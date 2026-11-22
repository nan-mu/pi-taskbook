import { lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { modelKey, type RoleSelection } from "../models/config.ts";
import { alwaysPrompt } from "../facts/always.ts";
import { git } from "../taskbook/document.ts";
import { privateDirectory } from "./run-paths.ts";
import { cleanRevision, type Run } from "./checkpoint.ts";

export type Seat = "lead" | "member-a" | "member-b" | "implementer";
export type WorkTurn = {id: string; work: string; prompt: string; context: unknown; schema: TSchema};
export type WorkerReceipt = {id: string; seat: Seat; work: string; session: string; model: string; thinking: RoleSelection["thinkingLevel"]};
export type CommandReceipt = {turn: string; command: string; before: string; cleanBefore?: boolean; revision: string; clean: boolean; failed: boolean; output: string};
export function commandSnapshot(run: Pick<Run, "root">) {
  try { return {revision: cleanRevision(run), clean: true}; }
  catch { return {revision: git(run.root, "rev-parse", "HEAD"), clean: false}; }
}

export function isCandidateReceipt(receipt: CommandReceipt, revision: string) {
  return receipt.cleanBefore === true && receipt.clean && receipt.before === revision && receipt.revision === revision;
}

const resultName = "taskbook_work_result";

export async function subagentTurn({ run, ctx, seat, turn, route, tools = [], builtins = [], cleanContext = false, signal }: {
  run: Run; ctx: ExtensionContext; seat: Seat; turn: WorkTurn; route: RoleSelection; tools?: ToolDefinition[];
  builtins?: string[]; cleanContext?: boolean; signal: AbortSignal;
}) {
  signal.throwIfAborted();
  const {root} = run;
  const directory = privateDirectory(dirname(run.path), "workers", seat);
  const [saved, ...duplicates] = readdirSync(directory).filter(name => name.endsWith(".jsonl"));
  if (duplicates.length || (saved && !lstatSync(join(directory, saved)).isFile())) {
    throw new Error("子代理会话目录无效 " + seat);
  }
  const parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
  const manager = saved ? SessionManager.open(join(directory, saved), directory)
    : SessionManager.create(root, directory, {parentSession});
  if (manager.getCwd() !== root) throw new Error("子代理会话的工作区不匹配 " + seat);
  if (cleanContext && manager.getLeafId()) {
    manager.appendCompaction("Previous turns are archived. Use the current assignment, revision and available evidence to locate the behavior to check; use earlier verdicts only as leads.", null, 0);
  }
  const settingsManager = SettingsManager.inMemory();
  const agentDir = getAgentDir();
  const systemPrompt = [
    alwaysPrompt(root),
    turn.prompt,
    "The plugin owns scheduling. Work only on this assignment and use its tools. Finish by calling " + resultName +
      " exactly once with the state-specific result. In any permitted reason or evidence fields, identify the observation and its location, including what changed a prior judgment. Use only fields the state accepts, then end the turn.",
  ].filter(Boolean).join("\n\n");
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, disabledBuiltinExtensions: ["mcp"], noSkills: true,
    noContextFiles: true, noThemes: true, noPromptTemplates: true, systemPrompt, appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  const {model, thinkingLevel} = route;
  const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(model.provider);
  const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false, signal,
  });
  if (nativeProvider) modelRuntime.registerNativeProvider(nativeProvider);
  if (providerConfig) modelRuntime.registerProvider(model.provider, providerConfig);

  let reply: {result: unknown} | undefined;
  const commands: CommandReceipt[] = [];
  const submissionSchema = Type.Object({result: turn.schema}, {additionalProperties: false});
  const resultTool: ToolDefinition<typeof submissionSchema> = {
    name: resultName, label: "Return work result", description: "Submit this Work State's structured outcome.",
    parameters: submissionSchema,
    async execute(_id, {result}) {
      signal.throwIfAborted();
      if (reply) throw new Error("This turn has already submitted a result.");
      const submission = session.messages.findLast(message => message.role === "assistant");
      const calls = submission?.role === "assistant" ? submission.content.filter(item => item.type === "toolCall") : [];
      if (calls.length !== 1 || calls[0]?.name !== resultName) throw new Error("Submit the result in its own tool call.");
      if (!Value.Check(turn.schema, result)) throw new Error("Result does not match the active state.");
      reply = {result: structuredClone(result)};
      return {content: [{type: "text", text: "Recorded."}], details: {}, terminate: true};
    },
  };
  const customTools = [...tools, resultTool];
  const names = [...builtins, ...customTools.map(tool => tool.name)];
  const {session} = await createAgentSession({
    cwd: root, agentDir, model, thinkingLevel, modelRuntime, sessionManager: manager, resourceLoader, settingsManager,
    tools: names, customTools,
  });
  const shellCalls = new Map<string, {command: string; before: string; cleanBefore: boolean}>();
  const unsubscribe = session.subscribe(event => {
    if (event.type === "tool_execution_start" && event.toolName === "bash" && typeof event.args.command === "string") {
      const start = commandSnapshot(run);
      shellCalls.set(event.toolCallId, {command: event.args.command, before: start.revision, cleanBefore: start.clean});
    }
    if (event.type === "tool_execution_end" && event.toolName === "bash") {
      const call = shellCalls.get(event.toolCallId);
      if (!call) return;
      const output = event.result.content.flatMap((part: TextContent | ImageContent) => part.type === "text" ? [part.text] : []).join("\n");
      commands.push({...call, ...commandSnapshot(run), turn: turn.id, failed: event.isError, output: output.slice(0, 4000)});
      shellCalls.delete(event.toolCallId);
    }
  });
  const abort = () => { void session.abort(); };
  signal.addEventListener("abort", abort, {once: true});
  try {
    signal.throwIfAborted();
    const actual = session.model;
    if (!actual || modelKey(actual) !== modelKey(model) || session.thinkingLevel !== thinkingLevel) {
      throw new Error("子代理未获得指定的模型和推理档位 " + seat);
    }
    if (session.getActiveToolNames().sort().join() !== names.sort().join()) {
      throw new Error("子代理工具与当前工作状态不匹配 " + seat);
    }
    await session.prompt(JSON.stringify({seat, work: turn.work, assignment: turn.context}), {expandPromptTemplates: false});
    signal.throwIfAborted();
    const last = session.messages.at(-1);
    if (!reply || last?.role !== "toolResult" || last.toolName !== resultName || last.isError) {
      throw new Error("子代理未完整提交结果 " + seat + " / " + turn.work +
        (last?.role === "assistant" && last.errorMessage ? " · " + last.errorMessage : ""));
    }
    const receipt: WorkerReceipt = {id: turn.id, seat, work: turn.work, session: session.sessionId,
      model: modelKey(actual), thinking: session.thinkingLevel};
    return {result: reply.result, receipt, commands};
  } finally {
    signal.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
}

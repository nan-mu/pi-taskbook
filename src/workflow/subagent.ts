import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
  createBashToolDefinition, createEditToolDefinition, createGrepToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { modelKey, type RoleSelection } from "../models/config.ts";
import { alwaysPrompt } from "../facts/always.ts";
import { factAccessRestriction } from "../facts/access.ts";
import { git } from "../taskbook/document.ts";
import { cleanRevision, type Run } from "./run.ts";

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
export const subagentTool = "subagent";
const subagentDescription = "Report a Taskbook-dispatched worker to the host. Invoked by the Taskbook coordinator.";

export async function subagentTurn({ run, ctx, seat, turn, route, tools = [], builtins = [], signal, activity }: {
  run: Run; ctx: ExtensionContext; seat: Seat; turn: WorkTurn; route: RoleSelection; tools?: ToolDefinition[];
  builtins?: string[]; signal: AbortSignal; activity?: (text: string) => void;
}) {
  signal.throwIfAborted();
  const {root} = run;
  const manager = SessionManager.inMemory(root);
  const settingsManager = SettingsManager.inMemory();
  const agentDir = getAgentDir();
  const systemPrompt = [
    "You are Pi Taskbook's " + seat + " for run " + run.task.id + ". Current phase: " + run.state.phase +
      ". Your Work State is " + turn.work + ". The current assignment establishes which judgment you own and which inputs you can rely on.",
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
  function guard<T extends TSchema, Details, State>(tool: ToolDefinition<T, Details, State>): ToolDefinition<T, Details, State> {
    return {...tool, async execute(id, params, signal, onUpdate, ctx) {
      const reason = factAccessRestriction(tool.name, params, root);
      if (reason) throw new Error(reason);
      return tool.execute(id, params, signal, onUpdate, ctx);
    }};
  }
  const guardedTools: ToolDefinition[] = builtins.length ? [
    guard(createBashToolDefinition(root)), guard(createEditToolDefinition(root)), guard(createGrepToolDefinition(root)),
    guard(createReadToolDefinition(root)), guard(createWriteToolDefinition(root)),
  ].filter(tool => builtins.includes(tool.name)) : [];
  const customTools = [...guardedTools, ...tools, resultTool];
  const names = [...new Set([...builtins, ...customTools.map(tool => tool.name)])];
  const {session} = await createAgentSession({
    cwd: root, agentDir, model, thinkingLevel, modelRuntime, sessionManager: manager, resourceLoader, settingsManager,
    tools: names, customTools,
  });
  const shellCalls = new Map<string, {command: string; before: string; cleanBefore: boolean}>();
  let lastActivity = 0;
  const unsubscribe = session.subscribe(event => {
    if (activity && event.type === "tool_execution_start" && Date.now() - lastActivity >= 1000) {
      lastActivity = Date.now();
      activity("正在调用 " + event.toolName);
    }
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

export function registerSubagentTool(pi: ExtensionAPI) {
  type Input = Parameters<typeof subagentTurn>[0];
  type Result = Awaited<ReturnType<typeof subagentTurn>>;
  type PendingWork = {input: Input; result?: Result; failure?: {error: unknown}};
  const pending = new Map<string, PendingWork>();
  pi.registerTool({
    name: subagentTool, label: "Taskbook 子代理", description: subagentDescription, exposure: "deferred",
    parameters: Type.Object({taskbookWorkToken: Type.String()}, {additionalProperties: false}),
    async execute(_id, {taskbookWorkToken}, signal, onUpdate) {
      const work = pending.get(taskbookWorkToken);
      if (!work) throw new Error("该子代理只能由 Taskbook 派发。");
      pending.delete(taskbookWorkToken);
      const {seat, turn, run, route} = work.input;
      const workerSignal = signal ? AbortSignal.any([signal, work.input.signal]) : work.input.signal;
      const identity = {agent: seat, task: run.state.phase + " / " + turn.work, model: modelKey(route.model)};
      // T3's Pi adapter reads details.results on subagent tool events.
      function snapshot(text: string, stopReason?: "stop" | "error" | "aborted"): Awaited<ReturnType<ToolDefinition["execute"]>> {
        return {content: [{type: "text", text}], details: {results: [{
          ...identity, finished: stopReason !== undefined, stopReason,
          messages: [{role: "assistant", content: [{type: "text", text}]}],
          ...(stopReason === "error" || stopReason === "aborted" ? {exitCode: 1, errorMessage: text} : {}),
        }]}};
      }
      onUpdate?.(snapshot("正在处理 " + identity.task));
      try {
        work.result = await subagentTurn({...work.input, signal: workerSignal, activity: text => onUpdate?.(snapshot(text))});
        return snapshot("已提交 " + identity.task + " 的结果", "stop");
      } catch (error) {
        work.failure = {error};
        return workerSignal.aborted ? snapshot("子代理已中断", "aborted") : snapshot("子代理工作失败，见任务书退出原因", "error");
      }
    },
  });

  return async (input: Input & {ctx: ExtensionToolContext}): Promise<Result> => {
    const {ctx} = input;
    if (!ctx.tools.some(tool => tool.name === subagentTool && tool.description === subagentDescription)) return subagentTurn(input);
    const taskbookWorkToken = randomUUID();
    const work: PendingWork = {input};
    pending.set(taskbookWorkToken, work);
    try {
      const outcome = await ctx.executeTool(subagentTool, {taskbookWorkToken}, {signal: input.signal});
      if (work.failure) throw work.failure.error;
      input.signal.throwIfAborted();
      if (!work.result || outcome.isError) {
        const reason = outcome.result.content.map(part => part.type === "text" ? part.text : "").join("\n");
        throw new Error("未能运行 Taskbook 子代理 " + input.seat + (reason ? " · " + reason : ""));
      }
      return work.result;
    } finally {
      pending.delete(taskbookWorkToken);
    }
  };
}

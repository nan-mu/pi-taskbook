import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager,
  type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Role = "fact-review" | "correctness" | "quality";
type TaskItem = { id: string; text: string };
export type ReviewInput = {
  root: string; base: string; revision: string; role: Role;
  taskbook: string; objectives: TaskItem[]; facts: TaskItem[]; evidence: unknown;
  methods: { source: string; text: string }[];
};
type Verdict = "pass" | "rework" | "blocked" | "measure" | "fact-conflict";
type ReviewItem = { id: string; status: "pass" | "gap" | "blocked" | "fact-conflict"; reason: string; evidence: string; memoryUse?: "independent" | "change-evidence"; runEvidence?: string[] };
type Conflict = { factId: string; observation: string };
type Inspection = { id: string; view: string; path?: string; start: number; digest: string; characters: number };
type RunSource = { id: string; phase: string; revision: string; toolCallId: string; digest: string };
export type ReviewResult = {
  sessionId: string; revision: string; role: Role; model: string; contextDigest: string;
  verdict: Verdict; summary: string; items: ReviewItem[]; conflicts: Conflict[]; observations: Inspection[]; runSources: RunSource[];
};

const designConsultInstruction = readFileSync(new URL("./prompts/design-consult.md", import.meta.url), "utf8");
const instruction = readFileSync(new URL("./prompts/independent-review.md", import.meta.url), "utf8");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const parameters = Type.Object({
  view: Type.Union([Type.Literal("changes"), Type.Literal("base"), Type.Literal("candidate"), Type.Literal("diff")]),
  path: Type.Optional(Type.String({ minLength: 1 })),
  start: Type.Optional(Type.Integer({ minimum: 1, description: "首行，从 1 计数" })),
}, { additionalProperties: false });

function inspectionTool(input: Pick<ReviewInput,"root"|"base"|"revision">, observations: Inspection[]): ToolDefinition<typeof parameters> {
  return {
    name: "inspect_revision", label: "检查固定 Git 提交", description: "changes 列出改变的路径。base 和 candidate 读取指定版本文件。diff 读取两版差异，允许按文件过滤。响应带观察编号和分页位置。",
    parameters,
    async execute(_id, { view, path, start = 1 }) {
      if (path && (posix.isAbsolute(path) || posix.normalize(path) !== path || path === ".." || path.startsWith("../"))) {
        throw new Error("请给仓库内的相对路径。");
      }
      let args: string[];
      if (view === "base" || view === "candidate") {
        if (!path) throw new Error("读取文件需要 path。");
        args = ["cat-file", "blob", (view === "base" ? input.base : input.revision) + ":" + path];
      } else {
        args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color",
          ...(view === "changes" ? ["--name-status"] : []), input.base, input.revision, "--", ...(path ? [path] : [])];
      }
      const raw = execFileSync("git", ["--literal-pathspecs", ...args], {
        cwd: input.root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      });
      const lines = raw.split("\n");
      if (start > lines.length) throw new Error("请求的首行超出文件或差异范围。");
      const page = lines.slice(start - 1, start + 119).join("\n");
      const content = page.length > 24000 ? page.slice(0, 24000) + "\n[本页字符截断，可指定后续首行]" : page;
      const id = "R" + (observations.length + 1);
      observations.push({ id, view, path, start, digest: digest(content), characters: content.length });
      return { content: [{ type: "text", text: `Observation ${id}\n总行数 ${lines.length}，首行 ${start}\n${content}` }], details: {} };
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function runSourcesFor(input: ReviewInput): RunSource[] {
  const evidence = input.evidence;
  if (!record(evidence) || !Array.isArray(evidence.candidateReports)) return [];
  const sources: RunSource[] = [];
  for (const report of evidence.candidateReports) {
    if (!record(report) || !string(report.phase) || !Array.isArray(report.observations)) continue;
    for (const obs of report.observations) {
      if (!record(obs) || !string(obs.observed) || !string(obs.toolCallId) || obs.revision !== input.revision) continue;
      sources.push({ id: "T" + (sources.length + 1), phase: report.phase, revision: input.revision,
        toolCallId: obs.toolCallId, digest: digest(obs.observed) });
    }
  }
  return sources;
}

function parseVerdict(text: string, required: string[], facts: TaskItem[], role: Role, observations: Inspection[], runSources: RunSource[], classifyFactChecks: boolean) {
  const response: unknown = JSON.parse(text);
  if (!record(response) || !string(response.summary) || !Array.isArray(response.items) || !Array.isArray(response.conflicts)) {
    throw new Error("独立审核报告缺少结论或逐项检查结果。");
  }
  const seen = new Set<string>();
  const items: ReviewItem[] = response.items.map(item => {
    if (!record(item) || !string(item.id) || !required.includes(item.id) || seen.has(item.id)
      || !["pass","gap","blocked","fact-conflict"].includes(String(item.status))
      || !string(item.reason) || !string(item.evidence) || !observations.some(o => o.id === item.evidence)) {
      throw new Error("独立审核报告的条目、状态或观察编号无效。");
    }
    const runEvidence: unknown = item.runEvidence;
    if (runEvidence !== undefined && (!Array.isArray(runEvidence)
      || runEvidence.some(id => !runSources.some(source => source.id === id)))) {
      throw new Error("运行依据必须引用本次候审提交包中的观测。");
    }
    let memoryUse: ReviewItem["memoryUse"];
    if (classifyFactChecks && role === "fact-review" && /^P\d+$/.test(item.id) && item.status === "pass") {
      if (item.memoryUse !== "independent" && item.memoryUse !== "change-evidence") {
        throw new Error("含记忆变更的审核需要说明每个 P 项的 memoryUse。");
      }
      memoryUse = item.memoryUse;
    }
    seen.add(item.id);
    return { id: item.id, status: item.status as ReviewItem["status"], reason: item.reason, evidence: item.evidence,
      ...(memoryUse ? {memoryUse} : {}), ...(Array.isArray(runEvidence) ? { runEvidence: runEvidence as string[] } : {}) };
  });
  if (required.length !== seen.size || !observations.length) throw new Error("独立审核未完成逐项取证。");
  const conflicts: Conflict[] = response.conflicts.map(conflict => {
    if (!record(conflict) || !string(conflict.factId) || !facts.some(f => f.id === conflict.factId) || !string(conflict.observation)) {
      throw new Error("独立审核报告的事实冲突缺少已有事实编号或新观测。");
    }
    return { factId: conflict.factId, observation: conflict.observation };
  });
  const verdict = response.verdict;
  if (verdict !== "pass" && verdict !== "measure" && verdict !== "blocked" && verdict !== "rework" && verdict !== "fact-conflict") {
    throw new Error("独立审核结论无效。");
  }
  if ((verdict === "pass" || verdict === "measure") && !items.some(item =>
    observations.some(observation => observation.id === item.evidence && observation.view !== "changes" && observation.characters > 0))) {
    throw new Error("通过报告须引用独立检查的文件内容或差异。");
  }
  const flagged = items.filter(item => item.status === "fact-conflict");
  if ((verdict === "fact-conflict") !== (conflicts.length > 0) || (flagged.length && !conflicts.length)
    || flagged.some(item => facts.some(f => f.id === item.id) && !conflicts.some(c => c.factId === item.id))
    || (verdict === "measure" && (role === "fact-review" || items.some(item => item.status === "blocked")))
    || (verdict === "pass" && items.some(item => item.status !== "pass"))
    || (verdict === "rework" && !items.some(item => item.status === "gap"))) {
    throw new Error("独立审核的总结果与逐项结论不一致。");
  }
  return { verdict: verdict as Verdict, summary: response.summary, items, conflicts };
}

export async function runIndependentReview(ctx: ExtensionContext, input: ReviewInput, signal?: AbortSignal, model = ctx.model): Promise<ReviewResult> {
  if (!model) throw new Error("独立审核需要已选定的 Pi 模型。");
  if (![input.base, input.revision].every(value => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value))) {
    throw new Error("审核需要固定的基线和候审提交。");
  }
  const requiredIds = [...input.objectives, ...(input.role === "quality" ? [] : input.facts)].map(item => item.id);
  if (!requiredIds.length || requiredIds.length !== new Set(requiredIds).size) throw new Error("审核范围需要唯一的目标与事实编号。");
  const { root, methods, ...data } = input;
  const runSources = runSourcesFor(input);
  const packet = JSON.stringify({ ...data, requiredIds, runSources });
  const system = [instruction, ...methods.map(method => "## " + method.source + "\n" + method.text)].join("\n\n");
  const reply = await readOnlySession(ctx, input, model, system, packet, signal);
  const result = parseVerdict(reply.text, requiredIds, input.facts, input.role, reply.observations, runSources,
    record(input.evidence) && input.evidence.classifyFactChecks === true);
  return { ...result, revision: input.revision, role: input.role, runSources, observations: reply.observations,
    contextDigest: reply.contextDigest, model: reply.model, sessionId: reply.sessionId };
}

export async function consultDesign(ctx: ExtensionContext, input: Omit<ReviewInput,"role">, question: string,
  model: NonNullable<ExtensionContext["model"]>, signal?: AbortSignal) {
  const system = [designConsultInstruction,
    ...input.methods.map(method => "## " + method.source + "\n" + method.text)].join("\n\n");
  const {root: _root, methods: _methods, ...data} = input;
  const packet = JSON.stringify({...data, role:"design-consult", question});
  const reply = await readOnlySession(ctx, input, model, system, packet, signal);
  return {answer: reply.text, model: reply.model, sessionId: reply.sessionId, observations: reply.observations,
    contextDigest: reply.contextDigest, revision: input.revision};
}

async function readOnlySession(ctx: ExtensionContext, input: Pick<ReviewInput,"root"|"base"|"revision">, model: NonNullable<ExtensionContext["model"]>,
  system: string, packet: string, signal?: AbortSignal) {
  const {root} = input;
  const observations: Inspection[] = [];
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, disabledBuiltinExtensions: ["mcp"], noSkills: true,
    noContextFiles: true, noThemes: true, noPromptTemplates: true, systemPrompt: system, appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  signal?.throwIfAborted();
  const { session } = await createAgentSession({
    cwd: root, agentDir, model, thinkingLevel: ctx.thinkingLevel,
    sessionManager: SessionManager.inMemory(root), resourceLoader, settingsManager,
    customTools: [inspectionTool(input, observations)], tools: ["inspect_revision"],
  });
  const abort = () => { void session.abort(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const activeTools = session.getActiveToolNames();
    if (activeTools.length !== 1 || activeTools[0] !== "inspect_revision") {
      throw new Error("独立会话未获得限定的只读审查工具。");
    }
    await session.prompt(packet, { expandPromptTemplates: false });
    signal?.throwIfAborted();
    const last = session.messages.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop") throw new Error("独立审核未正常完成，保留检查点。");
    const reply = session.getLastAssistantText();
    if (!reply) throw new Error("独立审核会话结束但未交回报告。");
    return {text: reply, sessionId: session.sessionId, model: model.provider + "/" + model.id,
      contextDigest: digest(JSON.stringify([system, packet])), observations};
  } finally {
    signal?.removeEventListener("abort", abort);
    session.dispose();
  }
}

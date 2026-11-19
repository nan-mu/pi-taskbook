import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitOk, readTaskbook, workspace, type Taskbook } from "./taskbook.ts";
import { nextPhase, restorePhase, stages, titles, type Outcome, type Phase } from "./workflow.ts";
import { prepareTaskWorktree, readEntryArgument, verifyPreparedEntry, type PreparedEntry } from "./entry.ts";
import { launchT3Thread, readT3Endpoint } from "./t3.ts";
import { loadUpstreamInputs, pinUpstreamInputs, type UpstreamPins } from "./upstream.ts";

import { taskMemory, workerContext, validateConflict, parseFactDecision, type FactConflict, type FactDecision } from "./memory.ts";
import { runIndependentReview, type ReviewResult } from "./reviewer.ts";
import { checkFacts, factChecksParameter, type Observation, type CheckedFact } from "./fact-check.ts";

const reportTool = "taskbook_report";
const kickoffType = "pi-taskbook-stage";
const promptDir = fileURLToPath(new URL("./prompts/", import.meta.url));
const common = readFileSync(join(promptDir, "common.md"), "utf8");
const promptNames = ["fact-check", "fact-check-fix", "fact-check-new", "design", "implement", "performance"];
const prompts = Object.fromEntries(promptNames.map(name => [name, readFileSync(join(promptDir, name + ".md"), "utf8")]));

type RunObservation = { revision: string; toolName: string; toolCallId: string; input: unknown; isError: boolean; observed: string };
type Report = { phase: Phase; outcome: Outcome; summary: string; evidence: string[];
  factChecks?: CheckedFact[]; observations?: RunObservation[]; review?: ReviewResult; candidateId?: string;
  conflicts?: FactConflict[]; reviewInput?: string };
type State = {
  version: 1;
  digest: string;
  session: string;
  reviewPolicy?: 1;
  candidateId?: string;
  pendingConflicts?: FactConflict[];
  decisions?: (FactDecision & { conflict: FactConflict; session: string; at: string })[];
  cycleStart?: number;
  base: string;
  branch: string;
  phase: Phase | "exit";
  exit?: "ready" | "blocked" | "cancelled";
  stopReason?: string;
  revision?: string;
  upstream?: UpstreamPins;
  reports: Report[];
};
type Run = { task: Taskbook; path: string; root: string; state: State };

const reportParameters = Type.Object({
  attempt: Type.String({ description: "当前阶段提示词中给出的执行标识。" }),
  outcome: Type.Union([Type.Literal("pass"), Type.Literal("blocked"), Type.Literal("fact-conflict")]),
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { maxItems: 20 }),
  factChecks: Type.Optional(factChecksParameter),
  observedRuns: Type.Optional(Type.Array(Type.Object({receipt: Type.String(), observed: Type.String({minLength: 1, maxLength: 4000})}, {additionalProperties: false}), {minItems: 1, maxItems: 20})),
  conflicts: Type.Optional(Type.Array(Type.Object({factId: Type.String(), observation: Type.String({minLength: 1, maxLength: 4000})}, {additionalProperties: false}), {minItems: 1, maxItems: 20})),
}, { additionalProperties: false });

function save(path: string, value: State, taskbook: Taskbook, initial = false) {
  const temporary = path + "." + randomUUID();
  try {
    writeFileSync(temporary, JSON.stringify({ ...value, taskbook }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
    if (initial) linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function checkpoint(run: Run, next: State) {
  save(run.path, next, run.task);
  run.state = next;
}

function openRun(ctx: ExtensionContext, task: Taskbook, prepared?: PreparedEntry): Run {
  const session = ctx.sessionManager.getSessionId();
  if (!ctx.sessionManager.getSessionFile()) throw new Error("请在有持久会话记录的 Pi thread 中启动任务。");
  const preliminary = verifyPreparedEntry(ctx.cwd, task, prepared);
  const relativePath = ".audit/pi-taskbook/" + task.id + "-" + task.digest.slice(0, 16) + "/state.json";
  if (!gitOk(preliminary.root, "check-ignore", "-q", "--", relativePath)) {
    throw new Error("请先将 .audit/pi-taskbook/ 加入 Git 排除配置。");
  }
  const path = join(preliminary.root, relativePath);
  let directory = preliminary.root;
  for (const component of relativePath.split("/").slice(0, -1)) {
    directory = join(directory, component);
    if (!existsSync(directory)) {
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    if (!lstatSync(directory).isDirectory()) throw new Error("审计路径需要真实的目录。");
  }

  if (!existsSync(path)) {
    const upstream = pinUpstreamInputs();
    loadUpstreamInputs(upstream, stages[0], task.type);
    const initial: State = { version: 1, reviewPolicy: 1, digest: task.digest, session, base: preliminary.base, branch: preliminary.branch,
      phase: stages[0], reports: [],
      upstream };
    try { save(path, initial, task, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!lstatSync(path).isFile()) throw new Error("审计状态需要是普通文件。");
  const saved = JSON.parse(readFileSync(path, "utf8")) as Omit<State, "phase" | "reports" | "branch"> & {
    phase: string; branch?: string; reports: (Omit<Report, "phase"> & { phase: string })[];
  };
  if (saved.version !== 1 || saved.digest !== task.digest || saved.session !== session || !Array.isArray(saved.reports)) {
    throw new Error("审计记录不匹配，或任务已绑定到另一个 Pi 会话。");
  }
  const state: State = { ...saved,
    branch: saved.branch ?? preliminary.branch,
    phase: saved.phase === "exit" ? "exit" : restorePhase(task.type, saved.phase),
    reports: saved.reports.map(report => ({ ...report, phase: restorePhase(task.type, report.phase) })),
  };
  workspace(ctx.cwd, task, state.base, state.branch);
  if (!state.reviewPolicy && (state.phase !== "exit" || state.exit === "ready")) {
    // Historical reports belong to the old trust model. Preserve the audit but
    // obtain fresh evidence and independent reviews before issuing a new handoff.
    Object.assign(state, { reviewPolicy: 1, phase: "fact-check", cycleStart: state.reports.length,
      exit: undefined, revision: undefined, candidateId: undefined });
    save(path, state, task);
  }
  if (state.phase !== "exit" && !state.upstream) {
    const pins = pinUpstreamInputs();
    loadUpstreamInputs(pins, state.phase, task.type);
    state.upstream = pins;
    save(path, state, task);
  }
  const active = { task, root: preliminary.root, path, state };
  if (state.exit === "ready" && state.revision !== cleanRevision(active)) {
    checkpoint(active, { ...state, phase: "implement", exit: undefined, revision: undefined, candidateId: undefined });
  }
  return active;
}

function cleanRevision(run: Run) {
  const revision = git(run.root, "rev-parse", "HEAD");
  if (git(run.root, "status", "--porcelain", "--untracked-files=all")) {
    throw new Error("交付快照需要干净的工作区。保留任务外改动，待其妥善处理后重试。");
  }
  return revision;
}

function memory(run: Run) {
  const admitted = run.state.reports.filter(report => report.phase === "fact-review" && report.outcome === "pass")
    .flatMap(report => report.factChecks ?? []);
  return taskMemory(run.task, run.state.decisions, admitted);
}

function buildPhaseInput(run: Run, phase: Phase, attempt: string) {
  const { task, state } = run;
  const fixed = JSON.stringify({ task: task.id, type: task.type, base: state.base, revision: state.revision,
    branch: state.branch, phase, attempt, ...memory(run), decisions: state.decisions ?? [],
    priorReports: workerContext(phase, state.reports.slice(state.cycleStart ?? 0)) }, null, 2);
  const upstream = loadUpstreamInputs(state.upstream, phase, task.type);
  const methods = upstream.flatMap(file => ["## 当前阶段的上游方法 " + file.source, file.text]);
  const guidance = [prompts[phase]];
  if (phase === "fact-check") guidance.push(prompts[task.type.startsWith("fix-") ? "fact-check-fix" : "fact-check-new"]);
  return [common, ...guidance, ...methods, "## 当前运行数据", fixed, "## 任务书原文", task.markdown,
    ...(task.facts !== undefined ? ["## 任务书随附事实", task.facts] : [])].join("\n\n");
}

export default function taskbookExtension(pi: ExtensionAPI) {
  let run: Run | undefined;
  let attempt: string | undefined;
  let started = false;
  let reported = false;
  let launching = false;
  let phaseInput: string | undefined;
  const observations = new Map<string, Observation>();

  let reviewing: AbortController | undefined;
  const observedCalls = new Map<string, string>();
  const candidateOutputs = new Map<string, Omit<RunObservation, "observed"> & { text: string[] }>();

  function toggleReportTool(enabled: boolean) {
    const tools = pi.getActiveTools().filter(name => name !== reportTool);
    if (enabled) tools.push(reportTool);
    pi.setActiveTools(tools);
  }

  function pauseForUser(ctx: ExtensionContext, active: Run) {
    toggleReportTool(false);
    const pending = active.state.pendingConflicts!;
    const facts = memory(active).facts;
    ctx.ui.setStatus("pi-taskbook", "等待用户裁决事实冲突");
    const details = pending.map(item => item.factId + " · " + facts.find(f => f.id === item.factId)?.text + "\n新观察：" + item.observation);
    ctx.ui.notify("等待用户裁决事实冲突 · " + active.task.id + "\n" + details.join("\n") +
      "\n/taskbook-decide " + pending[0].factId + " keep <理由> 或 replace <完整新事实>", "warning");
  }

  async function startPhase(ctx: ExtensionContext): Promise<void> {
    if (!run || run.state.phase === "exit") return;
    workspace(ctx.cwd, run.task, run.state.base, run.state.branch);
    if (run.state.pendingConflicts?.length) return pauseForUser(ctx, run);
    const phase = run.state.phase;
    if (phase === "fact-review" || phase === "correctness" || phase === "quality") {
      return startReview(ctx, run, phase);
    }
    toggleReportTool(true);
    const token = randomUUID();
    phaseInput = buildPhaseInput(run, run.state.phase, token);
    observedCalls.clear();
    candidateOutputs.clear();
    observations.clear();
    attempt = token;
    started = false;
    reported = false;
    ctx.ui.setStatus("pi-taskbook", titles[run.state.phase]);
    pi.sendMessage({ customType: kickoffType, content: "执行当前任务书阶段。", display: false, details: attempt },
      { triggerTurn: true });
  }

  async function startReview(ctx: ExtensionContext, active: Run, phase: ReviewResult["role"]): Promise<void> {
    toggleReportTool(false);
    ctx.ui.setStatus("pi-taskbook", titles[phase]);
    const { state, task } = active;
    const factReview = phase === "fact-review";
    const revision = factReview ? state.base : state.revision;
    if (!revision || (!factReview && revision !== cleanRevision(active))) throw new Error("候审提交与当前工作区不一致。");
    const current = state.reports.slice(state.cycleStart ?? 0);
    const proposals = current.at(-1)?.factChecks ?? [];
    if (factReview && !proposals.length) throw new Error("独立事实审核需要待审主张。");
    const { goals, facts, delivery } = memory(active);
    const candidateReports = current.filter(report => report.candidateId === state.candidateId &&
      (report.phase === "implement" || report.phase === "performance"))
      .map(report => ({phase: report.phase, pointers: report.evidence, observations: report.observations ?? []}));
    const evidence = { ...(factReview ? {factChecks: proposals} : {candidateReports}), decisions: state.decisions ?? [] };
    const methods = loadUpstreamInputs(state.upstream, phase, task.type);
    const objectives = factReview ? proposals.map((proposal, i) => ({id: "P" + (i+1), text: JSON.stringify(proposal)}))
      : [...goals, ...delivery];
    const controller = new AbortController();
    reviewing = controller;
    let review: ReviewResult;
    try {
      review = await runIndependentReview(ctx, {root: active.root, base: state.base, revision, role: phase,
        taskbook: task.markdown, facts, objectives, evidence, methods}, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || run !== active) return;
      throw error;
    } finally {
      if (reviewing === controller) reviewing = undefined;
    }
    if (controller.signal.aborted || run !== active || active.state !== state) return;
    workspace(ctx.cwd, task, state.base, state.branch);
    if (!factReview && cleanRevision(active) !== revision) throw new Error("独立审核期间候审工作区发生变化。");
    const conflicts = review.conflicts;
    conflicts.forEach(item => validateConflict(facts, item));
    const measured = candidateReports.some(report => report.phase === "performance");
    const next = nextPhase(task.type, phase, review.verdict, measured);
    // When neither the artifact nor the submitted evidence changed, send the
    // repeated finding back to the human instead of rerunning the same loop.
    const equivalent = factReview ? proposals.map(p => [p.claim, p.observed, p.source.kind === "git" ? p.origin : [p.toolInput, p.observedHead, p.toolError]]) :
      candidateReports.map(r => [r.phase, r.pointers, r.observations.map(o => [o.toolName, o.input, o.observed, o.isError])]);
    const reviewInput = createHash("sha256").update(JSON.stringify([phase, revision, equivalent])).digest("hex");
    const repeated = review.verdict === "rework" && current.some(r => r.outcome === "rework" && r.reviewInput === reviewInput);
    const report: Report = { phase, outcome: review.verdict, review, reviewInput,
      summary: review.summary, evidence: review.items.map(item => item.id + " · " + item.reason),
      candidateId: state.candidateId, conflicts, factChecks: factReview && review.verdict === "pass" ? proposals : undefined };
    const exit = repeated ? "blocked" : next === "ready" || next === "blocked" ? next : undefined;
    checkpoint(active, { ...state,
      revision: review.verdict === "rework" ? undefined : state.revision,
      candidateId: review.verdict === "rework" ? undefined : state.candidateId,
      reports: [...state.reports, report], pendingConflicts: conflicts, exit,
      stopReason: repeated ? "同一提交及证据再次被独立审核退回。" + review.summary :
        (next === "blocked" && review.verdict === "measure" ? "同一候审已经测量，审核仍缺所需证据。" + review.summary : undefined),
      phase: repeated || next === "blocked" || next === "ready" ? "exit" : next });
    if (repeated) ctx.ui.notify("同一提交及证据再次被独立审核退回，已暂停自动返工。", "warning");
    if (exit) return announce(ctx, active);
    await startPhase(ctx);
  }

  function release(ctx: ExtensionContext) {
    observedCalls.clear();
    candidateOutputs.clear();
    observations.clear();
    reviewing?.abort();
    reviewing = undefined;
    run = undefined;
    attempt = undefined;
    phaseInput = undefined;
    started = false;
    reported = false;
    toggleReportTool(false);
    ctx.ui.setStatus("pi-taskbook", undefined);
  }

  function exitInvocation(ctx: ExtensionContext, reason: string, recoverable?: Run) {
    const message = recoverable
      ? `退出（可恢复） · ${reason}\n检查点 ${recoverable.path}\n再次提交同一任务书可从检查点恢复。`
      : "退出（阻塞） · " + reason;
    release(ctx);
    ctx.ui.notify(message, "warning");
  }

  function announce(ctx: ExtensionContext, active: Run) {
    const labels = { ready: "可交接", blocked: "有阻塞", cancelled: "已取消" };
    const state = active.state;
    const lines = [labels[state.exit!] + " · " + active.task.id];
    if (state.exit === "blocked") lines.push("阻塞原因 · " + (state.stopReason ?? state.reports.at(-1)?.summary ?? "见审计记录。"));
    if (state.revision) lines.push((state.exit === "ready" ? "交付提交 " : "候审提交 ") + state.revision);
    if (state.exit === "ready") {
      const candidateReports = state.reports.filter(report => report.candidateId === state.candidateId);
      const current = candidateReports.filter(report => report === candidateReports.findLast(other => other.phase === report.phase));
      for (const report of current) {
        if (report.outcome !== "pass") continue;
        const reviewer = report.review ? " · 审核会话 " + report.review.sessionId : "";
        lines.push(titles[report.phase] + " · " + report.summary + reviewer);
      }
    }
    const decisions = new Map((state.decisions ?? []).map(decision => [decision.factId, decision]));
    for (const decision of decisions.values()) {
      lines.push(`用户事实裁决 ${decision.factId} · ${decision.action} · ${decision.text}`);
    }
    lines.push("完整审计 " + active.path);
    const handoff = lines.join("\n");
    ctx.ui.notify(handoff, active.state.exit === "blocked" ? "warning" : "info");
    release(ctx);
    pi.sendMessage({ customType: "pi-taskbook-exit", content: handoff, display: true }, { triggerTurn: false });
  }

  pi.registerCommand("taskbook", {
    description: "在当前 linked worktree 接收任务书或恢复工作流",
    async handler(args, ctx) {
      if (!ctx.isIdle() || attempt || launching || reviewing) return ctx.ui.notify("入口请求已退出：当前会话正在处理任务。", "warning");
      if (!args.trim()) return exitInvocation(ctx, "用法 /taskbook <任务书路径>");
      try {
        const input = readEntryArgument(args.trim());
        const task = readTaskbook(ctx.cwd, input.prepared ? '"' + input.path + '"' : input.path);
        const candidate = openRun(ctx, task, input.prepared);
        if (candidate.state.phase === "exit") return announce(ctx, candidate);
        run = candidate;
        toggleReportTool(true);
        await startPhase(ctx);
      } catch (error) {
        exitInvocation(ctx, String(error), run);
      }
    },
  });

  pi.registerCommand("taskbook-new", {
    description: "按任务书新建工作分支和 worktree，并启动 T3 thread",
    async handler(args, ctx) {
      if (!ctx.isIdle() || attempt || launching || reviewing) return ctx.ui.notify("入口请求已退出：当前会话正在处理任务。", "warning");
      if (!args.trim()) return exitInvocation(ctx, "用法 /taskbook-new <任务书路径>");
      launching = true;
      let preparedPath: string | undefined;
      try {
        const task = readTaskbook(ctx.cwd, args);
        loadUpstreamInputs(pinUpstreamInputs(), stages[0], task.type);
        const endpoint = readT3Endpoint();
        const location = process.env.PI_TASKBOOK_WORKTREE_ROOT;
        if (!location) throw new Error("请设置 PI_TASKBOOK_WORKTREE_ROOT 为专用 worktree 根目录。");
        const prepared = prepareTaskWorktree(ctx.cwd, task, location);
        preparedPath = prepared.path;
        const reply = await launchT3Thread(endpoint, {
          title: task.id, branch: prepared.branch, worktreePath: prepared.path, message: prepared.message,
          clientRequestId: "pi-taskbook-" + task.digest,
        });
        ctx.ui.notify(`已交给新 T3 thread ${reply.threadId}\n${reply.link ?? prepared.path}`, "info");
      } catch (error) {
        const recovery = preparedPath ? `\nworktree 已准备 ${preparedPath}\n如 T3 回执缺失，请先核对已存在的 thread。` : "";
        exitInvocation(ctx, String(error) + recovery);
      } finally {
        launching = false;
      }
    },
  });

  pi.registerCommand("taskbook-exit", {
    description: "退出当前任务书工作流并保留审计记录",
    async handler(_args, ctx) {
      if (!run) return ctx.ui.notify("当前没有已加载的任务书。", "info");
      try {
        if (run.state.phase !== "exit") checkpoint(run, { ...run.state, phase: "exit", exit: "cancelled" });
        if (!ctx.isIdle()) ctx.abort();
        announce(ctx, run);
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });

  pi.registerCommand("taskbook-decide", {
    description: "用户裁决待确认事实：<事实 ID> keep <理由> 或 replace <完整新事实>",
    async handler(args, ctx) {
      if (!ctx.isIdle() || !run || reviewing || attempt || !run.state.pendingConflicts?.length) {
        return ctx.ui.notify("请先提交同一任务书，定位等待用户裁决的检查点。", "warning");
      }
      try {
        const active = run;
        const pending = active.state.pendingConflicts!;
        const conflict = pending.find(entry => entry.factId === args.trim().split(/\s+/)[0]);
        if (!conflict) throw new Error("请选择待裁决的事实标识。");
        const decision = parseFactDecision(args, conflict);
        const remaining = pending.filter(item => item.factId !== decision.factId);
        checkpoint(active, { ...active.state, pendingConflicts: remaining, phase: "fact-check",
          revision: undefined, candidateId: undefined, cycleStart: active.state.reports.length,
          decisions: [...(active.state.decisions ?? []), { ...decision, conflict, at: new Date().toISOString(),
            session: ctx.sessionManager.getSessionId() }] });
        await startPhase(ctx);
      } catch (error) { ctx.ui.notify(String(error), "error"); }
    },
  });

  pi.on("context", event => {
    if (!started || !attempt) return;
    const index = event.messages.findLastIndex(message => message.role === "custom" &&
      message.customType === kickoffType && message.details === attempt);
    if (index >= 0) return { messages: event.messages.slice(index) };
    // Fail closed after compaction removes the kickoff boundary.
    return { messages: [] };
  });

  pi.on("before_agent_start", (event) => {
    if (!run || !attempt || !phaseInput || run.state.phase === "exit" || event.messageType !== "custom" ||
        event.message.customType !== kickoffType || event.message.details !== attempt) return;
    started = true;
    return { systemPrompt: event.systemPrompt + "\n\n" + phaseInput };
  });

  pi.on("tool_call", event => {
    if (reviewing || run?.state.pendingConflicts?.length) return { block: true, reason: "当前由独立审核者或用户裁决。" };
    if (started && reported) return { block: true, reason: "当前阶段已提交，等待 Pi 结束这一轮。" };
    if (started && run && (run.state.phase === "implement" || run.state.phase === "performance") &&
        ![reportTool, "edit", "write"].includes(event.toolName)) {
      try { observedCalls.set(event.toolCallId, cleanRevision(run)); } catch { /* Dirty snapshots cannot issue receipts. */ }
    }
  });

  pi.on("tool_result", (event) => {
    if (!started || reported || !run) return;
    const before = observedCalls.get(event.toolCallId);
    if (before) {
      observedCalls.delete(event.toolCallId);
      let after: string;
      try { after = cleanRevision(run); } catch { return; }
      if (before !== after) return;
      const text = event.content.flatMap(part => part.type === "text" && part.text.trim() ? [part.text] : []);
      if (!text.length) return;
      const receipt = randomUUID();
      candidateOutputs.set(receipt, { revision: before, toolName: event.toolName, toolCallId: event.toolCallId,
        input: event.input, isError: event.isError, text });
      return { content: [...event.content, { type: "text" as const, text: "候审观测回执 " + receipt }],
        structuredContent: event.structuredContent };
    }
    if (run.state.phase !== "fact-check") return;
    if ([reportTool, "write", "edit"].includes(event.toolName)) return;
    const text = event.content.flatMap(part => part.type === "text" && part.text.trim() ? [part.text] : []);
    if (text.length === 0) return;
    const receipt = randomUUID();
    observations.set(receipt, { toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError, input: event.input, head: git(run.root, "rev-parse", "HEAD"), text });
    return { content: [...event.content, { type: "text" as const, text: "事实核查回执 " + receipt }],
      structuredContent: event.structuredContent };
  });

  pi.registerTool({
    name: reportTool,
    label: "提交任务书阶段证据",
    description: "在本阶段结束时登记结论和证据，随后结束当前模型轮次。",
    defaultActive: false,
    parameters: reportParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!run || !started || reported || !attempt || params.attempt !== attempt || run.state.phase === "exit") {
        throw new Error("执行标识已失效，或当前阶段已经提交。");
      }
      const phase = run.state.phase;
      const outcome = params.outcome;
      const summary = params.summary.trim();
      const evidence = params.evidence.map(item => item.trim()).filter(Boolean);
      if (phase === "fact-review" || phase === "correctness" || phase === "quality") throw new Error("审核须由插件派发。");
      if ((outcome === "fact-conflict") !== Boolean(params.conflicts?.length)) throw new Error("事实冲突须提交 conflicts。");
      params.conflicts?.forEach(item => validateConflict(memory(run!).facts, item));
      if (phase !== "fact-check" && params.factChecks) throw new Error("factChecks 仅用于事实核查。");
      if (phase === "fact-check" && outcome === "pass" && !params.factChecks?.length) {
        throw new Error("事实核查通过需要至少一项可定位、有摘录的 factChecks。");
      }
      const factChecks = params.factChecks && checkFacts(run.root, run.state.base, params.factChecks, observations);
      if (!summary || (outcome === "pass" && !factChecks?.length && !evidence.length && !params.observedRuns?.length)) {
        throw new Error("请提供具体结论及对应证据。");
      }
      workspace(ctx.cwd, run.task, run.state.base, run.state.branch);
      let revision = run.state.revision;
      if (outcome === "pass" && phase === "implement") revision = cleanRevision(run);
      if (outcome === "pass" && revision && cleanRevision(run) !== revision) {
        throw new Error("待审快照已变化，应退出并使用更新的任务书重新提交。");
      }
      const candidateObservations = params.observedRuns?.map(({receipt, observed}) => {
        const entry = candidateOutputs.get(receipt);
        if (!observed.trim() || !entry || entry.revision !== revision || !entry.text.some(text => text.includes(observed))) {
          throw new Error("候审观测回执、提交或摘录不匹配。");
        }
        const { text: _text, ...source } = entry;
        return { ...source, observed };
      });
      const candidateId = phase === "implement" && outcome === "pass" ? randomUUID() : run.state.candidateId;
      const next = nextPhase(run.task.type, phase, outcome);
      const report: Report = { phase, outcome, summary, evidence, factChecks, candidateId, observations: candidateObservations, conflicts: params.conflicts };
      checkpoint(run, { ...run.state, revision, candidateId, pendingConflicts: params.conflicts,
        phase: next === "ready" || next === "blocked" ? "exit" : next,
        exit: next === "ready" || next === "blocked" ? next : undefined, reports: [...run.state.reports, report] });
      reported = true;
      return { content: [{ type: "text", text: "阶段结果已登记。结束当前轮次。" }], details: { phase } };
    },
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (!run || !started) return;
    started = false;
    attempt = undefined;
    if (run.state.phase === "exit") return announce(ctx, run);
    if (event.aborted || !reported) {
      return exitInvocation(ctx, event.aborted ? "当前轮次被中断。" : "本轮结束前没有通过校验的阶段报告。", run);
    }
    try { await startPhase(ctx); }
    catch (error) { exitInvocation(ctx, String(error), run); }
  });
}

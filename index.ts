import { collectSetup } from "./taskbook-setup.ts";
import { recallMagpieMemory, syncMagpieMemory } from "./magpie-memory.ts";
import { methodDirectory, readStageMethod, workerMethodStages } from "./method-catalog.ts";
import { methodTool, registerMethodTool } from "./method-tool.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitOk, readTaskbook, workspace, type Taskbook } from "./taskbook.ts";
import { nextPhase, restorePhase, stages, titles, type Outcome, type Phase } from "./workflow.ts";
import { prepareTaskWorktree, readEntryArgument, verifyPreparedEntry, type PreparedEntry } from "./entry.ts";
import { launchT3Thread, readT3Endpoint } from "./t3.ts";
import { loadUpstreamInputs, pinUpstreamInputs, usesCurrentInputs, type UpstreamPins } from "./upstream.ts";

import { taskMemory, workerContext, validateConflict, parseFactDecision, type FactConflict, type FactDecision } from "./memory.ts";
import { consultDesign, runIndependentReview, type ReviewResult } from "./reviewer.ts";
import { checkFacts, factChecksParameter, type Observation, type CheckedFact } from "./fact-check.ts";

import { applyApprovedMemory, historicalProjectFacts, memoryId, pendingMemoryChanges, projectFacts, readProjectMemory, taskbookMemoryChanges, type MemoryChange, type ProjectSnapshot } from "./project-memory.ts";

import { acceptPlan, modelKey, modelRoutes, planParameter, resolveModel, reviewerModel, runProbe,
  type ExecutionPlan, type ModelRoutes, type PlanGap } from "./design-worker.ts";

const reportTool = "taskbook_report";
const designTools = ["taskbook_consult", "taskbook_probe"];
const setupType = "pi-taskbook-setup";
const setupApplyType = "pi-taskbook-setup-apply";
const kickoffType = "pi-taskbook-stage";
const promptDir = fileURLToPath(new URL("./prompts/", import.meta.url));
const magpieGuide = readFileSync(new URL("./methods/magpie-memory/SKILL.md", import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "");
const localRolePrompts = readdirSync(promptDir).filter(name => name.endsWith(".md")).sort()
  .map(name => [name, readFileSync(join(promptDir, name), "utf8")]);
const localPromptDigest = createHash("sha256").update(JSON.stringify([localRolePrompts, magpieGuide])).digest("hex");
const memoryGuide = readFileSync(join(promptDir, "project-memory.md"), "utf8");
const common = readFileSync(join(promptDir, "common.md"), "utf8");
const promptNames = ["fact-check", "fact-check-fix", "fact-check-new", "design", "implement", "performance"];
const prompts = Object.fromEntries(promptNames.map(name => [name, readFileSync(join(promptDir, name + ".md"), "utf8")]));

type RunObservation = { revision: string; toolName: string; toolCallId: string; input: unknown; isError: boolean; observed: string };
type Report = { planVersion?: number; plan?: ExecutionPlan; gap?: PlanGap; model?: string; phase: Phase; outcome: Outcome; summary: string; evidence: string[];
  factChecks?: CheckedFact[]; observations?: RunObservation[]; review?: ReviewResult; candidateId?: string;
  projectHead?: string | null; conflicts?: FactConflict[]; reviewInput?: string };
type State = {
  version: 1;
  digest: string;
  session: string;
  reviewPolicy?: 1;
  promptDigest?: string;
  routes?: ModelRoutes;
  plan?: ExecutionPlan;
  planGap?: PlanGap & {planVersion?: number; revision?: string; evidence?: string[]; summary?: string};
  pendingQuestion?: { question: string };
  userAnswers?: { question: string; answer: string }[];
  designActions?: { kind: "consult" | "experiment"; version: number; request: unknown; result: unknown }[];
  candidateId?: string;
  pendingConflicts?: FactConflict[];
  decisions?: (FactDecision & { conflict: FactConflict; session: string; at: string; projectChange?: MemoryChange })[];
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
  outcome: Type.Union([Type.Literal("pass"), Type.Literal("blocked"), Type.Literal("fact-conflict"), Type.Literal("plan-gap"), Type.Literal("needs-user")]),
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { maxItems: 20 }),
  plan: Type.Optional(planParameter),
  planVersion: Type.Optional(Type.Integer({minimum:1})),
  gap: Type.Optional(Type.Object({stepId: Type.String({minLength:1}), observation: Type.String({minLength:1}),
    question: Type.String({minLength:1})}, {additionalProperties:false})),
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
    const initial: State = { version: 1, reviewPolicy: 1, promptDigest: localPromptDigest, digest: task.digest, session, base: preliminary.base, branch: preliminary.branch,
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
  if ((state.phase !== "exit" || state.exit === "ready") && (!state.reviewPolicy || state.promptDigest !== localPromptDigest || !usesCurrentInputs(state.upstream))) {
    const upstream = pinUpstreamInputs();
    loadUpstreamInputs(upstream, "fact-check", task.type);
    // Keep the audit trail and all pending human decisions. Approvals, designs
    // and candidate IDs from the previous policy cannot authorize delivery.
    Object.assign(state, { reviewPolicy: 1, promptDigest: localPromptDigest, upstream, phase: "fact-check", cycleStart: state.reports.length,
      exit: undefined, revision: undefined, candidateId: undefined, plan: undefined,
      planGap: undefined, designActions: undefined });
    save(path, state, task);
  }
  const active = { task, root: preliminary.root, path, state };
  if (state.exit === "ready" && state.revision !== cleanRevision(active)) {
    checkpoint(active, { ...state, phase: "implement", exit: undefined, revision: undefined, candidateId: undefined });
  } else if (state.exit === "ready" && (state.reports.findLast(r => r.phase === "quality")?.projectHead ?? null) !== readProjectMemory(active.root).head) {
    checkpoint(active, {...state, phase: "correctness", exit: undefined});
  }
  if (!active.state.routes) {
    const routes = modelRoutes(ctx);
    for (const key of new Set(Object.values(routes))) if (key) resolveModel(ctx, key);
    checkpoint(active, {...active.state, routes});
  }
  if (!active.state.plan && (["implement", "performance", "correctness", "quality"].includes(active.state.phase) ||
    active.state.exit === "ready")) {
    checkpoint(active, {...active.state, phase: "design", exit: undefined, revision: undefined, candidateId: undefined});
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

function memory(run: Run, snapshot = readProjectMemory(run.root)) {
  const decisions = run.state.decisions ?? [];
  // Old checkpoints may hold user decisions against V IDs. Modern reviews
  // materialize their facts from the versioned project ledger exactly once.
  const legacy = run.state.reports.filter(report => report.phase === "fact-review" &&
    report.outcome === "pass" && report.projectHead === undefined).flatMap(report => report.factChecks ?? []);
  const result = taskMemory(run.task, decisions.filter(d => !d.factId.startsWith("project:")), legacy);
  const humanReferences = new Set([...decisions, ...(run.state.pendingConflicts ?? [])].map(item => item.factId));
  result.facts = result.facts.filter(item => !item.id.startsWith("V") || humanReferences.has(item.id));
  const latest = run.state.reports.slice(run.state.cycleStart ?? 0).findLast(r => r.phase === "fact-review" && r.outcome === "pass");
  const accepted = latest?.factChecks?.filter((_, i) => latest.review?.items.find(item => item.id === "P" + (i + 1))?.memoryUse !== "change-evidence");
  result.facts.push(...projectFacts(snapshot, run.state.base, accepted).map(fact => {
    const version = snapshot.records[fact.id].version;
    const decision = decisions.findLast(d => d.factId === fact.id &&
      (d.conflict.projectVersion === version || (d.projectChange?.expected === version - 1 && d.text === snapshot.records[fact.id].text)));
    return decision ? { ...fact, userDecision: decision } : fact;
  }));
  return result;
}

function buildPhaseInput(run: Run, phase: Phase, attempt: string, projectSnapshot: ProjectSnapshot, magpieCandidates?: Awaited<ReturnType<typeof recallMagpieMemory>> & {receipts?: string[]}) {
  const { task, state } = run;
  const fixed = JSON.stringify({ task: task.id, type: task.type, base: state.base, revision: state.revision,
    branch: state.branch, phase, attempt, plan: state.plan, planGap: state.planGap,
    userAnswers: state.userAnswers ?? [], designActions: phase === "design" ?
      state.designActions?.filter(action => action.version === (state.plan?.version ?? 0)) : undefined,
    ...memory(run, projectSnapshot), magpieCandidates, decisions: state.decisions ?? [],
    priorReports: workerContext(phase, state.reports.slice(state.cycleStart ?? 0)) }, null, 2);
  const upstream = loadUpstreamInputs(state.upstream, phase, task.type);
  const methods = upstream.flatMap(file => ["## 当前阶段的上游方法 " + file.source, file.text]);
  const guidance = [prompts[phase]];
  if (phase === "fact-check") guidance.push(memoryGuide, magpieGuide);
  if (phase === "fact-check") guidance.push(prompts[task.type.startsWith("fix-") ? "fact-check-fix" : "fact-check-new"]);
  return [common, ...guidance, ...methods, methodDirectory(workerMethodStages(phase)), "## 当前运行数据", fixed, "## 任务书原文", task.markdown,
    ...(task.facts !== undefined ? ["## 任务书随附事实", task.facts] : [])].join("\n\n");
}

export default function taskbookExtension(pi: ExtensionAPI) {
  let run: Run | undefined;
  let attempt: string | undefined;
  let started = false;
  let setupTools: string[] | undefined;
  let pendingSetup: { session: string; cwd: string; report: string } | undefined;
  let reported = false;
  let launching = false;
  let phaseInput: string | undefined;
  let workerSnapshot: ProjectSnapshot | undefined;
  const observations = new Map<string, Observation>();

  let reviewing: AbortController | undefined;
  let assisting: AbortController | undefined;
  let initialModel: ExtensionContext["model"];
  const observedCalls = new Map<string, string>();
  const candidateOutputs = new Map<string, Omit<RunObservation, "observed"> & { text: string[] }>();

  registerMethodTool(pi, () => run && started && !reported && run.state.phase !== "exit"
    ? run.state.phase : undefined);

  function toggleReportTool(enabled: boolean) {
    const tools = pi.getActiveTools().filter(name => name !== reportTool && name !== methodTool && !designTools.includes(name));
    if (enabled && run?.state.phase === "design") tools.push(...designTools);
    if (enabled) tools.push(reportTool, methodTool);
    pi.setActiveTools(tools);
  }

  function pauseForUser(ctx: ExtensionContext, active: Run) {
    toggleReportTool(false);
    const pending = active.state.pendingConflicts!;
    const facts = memory(active).facts;
    ctx.ui.setStatus("pi-taskbook", "等待用户裁决事实冲突");
    const details = pending.map(item => item.factId + (item.projectVersion ? "（核查版本 @" + item.projectVersion + "）" : "") +
      " · " + (facts.find(f => f.id === item.factId)?.text ?? "当前快照中已退役或不适用") + "\n新观察：" + item.observation);
    ctx.ui.notify("等待用户裁决事实冲突 · " + active.task.id + "\n" + details.join("\n") +
      "\n/taskbook-decide " + pending[0].factId + " keep <理由> 或 replace <完整新事实>", "warning");
  }

  async function startPhase(ctx: ExtensionContext): Promise<void> {
    if (!run || run.state.phase === "exit") return;
    workspace(ctx.cwd, run.task, run.state.base, run.state.branch);
    if (run.state.pendingConflicts?.length) return pauseForUser(ctx, run);
    if (run.state.pendingQuestion) {
      toggleReportTool(false);
      ctx.ui.setStatus("pi-taskbook", "等待任务负责人裁决");
      ctx.ui.notify("等待任务负责人裁决 · " + run.state.pendingQuestion.question + "\n/taskbook-answer <裁决或已补齐的条件>", "warning");
      return;
    }
    if (run.state.phase === "implement" && !run.state.plan) checkpoint(run, {...run.state, phase: "design"});
    const phase = run.state.phase;
    if (phase === "fact-review" || phase === "correctness" || phase === "quality") {
      return startReview(ctx, run, phase);
    }
    const routes = run.state.routes!;
    const target = resolveModel(ctx, phase === "design" ? routes.design : phase === "implement" ? routes.implement
      : phase === "fact-check" ? routes.factCheck ?? routes.initial : routes.performance ?? routes.initial);
    if ((!ctx.model || modelKey(ctx.model) !== modelKey(target)) && !await pi.setModel(target)) {
      throw new Error("角色模型不可用 " + modelKey(target));
    }
    toggleReportTool(true);
    const token = randomUUID();
    const active = run;
    const priorState = active.state;
    const magpieCandidates = phase === "fact-check" ? await recallMagpieMemory(active.root, active.task.repository.split("/")[1],
      taskbookMemoryChanges(active.task.markdown).filter(c => c.scope.startsWith("cross-project:")).map(c => c.key)) : undefined;
    if (run !== active || active.state !== priorState) return;
    observedCalls.clear();
    candidateOutputs.clear();
    observations.clear();
    const receipts = magpieCandidates?.status === "available" ? magpieCandidates.results.map((text, index) => {
      const receipt = randomUUID();
      observations.set(receipt, {toolName:"magpie:memory_search", toolCallId:receipt, isError:false,
        input:magpieCandidates.searches[index], head:active.state.base, text:[text]});
      return receipt;
    }) : [];
    workerSnapshot = readProjectMemory(active.root);
    phaseInput = buildPhaseInput(active, phase, token, workerSnapshot, magpieCandidates ? {...magpieCandidates, receipts} : undefined);
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
    const projectSnapshot = readProjectMemory(active.root);
    const { goals, facts, delivery } = memory(active, projectSnapshot);
    const changes = factReview ? pendingMemoryChanges(task, projectSnapshot, state.decisions) : [];
    if (phase === "quality") {
      const spec = current.findLast(r => r.phase === "correctness" && r.candidateId === state.candidateId);
      if (spec && spec.projectHead !== projectSnapshot.head) {
        checkpoint(active, { ...state, phase: "correctness" });
        return startPhase(ctx);
      }
    }
    const candidateReports = current.filter(report => report.candidateId === state.candidateId &&
      (report.phase === "implement" || report.phase === "performance"))
      .map(report => ({phase: report.phase, pointers: report.evidence, observations: report.observations ?? []}));
    const magpieCandidates = factReview ? await recallMagpieMemory(active.root, task.repository.split("/")[1],
      changes.filter(c => c.scope.startsWith("cross-project:")).map(c => c.key)) : undefined;
    if (run !== active || active.state !== state) return;
    if (magpieCandidates?.status === "unavailable" && changes.some(c => c.scope.startsWith("cross-project:"))) {
      throw new Error("跨项目变更需要查询现有全局记忆，独立审核已暂停。" + magpieCandidates.reason);
    }
    const classifyFactChecks = factReview && (taskbookMemoryChanges(task.markdown).length > 0 ||
      Boolean(state.decisions?.some(d => d.factId.startsWith("project:"))));
    const evidence = { ...(factReview ? {factChecks: proposals, magpieCandidates, classifyFactChecks, priorProjectFacts: historicalProjectFacts(projectSnapshot)} : {candidateReports}),
      decisions: state.decisions ?? [], userAnswers: state.userAnswers ?? [] };
    const methods = loadUpstreamInputs(state.upstream, phase, task.type);
    const objectives = factReview ? proposals.map((proposal, i) => ({id: "P" + (i+1), text: JSON.stringify(proposal)}))
      : [...goals, ...delivery];
    if (phase === "correctness") {
      objectives.push(...(state.userAnswers ?? []).map((answer, index) => ({
        id: "ANSWER" + (index + 1), text: JSON.stringify({ ...answer, obligation: "核对候审结果是否符合用户对这个问题的原始答复。" }),
      })));
    }
    if (phase === "correctness" && state.plan) {
      const {version, steps} = state.plan;
      objectives.push(...steps.map((step, index) => ({id:"PLAN" + (index + 1),
        text: JSON.stringify({version, step, obligation:"对照候审提交与运行证据，核对约定行为和验收判据。"})})));
    }
    if (factReview) {
      objectives.push(...changes.map((change, index) => ({ id: "M" + (index + 1),
        text: JSON.stringify({ ...change, current: projectSnapshot.records[memoryId(change.kind, change.key)] ?? null }) })));
      methods.push({source: "pi-taskbook:project-memory", text: memoryGuide}, {source: "pi-taskbook:magpie-memory", text: magpieGuide});
    }
    const controller = new AbortController();
    reviewing = controller;
    let review: ReviewResult;
    try {
      review = await runIndependentReview(ctx, {root: active.root, base: state.base, revision, role: phase,
        taskbook: task.markdown, facts, objectives, evidence, methods}, controller.signal, resolveModel(ctx, reviewerModel(state.routes!, phase)));
    } catch (error) {
      if (controller.signal.aborted || run !== active) return;
      throw error;
    } finally {
      if (reviewing === controller) reviewing = undefined;
    }
    if (controller.signal.aborted || run !== active || active.state !== state) return;
    workspace(ctx.cwd, task, state.base, state.branch);
    if (!factReview && cleanRevision(active) !== revision) throw new Error("独立审核期间候审工作区发生变化。");
    if (review.verdict === "pass" && factReview) {
      applyApprovedMemory(active.root, projectSnapshot, task, state.base, changes, proposals, review, classifyFactChecks);
      await syncMagpieMemory(active.root, task.digest);
      if (run !== active || active.state !== state) return;
    } else if (readProjectMemory(active.root).head !== projectSnapshot.head) {
      throw new Error("审核期间项目记忆已更新；请重交同一任务书复核。");
    }
    const conflicts = review.conflicts.map(conflict => ({...conflict,
      projectVersion: projectSnapshot.records[conflict.factId]?.version}));
    conflicts.forEach(item => validateConflict(facts, item));
    const measured = candidateReports.some(report => report.phase === "performance");
    const next = nextPhase(task.type, phase, review.verdict, measured);
    // When neither the artifact nor the submitted evidence changed, send the
    // repeated finding back to the human instead of rerunning the same loop.
    const equivalent = factReview ? proposals.map(p => [p.claim, p.observed, p.source.kind === "git" ? p.origin : [p.toolInput, p.observedHead, p.toolError]]) :
      candidateReports.map(r => [r.phase, r.pointers, r.observations.map(o => [o.toolName, o.input, o.observed, o.isError])]);
    const reviewInput = createHash("sha256").update(JSON.stringify([phase, revision, projectSnapshot.head, state.plan?.version, changes, magpieCandidates, equivalent])).digest("hex");
    const repeated = review.verdict === "rework" && current.some(r => r.outcome === "rework" && r.reviewInput === reviewInput);
    const report: Report = { phase, outcome: review.verdict, review, reviewInput, projectHead: projectSnapshot.head,
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

  async function release(ctx: ExtensionContext) {
    observedCalls.clear();
    candidateOutputs.clear();
    observations.clear();
    assisting?.abort();
    assisting = undefined;
    reviewing?.abort();
    reviewing = undefined;
    run = undefined;
    attempt = undefined;
    phaseInput = undefined;
    workerSnapshot = undefined;
    started = false;
    reported = false;
    toggleReportTool(false);
    ctx.ui.setStatus("pi-taskbook", undefined);
    const previous = initialModel;
    initialModel = undefined;
    if (previous && (!ctx.model || modelKey(ctx.model) !== modelKey(previous))) await pi.setModel(previous);
  }

  async function exitInvocation(ctx: ExtensionContext, reason: string, recoverable?: Run) {
    const message = recoverable
      ? `退出（可恢复） · ${reason}\n检查点 ${recoverable.path}\n再次提交同一任务书可从检查点恢复。`
      : "退出（阻塞） · " + reason;
    await release(ctx);
    ctx.ui.notify(message, "warning");
  }

  async function announce(ctx: ExtensionContext, active: Run) {
    const labels = { ready: "可交接", blocked: "有阻塞", cancelled: "已取消" };
    const state = active.state;
    const lines = [labels[state.exit!] + " · " + active.task.id];
    if (state.exit === "blocked") lines.push("阻塞原因 · " + (state.stopReason ?? state.reports.at(-1)?.summary ?? "见审计记录。"));
    if (state.revision) lines.push((state.exit === "ready" ? "交付提交 " : "候审提交 ") + state.revision);
    if (state.exit === "ready") {
      const candidateReports = state.reports.filter(report => report.candidateId === state.candidateId);
      const evidenceHead = candidateReports.findLast(report => report.phase === "quality")?.projectHead;
      if (evidenceHead) lines.push("已审核的项目记忆版本 " + evidenceHead);
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
    await release(ctx);
    pi.sendMessage({ customType: "pi-taskbook-exit", content: handoff, display: true }, { triggerTurn: false });
  }

  pi.registerCommand("taskbook-setup", {
    description: "检查初始化条件，或执行用户明确批准的初始化改动",
    async handler(args, ctx) {
      if (!ctx.isIdle() || attempt || launching || reviewing || assisting ||
          run?.state.pendingQuestion || run?.state.pendingConflicts?.length) {
        return ctx.ui.notify("请在任务书会话空闲且没有待裁决事项时运行 /taskbook-setup。", "warning");
      }
      const request = args.trim();
      const approved = request.match(/^apply\s+([\s\S]+)$/)?.[1];
      if (request && !approved) {
        return ctx.ui.notify("用法 /taskbook-setup 或 /taskbook-setup apply <批准的改动>", "warning");
      }
      const session = ctx.sessionManager.getSessionId();
      launching = true;
      try {
        if (approved) {
          if (!pendingSetup || pendingSetup.session !== session || pendingSetup.cwd !== ctx.cwd) {
            return ctx.ui.notify("当前会话没有待批准的初始化检查。", "warning");
          }
          if (!ctx.model) return ctx.ui.notify("请选择执行初始化的 Pi 模型。", "warning");
          const content = JSON.stringify({ approved, report: pendingSetup.report });
          pendingSetup = undefined;
          pi.sendMessage({ customType: setupApplyType, content, display: false }, { triggerTurn: true });
          return;
        }
        pendingSetup = undefined;
        const report = JSON.stringify(await collectSetup(pi, ctx), null, 2);
        if (!ctx.model) return ctx.ui.notify(report, "warning");
        pendingSetup = { session, cwd: ctx.cwd, report };
        pi.sendMessage({ customType: setupType, content: report, display: false }, { triggerTurn: true });
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      } finally {
        launching = false;
      }
    },
  });

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
        initialModel ??= ctx.model;
        run = candidate;
        toggleReportTool(true);
        await startPhase(ctx);
      } catch (error) {
        await exitInvocation(ctx, String(error), run);
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
        await exitInvocation(ctx, String(error) + recovery);
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
        await announce(ctx, run);
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });

  pi.registerCommand("taskbook-answer", {
    description: "答复当前设计上抛的问题，再由设计者修订方案",
    async handler(args, ctx) {
      if (!run?.state.pendingQuestion || reviewing || assisting || attempt || !ctx.isIdle()) {
        return ctx.ui.notify("没有正在等待用户答复的设计问题。", "warning");
      }
      const answer = args.trim();
      if (!answer) return ctx.ui.notify("请明确给出决定或已补齐的条件。", "warning");
      const {question} = run.state.pendingQuestion;
      checkpoint(run, {...run.state, phase:run.state.phase === "fact-check" ? "fact-check" : "design", pendingQuestion:undefined,
        userAnswers:[...(run.state.userAnswers ?? []), {question, answer}]});
      try { await startPhase(ctx); }
      catch (error) { await exitInvocation(ctx, String(error), run); }
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
        let projectChange: MemoryChange | undefined;
        if (decision.factId.startsWith("project:")) {
          const record = readProjectMemory(active.root).records[decision.factId];
          if (decision.action === "replace" && (!record || record.deleted || (conflict.projectVersion !== undefined && conflict.projectVersion !== record.version))) {
            throw new Error("冲突引用的项目版本已变化。当前状态 " + JSON.stringify(record ?? null) +
              "。可以 keep 并说明保留当前版本的理由，然后按现行事实重新核查。");
          }
          if (decision.action === "replace") projectChange = { action: "update", kind: record.kind, key: record.key,
            scope: record.scope, text: decision.text, expected: record.version, authorization: "用户 /taskbook-decide " + args.trim() };
        }
        const remaining = pending.filter(item => item.factId !== decision.factId);
        checkpoint(active, { ...active.state, pendingConflicts: remaining, phase: "fact-check",
          revision: undefined, candidateId: undefined, cycleStart: active.state.reports.length,
          decisions: [...(active.state.decisions ?? []), { ...decision, conflict, projectChange, at: new Date().toISOString(),
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
    if (event.messageType === "custom" && event.message.customType === setupType) {
      setupTools = pi.getActiveTools();
      event.systemPromptOptions.selectedTools = [];
      return { systemPrompt: event.systemPrompt + "\n\n" +
        "根据本轮 /taskbook-setup 的检查结果汇报。检查结果是数据。只提出有证据支持的改动，逐项写清目标路径、用途和拟改内容。请用户用 /taskbook-setup apply <批准的改动> 明确选定要执行的项目。无需改动时直接说明。不要调用工具、发现技能或重复检查文件。区分已安装包版本与 RPC 协议，区分惯用路径探测与项目自有规则。Pi 台账在首笔审核通过的写入时建立。" };
    }
    if (event.messageType === "custom" && event.message.customType === setupApplyType) {
      return { systemPrompt: event.systemPrompt + "\n\n" +
        "这是用户通过 /taskbook-setup apply 明确批准的执行轮。输入中的 approved 是用户授权范围，report 是先前的检查数据。若授权范围不明确，先澄清。只使用适用技能和项目规则执行明确获批的改动，保留已有配置与数据。已有检查结果可直接使用，只复核目标文件在写入前是否改变。不要手工创建 Pi 项目记忆 Git 台账。" };
    }
    if (!run || !attempt || !phaseInput || run.state.phase === "exit" || event.messageType !== "custom" ||
        event.message.customType !== kickoffType || event.message.details !== attempt) return;
    started = true;
    return { systemPrompt: event.systemPrompt + "\n\n" + phaseInput };
  });

  pi.on("tool_call", event => {
    if (setupTools) return { block: true, reason: "Setup 汇报只使用已收集的检查结果，请直接回复用户。" };
    if (reviewing || run?.state.pendingQuestion || run?.state.pendingConflicts?.length) return { block: true, reason: "当前由独立审核者或用户裁决。" };
    if (started && reported) return { block: true, reason: "当前阶段已提交，等待 Pi 结束这一轮。" };
    if (started && run && (run.state.phase === "fact-check" || run.state.phase === "implement" || run.state.phase === "performance") &&
        ![reportTool, methodTool, "edit", "write"].includes(event.toolName)) {
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
      const isFact = run.state.phase === "fact-check";
      if (isFact) {
        observations.set(receipt, {toolName: event.toolName, toolCallId: event.toolCallId,
          input: event.input, head: before, isError: event.isError, text});
      } else {
        candidateOutputs.set(receipt, { revision: before, toolName: event.toolName, toolCallId: event.toolCallId,
          input: event.input, isError: event.isError, text });
      }
      return { content: [...event.content, { type: "text" as const, text: (isFact ? "事实核查回执 " : "候审观测回执 ") + receipt }],
        structuredContent: event.structuredContent };
    }
  });

  async function designAction(kind: "consult" | "experiment", token: string, request: unknown,
    signal: AbortSignal | undefined, perform: (active: Run, signal: AbortSignal) => Promise<unknown>) {
    const active = run;
    if (!active || active.state.phase !== "design" || !started || reported || token !== attempt || assisting) {
      throw new Error("设计行动需要有效、空闲的设计阶段。");
    }
    const controller = new AbortController();
    assisting = controller;
    const stop = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    try {
      const result = await perform(active, stop);
      stop.throwIfAborted();
      if (run !== active || attempt !== token || reported) throw new Error("设计行动已过期。");
      const action = {kind, version: active.state.plan?.version ?? 0, request, result};
      checkpoint(active, {...active.state, designActions: [...(active.state.designActions ?? []), action]});
      return {content: [{type: "text" as const, text: JSON.stringify(result)}], details: {kind}};
    } finally {
      if (assisting === controller) assisting = undefined;
    }
  }

  pi.registerTool({
    name: "taskbook_consult", label: "派发独立设计咨询", defaultActive: false,
    description: "把一个明确的技术分歧交给只读的新 Pi 会话，返回意见、固定提交和观察回执。",
    parameters: Type.Object({attempt: Type.String(), question: Type.String({minLength:1, maxLength:4000}),
      methods: Type.Optional(Type.Array(Type.String({minLength:1}), {uniqueItems:true, maxItems:4, description:"此问题需要的本阶段方法标识"}))}, {additionalProperties:false}),
    async execute(_id, {attempt: token, question, methods: selection = []}, signal, _onUpdate, ctx) {
      return designAction("consult", token, {question, methods:selection}, signal, async (active, stop) => {
        const {state, task} = active;
        const {facts, goals, delivery} = memory(active);
        const methods = loadUpstreamInputs(state.upstream, "design", task.type);
        for (const id of selection) {
          const method = readStageMethod(id, workerMethodStages("design"), "design");
          if (!methods.some(core => core.source === method.source)) methods.push(method);
        }
        return consultDesign(ctx, {root: active.root, base: state.base, revision: git(active.root, "rev-parse", "HEAD"),
          taskbook: task.markdown, facts, objectives:[...goals, ...delivery], methods,
          evidence: {plan:state.plan, gap:state.planGap, decisions:state.decisions, userAnswers:state.userAnswers}},
          question, resolveModel(ctx, state.routes!.consult ?? state.routes!.design), stop);
      });
    },
  });

  pi.registerTool({
    name: "taskbook_probe", label: "运行最小设计实验", defaultActive: false,
    description: "在当前 HEAD 的临时检出运行 argv；记录假设、判据、实际输出和退出码，然后删除检出。",
    parameters: Type.Object({attempt: Type.String(), hypothesis: Type.String({minLength:1, maxLength:4000}),
      criterion: Type.String({minLength:1, maxLength:4000}), argv: Type.Array(Type.String(), {minItems:1, maxItems:100})},
    {additionalProperties:false}),
    async execute(_id, {attempt: token, hypothesis, criterion, argv}, signal) {
      return designAction("experiment", token, {hypothesis, criterion, argv}, signal, async (active, stop) =>
        runProbe(active.root, git(active.root, "rev-parse", "HEAD"), argv, stop));
    },
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
      if (assisting) throw new Error("先等待本轮设计子任务完成，再提交阶段报告。");
      if (params.plan && (phase !== "design" || outcome !== "pass")) throw new Error("只有设计阶段可提交通过的执行方案。");
      if (phase === "implement" && params.planVersion !== run.state.plan?.version) throw new Error("执行报告须对应当前 planVersion。");
      if (phase === "implement" && outcome === "blocked") throw new Error("执行受阻时用 plan-gap 报告步骤、观察和决策问题，由设计者决定。");
      if (outcome === "plan-gap" && (phase !== "implement" || !params.gap?.observation.trim() || !params.gap.question.trim() ||
        !run.state.plan?.steps.some(step => step.id === params.gap!.stepId))) throw new Error("plan-gap 须引用当前方案的具体步骤并给出观察与待决问题。");
      if (params.gap && outcome !== "plan-gap") throw new Error("gap 仅用于 plan-gap。");
      let plan = run.state.plan;
      if (phase === "design" && outcome === "pass") {
        if (!params.plan) throw new Error("设计通过需要提交结构化 plan.steps。");
        const {goals, delivery} = memory(run);
        plan = acceptPlan(params.plan.steps, [...goals,...delivery].map(item => item.id), plan?.version);
      }
      const summary = params.summary.trim();
      const evidence = params.evidence.map(item => item.trim()).filter(Boolean);
      if (phase === "fact-review" || phase === "correctness" || phase === "quality") throw new Error("审核须由插件派发。");
      if ((outcome === "fact-conflict") !== Boolean(params.conflicts?.length)) throw new Error("事实冲突须提交 conflicts。");
      const projectSnapshot = workerSnapshot;
      const conflicts = params.conflicts?.map(item => {
        validateConflict(memory(run!, projectSnapshot).facts, item);
        return {...item, projectVersion: projectSnapshot?.records[item.factId]?.version};
      });
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
      const report: Report = { phase, outcome, summary, evidence, factChecks, candidateId, model:ctx.model && modelKey(ctx.model),
        planVersion:plan?.version, plan: params.plan ? plan : undefined, gap:params.gap, observations: candidateObservations, conflicts };
      const previousGap = run.state.reports.findLast(report => report.outcome === "plan-gap");
      const repeatedGap = outcome === "plan-gap" && previousGap?.gap?.stepId === params.gap!.stepId &&
        previousGap.gap.observation.trim() === params.gap!.observation.trim() &&
        previousGap.gap.question.trim() === params.gap!.question.trim();
      const sameModel = run.state.routes!.design === run.state.routes!.implement;
      const question = outcome === "needs-user" ? summary : repeatedGap ?
        "修订方案后，同一步骤和观察再次受阻。请决定下一步：" + params.gap!.question : outcome === "plan-gap" && sameModel ?
        "执行者退回方案，当前配置未指定不同的设计模型。请给出决定或处理意见：" + params.gap!.question : undefined;
      checkpoint(run, { ...run.state, revision, candidateId, plan, pendingQuestion:question ? {question} : undefined,
        planGap: outcome === "plan-gap" ? {...params.gap!, planVersion: plan?.version, revision: git(run.root,"rev-parse","HEAD"),
          evidence, summary} : params.plan ? undefined : run.state.planGap, pendingConflicts: conflicts,
        phase: next === "ready" || next === "blocked" ? "exit" : next,
        exit: next === "ready" || next === "blocked" ? next : undefined, reports: [...run.state.reports, report] });
      reported = true;
      return { content: [{ type: "text", text: "阶段结果已登记。结束当前轮次。" }], details: { phase } };
    },
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (setupTools) {
      const tools = setupTools;
      setupTools = undefined;
      pi.setActiveTools(tools);
    }
    if (!run || !started) return;
    started = false;
    attempt = undefined;
    if (run.state.phase === "exit") return announce(ctx, run);
    if (event.aborted || !reported) {
      return exitInvocation(ctx, event.aborted ? "当前轮次被中断。" : "本轮结束前没有通过校验的阶段报告。", run);
    }
    try { await startPhase(ctx); }
    catch (error) { await exitInvocation(ctx, String(error), run); }
  });
}

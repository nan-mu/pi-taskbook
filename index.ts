import { buildPhaseInput, localPromptDigest, magpieGuide, memoryGuide, readRunContext } from "./src/workflow/phase-input.ts";
import { registerSetupCommand } from "./src/setup/command.ts";
import { checkpoint, cleanRevision, matchesDeliveryHead, openRun, type Report, type Run, type RunObservation } from "./src/workflow/checkpoint.ts";
import { magpieSessionTransport, readSourceProjectFacts, recallMagpieMemory, syncMagpieMemory, type MagpieSyncResult } from "./src/integrations/magpie-memory.ts";
import { readStageMethod, workerMethodStages } from "./src/methods/catalog.ts";
import { methodTool, registerMethodTool } from "./src/methods/tool.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { git, readTaskbook, workspace, type Taskbook } from "./src/taskbook/document.ts";
import { nextPhase, stages, titles, type Phase } from "./src/workflow/transitions.ts";
import { prepareTaskLaunch, readEntryArgument, readTaskbookInput } from "./src/taskbook/entry.ts";
import { hasT3Context, launchT3Thread, readT3Workspace } from "./src/integrations/t3.ts";
import { loadUpstreamInputs, pinUpstreamInputs } from "./src/methods/upstream.ts";

import { validateConflict, parseFactDecision, taskMemory } from "./src/workflow/task-context.ts";
import { consultDesign, runIndependentReview, type ReviewResult } from "./src/review/reviewer.ts";
import { checkFacts, factChecksParameter, type Observation } from "./src/facts/fact-check.ts";
import { maxFactMatches, queryProjectFacts } from "./src/facts/query.ts";
import { intakeTargetsParameter, importTaskFacts, readTopicFacts, type IntakeDecision } from "./src/facts/taskbook-intake.ts";
import { alwaysPrompt } from "./src/facts/always.ts";
import { readFactFile } from "./src/facts/commit-files.ts";

import { applyApprovedMemory, historicalProjectFacts, memoryId, pendingMemoryChanges, projectFactsPath, readProjectMemory, taskbookMemoryChanges, type MemoryChange, type ProjectSnapshot } from "./src/facts/project-memory.ts";

import { acceptPlan, planParameter, runProbe } from "./src/workflow/design-worker.ts";
import { archiveDesign, removeDesignArchive } from "./src/workflow/design-archive.ts";
import { modelKey, roleSelection } from "./src/models/config.ts";
import { readFileSync } from "node:fs";
import { resumeTeam, runTeam, selectedPlaybook } from "./src/workflow/team.ts";
import { placementParameter, registerReviewedFacts, reviewedDrafts, validatePlacements } from "./src/workflow/register-facts.ts";
import { githubHandoff, githubHandoffTools, pullRequestActions, type PullRequestAction } from "./src/integrations/github-handoff.ts";
import { deliveryFactDiff, preparePublication, publicationHasComments, publicationLabels, publicationPreview, publishDelivery, PublicationChanged } from "./src/workflow/publication.ts";

const reportTool = "taskbook_report";
const queryFactsTool = "taskbook_query_facts";
const designTools = ["taskbook_consult", "taskbook_probe"];
const directDelegation = (name: string) => /^(?:agent|subagents?|subagentworkflow|get_subagent_result|steer_subagent|workflow|delegate_task|create_threads|t3_thread_launch)(?:_[\da-f]+)?$/i.test(name.split("__").at(-1) ?? name);
const kickoffType = "pi-taskbook-stage";
const t3Continuation = "pi-taskbook-t3-continuation";
const taskbookPrefix = "/taskbook ";
const publishKickoff = "pi-taskbook-publication";
const publishTool = "taskbook_publish_pr";
const tailPrompts = {
  "fact-registration": readFileSync(new URL("./prompts/fact-registration.md", import.meta.url), "utf8"),
  handoff: readFileSync(new URL("./prompts/handoff.md", import.meta.url), "utf8"),
};
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
  factPlacements: Type.Optional(placementParameter),
  pullRequest: Type.Optional(Type.Union(pullRequestActions.map(action => Type.Literal(action)))),
  intakeTargets: Type.Optional(intakeTargetsParameter),
  intakeConflicts: Type.Optional(Type.Array(Type.Object({id: Type.String(), reason: Type.String({minLength: 1, maxLength: 4000})},
    {additionalProperties: false}), {minItems: 1})),
  observedRuns: Type.Optional(Type.Array(Type.Object({receipt: Type.String(), observed: Type.String({minLength: 1, maxLength: 4000})}, {additionalProperties: false}), {minItems: 1, maxItems: 20})),
  conflicts: Type.Optional(Type.Array(Type.Object({factId: Type.String(), observation: Type.String({minLength: 1, maxLength: 4000})}, {additionalProperties: false}), {minItems: 1, maxItems: 20})),
}, { additionalProperties: false });

function requireApprovedFacts(run: Run, snapshot: ProjectSnapshot) {
  if (run.state.approvedProjectHead !== undefined && snapshot.head !== run.state.approvedProjectHead) {
    throw new Error("当前 .fact 与本任务已独立审核的版本不同，请恢复已审核版本后重试。");
  }
  if (run.state.topicFactsHead !== undefined && readTopicFacts(run.root).head !== run.state.topicFactsHead) {
    throw new Error("标签事实与本任务已同步的版本不同，请恢复对应版本后重试。");
  }
}

export default function taskbookExtension(pi: ExtensionAPI) {
  let run: Run | undefined;
  let attempt: string | undefined;
  let started = false;
  let syncCaller: { id: string; path: string; revision: string; transport: ReturnType<typeof magpieSessionTransport> } | undefined;
  let syncing = false;
  let reported = false;
  let launching = false;
  let relocated = false;
  let publishing: {token: string; run: Run; suggested?: PullRequestAction; previousTools: string[];
    nestedTools: Set<string>; active: boolean; caller?: string} | undefined;
  let phaseInput: string | undefined;
  let workerSnapshot: ProjectSnapshot | undefined;
  let intakeSnapshot: ReturnType<typeof readTopicFacts> | undefined;
  const observations = new Map<string, Observation>();

  let reviewing: AbortController | undefined;
  let assisting: AbortController | undefined;
  let coordinating: {controller: AbortController; settled: Promise<void>} | undefined;
  let initialModel: ExtensionContext["model"];
  let initialThinking: ExtensionContext["thinkingLevel"] | undefined;
  const suspendedTools = new Set<string>();
  const observedCalls = new Map<string, string>();
  const candidateOutputs = new Map<string, Omit<RunObservation, "observed"> & { text: string[] }>();

  registerMethodTool(pi, () => run && started && !reported && run.state.phase !== "exit"
    ? {phase: run.state.phase, type: run.task.type} : undefined);

  pi.registerTool({
    name: queryFactsTool,
    label: "Search project facts",
    description: "Find relevant project memory and source pointers in the task view of project facts. An exact registered label searches across tables. Check the source before using a result as evidence.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 240, description: "An exact label such as worktree, or search terms." }),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Restrict a text query to one registered label." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxFactMatches, default: 5 })),
    }, { additionalProperties: false }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      let root = run?.root ?? ctx.cwd;
      if (!run) {
        try { root = (await readT3Workspace(ctx.cwd))?.root ?? git(ctx.cwd, "rev-parse", "--show-toplevel"); } catch {}
      }
      const view = run && run.root === root && run.state.phase !== "fact-management" && !run.state.team?.registered
        ? run.state.factView : undefined;
      const result = await queryProjectFacts(root, input, view);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  function toggleReportTool(enabled: boolean) {
    const tools = pi.getActiveTools().filter(name => name !== reportTool && name !== methodTool && !designTools.includes(name));
    if (!run) {
      tools.push(...[...suspendedTools].filter(name => !tools.includes(name)));
      suspendedTools.clear();
    }
    if (enabled && run?.state.phase === "design") tools.push(...(run.state.designConsult ? ["taskbook_probe"] : designTools));
    if (enabled) tools.push(reportTool, methodTool);
    pi.setActiveTools(run ? tools.filter(name => {
      if (!directDelegation(name) && !(relocated && name === "read")) return true;
      suspendedTools.add(name);
      return false;
    }) : tools);
  }

  function pauseForUser(ctx: ExtensionContext, active: Run) {
    toggleReportTool(false);
    const pending = active.state.pendingConflicts!;
    const facts = readRunContext(active).facts;
    ctx.ui.setStatus("pi-taskbook", "等待用户裁决事实冲突");
    const details = pending.map(item => item.factId + (item.projectVersion ? "（核查版本 @" + item.projectVersion + "）" : "") +
      " · " + (facts.find(f => f.id === item.factId)?.text ?? "当前快照中已退役或不适用") + "\n新观察：" + item.observation);
    ctx.ui.notify("等待用户裁决事实冲突 · " + active.task.id + "\n" + details.join("\n") +
      "\n请直接回复 " + pending[0].factId + " keep <理由> 或 " + pending[0].factId + " replace <完整新事实>", "warning");
  }

  function pauseIntake(ctx: ExtensionContext, active: Run) {
    toggleReportTool(false);
    ctx.ui.setStatus("pi-taskbook", "等待用户裁决事实同步");
    const conflicts = active.state.intakeConflicts ?? [];
    ctx.ui.notify(conflicts.map(item => item.id + " · " + item.reason).join("\n") +
      "。\n请直接回复 <条目> use <已有事实>、<条目> update <已有事实>、<条目> delete <已有事实> 或 <条目> create <目标路径或区分理由>", "warning");
  }

  async function startPhase(ctx: ExtensionContext): Promise<void> {
    if (!run || run.state.phase === "exit") return;
    workspace(run.root, run.task, run.state.base, run.state.branch);
    if (run.state.intakeConflicts?.length) return pauseIntake(ctx, run);
    if (run.state.pendingConflicts?.length) return pauseForUser(ctx, run);
    if (run.state.pendingQuestion) {
      toggleReportTool(false);
      ctx.ui.setStatus("pi-taskbook", "等待任务负责人裁决");
      ctx.ui.notify("等待任务负责人裁决 · " + run.state.pendingQuestion.question + "\n请在当前会话直接回复你的决定或已补齐的条件。", "warning");
      return;
    }
    if (run.state.phase === "implement" && !run.state.plan) checkpoint(run, {...run.state, phase: "design"});
    const phase = run.state.phase;
    if (run.state.taskFacts && (phase === "design" || phase === "implement" || phase === "performance" || phase === "review")) {
      const active = run;
      const controller = new AbortController();
      toggleReportTool(false);
      const settled = runTeam(active, ctx, controller.signal, value => ctx.ui.setStatus("pi-taskbook", value));
      coordinating = {controller, settled};
      void settled.then(async () => {
        if (coordinating?.controller === controller) coordinating = undefined;
        if (!controller.signal.aborted && run === active) await startPhase(ctx);
      }).catch(async error => {
        if (coordinating?.controller === controller) coordinating = undefined;
        if (!controller.signal.aborted && run === active) await exitInvocation(ctx, String(error), active);
      });
      return;
    }
    if (phase === "fact-registration" && (run.state.team?.placements || !reviewedDrafts(run).length)) {
      const active = run;
      const team = active.state.team!;
      const {topicHead, ...registered} = registerReviewedFacts(active, team.placements ?? []);
      const existing = active.state.reports.at(-1);
      const reports: Report[] = existing?.phase === phase ? active.state.reports : [...active.state.reports,
        {phase, outcome: "pass", summary: "没有待登记的 Draft Facts。", evidence: [registered.revision]}];
      checkpoint(active, {...active.state, phase: "handoff", topicFactsHead: topicHead, approvedProjectHead: registered.projectHead, team: {...team, registered}, reports});
      return startPhase(ctx);
    }
    if (phase === "handoff" && run.state.team?.handoff) {
      const active = run;
      if (!matchesDeliveryHead(active, cleanRevision(active))) throw new Error("交付工作区与已签署的实现不同。");
      requireApprovedFacts(active, readProjectMemory(active.root));
      const deliveryRevision = removeDesignArchive(active.root, active.task);
      checkpoint(active, {...active.state, phase: "exit", exit: "ready", deliveryRevision});
      return announce(ctx, active);
    }
    if (phase === "fact-review" || phase === "correctness" || phase === "quality" || phase === "review") {
      return startReview(ctx, run, phase);
    }
    const tail = phase === "fact-registration" || phase === "handoff";
    const {model: target, thinkingLevel} = phase === "fact-management" || (phase === "fact-check" && run.state.reviewPolicy === 2) || tail
      ? {model: initialModel ?? ctx.model, thinkingLevel: initialThinking ?? ctx.thinkingLevel}
      : roleSelection(ctx, run.root, run.state.routes!, phase === "fact-check" ? "factCheck" : phase);
    if (!target) throw new Error("Fact Management 需要主会话模型。");
    if ((!ctx.model || modelKey(ctx.model) !== modelKey(target)) && !await pi.setModel(target)) {
      throw new Error("角色模型不可用 " + modelKey(target));
    }
    if (thinkingLevel !== undefined) pi.setThinkingLevel(thinkingLevel);
    toggleReportTool(true);
    const token = randomUUID();
    const active = run;
    const priorState = active.state;
    const magpieCandidates = phase === "fact-check" ? await recallMagpieMemory(active.root, active.task.repository.split("/")[1],
      taskbookMemoryChanges(active.task.markdown, active.task.id).filter(c => c.scope.startsWith("cross-project:")).map(c => c.key)) : undefined;
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
    requireApprovedFacts(active, workerSnapshot);
    intakeSnapshot = phase === "fact-management" ? readTopicFacts(active.root) : undefined;
    if (intakeSnapshot && !active.state.factBase) {
      checkpoint(active, {...active.state, factBase: git(active.root, "rev-parse", "HEAD")});
    }
    if (intakeSnapshot && active.state.intakeVersion &&
        (active.state.intakeVersion.topics !== intakeSnapshot.head || active.state.intakeVersion.project !== workerSnapshot.head)) {
      checkpoint(active, {...active.state, intakeDecisions: undefined, intakeVersion: undefined});
      ctx.ui.notify("事实版本已变化。同步将重新核对，原裁决用于其当时的版本。", "warning");
    }
    phaseInput = tail ? tailPrompts[phase] + "\n\n" + JSON.stringify({attempt: token, task: active.task.id, userAnswers: active.state.userAnswers,
      ...(phase === "fact-registration" ? {drafts: reviewedDrafts(active),
        topics: [...readTopicFacts(active.root).tables.keys()], labels: readTopicFacts(active.root).labels} : {
        goals: readRunContext(active).goals, delivery: readRunContext(active).delivery,
        factDiff: deliveryFactDiff(active), candidate: active.state.revision,
        reports: active.state.reports.filter(report => ["implement", "review", "fact-registration"].includes(report.phase)),
      })}) : buildPhaseInput(active, phase, token, workerSnapshot,
        magpieCandidates ? {...magpieCandidates, receipts} : undefined, intakeSnapshot);
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
    requireApprovedFacts(active, projectSnapshot);
    if (factReview && current.at(-1)?.projectHead !== projectSnapshot.head) {
      checkpoint(active, { ...state, phase: "fact-check", approvedProjectHead: undefined, cycleStart: state.reports.length });
      return startPhase(ctx);
    }
    const { goals, facts, delivery } = readRunContext(active, projectSnapshot);
    const changes = factReview ? pendingMemoryChanges(task, projectSnapshot, state.decisions) : [];
    if (phase === "quality") {
      const spec = current.findLast(r => r.phase === "correctness" && r.candidateId === state.candidateId);
      if (!spec || spec.outcome !== "pass" || spec.review?.revision !== revision || spec.projectHead !== projectSnapshot.head) {
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
    const classifyFactChecks = factReview && (taskbookMemoryChanges(task.markdown, task.id).length > 0 ||
      Boolean(state.decisions?.some(d => d.factId.startsWith("project:"))));
    const evidence = { projectHead: projectSnapshot.head,
      ...(factReview ? {factChecks: proposals, magpieCandidates, classifyFactChecks,
      priorProjectFacts: historicalProjectFacts(projectSnapshot),
      sourceProjectFactCandidates: readSourceProjectFacts(active.root, task.repository.toLowerCase())} : {candidateReports}),
      decisions: state.decisions ?? [], userAnswers: state.userAnswers ?? [] };
    const methods = loadUpstreamInputs(state.upstream, phase, task.type);
    const objectives = factReview ? proposals.map((proposal, i) => ({id: "P" + (i+1), text: proposal.claim}))
      : [...goals, ...delivery];
    if (phase === "correctness" || phase === "review") {
      objectives.push(...(state.userAnswers ?? []).map((answer, index) => ({
        id: "ANSWER" + (index + 1), text: JSON.stringify({ ...answer, obligation: "针对这条原始答复，指出一个可以推翻“候选已遵循答复”的具体情形，并用候选版本的可读产物或已有回执核查。" }),
      })));
    }
    if ((phase === "correctness" || phase === "review") && state.plan) {
      const {version, steps} = state.plan;
      objectives.push(...steps.map((step, index) => ({id:"PLAN" + (index + 1),
        text: JSON.stringify({version, step, obligation:"将该步骤约定的验收观察与候选提交的实际输出配对。缺少对应观察时，将该步骤记为未获证实。"})})));
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
      const target = roleSelection(ctx, active.root, state.routes!, phase === "fact-review" ? "factReview" : phase);
      review = await runIndependentReview(ctx, {root: active.root, base: state.base, revision, role: phase,
        taskbook: task.markdown, facts, objectives, evidence, methods}, controller.signal, target.model, pi, target.thinkingLevel);
    } catch (error) {
      if (controller.signal.aborted || run !== active) return;
      throw error;
    } finally {
      if (reviewing === controller) reviewing = undefined;
    }
    if (controller.signal.aborted || run !== active || active.state !== state) return;
    workspace(active.root, task, state.base, state.branch);
    requireApprovedFacts(active, readProjectMemory(active.root));
    if (!factReview && cleanRevision(active) !== revision) throw new Error("独立审核期间候审工作区发生变化。");
    let approvedProjectHead = state.approvedProjectHead;
    const legacyFactStore = factReview && state.reviewPolicy !== 2 && readFactFile(active.root, projectFactsPath) !== undefined;
    if (review.verdict === "pass" && legacyFactStore) {
      approvedProjectHead = applyApprovedMemory(active.root, projectSnapshot, task, state.base, changes,
        proposals, review, classifyFactChecks).head;
    } else if (readProjectMemory(active.root).head !== projectSnapshot.head) {
      throw new Error("审核期间项目记忆已更新；请重交同一任务书复核。");
    }
    const conflicts = review.conflicts.map(conflict => ({...conflict,
      projectVersion: projectSnapshot.records[conflict.factId]?.version,
      projectHead: conflict.factId.startsWith("project:") ? projectSnapshot.head : undefined}));
    conflicts.forEach(item => validateConflict(facts, item));
    const measured = candidateReports.some(report => report.phase === "performance");
    const next = nextPhase(task.type, phase, review.verdict, measured, state.reviewPolicy === 2 || state.taskFacts !== undefined);
    const reviewEvidence = factReview ? proposals.map(p => [p.claim, p.observed, p.source.kind === "git" ? p.origin : [p.toolInput, p.observedHead, p.toolError]]) :
      candidateReports.map(r => [r.phase, r.pointers, r.observations.map(o => [o.toolName, o.input, o.observed, o.isError])]);
    const reviewInput = createHash("sha256").update(JSON.stringify([phase, revision, projectSnapshot.head, state.plan?.version, changes, magpieCandidates, reviewEvidence])).digest("hex");
    const repeatedRework = review.verdict === "rework" && current.some(r => r.outcome === "rework" && r.reviewInput === reviewInput);
    const report: Report = { phase, outcome: review.verdict, review, reviewInput,
      projectHead: factReview && !legacyFactStore && review.verdict === "pass" ? undefined : projectSnapshot.head, projectStore: "fact-v1",
      summary: review.summary, evidence: review.items.map(item => item.id + " · " + item.reason),
      candidateId: state.candidateId, conflicts, factChecks: factReview && review.verdict === "pass" ? proposals : undefined };
    const exit = repeatedRework ? "blocked" : next === "ready" || next === "blocked" ? next : undefined;
    checkpoint(active, { ...state,
      revision: review.verdict === "rework" ? undefined : state.revision,
      candidateId: review.verdict === "rework" ? undefined : state.candidateId,
      reports: [...state.reports, report], pendingConflicts: conflicts, approvedProjectHead, exit,
      stopReason: repeatedRework ? "同一提交及证据再次被独立审核退回。" + review.summary :
        (next === "blocked" && review.verdict === "measure" ? "同一候审已经测量，审核仍缺所需证据。" + review.summary : undefined),
      phase: repeatedRework || next === "blocked" || next === "ready" ? "exit" : next });
    if (repeatedRework) ctx.ui.notify("同一提交及证据再次被独立审核退回，已暂停自动返工。", "warning");
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
    coordinating?.controller.abort();
    if (coordinating) await coordinating.settled.catch(() => {});
    coordinating = undefined;
    run = undefined;
    relocated = false;
    attempt = undefined;
    phaseInput = undefined;
    workerSnapshot = undefined;
    intakeSnapshot = undefined;
    started = false;
    reported = false;
    toggleReportTool(false);
    ctx.ui.setStatus("pi-taskbook", undefined);
    const previous = initialModel;
    const thinking = initialThinking;
    initialModel = undefined;
    initialThinking = undefined;
    if (previous && (!ctx.model || modelKey(ctx.model) !== modelKey(previous))) await pi.setModel(previous);
    if (thinking !== undefined) pi.setThinkingLevel(thinking);
  }

  pi.on("session_shutdown", async () => {
    coordinating?.controller.abort();
    await coordinating?.settled.catch(() => {});
  });

  async function exitInvocation(ctx: ExtensionContext, reason: string, recoverable?: Run) {
    const message = recoverable
      ? `退出（可恢复） · ${reason}\n检查点 ${recoverable.path}\n再次提交同一任务书可从检查点恢复。`
      : "退出（阻塞） · " + reason;
    await release(ctx);
    ctx.ui.notify(message, "warning");
  }

  async function syncCompleted(ctx: ExtensionContext, active: Run, reports: Report[], projectHead: string | null | undefined) {
    const { state, task } = active;
    const revision = state.revision;
    const deliveredProjectHead = state.approvedProjectHead;
    if (!revision || !state.candidateId || projectHead === undefined || deliveredProjectHead === undefined ||
        (!state.team?.registered && deliveredProjectHead !== projectHead) ||
        !(state.taskFacts ? ["review"] : ["correctness", "quality"]).every(phase => {
          const report = reports.findLast(item => item.phase === phase);
          return report?.outcome === "pass" && report.projectHead === projectHead && (report.review?.revision === revision ||
            (phase === "review" && state.team?.review?.kind === "approved" && state.team.review.checkpoint.candidate.revision === revision));
        })) {
      throw new Error("完成检查点缺少同一提交和 .fact 版本的交付审核。");
    }
    workspace(active.root, task, state.base, state.branch);
    const head = cleanRevision(active);
    if (!matchesDeliveryHead(active, head) || readProjectMemory(active.root).head !== deliveredProjectHead) {
      throw new Error("同步前候审提交或 .fact 版本已变化。");
    }
    if (state.sync?.projectHead === deliveredProjectHead && state.sync.revision === revision &&
        state.sync.result.status === "complete") return;
    syncing = true;
    try {
      const transport = syncCaller?.path === active.path && syncCaller.revision === revision ? syncCaller.transport : undefined;
      const result = await syncMagpieMemory(active.root, { repository: task.repository.toLowerCase(), digest: task.digest,
        projectHead: deliveredProjectHead, revision: head }, transport).catch((): MagpieSyncResult => ({ status: "pending", items: [],
          mirror: { status: "pending", updated: 0, reason: "同步未返回完整结果，重交同一任务书以读回并重试。" } }));
      const previous = state.sync?.projectHead === deliveredProjectHead && state.sync.revision === revision ? state.sync : undefined;
      const confirmed = new Map(previous?.confirmed?.map(item => [item.id, item]));
      for (const item of [...(previous?.result.items ?? []), ...result.items]) {
        if (item.status !== "pending") confirmed.set(item.id, item);
      }
      checkpoint(active, { ...state, sync: { revision, projectHead: deliveredProjectHead, result, confirmed: [...confirmed.values()] } });
    } catch {
      ctx.ui.notify("本地完成检查点已保存。Magpie 同步状态未能持久化，重交同一任务书以读回并重试。", "warning");
    } finally {
      syncing = false;
    }
  }

  function queuePublication(ctx: ExtensionContext, active: Run, suggested?: PullRequestAction) {
    const catalogue = githubHandoffTools(pi);
    if (!catalogue.has("list_pull_requests") || !catalogue.has("pull_request_read")) {
      ctx.ui.notify("本地交付已保存。PR 交付等待 Magpie GitHub MCP 的 list_pull_requests 和 pull_request_read。", "warning");
      return;
    }
    if (!ctx.model) {
      ctx.ui.notify("请选择可用的 Pi 会话模型以继续 PR 交付。", "warning");
      return;
    }
    const token = randomUUID();
    publishing = {token, run: active, suggested, previousTools: pi.getActiveTools(), active: false,
      nestedTools: new Set([...catalogue.values()].map(tool => tool.name))};
    pi.setActiveTools([publishTool]);
    pi.sendMessage({customType: publishKickoff, details: token, display: false,
      content: "Call taskbook_publish_pr once with attempt " + token + ". The plugin handles approval. Determine which revision and action succeeded from the receipt returned by this call, then end the turn."},
      {triggerTurn: true});
  }

  async function handoffToGitHub(ctx: ExtensionToolContext, active: Run, suggested?: PullRequestAction, signal?: AbortSignal) {
    try {
      let plan = active.state.publication;
      if (!plan) {
        if (!ctx.hasUI) throw new Error("请在支持审批对话的 Pi 会话发布 PR。");
        const options = pullRequestActions.map(action => publicationLabels[action]);
        const selected = suggested ?? pullRequestActions[options.indexOf(await ctx.ui.select("选择 Taskbook PR 操作", options) ?? "")];
        if (!selected) return;
        const receipt = active.state.publications?.find(item => item.action === selected && item.revision === active.state.deliveryRevision);
        if (receipt) {
          ctx.ui.notify("此交付的 PR 操作已完成 · " + receipt.pullRequest, "info");
          return;
        }
        const client = githubHandoff(pi, ctx, active.task.repository.toLowerCase(),
          {action: selected, comments: publicationHasComments(active, selected), signal});
        const proposal = await preparePublication(active, selected, client);
        const {title, text} = publicationPreview(proposal);
        if (!await ctx.ui.confirm(title, text)) return;
        signal?.throwIfAborted();
        checkpoint(active, {...active.state, publication: proposal});
        plan = proposal;
      }
      signal?.throwIfAborted();
      const client = githubHandoff(pi, ctx, active.task.repository.toLowerCase(),
        {action: plan.action, comments: plan.comments.length > 0, signal});
      const receipt = await publishDelivery(active, plan, client);
      checkpoint(active, {...active.state, publication: undefined, publications: [...(active.state.publications ?? []), receipt]});
      ctx.ui.notify("PR 已登记 · " + [receipt.pullRequest, ...receipt.comments].join("\n"), "info");
    } catch (error) {
      if (error instanceof PublicationChanged && active.state.publication) {
        checkpoint(active, {...active.state, publication: undefined});
      }
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify("本地交付已保存。PR 交付等待处理 · " + reason + "\n可重交原任务书重试 · /taskbook " + JSON.stringify(active.task.sourcePath), "warning");
    }
  }

  pi.registerTool({
    name: publishTool, label: "发布经批准的 PR 交付", description: "Continue the current Taskbook publication request.",
    defaultActive: false, executionMode: "sequential",
    parameters: Type.Object({attempt: Type.String()}, {additionalProperties: false}),
    async execute(toolCallId, {attempt: token}, signal, _onUpdate, ctx) {
      const pending = publishing;
      if (!pending?.active || pending.caller || token !== pending.token) throw new Error("当前没有匹配的 PR 交付请求。");
      pending.caller = toolCallId;
      await handoffToGitHub(ctx, pending.run, pending.suggested, signal);
      return {content: [{type: "text", text: "交付结果已在 Pi 中报告。"}], details: {}, terminate: true};
    },
  });

  async function announce(ctx: ExtensionContext, active: Run, reopened = false) {
    const labels = { ready: "可交接", blocked: "有阻塞", cancelled: "已取消" };
    const state = active.state;
    const lines = [labels[state.exit!] + " · " + active.task.id];
    if (state.exit === "blocked") lines.push("阻塞原因 · " + (state.stopReason ?? state.reports.at(-1)?.summary ?? "见审计记录。"));
    if (state.exit === "ready") {
      const candidateReports = state.reports.filter(report => report.candidateId === state.candidateId);
      const evidenceHead = candidateReports.findLast(report => report.phase === (state.taskFacts ? "review" : "quality"))?.projectHead;
      await syncCompleted(ctx, active, candidateReports, evidenceHead);
      const head = cleanRevision(active);
      if (!matchesDeliveryHead(active, head) ||
          readProjectMemory(active.root).head !== state.approvedProjectHead) {
        return exitInvocation(ctx, "同步期间候审提交或 .fact 版本发生变化。", active);
      }
      if (active.state.sync) {
        lines.push("Magpie 同步 · " + JSON.stringify(active.state.sync.result));
        const prior = active.state.sync.confirmed?.filter(item =>
          !active.state.sync?.result.items.some(current => current.id === item.id && current.status !== "pending"));
        if (prior?.length) lines.push("Magpie 此前确认的版本 · " + JSON.stringify(prior));
      }
      if (evidenceHead) lines.push("已审核的项目记忆版本 " + evidenceHead);
      const current = candidateReports.filter(report => report === candidateReports.findLast(other => other.phase === report.phase));
      for (const report of current) {
        if (report.outcome !== "pass") continue;
        const reviewer = report.review ? " · 审核会话 " + report.review.sessionId : "";
        lines.push(titles[report.phase] + " · " + report.summary + reviewer);
      }
      if (state.team?.handoff) lines.push(state.team.handoff);
    }
    if (state.taskFacts && state.plan) {
      const head = removeDesignArchive(active.root, active.task);
      if (state.exit === "ready" && active.state.deliveryRevision !== head) checkpoint(active, {...active.state, deliveryRevision: head});
    }
    let publishAction: PullRequestAction | undefined;
    if (state.exit === "ready") {
      const team = active.state.team;
      publishAction = active.state.publication?.action;
      if (!publishAction && team?.pullRequest && (!team.publicationOffered || reopened) &&
          !state.publications?.some(receipt => receipt.action === team.pullRequest && receipt.revision === state.deliveryRevision)) {
        checkpoint(active, {...active.state, team: {...team, publicationOffered: true}});
        publishAction = team.pullRequest;
      }
      for (const receipt of active.state.publications ?? []) lines.push("PR · " + receipt.pullRequest, ...receipt.comments);
    }
    if (state.revision) lines.splice(1, 0, state.exit === "ready" ? "交付提交 " + (active.state.deliveryRevision ?? state.revision) : "候审提交 " + state.revision);
    const decisions = new Map((state.decisions ?? []).map(decision => [decision.factId, decision]));
    for (const decision of decisions.values()) {
      lines.push(`用户事实裁决 ${decision.factId} · ${decision.action} · ${decision.text}`);
    }
    lines.push("完整审计 " + active.path);
    const handoff = lines.join("\n");
    ctx.ui.notify(handoff, active.state.exit === "blocked" ? "warning" : "info");
    await release(ctx);
    pi.sendMessage({ customType: "pi-taskbook-exit", content: handoff, display: true }, { triggerTurn: false });
    if (publishAction) queuePublication(ctx, active, publishAction);
  }

  const setup = registerSetupCommand(pi, () => Boolean(run || launching || publishing || syncing));

  function entryBusy(ctx: ExtensionContext) {
    return !ctx.isIdle() || attempt || launching || publishing || setup.isChecking() || reviewing || coordinating || syncing;
  }

  async function launchTaskbook(ctx: ExtensionContext, task: Taskbook) {
    selectedPlaybook(task.markdown);
    loadUpstreamInputs(pinUpstreamInputs(), stages[0], task.type);
    const prepared = prepareTaskLaunch(ctx.cwd, task);
    try {
      const reply = await launchT3Thread({
        title: task.id, branch: prepared.branch, base: prepared.base, message: prepared.message,
        clientRequestId: "pi-taskbook-" + task.digest,
      });
      ctx.ui.notify(`T3 已接收工作区请求 · ${reply.link ?? reply.threadId}`, "info");
    } catch (error) {
      await exitInvocation(ctx, String(error) + "\n如启动回执丢失，可重交同一任务书沿用请求标识。");
    }
  }

  function savedT3Continuation(ctx: ExtensionContext, digest: string) {
    for (const entry of ctx.sessionManager.getBranch().slice().reverse()) {
      if (entry.type !== "custom" || entry.customType !== t3Continuation || typeof entry.data !== "string" ||
          !entry.data.startsWith(taskbookPrefix)) continue;
      const prepared = readEntryArgument(entry.data.slice(taskbookPrefix.length)).prepared;
      if (prepared?.digest === digest && prepared.branch) return {base: prepared.base, branch: prepared.branch, message: entry.data, prepared};
    }
  }

  async function enterTaskbook(args: string, ctx: ExtensionContext) {
    if (entryBusy(ctx)) return ctx.ui.notify("入口请求已退出：当前会话正在处理任务。", "warning");
    if (!args.trim()) return ctx.ui.notify("用法 /taskbook <任务书路径或 Markdown 正文>", "warning");
    const previous = run;
    launching = true;
    try {
      const input = readEntryArgument(args.trim());
      const binding = await readT3Workspace(ctx.cwd);
      const needsT3Worktree = !binding && hasT3Context();
      if (needsT3Worktree && (input.prepared || run)) {
        throw new Error("当前 T3 线程需要已绑定的 linked worktree。");
      }
      const cwd = binding?.root ?? ctx.cwd;
      const task = input.prepared ? readTaskbook(cwd, '"' + input.path + '"') : readTaskbookInput(cwd, input.path);
      if (needsT3Worktree) return await launchTaskbook(ctx, task);
      if (run) {
        if (run.task.digest !== task.digest) return ctx.ui.notify("请先处理当前任务的待决事项。", "warning");
        return await startPhase(ctx);
      }
      selectedPlaybook(task.markdown);
      const prepared = input.prepared ?? savedT3Continuation(ctx, task.digest)?.prepared;
      const candidate = openRun({ctx, cwd, task, promptDigest: localPromptDigest, prepared});
      setup.close(ctx);
      if (candidate.state.phase === "exit") return await announce(ctx, candidate, true);
      initialModel ??= ctx.model;
      initialThinking ??= pi.getThinkingLevel();
      run = candidate;
      relocated = candidate.root !== git(ctx.cwd, "rev-parse", "--show-toplevel");
      toggleReportTool(true);
      await startPhase(ctx);
    } catch (error) {
      if (previous) ctx.ui.notify(String(error), "warning");
      else await exitInvocation(ctx, String(error), run);
    } finally { launching = false; }
  }

  pi.registerCommand("taskbook", {description: "按任务书启动工作流，未绑定时由 T3 创建 worktree", handler: enterTaskbook});

  pi.registerCommand("taskbook-new", {
    description: "按任务书指定的工作分支在新的 T3 worktree 开始任务",
    async handler(args, ctx) {
      if (run || entryBusy(ctx)) return ctx.ui.notify("入口请求已退出：当前会话正在处理任务。", "warning");
      if (!args.trim()) return exitInvocation(ctx, "用法 /taskbook-new <任务书路径或 Markdown 正文>");
      launching = true;
      try {
        await launchTaskbook(ctx, readTaskbookInput(ctx.cwd, args));
      } catch (error) {
        await exitInvocation(ctx, String(error));
      } finally {
        launching = false;
      }
    },
  });

  async function answerQuestion(answer: string, ctx: ExtensionContext) {
    if (!run?.state.pendingQuestion) return;
    const {question} = run.state.pendingQuestion;
    if (!resumeTeam(run, answer)) checkpoint(run, {...run.state, phase:run.state.phase === "fact-check" ? "fact-check" : "design", pendingQuestion:undefined,
      userAnswers:[...(run.state.userAnswers ?? []), {question, answer}]});
    try { await startPhase(ctx); }
    catch (error) { await exitInvocation(ctx, String(error), run); }
  }

  async function decideFact(args: string, ctx: ExtensionContext) {
    if (!run) return;
    try {
      const active = run;
      if (active.state.intakeConflicts?.length) {
        const version = active.state.intakeVersion;
        if (version && (version.topics !== readTopicFacts(active.root).head || version.project !== readProjectMemory(active.root).head)) {
          checkpoint(active, {...active.state, intakeConflicts: undefined, intakeDecisions: undefined, intakeVersion: undefined});
          ctx.ui.notify("事实版本已变化，本次同步将按新版本重新核对。", "warning");
          return startPhase(ctx);
        }
        const match = /^(\S+)\s+(create|use|update|delete)\s+([\s\S]+)$/u.exec(args.trim());
        const action = match?.[2];
        if (!match || (action !== "create" && action !== "use" && action !== "update" && action !== "delete") ||
            !active.state.intakeConflicts.some(item => item.id === match[1])) {
          throw new Error("请选择冲突条目并指定 create、use、update 或 delete。");
        }
        const decision: IntakeDecision = {id: match[1], action, detail: match[3].trim()};
        checkpoint(active, {...active.state, intakeDecisions: [...(active.state.intakeDecisions ?? []), decision],
          intakeConflicts: active.state.intakeConflicts.filter(item => item.id !== decision.id)});
        return startPhase(ctx);
      }
      const pending = active.state.pendingConflicts!;
      const conflict = pending.find(entry => entry.factId === args.trim().split(/\s+/)[0]);
      if (!conflict) throw new Error("请选择待裁决的事实标识。");
      const decision = parseFactDecision(args, conflict);
      const factStage = active.state.taskFacts ? "fact-management" : "fact-check";
      let projectChange: MemoryChange | undefined;
      if (decision.factId.startsWith("project:")) {
        const snapshot = readProjectMemory(active.root);
        if (conflict.projectHead !== snapshot.head) {
          checkpoint(active, { ...active.state, pendingConflicts: [], phase: factStage,
            approvedProjectHead: undefined, revision: undefined, candidateId: undefined, cycleStart: active.state.reports.length });
          ctx.ui.notify("冲突所用的 .fact 版本已变化。将重新核查，未登记本次裁决。", "warning");
          return startPhase(ctx);
        }
        const record = snapshot.records[decision.factId];
        if (decision.action === "replace" && (!record || record.deleted || (conflict.projectVersion !== undefined && conflict.projectVersion !== record.version))) {
          throw new Error("冲突引用的项目版本已变化。当前状态 " + JSON.stringify(record ?? null) +
            "。可以 keep 并说明保留当前版本的理由，然后按现行事实重新核查。");
        }
        if (decision.action === "replace") projectChange = { action: "update", kind: record.kind, key: record.key,
          scope: record.scope, text: decision.text, expected: record.version, authorization: "用户裁决 " + args.trim() };
      }
      const remaining = pending.filter(item => item.factId !== decision.factId);
      checkpoint(active, { ...active.state, pendingConflicts: remaining, phase: factStage,
        approvedProjectHead: undefined, revision: undefined, candidateId: undefined, cycleStart: active.state.reports.length,
        ...(active.state.team ? {team: undefined} : {}),
        designActions: undefined, designConsult: undefined,
        decisions: [...(active.state.decisions ?? []), { ...decision, conflict, projectChange, at: new Date().toISOString(),
          session: ctx.sessionManager.getSessionId() }] });
      await startPhase(ctx);
    } catch (error) { ctx.ui.notify(String(error), "error"); }
  }

  pi.on("input", async (event, ctx) => {
    const reply = event.text.trim();
    if (!run || event.source === "extension" || !reply || reply.startsWith("/")) return;
    if (!run.state.pendingQuestion && !run.state.pendingConflicts?.length && !run.state.intakeConflicts?.length) return;
    if (!attempt && !reviewing && !coordinating && !assisting && !launching) {
      launching = true;
      try {
        if (run.state.pendingQuestion) await answerQuestion(reply, ctx);
        else await decideFact(reply, ctx);
      } finally { launching = false; }
    } else {
      ctx.ui.notify("当前阶段尚未结束。请在出现裁决提示后回复。", "warning");
    }
    return {action: "handled"};
  });

  pi.on("context", event => {
    const kickoff = publishing?.active ? {type: publishKickoff, id: publishing.token} :
      started && attempt ? {type: kickoffType, id: attempt} : undefined;
    if (!kickoff) return;
    const index = event.messages.findLastIndex(message => message.role === "custom" &&
      message.customType === kickoff.type && message.details === kickoff.id);
    return {messages: index < 0 ? [] : event.messages.slice(index)};
  });

  pi.on("before_agent_start", (event, ctx) => {
    let root = run?.root;
    if (!root) {
      try { root = git(ctx.cwd, "rev-parse", "--show-toplevel"); } catch {}
    }
    const projectInstructions = root ? alwaysPrompt(root) : "";
    if (publishing && event.messageType === "custom" && event.message.customType === publishKickoff && event.message.details === publishing.token) {
      publishing.active = true;
      return {systemPrompt: [projectInstructions,
        "Run the single Taskbook publication tool with the supplied attempt token. Use the returned receipt to determine which revision and action succeeded, and end the turn."].filter(Boolean).join("\n\n")};
    }
    if (!run || !attempt || !phaseInput || run.state.phase === "exit" || event.messageType !== "custom" ||
        event.message.customType !== kickoffType || event.message.details !== attempt) {
      if (projectInstructions) return {systemPrompt: event.systemPrompt + "\n\n" + projectInstructions};
      return;
    }
    started = true;
    return {systemPrompt: [relocated ? "" : event.systemPrompt, projectInstructions, phaseInput].filter(Boolean).join("\n\n")};
  });

  pi.on("tool_call", event => {
    if (publishing) {
      if ((event.toolName === publishTool && publishing.active && !publishing.caller) ||
          (publishing.caller && event.parentToolCallId === publishing.caller && publishing.nestedTools.has(event.toolName))) return;
      return {block: true, reason: "PR 交付使用插件的批准和 Magpie GitHub MCP。"};
    }
    if (run && directDelegation(event.toolName)) {
      return {block: true, reason: "任务书的子代理由插件按项目配置派发。设计阶段可用 taskbook_consult。"};
    }
    if (run && relocated && event.toolName === "read") return {block: true, reason: "请通过 Taskbook 工具读取已验证的 T3 工作区。"};
    if ((run || syncing) && /^(?:mcp__.*__)?memory_(?:save|forget)(?:_[\da-f]+)?$/i.test(event.toolName) &&
        !(syncing && syncCaller && event.parentToolCallId === syncCaller.id)) {
      return { block: true, reason: "Magpie 写入由规格和质量审核通过后持久化的完成检查点触发。" };
    }
    if (reviewing || coordinating || run?.state.pendingQuestion || run?.state.pendingConflicts?.length || run?.state.intakeConflicts?.length) {
      return { block: true, reason: "当前由独立审核者或用户裁决。" };
    }
    if (started && reported) return { block: true, reason: "当前阶段已提交，等待 Pi 结束这一轮。" };
    if (started && run && ["fact-management", "fact-registration", "handoff"].includes(run.state.phase) && ![reportTool, queryFactsTool, methodTool, "read"].includes(event.toolName)) {
      return {block: true, reason: "Fact Management 通过阶段报告提交已核对的事实。"};
    }
    if (started && run && (run.state.phase === "fact-check" || run.state.phase === "implement" || run.state.phase === "performance") &&
        ![reportTool, methodTool, queryFactsTool, "edit", "write"].includes(event.toolName)) {
      try { observedCalls.set(event.toolCallId, cleanRevision(run)); } catch { return; }
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
    name: "taskbook_consult", label: "进入 Designer Consult", defaultActive: false,
    description: "记录待决定的设计问题和现有证据。结束本轮后，同一设计会话进入 Consult。",
    parameters: Type.Object({attempt: Type.String(), question: Type.String({minLength:1, maxLength:4000}),
      methods: Type.Optional(Type.Array(Type.String({minLength:1}), {uniqueItems:true, maxItems:4, description:"此问题需要的本阶段方法标识"}))}, {additionalProperties:false}),
    async execute(_id, {attempt: token, question, methods: selection = []}, signal, _onUpdate, ctx) {
      if (run?.state.taskFacts) {
        if (run.state.phase !== "design" || !started || reported || token !== attempt || assisting || run.state.designConsult) {
          throw new Error("Consult 需要有效的 Design 工作轮。");
        }
        for (const id of selection) readStageMethod(id, workerMethodStages("design"), "design");
        checkpoint(run, {...run.state, designConsult: {question, methods: selection}});
        reported = true;
        return {content: [{type: "text", text: "已记录问题。结束本轮，进入 Consult。"}], details: {}};
      }
      return designAction("consult", token, {question, methods:selection}, signal, async (active, stop) => {
        const {state, task} = active;
        const target = roleSelection(ctx, active.root, state.routes!, "consult");
        const {facts, goals, delivery} = readRunContext(active);
        const methods = selection.map(id => readStageMethod(id, workerMethodStages("design"), "design"));
        return consultDesign(ctx, {root: active.root, base: state.base, revision: git(active.root, "rev-parse", "HEAD"),
          taskbook: task.markdown, facts, objectives:[...goals, ...delivery], methods,
          evidence: {plan:state.plan, gap:state.planGap, decisions:state.decisions, userAnswers:state.userAnswers}},
          question, target.model, stop, pi, target.thinkingLevel);
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
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!run || !started || reported || !attempt || params.attempt !== attempt || run.state.phase === "exit") {
        throw new Error("执行标识已失效，或当前阶段已经提交。");
      }
      const phase = run.state.phase;
      const outcome = params.outcome;
      if (params.pullRequest && (phase !== "handoff" || outcome !== "pass")) throw new Error("PR 提议属于 Handoff 的通过报告。");
      if (params.intakeTargets && (phase !== "fact-management" || outcome !== "pass")) throw new Error("事实定位只用于 Fact Management 通过报告。");
      if (phase === "fact-registration" || phase === "handoff") {
        const active = run;
        const team = active.state.team;
        if (!team || !matchesDeliveryHead(active, cleanRevision(active))) throw new Error("交付工作区与签署结果不一致。");
        requireApprovedFacts(active, readProjectMemory(active.root));
        if (outcome !== "pass" && outcome !== "blocked") throw new Error("只接受通过结果或具体阻塞原因。");
        if (outcome === "pass" && phase === "fact-registration") {
          if (!params.factPlacements) throw new Error("请提交通过审核的事实分类。");
          validatePlacements(active, params.factPlacements);
        }
        const summary = params.summary.trim();
        if (!summary) throw new Error("请给出交付说明。");
        const report: Report = {phase, outcome, summary, evidence: params.evidence};
        if (outcome === "blocked") {
          checkpoint(active, {...active.state, pendingQuestion: {question: summary}, reports: [...active.state.reports, report]});
          reported = true;
          return {content: [{type:"text", text:"记录已保存，等待用户裁决。"}], details: {}};
        }
        const next = phase === "fact-registration" ? {...team, placements: params.factPlacements} :
          {...team, handoff: summary, pullRequest: params.pullRequest};
        checkpoint(active, {...active.state, team: next, reports: [...active.state.reports, report]});
        if (phase === "handoff" && active.state.revision) {
          syncCaller = {id: toolCallId, path: active.path, revision: active.state.revision, transport: magpieSessionTransport(pi, ctx)};
        }
        reported = true;
        return {content: [{type:"text", text:"记录已保存，请结束当前轮次。"}], details: {}};
      }
      if (params.factPlacements) throw new Error("只有 Fact Management 登记阶段可提交事实分类。");
      if (phase === "fact-management") {
        if (!intakeSnapshot || !workerSnapshot || readProjectMemory(run.root).head !== workerSnapshot.head ||
            readTopicFacts(run.root).head !== intakeSnapshot.head) throw new Error("事实同步输入已变化，请重新提交任务书。");
        if (outcome !== "pass" && outcome !== "fact-conflict" && outcome !== "blocked") throw new Error("无效的事实同步结果。");
        if (params.intakeConflicts && outcome !== "fact-conflict") throw new Error("同步冲突须使用 fact-conflict。");
        const items = taskMemory(run.task).facts.map(fact => {
          const previous = run?.state.taskFacts?.find(item => item.id === fact.id);
          const decision = run?.state.decisions?.findLast(item => item.factId === fact.id);
          return decision ? {...fact, text: !previous && decision.action === "replace" ? decision.text : fact.text,
            topicFact: previous?.topicFact, userDecision: decision} : fact;
        });
        if (outcome === "fact-conflict" && !params.intakeConflicts?.length) throw new Error("请提交待裁决的事实同步冲突。");
        if (params.intakeConflicts?.some(conflict => !items.some(item => item.id === conflict.id))) {
          throw new Error("事实同步冲突须引用任务书事实 ID。");
        }
        const memoryChanges = outcome === "pass" ? pendingMemoryChanges({markdown: run.task.markdown, digest: run.task.digest}, workerSnapshot,
          run.state.decisions) : [];
        const result = outcome === "pass" ? importTaskFacts({root: run.root, task: run.task, items, expectedHead: intakeSnapshot.head,
          project: workerSnapshot, base: run.state.base, sessionId: ctx.sessionManager.getSessionId(), memoryChanges,
          decisions: run.state.intakeDecisions, targets: params.intakeTargets}) : undefined;
        const conflicts = result?.kind === "conflict" ? result.conflicts : params.intakeConflicts;
        const complete = result?.kind === "complete" ? result : undefined;
        const report: Report = {phase, outcome: conflicts?.length ? "fact-conflict" : outcome, summary: params.summary,
          evidence: complete ? [...params.evidence, complete.revision] : params.evidence, projectHead: complete ? complete.projectHead : workerSnapshot.head,
          model: ctx.model && modelKey(ctx.model)};
        checkpoint(run, {...run.state, phase: complete ? "design" : outcome === "blocked" ? "exit" : phase,
          exit: outcome === "blocked" ? "blocked" : undefined, intakeConflicts: conflicts,
          intakeVersion: complete ? undefined : {topics: intakeSnapshot.head, project: workerSnapshot.head},
          ...(complete ? {topicFactsHead: complete.head, taskFacts: complete.facts, factView: complete.view, approvedProjectHead: complete.projectHead} : {}),
          reports: [...run.state.reports, report]});
        reported = true;
        return {content: [{type: "text", text: conflicts?.length ? "事实同步等待用户裁决。" : "事实同步结果已登记。"}], details: {}};
      }
      if (params.intakeConflicts) throw new Error("同步冲突仅用于 Fact Management。");
      if (phase === "design" && run.state.designConsult && outcome === "pass") {
        if (params.plan || !params.summary.trim() || !params.evidence.length) throw new Error("Consult 需要答案和证据。");
        const snapshot = readProjectMemory(run.root);
        requireApprovedFacts(run, snapshot);
        if (workerSnapshot?.head !== snapshot.head) throw new Error("Consult 使用的事实版本已变化。");
        const action = {kind: "consult" as const, version: run.state.plan?.version ?? 0, request: run.state.designConsult,
          result: {answer: params.summary, evidence: params.evidence}};
        checkpoint(run, {...run.state, designConsult: undefined, designActions: [...(run.state.designActions ?? []), action]});
        reported = true;
        return {content: [{type: "text", text: "Consult 答案已记录。结束本轮，回到 Design。"}], details: {}};
      }
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
        const {goals, delivery} = readRunContext(run);
        plan = acceptPlan(params.plan.steps, [...goals,...delivery].map(item => item.id), plan?.version);
      }
      const summary = params.summary.trim();
      const evidence = params.evidence.map(item => item.trim()).filter(Boolean);
      if (phase === "fact-review" || phase === "correctness" || phase === "quality" || phase === "review") throw new Error("审核须由插件派发。");
      if ((outcome === "fact-conflict") !== Boolean(params.conflicts?.length)) throw new Error("事实冲突须提交 conflicts。");
      const projectSnapshot = readProjectMemory(run.root);
      requireApprovedFacts(run, projectSnapshot);
      if (!workerSnapshot || projectSnapshot.head !== workerSnapshot.head) {
        throw new Error("本轮使用的 .fact 版本已变化，请重交同一任务书。");
      }
      const facts = readRunContext(run, projectSnapshot).facts;
      const conflicts = params.conflicts?.map(item => {
        validateConflict(facts, item);
        return {...item, projectVersion: projectSnapshot.records[item.factId]?.version,
          projectHead: item.factId.startsWith("project:") ? projectSnapshot.head : undefined};
      });
      if (phase !== "fact-check" && params.factChecks) throw new Error("factChecks 仅用于事实核查。");
      if (phase === "fact-check" && outcome === "pass" && !params.factChecks?.length) {
        throw new Error("事实核查通过需要至少一项可定位、有摘录的 factChecks。");
      }
      const factChecks = params.factChecks && checkFacts(run.root, run.state.base, params.factChecks, observations);
      if (!summary || (outcome === "pass" && !factChecks?.length && !evidence.length && !params.observedRuns?.length)) {
        throw new Error("请提供具体结论及对应证据。");
      }
      workspace(run.root, run.task, run.state.base, run.state.branch);
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
      const next = nextPhase(run.task.type, phase, outcome, false, run.state.reviewPolicy === 2 || run.state.taskFacts !== undefined);
      if (phase === "design" && params.plan && plan && run.state.taskFacts) {
        archiveDesign(run.root, run.task, run.state.base, run.state.branch, plan, run.state.taskFacts);
      }
      const report: Report = { phase, outcome, summary, evidence, factChecks, candidateId, model:ctx.model && modelKey(ctx.model),
        planVersion:plan?.version, plan: params.plan ? plan : undefined, gap:params.gap, observations: candidateObservations,
        projectHead: projectSnapshot.head, conflicts };
      const previousGap = run.state.reports.findLast(report => report.outcome === "plan-gap");
      const repeatedGap = outcome === "plan-gap" && previousGap?.gap?.stepId === params.gap!.stepId &&
        previousGap.gap.observation.trim() === params.gap!.observation.trim() &&
        previousGap.gap.question.trim() === params.gap!.question.trim();
      let sameRoute = false;
      if (outcome === "plan-gap") {
        const design = roleSelection(ctx, run.root, run.state.routes!, "design");
        const implement = roleSelection(ctx, run.root, run.state.routes!, "implement");
        sameRoute = modelKey(design.model) === modelKey(implement.model) && design.thinkingLevel === implement.thinkingLevel;
      }
      const question = outcome === "needs-user" ? summary : repeatedGap ?
        "修订方案后，同一步骤和观察再次受阻。请决定下一步：" + params.gap!.question : outcome === "plan-gap" && sameRoute ?
        "执行者退回方案，当前配置未指定不同的设计模型或推理档位。请给出决定或处理意见：" + params.gap!.question : undefined;
      checkpoint(run, { ...run.state, revision, candidateId, plan, pendingQuestion:question ? {question} : undefined,
        planGap: outcome === "plan-gap" ? {...params.gap!, planVersion: plan?.version, revision: git(run.root,"rev-parse","HEAD"),
          evidence, summary} : params.plan ? undefined : run.state.planGap, pendingConflicts: conflicts,
        phase: next === "ready" || next === "blocked" ? "exit" : next,
        exit: next === "ready" || next === "blocked" ? next : undefined, reports: [...run.state.reports, report] });
      if (phase === "implement" && outcome === "pass" && revision) {
        syncCaller = { id: toolCallId, path: run.path, revision, transport: magpieSessionTransport(pi, ctx) };
      }
      reported = true;
      return { content: [{ type: "text", text: "阶段结果已登记。结束当前轮次。" }], details: { phase } };
    },
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (publishing?.active) {
      const completed = publishing;
      publishing = undefined;
      pi.setActiveTools(completed.previousTools);
      if (!completed.caller) ctx.ui.notify("PR 交付未运行。重交原任务书可重试。", "warning");
      return;
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

import { buildPhaseInput, localPromptDigest, magpieGuide, memoryGuide, readRunContext } from "./src/workflow/phase-input.ts";
import { registerSetupCommand } from "./src/setup/command.ts";
import { checkpoint, cleanRevision, openRun, type Report, type Run, type RunObservation } from "./src/workflow/checkpoint.ts";
import { magpieSessionTransport, readSourceProjectFacts, recallMagpieMemory, syncMagpieMemory, type MagpieSyncResult } from "./src/integrations/magpie-memory.ts";
import { readStageMethod, workerMethodStages } from "./src/methods/catalog.ts";
import { methodTool, registerMethodTool } from "./src/methods/tool.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { git, readTaskbook, workspace } from "./src/taskbook/document.ts";
import { nextPhase, stages, titles, type Phase } from "./src/workflow/transitions.ts";
import { prepareTaskLaunch, readEntryArgument } from "./src/taskbook/entry.ts";
import { launchT3Thread } from "./src/integrations/t3.ts";
import { loadUpstreamInputs, pinUpstreamInputs } from "./src/methods/upstream.ts";

import { validateConflict, parseFactDecision } from "./src/workflow/task-context.ts";
import { consultDesign, runIndependentReview, type ReviewResult } from "./src/review/reviewer.ts";
import { checkFacts, factChecksParameter, type Observation } from "./src/facts/fact-check.ts";
import { maxFactMatches, queryProjectFacts } from "./src/facts/query.ts";

import { applyApprovedMemory, historicalProjectFacts, memoryId, pendingMemoryChanges, readProjectMemory, taskbookMemoryChanges, type MemoryChange, type ProjectSnapshot } from "./src/facts/project-memory.ts";

import { acceptPlan, planParameter, runProbe } from "./src/workflow/design-worker.ts";
import { modelKey, roleSelection } from "./src/models/config.ts";

const reportTool = "taskbook_report";
const queryFactsTool = "taskbook_query_facts";
const designTools = ["taskbook_consult", "taskbook_probe"];
const directDelegation = (name: string) => /^(?:agent|subagents?|subagentworkflow|get_subagent_result|steer_subagent|workflow|delegate_task|create_threads|t3_thread_launch)(?:_[\da-f]+)?$/i.test(name.split("__").at(-1) ?? name);
const kickoffType = "pi-taskbook-stage";
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

function requireApprovedFacts(run: Run, snapshot: ProjectSnapshot) {
  if (run.state.approvedProjectHead !== undefined && snapshot.head !== run.state.approvedProjectHead) {
    throw new Error("当前 .fact 与本任务已独立审核的版本不同，请恢复已审核版本后重试。");
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
  let phaseInput: string | undefined;
  let workerSnapshot: ProjectSnapshot | undefined;
  const observations = new Map<string, Observation>();

  let reviewing: AbortController | undefined;
  let assisting: AbortController | undefined;
  let initialModel: ExtensionContext["model"];
  let initialThinking: ExtensionContext["thinkingLevel"] | undefined;
  const suspendedDelegation = new Set<string>();
  const observedCalls = new Map<string, string>();
  const candidateOutputs = new Map<string, Omit<RunObservation, "observed"> & { text: string[] }>();

  registerMethodTool(pi, () => run && started && !reported && run.state.phase !== "exit"
    ? {phase: run.state.phase, type: run.task.type} : undefined);

  pi.registerTool({
    name: queryFactsTool,
    label: "Search project facts",
    description: "Find relevant project memory and source pointers in .fact topic tables. An exact registered label searches across tables. Check the source before using a result as evidence.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 240, description: "An exact label such as worktree, or search terms." }),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Restrict a text query to one registered label." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxFactMatches, default: 5 })),
    }, { additionalProperties: false }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      let root = ctx.cwd;
      try { root = git(ctx.cwd, "rev-parse", "--show-toplevel"); } catch { /* Pi also supports plain directories. */ }
      const result = await queryProjectFacts(root, input);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  function toggleReportTool(enabled: boolean) {
    const tools = pi.getActiveTools().filter(name => name !== reportTool && name !== methodTool && !designTools.includes(name));
    if (!run) {
      tools.push(...[...suspendedDelegation].filter(name => !tools.includes(name)));
      suspendedDelegation.clear();
    }
    if (enabled && run?.state.phase === "design") tools.push(...designTools);
    if (enabled) tools.push(reportTool, methodTool);
    pi.setActiveTools(run ? tools.filter(name => {
      if (!directDelegation(name)) return true;
      suspendedDelegation.add(name);
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
    const {model: target, thinkingLevel} = roleSelection(ctx, run.root, run.state.routes!, phase === "fact-check" ? "factCheck" : phase);
    if ((!ctx.model || modelKey(ctx.model) !== modelKey(target)) && !await pi.setModel(target)) {
      throw new Error("角色模型不可用 " + modelKey(target));
    }
    pi.setThinkingLevel(thinkingLevel);
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
    workspace(ctx.cwd, task, state.base, state.branch);
    if (!factReview && cleanRevision(active) !== revision) throw new Error("独立审核期间候审工作区发生变化。");
    let approvedProjectHead = state.approvedProjectHead;
    if (review.verdict === "pass" && factReview) {
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
    const next = nextPhase(task.type, phase, review.verdict, measured);
    const reviewEvidence = factReview ? proposals.map(p => [p.claim, p.observed, p.source.kind === "git" ? p.origin : [p.toolInput, p.observedHead, p.toolError]]) :
      candidateReports.map(r => [r.phase, r.pointers, r.observations.map(o => [o.toolName, o.input, o.observed, o.isError])]);
    const reviewInput = createHash("sha256").update(JSON.stringify([phase, revision, projectSnapshot.head, state.plan?.version, changes, magpieCandidates, reviewEvidence])).digest("hex");
    const repeatedRework = review.verdict === "rework" && current.some(r => r.outcome === "rework" && r.reviewInput === reviewInput);
    const report: Report = { phase, outcome: review.verdict, review, reviewInput, projectHead: projectSnapshot.head, projectStore: "fact-v1",
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
    run = undefined;
    attempt = undefined;
    phaseInput = undefined;
    workerSnapshot = undefined;
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
    if (!revision || !state.candidateId || projectHead === undefined || state.approvedProjectHead !== projectHead ||
        !["correctness", "quality"].every(phase => {
          const report = reports.findLast(item => item.phase === phase);
          return report?.outcome === "pass" && report.review?.revision === revision && report.projectHead === projectHead;
        })) {
      throw new Error("完成检查点缺少同一提交和 .fact 版本的规格与质量审核。");
    }
    workspace(ctx.cwd, task, state.base, state.branch);
    if (cleanRevision(active) !== revision || readProjectMemory(active.root).head !== projectHead) {
      throw new Error("同步前候审提交或 .fact 版本已变化。");
    }
    if (state.sync?.projectHead === projectHead && state.sync.revision === revision &&
        state.sync.result.status === "complete") return;
    syncing = true;
    try {
      const transport = syncCaller?.path === active.path && syncCaller.revision === revision ? syncCaller.transport : undefined;
      const result = await syncMagpieMemory(active.root, { repository: task.repository.toLowerCase(), digest: task.digest,
        projectHead, revision }, transport).catch((): MagpieSyncResult => ({ status: "pending", items: [],
          mirror: { status: "pending", updated: 0, reason: "同步未返回完整结果，重交同一任务书以读回并重试。" } }));
      const previous = state.sync?.projectHead === projectHead && state.sync.revision === revision ? state.sync : undefined;
      const confirmed = new Map(previous?.confirmed?.map(item => [item.id, item]));
      for (const item of [...(previous?.result.items ?? []), ...result.items]) {
        if (item.status !== "pending") confirmed.set(item.id, item);
      }
      checkpoint(active, { ...state, sync: { revision, projectHead, result, confirmed: [...confirmed.values()] } });
    } catch {
      ctx.ui.notify("本地完成检查点已保存。Magpie 同步状态未能持久化，重交同一任务书以读回并重试。", "warning");
    } finally {
      syncing = false;
    }
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
      await syncCompleted(ctx, active, candidateReports, evidenceHead);
      if (cleanRevision(active) !== state.revision || readProjectMemory(active.root).head !== evidenceHead) {
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

  const setup = registerSetupCommand(pi, () => Boolean(
    attempt || launching || reviewing || syncing || assisting || run?.state.pendingQuestion || run?.state.pendingConflicts?.length));

  pi.registerCommand("taskbook", {
    description: "在当前 linked worktree 接收任务书或恢复工作流",
    async handler(args, ctx) {
      if (!ctx.isIdle() || attempt || launching || setup.isChecking() || reviewing || syncing) return ctx.ui.notify("入口请求已退出：当前会话正在处理任务。", "warning");
      if (!args.trim()) return exitInvocation(ctx, "用法 /taskbook <任务书路径>");
      setup.closeModels();
      try {
        const input = readEntryArgument(args.trim());
        const task = readTaskbook(ctx.cwd, input.prepared ? '"' + input.path + '"' : input.path);
        const candidate = openRun({ ctx, task, promptDigest: localPromptDigest, prepared: input.prepared });
        if (candidate.state.phase === "exit") return announce(ctx, candidate);
        initialModel ??= ctx.model;
        initialThinking ??= pi.getThinkingLevel();
        run = candidate;
        toggleReportTool(true);
        await startPhase(ctx);
      } catch (error) {
        await exitInvocation(ctx, String(error), run);
      }
    },
  });

  pi.registerCommand("taskbook-new", {
    description: "请 T3 按任务书创建 worktree 和新 thread",
    async handler(args, ctx) {
      if (!ctx.isIdle() || attempt || launching || setup.isChecking() || reviewing || syncing) return ctx.ui.notify("入口请求已退出：当前会话正在处理任务。", "warning");
      if (!args.trim()) return exitInvocation(ctx, "用法 /taskbook-new <任务书路径>");
      setup.closeModels();
      launching = true;
      let requested = false;
      try {
        const task = readTaskbook(ctx.cwd, args);
        loadUpstreamInputs(pinUpstreamInputs(), stages[0], task.type);
        const prepared = prepareTaskLaunch(ctx.cwd, task);
        requested = true;
        const reply = await launchT3Thread({
          title: task.id, branch: prepared.branch, base: prepared.base, message: prepared.message,
          clientRequestId: "pi-taskbook-" + task.digest,
        });
        ctx.ui.notify(`已交给新 T3 thread ${reply.link ?? reply.threadId}`, "info");
      } catch (error) {
        const recovery = requested ? "\n如启动回执丢失，可重交同一任务书沿用请求标识。" : "";
        await exitInvocation(ctx, String(error) + recovery);
      } finally {
        launching = false;
      }
    },
  });

  pi.registerCommand("taskbook-exit", {
    description: "退出当前任务书工作流并保留审计记录",
    async handler(_args, ctx) {
      if (syncing) return ctx.ui.notify("本地完成检查点已保存，正在核对 Magpie 同步。", "info");
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
          const snapshot = readProjectMemory(active.root);
          if (conflict.projectHead !== snapshot.head) {
            checkpoint(active, { ...active.state, pendingConflicts: [], phase: "fact-check",
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
            scope: record.scope, text: decision.text, expected: record.version, authorization: "用户 /taskbook-decide " + args.trim() };
        }
        const remaining = pending.filter(item => item.factId !== decision.factId);
        checkpoint(active, { ...active.state, pendingConflicts: remaining, phase: "fact-check",
          approvedProjectHead: undefined, revision: undefined, candidateId: undefined, cycleStart: active.state.reports.length,
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
    if (!run || !attempt || !phaseInput || run.state.phase === "exit" || event.messageType !== "custom" ||
        event.message.customType !== kickoffType || event.message.details !== attempt) return;
    started = true;
    return { systemPrompt: event.systemPrompt + "\n\n" + phaseInput };
  });

  pi.on("tool_call", event => {
    if (run && directDelegation(event.toolName)) {
      return {block: true, reason: "任务书的子代理由插件按项目配置派发。设计阶段可用 taskbook_consult。"};
    }
    if ((run || syncing) && /^(?:mcp__.*__)?memory_(?:save|forget)(?:_[\da-f]+)?$/i.test(event.toolName) &&
        !(syncing && syncCaller && event.parentToolCallId === syncCaller.id)) {
      return { block: true, reason: "Magpie 写入由规格和质量审核通过后持久化的完成检查点触发。" };
    }
    if (reviewing || run?.state.pendingQuestion || run?.state.pendingConflicts?.length) return { block: true, reason: "当前由独立审核者或用户裁决。" };
    if (started && reported) return { block: true, reason: "当前阶段已提交，等待 Pi 结束这一轮。" };
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
    name: "taskbook_consult", label: "派发独立设计咨询", defaultActive: false,
    description: "把一个明确的技术分歧交给只读的新 Pi 会话，返回意见、固定提交和观察回执。",
    parameters: Type.Object({attempt: Type.String(), question: Type.String({minLength:1, maxLength:4000}),
      methods: Type.Optional(Type.Array(Type.String({minLength:1}), {uniqueItems:true, maxItems:4, description:"此问题需要的本阶段方法标识"}))}, {additionalProperties:false}),
    async execute(_id, {attempt: token, question, methods: selection = []}, signal, _onUpdate, ctx) {
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
      if (phase === "fact-review" || phase === "correctness" || phase === "quality") throw new Error("审核须由插件派发。");
      if ((outcome === "fact-conflict") !== Boolean(params.conflicts?.length)) throw new Error("事实冲突须提交 conflicts。");
      const projectSnapshot = readProjectMemory(run.root);
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

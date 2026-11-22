import { buildPhaseInput, readRunContext } from "./src/workflow/phase-input.ts";
import { registerSetupCommand } from "./src/setup/command.ts";
import { setRunState, cleanRevision, matchesDeliveryHead, startRun, type Report, type Run } from "./src/workflow/run.ts";
import { magpieSessionTransport, readSourceProjectFacts, recallMagpieMemory, syncMagpieMemory, type MagpieSyncResult } from "./src/integrations/magpie-memory.ts";
import { methodTool, registerMethodTool } from "./src/methods/tool.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { git, readTaskbook, workspace, type Taskbook } from "./src/taskbook/document.ts";
import { titles } from "./src/workflow/transitions.ts";
import { prepareTaskLaunch, readEntryArgument, readTaskbookInput } from "./src/taskbook/entry.ts";
import { registerHelpCommand } from "./src/taskbook/help.ts";
import { handoffT3Thread, hasT3Context, launchT3Thread, readT3Workspace } from "./src/integrations/t3.ts";

import { validateConflict, parseFactDecision, taskMemory } from "./src/workflow/task-context.ts";
import { checkFacts, factChecksParameter, type Observation } from "./src/facts/fact-check.ts";
import { maxFactMatches, queryProjectFacts } from "./src/facts/query.ts";
import { factAccessRestriction } from "./src/facts/access.ts";
import { intakeTargetsParameter, importTaskFacts, readFactTables, type IntakeDecision } from "./src/facts/taskbook-intake.ts";
import { alwaysPrompt } from "./src/facts/always.ts";

import { pendingMemoryChanges, readProjectMemory, taskbookMemoryChanges, type MemoryChange, type ProjectSnapshot } from "./src/facts/project-memory.ts";

import { removeDesignArchive } from "./src/workflow/design-archive.ts";
import { readFileSync } from "node:fs";
import { resumeTeam, runTeam, selectedPlaybook } from "./src/workflow/team.ts";
import { registerSubagentTool, subagentTool } from "./src/workflow/subagent.ts";
import { registerReviewedFacts, reviewedDrafts } from "./src/workflow/register-facts.ts";
import { githubHandoff, githubHandoffTools, pullRequestActions, type PullRequestAction } from "./src/integrations/github-handoff.ts";
import { preparePublication, publishDelivery } from "./src/workflow/publication.ts";

const reportTool = "taskbook_report";
const teamTool = "taskbook_run_team";
const queryFactsTool = "taskbook_query_facts";
const directDelegation = (name: string) => /^(?:agent|subagents?|subagentworkflow|get_subagent_result|steer_subagent|workflow|delegate_task|create_threads|t3_thread_launch|t3_worktree_handoff)(?:_[\da-f]+)?$/i.test(name.split("__").at(-1) ?? name);
const kickoffType = "pi-taskbook-stage";
const t3Continuation = "pi-taskbook-t3-continuation";
const taskbookPrefix = "/taskbook ";
const publishKickoff = "pi-taskbook-publication";
const publishTool = "taskbook_publish_pr";
const handoffPrompt = readFileSync(new URL("./prompts/handoff.md", import.meta.url), "utf8");
const reportParameters = Type.Object({
  attempt: Type.String({ description: "当前阶段提示词中给出的执行标识。" }),
  outcome: Type.Union([Type.Literal("pass"), Type.Literal("blocked"), Type.Literal("fact-conflict"), Type.Literal("needs-user")]),
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { maxItems: 20 }),
  factChecks: Type.Optional(factChecksParameter),
  pullRequest: Type.Optional(Type.Union(pullRequestActions.map(action => Type.Literal(action)))),
  intakeTargets: Type.Optional(intakeTargetsParameter),
  intakeConflicts: Type.Optional(Type.Array(Type.Object({id: Type.String(), reason: Type.String({minLength: 1, maxLength: 4000})},
    {additionalProperties: false}), {minItems: 1})),
  conflicts: Type.Optional(Type.Array(Type.Object({factId: Type.String(), observation: Type.String({minLength: 1, maxLength: 4000})}, {additionalProperties: false}), {minItems: 1, maxItems: 20})),
}, { additionalProperties: false });

function requireApprovedFacts(run: Run, snapshot: ProjectSnapshot) {
  if (run.state.approvedProjectHead !== undefined && snapshot.head !== run.state.approvedProjectHead) {
    throw new Error("当前 .fact 与本任务已独立审核的版本不同，请恢复已审核版本后重试。");
  }
  if (run.state.topicFactsHead !== undefined && readFactTables(run.root).head !== run.state.topicFactsHead) {
    throw new Error("标签事实与本任务已同步的版本不同，请恢复对应版本后重试。");
  }
}

export default function taskbookExtension(pi: ExtensionAPI) {
  let run: Run | undefined;
  let lastRun: Run | undefined;
  let attempt: string | undefined;
  let started = false;
  let syncCaller: { id: string; run: Run; revision: string; transport: ReturnType<typeof magpieSessionTransport> } | undefined;
  let syncing = false;
  let reported = false;
  let launching = false;
  let relocated = false;
  let publishing: {token: string; run: Run; action: PullRequestAction; previousTools: string[];
    active: boolean; caller?: string} | undefined;
  let phaseInput: string | undefined;
  let workerSnapshot: ProjectSnapshot | undefined;
  let intakeSnapshot: ReturnType<typeof readFactTables> | undefined;
  const observations = new Map<string, Observation>();

  let coordinating: {caller: string; controller: AbortController; settled: Promise<void>} | undefined;
  let teamProgress: string | undefined;
  const suspendedTools = new Set<string>();
  const observedCalls = new Map<string, string>();
  const runWorker = registerSubagentTool(pi);

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
    const tools = [...new Set([...pi.getActiveTools(), ...suspendedTools])]
      .filter(name => name !== reportTool && name !== teamTool && name !== methodTool);
    suspendedTools.clear();
    if (enabled) tools.push(reportTool, methodTool);
    const phase = run?.state.phase;
    pi.setActiveTools(phase ? tools.filter(name => {
      if (!directDelegation(name) && !(relocated && name === "read") && phaseAllowsTool(phase, name)) return true;
      suspendedTools.add(name);
      return false;
    }) : tools);
  }

  function phaseAllowsTool(phase: Run["state"]["phase"], name: string) {
    if (phase === "fact-management") return name === queryFactsTool || name === reportTool;
    if (phase === "fact-check") return !["codemode", "compress", "edit", "write"].includes(name);
    if (phase === "handoff") return name === queryFactsTool || name === reportTool;
    return true;
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
      "。\n请直接回复 <条目> use <已有事实>、<条目> update <已有事实>、<条目> delete <已有事实> 或 <条目> create <区分理由>", "warning");
  }

  function teamPhase(active: Run) {
    const phase = active.state.phase;
    return active.state.taskFacts !== undefined && (phase === "design" || phase === "implement" || phase === "performance" || phase === "review");
  }

  async function waitForTeam(active: Run, caller: string, ctx: ExtensionToolContext, signal: AbortSignal | undefined,
    onUpdate: Parameters<ToolDefinition["execute"]>[3]) {
    const controller = new AbortController();
    const teamSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const settled = Promise.resolve().then(() => runTeam(active, ctx, teamSignal, text => {
      teamProgress = text;
      ctx.ui.setStatus("pi-taskbook", text);
      onUpdate?.({content: [{type: "text", text}], details: {}});
    }, runWorker));
    coordinating = {caller, controller, settled};
    try {
      await settled;
      return "团队工作已完成本阶段。";
    } catch (error) {
      if (run === active && !controller.signal.aborted) await exitInvocation(ctx, String(error));
      return "团队工作已停止。\n" + String(error);
    } finally {
      if (coordinating?.controller === controller) {
        coordinating = undefined;
        teamProgress = undefined;
      }
    }
  }

  pi.registerTool({
    name: teamTool, label: "继续任务书团队工作", description: "Run the current Taskbook team phase.",
    defaultActive: false, executionMode: "sequential",
    parameters: Type.Object({attempt: Type.String()}, {additionalProperties: false}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!run || !started || reported || coordinating || attempt !== params.attempt || !teamPhase(run)) {
        throw new Error("当前没有匹配的团队任务。");
      }
      reported = true;
      const text = await waitForTeam(run, toolCallId, ctx, signal, onUpdate);
      return {content: [{type: "text", text}], details: {}, terminate: true};
    },
  });

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
    const phase = run.state.phase;
    if (teamPhase(run)) {
      toggleReportTool(false);
      pi.setActiveTools([...pi.getActiveTools(), teamTool]);
      attempt = randomUUID();
      reported = false;
      started = false;
      phaseInput = "Call " + teamTool + " once with attempt " + attempt + " to run the current phase.";
      ctx.ui.setStatus("pi-taskbook", titles[phase]);
      pi.sendMessage({customType: kickoffType, content: phaseInput, display: false, details: attempt}, {triggerTurn: true});
      return;
    }
    if (phase === "fact-registration") {
      const active = run;
      const team = active.state.team!;
      const drafts = reviewedDrafts(active);
      const {topicHead, projectHead, revision} = registerReviewedFacts(active);
      const report: Report = {phase, outcome: "pass", summary: "已登记任务事实和 " + drafts.length + " 条审核通过的草稿事实。",
        evidence: [revision]};
      setRunState(active, {...active.state, phase: "handoff", topicFactsHead: topicHead, approvedProjectHead: projectHead,
        team: {...team, registered: {revision}}, reports: [...active.state.reports, report]});
      return startPhase(ctx);
    }
    if (phase !== "fact-check" && phase !== "fact-management" && phase !== "handoff") {
      throw new Error("任务书阶段无可用的执行者：" + phase);
    }
    const tail = phase === "handoff";
    toggleReportTool(true);
    const token = randomUUID();
    const active = run;
    const priorState = active.state;
    const magpieCandidates = phase === "fact-check" ? await recallMagpieMemory(active.root, active.task.repository.split("/")[1],
      taskbookMemoryChanges(active.task.markdown, active.task.id).filter(c => c.scope.startsWith("cross-project:")).map(c => c.key)) : undefined;
    if (run !== active || active.state !== priorState) return;
    observedCalls.clear();
    observations.clear();
    const receipts = magpieCandidates?.status === "available" ? magpieCandidates.results.map((text, index) => {
      const receipt = randomUUID();
      observations.set(receipt, {toolName:"magpie:memory_search", toolCallId:receipt, isError:false,
        input:magpieCandidates.searches[index], head:active.state.base, text:[text]});
      return receipt;
    }) : [];
    workerSnapshot = readProjectMemory(active.root);
    requireApprovedFacts(active, workerSnapshot);
    intakeSnapshot = phase === "fact-management" ? readFactTables(active.root) : undefined;
    if (intakeSnapshot && !active.state.factBase) {
      setRunState(active, {...active.state, factBase: git(active.root, "rev-parse", "HEAD")});
    }
    if (intakeSnapshot && active.state.intakeVersion &&
        (active.state.intakeVersion.topics !== intakeSnapshot.head || active.state.intakeVersion.project !== workerSnapshot.head)) {
      setRunState(active, {...active.state, intakeDecisions: undefined, intakeVersion: undefined});
      ctx.ui.notify("事实版本已变化。同步将重新核对，原裁决用于其当时的版本。", "warning");
    }
    phaseInput = tail ? handoffPrompt + "\n\n" + JSON.stringify({attempt: token, task: active.task.id, userAnswers: active.state.userAnswers,
      goals: readRunContext(active).goals, delivery: readRunContext(active).delivery,
      candidate: active.state.revision,
      reports: ["implement", "review", "fact-registration"].map(name =>
        active.state.reports.findLast(report => report.phase === name && report.outcome === "pass")),
    }) : buildPhaseInput(active, phase, token, magpieCandidates ? {...magpieCandidates, receipts} : undefined);
    attempt = token;
    started = false;
    reported = false;
    ctx.ui.setStatus("pi-taskbook", titles[run.state.phase]);
    pi.sendMessage({ customType: kickoffType, content: "执行当前任务书阶段。", display: false, details: attempt },
      { triggerTurn: true });
  }

  async function release(ctx: ExtensionContext) {
    observedCalls.clear();
    observations.clear();
    coordinating?.controller.abort();
    if (coordinating) await coordinating.settled.catch(() => {});
    coordinating = undefined;
    teamProgress = undefined;
    run = undefined;
    syncCaller = undefined;
    relocated = false;
    attempt = undefined;
    phaseInput = undefined;
    workerSnapshot = undefined;
    intakeSnapshot = undefined;
    started = false;
    reported = false;
    toggleReportTool(false);
    ctx.ui.setStatus("pi-taskbook", undefined);
  }

  pi.on("session_shutdown", async () => {
    run = undefined;
    coordinating?.controller.abort();
    await coordinating?.settled.catch(() => {});
  });

  async function exitInvocation(ctx: ExtensionContext, reason: string) {
    if (run) setRunState(run, {...run.state, phase: "exit", exit: "blocked", stopReason: reason});
    await release(ctx);
    ctx.ui.notify("退出（阻塞） · " + reason, "warning");
  }

  async function syncCompleted(active: Run) {
    const {state, task} = active;
    const revision = state.deliveryRevision;
    if (!revision || !state.revision || state.team?.review?.kind !== "approved" ||
        state.team.review.progress.candidate.revision !== state.revision || state.approvedProjectHead === undefined) {
      throw new Error("同步需要已签署的交付提交和 .fact 版本。");
    }
    if (cleanRevision(active) !== revision) throw new Error("同步前交付提交已变化。");
    requireApprovedFacts(active, readProjectMemory(active.root));
    syncing = true;
    try {
      const transport = syncCaller?.run === active && syncCaller.revision === state.revision ? syncCaller.transport : undefined;
      const result = await syncMagpieMemory(active.root, {repository: task.repository.toLowerCase(), digest: task.digest,
        projectHead: state.approvedProjectHead, revision}, transport).catch((): MagpieSyncResult => ({status: "pending", items: [],
          mirror: {status: "pending", updated: 0, reason: "同步未返回完整结果。"}}));
      setRunState(active, {...state, sync: result});
    } finally {
      syncing = false;
    }
  }

  function queuePublication(ctx: ExtensionContext, active: Run, action: PullRequestAction) {
    const catalogue = githubHandoffTools(pi);
    if (!ctx.model) {
      const reason = "当前 Pi 会话没有可用模型。";
      setRunState(active, {...active.state, stopReason: reason});
      ctx.ui.notify("PR 发布失败 · " + reason, "warning");
      return;
    }
    const token = randomUUID();
    publishing = {token, run: active, action, previousTools: pi.getActiveTools(), active: false};
    pi.setActiveTools([publishTool, ...[...catalogue.values()].filter(tool => tool.exposure === "direct").map(tool => tool.name)]);
    pi.sendMessage({customType: publishKickoff, details: token, display: false,
      content: "Call taskbook_publish_pr once with attempt " + token + ". Determine which revision and action succeeded from the receipt returned by this call, then end the turn."},
      {triggerTurn: true});
  }

  async function handoffToGitHub(ctx: ExtensionToolContext, active: Run, selected: PullRequestAction, signal?: AbortSignal) {
    try {
      const directory = githubHandoff(pi, ctx, active.task.repository.toLowerCase(), {signal});
      const plan = await preparePublication(active, selected, directory);
      signal?.throwIfAborted();
      const client = githubHandoff(pi, ctx, active.task.repository.toLowerCase(),
        {action: plan.action, comments: plan.comments.length > 0, signal});
      const receipt = await publishDelivery(active, plan, client);
      setRunState(active, {...active.state, publication: receipt});
      const summary = "PR 已登记 · " + [receipt.pullRequest, ...receipt.comments].join("\n");
      ctx.ui.notify(summary, "info");
      return summary;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setRunState(active, {...active.state, stopReason: reason});
      const summary = "本地交付提交 " + active.state.deliveryRevision + "。PR 发布失败 · " + reason;
      ctx.ui.notify(summary, "warning");
      return summary;
    }
  }

  pi.registerTool({
    name: publishTool, label: "发布已签署的交付 PR", description: "Continue the current Taskbook publication request.",
    defaultActive: false, executionMode: "sequential",
    reachesTools: () => ["magpie"],
    parameters: Type.Object({attempt: Type.String()}, {additionalProperties: false}),
    async execute(toolCallId, {attempt: token}, signal, _onUpdate, ctx) {
      const pending = publishing;
      if (!pending?.active || pending.caller || token !== pending.token) throw new Error("当前没有匹配的 PR 交付请求。");
      pending.caller = toolCallId;
      const summary = await handoffToGitHub(ctx, pending.run, pending.action, signal);
      return {content: [{type: "text", text: summary}], details: {}, terminate: true};
    },
  });

  async function announce(ctx: ExtensionContext, active: Run) {
    const labels = {ready: "可交接", blocked: "有阻塞"};
    const state = active.state;
    const lines = [labels[state.exit!] + " · " + active.task.id];
    if (state.exit === "blocked") lines.push("阻塞原因 · " + (state.stopReason ?? state.reports.at(-1)?.summary ?? "见当前会话。"));
    if (state.exit === "ready") {
      await syncCompleted(active);
      const head = cleanRevision(active);
      if (!matchesDeliveryHead(active, head)) return exitInvocation(ctx, "同步期间交付提交发生变化。");
      requireApprovedFacts(active, readProjectMemory(active.root));
      if (active.state.sync) lines.push("Magpie 同步 · " + JSON.stringify(active.state.sync));
      for (const report of state.reports.filter(report => report.candidateId === state.candidateId && report.outcome === "pass")) {
        lines.push(titles[report.phase] + " · " + report.summary);
      }
      if (state.team?.handoff) lines.push(state.team.handoff);
    }
    const publishAction = state.exit === "ready" && state.team?.handoff ? state.team.pullRequest ?? "create" : undefined;
    if (publishAction) lines[0] = "本地已签署，正在发布 PR · " + active.task.id;
    if (state.revision) lines.splice(1, 0, state.exit === "ready" ? "交付提交 " + (active.state.deliveryRevision ?? state.revision) : "候审提交 " + state.revision);
    const decisions = new Map((state.decisions ?? []).map(decision => [decision.factId, decision]));
    for (const decision of decisions.values()) {
      lines.push(`用户事实裁决 ${decision.factId} · ${decision.action} · ${decision.text}`);
    }
    const handoff = lines.join("\n");
    ctx.ui.notify(handoff, active.state.exit === "blocked" ? "warning" : "info");
    await release(ctx);
    pi.sendMessage({ customType: "pi-taskbook-exit", content: handoff, display: true }, { triggerTurn: false });
    if (publishAction) queuePublication(ctx, active, publishAction);
  }

  const setup = registerSetupCommand(pi, () => Boolean(run || launching || publishing || syncing));

  function entryBusy(ctx: ExtensionContext) {
    return !ctx.isIdle() || attempt || launching || publishing || setup.isChecking() || coordinating || syncing;
  }

  registerHelpCommand(pi, ctx => {
    if (setup.isChecking()) return "当前阶段 · Setup 正在检查当前 Pi 会话和项目。";
    if (publishing) return "当前阶段 · Handoff 正通过 Magpie GitHub 发布 PR · " + publishing.run.task.id;
    if (launching && !run) return "正在准备任务入口和工作树。";
    if (setup.isActive(ctx)) return "当前阶段 · Setup 正在处理配置或迁移问题。";
    const current = run ?? (lastRun?.state.session === ctx.sessionManager.getSessionId() ? lastRun : undefined);
    if (!current) return "当前会话没有正在执行的任务书。";
    const {task, state} = current;
    if (state.phase === "exit") {
      const receipt = state.publication;
      if (receipt) return task.id + " · PR 已登记 · " + receipt.pullRequest;
      if (state.exit === "ready") return task.id + " · 本地已签署" + (state.stopReason ? "，PR 发布失败 · " + state.stopReason : "，正在发布 PR。");
      return task.id + " · 有阻塞" +
        (state.stopReason ? " · " + state.stopReason : "");
    }
    const stage = task.id + " · " + titles[state.phase];
    if (state.pendingQuestion) return stage + " · 等待你的决定\n" + state.pendingQuestion.question;
    if (state.intakeConflicts?.length) return stage + " · 等待事实同步裁决 · " + state.intakeConflicts.map(item => item.id).join("、");
    if (state.pendingConflicts?.length) return stage + " · 等待事实冲突裁决 · " + state.pendingConflicts.map(item => item.factId).join("、");
    return teamProgress ? stage + "\n" + teamProgress : stage;
  }, ctx => Boolean(entryBusy(ctx)));

  async function launchTaskbook(ctx: ExtensionContext, task: Taskbook) {
    selectedPlaybook(task.markdown);
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

  async function handoffTaskbook(ctx: ExtensionContext, task: Taskbook) {
    if (!ctx.sessionManager.getSessionFile()) throw new Error("请在有持久会话记录的 Pi thread 中启动任务。");
    selectedPlaybook(task.markdown);
    const saved = savedT3Continuation(ctx, task.digest);
    const launch = saved ?? prepareTaskLaunch(ctx.cwd, task);
    if (!saved) pi.appendEntry(t3Continuation, launch.message);
    const reply = await handoffT3Thread({root: git(ctx.cwd, "rev-parse", "--show-toplevel"), ...launch});
    if (reply.kind === "bound") return reply.root;

    setup.close(ctx);
    const {continuation, setupScript} = reply;
    const lines = ["T3 工作区 · " + reply.worktreePath];
    if (continuation.status === "scheduled") lines.push("任务将在原线程继续。");
    else {
      if (continuation.status === "failed") lines.push(continuation.detail);
      lines.push("可在原线程继续 · " + taskbookPrefix + JSON.stringify(task.sourcePath));
    }
    if (setupScript.status === "failed") lines.push("工作区初始化脚本失败 · " + setupScript.detail);
    ctx.ui.notify(lines.join("\n"), continuation.status !== "scheduled" || setupScript.status === "failed" ? "warning" : "info");
  }

  async function enterTaskbook(args: string, ctx: ExtensionContext) {
    if (entryBusy(ctx)) return ctx.ui.notify("入口请求已退出：当前会话正在处理任务。", "warning");
    if (!args.trim()) return ctx.ui.notify("用法 /taskbook <任务书路径或 Markdown 正文>", "warning");
    if (run) return ctx.ui.notify("请先在当前会话回复任务书待决事项。", "warning");
    launching = true;
    try {
      const input = readEntryArgument(args.trim());
      const binding = await readT3Workspace(ctx.cwd);
      const needsT3Worktree = !binding && hasT3Context();
      if (needsT3Worktree && input.prepared) {
        throw new Error("当前 T3 线程需要已绑定的 linked worktree。");
      }
      let cwd = binding?.root ?? ctx.cwd;
      const task = input.prepared ? readTaskbook(cwd, '"' + input.path + '"') : readTaskbookInput(cwd, input.path);
      if (needsT3Worktree) {
        const boundRoot = await handoffTaskbook(ctx, task);
        if (!boundRoot) return;
        cwd = boundRoot;
      }
      selectedPlaybook(task.markdown);
      const candidate = startRun(ctx, cwd, task, input.prepared);
      lastRun = candidate;
      setup.close(ctx);
      run = candidate;
      relocated = candidate.root !== git(ctx.cwd, "rev-parse", "--show-toplevel");
      toggleReportTool(true);
      await startPhase(ctx);
    } catch (error) {
      await exitInvocation(ctx, String(error));
    } finally { launching = false; }
  }

  pi.registerCommand("taskbook", {description: "按任务书启动工作流，未绑定时将当前 T3 线程迁到新 worktree", handler: enterTaskbook});

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
    if (!resumeTeam(run, answer)) setRunState(run, {...run.state, pendingQuestion:undefined,
      userAnswers:[...(run.state.userAnswers ?? []), {question, answer}]});
    try { await startPhase(ctx); }
    catch (error) { await exitInvocation(ctx, String(error)); }
  }

  async function decideFact(args: string, ctx: ExtensionContext) {
    if (!run) return;
    try {
      const active = run;
      if (active.state.intakeConflicts?.length) {
        const version = active.state.intakeVersion;
        if (version && (version.topics !== readFactTables(active.root).head || version.project !== readProjectMemory(active.root).head)) {
          setRunState(active, {...active.state, intakeConflicts: undefined, intakeDecisions: undefined, intakeVersion: undefined});
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
        setRunState(active, {...active.state, intakeDecisions: [...(active.state.intakeDecisions ?? []), decision],
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
          setRunState(active, { ...active.state, pendingConflicts: [], phase: factStage,
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
      setRunState(active, { ...active.state, pendingConflicts: remaining, phase: factStage,
        approvedProjectHead: undefined, revision: undefined, candidateId: undefined, cycleStart: active.state.reports.length,
        ...(active.state.team ? {team: undefined} : {}),
        decisions: [...(active.state.decisions ?? []), { ...decision, conflict, projectChange, at: new Date().toISOString(),
          session: ctx.sessionManager.getSessionId() }] });
      await startPhase(ctx);
    } catch (error) { ctx.ui.notify(String(error), "error"); }
  }

  pi.on("input", async (event, ctx) => {
    const reply = event.text.trim();
    if (!run || event.source === "extension" || !reply || reply.startsWith("/")) return;
    if (!run.state.pendingQuestion && !run.state.pendingConflicts?.length && !run.state.intakeConflicts?.length) return;
    if (!attempt && !coordinating && !launching) {
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
        "You are the Pi Taskbook delivery agent. Current phase: Handoff / PR publication. Review has signed the delivery; your remaining job is to obtain the Magpie GitHub receipt.",
        "Run the single Taskbook publication tool with the supplied attempt token. Use the returned receipt to determine which revision and action succeeded, and end the turn."].filter(Boolean).join("\n\n")};
    }
    if (!run || !attempt || !phaseInput || run.state.phase === "exit" || event.messageType !== "custom" ||
        event.message.customType !== kickoffType || event.message.details !== attempt) {
      if (projectInstructions) return {systemPrompt: event.systemPrompt + "\n\n" + projectInstructions};
      return;
    }
    started = true;
    const role = "You are the main agent for Pi Taskbook run " + run.task.id + ". Current phase: " + run.state.phase +
      ". Complete the phase assignment below. The plugin dispatches workers and advances the workflow after your report.";
    return {systemPrompt: [relocated ? "" : event.systemPrompt, role, projectInstructions, phaseInput].filter(Boolean).join("\n\n")};
  });

  pi.on("tool_call", (event, ctx) => {
    if (publishing) {
      if ((event.toolName === publishTool && publishing.active && !publishing.caller) ||
          (publishing.caller && event.parentToolCallId === publishing.caller &&
            [...githubHandoffTools(pi).values()].some(tool => tool.name === event.toolName))) return;
      return {block: true, reason: "PR 交付由插件通过 Magpie GitHub MCP 执行。"};
    }
    if (event.toolName === subagentTool && coordinating && event.parentToolCallId === coordinating.caller) return;
    if (run && directDelegation(event.toolName)) {
      return {block: true, reason: "任务书的子代理由插件按项目配置派发。"};
    }
    if (run && relocated && event.toolName === "read") return {block: true, reason: "请通过 Taskbook 工具读取已验证的 T3 工作区。"};
    if (run) {
      const reason = factAccessRestriction(event.toolName, event.input, ctx.cwd, run.root);
      if (reason) return {block: true, reason};
    }
    if ((run || syncing) && /^(?:mcp__.*__)?memory_(?:save|forget)(?:_[\da-f]+)?$/i.test(event.toolName) &&
        !(syncing && syncCaller && event.parentToolCallId === syncCaller.id)) {
      return { block: true, reason: "Magpie 写入在签署交付后由插件执行。" };
    }
    if (coordinating || run?.state.pendingQuestion || run?.state.pendingConflicts?.length || run?.state.intakeConflicts?.length) {
      return { block: true, reason: "当前由独立审核者或用户裁决。" };
    }
    if (started && reported) return { block: true, reason: "当前阶段已提交，等待 Pi 结束这一轮。" };
    if (started && run && teamPhase(run) && event.toolName !== teamTool) {
      return {block: true, reason: "请调用 " + teamTool + " 执行本阶段。"};
    }
    if (started && run && !phaseAllowsTool(run.state.phase, event.toolName)) {
      return {block: true, reason: "请使用当前阶段提示中的工具。"};
    }
    if (started && run?.state.phase === "fact-check" && ![reportTool, methodTool].includes(event.toolName)) {
      try { observedCalls.set(event.toolCallId, cleanRevision(run)); } catch { return; }
    }
  });

  pi.on("tool_result", event => {
    if (!started || reported || !run) return;
    const before = observedCalls.get(event.toolCallId);
    if (!before) return;
    observedCalls.delete(event.toolCallId);
    let after: string;
    try { after = cleanRevision(run); } catch { return; }
    if (before !== after) return;
    const text = event.content.flatMap(part => part.type === "text" && part.text.trim() ? [part.text] : []);
    if (!text.length) return;
    const receipt = randomUUID();
    observations.set(receipt, {toolName: event.toolName, toolCallId: event.toolCallId,
      input: event.input, head: before, isError: event.isError, text});
    return {content: [...event.content, {type: "text" as const, text: "事实核查回执 " + receipt}],
      structuredContent: event.structuredContent};
  });

  pi.registerTool({
    name: reportTool,
    label: "提交任务书阶段证据",
    description: "在本阶段结束时登记结论和证据，随后结束当前模型轮次。",
    defaultActive: false,
    parameters: reportParameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!run || !started || reported || !attempt || params.attempt !== attempt || run.state.phase === "exit") {
        throw new Error("执行标识已失效，或当前阶段已经提交。");
      }
      const phase = run.state.phase;
      const outcome = params.outcome;
      if (params.pullRequest && (phase !== "handoff" || outcome !== "pass")) throw new Error("PR 提议属于 Handoff 的通过报告。");
      if (params.intakeTargets && (phase !== "fact-management" || outcome !== "pass")) throw new Error("事实定位只用于 Fact Management 通过报告。");
      if (phase === "handoff") {
        const active = run;
        const team = active.state.team;
        const revision = active.state.revision;
        if (!revision || !team || !matchesDeliveryHead(active, cleanRevision(active))) throw new Error("交付工作区与签署结果不一致。");
        requireApprovedFacts(active, readProjectMemory(active.root));
        if (outcome !== "pass" && outcome !== "blocked") throw new Error("只接受通过结果或具体阻塞原因。");
        const summary = params.summary.trim();
        if (!summary) throw new Error("请给出交付说明。");
        const report: Report = {phase, outcome, summary, evidence: params.evidence};
        if (outcome === "blocked") {
          setRunState(active, {...active.state, pendingQuestion: {question: summary}, reports: [...active.state.reports, report]});
          reported = true;
          return {content: [{type:"text", text:"记录已保存，等待用户裁决。"}], details: {}, terminate: true};
        }
        const next = {...team, handoff: summary, pullRequest: params.pullRequest};
        syncCaller = {id: toolCallId, run: active, revision, transport: magpieSessionTransport(pi, ctx)};
        setRunState(active, {...active.state, team: next, reports: [...active.state.reports, report]});
        reported = true;
        return {content: [{type:"text", text:"交付说明已保存。"}], details: {}, terminate: true};
      }
      if (phase === "fact-management") {
        if (!intakeSnapshot || !workerSnapshot || readProjectMemory(run.root).head !== workerSnapshot.head ||
            readFactTables(run.root).head !== intakeSnapshot.head) throw new Error("事实同步输入已变化，请重新提交任务书。");
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
          evidence: complete ? [...params.evidence, complete.revision] : params.evidence};
        setRunState(run, {...run.state, phase: complete ? "design" : outcome === "blocked" ? "exit" : phase,
          exit: outcome === "blocked" ? "blocked" : undefined, intakeConflicts: conflicts,
          intakeVersion: complete ? undefined : {topics: intakeSnapshot.head, project: workerSnapshot.head},
          ...(complete ? {topicFactsHead: complete.head, taskFacts: complete.facts, factView: complete.view, approvedProjectHead: complete.projectHead} : {}),
          reports: [...run.state.reports, report]});
        reported = true;
        if (complete) {
          const text = await waitForTeam(run, toolCallId, ctx, signal, onUpdate);
          return {content: [{type: "text", text}], details: {}, terminate: true};
        }
        return {content: [{type: "text", text: conflicts?.length ? "事实同步等待用户裁决。" : "事实同步结果已登记。"}], details: {}};
      }
      if (phase !== "fact-check") throw new Error("当前阶段由插件派发。");
      if (outcome !== "pass" && outcome !== "blocked" && outcome !== "needs-user" && outcome !== "fact-conflict") {
        throw new Error("无效的事实核查结果。");
      }
      const summary = params.summary.trim();
      if (!summary || ((outcome === "fact-conflict") !== Boolean(params.conflicts?.length))) {
        throw new Error("请提交具体结论，事实冲突须附冲突条目。");
      }
      if (outcome === "pass" && !params.factChecks?.length) throw new Error("事实核查通过需要至少一项可定位、有摘录的 factChecks。");
      const project = readProjectMemory(run.root);
      requireApprovedFacts(run, project);
      if (!workerSnapshot || project.head !== workerSnapshot.head) throw new Error("本轮使用的 .fact 版本已变化。");
      workspace(run.root, run.task, run.state.base, run.state.branch);
      const facts = readRunContext(run, project).facts;
      const conflicts = params.conflicts?.map(item => {
        validateConflict(facts, item);
        return {...item, projectVersion: project.records[item.factId]?.version,
          projectHead: item.factId.startsWith("project:") ? project.head : undefined};
      });
      const factChecks = params.factChecks && checkFacts(run.root, run.state.base, params.factChecks, observations);
      const report: Report = {phase, outcome, summary, evidence: params.evidence, factChecks};
      setRunState(run, {...run.state, reports: [...run.state.reports, report],
        pendingConflicts: conflicts, pendingQuestion: outcome === "needs-user" ? {question: summary} : undefined,
        phase: outcome === "pass" ? "fact-management" : outcome === "blocked" ? "exit" : phase,
        exit: outcome === "blocked" ? "blocked" : undefined});
      reported = true;
      return {content: [{type: "text", text: "事实核查结果已登记。"}], details: {}, terminate: true};
    },
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (publishing?.active) {
      const completed = publishing;
      publishing = undefined;
      pi.setActiveTools(completed.previousTools);
      if (!completed.caller) {
        setRunState(completed.run, {...completed.run.state, stopReason: "PR 工具未执行。"});
        ctx.ui.notify("PR 工具未执行。", "warning");
      }
      return;
    }
    if (!run || !started) return;
    started = false;
    attempt = undefined;
    if (event.aborted || !reported) {
      return exitInvocation(ctx, event.aborted ? "当前轮次被中断。" : "本轮结束前没有通过校验的阶段报告。");
    }
    try {
      if (run.state.phase === "handoff" && run.state.team?.handoff) {
        if (!matchesDeliveryHead(run, cleanRevision(run))) throw new Error("交付工作区与签署结果不一致。");
        requireApprovedFacts(run, readProjectMemory(run.root));
        const deliveryRevision = removeDesignArchive(run.root, run.task);
        setRunState(run, {...run.state, phase: "exit", exit: "ready", deliveryRevision});
      }
      if (run.state.phase === "exit") return await announce(ctx, run);
      await startPhase(ctx);
    } catch (error) { await exitInvocation(ctx, String(error)); }
  });
}

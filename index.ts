import { buildIntakeInput, readRunContext } from "./src/workflow/phase-input.ts";
import { registerSetupCommand } from "./src/setup/command.ts";
import { setRunState, cleanRevision, matchesDeliveryHead, startRun, type Report, type Run } from "./src/workflow/run.ts";
import { magpieSessionTransport, syncMagpieMemory, type MagpieSyncResult } from "./src/integrations/magpie-memory.ts";
import { magpieRepositoryReader, magpieSessionTools } from "./src/integrations/mcp-catalog.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { git, readTaskbook, workspace, type Taskbook } from "./src/taskbook/document.ts";
import { titles } from "./src/workflow/transitions.ts";
import { prepareTaskLaunch, readEntryArgument, readTaskbookInput } from "./src/taskbook/entry.ts";
import { registerHelpCommand } from "./src/taskbook/help.ts";
import { handoffT3Thread, hasT3Context, launchT3Thread, readT3Workspace } from "./src/integrations/t3.ts";

import { parseFactDecision, taskMemory } from "./src/workflow/task-context.ts";
import { maxFactMatches, queryProjectFacts } from "./src/facts/query.ts";
import { factAccessRestriction, factSearchOnly, isFactPath } from "./src/facts/access.ts";
import { intakeTargetsParameter, importTaskFacts, readFactTables, type IntakeDecision } from "./src/facts/taskbook-intake.ts";
import { alwaysPrompt } from "./src/facts/always.ts";

import { pendingMemoryChanges, readProjectMemory, type MemoryChange, type ProjectSnapshot } from "./src/facts/project-memory.ts";

import { removeDesignArchive } from "./src/workflow/design-archive.ts";
import { readFileSync } from "node:fs";
import { resumeTeam, runTeam, selectedPlaybook } from "./src/workflow/team.ts";
import { registerSubagentTool, subagentTool } from "./src/workflow/subagent.ts";
import { registerReviewedFacts, reviewedDrafts } from "./src/workflow/register-facts.ts";
import { githubHandoff, githubHandoffTools, pullRequestActions } from "./src/integrations/github-handoff.ts";
import { preparePublication, publishDelivery } from "./src/workflow/publication.ts";

const reportTool = "taskbook_report";
const teamTool = "taskbook_run_team";
const queryFactsTool = "taskbook_query_facts";
const directDelegation = (name: string) => /^(?:agent|subagents?|subagentworkflow|get_subagent_result|steer_subagent|workflow|delegate_task|create_threads|t3_thread_launch|t3_worktree_handoff)(?:_[\da-f]+)?$/i.test(name.split("__").at(-1) ?? name);
const kickoffType = "pi-taskbook-stage";
const t3Continuation = "pi-taskbook-t3-continuation";
const taskbookPrefix = "/taskbook ";
const handoffPrompt = readFileSync(new URL("./prompts/handoff.md", import.meta.url), "utf8");
const designSourceParameters = Type.Object({
  owner: Type.String({pattern: "^[A-Za-z0-9-]+$", maxLength: 100}),
  repo: Type.String({pattern: "^[A-Za-z0-9_.-]+$", maxLength: 100}),
  commit: Type.String({pattern: "^[0-9a-fA-F]{40}$"}),
  path: Type.String({maxLength: 500}),
}, {additionalProperties: false});
const reportParameters = Type.Object({
  attempt: Type.String({ description: "当前阶段提示词中给出的执行标识。" }),
  outcome: Type.Union([Type.Literal("pass"), Type.Literal("blocked"), Type.Literal("fact-conflict")]),
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { maxItems: 20 }),
  pullRequest: Type.Optional(Type.Union(pullRequestActions.map(action => Type.Literal(action)))),
  intakeTargets: Type.Optional(intakeTargetsParameter),
  intakeConflicts: Type.Optional(Type.Array(Type.Object({id: Type.String(), reason: Type.String({minLength: 1, maxLength: 4000})},
    {additionalProperties: false}), {minItems: 1})),
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
  let deliveryCaller: string | undefined;
  let reported = false;
  let launching = false;
  let relocated = false;
  let phaseInput: string | undefined;
  let workerSnapshot: ProjectSnapshot | undefined;
  let intakeSnapshot: ReturnType<typeof readFactTables> | undefined;

  let coordinating: {caller: string; controller: AbortController; settled: Promise<void>; sourceReader?: string} | undefined;
  let teamProgress: string | undefined;
  const suspendedTools = new Set<string>();
  const runWorker = registerSubagentTool(pi);

  pi.registerTool({
    name: queryFactsTool,
    label: "Search project facts",
    description: "Find registered project facts by ID, exact text, keywords, or label. Results include their source pointers.",
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
      .filter(name => name !== reportTool && name !== teamTool);
    suspendedTools.clear();
    if (enabled) tools.push(reportTool);
    const phase = run?.state.phase;
    pi.setActiveTools(phase ? tools.filter(name => {
      if (!directDelegation(name) && !(relocated && name === "read") && phaseAllowsTool(phase, name)) return true;
      suspendedTools.add(name);
      return false;
    }) : tools);
  }

  function phaseAllowsTool(phase: Run["state"]["phase"], name: string) {
    return (phase !== "fact-management" && phase !== "handoff") || name === queryFactsTool || name === reportTool;
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
    const reader = magpieRepositoryReader(pi);
    const sourceReads = new Map<string, Promise<string>>();
    const sourceTool: ToolDefinition<typeof designSourceParameters> | undefined = reader && {
      name: "inspect_github", label: "Inspect pinned GitHub source",
      description: "Read a file or directory in a GitHub repository at the exact commit used by the task.",
      parameters: designSourceParameters,
      annotations: {readOnlyHint: true},
      async execute(_id, {owner, repo, commit, path}, workerSignal) {
        if (isFactPath(path)) throw new Error(factSearchOnly);
        workerSignal?.throwIfAborted();
        const key = JSON.stringify([owner.toLowerCase(), repo.toLowerCase(), commit.toLowerCase(), path]);
        let content = sourceReads.get(key);
        if (!content) {
          content = ctx.executeTool(reader.name, {owner, repo, path, [reader.revisionField]: commit}, {signal: teamSignal})
            .then(result => {
              if (result.isError || result.result.isError) throw new Error("Magpie GitHub could not read the pinned source.");
              return result.result.content.filter(part => part.type === "text").map(part => part.text).join("\n").slice(0, 16000);
            })
            .catch(error => {
              sourceReads.delete(key);
              throw error;
            });
          sourceReads.set(key, content);
        }
        const text = await content;
        workerSignal?.throwIfAborted();
        return {content: [{type: "text", text: `${owner}/${repo}@${commit}:${path}\n` + text}], details: {}};
      },
    };
    const settled = Promise.resolve().then(() => runTeam(active, ctx, teamSignal, text => {
      teamProgress = text;
      ctx.ui.setStatus("pi-taskbook", text);
      onUpdate?.({content: [{type: "text", text}], details: {}});
    }, runWorker, sourceTool));
    coordinating = {caller, controller, settled, sourceReader: reader?.name};
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
    reachesTools: () => run && teamPhase(run) ? ["magpie"] : [],
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
    if (phase !== "fact-management" && phase !== "handoff") {
      throw new Error("任务书阶段无可用的执行者：" + phase);
    }
    const tail = phase === "handoff";
    toggleReportTool(true);
    const token = randomUUID();
    const active = run;
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
    }) : buildIntakeInput(active, token);
    attempt = token;
    started = false;
    reported = false;
    ctx.ui.setStatus("pi-taskbook", titles[run.state.phase]);
    pi.sendMessage({ customType: kickoffType, content: "执行当前任务书阶段。", display: false, details: attempt },
      { triggerTurn: true });
  }

  async function release(ctx: ExtensionContext) {
    coordinating?.controller.abort();
    if (coordinating) await coordinating.settled.catch(() => {});
    coordinating = undefined;
    teamProgress = undefined;
    run = undefined;
    deliveryCaller = undefined;
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

  async function publishSignedDelivery(ctx: ExtensionToolContext, active: Run, signal?: AbortSignal) {
    const {state, task} = active;
    const revision = state.deliveryRevision;
    if (!revision || !state.revision || state.team?.review?.kind !== "approved" ||
        state.team.review.progress.candidate.revision !== state.revision || state.approvedProjectHead === undefined) {
      throw new Error("发布需要已签署的交付提交和 .fact 版本。");
    }
    if (cleanRevision(active) !== revision) throw new Error("发布前交付提交已变化。");
    requireApprovedFacts(active, readProjectMemory(active.root));
    const repository = task.repository.toLowerCase();
    const sync = await syncMagpieMemory(active.root, {repository, digest: task.digest, projectHead: state.approvedProjectHead, revision},
      magpieSessionTransport(pi, ctx, signal)).catch((): MagpieSyncResult => ({status: "pending", items: [],
      mirror: {status: "pending", updated: 0, reason: "同步未返回完整结果。"}}));
    setRunState(active, {...active.state, sync});
    signal?.throwIfAborted();
    const target = githubHandoff(pi, ctx, repository, {signal});
    const plan = await preparePublication(active, state.team.pullRequest ?? "create", target);
    signal?.throwIfAborted();
    const writer = githubHandoff(pi, ctx, repository, {action: plan.action, comments: plan.comments.length > 0, signal});
    return publishDelivery(active, plan, writer, signal);
  }

  async function announce(ctx: ExtensionContext, active: Run) {
    const labels = {ready: "可交接", blocked: "有阻塞"};
    const state = active.state;
    const lines = [labels[state.exit!] + " · " + active.task.id];
    if (state.exit === "blocked") lines.push("阻塞原因 · " + (state.stopReason ?? state.reports.at(-1)?.summary ?? "见当前会话。"));
    if (state.sync) lines.push("Magpie 同步 · " + JSON.stringify(state.sync));
    if (state.exit === "ready") {
      if (state.publication) lines.push("PR · " + state.publication.pullRequest, ...state.publication.comments);
      for (const report of state.reports.filter(report => report.candidateId === state.candidateId && report.outcome === "pass")) {
        lines.push(titles[report.phase] + " · " + report.summary);
      }
      if (state.team?.handoff) lines.push(state.team.handoff);
    }
    if (state.deliveryRevision) lines.splice(1, 0, "交付提交 " + state.deliveryRevision);
    else if (state.revision) lines.splice(1, 0, "候审提交 " + state.revision);
    const decisions = new Map((state.decisions ?? []).map(decision => [decision.factId, decision]));
    for (const decision of decisions.values()) {
      lines.push(`用户事实裁决 ${decision.factId} · ${decision.action} · ${decision.text}`);
    }
    const handoff = lines.join("\n");
    ctx.ui.notify(handoff, active.state.exit === "blocked" ? "warning" : "info");
    await release(ctx);
    pi.sendMessage({ customType: "pi-taskbook-exit", content: handoff, display: true }, { triggerTurn: false });
  }

  const setup = registerSetupCommand(pi, () => Boolean(run || launching));

  function entryBusy(ctx: ExtensionContext) {
    return !ctx.isIdle() || attempt || launching || setup.isChecking() || coordinating;
  }

  registerHelpCommand(pi, ctx => {
    if (setup.isChecking()) return "当前阶段 · Setup 正在检查当前 Pi 会话和项目。";
    if (launching && !run) return "正在准备任务入口和工作树。";
    if (setup.isActive(ctx)) return "当前阶段 · Setup 正在处理配置或迁移问题。";
    const current = run ?? (lastRun?.state.session === ctx.sessionManager.getSessionId() ? lastRun : undefined);
    if (!current) return "当前会话没有正在执行的任务书。";
    const {task, state} = current;
    if (state.phase === "exit") {
      const receipt = state.publication;
      if (receipt) return task.id + " · PR 已登记 · " + receipt.pullRequest;
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
      let projectChange: MemoryChange | undefined;
      if (decision.factId.startsWith("project:")) {
        const snapshot = readProjectMemory(active.root);
        if (conflict.projectHead !== snapshot.head) {
          setRunState(active, { ...active.state, pendingConflicts: [], phase: "fact-management",
            approvedProjectHead: undefined, revision: undefined, candidateId: undefined });
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
      setRunState(active, { ...active.state, pendingConflicts: remaining, phase: "fact-management",
        approvedProjectHead: undefined, revision: undefined, candidateId: undefined, team: undefined,
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
    if (!started || !attempt) return;
    const index = event.messages.findLastIndex(message => message.role === "custom" &&
      message.customType === kickoffType && message.details === attempt);
    return {messages: index < 0 ? [] : event.messages.slice(index)};
  });

  pi.on("before_agent_start", (event, ctx) => {
    let root = run?.root;
    if (!root) {
      try { root = git(ctx.cwd, "rev-parse", "--show-toplevel"); } catch {}
    }
    const projectInstructions = root ? alwaysPrompt(root) : "";
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
    if (run?.state.phase === "publication") {
      if (deliveryCaller && event.parentToolCallId === deliveryCaller) {
        const github = [...githubHandoffTools(pi).values()];
        const memory = [...magpieSessionTools(pi).values()].flatMap(group => Object.values(group));
        if ([...github, ...memory].some(tool => tool.name === event.toolName)) return;
      }
      return {block: true, reason: "交付阶段由插件通过 Magpie 执行。"};
    }
    if (coordinating && event.parentToolCallId === coordinating.caller &&
        (event.toolName === subagentTool ||
          ((run?.state.phase === "design" || run?.state.phase === "review") && event.toolName === coordinating.sourceReader))) return;
    if (run && directDelegation(event.toolName)) {
      return {block: true, reason: "任务书的子代理由插件按项目配置派发。"};
    }
    if (run && relocated && event.toolName === "read") return {block: true, reason: "请通过 Taskbook 工具读取已验证的 T3 工作区。"};
    if (run) {
      const reason = factAccessRestriction(event.toolName, event.input, ctx.cwd, run.root);
      if (reason) return {block: true, reason};
    }
    if (run && /^(?:mcp__.*__)?memory_(?:save|forget)(?:_[\da-f]+)?$/i.test(event.toolName)) {
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
  });

  pi.registerTool({
    name: reportTool,
    label: "提交任务书阶段证据",
    description: "登记本阶段结果。Handoff 通过时在本调用内等待签署交付的 PR 回执。",
    defaultActive: false,
    executionMode: "sequential",
    reachesTools: input => input.outcome === "pass" &&
      (run?.state.phase === "handoff" || run?.state.phase === "fact-management") ? ["magpie"] : [],
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
        reported = true;
        deliveryCaller = toolCallId;
        try {
          const deliveryRevision = removeDesignArchive(active.root, active.task);
          setRunState(active, {...active.state, phase: "publication", deliveryRevision,
            team: {...team, handoff: summary, pullRequest: params.pullRequest}, reports: [...active.state.reports, report]});
          ctx.ui.setStatus("pi-taskbook", titles.publication);
          onUpdate?.({content: [{type: "text", text: titles.publication}], details: {}});
          const publication = await publishSignedDelivery(ctx, active, signal);
          setRunState(active, {...active.state, phase: "exit", exit: "ready", publication});
          return {content: [{type: "text", text: "PR 已登记 · " + publication.pullRequest}], details: {}, terminate: true};
        } catch (error) {
          const stopReason = error instanceof Error ? error.message : String(error);
          setRunState(active, {...active.state, phase: "exit", exit: "blocked", stopReason});
          return {content: [{type: "text", text: "PR 发布失败 · " + stopReason}], details: {}, terminate: true};
        } finally {
          deliveryCaller = undefined;
        }
      }
      if (phase === "fact-management") {
        if (!intakeSnapshot || !workerSnapshot || readProjectMemory(run.root).head !== workerSnapshot.head ||
            readFactTables(run.root).head !== intakeSnapshot.head) throw new Error("事实同步输入已变化，请重新提交任务书。");
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
      throw new Error("当前阶段由插件派发。");
    },
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (!run || !started) return;
    started = false;
    attempt = undefined;
    try {
      if (run.state.phase === "exit" && reported) return await announce(ctx, run);
      if (event.aborted || !reported) return await exitInvocation(ctx,
        event.aborted ? "当前轮次被中断。" : "本轮结束前没有通过校验的阶段报告。");
      await startPhase(ctx);
    } catch (error) { await exitInvocation(ctx, String(error)); }
  });
}

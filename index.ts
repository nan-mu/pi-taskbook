import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitOk, readTaskbook, workspace, type Taskbook } from "./taskbook.ts";
import { nextPhase, restorePhase, taskFlow, titles, type Outcome, type Phase } from "./workflow.ts";
import { prepareTaskWorktree, readEntryArgument, verifyPreparedEntry, type PreparedEntry } from "./entry.ts";
import { launchT3Thread, readT3Endpoint } from "./t3.ts";
import { loadUpstreamInputs, pinUpstreamInputs, type UpstreamPins } from "./upstream.ts";

const reportTool = "taskbook_report";
const kickoffType = "pi-taskbook-stage";
const promptDir = fileURLToPath(new URL("./prompts/", import.meta.url));
const common = readFileSync(join(promptDir, "common.md"), "utf8");
const prompts = Object.fromEntries(Object.keys(titles).map(phase => {
  const name = phase === "implement-new" || phase === "implement-fix" ? "implement" : phase;
  return [phase, readFileSync(join(promptDir, name + ".md"), "utf8")];
}));

type Report = { phase: Phase; outcome: Outcome; summary: string; evidence: string[]; reviewThread?: string };
type State = {
  version: 1;
  digest: string;
  session: string;
  base: string;
  phase: Phase | "exit";
  exit?: "ready" | "blocked" | "cancelled";
  revision?: string;
  upstream?: UpstreamPins;
  reports: Report[];
};
type Run = { task: Taskbook; path: string; root: string; state: State };

const reportParameters = Type.Object({
  attempt: Type.String({ description: "当前阶段提示词中给出的执行标识。" }),
  outcome: Type.Union([Type.Literal("pass"), Type.Literal("blocked"), Type.Literal("measure")]),
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { maxItems: 20 }),
  reviewThread: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
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
    const initial: State = { version: 1, digest: task.digest, session, base: preliminary.base, phase: taskFlow(task.type)[0], reports: [],
      upstream: pinUpstreamInputs() };
    try { save(path, initial, task, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!lstatSync(path).isFile()) throw new Error("审计状态需要是普通文件。");
  const saved = JSON.parse(readFileSync(path, "utf8")) as Omit<State, "phase" | "reports"> & {
    phase: string; reports: (Omit<Report, "phase"> & { phase: string })[];
  };
  if (saved.version !== 1 || saved.digest !== task.digest || saved.session !== session || !Array.isArray(saved.reports)) {
    throw new Error("审计记录不匹配，或任务已绑定到另一个 Pi 会话。");
  }
  const state: State = { ...saved,
    phase: saved.phase === "exit" ? "exit" : restorePhase(task.type, saved.phase),
    reports: saved.reports.map(report => ({ ...report, phase: restorePhase(task.type, report.phase) })),
  };
  workspace(ctx.cwd, task, state.base);
  return { task, root: preliminary.root, path, state };
}

function cleanRevision(run: Run) {
  const revision = git(run.root, "rev-parse", "HEAD");
  if (git(run.root, "status", "--porcelain", "--untracked-files=all")) {
    throw new Error("交付快照需要干净的工作区。保留任务外改动，待其妥善处理后重试。");
  }
  return revision;
}

function buildPhaseInput(run: Run, phase: Phase, attempt: string) {
  const { task, state } = run;
  const fixed = JSON.stringify({ task: task.id, type: task.type, base: state.base, revision: state.revision,
    branch: task.branch, phase, attempt, priorReports: state.reports }, null, 2);
  const upstream = loadUpstreamInputs(state.upstream, phase, task.type);
  const methods = upstream.flatMap(file => ["## 当前阶段的上游方法 " + file.source, file.text]);
  return [common, prompts[phase], ...methods, "## 当前运行数据", fixed, "## 任务书原文", task.markdown,
    "## 任务书随附事实", task.facts ?? "任务书未声明随附事实文件。"].join("\n\n");
}

export default function taskbookExtension(pi: ExtensionAPI) {
  let run: Run | undefined;
  let attempt: string | undefined;
  let started = false;
  let reported = false;
  let launching = false;
  let phaseInput: string | undefined;

  function toggleReportTool(enabled: boolean) {
    const tools = pi.getActiveTools().filter(name => name !== reportTool);
    if (enabled) tools.push(reportTool);
    pi.setActiveTools(tools);
  }

  function startPhase(ctx: ExtensionContext) {
    if (!run || run.state.phase === "exit") return;
    workspace(ctx.cwd, run.task, run.state.base);
    const token = randomUUID();
    phaseInput = buildPhaseInput(run, run.state.phase, token);
    attempt = token;
    started = false;
    reported = false;
    ctx.ui.setStatus("pi-taskbook", titles[run.state.phase]);
    pi.sendMessage({ customType: kickoffType, content: "执行当前任务书阶段。", display: false, details: attempt },
      { triggerTurn: true });
  }

  function release(ctx: ExtensionContext) {
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
    const reports = active.state.exit === "cancelled" ? [] : active.state.reports;
    const summaries = reports.map(report => `${titles[report.phase]} · ${report.summary}`);
    const handoff = [labels[active.state.exit!] + " · " + active.task.id,
      active.state.revision ? "交付提交 " + active.state.revision : "",
      ...summaries, active.path].filter(Boolean).join("\n");
    ctx.ui.notify(handoff, active.state.exit === "blocked" ? "warning" : "info");
    release(ctx);
    pi.sendMessage({ customType: "pi-taskbook-exit", content: handoff, display: true }, { triggerTurn: false });
  }

  pi.registerCommand("taskbook", {
    description: "在当前 linked worktree 接收任务书或恢复工作流",
    async handler(args, ctx) {
      if (!ctx.isIdle() || attempt || launching) return ctx.ui.notify("入口请求已退出：当前会话正在处理任务。", "warning");
      if (!args.trim()) return exitInvocation(ctx, "用法 /taskbook <任务书路径>");
      try {
        const input = readEntryArgument(args.trim());
        const task = readTaskbook(ctx.cwd, input.prepared ? '"' + input.path + '"' : input.path);
        const candidate = openRun(ctx, task, input.prepared);
        if (candidate.state.phase === "exit") return announce(ctx, candidate);
        run = candidate;
        toggleReportTool(true);
        startPhase(ctx);
      } catch (error) {
        exitInvocation(ctx, String(error), run);
      }
    },
  });

  pi.registerCommand("taskbook-new", {
    description: "按任务书新建工作分支和 worktree，并启动 T3 thread",
    async handler(args, ctx) {
      if (!ctx.isIdle() || attempt || launching) return ctx.ui.notify("入口请求已退出：当前会话正在处理任务。", "warning");
      if (!args.trim()) return exitInvocation(ctx, "用法 /taskbook-new <任务书路径>");
      launching = true;
      let preparedPath: string | undefined;
      try {
        const task = readTaskbook(ctx.cwd, args);
        const endpoint = readT3Endpoint();
        const location = process.env.PI_TASKBOOK_WORKTREE_ROOT;
        if (!location) throw new Error("请设置 PI_TASKBOOK_WORKTREE_ROOT 为专用 worktree 根目录。");
        const prepared = prepareTaskWorktree(ctx.cwd, task, location);
        preparedPath = prepared.path;
        const reply = await launchT3Thread(endpoint, {
          title: task.id, branch: task.branch, worktreePath: prepared.path, message: prepared.message,
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

  pi.on("before_agent_start", (event) => {
    if (!run || !attempt || !phaseInput || run.state.phase === "exit" || event.messageType !== "custom" ||
        event.message.customType !== kickoffType || event.message.details !== attempt) return;
    started = true;
    return { systemPrompt: event.systemPrompt + "\n\n" + phaseInput };
  });

  pi.on("tool_call", () => {
    if (started && reported) return { block: true, reason: "当前阶段已提交，等待 Pi 结束这一轮。" };
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
      const reviewThread = params.reviewThread?.trim();
      if (!summary || (outcome !== "blocked" && evidence.length === 0)) throw new Error("请提供具体结论及对应证据。");
      if (outcome !== "blocked" && (phase === "correctness" || phase === "quality")) {
        if (!reviewThread || run.state.reports.some(item => item.reviewThread === reviewThread)) {
          throw new Error("请提供本阶段独立审核的子 thread 标识。");
        }
      }
      workspace(ctx.cwd, run.task, run.state.base);
      let revision = run.state.revision;
      if (outcome !== "blocked" && (phase === "implement-new" || phase === "implement-fix")) revision = cleanRevision(run);
      if (outcome !== "blocked" && revision && cleanRevision(run) !== revision) {
        throw new Error("待审快照已变化，应退出并使用更新的任务书重新提交。");
      }
      const next = nextPhase(run.task.type, phase, outcome);
      const report: Report = { phase, outcome, summary, evidence, reviewThread };
      const exit = next === "ready" || next === "blocked";
      checkpoint(run, { ...run.state, revision, phase: exit ? "exit" : next,
        exit: exit ? next : undefined, reports: [...run.state.reports, report] });
      reported = true;
      return { content: [{ type: "text", text: "阶段结果已登记。结束当前轮次。" }], details: { phase } };
    },
  });

  pi.on("agent_settled", (event, ctx) => {
    if (!run || !started) return;
    started = false;
    attempt = undefined;
    if (run.state.phase === "exit") return announce(ctx, run);
    if (event.aborted || !reported) {
      return exitInvocation(ctx, event.aborted ? "当前轮次被中断。" : "本轮结束前没有通过校验的阶段报告。", run);
    }
    try { startPhase(ctx); }
    catch (error) { exitInvocation(ctx, String(error), run); }
  });
}

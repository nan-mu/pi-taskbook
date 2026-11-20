import { randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecutionPlan, PlanGap } from "./design-worker.ts";
import { modelConfigPaths, modelRoles, modelRoutes, readModelConfig, resolveModel, type ModelRoutes } from "../models/config.ts";
import { verifyPreparedEntry, type PreparedEntry } from "../taskbook/entry.ts";
import type { CheckedFact } from "../facts/fact-check.ts";
import type { MagpieSyncResult } from "../integrations/magpie-memory.ts";
import type { FactConflict, FactDecision } from "./task-context.ts";
import { legacyProjectFactsPath, readProjectMemory, type MemoryChange } from "../facts/project-memory.ts";
import type { ReviewResult } from "../review/reviewer.ts";
import { git, workspace, type Taskbook } from "../taskbook/document.ts";
import { loadUpstreamInputs, pinUpstreamInputs, usesCurrentInputs, type UpstreamPins } from "../methods/upstream.ts";
import { inspectAuditMigration } from "../setup/audit-migration.ts";
import { ensureRunDirectory, runDirectory } from "./run-paths.ts";
import { restorePhase, stages, type Outcome, type Phase } from "./transitions.ts";

export type RunObservation = { revision: string; toolName: string; toolCallId: string; input: unknown; isError: boolean; observed: string };
export type Report = { planVersion?: number; plan?: ExecutionPlan; gap?: PlanGap; model?: string; phase: Phase; outcome: Outcome; summary: string; evidence: string[];
  factChecks?: CheckedFact[]; observations?: RunObservation[]; review?: ReviewResult; candidateId?: string;
  projectHead?: string | null; projectStore?: "fact-v1"; conflicts?: FactConflict[]; reviewInput?: string };
type CompletedSync = {
  revision: string;
  projectHead: string | null;
  result: MagpieSyncResult;
  confirmed?: ConfirmedMagpieItem[];
};
type ConfirmedMagpieItem = Extract<CompletedSync["result"]["items"][number], { remoteId: string }>;
type State = {
  version: 3;
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
  approvedProjectHead?: string | null;
  sync?: CompletedSync;
  revision?: string;
  upstream?: UpstreamPins;
  reports: Report[];
};
export type Run = { task: Taskbook; path: string; root: string; state: State };

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

export function checkpoint(run: Run, next: State) {
  save(run.path, next, run.task);
  run.state = next;
}

export function openRun({ ctx, task, promptDigest, prepared }: {
  ctx: ExtensionContext;
  task: Taskbook;
  promptDigest: string;
  prepared?: PreparedEntry;
}): Run {
  const session = ctx.sessionManager.getSessionId();
  if (!ctx.sessionManager.getSessionFile()) throw new Error("请在有持久会话记录的 Pi thread 中启动任务。");
  const preliminary = verifyPreparedEntry(ctx.cwd, task, prepared);
  const key = task.id + "-" + task.digest.slice(0, 16);
  const path = join(runDirectory(preliminary.root), key, "state.json");
  if (!existsSync(path) && lstatSync(join(preliminary.root, ".audit/pi-taskbook", key, "state.json"), {throwIfNoEntry: false})) {
    throw new Error("该任务仍有旧检查点。先运行 /taskbook-setup 并批准迁移，再提交原任务书。");
  }
  ensureRunDirectory(preliminary.root, key);

  if (!existsSync(path)) {
    const upstream = pinUpstreamInputs();
    loadUpstreamInputs(upstream, stages[0], task.type);
    const initial: State = { version: 3, reviewPolicy: 1, promptDigest, digest: task.digest, session, base: preliminary.base, branch: preliminary.branch,
      phase: stages[0], reports: [],
      upstream };
    try { save(path, initial, task, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!lstatSync(path).isFile()) throw new Error("审计状态需要是普通文件。");
  const saved = JSON.parse(readFileSync(path, "utf8")) as Omit<State, "version" | "phase" | "reports" | "branch"> & {
    version: number; phase: string; branch?: string; reports: (Omit<Report, "phase"> & { phase: string })[];
  };
  if (![1, 2, 3].includes(saved.version) || saved.digest !== task.digest || saved.session !== session || !Array.isArray(saved.reports)) {
    throw new Error("审计记录不匹配，或任务已绑定到另一个 Pi 会话。");
  }
  const state: State = { ...saved, version: 3,
    branch: saved.branch ?? preliminary.branch,
    phase: saved.phase === "exit" ? "exit" : restorePhase(task.type, saved.phase),
    reports: saved.reports.map(report => ({ ...report, phase: restorePhase(task.type, report.phase) })),
  };
  workspace(ctx.cwd, task, state.base, state.branch);
  if (saved.version === 1) {
    if (state.reports.some(report => report.phase === "fact-review" && report.outcome === "pass") ||
        [...(state.pendingConflicts ?? []), ...(state.decisions ?? [])].some(item => item.factId.startsWith("project:"))) {
      throw new Error("旧检查点含已审核的观察或项目事实裁决。保留 " + path +
        "，用 /taskbook-setup 盘点并核对迁移，再用新的 Taskbook ID 重启任务并重新提交裁决。");
    }
    save(path, state, task);
  }
  if ((state.phase !== "exit" || state.exit === "ready") && (saved.version < 3 || !state.reviewPolicy || state.promptDigest !== promptDigest || !usesCurrentInputs(state.upstream))) {
    const upstream = pinUpstreamInputs();
    loadUpstreamInputs(upstream, "fact-check", task.type);
    Object.assign(state, { reviewPolicy: 1, promptDigest, upstream, phase: "fact-check", cycleStart: state.reports.length,
      exit: undefined, revision: undefined, candidateId: undefined, plan: undefined, approvedProjectHead: undefined, sync: undefined,
      planGap: undefined, designActions: undefined });
    save(path, state, task);
  }
  const active = { task, root: preliminary.root, path, state };
  if (state.approvedProjectHead !== undefined && state.approvedProjectHead !== readProjectMemory(active.root).head) {
    throw new Error("当前 .fact 与检查点中已独立审核的版本不同。核对已接受的项目事实版本，恢复该版本后重试，或使用新 Taskbook ID 重新核查。");
  }
  if (state.exit === "ready" && state.revision !== cleanRevision(active)) {
    checkpoint(active, { ...state, phase: "implement", exit: undefined, revision: undefined, candidateId: undefined, sync: undefined });
  } else if (state.exit === "ready" && (state.reports.findLast(r => r.phase === "quality")?.projectHead ?? null) !== readProjectMemory(active.root).head) {
    checkpoint(active, {...state, phase: "correctness", exit: undefined, sync: undefined});
  }
  if (!active.state.routes) {
    const routes = modelRoutes(ctx, readModelConfig(modelConfigPaths(active.root)));
    for (const key of new Set(modelRoles.map(role => routes[role]))) if (key) resolveModel(ctx, key);
    checkpoint(active, {...active.state, routes});
  }
  if (!active.state.plan && (["implement", "performance", "correctness", "quality"].includes(active.state.phase) ||
    active.state.exit === "ready")) {
    checkpoint(active, {...active.state, phase: "design", exit: undefined, revision: undefined, candidateId: undefined});
  }
  return active;
}

export function cleanRevision(run: Run) {
  const revision = git(run.root, "rev-parse", "HEAD");
  const untracked = git(run.root, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
  if (untracked.includes(legacyProjectFactsPath)) readProjectMemory(run.root);
  const isAudit = (path: string) => path.startsWith(".audit/");
  if (git(run.root, "status", "--porcelain", "--untracked-files=no") ||
      untracked.some(path => path !== legacyProjectFactsPath && !isAudit(path)) ||
      (untracked.some(isAudit) && inspectAuditMigration(run.root).status !== "archived")) {
    throw new Error("交付快照需要干净的工作区。保留任务外改动，待其妥善处理后重试。");
  }
  return revision;
}

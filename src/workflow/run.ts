import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecutionPlan } from "./design-worker.ts";
import { modelConfigPaths, modelRoles, modelRoutes, readModelConfig, resolveModel, type ModelRoutes } from "../models/config.ts";
import { verifyPreparedEntry, type PreparedEntry } from "../taskbook/entry.ts";
import type { CheckedFact } from "../facts/fact-check.ts";
import type { MagpieSyncResult } from "../integrations/magpie-memory.ts";
import type { FactConflict, FactDecision, TaskItem } from "./task-context.ts";
import { legacyProjectFactsPath, projectFactsPath, projectGlossaryPath, readProjectMemory, taskbookMemoryChanges, type MemoryChange } from "../facts/project-memory.ts";
import { readFactFile } from "../facts/commit-files.ts";
import { git, type Taskbook } from "../taskbook/document.ts";
import type { Outcome, Phase } from "./transitions.ts";
import type { IntakeConflict, IntakeDecision, TaskFactView } from "../facts/taskbook-intake.ts";
import { isArchiveRemoval } from "./design-archive.ts";
import type { Team } from "./team.ts";
import type { PublicationReceipt } from "./publication.ts";

export type Report = {phase: Phase; outcome: Outcome; summary: string; evidence: string[]; planVersion?: number;
  plan?: ExecutionPlan; factChecks?: CheckedFact[]; candidateId?: string; projectHead?: string | null; reviewInput?: string};
type State = {
  session: string;
  routes: ModelRoutes;
  plan?: ExecutionPlan;
  pendingQuestion?: { question: string };
  userAnswers?: { question: string; answer: string }[];
  candidateId?: string;
  pendingConflicts?: FactConflict[];
  decisions?: (FactDecision & { conflict: FactConflict; session: string; at: string; projectChange?: MemoryChange })[];
  cycleStart?: number;
  base: string;
  branch: string;
  phase: Phase | "exit";
  exit?: "ready" | "blocked";
  stopReason?: string;
  approvedProjectHead?: string | null;
  sync?: MagpieSyncResult;
  taskFacts?: TaskItem[];
  factView?: TaskFactView;
  intakeConflicts?: IntakeConflict[];
  intakeDecisions?: IntakeDecision[];
  intakeVersion?: {topics: string; project: string | null};
  topicFactsHead?: string;
  factBase?: string;
  revision?: string;
  deliveryRevision?: string;
  publication?: PublicationReceipt;
  team?: Team;
  reports: Report[];
};
export type Run = { task: Taskbook; root: string; state: State };

export function setRunState(run: Run, state: State) {
  run.state = state;
}

export function startRun(ctx: ExtensionContext, cwd: string, task: Taskbook, prepared?: PreparedEntry): Run {
  const {root, base, branch} = verifyPreparedEntry(cwd, task, prepared);
  const legacyChanges = taskbookMemoryChanges(task.markdown);
  if (legacyChanges.length && (readFactFile(root, projectFactsPath) === undefined ||
      (legacyChanges.some(change => change.kind === "term") && !existsSync(join(root, projectGlossaryPath(root)))))) {
    throw new Error("任务书使用旧 Project memory 指令。请用 Facts 引用或修改事实表中的条目。");
  }
  const routes = modelRoutes(ctx, readModelConfig(modelConfigPaths(root)));
  for (const route of new Set(modelRoles.map(role => routes[role]))) if (route) resolveModel(ctx, route);
  return {task, root, state: {session: ctx.sessionManager.getSessionId(), routes, base, branch, phase: "fact-check", reports: []}};
}

export function matchesDeliveryHead(run: Run, head: string) {
  const {state, root, task} = run;
  const reviewed = state.team?.registered?.revision ?? state.revision;
  return reviewed !== undefined && (head === reviewed || isArchiveRemoval(root, task, reviewed, head));
}

export function cleanRevision(run: Pick<Run, "root">) {
  const revision = git(run.root, "rev-parse", "HEAD");
  const untracked = git(run.root, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
  if (untracked.includes(legacyProjectFactsPath)) readProjectMemory(run.root);
  if (git(run.root, "status", "--porcelain", "--untracked-files=no") ||
      untracked.some(path => path !== legacyProjectFactsPath && !path.startsWith(".audit/"))) {
    throw new Error("交付快照需要干净的工作区。保留任务外改动，待其妥善处理后重试。");
  }
  return revision;
}

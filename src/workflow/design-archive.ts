import { commitFactFiles, readFactFile } from "../facts/commit-files.ts";
import { git } from "../taskbook/document.ts";
import type { Taskbook } from "../taskbook/document.ts";
import type { DesignReviewRecord } from "./designer/v0.3.ts";
import type { ExecutionPlan } from "./design-worker.ts";
import { taskMemory, type TaskItem } from "./task-context.ts";

function archivePath(task: Taskbook) { return ".fact/taskbook/" + task.digest + ".md"; }
const marker = (task: Taskbook) => "<!-- pi-taskbook design " + task.digest + " -->\n";

export function archiveDesign(root: string, task: Taskbook, base: string, branch: string, plan: ExecutionPlan, facts: TaskItem[],
  approved: {goal: string; facts: string[]; version: string; review: DesignReviewRecord[]}) {
  const path = archivePath(task);
  const {delivery} = taskMemory(task);
  const title = /^# (.+)$/m.exec(task.markdown)?.[1] ?? task.id;
  const list = (items: TaskItem[]) => items.map(item => `- **${item.id}** ${item.text.replace(/\n/g, "\n  ")}`).join("\n");
  const steps = plan.steps.map(step => `### ${step.id}\n\n${step.action}\n\nAcceptance\n\n${step.checks}\n\nTargets ${step.targets.join(", ")}`);
  const line = (text: string) => text.replace(/\s+/gu, " ").trim();
  const review = approved.review.map(({finding, reviewedVersion, resolution}) =>
    [`- ${finding.member} · ${finding.id} · ${line(finding.target)} · ${reviewedVersion.slice(0, 12)}`,
      `  Counterexample · ${line(finding.counterexample)}`, `  Evidence · ${line(finding.evidence)}`,
      `  Proposed change · ${line(finding.correction)}`, `  Lead · ${resolution.disposition} · ${line(resolution.explanation)}`].join("\n"));
  const content = [marker(task) + `# ${title}`,
    [`Taskbook ID: ${task.id}`, `Repository: ${task.repository}`, `Base commit: ${base}`,
      `Work branch: ${branch}`, `Entry: ${task.type.replace(/-/gu, " ")}`].join("\n"),
    "## Goal", approved.goal, "## Facts", list(facts),
    ...(approved.facts.length ? ["### Design facts", approved.facts.map(fact => `- ${fact.replace(/\n/g, "\n  ")}`).join("\n")] : []),
    "## Delivery", list(delivery),
    "## Implementation plan · " + plan.version, ...steps,
    "## Design review", "Signed candidate " + approved.version, ...review].join("\n\n") + "\n";
  return commitFactFiles(root, new Map([[path, content]]), "Archive taskbook design · " + task.id, () => {
    const current = readFactFile(root, path);
    if (current !== undefined && !current.startsWith(marker(task))) throw new Error("设计归档路径已有其他文件：" + path);
  });
}

export function removeDesignArchive(root: string, task: Taskbook) {
  const path = archivePath(task);
  return commitFactFiles(root, new Map([[path, undefined]]), "Close taskbook design archive · " + task.id, () => {
    const current = readFactFile(root, path);
    if (current !== undefined && !current.startsWith(marker(task))) throw new Error("设计归档不属于当前任务：" + path);
  });
}

export function isArchiveRemoval(root: string, task: Taskbook, candidate: string, revision: string) {
  if (revision === candidate) return false;
  if (git(root, "rev-list", "--parents", "-n", "1", revision) !== revision + " " + candidate) return false;
  return git(root, "diff", "--name-status", "--no-renames", candidate, revision) === "D\t" + archivePath(task);
}

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectFacts, readProjectMemory, type ProjectSnapshot } from "../facts/project-memory.ts";
import { taskFactLabel } from "../facts/taskbook-intake.ts";
import { readSourceProjectFacts, type recallMagpieMemory } from "../integrations/magpie-memory.ts";
import { methodDirectory, readStageMethod, workerMethodStages } from "../methods/catalog.ts";
import { phaseSources, usesCurrentInputs } from "../methods/upstream.ts";
import type { Run } from "./checkpoint.ts";
import { taskMemory, workerContext } from "./task-context.ts";
import type { Phase } from "./transitions.ts";

const promptDir = fileURLToPath(new URL("../../prompts/", import.meta.url));
export const magpieGuide = readFileSync(new URL("../../methods/magpie-memory/SKILL.md", import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "");
const localRolePrompts = readdirSync(promptDir, {recursive: true}).flatMap(name => typeof name === "string" && name.endsWith(".md") && name !== "setup.md" ? [name] : []).sort()
  .map(name => [name, readFileSync(join(promptDir, name), "utf8")]);
export const localPromptDigest = createHash("sha256").update(JSON.stringify([localRolePrompts, magpieGuide])).digest("hex");
export const memoryGuide = readFileSync(join(promptDir, "project-memory.md"), "utf8");
const common = readFileSync(join(promptDir, "common.md"), "utf8");
const promptNames = ["fact-management", "fact-check", "fact-check-fix", "fact-check-new", "design", "designer-consult", "implement", "performance"];
const prompts = Object.fromEntries(promptNames.map(name => [name, readFileSync(join(promptDir, name + ".md"), "utf8")]));

export function readRunContext(run: Run, snapshot = readProjectMemory(run.root)) {
  const decisions = run.state.decisions ?? [];
  const legacyFactChecks = run.state.reports.filter(report => report.phase === "fact-review" &&
    report.outcome === "pass" && report.projectHead === undefined).flatMap(report => report.factChecks ?? []);
  if (Object.values(snapshot.records).some(record => record.source.repository.toLowerCase() !== run.task.repository.toLowerCase())) {
    throw new Error(".fact/facts.tsv 含其他仓库归属的记录。请按来源核对本项目事实。");
  }
  const result = taskMemory(run.task, decisions.filter(d => !d.factId.startsWith("project:")), legacyFactChecks);
  if (run.state.taskFacts) {
    result.facts = run.state.taskFacts.map(fact => {
      const decision = decisions.findLast(item => item.factId === fact.id);
      return decision ? {...fact, text: decision.action === "replace" ? decision.text : fact.text, userDecision: decision} : fact;
    });
  }
  const referencedFactIds = new Set([...decisions, ...(run.state.pendingConflicts ?? [])].map(item => item.factId));
  result.facts = result.facts.filter(item => !item.id.startsWith("V") || referencedFactIds.has(item.id));
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

export function buildPhaseInput(run: Run, phase: Phase, attempt: string, projectSnapshot: ProjectSnapshot,
  magpieCandidates?: Awaited<ReturnType<typeof recallMagpieMemory>> & {receipts?: string[]}) {
  const { task, state } = run;
  if (!usesCurrentInputs(state.upstream)) throw new Error("任务的方法版本与随包编审版本不同，需要从事实核查重新建立审计。");
  const context = phase === "fact-management" ? taskMemory(task) : readRunContext(run, projectSnapshot);
  const fixed = JSON.stringify({ task: task.id, root: run.root, type: task.type, base: state.base, revision: state.revision,
    branch: state.branch, phase, attempt, plan: state.plan, planGap: state.planGap,
    consult: phase === "design" ? state.designConsult : undefined,
    userAnswers: state.userAnswers ?? [], designActions: phase === "design" ?
      state.designActions?.filter(action => action.version === (state.plan?.version ?? 0)) : undefined,
    ...context, magpieCandidates,
    ...(phase === "fact-management" ? {intakeDecisions: state.intakeDecisions ?? []} : {}),
    ...(state.taskFacts ? {taskFactLabel: taskFactLabel(task)} : {}),
    sourceProjectFactCandidates: phase === "fact-check" ? readSourceProjectFacts(run.root, task.repository.toLowerCase()) : undefined,
    decisions: state.decisions ?? [],
    priorReports: phase === "fact-management" ? undefined : workerContext(phase, state.reports.slice(state.cycleStart ?? 0)) });
  const consult = phase === "design" ? state.designConsult : undefined;
  const guidance = consult ? [prompts["designer-consult"], ...consult.methods.map(id => readStageMethod(id, workerMethodStages("design"), "design").text)]
    : [prompts[phase]];
  if (state.taskFacts && (phase === "design" || phase === "implement")) {
    guidance.push("Facts tagged " + taskFactLabel(task) + " are the primary facts for this task. Locate each task fact and background fact in its task, project, and revision. For contradictions in the same scope, escalate both record locations and their overlapping scope.");
  }
  if (phase === "fact-check") guidance.push(prompts[task.type.startsWith("fix-") ? "fact-check-fix" : "fact-check-new"], magpieGuide);
  const methods = methodDirectory(workerMethodStages(phase, task.type), phaseSources(phase, task.type));
  return [common, ...guidance, ...(phase === "fact-management" ? [] : ["## Reference methods\nIdentify the current role decision that needs a method. Use taskbook_method to read only the guidance needed for that decision, retain its source, and return to the assignment after finding the criterion. Omit name to browse.\n" + methods]),
    "## 当前运行数据", fixed, "## 任务书原文", task.markdown,
    ...(task.facts !== undefined ? ["## 任务书随附事实", task.facts] : [])].join("\n\n");
}

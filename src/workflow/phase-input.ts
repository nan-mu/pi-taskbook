import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectFacts, readProjectMemory, type ProjectSnapshot } from "../facts/project-memory.ts";
import { taskFactLabel } from "../facts/taskbook-intake.ts";
import { readSourceProjectFacts, type recallMagpieMemory } from "../integrations/magpie-memory.ts";
import { methodDirectory, workerMethodStages } from "../methods/catalog.ts";
import { phaseSources } from "../methods/upstream.ts";
import type { Run } from "./run.ts";
import { taskMemory } from "./task-context.ts";
import type { Phase } from "./transitions.ts";

const promptDir = fileURLToPath(new URL("../../prompts/", import.meta.url));
export const magpieGuide = readFileSync(join(promptDir, "magpie-memory.md"), "utf8");
const common = readFileSync(join(promptDir, "common.md"), "utf8");
const factCheck = readFileSync(join(promptDir, "fact-check.md"), "utf8");
const factCheckFix = readFileSync(join(promptDir, "fact-check-fix.md"), "utf8");
const factCheckNew = readFileSync(join(promptDir, "fact-check-new.md"), "utf8");
const factManagement = readFileSync(join(promptDir, "fact-management.md"), "utf8");

export function readRunContext(run: Run, snapshot = readProjectMemory(run.root)) {
  const decisions = run.state.decisions ?? [];
  if (Object.values(snapshot.records).some(record => record.source.repository.toLowerCase() !== run.task.repository.toLowerCase())) {
    throw new Error(".fact/facts.tsv 含其他仓库归属的记录。请按来源核对本项目事实。");
  }
  const result = taskMemory(run.task, decisions.filter(d => !d.factId.startsWith("project:")));
  if (run.state.taskFacts) {
    result.facts = run.state.taskFacts.map(fact => {
      const decision = decisions.findLast(item => item.factId === fact.id);
      return decision ? {...fact, text: decision.action === "replace" ? decision.text : fact.text, userDecision: decision} : fact;
    });
  }
  const referencedFactIds = new Set([...decisions, ...(run.state.pendingConflicts ?? [])].map(item => item.factId));
  result.facts = result.facts.filter(item => !item.id.startsWith("V") || referencedFactIds.has(item.id));
  result.facts.push(...projectFacts(snapshot, run.state.base).map(fact => {
    const version = snapshot.records[fact.id].version;
    const decision = decisions.findLast(d => d.factId === fact.id &&
      (d.conflict.projectVersion === version || (d.projectChange?.expected === version - 1 && d.text === snapshot.records[fact.id].text)));
    return decision ? { ...fact, userDecision: decision } : fact;
  }));
  return result;
}

export function buildPhaseInput(run: Run, phase: Extract<Phase, "fact-management" | "fact-check">, attempt: string,
  magpieCandidates?: Awaited<ReturnType<typeof recallMagpieMemory>> & {receipts?: string[]}) {
  const { task, state } = run;
  const {goals, facts, delivery} = taskMemory(task, state.decisions?.filter(decision => !decision.factId.startsWith("project:")));
  const fixed = JSON.stringify({task: task.id, root: run.root, type: task.type, base: state.base, branch: state.branch,
    phase, attempt, goals, facts, delivery, userAnswers: state.userAnswers, decisions: state.decisions,
    ...(phase === "fact-management" ? {intakeDecisions: state.intakeDecisions} :
      {magpieCandidates, sourceProjectFactCandidates: readSourceProjectFacts(run.root, task.repository.toLowerCase())})});
  const guidance = phase === "fact-management" ? [factManagement] : [factCheck,
    task.type.startsWith("fix-") ? factCheckFix : factCheckNew, magpieGuide,
    "Use taskbook_method for relevant methods.\n" + methodDirectory(workerMethodStages(phase, task.type), phaseSources(phase, task.type))];
  return [common, ...guidance, "## 当前运行数据", fixed, "## 任务书原文", task.markdown,
    ...(task.facts !== undefined ? ["## 任务书随附事实", task.facts] : [])].join("\n\n");
}

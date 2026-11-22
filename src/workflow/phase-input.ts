import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectFacts, readProjectMemory, type ProjectSnapshot } from "../facts/project-memory.ts";
import { taskFactLabel } from "../facts/taskbook-intake.ts";
import type { Run } from "./run.ts";
import { taskMemory } from "./task-context.ts";

const promptDir = fileURLToPath(new URL("../../prompts/", import.meta.url));
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
  result.facts.push(...projectFacts(snapshot, run.state.base).map(fact => {
    const version = snapshot.records[fact.id].version;
    const decision = decisions.findLast(d => d.factId === fact.id &&
      (d.conflict.projectVersion === version || (d.projectChange?.expected === version - 1 && d.text === snapshot.records[fact.id].text)));
    return decision ? { ...fact, userDecision: decision } : fact;
  }));
  return result;
}

export function buildIntakeInput(run: Run, attempt: string) {
  const { task, state } = run;
  const {facts} = taskMemory(task, state.decisions?.filter(decision => !decision.factId.startsWith("project:")));
  const fixed = {attempt, base: state.base, facts, intakeDecisions: state.intakeDecisions};
  return factManagement + "\n\n" + JSON.stringify(fixed);
}

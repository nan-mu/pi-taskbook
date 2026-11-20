import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectFacts, readProjectMemory, type ProjectSnapshot } from "../facts/project-memory.ts";
import { readForeignFacts, type recallMagpieMemory } from "../integrations/magpie-memory.ts";
import { methodDirectory, workerMethodStages } from "../methods/catalog.ts";
import { loadUpstreamInputs } from "../methods/upstream.ts";
import type { Run } from "./checkpoint.ts";
import { taskMemory, workerContext } from "./task-context.ts";
import type { Phase } from "./transitions.ts";

const promptDir = fileURLToPath(new URL("../../prompts/", import.meta.url));
export const magpieGuide = readFileSync(new URL("../../methods/magpie-memory/SKILL.md", import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "");
const localRolePrompts = readdirSync(promptDir).filter(name => name.endsWith(".md")).sort()
  .map(name => [name, readFileSync(join(promptDir, name), "utf8")]);
export const localPromptDigest = createHash("sha256").update(JSON.stringify([localRolePrompts, magpieGuide])).digest("hex");
export const memoryGuide = readFileSync(join(promptDir, "project-memory.md"), "utf8");
const common = readFileSync(join(promptDir, "common.md"), "utf8");
const promptNames = ["fact-check", "fact-check-fix", "fact-check-new", "design", "implement", "performance"];
const prompts = Object.fromEntries(promptNames.map(name => [name, readFileSync(join(promptDir, name + ".md"), "utf8")]));

export function readRunContext(run: Run, snapshot = readProjectMemory(run.root)) {
  const decisions = run.state.decisions ?? [];
  const legacyFactChecks = run.state.reports.filter(report => report.phase === "fact-review" &&
    report.outcome === "pass" && report.projectHead === undefined).flatMap(report => report.factChecks ?? []);
  if (Object.values(snapshot.records).some(record => record.source.repository.toLowerCase() !== run.task.repository.toLowerCase())) {
    throw new Error(".fact/project.json 含其他仓库归属的记录。请按来源核对本项目事实。");
  }
  const result = taskMemory(run.task, decisions.filter(d => !d.factId.startsWith("project:")), legacyFactChecks);
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

export function buildPhaseInput(run: Run, phase: Phase, attempt: string, projectSnapshot: ProjectSnapshot, magpieCandidates?: Awaited<ReturnType<typeof recallMagpieMemory>> & {receipts?: string[]}) {
  const { task, state } = run;
  const fixed = JSON.stringify({ task: task.id, type: task.type, base: state.base, revision: state.revision,
    branch: state.branch, phase, attempt, plan: state.plan, planGap: state.planGap,
    userAnswers: state.userAnswers ?? [], designActions: phase === "design" ?
      state.designActions?.filter(action => action.version === (state.plan?.version ?? 0)) : undefined,
    ...readRunContext(run, projectSnapshot), magpieCandidates,
    foreignFactCandidates: phase === "fact-check" ? readForeignFacts(run.root, task.repository.toLowerCase()) : undefined,
    decisions: state.decisions ?? [],
    priorReports: workerContext(phase, state.reports.slice(state.cycleStart ?? 0)) }, null, 2);
  const upstream = loadUpstreamInputs(state.upstream, phase, task.type);
  const methods = upstream.flatMap(file => ["## 当前阶段的上游方法 " + file.source, file.text]);
  const guidance = [prompts[phase]];
  guidance.push(".fact 自有事实与术语由独立事实审核写入。foreignFactCandidates 是按来源提供的只读候选数据。完成前只核对 Magpie 候选，不经工具或 shell 发布或退役远端数据。");
  if (phase === "fact-check") guidance.push(memoryGuide, magpieGuide);
  if (phase === "fact-check") guidance.push(prompts[task.type.startsWith("fix-") ? "fact-check-fix" : "fact-check-new"]);
  return [common, ...guidance, ...methods, methodDirectory(workerMethodStages(phase)), "## 当前运行数据", fixed, "## 任务书原文", task.markdown,
    ...(task.facts !== undefined ? ["## 任务书随附事实", task.facts] : [])].join("\n\n");
}

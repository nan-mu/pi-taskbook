import type { Taskbook } from "./taskbook.ts";

const reviewStages = ["correctness", "quality", "performance"] as const;
const newStages = ["confirm-premises", "design", "implement-new", ...reviewStages] as const;
const fixStages = ["reproduce-defect", "design", "implement-fix", ...reviewStages] as const;

export type Phase = (typeof newStages | typeof fixStages)[number];
export type Outcome = "pass" | "blocked" | "measure";

export const titles: Record<Phase, string> = {
  "confirm-premises": "新增任务 · 核查前提",
  "reproduce-defect": "修复任务 · 复现或核实缺陷",
  design: "澄清与设计",
  "implement-new": "实现新增目标并取证",
  "implement-fix": "修复已确认缺陷并复验",
  correctness: "规格审核",
  quality: "质量审核",
  performance: "性能验证",
};

export type TaskType = Taskbook["type"];

export function taskFlow(type: TaskType): readonly Phase[] {
  return type === "new-feature" || type === "new-experiment" ? newStages : fixStages;
}

export function restorePhase(type: TaskType, savedPhase: string): Phase {
  const flow = taskFlow(type);
  if (savedPhase === "fact-check") return flow[0];
  if (savedPhase === "implement") return flow[2];
  const phase = flow.find(candidate => candidate === savedPhase);
  if (!phase) throw new Error("审计中的阶段不属于这类任务书。");
  return phase;
}

export function nextPhase(type: TaskType, phase: Phase, outcome: Outcome): Phase | "ready" | "blocked" {
  const flow = taskFlow(type);
  const position = flow.indexOf(phase);
  if (position < 0) throw new Error("当前阶段不属于这类任务书。");
  if (outcome === "blocked") return "blocked";
  if (outcome === "measure" && phase !== "quality") throw new Error("只有质量审核阶段可决定进入性能验证。");
  if (phase === "quality") {
    const experiment = type === "new-experiment" || type === "fix-experiment";
    return outcome === "measure" || experiment ? "performance" : "ready";
  }
  return flow[position + 1] ?? "ready";
}

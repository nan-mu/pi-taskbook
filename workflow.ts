import type { Taskbook } from "./taskbook.ts";

export const stages = ["fact-check", "design", "implement", "correctness", "quality", "performance"] as const;
export type Phase = typeof stages[number];
export type Outcome = "pass" | "blocked" | "measure";
export type TaskType = Taskbook["type"];

export const titles: Record<Phase, string> = {
  "fact-check": "核查任务依据",
  design: "澄清与设计",
  implement: "实施并取证",
  correctness: "规格审核",
  quality: "质量审核",
  performance: "性能验证",
};

export function restorePhase(type: TaskType, savedPhase: string): Phase {
  const fix = type.startsWith("fix-");
  if (savedPhase === (fix ? "reproduce-defect" : "confirm-premises")) return "fact-check";
  if (savedPhase === (fix ? "implement-fix" : "implement-new")) return "implement";
  const phase = stages.find(candidate => candidate === savedPhase);
  if (!phase) throw new Error("审计中的阶段与任务书类型不匹配。");
  return phase;
}

export function nextPhase(type: TaskType, phase: Phase, outcome: Outcome): Phase | "ready" | "blocked" {
  if (outcome === "blocked") return "blocked";
  if (outcome === "measure" && phase !== "quality") throw new Error("只有质量审核阶段可决定进入性能验证。");
  if (phase === "quality") {
    const experiment = type === "new-experiment" || type === "fix-experiment";
    return outcome === "measure" || experiment ? "performance" : "ready";
  }
  return stages[stages.indexOf(phase) + 1] ?? "ready";
}

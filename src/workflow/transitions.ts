import type { Taskbook } from "../taskbook/document.ts";

export const stages = ["fact-management", "fact-check", "fact-review", "design", "implement", "correctness", "quality", "performance", "review", "fact-registration", "handoff"] as const;
export type Phase = typeof stages[number];
export type Outcome = "pass" | "blocked" | "measure" | "rework" | "fact-conflict" | "plan-gap" | "needs-user";
export type TaskType = Taskbook["type"];

export const titles: Record<Phase, string> = {
  "fact-management": "Fact Management · 同步任务书事实",
  "fact-check": "核查任务依据",
  "fact-review": "独立审核新增事实",
  design: "澄清与设计",
  implement: "实施并取证",
  correctness: "独立规格审核",
  quality: "独立质量审核",
  performance: "性能验证",
  review: "Review · 审核实现",
  "fact-registration": "Fact Management · 登记审核通过的草稿事实",
  handoff: "Handoff · 整理交付",
};

export function restorePhase(type: TaskType, savedPhase: string): Phase {
  const fix = type.startsWith("fix-");
  if (savedPhase === (fix ? "reproduce-defect" : "confirm-premises")) return "fact-check";
  if (savedPhase === (fix ? "implement-fix" : "implement-new")) return "implement";
  const phase = stages.find(candidate => candidate === savedPhase);
  if (!phase) throw new Error("审计中的阶段与任务书类型不匹配。");
  return phase;
}

export function nextPhase(type: TaskType, phase: Phase, outcome: Outcome, measured = false, unifiedReview = false): Phase | "ready" | "blocked" {
  if (outcome === "plan-gap" || outcome === "needs-user") {
    if (phase !== (outcome === "plan-gap" ? "implement" : "design")) throw new Error("此阶段不能作此设计决定。");
    return "design";
  }
  if (outcome === "blocked") return "blocked";
  if (outcome === "fact-conflict") return phase;
  if (phase === "fact-management" && outcome === "pass") return "design";
  if (outcome === "rework") {
    if (phase === "fact-review") return "fact-check";
    if (phase === "review" || phase === "correctness" || phase === "quality") return "implement";
    throw new Error("返工须由独立审核提出。");
  }
  if (outcome === "measure") {
    if (phase !== "review" && phase !== "correctness" && phase !== "quality") throw new Error("正式测量须由交付审核提出。");
    return measured ? "blocked" : "performance";
  }
  if (phase === "implement" && type.endsWith("-experiment")) return "performance";
  if (phase === "review" || phase === "quality") return "ready";
  if (phase === "performance" || (phase === "implement" && unifiedReview)) return unifiedReview ? "review" : "correctness";
  return stages[stages.indexOf(phase) + 1]!;
}

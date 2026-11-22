import type { Taskbook } from "../taskbook/document.ts";

export const stages = ["fact-check", "fact-review", "fact-management", "design", "implement", "correctness", "quality", "performance", "review", "fact-registration", "handoff", "publication"] as const;
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
  publication: "Publication · 等待 Magpie GitHub PR 回执",
};

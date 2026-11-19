export const phases = ["fact-check", "design", "implement", "correctness", "quality", "performance"] as const;
export type Phase = typeof phases[number];
export type Outcome = "pass" | "blocked" | "measure";

export const titles: Record<Phase, string> = {
  "fact-check": "事实核查",
  design: "澄清与设计",
  implement: "实现与取证",
  correctness: "规格审核",
  quality: "质量审核",
  performance: "性能验证",
};

export function nextPhase(phase: Phase, outcome: Outcome, experiment: boolean): Phase | "ready" | "blocked" {
  if (outcome === "blocked") return "blocked";
  if (outcome === "measure" && phase !== "quality") throw new Error("只有质量审核阶段可决定进入性能验证。");
  if (phase === "quality") return outcome === "measure" || experiment ? "performance" : "ready";
  if (phase === "performance") return "ready";
  return phases[phases.indexOf(phase) + 1];
}

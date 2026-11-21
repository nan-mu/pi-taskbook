import { catalogPins, phaseMethod, type CatalogOwner } from "./catalog.ts";
import type { Taskbook } from "../taskbook/document.ts";
import type { Phase } from "../workflow/transitions.ts";

// Old checkpoints have {root, commit}. They are readable for migration, but
// cannot authorize work against a different version of the adapted methods.
type Pin = { commit: string; digest?: string; root?: string };
export type UpstreamPins = Record<CatalogOwner, Pin>;

export function pinUpstreamInputs(): UpstreamPins {
  return catalogPins();
}

export function usesCurrentInputs(pins: UpstreamPins | undefined): boolean {
  if (!pins) return false;
  const current = catalogPins();
  return (["pstack", "matt"] as const).every(owner =>
    current[owner].commit === pins[owner]?.commit && current[owner].digest === pins[owner]?.digest);
}

export function phaseSources(phase: Phase, type: Taskbook["type"]): string[] {
  const fix = type.startsWith("fix-");
  switch (phase) {
    case "fact-management": return ["matt:domain-modeling", "pstack:principle-model-the-domain"];
    case "fact-registration": return ["matt:domain-modeling", "pstack:principle-model-the-domain"];
    case "handoff": return ["matt:pr", "pstack:principle-prove-it-works"];
    case "review": return ["pstack:principle-prove-it-works", "pstack:blast-radius"];
    case "fact-check":
      return [
        "pstack:in-your-own-words", "matt:triage", "pstack:principle-prove-it-works",
        "matt:research", "matt:domain-modeling", ...(fix ? ["matt:diagnosing-bugs"] : []),
      ];
    case "fact-review":
      return ["pstack:principle-prove-it-works", "matt:research", "matt:domain-modeling"];
    case "design":
      return [
        "matt:to-spec", "pstack:architect", "pstack:principle-model-the-domain", "matt:codebase-design",
        "pstack:principle-sequence-verifiable-units",
        ...(fix ? ["pstack:principle-fix-root-causes"] : ["pstack:principle-experience-first"]),
      ];
    case "implement":
      return ["matt:implement", "pstack:principle-sequence-verifiable-units", "pstack:principle-prove-it-works",
        ...(fix ? ["matt:diagnosing-bugs"] : type === "new-experiment" ? ["pstack:benchmark-checklist"] : ["matt:tdd"])];
    case "correctness":
      return ["matt:code-review", "matt:tdd", "pstack:principle-prove-it-works",
        "pstack:principle-test-behavior-not-implementation"];
    case "quality":
      return ["matt:code-review", "pstack:principle-minimize-reader-load", "pstack:blast-radius", "matt:tdd",
        "matt:setup-ts-deep-modules", "matt:setup-pre-commit"];
    case "performance":
      return ["pstack:benchmark-checklist", "pstack:principle-explain-the-number", "matt:research"];
  }
}

export function loadUpstreamInputs(pins: UpstreamPins | undefined, phase: Phase, type: Taskbook["type"]) {
  if (!usesCurrentInputs(pins)) throw new Error("任务的方法版本与随包编审版本不同，需要从事实核查重新建立审计。");
  return phaseSources(phase, type).map(name => phaseMethod(name, phase));
}

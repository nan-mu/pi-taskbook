import { phaseMethod } from "./catalog.ts";
import type { Taskbook } from "../taskbook/document.ts";
import type { Phase } from "../workflow/transitions.ts";

export function phaseSources(phase: Phase, type: Taskbook["type"]): string[] {
  const fix = type.startsWith("fix-");
  switch (phase) {
    case "fact-management": return ["matt:domain-modeling", "pstack:principle-model-the-domain"];
    case "fact-registration": return ["matt:domain-modeling", "pstack:principle-model-the-domain"];
    case "publication": return [];
    case "handoff": return ["matt:pr", "pstack:principle-prove-it-works"];
    case "review": return ["pstack:principle-prove-it-works", "pstack:blast-radius"];
    case "fact-review":
      return ["pstack:principle-prove-it-works", "matt:research", "matt:domain-modeling"];
    case "design":
      return [
        "matt:to-spec", "pstack:architect", "pstack:principle-model-the-domain", "matt:codebase-design",
        "pstack:principle-sequence-verifiable-units", "matt:research",
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

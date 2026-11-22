import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { readStageMethod, type MethodStage } from "../methods/catalog.ts";

export const investigations = ["how", "why"] as const;
export type Investigation = typeof investigations[number];

export const investigationRequest = Type.Object({
  kind: Type.Literal("investigate"), question: Type.String({minLength: 1, maxLength: 1200}),
}, {additionalProperties: false});

export const investigationResult = Type.Object({
  kind: Type.Literal("investigated"), answer: Type.String({minLength: 1, maxLength: 2400}),
  evidence: Type.Array(Type.String({minLength: 1, maxLength: 600}), {minItems: 1, maxItems: 6}),
}, {additionalProperties: false});

export function transition<const Next extends string, Result extends TSchema>(next: Next, result: Result) {
  return Type.Object({next: Type.Literal(next), result}, {additionalProperties: false});
}

const submission = Type.Object({next: Type.String(), result: Type.Unknown()}, {additionalProperties: false});

export function readTransition(schema: TSchema, input: unknown) {
  if (!Value.Check(submission, input) || !Value.Check(schema, input)) throw new Error("Invalid playbook transition.");
  return input;
}

export function pstackGuidance(name: string, stage: MethodStage) {
  const method = readStageMethod("pstack:" + name, [stage]);
  return [method.source, method.text].join("\n");
}

export function investigationPrompt(work: Investigation) {
  const focus = work === "how"
    ? "Trace the real entry point, the calls and tools it uses, and the observable outcome. Cite the fixed source paths and lines."
    : "Start with the introducing commit or decision, then trace later changes. Use inspect_revision history for versioned decisions. Distinguish the recorded rationale, your inference, and questions the record leaves open.";
  return [focus, "Use project facts through taskbook_query_facts. Report only the findings that answer the question.",
    pstackGuidance(work, "design")].join("\n\n");
}

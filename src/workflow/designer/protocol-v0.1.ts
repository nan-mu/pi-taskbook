import { Type, type Static } from "typebox";
import { planParameter } from "../design-worker.ts";

export const designers = ["lead", "member-a", "member-b"] as const;
export type Designer = typeof designers[number];
const designer = Type.Union(designers.map(id => Type.Literal(id)));
const text = Type.String({minLength: 1, pattern: "\\S"});
const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, {additionalProperties: false});
const draft = object({goal: text, facts: Type.Array(text)});
const change = object({section: Type.Union([Type.Literal("Goal"), Type.Literal("Facts")]), target: text, proposal: text, reason: text});
const response = Type.Union([
  object({issue: text, decision: Type.Literal("accept")}),
  object({issue: text, decision: Type.Literal("counter"), proposal: text, reason: text}),
]);
export const answers = {
  draft: object({kind: Type.Literal("draft"), draft}),
  compare: object({kind: Type.Literal("compare"), reviews: Type.Array(object({designer, changes: Type.Array(change)}), {minItems: 2, maxItems: 2})}),
  respond: object({kind: Type.Literal("respond"), responses: Type.Array(response)}),
  reconcile: object({kind: Type.Literal("reconcile"), responses: Type.Array(response)}),
  synthesize: object({kind: Type.Literal("synthesize"), draft, plan: planParameter, appliedIssues: Type.Array(text)}),
  confirm: Type.Union([
    object({kind: Type.Literal("approved"), version: text}),
    object({kind: Type.Literal("objected"), version: text, changes: Type.Array(change, {minItems: 1})}),
  ]),
  consult: object({kind: Type.Literal("answered"), answer: text, basis: text, draftFacts: Type.Array(object({text, source: text}))}),
};

export const needsUser = object({kind: Type.Literal("needs-user"), question: text, evidence: text, factId: Type.Optional(text)});
export const askConsult = object({kind: Type.Literal("consult"), question: text, evidence: text});
export type Work = keyof typeof answers;
export type RoundWork = Exclude<Work, "consult">;
export type Reply = Static<typeof answers[Work]> | Static<typeof needsUser> | Static<typeof askConsult>;
export type CompletedReply = Exclude<Reply, {kind: "consult" | "answered" | "needs-user"}>;
export type Draft = Static<typeof draft>;
export type Change = Static<typeof change>;
export type Response = Static<typeof response>;
export type Consultation = Static<typeof answers.consult>;

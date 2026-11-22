import { Type, type Static } from "typebox";

const text = Type.String({ minLength: 1, maxLength: 1200 });
const gitSource = Type.Object({
  kind: Type.Literal("git"),
  path: text,
  line: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
const toolSource = Type.Object({
  kind: Type.Literal("tool"),
  receipt: text,
}, { additionalProperties: false });

export const factChecksParameter = Type.Array(Type.Object({
  claim: text,
  observed: text,
  source: Type.Union([gitSource, toolSource]),
}, { additionalProperties: false }), { minItems: 1, maxItems: 20 });

type FactCheck = Static<typeof factChecksParameter>[number];
export type CheckedFact = FactCheck & { origin: string; toolError?: boolean; toolInput?: unknown; observedHead?: string };

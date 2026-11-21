import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const text = Type.String({ minLength: 1, pattern: "\\S" });
const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
const finding = object({ issue: text, detail: text, evidence: Type.Array(text, { minItems: 1 }), factId: Type.Optional(text) });
const factDecision = object({ id: text, decision: Type.Union([Type.Literal("keep"), Type.Literal("drop")]),
  evidence: Type.Array(text, { minItems: 1 }) });
const support = { summary: text, evidence: Type.Optional(Type.Array(text)), draftFacts: Type.Optional(Type.Array(factDecision)) };
const pass = object({ kind: Type.Literal("pass"), ...support });
const changes = object({ kind: Type.Literal("changes"), ...support, findings: Type.Array(finding, { minItems: 1 }) });
const independentPass = object({ kind: Type.Literal("pass"), ...support, evidence: Type.Array(text, { minItems: 1 }) });
const judgment = Type.Union([independentPass, changes]);
const comparison = Type.Union([pass, changes,
  object({ kind: Type.Literal("dispute"), ...support, findings: Type.Array(finding, { minItems: 1 }) })]);
const lead = Type.Union([
  object({ kind: Type.Literal("approve"), summary: text }),
  object({ kind: Type.Literal("rework"), summary: text, selected: Type.Optional(Type.Array(object({ issue: text, detail: text }), { minItems: 1 })) }),
  object({ kind: Type.Literal("ask-user"), summary: text, question: text }),
]);

export type ReviewFinding = Static<typeof finding>;
export type ReviewedFact = Static<typeof factDecision>;
type Judgment = Static<typeof judgment>;
type Comparison = Static<typeof comparison>;
type Member = "member-a" | "member-b";
type Designer = Member | "lead";
type Opinions = Record<Member, Judgment>;
type Replies = Partial<Record<Member, Comparison>>;
type Candidate = { revision: string; evidenceVersion: string };
type Goal = { id: string; text: string };
type Input = { runId: string; goals: readonly Goal[]; candidate: Candidate };
type Checkpoint = Input & { epoch: number; serial: number; everCrossed: boolean; priorFindings: ReviewFinding[] };
type Discussion = { opinions: Opinions; replies: Replies; protectedFindings: ReviewFinding[]; seen: string[] };
type Basis =
  | { kind: "pass"; draftFacts: ReviewedFact[] }
  | { kind: "changes" | "unresolved"; findings: ReviewFinding[] };
type Initial = { work: "initial-first" | "initial-rework" };
type Cross = { work: "cross-first" | "cross-repeat"; initial: Static<typeof independentPass> };
type Pair = Discussion & { work: "compare" | "respond" | "reconcile"; prior?: Record<Member, Comparison> };
type Lead = {
  work: "lead"; basis: Basis; protectedFindings: ReviewFinding[];
  opinions?: Opinions; comparisons?: Record<Member, Comparison>; userAnswer?: string;
};
type Stage = Initial | Cross | Pair | Lead;
type Working = { kind: "working"; checkpoint: Checkpoint; stage: Stage };
export type ReviewFlow = Working |
  { kind: "approved"; checkpoint: Checkpoint; summary: string; draftFacts: ReviewedFact[] } |
  { kind: "rework"; checkpoint: Checkpoint; summary: string; findings: ReviewFinding[] } |
  { kind: "needs-user"; checkpoint: Checkpoint; summary: string; question: string; findings: ReviewFinding[]; stage: Lead };

export function startReviewFlow(input: Input & { previous?: ReviewFlow }): ReviewFlow {
  const { previous } = input;
  const old = previous?.checkpoint;
  if (old && old.runId !== input.runId) throw new Error("Cannot reuse Review from another run.");
  const goals = input.goals.map(({ id, text }) => ({ id, text }));
  if (previous && old?.candidate.revision === input.candidate.revision && old.candidate.evidenceVersion === input.candidate.evidenceVersion &&
    JSON.stringify(old.goals) === JSON.stringify(goals)) return previous;
  const checkpoint: Checkpoint = { runId: input.runId, goals, candidate: { ...input.candidate }, epoch: old ? old.epoch + 1 : 1,
    serial: 1, everCrossed: old?.everCrossed ?? false, priorFindings: previous?.kind === "rework" ? previous.findings : old?.priorFindings ?? [] };
  return { kind: "working", checkpoint, stage: { work: old ? "initial-rework" : "initial-first" } };
}

const members: readonly Member[] = ["member-a", "member-b"];

function pending(stage: Stage): readonly Designer[] {
  switch (stage.work) {
    case "initial-first": case "initial-rework": return ["member-a"];
    case "cross-first": case "cross-repeat": return ["member-b"];
    case "lead": return ["lead"];
    case "compare": case "respond": case "reconcile": return members.filter(member => !stage.replies[member]);
  }
}

function turnId(checkpoint: Checkpoint, designer: Designer) {
  return `${checkpoint.runId}:review:${checkpoint.epoch}:${checkpoint.serial}:${designer}`;
}

function materials(stage: Stage, checkpoint: Checkpoint, designer: Designer) {
  switch (stage.work) {
    case "initial-first": case "cross-first": return {};
    case "initial-rework": case "cross-repeat": return { priorFindings: checkpoint.priorFindings.map(({ issue, detail }) => ({ issue, detail })) };
    case "compare": return { opinions: stage.opinions };
    case "respond": case "reconcile": return { opinions: stage.opinions, previous: stage.prior, reviewer: designer };
    case "lead": return { basis: stage.basis, opinions: stage.opinions, comparisons: stage.comparisons,
      protectedFindings: stage.protectedFindings, userAnswer: stage.userAnswer };
  }
}

function schema(stage: Stage) {
  switch (stage.work) {
    case "initial-first": case "initial-rework": case "cross-first": case "cross-repeat": return judgment;
    case "compare": case "respond": case "reconcile": return comparison;
    case "lead": return lead;
  }
}

const common = readFileSync(new URL("../../../prompts/review/common.md", import.meta.url), "utf8").trim();

export function reviewTurns(state: ReviewFlow) {
  if (state.kind !== "working") return [];
  const { stage, checkpoint } = state;
  const prompt = readFileSync(new URL(`../../../prompts/review/${stage.work}.md`, import.meta.url), "utf8").trim();
  return pending(stage).map(designer => ({
    id: turnId(checkpoint, designer), designer, work: stage.work,
    cleanContext: stage.work === "cross-first" || stage.work === "cross-repeat",
    context: structuredClone({ goals: checkpoint.goals, ...materials(stage, checkpoint, designer) }),
    prompt: `${prompt}\n\n${common}`, schema: schema(stage),
  }));
}

function advance(checkpoint: Checkpoint, stage: Stage): Working {
  return { kind: "working", checkpoint: { ...checkpoint, serial: checkpoint.serial + 1 }, stage };
}

const normalize = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();
const issueKey = ({ issue, factId }: ReviewFinding) => JSON.stringify([normalize(issue), factId]);
const findingKey = (item: ReviewFinding) => JSON.stringify([issueKey(item), normalize(item.detail)]);

function uniqueFindings(items: ReviewFinding[]) {
  const merged = new Map<string, ReviewFinding>();
  for (const item of items) {
    const key = findingKey(item);
    const prior = merged.get(key);
    merged.set(key, prior ? { ...prior, evidence: [...new Set([...prior.evidence, ...item.evidence])] } : item);
  }
  return [...merged.values()];
}

const findingsOf = (reply: Comparison) => reply.kind === "pass" ? [] : reply.findings;
const factKey = (facts: ReviewedFact[]) => JSON.stringify(facts.map(({ id, decision }) => [id, decision]).sort());

function verifyOpinion<T extends Comparison>(opinion: T): T {
  const result = structuredClone(opinion);
  const facts = result.draftFacts ?? [];
  const findings = findingsOf(result);
  if (new Set(facts.map(item => item.id)).size !== facts.length) throw new Error("Each draft fact needs one disposition.");
  if (new Set(findings.map(issueKey)).size !== findings.length) throw new Error("Each Review issue needs one finding.");
  return result;
}

function disputedFactDecisions(a: ReviewedFact[], b: ReviewedFact[]): ReviewFinding[] {
  return [[a, b], [b, a]].flatMap(([proposed, peer]) => proposed.flatMap(({ id, decision, evidence }) => {
    if (peer.find(item => item.id === id)?.decision === decision) return [];
    return [{ issue: `Draft fact ${id}`, detail: `${decision === "keep" ? "Keep" : "Drop"} draft fact ${id}.`, evidence }];
  }));
}

function placeDiscussions(checkpoint: Checkpoint, stage: Pair, replies: Record<Member, Comparison>): ReviewFlow {
  const a = replies["member-a"], b = replies["member-b"];
  const findings = uniqueFindings([...findingsOf(a), ...findingsOf(b)]);
  const protectedFindings = uniqueFindings([...stage.protectedFindings, ...findings.filter(item => item.factId)]);
  const aFacts = a.draftFacts ?? stage.opinions["member-a"].draftFacts ?? [];
  const bFacts = b.draftFacts ?? stage.opinions["member-b"].draftFacts ?? [];
  function decide(basis: Basis) {
    return advance(checkpoint, { work: "lead", basis, opinions: stage.opinions, comparisons: replies, protectedFindings });
  }
  if (a.kind === "pass" && b.kind === "pass") {
    if (factKey(aFacts) === factKey(bFacts)) {
      const peer = new Map(bFacts.map(item => [item.id, item]));
      return decide({ kind: "pass", draftFacts: aFacts.map(item => ({ ...item,
        evidence: [...new Set([...item.evidence, ...(peer.get(item.id)?.evidence ?? [])])] })) });
    }
  }
  if (a.kind === "changes" && b.kind === "changes" &&
    JSON.stringify(a.findings.map(findingKey).sort()) === JSON.stringify(b.findings.map(findingKey).sort())) {
    return decide({ kind: "changes", findings });
  }
  const signatureOf = (reply: Comparison, facts: ReviewedFact[]) => [reply.kind, findingsOf(reply).map(findingKey).sort(), factKey(facts)];
  const signature = JSON.stringify([signatureOf(a, aFacts), signatureOf(b, bFacts)]);
  if (stage.work === "reconcile" && (stage.seen.includes(signature) || stage.seen.length >= 4)) {
    return decide({ kind: "unresolved", findings: uniqueFindings([...findings, ...disputedFactDecisions(aFacts, bFacts)]) });
  }
  return advance(checkpoint, { ...stage, work: stage.work === "respond" ? "reconcile" : "respond", replies: {},
    prior: replies, seen: [...stage.seen, signature], protectedFindings });
}

export function settleReviewTurn(state: ReviewFlow, event: { id: string; settled: boolean; result: unknown }): ReviewFlow {
  if (state.kind !== "working" || !event.settled) return state;
  const { checkpoint, stage } = state;
  const designer = pending(stage).find(role => turnId(checkpoint, role) === event.id);
  if (!designer) return state;
  switch (stage.work) {
    case "initial-first": case "initial-rework": case "cross-first": case "cross-repeat": {
      if (!Value.Check(judgment, event.result)) throw new Error(`Invalid ${stage.work} result.`);
      const result = verifyOpinion(event.result);
      if (stage.work === "cross-first" || stage.work === "cross-repeat") {
        const opinions = { "member-a": stage.initial, "member-b": result };
        return advance({ ...checkpoint, everCrossed: true }, { work: "compare", opinions, replies: {}, seen: [],
          protectedFindings: findingsOf(result).filter(item => item.factId) });
      }
      if (result.kind === "changes") return advance(checkpoint, { work: "lead", basis: { kind: "changes", findings: result.findings },
        protectedFindings: result.findings.filter(item => item.factId) });
      return advance(checkpoint, { work: checkpoint.everCrossed ? "cross-repeat" : "cross-first", initial: result });
    }
    case "compare": case "respond": case "reconcile": {
      if (!Value.Check(comparison, event.result)) throw new Error(`Invalid ${stage.work} result.`);
      const replies = { ...stage.replies, [designer]: verifyOpinion(event.result) };
      const a = replies["member-a"], b = replies["member-b"];
      return a && b ? placeDiscussions(checkpoint, stage, { "member-a": a, "member-b": b }) : { ...state, stage: { ...stage, replies } };
    }
    case "lead": {
      if (!Value.Check(lead, event.result)) throw new Error("Invalid Lead Designer Review result.");
      const result = event.result;
      const { basis, protectedFindings } = stage;
      const mustAsk = !stage.userAnswer && (basis.kind === "unresolved" || protectedFindings.length > 0);
      if (result.kind === "ask-user") return { kind: "needs-user", checkpoint, stage, summary: result.summary, question: result.question,
        findings: uniqueFindings([...(basis.kind === "pass" ? [] : basis.findings), ...protectedFindings]) };
      if (mustAsk) throw new Error("The Lead Designer must ask the user about unresolved or protected facts.");
      if (result.kind === "approve") {
        if (basis.kind !== "pass") throw new Error("Review approval needs both members to agree on this candidate.");
        return { kind: "approved", checkpoint, summary: result.summary, draftFacts: basis.draftFacts };
      }
      const available = uniqueFindings([...(basis.kind === "pass" ? [] : basis.findings), ...protectedFindings]);
      const needsSelection = basis.kind === "unresolved" || basis.kind === "pass";
      if (!available.length || (needsSelection && !result.selected)) throw new Error("Review rework needs an actionable finding.");
      const findings = result.selected?.map(({ issue, detail }) => {
        const selected = available.find(item => item.issue === issue && item.detail === detail);
        if (!selected) throw new Error("Review rework must select a reported finding.");
        return selected;
      }) ?? available;
      if (new Set(findings.map(issueKey)).size !== findings.length) throw new Error("Review rework needs one correction for each issue.");
      return { kind: "rework", checkpoint, summary: result.summary, findings };
    }
  }
}

export function answerReviewUser(state: ReviewFlow, answer: string): ReviewFlow {
  if (state.kind !== "needs-user" || !answer.trim()) throw new Error("No Review decision is waiting for an answer.");
  return advance(state.checkpoint, { ...state.stage, userAnswer: answer.trim() });
}

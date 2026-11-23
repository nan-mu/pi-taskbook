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
const approve = object({ kind: Type.Literal("approve"), summary: text });
const selectedFindings = Type.Array(object({ issue: text, detail: text }), { minItems: 1 });
const rework = object({ kind: Type.Literal("rework"), summary: text, selected: Type.Optional(selectedFindings) });
const selectiveRework = object({ kind: Type.Literal("rework"), summary: text, selected: selectedFindings });
const askUser = object({ kind: Type.Literal("ask-user"), summary: text, question: text });
const summaryShape = Type.Object({ kind: text, summary: text });

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
type Progress = Input & { epoch: number; serial: number; everCrossed: boolean; priorFindings: ReviewFinding[]; previousRevision?: string };
type Discussion = { opinions: Opinions; replies: Replies; protectedFindings: ReviewFinding[]; seen: string[] };
type Basis =
  | { kind: "pass"; draftFacts: ReviewedFact[] }
  | { kind: "changes"; findings: ReviewFinding[]; selectFindings?: true }
  | { kind: "unresolved"; findings: ReviewFinding[] };
type Initial = { work: "initial-first" | "initial-rework" };
type Cross = { work: "cross-first" | "cross-repeat"; initial: Static<typeof independentPass> };
type Pair = Discussion & { work: "compare" | "respond" | "reconcile"; prior?: Record<Member, Comparison> };
type Lead = {
  work: "lead"; basis: Basis; protectedFindings: ReviewFinding[];
  opinions?: Opinions; comparisons?: Record<Member, Comparison>; userAnswer?: string;
};
type Stage = Initial | Cross | Pair | Lead;
type Working = { kind: "working"; progress: Progress; stage: Stage };
export type ReviewFlow = Working |
  { kind: "approved"; progress: Progress; summary: string; draftFacts: ReviewedFact[] } |
  { kind: "rework"; progress: Progress; summary: string; findings: ReviewFinding[] } |
  { kind: "needs-user"; progress: Progress; summary: string; question: string; findings: ReviewFinding[]; stage: Lead };

export function startReviewFlow(input: Input & { previous?: ReviewFlow }): ReviewFlow {
  const { previous } = input;
  const old = previous?.progress;
  if (old && old.runId !== input.runId) throw new Error("Cannot reuse Review from another run.");
  const goals = input.goals.map(({ id, text }) => ({ id, text }));
  if (previous && old?.candidate.revision === input.candidate.revision && old.candidate.evidenceVersion === input.candidate.evidenceVersion &&
    JSON.stringify(old.goals) === JSON.stringify(goals)) return previous;
  const progress: Progress = { runId: input.runId, goals, candidate: { ...input.candidate }, epoch: old ? old.epoch + 1 : 1,
    serial: 1, everCrossed: old?.everCrossed ?? false, priorFindings: previous?.kind === "rework" ? previous.findings : old?.priorFindings ?? [],
    previousRevision: old?.candidate.revision === input.candidate.revision ? old.previousRevision : old?.candidate.revision };
  return { kind: "working", progress, stage: { work: old ? "initial-rework" : "initial-first" } };
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

function turnId(progress: Progress, designer: Designer) {
  return `${progress.runId}:review:${progress.epoch}:${progress.serial}:${designer}`;
}

function materials(stage: Stage, progress: Progress, designer: Designer) {
  switch (stage.work) {
    case "initial-first": case "cross-first": return {};
    case "initial-rework": case "cross-repeat": return { priorFindings: progress.priorFindings.map(({ issue, detail }) => ({ issue, detail })) };
    case "compare": return { opinions: stage.opinions };
    case "respond": case "reconcile": return { opinions: stage.opinions, previous: stage.prior, reviewer: designer };
    case "lead": return { basis: stage.basis, opinions: stage.opinions, comparisons: stage.comparisons,
      protectedFindings: stage.protectedFindings, userAnswer: stage.userAnswer };
  }
}

function leadSchema(stage: Lead) {
  const {basis, protectedFindings, userAnswer} = stage;
  if (!userAnswer && (basis.kind === "unresolved" || protectedFindings.length)) return askUser;
  if (basis.kind === "changes") return Type.Union([basis.selectFindings ? selectiveRework : rework, askUser]);
  if (basis.kind === "unresolved") return Type.Union([selectiveRework, askUser]);
  return protectedFindings.length ? Type.Union([approve, selectiveRework, askUser]) : Type.Union([approve, askUser]);
}

function schema(stage: Stage) {
  switch (stage.work) {
    case "initial-first": case "initial-rework": case "cross-first": case "cross-repeat": return judgment;
    case "compare": case "respond": case "reconcile": return comparison;
    case "lead": return leadSchema(stage);
  }
}

const common = readFileSync(new URL("../../../prompts/review/common.md", import.meta.url), "utf8").trim();

export function reviewTurns(state: ReviewFlow) {
  if (state.kind !== "working") return [];
  const { stage, progress } = state;
  const prompt = readFileSync(new URL(`../../../prompts/review/${stage.work}.md`, import.meta.url), "utf8").trim();
  return pending(stage).map(designer => ({
    id: turnId(progress, designer), designer, work: stage.work,
    context: structuredClone({ goals: progress.goals, previousReviewedRevision: progress.previousRevision,
      ...materials(stage, progress, designer) }),
    prompt: `${prompt}\n\n${common}`, schema: schema(stage),
    summarizeResult(result: unknown) {
      if (Value.Check(askUser, result)) return result.kind + " · " + result.question;
      if (Value.Check(summaryShape, result)) return result.kind + " · " + result.summary;
    },
  }));
}

function advance(progress: Progress, stage: Stage): Working {
  return { kind: "working", progress: { ...progress, serial: progress.serial + 1 }, stage };
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

function placeDiscussions(progress: Progress, stage: Pair, replies: Record<Member, Comparison>): ReviewFlow {
  const a = replies["member-a"], b = replies["member-b"];
  const findings = uniqueFindings([...findingsOf(a), ...findingsOf(b)]);
  const protectedFindings = uniqueFindings([...stage.protectedFindings, ...findings.filter(item => item.factId)]);
  const aFacts = a.draftFacts ?? stage.opinions["member-a"].draftFacts ?? [];
  const bFacts = b.draftFacts ?? stage.opinions["member-b"].draftFacts ?? [];
  function decide(basis: Basis) {
    return advance(progress, { work: "lead", basis, opinions: stage.opinions, comparisons: replies, protectedFindings });
  }
  if (a.kind === "pass" && b.kind === "pass") {
    if (factKey(aFacts) === factKey(bFacts)) {
      const peer = new Map(bFacts.map(item => [item.id, item]));
      return decide({ kind: "pass", draftFacts: aFacts.map(item => ({ ...item,
        evidence: [...new Set([...item.evidence, ...(peer.get(item.id)?.evidence ?? [])])] })) });
    }
  }
  if (a.kind === "changes" && b.kind === "changes") {
    return decide({ kind: "changes", findings, selectFindings: true });
  }
  const signatureOf = (reply: Comparison, facts: ReviewedFact[]) => [reply.kind, findingsOf(reply).map(findingKey).sort(), factKey(facts)];
  const signature = JSON.stringify([signatureOf(a, aFacts), signatureOf(b, bFacts)]);
  if (stage.work === "reconcile" && (stage.seen.includes(signature) || stage.seen.length >= 4)) {
    return decide({ kind: "unresolved", findings: uniqueFindings([...findings, ...disputedFactDecisions(aFacts, bFacts)]) });
  }
  return advance(progress, { ...stage, work: stage.work === "respond" ? "reconcile" : "respond", replies: {},
    prior: replies, seen: [...stage.seen, signature], protectedFindings });
}

export function settleReviewTurn(state: ReviewFlow, event: { id: string; settled: boolean; result: unknown }): ReviewFlow {
  if (state.kind !== "working" || !event.settled) return state;
  const { progress, stage } = state;
  const designer = pending(stage).find(role => turnId(progress, role) === event.id);
  if (!designer) return state;
  switch (stage.work) {
    case "initial-first": case "initial-rework": case "cross-first": case "cross-repeat": {
      if (!Value.Check(judgment, event.result)) throw new Error(`Invalid ${stage.work} result.`);
      const result = verifyOpinion(event.result);
      if (stage.work === "cross-first" || stage.work === "cross-repeat") {
        const opinions = { "member-a": stage.initial, "member-b": result };
        return advance({ ...progress, everCrossed: true }, { work: "compare", opinions, replies: {}, seen: [],
          protectedFindings: findingsOf(result).filter(item => item.factId) });
      }
      if (result.kind === "changes") return advance(progress, { work: "lead", basis: { kind: "changes", findings: result.findings },
        protectedFindings: result.findings.filter(item => item.factId) });
      return advance(progress, { work: progress.everCrossed ? "cross-repeat" : "cross-first", initial: result });
    }
    case "compare": case "respond": case "reconcile": {
      if (!Value.Check(comparison, event.result)) throw new Error(`Invalid ${stage.work} result.`);
      const replies = { ...stage.replies, [designer]: verifyOpinion(event.result) };
      const a = replies["member-a"], b = replies["member-b"];
      return a && b ? placeDiscussions(progress, stage, { "member-a": a, "member-b": b }) : { ...state, stage: { ...stage, replies } };
    }
    case "lead": {
      if (!Value.Check(leadSchema(stage), event.result)) throw new Error("Choose a Lead decision offered for the current Review evidence.");
      const result = event.result;
      const { basis, protectedFindings } = stage;
      if (result.kind === "ask-user") return { kind: "needs-user", progress, stage, summary: result.summary, question: result.question,
        findings: uniqueFindings([...(basis.kind === "pass" ? [] : basis.findings), ...protectedFindings]) };
      if (result.kind === "approve") {
        if (basis.kind !== "pass") throw new Error("Review approval needs both members to agree on this candidate.");
        return { kind: "approved", progress, summary: result.summary, draftFacts: basis.draftFacts };
      }
      const available = uniqueFindings([...(basis.kind === "pass" ? [] : basis.findings), ...protectedFindings]);
      const needsSelection = basis.kind !== "changes" || basis.selectFindings;
      if (!available.length || (needsSelection && !result.selected)) throw new Error("Review rework needs an actionable finding.");
      const findings = result.selected?.map(({ issue, detail }) => {
        const selected = available.find(item => item.issue === issue && item.detail === detail);
        if (!selected) throw new Error("Review rework must select a reported finding.");
        return selected;
      }) ?? available;
      if (new Set(findings.map(issueKey)).size !== findings.length) throw new Error("Review rework needs one correction for each issue.");
      return { kind: "rework", progress, summary: result.summary, findings };
    }
  }
}

export function answerReviewUser(state: ReviewFlow, answer: string): ReviewFlow {
  if (state.kind !== "needs-user" || !answer.trim()) throw new Error("No Review decision is waiting for an answer.");
  return advance(state.progress, { ...state.stage, userAnswer: answer.trim() });
}

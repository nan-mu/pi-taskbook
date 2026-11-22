import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { acceptPlan, type ExecutionPlan } from "../design-worker.ts";
import { answers, askConsult, designers, needsUser, type Change, type CompletedReply, type Consultation,
  type Designer, type Draft, type Reply, type Response, type RoundWork, type Work } from "./protocol-v0.1.ts";

export const designerVersion = "0.1";
export type DesignInput = {runId: string; taskbook: string; baseline: string; factsVersion: string; facts: readonly string[]; observations?: readonly import("../../facts/fact-check.ts").CheckedFact[]; userAnswers?: readonly {question: string; answer: string}[]; targetIds: readonly string[]};
type DraftEntry = {designer: Designer; version: string; draft: Draft};
type Issue = {
  id: string; author: Designer; proposer: Designer; version: string; original: Change; proposal: Change;
  replies: {designer: Designer; response: Response}[];
};
type Candidate = {version: string; draft: Draft; plan: ExecutionPlan};
type WorkInput = {drafts: DraftEntry[]} | {issues: Issue[]} | {drafts: DraftEntry[]; resolved: Issue[]; previous?: Candidate} |
  {candidate: Candidate; resolved: Issue[]} | null;
type RoundJob = {id: string; designer: Designer; work: RoundWork; input: WorkInput};
type ConsultJob = {id: string; designer: Designer; work: "consult"; question: string; evidence: string; returnTo: RoundJob};
type Job = RoundJob | ConsultJob;
type Slot = {job: Job; reply?: CompletedReply};
type Checkpoint = {
  protocol: typeof designerVersion; input: DesignInput; round: number; serial: number; drafts: DraftEntry[];
  issues: Issue[]; resolved: Issue[]; seenProposals: string[]; candidate?: Candidate;
  consultations: {designer: Designer; question: string; result: Consultation}[];
};
type Working = {kind: "working"; work: RoundWork; checkpoint: Checkpoint; slots: Slot[]};
export type DesignerState = Working |
  {kind: "paused"; previous: Working; question: string; evidence: string; factId?: string} |
  {kind: "approved"; checkpoint: Checkpoint; candidate: Candidate};

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function begin(checkpoint: Checkpoint, work: RoundWork, turns: {designer: Designer; input: WorkInput}[]): Working {
  const round = checkpoint.round + 1;
  const slots = turns.map(({designer, input}, index) => ({job: {
    id: `${checkpoint.input.runId}:${round}:${designer}:${checkpoint.serial + index + 1}`, designer, work, input,
  }}));
  return {kind: "working", work, slots, checkpoint: {...checkpoint, round, serial: checkpoint.serial + slots.length}};
}

export function startDesigner(input: DesignInput): DesignerState {
  return begin({protocol: designerVersion, input: structuredClone(input), round: 0, serial: 0, drafts: [], issues: [], resolved: [],
    seenProposals: [], consultations: []}, "draft", designers.map(designer => ({designer, input: null})));
}

function responseSchema(work: Work) {
  return work === "consult" ? Type.Union([answers.consult, needsUser]) : Type.Union([answers[work], askConsult, needsUser]);
}

export function designerTurns(state: DesignerState) {
  if (state.kind !== "working") return [];
  const {input, consultations, round} = state.checkpoint;
  return state.slots.filter(slot => !slot.reply).map(({job}) => {
    const materials = job.work === "consult" ? {question: job.question, evidence: job.evidence, work: job.returnTo.input} : job.input;
    return {
      id: job.id, designer: job.designer, work: job.work,
      context: structuredClone({protocol: designerVersion, round, ...input, materials,
        consultations: consultations.filter(item => item.designer === job.designer)}),
      prompt: readFileSync(new URL(`../../../prompts/designer/${designerVersion}/${job.work}.md`, import.meta.url), "utf8").trim(),
      schema: responseSchema(job.work),
    };
  });
}

function submitted<K extends CompletedReply["kind"]>(slots: Slot[], kind: K) {
  type Result = Extract<CompletedReply, {kind: K}>;
  const matches = (reply: CompletedReply | undefined): reply is Result => reply?.kind === kind;
  return slots.flatMap(({job, reply}) => matches(reply) ? [{designer: job.designer, reply}] : []);
}

function sameIds(actual: string[], expected: string[]) {
  return actual.length === expected.length && new Set(actual).size === actual.length && expected.every(id => actual.includes(id));
}

function validateReply(state: Working, job: RoundJob, reply: CompletedReply) {
  const {issues, resolved, candidate} = state.checkpoint;
  if (reply.kind === "compare" && !sameIds(reply.reviews.map(item => item.designer), designers.filter(id => id !== job.designer))) {
    throw new Error("Compare needs one result for each peer draft.");
  }
  if (reply.kind === "respond" || reply.kind === "reconcile") {
    const assigned = issues.filter(issue => reply.kind === "respond" ? issue.author === job.designer : issue.author !== job.designer);
    if (!sameIds(reply.responses.map(item => item.issue), assigned.map(issue => issue.id))) {
      throw new Error("Each assigned issue needs exactly one response.");
    }
    if (reply.kind === "respond" && reply.responses.some(item => item.decision === "accept" &&
      assigned.find(issue => issue.id === item.issue)?.replies.some(peer => peer.response.decision === "counter"))) {
      throw new Error("A proposal with a peer objection needs a counter or a user decision.");
    }
  }
  if (reply.kind === "synthesize") {
    if (!sameIds(reply.appliedIssues, resolved.map(issue => issue.id))) throw new Error("The final design needs to account for all resolved issues.");
    acceptPlan(reply.plan.steps, [...state.checkpoint.input.targetIds]);
  }
  if ((reply.kind === "approved" || reply.kind === "objected") && reply.version !== candidate?.version) {
    throw new Error("Confirmation needs the current candidate version.");
  }
}

export function settleDesignerTurn(state: DesignerState, event: {id: string; settled: boolean; result: unknown}): DesignerState {
  if (state.kind !== "working" || !event.settled) return state;
  const slot = state.slots.find(item => item.job.id === event.id && !item.reply);
  if (!slot) return state;
  const schema = responseSchema(slot.job.work);
  if (!Value.Check(schema, event.result)) throw new Error(`Invalid Designer ${slot.job.work} result.`);
  const result: Reply = structuredClone(event.result);
  if (result.kind === "needs-user") return {kind: "paused", previous: state, question: result.question,
    evidence: result.evidence, factId: result.factId};
  if (result.kind === "consult" && slot.job.work !== "consult") {
    return replaceJob(state, slot, {question: result.question, evidence: result.evidence,
      work: "consult", designer: slot.job.designer, returnTo: slot.job});
  }
  if (result.kind === "answered" && slot.job.work === "consult") {
    const consultations = [...state.checkpoint.consultations, {designer: slot.job.designer, question: slot.job.question, result}];
    return replaceJob({...state, checkpoint: {...state.checkpoint, consultations}}, slot, slot.job.returnTo);
  }
  if (result.kind === "consult" || result.kind === "answered" || slot.job.work === "consult") throw new Error("Invalid Consult transition.");
  validateReply(state, slot.job, result);
  const slots = state.slots.map(item => item === slot ? {...slot, reply: result} : item);
  const next = {...state, slots};
  return slots.every(item => item.reply) ? advance(next) : next;
}

function replaceJob(state: Working, slot: Slot, job: Omit<ConsultJob, "id"> | RoundJob): Working {
  const {checkpoint} = state;
  const serial = checkpoint.serial + 1;
  const id = `${checkpoint.input.runId}:${checkpoint.round}:${job.designer}:${serial}`;
  return {...state, checkpoint: {...checkpoint, serial}, slots: state.slots.map(item => item === slot ? {job: {...job, id}} : item)};
}

function makeIssue(id: string, author: Designer, proposer: Designer, version: string, change: Change): Issue {
  return {id, author, proposer, version, original: change, proposal: change, replies: []};
}

function assignIssues(checkpoint: Checkpoint, work: "respond" | "reconcile") {
  const turns = designers.flatMap(designer => {
    const issues = checkpoint.issues.filter(issue => work === "respond" ? issue.author === designer : issue.author !== designer);
    return issues.length ? [{designer, input: {issues}}] : [];
  });
  return begin(checkpoint, work, turns);
}

function synthesize(checkpoint: Checkpoint) {
  return begin(checkpoint, "synthesize", [{designer: "lead",
    input: {drafts: checkpoint.drafts, resolved: checkpoint.resolved, previous: checkpoint.candidate}}]);
}

function pauseRepeated(state: Working, issues: Issue[]): DesignerState {
  return {kind: "paused", previous: state, question: "Resolve the outstanding design proposals.", evidence: JSON.stringify(issues)};
}

function advance(state: Working): DesignerState {
  const checkpoint = state.checkpoint;
  switch (state.work) {
    case "draft": {
      const drafts = submitted(state.slots, "draft").map(({designer, reply}) => ({designer, draft: reply.draft, version: digest(reply.draft)}));
      return begin({...checkpoint, drafts}, "compare", designers.map(designer => ({designer, input: {drafts}})));
    }
    case "compare": {
      const issues = submitted(state.slots, "compare").flatMap(({designer, reply}) => reply.reviews.flatMap(review => {
        const target = checkpoint.drafts.find(item => item.designer === review.designer)!;
        return review.changes.map((change, index) => makeIssue(`${checkpoint.round}:${designer}:${target.designer}:${index + 1}`,
          target.designer, designer, target.version, change));
      }));
      return issues.length ? assignIssues({...checkpoint, issues}, "respond") : synthesize(checkpoint);
    }
    case "respond": {
      const responses = new Map<string, Response>();
      for (const {reply} of submitted(state.slots, "respond")) {
        for (const response of reply.responses) responses.set(response.issue, response);
      }
      const accepted: Issue[] = [];
      const issues: Issue[] = [];
      for (const issue of checkpoint.issues) {
        const response = responses.get(issue.id)!;
        if (response.decision === "accept") accepted.push(issue);
        else issues.push({...issue, proposal: {...issue.proposal, proposal: response.proposal, reason: response.reason}, replies: []});
      }
      const next = {...checkpoint, resolved: [...checkpoint.resolved, ...accepted], issues};
      if (!issues.length) return synthesize(next);
      const key = digest(issues.map(issue => [issue.id, normalizeProposal(issue.proposal.proposal)]).sort());
      if (checkpoint.seenProposals.includes(key)) return pauseRepeated({...state, checkpoint: next}, issues);
      return assignIssues({...next, seenProposals: [...checkpoint.seenProposals, key]}, "reconcile");
    }
    case "reconcile": {
      const replies = submitted(state.slots, "reconcile");
      const issues = checkpoint.issues.map(issue => ({...issue, replies: replies.flatMap(({designer, reply}) =>
        reply.responses.filter(response => response.issue === issue.id).map(response => ({designer, response})))}));
      return assignIssues({...checkpoint, issues}, "respond");
    }
    case "synthesize": {
      const {reply} = submitted(state.slots, "synthesize")[0];
      const plan = acceptPlan(reply.plan.steps, [...checkpoint.input.targetIds], checkpoint.candidate?.plan.version);
      const candidate = {draft: reply.draft, plan, version: digest({draft: reply.draft, plan, factsVersion: checkpoint.input.factsVersion})};
      return begin({...checkpoint, candidate}, "confirm", designers.slice(1).map(designer => ({designer, input: {candidate, resolved: checkpoint.resolved}})));
    }
    case "confirm": {
      const candidate = checkpoint.candidate!;
      const issues = submitted(state.slots, "objected").flatMap(({designer, reply}) => reply.changes.map((change, index) =>
        makeIssue(`${checkpoint.round}:${designer}:lead:${index + 1}`, "lead", designer, candidate.version, change)));
      if (!issues.length) return {kind: "approved", checkpoint, candidate};
      const key = digest([candidate.draft, candidate.plan.steps, issues.map(issue => [issue.proposer, issue.original.section,
        normalizeProposal(issue.original.target), normalizeProposal(issue.original.proposal)]).sort()]);
      if (checkpoint.seenProposals.includes(key)) return pauseRepeated(state, issues);
      return assignIssues({...checkpoint, issues, seenProposals: [...checkpoint.seenProposals, key]}, "respond");
    }
  }
}

function normalizeProposal(text: string) { return text.normalize("NFKC").trim().replace(/\s+/gu, " "); }

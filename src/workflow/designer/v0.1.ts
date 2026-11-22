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
type ConfirmationChanges = {goal: boolean; facts: boolean; steps: string[]; order: boolean};
type WorkInput = {drafts: DraftEntry[]} | {issues: Issue[]} | {drafts: DraftEntry[]; resolved: Issue[]; previous?: Candidate} |
  {candidate: Candidate; resolved: Issue[]; changesSincePrevious?: ConfirmationChanges} | null;
type RoundJob = {id: string; designer: Designer; work: RoundWork; input: WorkInput};
type ConsultJob = {id: string; designer: Designer; work: "consult"; question: string; evidence: string; returnTo: RoundJob};
type Job = RoundJob | ConsultJob;
type Slot = {job: Job; reply?: CompletedReply};
type Progress = {
  protocol: typeof designerVersion; input: DesignInput; round: number; serial: number; drafts: DraftEntry[];
  issues: Issue[]; resolved: Issue[]; seenProposals: string[]; candidate?: Candidate;
  consultations: {designer: Designer; question: string; result: Consultation}[];
};
type Working = {kind: "working"; work: RoundWork; progress: Progress; slots: Slot[]};
export type DesignerState = Working |
  {kind: "paused"; previous: Working; question: string; evidence: string; factId?: string} |
  {kind: "approved"; progress: Progress; candidate: Candidate};

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function begin(progress: Progress, work: RoundWork, turns: {designer: Designer; input: WorkInput}[]): Working {
  const round = progress.round + 1;
  const slots = turns.map(({designer, input}, index) => ({job: {
    id: `${progress.input.runId}:${round}:${designer}:${progress.serial + index + 1}`, designer, work, input,
  }}));
  return {kind: "working", work, slots, progress: {...progress, round, serial: progress.serial + slots.length}};
}

export function startDesigner(input: DesignInput): DesignerState {
  return begin({protocol: designerVersion, input: structuredClone(input), round: 0, serial: 0, drafts: [], issues: [], resolved: [],
    seenProposals: [], consultations: []}, "draft", designers.map(designer => ({designer, input: null})));
}

function responseSchema(work: Work) {
  return work === "consult" ? Type.Union([answers.consult, needsUser]) : Type.Union([answers[work], askConsult, needsUser]);
}

export function designContext(input: DesignInput) {
  const {observations, ...assignment} = input;
  return {...assignment, observations: observations?.map(({claim, origin}, index) => ({id: "observation:P" + (index + 1), claim, origin}))};
}

export function designerTurns(state: DesignerState) {
  if (state.kind !== "working") return [];
  const {input, consultations, round} = state.progress;
  const assignment = designContext(input);
  return state.slots.filter(slot => !slot.reply).map(({job}) => {
    const current = job.work === "consult" ? job.returnTo.input : job.input;
    const focused = current && "resolved" in current ? {
      ...current, ...("previous" in current && current.previous ? {drafts: []} : {}),
      resolved: current.resolved.map(({id, proposal}) => ({id, proposal})),
    } : current;
    const materials = job.work === "consult" ? {question: job.question, evidence: job.evidence, work: focused} : focused;
    return {
      id: job.id, designer: job.designer, work: job.work,
      context: structuredClone({protocol: designerVersion, round, ...assignment, materials,
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
  const {issues, resolved, candidate} = state.progress;
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
    acceptPlan(reply.plan.steps, [...state.progress.input.targetIds]);
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
    const consultations = [...state.progress.consultations, {designer: slot.job.designer, question: slot.job.question, result}];
    return replaceJob({...state, progress: {...state.progress, consultations}}, slot, slot.job.returnTo);
  }
  if (result.kind === "consult" || result.kind === "answered" || slot.job.work === "consult") throw new Error("Invalid Consult transition.");
  validateReply(state, slot.job, result);
  const slots = state.slots.map(item => item === slot ? {...slot, reply: result} : item);
  const next = {...state, slots};
  return slots.every(item => item.reply) ? advance(next) : next;
}

function replaceJob(state: Working, slot: Slot, job: Omit<ConsultJob, "id"> | RoundJob): Working {
  const {progress} = state;
  const serial = progress.serial + 1;
  const id = `${progress.input.runId}:${progress.round}:${job.designer}:${serial}`;
  return {...state, progress: {...progress, serial}, slots: state.slots.map(item => item === slot ? {job: {...job, id}} : item)};
}

function makeIssue(id: string, author: Designer, proposer: Designer, version: string, change: Change): Issue {
  return {id, author, proposer, version, original: change, proposal: change, replies: []};
}

function assignIssues(progress: Progress, work: "respond" | "reconcile") {
  const turns = designers.flatMap(designer => {
    const issues = progress.issues.filter(issue => work === "respond" ? issue.author === designer : issue.author !== designer);
    return issues.length ? [{designer, input: {issues}}] : [];
  });
  return begin(progress, work, turns);
}

function synthesize(progress: Progress) {
  return begin(progress, "synthesize", [{designer: "lead",
    input: {drafts: progress.candidate ? [] : progress.drafts, resolved: progress.resolved, previous: progress.candidate}}]);
}

function confirmationChanges(previous: Candidate, current: Candidate): ConfirmationChanges {
  const oldSteps = new Map(previous.plan.steps.map(step => [step.id, step]));
  const newSteps = new Map(current.plan.steps.map(step => [step.id, step]));
  return {
    goal: previous.draft.goal !== current.draft.goal,
    facts: JSON.stringify(previous.draft.facts) !== JSON.stringify(current.draft.facts),
    steps: [...new Set([...oldSteps.keys(), ...newSteps.keys()])]
      .filter(id => JSON.stringify(oldSteps.get(id)) !== JSON.stringify(newSteps.get(id))),
    order: JSON.stringify([...oldSteps.keys()]) !== JSON.stringify([...newSteps.keys()]),
  };
}

function pauseRepeated(state: Working, issues: Issue[]): DesignerState {
  return {kind: "paused", previous: state, question: "Resolve the outstanding design proposals.", evidence: JSON.stringify(issues)};
}

function advance(state: Working): DesignerState {
  const progress = state.progress;
  switch (state.work) {
    case "draft": {
      const drafts = submitted(state.slots, "draft").map(({designer, reply}) => ({designer, draft: reply.draft, version: digest(reply.draft)}));
      return begin({...progress, drafts}, "compare", designers.map(designer => ({designer, input: {drafts}})));
    }
    case "compare": {
      const issues = submitted(state.slots, "compare").flatMap(({designer, reply}) => reply.reviews.flatMap(review => {
        const target = progress.drafts.find(item => item.designer === review.designer)!;
        return review.changes.map((change, index) => makeIssue(`${progress.round}:${designer}:${target.designer}:${index + 1}`,
          target.designer, designer, target.version, change));
      }));
      return issues.length ? assignIssues({...progress, issues}, "respond") : synthesize(progress);
    }
    case "respond": {
      const responses = new Map<string, Response>();
      for (const {reply} of submitted(state.slots, "respond")) {
        for (const response of reply.responses) responses.set(response.issue, response);
      }
      const accepted: Issue[] = [];
      const issues: Issue[] = [];
      for (const issue of progress.issues) {
        const response = responses.get(issue.id)!;
        if (response.decision === "accept") accepted.push(issue);
        else issues.push({...issue, proposal: {...issue.proposal, proposal: response.proposal, reason: response.reason}, replies: []});
      }
      const next = {...progress, resolved: [...progress.resolved, ...accepted], issues};
      if (!issues.length) return synthesize(next);
      const key = digest(issues.map(issue => [issue.id, normalizeProposal(issue.proposal.proposal)]).sort());
      if (progress.seenProposals.includes(key)) return pauseRepeated({...state, progress: next}, issues);
      return assignIssues({...next, seenProposals: [...progress.seenProposals, key]}, "reconcile");
    }
    case "reconcile": {
      const replies = submitted(state.slots, "reconcile");
      const issues = progress.issues.map(issue => ({...issue, replies: replies.flatMap(({designer, reply}) =>
        reply.responses.filter(response => response.issue === issue.id).map(response => ({designer, response})))}));
      return assignIssues({...progress, issues}, "respond");
    }
    case "synthesize": {
      const {reply} = submitted(state.slots, "synthesize")[0];
      const plan = acceptPlan(reply.plan.steps, [...progress.input.targetIds], progress.candidate?.plan.version);
      const candidate = {draft: reply.draft, plan, version: digest({draft: reply.draft, plan, factsVersion: progress.input.factsVersion})};
      const changesSincePrevious = progress.candidate ? confirmationChanges(progress.candidate, candidate) : undefined;
      return begin({...progress, candidate}, "confirm", designers.slice(1).map(designer => ({
        designer, input: {candidate, resolved: progress.resolved, changesSincePrevious},
      })));
    }
    case "confirm": {
      const candidate = progress.candidate!;
      const issues = submitted(state.slots, "objected").flatMap(({designer, reply}) => reply.changes.map((change, index) =>
        makeIssue(`${progress.round}:${designer}:lead:${index + 1}`, "lead", designer, candidate.version, change)));
      if (!issues.length) return {kind: "approved", progress, candidate};
      const key = digest([candidate.draft, candidate.plan.steps, issues.map(issue => [issue.proposer, issue.original.section,
        normalizeProposal(issue.original.target), normalizeProposal(issue.original.proposal)]).sort()]);
      if (progress.seenProposals.includes(key)) return pauseRepeated(state, issues);
      return assignIssues({...progress, issues, seenProposals: [...progress.seenProposals, key]}, "respond");
    }
  }
}

function normalizeProposal(text: string) { return text.normalize("NFKC").trim().replace(/\s+/gu, " "); }

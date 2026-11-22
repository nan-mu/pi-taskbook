import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { investigationPrompt, investigationRequest, investigationResult, investigations, readTransition, transition, type Investigation } from "../playbook.ts";
import { answers, designers, needsUser, type Change, type Designer } from "./protocol-v0.1.ts";
import { designContext, designerTurns as draftTurns, settleDesignerTurn as settleDraft, startDesigner as startDraft, redraftDesign,
  type DesignInput, type DesignerState as DraftState } from "./v0.1.ts";

export const designerVersion = "0.2";
export type { DesignInput };

type Drafting = Extract<DraftState, {kind: "working"}>;
type DraftApproval = Extract<DraftState, {kind: "approved"}>;
type DraftPause = Extract<DraftState, {kind: "paused"}>;
type Progress = Drafting["progress"];
type Direction = {author: "lead" | "user"; text: string; question?: string; evidence?: string; factId?: string; designer?: Designer};
type Escalation = {designer: Designer; question: string; evidence: string; factId?: string};
type Decision = {kind: "signoff"; approved: DraftApproval} |
  {kind: "escalation"; previous: Drafting; issue: Escalation} |
  {kind: "disagreement"; previous: Drafting; issue: Escalation};

type DraftWork = Drafting & {authority: Direction[]};
type LeadWork = {kind: "working"; work: "lead-decision"; progress: Progress; id: string; decision: Decision; authority: Direction[]};
type DesignWork = DraftWork | LeadWork;
type Selection = {kind: "working"; work: "select-state"; progress: Progress; id: string; completed: string; target: DesignWork; authority: Direction[]};
type Research = {kind: "working"; work: Investigation; progress: Progress; id: string; question: string; selection: Selection; authority: Direction[]};
type Paused = {kind: "paused"; previous: LeadWork | Selection; question: string; evidence: string; factId?: string};
type Approved = DraftApproval & {authority: Direction[]; signedBy: "lead"};
export type DesignerState = (DesignWork | Selection | Research | Paused | Approved) & {protocol: typeof designerVersion};

const text = Type.String({minLength: 1, pattern: "\\S"});
const approve = Type.Object({kind: Type.Literal("approved"), version: text}, {additionalProperties: false});
const change = answers.compare.properties.reviews.items.properties.changes.items;
const revise = Type.Object({kind: Type.Literal("revise"), changes: Type.Array(change, {minItems: 1})}, {additionalProperties: false});
const resume = Type.Object({kind: Type.Literal("resume"), instructions: text}, {additionalProperties: false});
const decisionPrompt = readFileSync(new URL("../../../prompts/designer/0.2/lead-decision.md", import.meta.url), "utf8").trim();
const selectPrompt = readFileSync(new URL("../../../prompts/designer/0.2/select-state.md", import.meta.url), "utf8").trim();
const memberAuthority = readFileSync(new URL("../../../prompts/designer/0.2/member-authority.md", import.meta.url), "utf8").trim();

function leadSchema(decision: Decision) {
  const ask = transition("needs-user", needsUser);
  if (decision.kind === "signoff") return Type.Union([transition("implement", approve), transition("respond", revise), ask]);
  if (decision.kind === "escalation" && !decision.issue.factId) {
    return Type.Union([transition(decision.previous.work, resume), ask]);
  }
  return ask;
}

function selectState(target: DesignWork, completed: string, authority: Direction[] = target.authority,
  afterSerial = target.progress.serial): Selection & {protocol: typeof designerVersion} {
  const progress = {...target.progress, serial: afterSerial + 1};
  return {kind: "working", work: "select-state", id: `${progress.input.runId}:select-state:${progress.serial}`,
    protocol: designerVersion, progress, completed, target, authority};
}

const redraft = Type.Object({kind: Type.Literal("redraft"), reason: Type.String({minLength: 1, maxLength: 600})}, {additionalProperties: false});
const proceed = Type.Object({kind: Type.Literal("proceed"), reason: Type.String({minLength: 1, maxLength: 600})}, {additionalProperties: false});

function selectionSchema(state: Selection) {
  const {target} = state;
  return Type.Union([
    transition(target.work, proceed),
    ...investigations.map(work => transition(work, investigationRequest)),
    ...(target.work !== "draft" && target.work !== "lead-decision" ? [transition("draft", redraft)] : []),
    transition("needs-user", needsUser),
  ]);
}

function researchSchema(state: Research) {
  return Type.Union([transition(state.selection.target.work, investigationResult), transition("select-state", investigationResult)]);
}

function activate(target: DesignWork, progress: Progress, authority: Direction[]): DesignerState {
  return {...target, progress, authority, protocol: designerVersion};
}

function leadDecision(decision: Decision, authority: Direction[]): LeadWork & Pick<DesignerState, "protocol"> {
  const previous = decision.kind === "signoff" ? decision.approved : decision.previous;
  const progress = {...previous.progress, serial: previous.progress.serial + 1};
  return {kind: "working", work: "lead-decision", protocol: designerVersion, progress, id: `${progress.input.runId}:lead-decision:${progress.serial}`,
    decision, authority};
}

export function startDesigner(input: DesignInput): DesignerState {
  const state = startDraft(input);
  if (state.kind !== "working") throw new Error("Designer could not start Draft.");
  return selectState({...state, authority: []}, "start");
}

export function designerTurns(state: DesignerState) {
  if (state.kind !== "working") return [];
  if (state.work === "select-state") {
    const {progress, target} = state;
    return [{id: state.id, designer: "lead" as const, work: state.work, prompt: selectPrompt, schema: selectionSchema(state),
      context: {round: progress.round, completed: state.completed, availableRound: target.work,
        goals: progress.input.targetIds, taskbook: progress.input.taskbook,
        drafts: progress.drafts.map(({designer, draft}) => ({designer, goal: draft.goal.slice(0, 1600)})),
        issues: progress.issues.slice(0, 8).map(({id, proposal}) => ({id, ...proposal})),
        outstandingIssues: progress.issues.length, resolvedIssues: progress.resolved.length,
        candidate: progress.candidate && {version: progress.candidate.version, goal: progress.candidate.draft.goal},
        authority: state.authority.slice(-6)}}];
  }
  if (state.work === "how" || state.work === "why") {
    return [{id: state.id, designer: "lead" as const, work: state.work, prompt: investigationPrompt(state.work), schema: researchSchema(state),
      context: {question: state.question, availableRound: state.selection.target.work,
        observations: designContext(state.progress.input).observations, authority: state.authority.slice(-6)}}];
  }
  if (state.work === "lead-decision") {
    const material = state.decision.kind === "signoff" ? {candidate: state.decision.approved.candidate,
      approvedBy: ["member-a", "member-b"]} : {issue: state.decision.issue};
    return [{id: state.id, designer: "lead" as const, work: state.work, prompt: decisionPrompt,
      schema: leadSchema(state.decision), context: structuredClone({protocol: designerVersion, ...designContext(state.progress.input),
        round: state.progress.round, kind: state.decision.kind, materials: material, authority: state.authority})}];
  }
  if (!("slots" in state)) return [];
  return draftTurns(state).map(turn => {
    const draft = state.work === "draft";
    const authority = state.authority.filter(item => item.author === "user" || !item.designer || item.designer === turn.designer)
      .map(item => draft && turn.designer !== item.designer && item.author === "user"
        ? {author: item.author, text: item.text, factId: item.factId} : item);
    return {...turn, prompt: turn.designer === "lead" ? turn.prompt : `${turn.prompt}\n\n${memberAuthority}`,
      context: {...turn.context, protocol: designerVersion, authority: structuredClone(authority)}};
  });
}

function pause(state: LeadWork | Selection, request: Omit<Escalation, "designer">): DesignerState {
  const factId = state.work === "lead-decision" && state.decision.kind !== "signoff" ?
    state.decision.issue.factId ?? request.factId : request.factId;
  return {kind: "paused", protocol: designerVersion, previous: state, question: request.question, evidence: request.evidence, factId};
}

function resumeRound(state: LeadWork, previous: Drafting, authority: Direction[]): DraftWork & {protocol: typeof designerVersion} {
  let serial = state.progress.serial;
  const slots = previous.slots.map(slot => slot.reply ? slot : {...slot, job: {...slot.job,
    id: `${state.progress.input.runId}:${state.progress.round}:${slot.job.designer}:${++serial}`}});
  return {...previous, progress: {...state.progress, serial}, slots, authority, protocol: designerVersion};
}

function resynthesize(state: LeadWork, authority: Direction[]): DraftWork & {protocol: typeof designerVersion} {
  const {progress} = state;
  const round = progress.round + 1;
  const serial = progress.serial + 1;
  return {kind: "working", work: "synthesize", protocol: designerVersion, progress: {...progress, round, serial, issues: []}, authority,
    slots: [{job: {id: `${progress.input.runId}:${round}:lead:${serial}`, designer: "lead", work: "synthesize",
      input: {drafts: progress.candidate ? [] : progress.drafts, resolved: progress.resolved, previous: progress.candidate}}}]};
}

function reconsider(state: LeadWork, changes: Change[]): DesignerState {
  const {progress} = state;
  const round = progress.round + 1;
  let serial = progress.serial;
  const version = progress.candidate!.version;
  const slots = designers.slice(1).map(designer => ({job: {id: `${progress.input.runId}:${round}:${designer}:${++serial}`,
    designer, work: "respond" as const, input: {issues: changes.map((proposal, index) => ({
      id: `${round}:lead:${designer}:${index + 1}`, author: designer, proposer: "lead" as const, version,
      original: proposal, proposal, replies: [],
    }))}}}));
  const issues = slots.flatMap(slot => slot.job.input.issues);
  return {kind: "working", work: "respond", protocol: designerVersion, progress: {...progress, round, serial, issues},
    authority: state.authority, slots};
}

export function settleDesignerTurn(state: DesignerState, event: Parameters<typeof settleDraft>[1]): DesignerState {
  if (state.kind !== "working" || !event.settled) return state;
  if (state.work === "select-state") {
    if (event.id !== state.id) return state;
    const {next, result} = readTransition(selectionSchema(state), event.result);
    if (Value.Check(needsUser, result)) return pause(state, result);
    if ((next === "how" || next === "why") && Value.Check(investigationRequest, result)) {
      const progress = {...state.progress, serial: state.progress.serial + 1};
      return {kind: "working", protocol: designerVersion, work: next, progress, selection: state,
        id: `${progress.input.runId}:${next}:${progress.serial}`, question: result.question, authority: state.authority};
    }
    if (next === "draft" && Value.Check(redraft, result) && "slots" in state.target) {
      const draft = redraftDesign({...state.target, progress: state.progress});
      return activate({...draft, authority: state.authority}, draft.progress, state.authority);
    }
    if (next === state.target.work) return activate(state.target, state.progress, state.authority);
    throw new Error("Invalid next Designer Work State.");
  }
  if (state.work === "how" || state.work === "why") {
    if (event.id !== state.id) return state;
    const {next, result} = readTransition(researchSchema(state), event.result);
    if (!Value.Check(investigationResult, result)) throw new Error("Invalid Designer investigation result.");
    const authority: Direction[] = [...state.authority, {author: "lead", question: state.question,
      text: result.answer, evidence: result.evidence.join("\n")}];
    const {target, completed} = state.selection;
    return next === "select-state" ? selectState(target, completed, authority, state.progress.serial) :
      activate(target, state.progress, authority);
  }
  if (state.work === "lead-decision") {
    if (event.id !== state.id) return state;
    const {result} = readTransition(leadSchema(state.decision), event.result);
    if (Value.Check(needsUser, result)) return pause(state, result);
    const {decision} = state;
    if (decision.kind === "signoff" && Value.Check(approve, result)) {
      if (result.version !== decision.approved.candidate.version) throw new Error("Lead must sign the confirmed plan version.");
      return {...decision.approved, protocol: designerVersion, progress: state.progress, authority: state.authority, signedBy: "lead"};
    }
    if (decision.kind === "signoff" && Value.Check(revise, result)) {
      return reconsider(state, structuredClone(result.changes));
    }
    if (decision.kind === "escalation" && !decision.issue.factId && Value.Check(resume, result)) {
      return resumeRound(state, decision.previous, [...state.authority, {author: "lead", text: result.instructions,
        question: decision.issue.question, evidence: decision.issue.evidence, designer: decision.issue.designer}]);
    }
    throw new Error("Invalid Lead Designer decision.");
  }
  if (!("slots" in state)) return state;
  const slot = state.slots.find(item => item.job.id === event.id && !item.reply);
  if (!slot) return state;
  const next = settleDraft(state, event);
  if (next.kind === "working") {
    const target: DraftWork = {...next, authority: state.authority};
    return next.progress.round !== state.progress.round ? selectState(target, state.work) : activate(target, next.progress, state.authority);
  }
  if (next.kind === "approved") return selectState(leadDecision({kind: "signoff", approved: next}, state.authority), state.work);
  const {question, evidence, factId} = next;
  const issue = {designer: slot.job.designer, question, evidence, factId};
  const request = Type.Object({result: needsUser});
  const kind = Value.Check(request, event.result) ? "escalation" : "disagreement";
  const lead = leadDecision({kind, previous: next.previous, issue}, state.authority);
  return kind === "escalation" && issue.designer === "lead" ? pause(lead, issue) : lead;
}

export function answerDesigner(state: DesignerState, answer: string): DesignerState {
  if (state.kind !== "paused" || !answer.trim()) throw new Error("Provide an answer to the pending Designer question.");
  const {previous, question, evidence, factId} = state;
  const designer = previous.work === "lead-decision" && previous.decision.kind !== "signoff" ? previous.decision.issue.designer : undefined;
  const authority: Direction[] = [...previous.authority, {author: "user", question, evidence, factId, designer, text: answer.trim()}];
  if (previous.work === "select-state") return selectState(previous.target, previous.completed, authority, previous.progress.serial);
  const target = previous.decision.kind === "escalation" ? resumeRound(previous, previous.decision.previous, authority) :
    resynthesize(previous, authority);
  return selectState(target, "user-decision");
}

import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { answers, designers, needsUser, type Change, type Designer } from "./protocol-v0.1.ts";
import { designContext, designerTurns as draftTurns, settleDesignerTurn as settleDraft, startDesigner as startDraft,
  type DesignInput, type DesignerState as DraftState } from "./v0.1.ts";

export const designerVersion = "0.2";
export type { DesignInput };

type Drafting = Extract<DraftState, {kind: "working"}>;
type DraftApproval = Extract<DraftState, {kind: "approved"}>;
type DraftPause = Extract<DraftState, {kind: "paused"}>;
type Checkpoint = Drafting["checkpoint"];
type Direction = {author: "lead" | "user"; text: string; question?: string; evidence?: string; factId?: string; designer?: Designer};
type Escalation = {designer: Designer; question: string; evidence: string; factId?: string};
type Decision = {kind: "signoff"; approved: DraftApproval} |
  {kind: "escalation"; previous: Drafting; issue: Escalation} |
  {kind: "disagreement"; previous: Drafting; issue: Escalation};

type DraftWork = Drafting & {authority: Direction[]};
type LeadWork = {kind: "working"; work: "lead-decision"; checkpoint: Checkpoint; id: string; decision: Decision; authority: Direction[]};
type Paused = {kind: "paused"; previous: LeadWork; question: string; evidence: string; factId?: string};
type Approved = DraftApproval & {authority: Direction[]; signedBy: "lead"};
export type DesignerState = (DraftWork | LeadWork | Paused | Approved) & {protocol: typeof designerVersion};

const text = Type.String({minLength: 1, pattern: "\\S"});
const approve = Type.Object({kind: Type.Literal("approved"), version: text}, {additionalProperties: false});
const change = answers.compare.properties.reviews.items.properties.changes.items;
const revise = Type.Object({kind: Type.Literal("revise"), changes: Type.Array(change, {minItems: 1})}, {additionalProperties: false});
const resume = Type.Object({kind: Type.Literal("resume"), instructions: text}, {additionalProperties: false});
const signoffSchema = Type.Union([approve, revise, needsUser]);
const escalationSchema = Type.Union([resume, needsUser]);
const decisionPrompt = readFileSync(new URL("../../../prompts/designer/0.2/lead-decision.md", import.meta.url), "utf8").trim();
const memberAuthority = readFileSync(new URL("../../../prompts/designer/0.2/member-authority.md", import.meta.url), "utf8").trim();

function schemaFor(decision: Decision) {
  if (decision.kind === "signoff") return signoffSchema;
  return decision.kind === "escalation" && !decision.issue.factId ? escalationSchema : needsUser;
}

function leadDecision(decision: Decision, authority: Direction[]): LeadWork & Pick<DesignerState, "protocol"> {
  const previous = decision.kind === "signoff" ? decision.approved : decision.previous;
  const checkpoint = {...previous.checkpoint, serial: previous.checkpoint.serial + 1};
  return {kind: "working", work: "lead-decision", protocol: designerVersion, checkpoint, id: `${checkpoint.input.runId}:lead-decision:${checkpoint.serial}`,
    decision, authority};
}

export function startDesigner(input: DesignInput): DesignerState {
  const state = startDraft(input);
  if (state.kind !== "working") throw new Error("Designer could not start Draft.");
  return {...state, authority: [], protocol: designerVersion};
}

export function designerTurns(state: DesignerState) {
  if (state.kind !== "working") return [];
  if (state.work === "lead-decision") {
    const material = state.decision.kind === "signoff" ? {candidate: state.decision.approved.candidate,
      approvedBy: ["member-a", "member-b"]} : {issue: state.decision.issue};
    return [{id: state.id, designer: "lead" as const, work: state.work, prompt: decisionPrompt,
      schema: schemaFor(state.decision), context: structuredClone({protocol: designerVersion, ...designContext(state.checkpoint.input),
        round: state.checkpoint.round, kind: state.decision.kind, materials: material, authority: state.authority})}];
  }
  return draftTurns(state).map(turn => {
    const draft = state.work === "draft";
    const authority = state.authority.filter(item => item.author === "user" || !item.designer || item.designer === turn.designer)
      .map(item => draft && turn.designer !== item.designer && item.author === "user"
        ? {author: item.author, text: item.text, factId: item.factId} : item);
    return {...turn, prompt: turn.designer === "lead" ? turn.prompt : `${turn.prompt}\n\n${memberAuthority}`,
      context: {...turn.context, protocol: designerVersion, authority: structuredClone(authority)}};
  });
}

function pause(state: LeadWork, request: Omit<Escalation, "designer">): DesignerState {
  const factId = state.decision.kind === "signoff" ? request.factId : state.decision.issue.factId ?? request.factId;
  return {kind: "paused", protocol: designerVersion, previous: state, question: request.question, evidence: request.evidence, factId};
}

function resumeRound(state: LeadWork, previous: Drafting, authority: Direction[]): DesignerState {
  let serial = state.checkpoint.serial;
  const slots = previous.slots.map(slot => slot.reply ? slot : {...slot, job: {...slot.job,
    id: `${state.checkpoint.input.runId}:${state.checkpoint.round}:${slot.job.designer}:${++serial}`}});
  return {...previous, checkpoint: {...state.checkpoint, serial}, slots, authority, protocol: designerVersion};
}

function resynthesize(state: LeadWork, authority: Direction[]): DesignerState {
  const {checkpoint} = state;
  const round = checkpoint.round + 1;
  const serial = checkpoint.serial + 1;
  return {kind: "working", work: "synthesize", protocol: designerVersion, checkpoint: {...checkpoint, round, serial, issues: []}, authority,
    slots: [{job: {id: `${checkpoint.input.runId}:${round}:lead:${serial}`, designer: "lead", work: "synthesize",
      input: {drafts: checkpoint.candidate ? [] : checkpoint.drafts, resolved: checkpoint.resolved, previous: checkpoint.candidate}}}]};
}

function reconsider(state: LeadWork, changes: Change[]): DesignerState {
  const {checkpoint} = state;
  const round = checkpoint.round + 1;
  let serial = checkpoint.serial;
  const version = checkpoint.candidate!.version;
  const slots = designers.slice(1).map(designer => ({job: {id: `${checkpoint.input.runId}:${round}:${designer}:${++serial}`,
    designer, work: "respond" as const, input: {issues: changes.map((proposal, index) => ({
      id: `${round}:lead:${designer}:${index + 1}`, author: designer, proposer: "lead" as const, version,
      original: proposal, proposal, replies: [],
    }))}}}));
  const issues = slots.flatMap(slot => slot.job.input.issues);
  return {kind: "working", work: "respond", protocol: designerVersion, checkpoint: {...checkpoint, round, serial, issues},
    authority: state.authority, slots};
}

export function settleDesignerTurn(state: DesignerState, event: Parameters<typeof settleDraft>[1]): DesignerState {
  if (state.kind !== "working" || !event.settled) return state;
  if (state.work === "lead-decision") {
    if (event.id !== state.id) return state;
    if (Value.Check(needsUser, event.result)) return pause(state, event.result);
    const {decision} = state;
    if (decision.kind === "signoff" && Value.Check(approve, event.result)) {
      if (event.result.version !== decision.approved.candidate.version) throw new Error("Lead must sign the confirmed plan version.");
      return {...decision.approved, protocol: designerVersion, checkpoint: state.checkpoint, authority: state.authority, signedBy: "lead"};
    }
    if (decision.kind === "signoff" && Value.Check(revise, event.result)) {
      return reconsider(state, structuredClone(event.result.changes));
    }
    if (decision.kind === "escalation" && !decision.issue.factId && Value.Check(resume, event.result)) {
      return resumeRound(state, decision.previous, [...state.authority, {author: "lead", text: event.result.instructions,
        question: decision.issue.question, evidence: decision.issue.evidence, designer: decision.issue.designer}]);
    }
    throw new Error("Invalid Lead Designer decision.");
  }
  const slot = state.slots.find(item => item.job.id === event.id && !item.reply);
  if (!slot) return state;
  const next = settleDraft(state, event);
  if (next.kind === "working") return {...next, protocol: designerVersion, authority: state.authority};
  if (next.kind === "approved") return leadDecision({kind: "signoff", approved: next}, state.authority);
  const {question, evidence, factId} = next;
  const issue = {designer: slot.job.designer, question, evidence, factId};
  const kind = Value.Check(needsUser, event.result) ? "escalation" : "disagreement";
  const lead = leadDecision({kind, previous: next.previous, issue}, state.authority);
  return kind === "escalation" && issue.designer === "lead" ? pause(lead, issue) : lead;
}

export function answerDesigner(state: DesignerState, answer: string): DesignerState {
  if (state.kind !== "paused" || !answer.trim()) throw new Error("Provide an answer to the pending Designer question.");
  const {previous, question, evidence, factId} = state;
  const designer = previous.decision.kind === "signoff" ? undefined : previous.decision.issue.designer;
  const authority: Direction[] = [...previous.authority, {author: "user", question, evidence, factId, designer, text: answer.trim()}];
  return previous.decision.kind === "escalation" ? resumeRound(previous, previous.decision.previous, authority) : resynthesize(previous, authority);
}

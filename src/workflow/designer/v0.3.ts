import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { TaskType } from "../transitions.ts";
import { acceptPlan, planParameter, type ExecutionPlan } from "../design-worker.ts";
import { investigationPrompt, investigationRequest, investigationResult, investigations, pstackGuidance, readTransition, transition, type Investigation } from "../playbook.ts";

const members = ["member-a", "member-b"] as const;
type Member = typeof members[number];
type Designer = "lead" | Member;

type DesignInput = {runId: string; taskbook: string; taskType: TaskType; baseline: string; factsVersion: string; facts: readonly string[];
  userAnswers: readonly {question: string; answer: string}[];
  requirements: readonly {id: string; text: string}[]; previousPlanVersion?: number};

const text = Type.String({minLength: 1, pattern: "\\S"});
const shortText = Type.String({minLength: 1, maxLength: 800, pattern: "\\S"});
const draft = Type.Object({goal: text, facts: Type.Array(text)}, {additionalProperties: false});
function objection<T extends TSchema>(target: T) {
  const finding = Type.Object({target, counterexample: shortText, evidence: shortText, correction: shortText,
    factId: Type.Optional(shortText)}, {additionalProperties: false});
  return Type.Object({kind: Type.Literal("objected"), version: text,
    findings: Type.Array(finding, {minItems: 1})}, {additionalProperties: false});
}
const proposed = {draft, plan: planParameter};
const initialPlan = Type.Object({kind: Type.Literal("plan"), ...proposed}, {additionalProperties: false});
const resolution = Type.Object({id: text, disposition: Type.Union([Type.Literal("changed"), Type.Literal("rebutted")]),
  explanation: shortText}, {additionalProperties: false});
const revisedPlan = Type.Object({kind: Type.Literal("revised"), ...proposed, resolutions: Type.Array(resolution)}, {additionalProperties: false});
const approved = Type.Object({kind: Type.Literal("approved"), version: text}, {additionalProperties: false});
const objected = objection(shortText);
const signed = Type.Object({kind: Type.Literal("signed"), version: text}, {additionalProperties: false});
const needsUser = Type.Object({kind: Type.Literal("needs-user"), question: shortText, evidence: shortText, factId: Type.Optional(shortText)},
  {additionalProperties: false});
const consultRequest = Type.Object({kind: Type.Literal("consult"), question: shortText, evidence: shortText}, {additionalProperties: false});
const consultResult = Type.Object({kind: Type.Literal("answered"), answer: text, basis: shortText,
  draftFacts: Type.Array(Type.Object({text: text, source: text}, {additionalProperties: false}))}, {additionalProperties: false});

type Candidate = {version: string; draft: Static<typeof draft>; plan: ExecutionPlan};
type Finding = Static<typeof objected>["findings"][number] & {id: string; member: Member};
export type DesignReviewRecord = {finding: Finding; reviewedVersion: string; resolution: Static<typeof resolution>};
type MemberReply = Static<typeof approved> | Static<typeof objected>;
type PrimaryWork = "draft" | "confirm" | "reconfirm" | "revise" | "signoff";
type HelpWork = "consult" | Investigation;
type PrimaryJob = {id: string; designer: Designer; work: PrimaryWork};
type Job = PrimaryJob | {id: string; designer: Designer; work: HelpWork; question: string; evidence?: string; returnTo: PrimaryJob};
type Progress = {input: DesignInput; serial: number; candidate?: Candidate; findings: Finding[];
  resolutions: DesignReviewRecord[]; reconsideredVersion?: string; recheck?: ReturnType<typeof revisionScope>;
  consultations: {designer: Designer; question: string; result: Static<typeof consultResult>}[]};
type Working = {kind: "working"; work: PrimaryWork; progress: Progress; slots: {job: Job; review?: MemberReply}[]};
type Paused = {kind: "paused"; previous: Working; question: string; evidence: string; factId?: string};
export type DesignerState = Working | Paused | {kind: "approved"; progress: Progress; candidate: Candidate};
type Proposal = Static<typeof initialPlan> | Static<typeof revisedPlan>;

function confirmation(work: Job["work"]) {
  return work === "confirm" || work === "reconfirm";
}

function begin(progress: Progress, work: PrimaryWork): Working {
  const seats: readonly Designer[] = confirmation(work) ? members : ["lead"];
  const slots = seats.map((designer, index) => ({job: {id: `${progress.input.runId}:design:${progress.serial + index + 1}`, designer, work}}));
  return {kind: "working", work, progress: {...progress, serial: progress.serial + slots.length}, slots};
}

export function startDesigner(input: DesignInput): DesignerState {
  return begin({input: structuredClone(input), serial: 0, findings: [], resolutions: [], consultations: []}, "draft");
}

function findingTargets({input, candidate}: Progress) {
  return [...new Set([...input.requirements.map(item => item.id), ...(candidate?.plan.steps.map(step => step.id) ?? [])])];
}

function destinations(job: Job, progress: Progress) {
  const ask = transition("needs-user", needsUser);
  if ("returnTo" in job) {
    const answer = transition(job.returnTo.work, job.work === "consult" ? consultResult : investigationResult);
    return job.designer === "lead" ? Type.Union([answer, ask]) : answer;
  }
  const helpers = [transition("consult", consultRequest), ...investigations.map(method => transition(method, investigationRequest))];
  if (confirmation(job.work)) {
    const allowed = job.work === "reconfirm" ? progress.recheck?.findingTargets : findingTargets(progress);
    if (!allowed?.length) throw new Error("Confirmation requires review targets.");
    const target = Type.Enum(allowed, {description: "Select one Goal, Delivery or plan step ID."});
    return Type.Union([transition("signoff", approved), transition("revise", objection(target)), ...helpers]);
  }
  if (job.work === "draft") return Type.Union([transition("confirm", initialPlan), ask, ...helpers]);
  if (job.work === "revise") {
    return Type.Union([...(progress.findings.some(item => item.factId) ? [] :
      [transition(progress.findings.length ? "reconfirm" : "confirm", revisedPlan)]), ask, ...helpers]);
  }
  return Type.Union([transition("implement", signed), ask, ...helpers]);
}

function revisionScope(input: DesignInput, previous: Candidate, current: Candidate, resolutions: DesignReviewRecord[]) {
  const oldSteps = new Map(previous.plan.steps.map(step => [step.id, step]));
  const newSteps = new Map(current.plan.steps.map(step => [step.id, step]));
  const changes = [...new Set([...oldSteps.keys(), ...newSteps.keys()])].flatMap(id => {
    const before = oldSteps.get(id), after = newSteps.get(id);
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{id, before, after}];
  });
  const beforeOrder = [...oldSteps.keys()];
  const afterOrder = [...newSteps.keys()];
  const reordered = JSON.stringify(beforeOrder.filter(id => newSteps.has(id))) !==
    JSON.stringify(afterOrder.filter(id => oldSteps.has(id)));
  const broad = reordered || previous.draft.goal !== current.draft.goal ||
    JSON.stringify(previous.draft.facts) !== JSON.stringify(current.draft.facts);
  const affected = new Set([...resolutions.map(item => item.finding.target), ...changes.flatMap(({id, before, after}) =>
    [id, ...(before?.targets ?? []), ...(after?.targets ?? [])])]);
  for (const id of affected) {
    if (!oldSteps.has(id)) continue;
    for (const requirement of oldSteps.get(id)?.targets ?? []) affected.add(requirement);
  }
  const requirements = input.requirements.filter(item => broad || affected.has(item.id));
  return {previousVersion: previous.version, candidateVersion: current.version, resolutions, requirements, changes,
    stepOrder: afterOrder, ...(broad ? {candidate: current} : {}),
    findingTargets: [...new Set([...requirements.map(item => item.id), ...afterOrder.filter(id => broad || affected.has(id))])]};
}

function reviewSummary(value: unknown) {
  const summary = Type.Object({result: Type.Union([approved, objected])});
  if (!Value.Check(summary, value)) return;
  const {result} = value;
  if (result.kind === "approved") return "已确认方案 " + result.version.slice(0, 12);
  return result.findings.map(({target, counterexample, evidence, correction}) =>
    `${target} · ${counterexample}\n依据 · ${evidence}\n需要改动 · ${correction}`).join("\n\n");
}

function revisionSummary(value: unknown) {
  if (!Value.Check(Type.Object({result: revisedPlan}), value)) return;
  return value.result.resolutions.map(item => `${item.id} · ${item.disposition} · ${item.explanation}`).join("\n");
}

export function designerTurns(state: DesignerState) {
  if (state.kind !== "working") return [];
  const {input, candidate, findings, recheck, consultations} = state.progress;
  return state.slots.filter(slot => !slot.review).map(({job}) => {
    const prompt = job.work === "how" || job.work === "why" ? investigationPrompt(job.work) :
      readFileSync(new URL(`../../../prompts/designer/0.3/${job.work}.md`, import.meta.url), "utf8").trim();
    return {id: job.id, designer: job.designer, work: job.work, schema: destinations(job, state.progress),
      prompt: job.work === "draft" || job.work === "revise" ? prompt + "\n\n" + pstackGuidance("architect", "design") : prompt,
      context: structuredClone({...(job.work === "reconfirm"
        ? {...recheck, baseline: input.baseline, facts: input.facts, userAnswers: input.userAnswers}
        : {...input, candidate}),
        ...(job.work === "revise" ? {findings} : {}),
        ...(job.work === "confirm" ? {findingTargets: findingTargets(state.progress)} : {}),
        ...(job.work === "signoff" ? {approvedBy: members} : {}),
        ...("returnTo" in job ? {question: job.question, evidence: job.evidence, returnTo: job.returnTo.work} : {}),
        consultations: consultations.filter(entry => entry.designer === job.designer).slice(-6)}),
      validateResult(result: unknown) {
        settleDesignerTurn(state, {id: job.id, settled: true, result});
      },
      summarizeResult: confirmation(job.work) ? reviewSummary : job.work === "revise" ? revisionSummary : undefined};
  });
}

function replaceJob(state: Working, uid: string, next: Omit<PrimaryJob, "id"> | Omit<Extract<Job, {returnTo: PrimaryJob}>, "id">): Working {
  const serial = state.progress.serial + 1;
  return {...state, progress: {...state.progress, serial},
    slots: state.slots.map(slot => slot.job.id === uid ? {job: {...next, id: `${state.progress.input.runId}:design:${serial}`}} : slot)};
}

function prepareCandidate(progress: Progress, result: Proposal): Candidate {
  const plan = acceptPlan(result.plan.steps, progress.input.requirements.map(item => item.id),
    progress.candidate?.plan.version ?? progress.input.previousPlanVersion);
  const version = createHash("sha256").update(JSON.stringify([result.draft, plan.steps, progress.input.factsVersion])).digest("hex");
  return progress.candidate?.version === version ? progress.candidate : {version, plan, draft: result.draft};
}

function applyRevision(state: Working, result: Static<typeof revisedPlan>, candidate: Candidate): DesignerState {
  const {progress} = state;
  const previous = progress.candidate;
  if (!previous) throw new Error("Revision needs the reviewed candidate.");
  const byID = new Map(result.resolutions.map(item => [item.id, item]));
  if (result.resolutions.length !== progress.findings.length || byID.size !== result.resolutions.length ||
      progress.findings.some(item => !byID.has(item.id))) throw new Error("Address each member finding exactly once.");
  const unchanged = candidate.version === previous.version;
  if (unchanged && result.resolutions.some(item => item.disposition === "changed")) {
    throw new Error("A change to a finding requires a change to the candidate.");
  }
  if (unchanged && progress.reconsideredVersion === candidate.version) {
    return {kind: "paused", previous: state, question: "Which unresolved design correction should the plan adopt?",
      evidence: progress.findings.map(item => `${item.member} · ${item.target} · ${item.counterexample} · ${item.evidence}`).join("\n")};
  }
  const resolutions = progress.findings.map(item => ({finding: item, reviewedVersion: previous.version, resolution: byID.get(item.id)!}));
  const recheck = resolutions.length ? revisionScope(progress.input, previous, candidate, resolutions) : undefined;
  return begin({...progress, candidate, findings: [], resolutions: [...progress.resolutions, ...resolutions],
    recheck, reconsideredVersion: unchanged ? candidate.version : undefined}, recheck ? "reconfirm" : "confirm");
}

function settleConfirmation(state: Working, job: PrimaryJob, review: MemberReply): DesignerState {
  const {candidate, input} = state.progress;
  if (job.designer === "lead" || !candidate || candidate.version !== review.version) throw new Error("Confirmation needs the current candidate version.");
  const slots = state.slots.map(slot => slot.job.id === job.id ? {...slot, review} : slot);
  if (slots.some(slot => !slot.review)) return {...state, slots};
  const findings = slots.flatMap(({job, review}) => {
    const member = job.designer;
    if (member === "lead" || review?.kind !== "objected") return [];
    return review.findings.map((item, index) => ({...item,
      factId: item.factId && input.facts.some(fact => fact.startsWith(item.factId + " ")) ? item.factId : undefined,
      id: `${member}:${job.id.split(":").at(-1)}:${index + 1}`, member}));
  });
  return begin({...state.progress, findings}, findings.length ? "revise" : "signoff");
}

export function settleDesignerTurn(state: DesignerState, event: {id: string; settled: boolean; result: unknown}): DesignerState {
  if (state.kind !== "working" || !event.settled) return state;
  const job = state.slots.find(slot => slot.job.id === event.id && !slot.review)?.job;
  if (!job) return state;
  const {progress} = state;
  const {next, result} = readTransition(destinations(job, progress), event.result);
  if (Value.Check(needsUser, result)) {
    const protectedFact = progress.findings.find(item => item.factId);
    return {kind: "paused", previous: state, question: result.question, evidence: result.evidence,
      factId: protectedFact?.factId ?? result.factId};
  }
  if ("returnTo" in job) {
    const answer = Value.Check(investigationResult, result) ?
      {kind: "answered" as const, answer: result.answer, basis: result.evidence.join("\n").slice(0, 800), draftFacts: []} : result;
    if (!Value.Check(consultResult, answer)) throw new Error("An investigation or consultation needs an answer and its evidence.");
    const consultations = [...progress.consultations, {designer: job.designer, question: job.question, result: answer}];
    return replaceJob({...state, progress: {...progress, consultations}}, job.id, job.returnTo);
  }
  if ((next === "how" || next === "why") && Value.Check(investigationRequest, result)) {
    return replaceJob(state, job.id, {designer: job.designer, work: next, question: result.question, returnTo: job});
  }
  if (next === "consult" && Value.Check(consultRequest, result)) {
    return replaceJob(state, job.id, {designer: job.designer, work: next, question: result.question, evidence: result.evidence, returnTo: job});
  }
  if (Value.Check(initialPlan, result)) return begin({...progress, candidate: prepareCandidate(progress, result)}, "confirm");
  if (Value.Check(revisedPlan, result)) return applyRevision(state, result, prepareCandidate(progress, result));
  if (Value.Check(approved, result) || Value.Check(objected, result)) return settleConfirmation(state, job, result);
  if (Value.Check(signed, result) && progress.candidate?.version === result.version) {
    return {kind: "approved", progress, candidate: progress.candidate};
  }
  throw new Error("The Lead must sign the exact member-confirmed plan version.");
}

export function answerDesigner(state: DesignerState, answer: string): DesignerState {
  if (state.kind !== "paused" || !answer.trim()) throw new Error("Provide an answer to the pending Designer question.");
  const {previous, question} = state;
  const {progress, work} = previous;
  const userAnswers = [...progress.input.userAnswers, {question, answer}];
  const factsVersion = createHash("sha256").update(JSON.stringify([progress.input.factsVersion, question, answer])).digest("hex");
  return begin({...progress, reconsideredVersion: undefined, input: {...progress.input, userAnswers, factsVersion}},
    work === "signoff" ? "revise" : work);
}

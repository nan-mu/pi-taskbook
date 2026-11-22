import { readFileSync } from "node:fs";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { TaskType } from "../transitions.ts";
import { investigationPrompt, investigationRequest, investigationResult, investigations, pstackGuidance, readTransition, transition, type Investigation } from "../playbook.ts";

export const implementerVersion = "0.1";
export type Playbook = "feature" | "refactoring" | "bug-fix" | "perf-issue" | "hillclimb" | "experiment" | "experiment-fix";
export const playbooks: Record<Playbook, readonly Step[]> = {
  feature: ["trace", "shape", "implement", "verify"],
  refactoring: ["pin", "shape", "implement", "verify"],
  "bug-fix": ["reproduce", "diagnose", "implement", "verify"],
  "perf-issue": ["baseline", "diagnose", "implement", "measure", "verify"],
  hillclimb: ["baseline", "choose", "experiment", "measure", "decide", "verify"],
  experiment: ["baseline", "experiment", "measure", "verify"],
  "experiment-fix": ["reproduce", "diagnose", "baseline", "experiment", "measure", "verify"],
};
type Step = "trace" | "shape" | "pin" | "reproduce" | "diagnose" | "baseline" | "implement" | "experiment" | "measure" | "verify" | "rework" | "choose" | "decide" | "rollback";
type Work = Step | "consult" | Investigation;
export type ImplementInput = {runId: string; taskType: TaskType; taskbook: string; tasks: readonly string[]; playbook?: Playbook; hillclimb?: {maxAttempts: number; minAttempts: number; target: string}};
const text = Type.String({minLength: 1, pattern: "\\S"});
const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, {additionalProperties: false});
const draftFact = object({text, source: text});
const done = object({draftFacts: Type.Optional(Type.Array(draftFact)), kind: Type.Literal("done"), summary: text, evidence: Type.Array(text, {minItems: 1})});
const consult = object({kind: Type.Literal("consult"), question: text, evidence: text});
const answer = object({draftFacts: Type.Optional(Type.Array(draftFact)), kind: Type.Literal("answered"), answer: text, evidence: text});
const gap = object({kind: Type.Literal("plan-gap"), stepId: text, observation: text, question: text});
const reproduced = object({kind: Type.Literal("reproduced"), trigger: text, observed: text, evidence: text});
const unreproduced = object({kind: Type.Literal("unreproduced"), attempts: text, observation: text, question: text});
const baseline = object({kind: Type.Literal("baseline"), workload: text, metric: text, direction: Type.Union([Type.Literal("increase"), Type.Literal("decrease")]), value: text, harness: text, sensitivity: text, regressionGate: Type.Literal("pass")});
const chosen = object({kind: Type.Literal("chosen"), hypothesis: text, change: text});
const measured = object({kind: Type.Literal("measured"), before: text, after: text, workCount: text, errors: text, regressionGate: Type.Union([Type.Literal("pass"), Type.Literal("fail")]), evidence: text});
const decision = object({kind: Type.Literal("decision"), verdict: Type.Union([Type.Literal("keep"), Type.Literal("revert")]), reason: text});
const verified = object({kind: Type.Literal("verified"), evidence: Type.Array(text, {minItems: 1}), summary: text, draftFacts: Type.Optional(Type.Array(draftFact))});
const revisit = object({kind: Type.Literal("revisit"), observation: text});
const retry = object({kind: Type.Literal("retry"), observation: text});
type Done = Static<typeof done>;
type StageResult = Done | Static<typeof reproduced> | Static<typeof baseline> | Static<typeof chosen> | Static<typeof measured> | Static<typeof decision> | Static<typeof verified>;
export type ImplementRecord = {work: Step; result: StageResult};
type Progress = {input: ImplementInput; playbook: Playbook; serial: number; records: ImplementRecord[];
  consultations: {question?: string; answer: string; evidence: string | string[]}[]; feedback?: string; attempts: number};
type Working = {kind: "working"; progress: Progress; work: Step; id: string} |
  {kind: "working"; progress: Progress; work: "consult" | Investigation; id: string; question: string; evidence?: string; returnTo: Step};
export type ImplementerState = Working | {kind: "paused"; previous: Working; reason: "lead" | "plan-gap" | "unreproduced";
  question: string; evidence: string; stepId?: string} | {kind: "handoff"; progress: Progress};

function nextId(progress: Progress) {
  return `${progress.input.runId}:implementer:${progress.serial + 1}`;
}
function step(progress: Progress, work: Step): Working {
  return {kind: "working", work, id: nextId(progress), progress: {...progress, serial: progress.serial + 1}};
}
function investigate(progress: Progress, work: "consult" | Investigation, returnTo: Step, question: string, evidence?: string): Working {
  return {kind: "working", work, returnTo, question, evidence, id: nextId(progress), progress: {...progress, serial: progress.serial + 1}};
}
function isStep(work: string): work is Step {
  return Object.values(playbooks).some(steps => steps.some(step => step === work)) || work === "rework" || work === "rollback";
}
export function startImplementer(input: ImplementInput): ImplementerState {
  if (!input.runId.trim() || !input.taskbook.trim() || !input.tasks.length || input.tasks.some(task => !task.trim())) throw new Error("Implementer needs a run, taskbook and ordered tasks.");
  const playbook = input.playbook ?? (input.taskType === "fix-feature" ? "bug-fix" : input.taskType === "fix-experiment" ? "experiment-fix" : input.taskType === "new-experiment" ? "experiment" : "feature");
  if (!playbooks[playbook]) throw new Error("Unknown implementation playbook.");
  if (playbook === "hillclimb" && (!input.hillclimb || !Number.isInteger(input.hillclimb.maxAttempts) || !Number.isInteger(input.hillclimb.minAttempts) || input.hillclimb.minAttempts < 1 || input.hillclimb.maxAttempts < input.hillclimb.minAttempts || !input.hillclimb.target.trim())) throw new Error("Hillclimb needs a target and valid attempt budget.");
  const progress: Progress = {input: structuredClone(input), playbook, serial: 0, attempts: 0, records: [], consultations: []};
  return step(progress, playbooks[playbook][0]);
}
const stepResult = {trace: done, shape: done, pin: done, reproduce: reproduced, diagnose: done, baseline, implement: done,
  experiment: done, measure: measured, verify: verified, rework: done, choose: chosen, decide: decision, rollback: done} satisfies Record<Step, TSchema>;

function destinations(state: Working): TSchema[] {
  const {work, progress} = state;
  if (work === "consult") return [transition(state.returnTo, answer), transition("lead-consult", gap)];
  if (work === "how" || work === "why") return [transition(state.returnTo, investigationResult)];
  const helpers = [transition("consult", consult), transition("lead-consult", consult), transition("lead-consult", gap),
    ...investigations.map(method => transition(method, investigationRequest)),
    ...(work === "reproduce" ? [transition("lead-consult", unreproduced)] : [])];
  const steps = playbooks[progress.playbook];
  if (work === "verify") {
    const retrySteps = steps.filter(name => name === "implement" || name === "diagnose");
    return [transition("handoff", verified), ...(retrySteps.length ? retrySteps : ["rework" as const]).map(name => transition(name, retry)), ...helpers];
  }
  if (progress.playbook === "hillclimb" && (work === "decide" || work === "rollback")) {
    const {minAttempts, maxAttempts} = progress.input.hillclimb!;
    const attempts = progress.attempts + Number(work === "decide");
    const moves = [...(attempts >= minAttempts ? ["verify" as const] : []), ...(attempts < maxAttempts ? ["choose" as const] : [])];
    return [...(work === "decide" ? ["rollback" as const, ...moves] : moves).map(name => transition(name, stepResult[work])), ...helpers];
  }
  const position = steps.indexOf(work);
  const forward = work === "rework" ? "verify" : steps[position + 1];
  const earlier = progress.playbook === "hillclimb" ? [] : steps.slice(0, position + 1)
    .filter(name => name === "trace" || name === "pin" || name === "shape" || name === "reproduce" || name === "diagnose");
  const result = progress.playbook !== "hillclimb" && (work === "baseline" || work === "measure") ? done : stepResult[work];
  return [transition(forward, result), ...earlier.map(name => transition(name, revisit)), ...helpers];
}

export function implementerTurn(state: ImplementerState) {
  if (state.kind !== "working") return undefined;
  const {input, playbook, attempts, records, consultations, feedback} = state.progress;
  const latest = records.filter(record => record === records.findLast(other => other.work === record.work));
  const choices = destinations(state);
  const {work} = state;
  const guidance = work === "how" || work === "why" ? investigationPrompt(work) :
    readFileSync(new URL(`../../../prompts/implementer/${implementerVersion}/${work}.md`, import.meta.url), "utf8").trim();
  const method = work === "diagnose" ? pstackGuidance("principle-fix-root-causes", "design") :
    work === "verify" ? pstackGuidance("principle-prove-it-works", "implement") : "";
  return {id: state.id, work, context: structuredClone({input, playbook, attempts, records: latest,
    consultations: consultations.slice(-6), feedback, ...("returnTo" in state ? {question: state.question, evidence: state.evidence, returnTo: state.returnTo} : {})}),
    prompt: [guidance, method,
      "Choose the next Work State in the result tool's next field. Advance when the result supports it. Use revisit for missing earlier evidence, how to trace current behavior, why to check the rationale of a decision, and Consult for a question."].filter(Boolean).join("\n\n"),
    schema: Type.Union(choices)};
}

export function settleImplementerTurn(state: ImplementerState, event: {id: string; settled: boolean; result: unknown}): ImplementerState {
  if (state.kind !== "working" || !event.settled || event.id !== state.id) return state;
  const {next, result} = readTransition(Type.Union(destinations(state)), event.result);
  const {progress, work} = state;
  if (Value.Check(gap, result)) return {kind: "paused", previous: state, reason: "plan-gap", question: result.question, evidence: result.observation, stepId: result.stepId};
  if (Value.Check(unreproduced, result)) return {kind: "paused", previous: state, reason: "unreproduced", question: result.question,
    evidence: [result.attempts, result.observation].join("\n")};
  if (next === "lead-consult" && Value.Check(consult, result)) return {kind: "paused", previous: state, reason: "lead", question: result.question, evidence: result.evidence};
  if (isStep(work) && (next === "how" || next === "why") && Value.Check(investigationRequest, result)) {
    return investigate(progress, next, work, result.question);
  }
  if (isStep(work) && next === "consult" && Value.Check(consult, result)) {
    return investigate(progress, next, work, result.question, result.evidence);
  }
  if ("returnTo" in state && (Value.Check(answer, result) || Value.Check(investigationResult, result))) {
    return step({...progress, consultations: [...progress.consultations, {question: state.question, answer: result.answer, evidence: result.evidence}]}, state.returnTo);
  }
  if (!isStep(work)) throw new Error("Invalid Implementer transition.");
  if (Value.Check(retry, result) || Value.Check(revisit, result)) {
    if (!isStep(next)) throw new Error("Returning requires an Implementer step.");
    return step({...progress, feedback: result.observation}, next);
  }
  if (Value.Check(decision, result)) {
    const measurement = progress.records.findLast(entry => entry.result.kind === "measured")?.result;
    if (measurement?.kind !== "measured") throw new Error("A decision needs a measurement.");
    if ((next === "rollback") !== (result.verdict === "revert")) throw new Error("Reverted trials must go to Rollback.");
    if (measurement.regressionGate === "fail" && result.verdict === "keep") throw new Error("A failing regression gate cannot be kept.");
  }
  if (!Value.Check(Type.Union(Object.values(stepResult)), result)) throw new Error("Invalid Implementer step result.");
  const record: ImplementRecord = {work, result};
  const updated = {...progress, records: [...progress.records, record], attempts: progress.attempts + Number(work === "decide")};
  if (next === "handoff") return {kind: "handoff", progress: updated};
  if (!isStep(next)) throw new Error("Expected a next Implementer step.");
  return step(updated, next);
}

export function resumeImplementer(state: ImplementerState, answer: string): ImplementerState {
  if (state.kind !== "paused" || !answer.trim()) throw new Error("A paused Implementer needs an answer.");
  const {previous} = state;
  const progress = {...previous.progress, feedback: answer,
    consultations: [...previous.progress.consultations, {question: state.question, answer, evidence: state.evidence}]};
  return "returnTo" in previous ? step(progress, previous.returnTo) : step(progress, previous.work);
}
export function reworkImplementer(state: ImplementerState, feedback: string): ImplementerState {
  if (state.kind !== "handoff" || !feedback.trim()) throw new Error("Review rework needs a handoff and feedback.");
  return step({...state.progress, feedback}, "rework");
}

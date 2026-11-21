import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { TaskType } from "../transitions.ts";

export const implementerVersion = "0.1";
export type Playbook = "feature" | "refactoring" | "bug-fix" | "perf-issue" | "hillclimb" | "experiment" | "experiment-fix";
export const playbooks: Record<Playbook, readonly Work[]> = {
  feature: ["trace", "shape", "implement", "verify"],
  refactoring: ["pin", "shape", "implement", "verify"],
  "bug-fix": ["reproduce", "diagnose", "implement", "verify"],
  "perf-issue": ["baseline", "diagnose", "implement", "measure", "verify"],
  hillclimb: ["baseline", "choose", "experiment", "measure", "decide", "verify"],
  experiment: ["baseline", "experiment", "measure", "verify"],
  "experiment-fix": ["reproduce", "diagnose", "baseline", "experiment", "measure", "verify"],
};
export type Work = "trace" | "shape" | "pin" | "reproduce" | "diagnose" | "baseline" | "implement" | "experiment" | "measure" | "verify" | "rework" | "consult" | "choose" | "decide" | "rollback";
export type ImplementInput = {runId: string; taskType: TaskType; taskbook: string; tasks: readonly string[]; playbook?: Playbook; hillclimb?: {maxAttempts: number; minAttempts: number; target: string}};
const text = Type.String({minLength: 1, pattern: "\\S"});
const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, {additionalProperties: false});
const draftFact = object({text, source: text});
const done = object({draftFacts: Type.Optional(Type.Array(draftFact)), kind: Type.Literal("done"), summary: text, evidence: Type.Array(text, {minItems: 1})});
const consult = object({kind: Type.Literal("consult"), scope: Type.Union([Type.Literal("local"), Type.Literal("lead")]), question: text, evidence: text});
const answer = object({draftFacts: Type.Optional(Type.Array(draftFact)), kind: Type.Literal("answered"), answer: text, evidence: text});
const gap = object({kind: Type.Literal("plan-gap"), stepId: text, observation: text, question: text});
const reproduced = object({kind: Type.Literal("reproduced"), trigger: text, observed: text, evidence: text});
const unreproduced = object({kind: Type.Literal("unreproduced"), attempts: text, observation: text, question: text});
const baseline = object({kind: Type.Literal("baseline"), workload: text, metric: text, direction: Type.Union([Type.Literal("increase"), Type.Literal("decrease")]), value: text, harness: text, sensitivity: text, regressionGate: Type.Literal("pass")});
const chosen = object({kind: Type.Literal("chosen"), hypothesis: text, change: text});
const measured = object({kind: Type.Literal("measured"), before: text, after: text, workCount: text, errors: text, regressionGate: Type.Union([Type.Literal("pass"), Type.Literal("fail")]), evidence: text});
const decision = object({kind: Type.Literal("decision"), verdict: Type.Union([Type.Literal("keep"), Type.Literal("revert")]), next: Type.Union([Type.Literal("continue"), Type.Literal("stop")]), reason: text});
const verified = object({kind: Type.Literal("verified"), evidence: Type.Array(text, {minItems: 1}), summary: text, draftFacts: Type.Optional(Type.Array(draftFact))});
const retry = object({kind: Type.Literal("retry"), route: Type.Union([Type.Literal("implement"), Type.Literal("diagnose")]), observation: text});
export const implementerSchemas = {work: Type.Union([done, consult, gap]), consult: Type.Union([answer, gap])};
type Done = Static<typeof done>;
type Consultation = Static<typeof answer>;
type StageResult = Done | Static<typeof reproduced> | Static<typeof baseline> | Static<typeof chosen> | Static<typeof measured> | Static<typeof decision> | Static<typeof verified>;
type RecordEntry = {work: Work; result: StageResult};
type Checkpoint = {protocol: typeof implementerVersion; input: ImplementInput; playbook: Playbook; serial: number; index: number; records: RecordEntry[]; consultations: Consultation[]; feedback?: string; attempts: number; stopAfterRollback?: boolean};
type Working = {kind: "working"; checkpoint: Checkpoint; work: Work; id: string; question?: string; evidence?: string; returnTo?: Work};
export type ImplementerState = Working | {kind: "paused"; previous: Working; reason: "lead" | "plan-gap" | "unreproduced"; question: string; evidence: string; stepId?: string} | {kind: "handoff"; checkpoint: Checkpoint};

function next(checkpoint: Checkpoint, work: Work, extra: Partial<Pick<Working, "question" | "evidence" | "returnTo">> = {}): Working {
  const serial = checkpoint.serial + 1;
  return {kind: "working", checkpoint: {...checkpoint, serial}, work, id: `${checkpoint.input.runId}:implementer:${serial}`, ...extra};
}
export function startImplementer(input: ImplementInput): ImplementerState {
  if (!input.runId.trim() || !input.taskbook.trim() || !input.tasks.length || input.tasks.some(task => !task.trim())) throw new Error("Implementer needs a run, taskbook and ordered tasks.");
  const playbook = input.playbook ?? (input.taskType === "fix-feature" ? "bug-fix" : input.taskType === "fix-experiment" ? "experiment-fix" : input.taskType === "new-experiment" ? "experiment" : "feature");
  if (!playbooks[playbook]) throw new Error("Unknown implementation playbook.");
  if (playbook === "hillclimb" && (!input.hillclimb || !Number.isInteger(input.hillclimb.maxAttempts) || !Number.isInteger(input.hillclimb.minAttempts) || input.hillclimb.minAttempts < 1 || input.hillclimb.maxAttempts < input.hillclimb.minAttempts || !input.hillclimb.target.trim())) throw new Error("Hillclimb needs a target and valid attempt budget.");
  const checkpoint: Checkpoint = {protocol: implementerVersion, input: structuredClone(input), playbook, serial: 0, index: 0, attempts: 0, records: [], consultations: []};
  return next(checkpoint, playbooks[playbook][0]!);
}
function schemaFor(state: Working) {
  const options = [consult, gap];
  if (state.work === "consult") return implementerSchemas.consult;
  if (state.work === "reproduce") return Type.Union([reproduced, unreproduced, ...options]);
  if (state.work === "verify") return Type.Union([verified, retry, ...options]);
  if (state.checkpoint.playbook === "hillclimb") {
    if (state.work === "baseline") return Type.Union([baseline, ...options]);
    if (state.work === "choose") return Type.Union([chosen, ...options]);
    if (state.work === "measure") return Type.Union([measured, ...options]);
    if (state.work === "decide") return Type.Union([decision, ...options]);
  }
  return implementerSchemas.work;
}
export function implementerTurn(state: ImplementerState) {
  if (state.kind !== "working") return undefined;
  return {id: state.id, work: state.work, context: structuredClone({ ...state.checkpoint, question: state.question, evidence: state.evidence }),
    prompt: readFileSync(new URL(`../../../prompts/implementer/${implementerVersion}/${state.work}.md`, import.meta.url), "utf8").trim(),
    schema: schemaFor(state)};
}
export function settleImplementerTurn(state: ImplementerState, event: {id: string; settled: boolean; result: unknown}): ImplementerState {
  if (state.kind !== "working" || !event.settled || event.id !== state.id) return state;
  const schema = schemaFor(state);
  if (!Value.Check(schema, event.result)) throw new Error(`Invalid Implementer ${state.work} result.`);
  const result = structuredClone(event.result) as StageResult | Static<typeof consult> | Static<typeof answer> | Static<typeof gap> | Static<typeof unreproduced> | Static<typeof retry>;
  if (result.kind === "plan-gap") return {kind: "paused", previous: state, reason: "plan-gap", question: result.question, evidence: result.observation, stepId: result.stepId};
  if (result.kind === "unreproduced") return {kind: "paused", previous: state, reason: "unreproduced", question: result.question, evidence: `${result.attempts}\n${result.observation}`};
  if (result.kind === "retry") {
    const index = playbooks[state.checkpoint.playbook].indexOf(result.route);
    if (index < 0) return next(state.checkpoint, "rework");
    return next({...state.checkpoint, index}, result.route);
  }
  if (result.kind === "consult") {
    if (result.scope === "lead") return {kind: "paused", previous: state, reason: "lead", question: result.question, evidence: result.evidence};
    return next(state.checkpoint, "consult", {question: result.question, evidence: result.evidence, returnTo: state.work});
  }
  if (result.kind === "answered") return next({...state.checkpoint, consultations: [...state.checkpoint.consultations, result]}, state.returnTo!);
  let checkpoint = {...state.checkpoint, records: [...state.checkpoint.records, {work: state.work, result}]};
  if (state.checkpoint.playbook === "hillclimb") {
    if (result.kind === "decision") {
      const measurement = [...checkpoint.records].reverse().find(entry => entry.result.kind === "measured")?.result;
      if (measurement?.kind !== "measured") throw new Error("A decision needs a measurement.");
      if (measurement.regressionGate === "fail" && result.verdict === "keep") throw new Error("A failing regression gate cannot be kept.");
      const attempts = checkpoint.attempts + 1;
      const budget = checkpoint.input.hillclimb!;
      if (result.next === "stop" && attempts < budget.minAttempts) throw new Error("Hillclimb has not met its minimum attempts.");
      const stop = result.next === "stop" || attempts >= budget.maxAttempts;
      checkpoint = {...checkpoint, attempts, stopAfterRollback: stop};
      if (result.verdict === "revert") return next(checkpoint, "rollback");
      return next(checkpoint, stop ? "verify" : "choose");
    }
    if (state.work === "rollback") return next(checkpoint, checkpoint.stopAfterRollback ? "verify" : "choose");
    if (state.work === "choose") return next(checkpoint, "experiment");
    if (state.work === "experiment") return next(checkpoint, "measure");
    if (state.work === "measure") return next(checkpoint, "decide");
    if (state.work === "baseline") return next(checkpoint, "choose");
    if (state.work === "verify") return {kind: "handoff", checkpoint};
  }
  if (state.work === "rework") return next({...checkpoint, index: playbooks[checkpoint.playbook].length - 1}, "verify");
  const index = checkpoint.index + 1;
  return index >= playbooks[checkpoint.playbook].length ? {kind: "handoff", checkpoint: {...checkpoint, index}} : next({...checkpoint, index}, playbooks[checkpoint.playbook][index]!);
}
export function resumeImplementer(state: ImplementerState, answer: string): ImplementerState {
  if (state.kind !== "paused" || !answer.trim()) throw new Error("A paused Implementer needs an answer.");
  const checkpoint = {...state.previous.checkpoint, consultations: [...state.previous.checkpoint.consultations, {kind: "answered" as const, answer, evidence: state.evidence}]};
  return next(checkpoint, state.previous.work, {question: state.previous.question, evidence: state.previous.evidence, returnTo: state.previous.returnTo});
}
export function reworkImplementer(state: ImplementerState, feedback: string): ImplementerState {
  if (state.kind !== "handoff" || !feedback.trim()) throw new Error("Review rework needs a handoff and feedback.");
  return next({...state.checkpoint, feedback}, "rework");
}

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { startImplementer, implementerTurn, settleImplementerTurn, resumeImplementer, reworkImplementer } from "../src/workflow/implement/v0.1.ts";

test("fix experiment progresses through verified handoff and review rework", () => {
  let state = startImplementer({runId: "run", taskType: "fix-experiment", taskbook: "approved", tasks: ["first", "second"]});
  for (const work of ["reproduce", "diagnose", "baseline", "experiment", "measure", "verify"]) {
    const turn = implementerTurn(state)!;
    assert.equal(turn.work, work);
    state = settleImplementerTurn(state, {id: turn.id, settled: true, result: work === "reproduce" ? {kind: "reproduced", trigger: "run", observed: "failure", evidence: "output"} : work === "verify" ? {kind: "verified", summary: work, evidence: ["observed output"]} : {kind: "done", summary: work, evidence: ["observed output"]}});
    state = JSON.parse(JSON.stringify(state));
  }
  assert.equal(state.kind, "handoff");
  state = reworkImplementer(state, "review finding");
  assert.equal(implementerTurn(state)?.work, "rework");
  const turn = implementerTurn(state)!;
  state = settleImplementerTurn(state, {id: turn.id, settled: true, result: {kind: "done", summary: "fixed", evidence: ["diff"]}});
  assert.equal(implementerTurn(state)?.work, "verify");
});

test("consult routes locally or to Lead and resumes the same work", () => {
  let state = startImplementer({runId: "run", taskType: "new-feature", taskbook: "approved", tasks: ["task"]});
  let turn = implementerTurn(state)!;
  state = settleImplementerTurn(state, {id: turn.id, settled: true, result: {kind: "consult", scope: "local", question: "where?", evidence: "trace"}});
  turn = implementerTurn(state)!;
  assert.equal(turn.work, "consult");
  state = settleImplementerTurn(state, {id: turn.id, settled: true, result: {kind: "answered", answer: "here", evidence: "source", draftFacts: [{text: "fact", source: "file"}]}});
  turn = implementerTurn(state)!;
  assert.equal(turn.work, "trace");
  assert.equal(turn.context.consultations[0]?.draftFacts?.[0]?.text, "fact");
  state = settleImplementerTurn(state, {id: turn.id, settled: true, result: {kind: "consult", scope: "lead", question: "scope?", evidence: "gap"}});
  assert.equal(state.kind, "paused");
  state = resumeImplementer(state, "approved scope");
  assert.equal(implementerTurn(state)?.work, "trace");
});


test("hillclimb rolls back a rejected attempt before the next and respects budget", () => {
  let state = startImplementer({runId: "r", taskType: "new-experiment", taskbook: "approved", tasks: ["improve"], playbook: "hillclimb", hillclimb: {minAttempts: 2, maxAttempts: 2, target: "half latency"}});
  function submit(work: string, result: object) {
    const turn = implementerTurn(state)!;
    assert.equal(turn.work, work);
    state = settleImplementerTurn(state, {id: turn.id, settled: true, result});
  }
  submit("baseline", {kind: "baseline", workload: "real", metric: "latency", direction: "decrease", value: "10", harness: "run", sensitivity: "contrast", regressionGate: "pass"});
  for (let i = 0; i < 2; i++) {
    submit("choose", {kind: "chosen", hypothesis: "less work", change: "remove operation"});
    submit("experiment", {kind: "done", summary: "changed", evidence: ["diff"]});
    submit("measure", {kind: "measured", before: "10", after: "11", workCount: "1", errors: "0", regressionGate: "pass", evidence: "output"});
    submit("decide", {kind: "decision", verdict: "revert", next: "continue", reason: "slower"});
    submit("rollback", {kind: "done", summary: "reverted", evidence: ["diff"]});
  }
  submit("verify", {kind: "verified", summary: "verified", evidence: ["run"]});
  assert.equal(state.kind, "handoff");
});

test("failed reproduction pauses and failed verification routes to diagnosis", () => {
  let state = startImplementer({runId: "r", taskType: "fix-feature", taskbook: "approved", tasks: ["fix"]});
  let turn = implementerTurn(state)!;
  state = settleImplementerTurn(state, {id: turn.id, settled: true, result: {kind: "unreproduced", attempts: "tried", observation: "passes", question: "what environment?"}});
  assert.equal(state.kind, "paused");
  state = resumeImplementer(state, "environment");
  for (const result of [{kind: "reproduced", trigger: "run", observed: "fail", evidence: "log"}, {kind: "done", summary: "cause", evidence: ["trace"]}, {kind: "done", summary: "fix", evidence: ["diff"]}]) {
    turn = implementerTurn(state)!;
    state = settleImplementerTurn(state, {id: turn.id, settled: true, result});
  }
  turn = implementerTurn(state)!;
  state = settleImplementerTurn(state, {id: turn.id, settled: true, result: {kind: "retry", route: "diagnose", observation: "still fails"}});
  assert.equal(implementerTurn(state)?.work, "diagnose");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { designerTurns, settleDesignerTurn, answerDesigner, startDesigner, type DesignerState } from "../src/workflow/designer/v0.2.ts";
import { designers, type Designer } from "../src/workflow/designer/protocol-v0.1.ts";

const input = {runId: "taskbook", taskbook: "Generate a TSV", baseline: "base", factsVersion: "facts",
  facts: ["F1: column order is fixed"], targetIds: ["G1", "D1"]};
const draft = {kind: "draft", draft: {goal: "Generate a tab-delimited report", facts: []}};

function submit(state: DesignerState, designer: Designer, result: unknown) {
  const turn = designerTurns(state).find(turn => turn.designer === designer);
  assert.ok(turn);
  return settleDesignerTurn(state, {id: turn.id, settled: true, result});
}

function confirmPlan(state: DesignerState, appliedIssues: string[] = []) {
  state = submit(state, "lead", {kind: "synthesize", draft: draft.draft, appliedIssues,
    plan: {steps: [{id: "TSV", action: "Write the report", checks: "Check its header", targets: ["G1", "D1"]}]}});
  const first = designerTurns(state)[0];
  const materials = first.context.materials;
  assert.ok(materials && "candidate" in materials);
  const {version} = materials.candidate;
  const vote = {kind: "approved", version};
  for (const member of ["member-a", "member-b"] as const) state = submit(state, member, vote);
  return {state, vote, oldWork: first.id};
}

test("Design waits for the Lead to sign both member votes for the exact plan", () => {
  let state = startDesigner(input);
  for (const designer of designers) state = submit(state, designer, draft);
  for (const designer of designers) {
    state = submit(state, designer, {kind: "compare", reviews: designers.filter(id => id !== designer).map(id => ({designer: id, changes: []}))});
  }
  const first = confirmPlan(state);
  state = first.state;
  assert.equal(state.kind, "working");
  assert.equal(state.work, "lead-decision");
  assert.deepEqual(designerTurns(state).map(turn => turn.designer), ["lead"]);
  assert.equal(settleDesignerTurn(state, {id: first.oldWork, settled: true, result: first.vote}), state);
  assert.throws(() => submit(state, "lead", {kind: "approved", version: "stale"}), /confirmed plan version/);
  state = submit(state, "lead", {kind: "revise", changes: [{section: "Goal", target: "report",
    proposal: "Write the header for empty input", reason: "Retain a valid schema for an empty report"}]});
  const reconsideration = designerTurns(state);
  assert.deepEqual(reconsideration.map(turn => [turn.designer, turn.work]), [["member-a", "respond"], ["member-b", "respond"]]);
  const accepted = reconsideration.flatMap(turn => {
    const materials = turn.context.materials;
    assert.ok(materials && "issues" in materials);
    const responses = materials.issues.map(({id}) => ({issue: id, decision: "accept"}));
    state = submit(state, turn.designer, {kind: "respond", responses});
    return responses.map(response => response.issue);
  });
  assert.equal(designerTurns(state)[0]?.work, "synthesize");
  const second = confirmPlan(state, accepted);
  assert.notEqual(second.vote.version, first.vote.version);
  state = submit(second.state, "lead", second.vote);
  assert.equal(state.kind, "approved");
  assert.equal(state.signedBy, "lead");
  assert.equal(state.candidate.version, second.vote.version);
});

test("A member proposal cannot pause for the user until Lead requests a decision", () => {
  let state = startDesigner(input);
  state = submit(state, "member-a", draft);
  const previous = designerTurns(state).find(turn => turn.designer === "member-b");
  assert.ok(previous);
  assert.match(previous.prompt, /Lead Designer decides/);
  state = submit(state, "member-b", {kind: "needs-user", question: "Which column order?", evidence: "Baseline contradicts F1", factId: "F1"});
  assert.equal(state.kind, "working");
  assert.deepEqual(designerTurns(state).map(turn => turn.designer), ["lead"]);
  assert.throws(() => submit(state, "lead", {kind: "resume", instructions: "Ignore F1"}), /Invalid Lead/);
  state = submit(state, "lead", {kind: "needs-user", question: "Confirm the column order for this task.", evidence: "The baseline differs from F1"});
  assert.equal(state.kind, "paused");
  assert.equal(state.factId, "F1");
  assert.deepEqual(designerTurns(state), []);
  state = answerDesigner(state, "Follow the order in F1.");
  const turns = designerTurns(state);
  assert.deepEqual(turns.map(turn => turn.designer), ["lead", "member-b"]);
  assert.equal(turns[1].context.authority.at(-1)?.text, "Follow the order in F1.");
  assert.notEqual(turns[1].id, previous.id);
  assert.equal(settleDesignerTurn(state, {id: previous.id, settled: true, result: draft}), state);
  state = submit(state, "lead", draft);
  state = submit(state, "member-b", draft);
  assert.equal(designerTurns(state)[0]?.work, "compare");
});

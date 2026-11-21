import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { designerTurns, settleDesignerTurn, startDesigner, type DesignerState } from "../src/workflow/designer/v0.1.ts";
import { designers, type Designer } from "../src/workflow/designer/protocol-v0.1.ts";

const input = {runId: "fixture", taskbook: "Export a report as TSV.", baseline: "base", factsVersion: "facts-1",
  facts: ["The public entry point is report."], targetIds: ["G1", "D1"]};
const proposal = {section: "Goal", target: "Keep the report readable", proposal: "Show column headings for empty reports.", reason: "Consumers parse the first row."};
const counter = {proposal: "Always output the defined TSV header.", reason: "The header is part of the contract."};

function submit(state: DesignerState, designer: Designer, result: unknown) {
  const turn = designerTurns(state).find(item => item.designer === designer);
  assert.ok(turn);
  assert.ok(Value.Check(turn.schema, result), JSON.stringify(result));
  return settleDesignerTurn(state, {id: turn.id, settled: true, result});
}

function finishDrafts(state = startDesigner(input)) {
  for (const designer of ["member-b", "lead", "member-a"] as const) {
    const turn = designerTurns(state).find(item => item.designer === designer);
    assert.equal(turn?.work, "draft");
    assert.equal(turn.context.materials, null);
    assert.match(turn.prompt, /independent design/);
    state = submit(state, designer, {kind: "draft", draft: {goal: designer + " writes a TSV report.", facts: []}});
  }
  return state;
}

function finishComparisons(state: DesignerState) {
  for (const designer of ["member-a", "lead", "member-b"] as const) {
    const turn = designerTurns(state).find(item => item.designer === designer);
    assert.equal(turn?.work, "compare");
    assert.match(turn.prompt, /both peer drafts/);
    const peers = designers.filter(id => id !== designer);
    assert.throws(() => submit(state, designer, {kind: "compare", reviews: peers.map(() => ({designer, changes: []}))}), /each peer/);
    state = submit(state, designer, {kind: "compare", reviews: peers.map(id => ({designer: id,
      changes: designer === "lead" && id === "member-a" ? [proposal] : []}))});
  }
  return state;
}

function assignedIssue(state: DesignerState) {
  const turn = designerTurns(state)[0];
  assert.ok(turn.context.materials && "issues" in turn.context.materials);
  return turn.context.materials.issues[0].id;
}

test("Designer 0.1 uses each state prompt and requires settled, version-matched results", () => {
  let state = startDesigner(input);
  const initial = designerTurns(state)[0];
  assert.equal(settleDesignerTurn(state, {id: initial.id, settled: false, result: {}}), state);
  assert.throws(() => settleDesignerTurn(state, {id: initial.id, settled: true, result: {kind: "draft",
    draft: {goal: "Goal", facts: [], delivery: "A different delivery"}}}), /Invalid Designer draft result/);
  state = submit(state, "lead", {kind: "consult", question: "Which public command owns TSV export?", evidence: "Two callers are possible."});
  const consult = designerTurns(state).find(turn => turn.designer === "lead");
  assert.equal(consult?.work, "consult");
  assert.match(consult.prompt, /recorded question/);
  state = submit(state, "lead", {kind: "answered", answer: "Use report.", basis: "Taskbook F1", draftFacts: []});
  const resumed = designerTurns(state).find(turn => turn.designer === "lead");
  assert.equal(resumed?.work, "draft");
  assert.equal(resumed.context.consultations[0]?.result.answer, "Use report.");
  assert.equal(designerTurns(state).find(turn => turn.designer === "member-a")?.context.consultations.length, 0);
  assert.equal(settleDesignerTurn(state, {id: initial.id, settled: true, result: {}}), state);

  state = finishComparisons(finishDrafts(state));
  const issue = assignedIssue(state);
  assert.match(designerTurns(state)[0].prompt, /each issue addressed to you/);
  state = submit(state, "member-a", {kind: "respond", responses: [{issue, decision: "counter", ...counter}]});
  assert.deepEqual(designerTurns(state).map(turn => turn.designer), ["lead", "member-b"]);
  assert.match(designerTurns(state)[0].prompt, /current proposal/);
  state = submit(state, "member-b", {kind: "reconcile", responses: [{issue, decision: "accept"}]});
  assert.equal(designerTurns(state)[0].work, "reconcile");
  state = submit(state, "lead", {kind: "reconcile", responses: [{issue, decision: "accept"}]});
  state = submit(state, "member-a", {kind: "respond", responses: [{issue, decision: "accept"}]});

  const final = {kind: "synthesize", draft: {goal: "Output a TSV report with its header.", facts: []}, appliedIssues: [issue],
    plan: {steps: [{id: "report", action: "Write the header before rows", checks: "Run report with no rows", targets: ["G1", "D1"]}]}};
  assert.match(designerTurns(state)[0].prompt, /every resolved issue/);
  assert.throws(() => submit(state, "lead", {...final, appliedIssues: []}), /all resolved issues/);
  state = submit(state, "lead", final);
  const confirmation = designerTurns(state)[0];
  assert.match(confirmation.prompt, /exact `version`/);
  assert.ok(confirmation.context.materials && "candidate" in confirmation.context.materials);
  const {version} = confirmation.context.materials.candidate;
  assert.throws(() => submit(state, "member-b", {kind: "approved", version: "old-version"}), /current candidate version/);
  state = submit(state, "member-b", {kind: "approved", version});
  assert.equal(state.kind, "working");
  state = submit(state, "member-a", {kind: "objected", version, changes: [{...proposal, target: "TSV header", proposal: "Use the published column order."}]});
  const objection = assignedIssue(state);
  state = submit(state, "lead", {kind: "respond", responses: [{issue: objection, decision: "accept"}]});
  state = submit(state, "lead", {...final, appliedIssues: [issue, objection], draft: {...final.draft,
    goal: "Output a TSV report with its header in the published column order."}});
  const renewed = designerTurns(state)[0].context.materials;
  assert.ok(renewed && "candidate" in renewed);
  assert.notEqual(renewed.candidate.version, version);
  assert.throws(() => submit(state, "member-a", {kind: "approved", version}), /current candidate version/);
  state = submit(state, "member-a", {kind: "approved", version: renewed.candidate.version});
  assert.equal(state.kind, "working");
  state = submit(state, "member-b", {kind: "approved", version: renewed.candidate.version});
  assert.equal(state.kind, "approved");
  assert.equal(state.candidate.version, renewed.candidate.version);
  assert.deepEqual(designerTurns(state), []);
});

test("Designer 0.1 pauses the group when Consult encounters a protected fact", () => {
  let state = startDesigner(input);
  state = submit(state, "member-a", {kind: "draft", draft: {goal: "Build the export command.", facts: []}});
  state = submit(state, "lead", {kind: "consult", question: "Which command owns the export?", evidence: "F1 and the baseline disagree."});
  state = submit(state, "lead", {kind: "needs-user", question: "Should F1 be updated?", evidence: "The current entry point is export.", factId: "F1"});
  assert.equal(state.kind, "paused");
  assert.equal(state.factId, "F1");
  assert.ok(state.previous.slots.some(slot => slot.job.designer === "member-a" && slot.reply?.kind === "draft"));
  assert.deepEqual(designerTurns(state), []);
});

test("Designer 0.1 preserves a checkpoint when peer objections repeat", () => {
  let state = finishComparisons(finishDrafts());
  const issue = assignedIssue(state);
  const response = {kind: "respond", responses: [{issue, decision: "counter", ...counter}]};
  state = submit(state, "member-a", response);
  state = submit(state, "lead", {kind: "reconcile", responses: [{issue, decision: "accept"}]});
  state = submit(state, "member-b", {kind: "reconcile", responses: [{issue, decision: "counter",
    proposal: proposal.proposal, reason: proposal.reason}]});
  assert.throws(() => submit(state, "member-a", {kind: "respond", responses: [{issue, decision: "accept"}]}), /peer objection/);
  state = submit(state, "member-a", response);
  assert.equal(state.kind, "paused");
  assert.match(state.evidence, new RegExp(issue));
  assert.equal(state.previous.checkpoint.drafts.length, 3);
  assert.deepEqual(designerTurns(state), []);
});

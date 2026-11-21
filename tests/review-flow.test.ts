import assert from "node:assert/strict";
import test from "node:test";
import { answerReviewUser, reviewTurns, settleReviewTurn, startReviewFlow, type ReviewFlow } from "../src/workflow/review/flow.ts";

const input = { runId: "task-1", goals: [{ id: "goal-1", text: "Retain completed work when a run is retried." }],
  candidate: { revision: "revision-1", evidenceVersion: "evidence-1" } };
const pass = { kind: "pass", summary: "The candidate meets the goal.", evidence: ["receipt-1"] };
const finding = { issue: "retry loses completion", detail: "Use the existing completion receipt on retry.", evidence: ["receipt-2"] };
const changes = { kind: "changes", summary: "Retry loses completed work.", findings: [finding] };
const approve = { kind: "approve", summary: "Both members reviewed the candidate and its draft facts." };
const rework = { kind: "rework", summary: "Address the review finding and submit a revised candidate." };

function submit(state: ReviewFlow, designer: "member-a" | "member-b" | "lead", result: unknown) {
  const turn = reviewTurns(state).find(item => item.designer === designer);
  assert(turn, `No Review turn for ${designer}`);
  return settleReviewTurn(state, { id: turn.id, settled: true, result });
}

test("Review requires Member A, an independent Member B, both comparison replies, and Lead sign-off", () => {
  let state = startReviewFlow(input);
  const [initial] = reviewTurns(state);
  assert.equal(initial.designer, "member-a");
  assert.equal(initial.work, "initial-first");
  assert.deepEqual(initial.context, { goals: input.goals });
  assert.throws(() => submit(state, "member-a", { kind: "pass", summary: "Looks good." }), /Invalid initial-first/);

  const disposition = { id: "draft-9", decision: "keep", evidence: ["receipt-1"] };
  state = submit(state, "member-a", { ...pass, draftFacts: [disposition] });
  const [cross] = reviewTurns(state);
  assert.equal(cross.designer, "member-b");
  assert.equal(cross.work, "cross-first");
  assert.equal(cross.cleanContext, true);
  assert.deepEqual(cross.context, { goals: input.goals });
  state = submit(state, "member-b", { ...pass, draftFacts: [{ ...disposition, evidence: ["receipt-3"] }] });
  const comparisons = reviewTurns(state);
  assert.deepEqual(comparisons.map(({ designer, work }) => [designer, work]), [["member-a", "compare"], ["member-b", "compare"]]);

  state = submit(state, "member-b", pass);
  assert.deepEqual(reviewTurns(state).map(turn => turn.designer), ["member-a"]);
  const duplicate = settleReviewTurn(state, { id: comparisons[1].id, settled: true, result: changes });
  assert.equal(duplicate, state);
  state = submit(state, "member-a", pass);
  assert.deepEqual(reviewTurns(state).map(turn => turn.designer), ["lead"]);
  state = submit(state, "lead", approve);
  assert.equal(state.kind, "approved");
  assert.deepEqual(state.draftFacts, [{ ...disposition, evidence: ["receipt-1", "receipt-3"] }]);
});

test("Revised material invalidates old Review turns and return always begins with Member A", () => {
  let state = startReviewFlow(input);
  state = submit(state, "member-a", changes);
  assert.throws(() => submit(state, "lead", approve), /both members/);
  state = submit(state, "lead", rework);
  assert.equal(state.kind, "rework");
  assert.equal(startReviewFlow({ ...input, previous: state }), state);
  state = startReviewFlow({ ...input, previous: state, candidate: { ...input.candidate, revision: "revision-2" } });
  const [initialRework] = reviewTurns(state);
  assert.equal(initialRework.work, "initial-rework");
  assert.deepEqual(initialRework.context.priorFindings, [{ issue: finding.issue, detail: finding.detail }]);
  state = submit(state, "member-a", pass);
  assert.equal(reviewTurns(state)[0].work, "cross-first");
  state = submit(state, "member-b", pass);
  const stale = reviewTurns(state)[0];

  state = startReviewFlow({ ...input, previous: state, candidate: { revision: "revision-2", evidenceVersion: "evidence-2" } });
  assert.equal(reviewTurns(state)[0].work, "initial-rework");
  assert.equal(settleReviewTurn(state, { id: stale.id, settled: true, result: pass }), state);
  state = submit(state, "member-a", pass);
  const [crossRepeat] = reviewTurns(state);
  assert.equal(crossRepeat.work, "cross-repeat");
  assert.equal(crossRepeat.cleanContext, true);
  assert.notEqual(crossRepeat.prompt, initialRework.prompt);
});

test("Unresolved member disagreement reaches the user through Lead and can resume after serialization", () => {
  let state = startReviewFlow(input);
  state = submit(state, "member-a", pass);
  state = submit(state, "member-b", changes);
  const alternative = { ...changes, findings: [{ ...finding, detail: "Create a new receipt for each retry." }] };
  for (const work of ["compare", "respond", "reconcile"]) {
    assert.deepEqual(reviewTurns(state).map(turn => turn.work), [work, work]);
    state = submit(state, "member-a", alternative);
    state = submit(state, "member-b", changes);
  }
  assert.throws(() => submit(state, "lead", rework), /must ask the user/);
  state = submit(state, "lead", { kind: "ask-user", summary: "The members support incompatible retry behavior.",
    question: "Should a retry reuse the existing receipt?" });
  assert.equal(state.kind, "needs-user");
  assert.deepEqual(reviewTurns(state), []);
  state = answerReviewUser(JSON.parse(JSON.stringify(state)), "Reuse the existing receipt.");
  assert.equal(reviewTurns(state)[0].context.userAnswer, "Reuse the existing receipt.");
  assert.throws(() => submit(state, "lead", rework), /actionable finding/);
  state = submit(state, "lead", { ...rework, selected: [{ issue: finding.issue, detail: finding.detail }] });
  assert.equal(state.kind, "rework");
  assert.deepEqual(state.findings, [finding]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { taskMemory, parseFactDecision, validateConflict, workerContext } from "../src/workflow/task-context.ts";
import type { CheckedFact } from "../src/facts/fact-check.ts";

const document = {
  markdown: [
    "## Goal", "Type: new-feature", "1. Move outputs while preserving explicit paths.", "2. Provide a readback command.",
    "## Facts", "1. The baseline writes to ../build.", "   ```console", "1. This example is not a second fact.",
    "## Delivery", "   ```", "2. The verifier reads a fixed path.", "## Delivery", "Provide the package.",
  ].join("\n"),
  facts: "1. A separate first-party reference.",
};
const observation: CheckedFact = {
  claim: "The CLI accepts -o.", observed: "--output", source: { kind: "git", path: "cli.ts", line: 12 }, origin: "base:cli.ts:12",
};

test("taskbook item IDs preserve authored numbering and fenced content", () => {
  const { goals, facts, delivery } = taskMemory(document);
  assert.deepEqual(goals.map(x => x.id), ["G1", "G2"]);
  assert.deepEqual(facts.map(x => x.id), ["F1", "F2", "AF1"]);
  assert.match(facts[0].text, /## Delivery/);
  assert.deepEqual(delivery, [{ id: "D1", text: "Provide the package." }]);
});

test("unstructured goals keep their full text and external-only facts retain F IDs", () => {
  const memory = taskMemory({ markdown: "## Goal\nType: fix-feature\nFix the signal.\nRetain the log.\n## Delivery\nA passing check.", facts: "Exact old signal." });
  assert.deepEqual(memory.goals, [{ id: "G1", text: "Fix the signal.\nRetain the log." }]);
  assert.deepEqual(memory.facts, [{ id: "F1", text: "Exact old signal." }]);
});

test("only the named pending fact can be decided, and the original remains available", () => {
  const before = taskMemory(document, [], [observation]);
  const conflict = { factId: "F1", observation: "The baseline now resolves another directory." };
  validateConflict(before.facts, conflict);
  assert.throws(() => validateConflict(before.facts, { ...conflict, factId: "F7" }));
  assert.throws(() => parseFactDecision("F2 replace abc", conflict));
  assert.throws(() => parseFactDecision("F1 replace", conflict));
  const replace = parseFactDecision("F1 replace The authorized baseline is /tmp/out.", conflict);
  const keep = parseFactDecision("F1 keep Corroborated by the pinned release.", conflict);
  const after = taskMemory(document, [replace, keep], [observation, observation]);
  assert.equal(after.facts[0].text, replace.text);
  assert.equal(after.facts[0].userDecision?.text, keep.text);
  assert.equal(after.facts.filter(item => item.id.startsWith("V")).length, 1);
  assert.deepEqual(before.facts.slice(1), after.facts.slice(1));
  assert.match(before.facts[0].text, /\.\.\/build/);
});

test("repeated Markdown list ordinals still identify every goal uniquely", () => {
  const parsed = taskMemory({ markdown: "## Goal\n1. First\n1. Second\n1. Third\n## Delivery\nA single outcome." });
  assert.deepEqual(parsed.goals.map(item => item.id), ["G1", "G2", "G3"]);
});


test("worker memory contains the current gap and excludes superseded approvals", () => {
  const reports = [
    { phase: "fact-review", outcome: "rework", summary: "recheck baseline output", evidence: ["receipt mismatch"] },
    { phase: "design", outcome: "pass", summary: "keep explicit paths", evidence: ["G1"] },
    { phase: "implement", outcome: "pass", summary: "old candidate", evidence: ["first attempt"] },
    { phase: "correctness", outcome: "pass", summary: "old approval", evidence: ["superseded"] },
    { phase: "quality", outcome: "rework", summary: "retry overwrites another backend", evidence: ["changed path"] },
  ] as const;
  const history = reports.map(item => ({ ...item, evidence: [...item.evidence] }));
  assert.deepEqual(workerContext("fact-check", history.slice(0, 1)).map(r => r.summary), ["recheck baseline output"]);
  assert.deepEqual(workerContext("implement", history).map(r => r.summary), ["keep explicit paths", "retry overwrites another backend"]);
});

test("measurement receives the request for the current candidate only", () => {
  const candidate = { phase: "implement" as const, outcome: "pass", summary: "candidate", evidence: ["sha"] };
  const stale = { phase: "quality" as const, outcome: "measure", summary: "stale request", evidence: [] };
  const request = { phase: "correctness" as const, outcome: "measure", summary: "measure current goal", evidence: ["G1"] };
  assert.deepEqual(workerContext("performance", [stale, candidate]), [candidate]);
  assert.deepEqual(workerContext("performance", [stale, candidate, request]), [candidate, request]);
});

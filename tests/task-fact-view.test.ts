import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryProjectFacts } from "../src/facts/query.ts";
import { importTaskFacts, readTopicFacts } from "../src/facts/taskbook-intake.ts";
import { readProjectMemory } from "../src/facts/project-memory.ts";
import { git, type Taskbook } from "../src/taskbook/document.ts";
import { taskAuthoredFacts } from "../src/workflow/task-context.ts";
import { registerReviewedFacts } from "../src/workflow/register-facts.ts";
import type { Run } from "../src/workflow/checkpoint.ts";

const table = (rows: string) => "id\tfact\tsource\tlabels\n" + rows;
function repository() {
  const root = mkdtempSync(join(tmpdir(), "task-fact-view-"));
  git(root, "init", "-q");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "--allow-empty", "-qm", "base");
  return root;
}

function input(root: string, markdown: string) {
  const task: Taskbook = {id: "sample", digest: "a".repeat(64), markdown, type: "new-feature", repository: "local/test", sourcePath: ""};
  const base = git(root, "rev-parse", "HEAD");
  return {root, task, base, sessionId: "session", memoryChanges: [], items: taskAuthoredFacts(markdown),
    expectedHead: readTopicFacts(root).head, project: readProjectMemory(root)};
}
function runFor(args: ReturnType<typeof input>, staged: Extract<ReturnType<typeof importTaskFacts>, {kind: "complete"}>): Run {
  const {root, task, base} = args;
  return {root, task, path: join(root, ".git", "state.json"),
    state: {base, digest: task.digest, session: "session", phase: "fact-registration", version: 3, reviewPolicy: 2, reports: [], branch: "fixture",
      revision: base, topicFactsHead: staged.head, approvedProjectHead: staged.projectHead, factView: staged.view, taskFacts: staged.facts,
      team: {review: {kind: "approved", checkpoint: {runId: task.id, goals: [], candidate: {revision: base, evidenceVersion: "test"},
        epoch: 1, serial: 1, everCrossed: true, priorFindings: []}, draftFacts: [], summary: "accepted"}}}};
}

test("stages all operations without a commit, queries the recovered view and registers the signed candidate once", async () => {
  const root = repository();
  try {
    const path = ".fact/product.tsv";
    mkdirSync(join(root, ".fact"));
    writeFileSync(join(root, path), table("one\tOld value.\tbaseline\t\ntwo\tUnneeded value.\tbaseline\t\nthree\tKeep this fact.\tbaseline\t\n"));
    writeFileSync(join(root, ".fact/label.tsv"), "label\tdescription\ncustom\tCustom label\n");
    git(root, "add", ".fact");
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "subjects");
    const args = input(root, [
      "## Facts", "1. `create` · `.fact/domain.tsv` · `terms` — A Widget is a test component.",
      "2. `update` · `fact` — `Old value.`：New value.",
      "3. `delete` · `fact` — `Unneeded value.`：Removed from the design.",
      "4. `use` · `fact` — `three`", "5. A plain older taskbook fact."
    ].join("\n"));
    const staged = importTaskFacts({...args, targets: [{id: "F5", target: path}]});
    assert.equal(staged.kind, "complete");
    const run = runFor(args, staged);
    const recovered = JSON.parse(JSON.stringify(staged.view));
    const overlay = await queryProjectFacts(root, {query: recovered.label, limit: 10}, recovered);
    assert.deepEqual(overlay.matches.map(x => x.operation).sort(), ["create", "create", "delete", "update", "use"]);
    assert.equal((await queryProjectFacts(root, {query: "Unneeded"}, recovered)).matches.length, 0);
    assert.equal((await queryProjectFacts(root, {query: path + "#one"}, recovered)).matches[0].fact, "New value.");
    assert.equal((await queryProjectFacts(root, {query: path + "#one"})).matches[0].fact, "Old value.");
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(git(root, "rev-parse", "HEAD"), args.base);
    const unsigned = {...run, state: {...run.state, team: {}}};
    assert.throws(() => registerReviewedFacts(unsigned, []), /签署审核/);
    const receipt = registerReviewedFacts(run, []);
    assert.notEqual(receipt.revision, args.base);
    assert.equal(git(root, "rev-parse", "HEAD^"), args.base);
    assert.equal((await queryProjectFacts(root, {query: "terms"})).matches[0].fact, "A Widget is a test component.");
    assert.equal((await queryProjectFacts(root, {query: "one"})).matches[0].fact, "New value.");
    assert.equal((await queryProjectFacts(root, {query: path + "#two"})).matches.length, 0);
    assert.equal((await queryProjectFacts(root, {query: recovered.label})).matches.length, 0);
    assert.match(readFileSync(join(root, ".fact/label.tsv"), "utf8"), /custom\tCustom label\nterms\t/);
    const restored = {...run, state: JSON.parse(readFileSync(run.path, "utf8"))};
    assert.deepEqual(registerReviewedFacts(restored, []), receipt);
    assert.equal(git(root, "status", "--porcelain"), "");
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("first term on a new project survives a failed registration and retry", async () => {
  const root = repository();
  try {
    const args = input(root, "## Facts\n1. `create` · `.fact/glossary/domain.tsv` · `terms` — A Domain is a set of outcomes.");
    const staged = importTaskFacts(args);
    assert.equal(staged.kind, "complete");
    const run = runFor(args, staged);
    assert.equal((await queryProjectFacts(root, {query: "terms"}, staged.view)).matches.length, 1);
    assert.equal(existsSync(join(root, ".fact")), false);
    const hook = join(root, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", {mode: 0o755});
    assert.throws(() => registerReviewedFacts(run, []));
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(existsSync(join(root, ".fact/label.tsv")), false);
    rmSync(hook);
    const receipt = registerReviewedFacts(run, []);
    assert.equal((await queryProjectFacts(root, {query: "terms"})).matches.length, 1);
    const parent = git(root, "rev-parse", "HEAD^");
    assert.equal(parent, args.base);
    assert.equal(receipt.revision, git(root, "rev-parse", "HEAD"));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("an agent mapping cannot redirect an explicit missing or retired target", () => {
  const root = repository();
  try {
    mkdirSync(join(root, ".fact"));
    writeFileSync(join(root, ".fact/other.tsv"), table("live\tStill valid.\tbaseline\t\n"));
    for (const selector of [".fact/removed.tsv#gone", "old-id", "A factual statement that used to be present."]) {
      const args = input(root, "## Facts\n1. `delete` · `fact` — `" + selector + "`：Retired.");
      const result = importTaskFacts({...args, targets: [{id: "F1", target: ".fact/other.tsv#live"}]});
      assert.equal(result.kind, "conflict");
      const authorized = importTaskFacts({...args, decisions: [{id: "F1", action: "delete", detail: ".fact/other.tsv#live"}]});
      assert.equal(authorized.kind, "complete");
      assert.equal(authorized.view.entries[0].operation, "delete");
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("resuming an old committed intake acknowledges its deletion and never resurrects its superseded creation", () => {
  const root = repository();
  try {
    mkdirSync(join(root, ".fact"));
    const path = join(root, ".fact/old.tsv");
    writeFileSync(path, table("retired\tHistorical value.\tprior\t\n"));
    const commit = (message: string) => {
      git(root, "add", ".fact");
      git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", message);
    };
    commit("before old intake");
    const args = input(root, "## Facts\n1. `delete` · `fact` — `retired`：Retire the old fact.");
    writeFileSync(path, table(""));
    commit("Import taskbook facts\n\nTaskbook-Input: " + args.task.digest);
    const state = {...args, expectedHead: readTopicFacts(root).head};
    const restored = importTaskFacts(state);
    assert.equal(restored.kind, "complete");
    assert.deepEqual(restored.view.entries, []);
    const creation = {id: "F1", text: "`create` · `.fact/old.tsv` — Previously removed."};
    assert.equal(importTaskFacts({...state, items: [creation]}).kind, "conflict");
  } finally { rmSync(root, {recursive: true, force: true}); }
});

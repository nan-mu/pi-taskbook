import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { applyApprovedMemory, historicalProjectFacts, pendingMemoryChanges, projectFacts, projectMemoryRef, readProjectMemory,
  taskbookMemoryChanges } from "../project-memory.ts";
import type { CheckedFact } from "../fact-check.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
function repository(t: TestContext) {
  const box = mkdtempSync(join(tmpdir(), "pi-taskbook-memory-"));
  t.after(() => rmSync(box, {recursive: true, force: true}));
  const root = join(box, "repo");
  git(box, "init", "-q", root);
  git(root, "-c", "user.name=Pi", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-m", "base");
  return {box, root, base: git(root, "rev-parse", "HEAD")};
}
function task(id: string, operations?: string) {
  const markdown = "## Goal\nTask " + id + (operations ? "\n## Project memory\n" + operations : "");
  return {markdown, id, digest: id, repository: "owner/repo"};
}
const observation: CheckedFact = {claim: "The executable currently accepts input files.", observed: "--input",
  origin: "commit:cli.ts:4", source: {kind: "git", path: "cli.ts", line: 4}};
function receipt(...ids: string[]) {
  return {role: "fact-review", verdict: "pass", sessionId: "fresh-review", items: ids.map(id => ({id, status: "pass", memoryUse: "change-evidence" as const}))};
}

test("taskbook memory section is optional, ignores fenced examples and rejects ambiguity", () => {
  assert.deepEqual(taskbookMemoryChanges("## Facts\n- create fact id @0 | x | y"), []);
  assert.deepEqual(taskbookMemoryChanges("~~~md\n## Project memory\n- delete fact key @1 | project | no\n~~~"), []);
  assert.throws(() => taskbookMemoryChanges("## 项目记忆\n- delete term x @0 | project | retired"));
  assert.throws(() => taskbookMemoryChanges("## 项目记忆\n- create term x @0 | project | A\n- create term x @0 | project | B"));
});

test("reviewed term create, replace, retirement and reactivation retain all source versions", t => {
  const {root, base, box} = repository(t);
  const other = join(box, "worktree");
  git(root, "worktree", "add", "-q", "--detach", other);
  const id = "project:term:entry";
  const apply = (id: string, line: string) => {
    const spec = task(id, line);
    const snapshot = readProjectMemory(other);
    return applyApprovedMemory(other, snapshot, spec, base, pendingMemoryChanges(spec, snapshot), [observation], receipt("M1","P1"));
  };
  const first = apply("create", "- create term entry @0 | project | Start signal with explicit task type.");
  assert.equal(readProjectMemory(root).records[id].source.taskId, "create");
  assert.equal(first.records[id].scope, "project");
  const second = apply("update", "- update term entry @1 | cross-project:term | Start signal for either work family.");
  assert.equal(second.records[id].sharedSince, 2);
  assert.deepEqual(projectFacts(second, base).map(x => x.id), [id]);
  const retired = apply("delete", "- delete term entry @2 | project | Obsolete after protocol change.");
  assert.equal(retired.records[id].sharedSince, 2);
  assert.equal(retired.records[id].deleted, true);
  assert.deepEqual(projectFacts(retired, base), []);
  assert.equal(JSON.parse(git(root, "show", projectMemoryRef + "^:memory.json")).records[id].text, second.records[id].text);
  assert.equal(JSON.parse(git(root, "show", projectMemoryRef + "^^:memory.json")).records[id].text, first.records[id].text);
  assert.throws(() => apply("bad", "- create term entry @0 | project | Cannot silently restore."));
  assert.equal(apply("restore", "- create term entry @3 | project | Explicitly restored.").records[id].version, 4);
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  assert.equal(git(other, "status", "--porcelain"), "");
});

test("concurrent snapshots, unauthorized author and partial receipts fail without partial writes", t => {
  const {root, base} = repository(t);
  const snapshot = readProjectMemory(root);
  const a = task("one", "- create fact a @0 | project | First.");
  const b = task("two", "- create fact b @0 | project | Second.\n- create fact c @0 | project | Third.");
  const changes = pendingMemoryChanges(b, snapshot);
  assert.throws(() => applyApprovedMemory(root, snapshot, b, base, changes, [observation], receipt("M1", "P1")));
  assert.throws(() => applyApprovedMemory(root, snapshot, b, base, changes, [], {...receipt("M1","M2"), role: "implement"}));
  assert.equal(readProjectMemory(root).head, null);
  const committed = applyApprovedMemory(root, snapshot, a, base, pendingMemoryChanges(a, snapshot), [observation], receipt("M1","P1"));
  assert.throws(() => applyApprovedMemory(root, snapshot, b, base, changes, [observation], receipt("M1","M2","P1")), /另一工作区/);
  assert.deepEqual(readProjectMemory(root), committed);
  const retry = pendingMemoryChanges(a, committed);
  assert.deepEqual(retry, []);
  assert.deepEqual(applyApprovedMemory(root, committed, a, base, retry, [observation], receipt("P1"), true), committed);
  const questionable = task("three", "- update fact a @1 | project | Attempted replacement.");
  assert.deepEqual(pendingMemoryChanges(questionable, committed, [{factId: "project:fact:a", action:"keep"}]), []);
  assert.throws(() => pendingMemoryChanges(task("four", "- delete fact a @2 | project | Stale."), committed), /当前版本 @1/);
});

test("ordinary reviewed evidence stays in its observed revision and never overwrites a retired entry", t => {
  const {root, base} = repository(t);
  const oldTask = task("unstructured");
  const evidence = {...observation, observedHead: "different-head"};
  const projected = applyApprovedMemory(root, readProjectMemory(root), oldTask, base, [], [evidence], receipt("P1"));
  assert.deepEqual(projectFacts(projected, base), []);
  const [id] = projectFacts(projected, "different-head").map(item => item.id);
  assert.ok(id.startsWith("project:fact:observation-"));
  const record = projected.records[id];
  const retire = task("retire", "- delete fact " + record.key + " @1 | " + record.scope + " | Corrected observation.");
  const deleted = applyApprovedMemory(root, projected, retire, base, pendingMemoryChanges(retire, projected), [observation], receipt("M1","P1"));
  assert.deepEqual(applyApprovedMemory(root, deleted, oldTask, base, [], [evidence], receipt("P1")), deleted);
});

test("mixed M and P receipts preserve an independent worktree observation without copying superseded term evidence", t => {
  const {root, base} = repository(t);
  git(root, "-c", "user.name=Pi", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-m", "ahead");
  const observedHead = git(root, "rev-parse", "HEAD");
  const command: CheckedFact = {...observation, observedHead, origin:"bash call-A", toolInput:{command:"cli --help"},
    source:{kind:"tool", receipt:"A"}};
  const supporting: CheckedFact = {...observation, claim:"Legacy entry means tool input.", observed:"old glossary entry"};
  const spec = task("mixed", "- create term entry @0 | project | Entry chooses a task family.");
  const initial = readProjectMemory(root);
  const changes = pendingMemoryChanges(spec, initial);
  const decided = {role:"fact-review", verdict:"pass", sessionId:"different-reviewer", items:[
    {id:"M1",status:"pass"}, {id:"P1",status:"pass",memoryUse:"independent" as const},
    {id:"P2",status:"pass",memoryUse:"change-evidence" as const}]};
  const incomplete = {...decided, items:decided.items.map(i => ({id:i.id,status:i.status}))};
  assert.throws(() => applyApprovedMemory(root, initial, spec, base, changes, [command,supporting], incomplete), /逐项确定/);
  assert.equal(readProjectMemory(root).head,null);
  const committed = applyApprovedMemory(root, initial, spec, base, changes, [command,supporting], decided);
  const scoped = projectFacts(committed, base, [command]);
  assert.equal(projectFacts(committed, base).length, 1);
  assert.equal(scoped.length, 2);
  const accepted = scoped.find(f => f.id.includes("observation-"))!;
  assert.equal(JSON.parse(accepted.text).statement, command.claim);
  assert.equal(JSON.parse(accepted.text).scope, "commit:" + observedHead);
  const term = committed.records["project:term:entry"];
  assert.ok(term.source.evidence.some(e => e.includes(supporting.claim)));
  assert.ok(Object.values(committed.records).every(r => r.text !== supporting.claim));

  const key = committed.records[accepted.id].key;
  const retire = task("retire-ahead", "- delete fact " + key + " @1 | commit:" + observedHead + " | Incorrect observation.");
  const deleted = applyApprovedMemory(root, committed, retire, base, pendingMemoryChanges(retire, committed), [command], receipt("M1","P1"));
  assert.equal(projectFacts(deleted, base, [command]).length, 1);
  const history = historicalProjectFacts(deleted).find(h => h.id === accepted.id);
  assert.equal(history?.previous.text, command.claim);
  assert.equal(history?.currentStatementOrRetirementReason, "Incorrect observation.");
  const punctuated = {...command, origin:"bash call-B", source:{kind:"tool" as const, receipt:"B"}, claim:command.claim.slice(0, -1)};
  const replay = applyApprovedMemory(root, deleted, task("punctuation"), base, [], [punctuated], receipt("P1"));
  assert.equal(replay.head, deleted.head);
  assert.equal(projectFacts(replay, base, [punctuated]).length, 1);
  const distinct = {...punctuated, claim:"The command lists --input in its help text."};
  const different = applyApprovedMemory(root, replay, task("different"), base, [], [distinct], receipt("P1"));
  assert.equal(projectFacts(different, base, [distinct]).length, 2);
});

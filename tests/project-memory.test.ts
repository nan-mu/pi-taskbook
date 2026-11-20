import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { applyApprovedMemory, formatProjectTsv, historicalProjectFacts, legacyProjectFactsPath, parseProjectTsv, pendingMemoryChanges,
  projectFacts, projectFactsPath, readProjectMemory, taskbookMemoryChanges, type ProjectDocument } from "../src/facts/project-memory.ts";
import { deleteLegacyProjectMemoryArchive, deleteLegacyProjectMemoryRef, importLegacyProjectMemory, inspectLegacyProjectMemory } from "../src/facts/project-memory-migration.ts";
import type { CheckedFact } from "../src/facts/fact-check.ts";

const legacyRef = "refs/pi-taskbook/project-memory";
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
  const [entry] = taskbookMemoryChanges("## Facts\n3. `create` · `decision` — Store approved facts.", "facts");
  assert.equal(entry.key, "task/facts/F3");
  assert.equal(entry.factId, "F3");
  assert.equal(entry.type, "decision");
  assert.equal(entry.scope, "project");
  assert.equal(entry.text, "Store approved facts.");
});

test("reviewed term create, replace, retirement and reactivation retain all source versions", t => {
  const {root, base, box} = repository(t);
  const other = join(box, "worktree");
  git(root, "worktree", "add", "-q", "-b", "facts", other);
  const id = "project:term:entry";
  const apply = (id: string, line: string) => {
    const spec = task(id, line);
    const snapshot = readProjectMemory(other);
    return applyApprovedMemory(other, snapshot, spec, base, pendingMemoryChanges(spec, snapshot), [observation], receipt("M1","P1"));
  };
  const first = apply("create", "- create term entry @0 | project | Start signal with explicit task type.");
  assert.equal(readProjectMemory(root).head, null);
  assert.equal(readProjectMemory(other).records[id].source.taskId, "create");
  assert.match(readFileSync(join(other, "GLOSSARY.md"), "utf8"), /Start signal with explicit task type/);
  assert.equal(first.records[id].scope, "project");
  const second = apply("update", "- update term entry @1 | cross-project:term | Start signal for either work family.");
  assert.equal(second.records[id].sharedSince, 2);
  assert.deepEqual(projectFacts(second, base).map(x => x.id), [id]);
  const retired = apply("delete", "- delete term entry @2 | project | Obsolete after protocol change.");
  assert.equal(retired.records[id].sharedSince, 2);
  assert.equal(retired.records[id].deleted, true);
  assert.deepEqual(projectFacts(retired, base), []);
  const committed = (revision: string) => parseProjectTsv(execFileSync("git", ["show", revision + ":" + projectFactsPath],
    {cwd: other, encoding: "utf8"}));
  assert.equal(committed("HEAD^").records[id].text, second.records[id].text);
  assert.equal(committed("HEAD^^").records[id].text, first.records[id].text);
  assert.doesNotMatch(readFileSync(join(other, "GLOSSARY.md"), "utf8"), /Start signal/);
  assert.throws(() => apply("bad", "- create term entry @0 | project | Cannot silently restore."));
  assert.equal(apply("restore", "- create term entry @3 | project | Explicitly restored.").records[id].version, 4);
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  assert.equal(git(other, "status", "--porcelain"), "");
  assert.equal(git(root, "for-each-ref", legacyRef), "");
  const clone = join(box, "clone");
  git(box, "clone", "--quiet", "--branch", "facts", other, clone);
  assert.deepEqual(readProjectMemory(clone), readProjectMemory(other));
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
  assert.ok(term.source.evidence.some(e => e.startsWith("P2 · " + supporting.origin)));
  assert.ok(term.source.evidence.every(e => !e.includes(supporting.observed)));
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

function legacyCommit(root: string, document: object, parent?: string) {
  function write(args: string[], input: string) {
    return execFileSync("git", args, {cwd:root, encoding:"utf8", input}).trim();
  }
  const blob = write(["hash-object", "-w", "--stdin"], JSON.stringify(document));
  const tree = write(["mktree"], "100644 blob " + blob + "\tmemory.json\n");
  const head = git(root, "-c", "user.name=Pi", "-c", "user.email=test@localhost", "commit-tree",
    tree, ...(parent ? ["-p", parent] : []), "-m", "old format");
  git(root, "update-ref", legacyRef, head);
  return head;
}

test("migration previews reviewed legacy sources and retires only the explicitly selected, verified ref", t => {
  const {root, base} = repository(t);
  assert.deepEqual(inspectLegacyProjectMemory(root), {legacyHead:null, entries:[], unresolved:[], archives:[]});
  const termId = "project:term:entry";
  const source = {repository:"owner/repo", taskId:"legacy", taskDigest:"old-digest", base, reviewSession:"old-review", evidence:["author source"]};
  const first = {kind:"term", key:"entry", scope:"project", text:"Local term", version:1, deleted:false, source};
  const parent = legacyCommit(root, {schema:1, records:{[termId]:first}, applied:{}});
  const applied = {["a".repeat(64)]: true};
  const old = legacyCommit(root, {schema:1, records:{[termId]:{
    ...first, text:"Replaced old protocol", version:2, deleted:true,
  }}, applied}, parent);
  const path = join(root, ".audit/pi-taskbook/legacy/state.json");
  mkdirSync(join(root, ".audit/pi-taskbook/legacy"), {recursive:true});
  const approvedObservation = {...observation, observedHead:base};
  const state = {version:1, base, digest:"checkpoint-digest", taskbook:{id:"old-checkpoint", digest:"checkpoint-digest", repository:"owner/repo"},
    phase:"implement", reports:[{phase:"fact-review", outcome:"pass", review:{...receipt("P1"),items:[{id:"P1",status:"pass"}]}, factChecks:[approvedObservation]}]};
  writeFileSync(path, JSON.stringify(state));
  writeFileSync(join(root, ".audit/unrecognized.md"), "unknown source\n");
  const before = git(root, "status", "--porcelain", "--untracked-files=all");
  const preview = inspectLegacyProjectMemory(root, "owner/repo");
  assert.equal(git(root, "status", "--porcelain", "--untracked-files=all"), before);
  assert.equal(git(root, "rev-parse", legacyRef), old);
  assert.equal(preview.entries.length, 2);
  assert.equal(preview.unresolved[0].source, ".audit/unrecognized.md");
  const term = preview.entries.find(entry => entry.kind === "term")!;
  const observed = preview.entries.find(entry => entry.kind === "fact")!;
  assert.equal(term.version, 2);
  assert.equal(term.retired, true);
  assert.throws(() => deleteLegacyProjectMemoryRef(root, old), /缺少可回查/);
  assert.throws(() => importLegacyProjectMemory(root, "owner/repo", [term, {...observed, sourceVersion:"stale"}]), /没有对应版本/);
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  assert.equal(readProjectMemory(root).head, null);
  const imported = importLegacyProjectMemory(root, "owner/repo", [term, observed]);
  assert.equal(imported.records[termId].history?.[0].text, first.text);
  assert.equal(imported.records[termId].deleted, true);
  assert.equal(imported.applied["a".repeat(64)], true);
  assert.equal(projectFacts(imported, base).length, 1);
  assert.equal(projectFacts(imported, base)[0].id, observed.target.split("#")[1]);
  assert.deepEqual(projectFacts(imported, "different"), []);
  assert.deepEqual(importLegacyProjectMemory(root, "owner/repo", [term, observed]), imported);
  assert.equal(git(root, "rev-parse", legacyRef), old);
  deleteLegacyProjectMemoryRef(root, old);
  assert.equal(git(root, "for-each-ref", legacyRef), "");
  assert.equal(readFileSync(path, "utf8"), JSON.stringify(state));
  assert.deepEqual(readProjectMemory(root), imported);
  assert.deepEqual(importLegacyProjectMemory(root, "owner/repo", [term, observed]), imported);
});

test("fact commits preserve unrelated staged changes and use the documented glossary", t => {
  const {root, base} = repository(t);
  mkdirSync(join(root, "docs/agents"), {recursive:true});
  writeFileSync(join(root, "docs/agents/domain.md"), "The glossary lives at `docs/project terms.md`.\n");
  writeFileSync(join(root, "docs/project terms.md"), "# Definitions\n\nOriginal term.\n");
  git(root, "add", "docs");
  git(root, "-c", "user.name=Pi", "-c", "user.email=test@localhost", "commit", "-m", "project convention");
  writeFileSync(join(root, "staged.txt"), "unrelated");
  git(root, "add", "staged.txt");
  const spec = task("author-term", "- create term term @0 | project | Approved definition.");
  const previous = readProjectMemory(root);
  applyApprovedMemory(root, previous, spec, base, pendingMemoryChanges(spec, previous), [observation], receipt("M1", "P1"));
  assert.equal(git(root, "status", "--porcelain"), "A  staged.txt");
  assert.match(readFileSync(join(root, "docs/project terms.md"), "utf8"), /Original term.[\s\S]*Approved definition/);
  assert.deepEqual(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n"),
    [projectFactsPath, "docs/project terms.md"]);
  writeFileSync(join(root, "docs/project terms.md"), "# Definitions\n");
  assert.throws(() => readProjectMemory(root), /管理区与 .fact 不一致/);
});

test("failed fact commit restores prepared files and keeps legacy records available for retry", t => {
  const {root, base} = repository(t);
  const termId = "project:term:entry";
  const records = {[termId]: {kind:"term", key:"entry", scope:"project", text:"Archived term", version:1, deleted:false,
    source: {repository:"owner/repo", taskId:"legacy", taskDigest:"old", base, reviewSession:"review", evidence:["original"]}}};
  const info = {schema:1, records, applied:{}};
  const old = legacyCommit(root, info);
  const hook = join(root, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", {mode:0o700});
  const {entries} = inspectLegacyProjectMemory(root, "owner/repo");
  assert.throws(() => importLegacyProjectMemory(root, "owner/repo", entries));
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  assert.equal(git(root, "rev-parse", legacyRef), old);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(readProjectMemory(root).head, null);
  rmSync(hook);
  const imported = importLegacyProjectMemory(root, "owner/repo", entries);
  assert.equal(imported.records[termId].text, "Archived term");
});

test("archive cleanup checks the exact preview version and keeps checkpoints and unknown .audit materials", t => {
  const {root, base} = repository(t);
  const factId = "project:fact:layout";
  const records = {[factId]: {kind:"fact", key:"layout", scope:"project", text:"Local layout", version:1, deleted:false,
    source: {repository:"owner/repo", taskId:"archived", taskDigest:"archive", base, reviewSession:"verified", evidence:["original"]}}};
  const raw = JSON.stringify({schema:1, records, applied:{["b".repeat(64)]:true}});
  const archived = ".audit/archive/facts.json";
  const active = ".audit/pi-taskbook/active/state.json";
  mkdirSync(join(root, ".audit/archive"), {recursive:true});
  mkdirSync(join(root, ".audit/pi-taskbook/active"), {recursive:true});
  writeFileSync(join(root, archived), raw);
  writeFileSync(join(root, active), "unrecognized checkpoint");
  const {entries, unresolved} = inspectLegacyProjectMemory(root, "owner/repo");
  assert.deepEqual(unresolved.map(item => item.source), [active]);
  const [entry] = entries;
  assert.throws(() => deleteLegacyProjectMemoryArchive(root, archived, entry.sourceRevision), /缺少可回查/);
  assert.throws(() => deleteLegacyProjectMemoryArchive(root, active, entry.sourceRevision), /检查点需要保留/);
  const imported = importLegacyProjectMemory(root, "owner/repo", entries);
  writeFileSync(join(root, archived), raw + "\n");
  assert.throws(() => deleteLegacyProjectMemoryArchive(root, archived, entry.sourceRevision), /版本已变化/);
  assert.equal(readFileSync(join(root, archived), "utf8"), raw + "\n");
  writeFileSync(join(root, archived), raw);
  deleteLegacyProjectMemoryArchive(root, archived, entry.sourceRevision);
  assert.throws(() => readFileSync(join(root, archived)), /ENOENT/);
  assert.equal(readFileSync(join(root, active), "utf8"), "unrecognized checkpoint");
  assert.deepEqual(importLegacyProjectMemory(root, "owner/repo", entries), imported);
});

test("TSV preserves sourced versions and multiline fact text as inspectable rows", () => {
  const id = "project:fact:escape";
  const source = {repository: "owner/repo", taskId: "task", taskDigest: "digest", base: "base", reviewSession: "review",
    evidence: ["first\nsecond\tthird", "literal \\n"]};
  const document: ProjectDocument = {schema: 1, records: {[id]: {
    kind: "fact", key: "escape", scope: "project", text: "Updated\r\nline\twith literal \\t", version: 2, deleted: false, source,
    history: [{scope: "project", text: "Old value", version: 1, deleted: false, source}],
  }}, applied: {[ "a".repeat(64) ]: true}};
  const text = formatProjectTsv(document);
  assert.match(text, /^record\tproject:fact:escape\t2\tfact\t/m);
  assert.match(text, /^history\tproject:fact:escape\t1\t/m);
  assert.match(text, /first\\nsecond\\tthird/);
  assert.deepEqual(parseProjectTsv(text), document);
  assert.throws(() => parseProjectTsv(text.replace("\\nsecond", "\\qsecond")), /转义无效/);
});

test("normal reads require explicit migration of pre-existing own JSON, including receipt-only documents", t => {
  const {root, base} = repository(t);
  const old = join(root, legacyProjectFactsPath);
  const marker = "c".repeat(64);
  const raw = JSON.stringify({schema: 1, records: {}, applied: {[marker]: true}});
  mkdirSync(join(root, ".fact"));
  writeFileSync(old, raw);
  const preview = inspectLegacyProjectMemory(root, "owner/repo");
  assert.equal(preview.projectJson?.status, "ready");
  assert.equal(preview.entries.length, 0);
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  assert.throws(() => readProjectMemory(root), /尚未迁移/);
  assert.throws(() => importLegacyProjectMemory(root, "owner/repo", [], {projectJsonVersion: "old"}), /版本已变化/);
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  const approval = {projectJsonVersion: preview.projectJson?.sourceRevision};
  const imported = importLegacyProjectMemory(root, "owner/repo", [], approval);
  assert.equal(imported.applied[marker], true);
  assert.deepEqual(readProjectMemory(root), imported);
  assert.equal(readFileSync(old, "utf8"), raw);
  assert.deepEqual(importLegacyProjectMemory(root, "owner/repo", [], approval), imported);
  assert.equal(inspectLegacyProjectMemory(root, "owner/repo").projectJson?.status, "already-imported");
});

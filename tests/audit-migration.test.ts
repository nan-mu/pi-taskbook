import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteMigratedAudit, inspectAuditMigration, migrateAudit } from "../src/setup/audit-migration.ts";
import { inspectAuditFacts, prepareAuditFactInput } from "../src/setup/audit-facts.ts";
import { readProjectMemory } from "../src/facts/project-memory.ts";
import { importTaskFacts, readFactTables } from "../src/facts/taskbook-intake.ts";
import { git, readTaskbook } from "../src/taskbook/document.ts";
import { prepareTaskLaunch } from "../src/taskbook/entry.ts";
import { taskAuthoredFacts } from "../src/workflow/task-context.ts";
import { registerReviewedFacts } from "../src/workflow/register-facts.ts";
import { runDirectory } from "../src/workflow/run-paths.ts";

test("audit migration checks the approved bytes before copying or removing an original", t => {
  const root = mkdtempSync(join(tmpdir(), "taskbook-audit-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  execFileSync("git", ["init", "-q", root]);
  const digest = "a".repeat(64);
  const key = "resume-" + digest.slice(0, 16);
  const audit = join(root, ".audit", "pi-taskbook", key);
  mkdirSync(audit, {recursive: true});
  const legacy = JSON.stringify({version: 2, digest, session: "session", reports: [],
    taskbook: {id: "resume", repository: "owner/repo", digest}});
  writeFileSync(join(audit, "state.json"), legacy);
  const notes = join(root, ".audit", "notes.bin");
  writeFileSync(notes, Buffer.from([0, 255]));
  const preview = inspectAuditMigration(root);
  assert.equal(preview.status, "ready");
  const { snapshot } = preview;
  assert.equal(existsSync(runDirectory(root)), false);

  writeFileSync(notes, "changed after preview");
  assert.throws(() => migrateAudit(root, "owner/repo", snapshot.digest), /发生变化/);
  assert.throws(() => deleteMigratedAudit(root, snapshot.digest), /已改变/);
  assert.equal(readFileSync(notes, "utf8"), "changed after preview");

  writeFileSync(notes, Buffer.from([0, 255]));
  const migrated = migrateAudit(root, "owner/repo", snapshot.digest);
  assert.equal(migrated.copied, 1);
  assert.deepEqual(readFileSync(join(migrated.archive, "notes.bin")), Buffer.from([0, 255]));
  assert.equal(readFileSync(join(runDirectory(root), key, "state.json"), "utf8"), legacy);
  assert.equal(migrateAudit(root, "owner/repo", snapshot.digest).copied, 0);
  writeFileSync(notes, "changed before cleanup");
  assert.throws(() => deleteMigratedAudit(root, snapshot.digest), /已改变/);
  assert.equal(readFileSync(notes, "utf8"), "changed before cleanup");

  writeFileSync(notes, Buffer.from([0, 255]));
  const agentGuide = join(root, "AGENTS.md");
  writeFileSync(agentGuide, "The glossary lives at `.audit/terms.md`.\n");
  const glossary = join(root, ".audit", "terms.md");
  writeFileSync(glossary, "# Glossary\n");
  const withGlossary = inspectAuditMigration(root);
  assert.equal(withGlossary.status, "ready");
  assert.equal(withGlossary.activeGlossary, ".audit/terms.md");
  migrateAudit(root, "owner/repo", withGlossary.snapshot.digest);
  assert.throws(() => deleteMigratedAudit(root, withGlossary.snapshot.digest), /当前术语清单/);
  assert.equal(readFileSync(glossary, "utf8"), "# Glossary\n");
  rmSync(glossary);
  rmSync(agentGuide);
  deleteMigratedAudit(root, snapshot.digest);
  assert.equal(existsSync(join(root, ".audit")), false);
  assert.equal(readFileSync(join(runDirectory(root), key, "state.json"), "utf8"), legacy);
  assert.deepEqual(readFileSync(join(migrated.archive, "notes.bin")), Buffer.from([0, 255]));
});

test("Setup hands audit terms to Fact Management and recognizes a signed registration after merging the worktree", t => {
  const dir = mkdtempSync(join(tmpdir(), "audit input "));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const root = join(dir, "main");
  const worktree = join(dir, "work");
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=me@example.invalid", "commit", "--allow-empty", "-qm", "base");
  git(root, "remote", "add", "origin", "https://github.com/owner/repo");
  const base = git(root, "rev-parse", "HEAD");
  const branch = "agent/restore-facts";
  const repository = "owner/repo";
  const source = {repository, taskId: "prior", taskDigest: "digest", base, reviewSession: "review", evidence: ["approved"]};
  const record = {kind: "term", key: "entry", version: 1, scope: "project", text: "Entry selects the task type.", source, deleted: false};
  mkdirSync(join(root, ".audit"));
  const archive = join(root, ".audit", "terms.json");
  writeFileSync(archive, JSON.stringify({schema: 1, records: {"project:term:entry": record}, applied: {}}));
  const audit = inspectAuditMigration(root);
  assert.equal(audit.status, "ready");
  const digest = audit.snapshot.digest;
  const preview = () => inspectAuditFacts(root, repository, digest);
  const before = preview();
  const choices = [{id: before.entries[0].id, path: ".fact/domain.tsv"}];
  assert.throws(() => prepareAuditFactInput(root, repository, digest, "HEAD", choices, before), /工作分支/);
  const input = prepareAuditFactInput(root, repository, digest, branch, choices, before);
  assert.equal(prepareAuditFactInput(root, repository, digest, branch, choices, before).input, input.input);
  assert.equal(preview().entries[0].status, "ready");
  assert.equal(existsSync(join(root, ".fact")), false);
  const task = readTaskbook(root, input.input);
  assert.equal(prepareTaskLaunch(root, task).branch, branch);
  git(root, "worktree", "add", "-q", "-b", branch, worktree);
  const view = importTaskFacts({root: worktree, task, base, sessionId: "session", memoryChanges: [],
    items: taskAuthoredFacts(task.markdown), expectedHead: readFactTables(worktree).head, project: readProjectMemory(worktree)});
  assert.equal(view.kind, "complete");
  assert.deepEqual(view.view.entries[0].row.labels, ["terms"]);
  const {revision} = registerReviewedFacts({task, root: worktree, path: join(git(worktree, "rev-parse", "--absolute-git-dir"), "state.json"),
    state: {version: 3, digest: task.digest, session: "s", base, branch, phase: "fact-registration", reports: [], revision: base,
      factView: view.view, team: {review: {kind: "approved", checkpoint: {runId: task.id, goals: [], candidate: {revision: base, evidenceVersion: "v1"},
        epoch: 1, serial: 1, everCrossed: true, priorFindings: []}, draftFacts: [], summary: "approved"}}}}, []);
  assert.equal(preview().entries[0].status, "ready");
  git(root, "merge", "--ff-only", revision);
  assert.equal(preview().entries[0].status, "already-imported");
  assert.equal(preview().archives[0].status, "already-imported");
  assert.equal(existsSync(archive), true);
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteMigratedAudit, inspectAuditMigration, migrateAudit } from "../src/setup/audit-migration.ts";
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

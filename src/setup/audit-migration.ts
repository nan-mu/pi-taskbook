import { createHash, randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectGlossaryPath } from "../facts/project-memory.ts";
import { git } from "../taskbook/document.ts";
import { privateDirectory } from "../taskbook/private-directory.ts";

type AuditEntry = { path: string; digest: string | null };
type AuditSnapshot = { digest: string; entries: AuditEntry[] };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function scanAudit(directory: string): AuditSnapshot | undefined {
  const stat = lstatSync(directory, {throwIfNoEntry: false});
  if (!stat) return;
  const entries: AuditEntry[] = [];
  function visit(path: string) {
    const file = join(directory, path);
    const stat = lstatSync(file);
    if (stat.isDirectory()) {
      if (path) entries.push({path, digest: null});
      for (const name of readdirSync(file).sort()) visit(path ? path + "/" + name : name);
    } else if (path && stat.isFile()) {
      entries.push({path, digest: hash(readFileSync(file))});
    } else {
      throw new Error("旧审计资料包含非普通文件：" + (path || ".audit"));
    }
  }
  visit("");
  return {digest: hash(JSON.stringify(entries)), entries};
}

function archiveLocation(root: string, digest: string) {
  return join(git(root, "rev-parse", "--absolute-git-dir"), "pi-taskbook", "legacy-audit", digest);
}

function glossaryInAudit(root: string, snapshot: AuditSnapshot) {
  const glossary = projectGlossaryPath(root);
  return snapshot.entries.some(entry => entry.digest !== null && ".audit/" + entry.path === glossary) ? glossary : undefined;
}

export function inspectAuditMigration(root: string) {
  try {
    const snapshot = scanAudit(join(root, ".audit"));
    if (!snapshot) return {status: "absent" as const};
    const archive = archiveLocation(root, snapshot.digest);
    const verified = scanAudit(archive)?.digest === snapshot.digest;
    return {status: verified ? "archived" as const : "ready" as const, snapshot, archive, activeGlossary: glossaryInAudit(root, snapshot)};
  } catch (error) {
    return {status: "unconfirmed" as const, reason: error instanceof Error ? error.message : "无法核对 .audit。"};
  }
}

export function migrateAudit(root: string, expectedDigest: string) {
  const source = join(root, ".audit");
  const snapshot = scanAudit(source);
  if (snapshot?.digest !== expectedDigest) throw new Error(".audit 在批准前后发生变化，重新运行 /taskbook-setup。");
  const directory = privateDirectory(git(root, "rev-parse", "--absolute-git-dir"), "pi-taskbook", "legacy-audit");
  const archive = archiveLocation(root, snapshot.digest);
  if (!scanAudit(archive)) {
    const temporary = join(directory, randomUUID());
    mkdirSync(temporary, {mode: 0o700});
    try {
      for (const {path, digest} of snapshot.entries) {
        const target = join(temporary, path);
        if (digest === null) mkdirSync(target, {mode: 0o700});
        else {
          copyFileSync(join(source, path), target, constants.COPYFILE_EXCL);
          chmodSync(target, 0o600);
        }
      }
      if (scanAudit(temporary)?.digest !== expectedDigest || scanAudit(source)?.digest !== expectedDigest) {
        throw new Error(".audit 在归档期间发生变化。");
      }
      renameSync(temporary, archive);
    } finally { rmSync(temporary, {recursive: true, force: true}); }
  }
  if (scanAudit(archive)?.digest !== expectedDigest) throw new Error("现有审计归档与原件不符。");
  return {archive};
}

export function deleteMigratedAudit(root: string, expectedDigest: string) {
  const source = join(root, ".audit");
  const snapshot = scanAudit(source);
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) ||
      snapshot?.digest !== expectedDigest ||
      scanAudit(archiveLocation(root, expectedDigest))?.digest !== expectedDigest) {
    throw new Error(".audit 缺少匹配的迁移副本，或内容已改变。");
  }
  const glossary = glossaryInAudit(root, snapshot);
  if (glossary) throw new Error(`当前术语清单 ${glossary} 位于 .audit 中。请先按项目约定迁出并更新声明。`);
  const temporary = join(dirname(source), ".audit-taskbook-" + randomUUID());
  renameSync(source, temporary);
  if (scanAudit(temporary)?.digest !== expectedDigest) {
    renameSync(temporary, source);
    throw new Error(".audit 内容已改变，已保留原件。");
  }
  rmSync(temporary, {recursive: true});
}

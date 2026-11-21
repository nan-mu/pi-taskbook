import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, posix } from "node:path";
import { taskAuthoredFacts } from "../workflow/task-context.ts";
import type { CheckedFact } from "./fact-check.ts";
import type { Taskbook } from "../taskbook/document.ts";

import { formatProjectTsv, keyPattern, memoryId, parseProjectTsv, type PriorValue,
  type ProjectDocument, type ProjectKind, type ProjectRecord } from "./project-memory-format.ts";

export { formatProjectTsv, memoryId, parseLegacyProjectDocument, parseProjectTsv } from "./project-memory-format.ts";
export type { ProjectDocument, ProjectKind, ProjectRecord } from "./project-memory-format.ts";

export const projectFactsPath = ".fact/facts.tsv";
export const legacyProjectFactsPath = ".fact/project.json";

export type ProjectSnapshot = { head: string | null } & Omit<ProjectDocument, "schema">;
export type MemoryChange = { action: "create" | "update" | "delete"; kind: ProjectKind; key: string;
  expected: number; scope: string; text: string; authorization: string; factId?: string; type?: ProjectRecord["type"] };
type ReviewReceipt = { role: string; verdict: string; sessionId: string; items: {id: string; status: string; reason?: string; memoryUse?: "independent" | "change-evidence"}[] };

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"] }).trim();
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const sharedScopes = new Set(["cross-project:rule", "cross-project:preference", "cross-project:fact", "cross-project:term"]);
function regularFile(root: string, relativePath: string) {
  let current = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = join(current, segment);
    const directory = lstatSync(current, {throwIfNoEntry: false});
    if (!directory) return;
    if (!directory.isDirectory()) throw new Error("项目事实路径要求真实目录：" + relativePath);
  }
  const path = join(root, relativePath);
  const entry = lstatSync(path, {throwIfNoEntry: false});
  if (!entry) return;
  if (!entry.isFile()) throw new Error("项目事实路径要求普通文件：" + relativePath);
  return readFileSync(path, "utf8");
}

export function readLegacyProjectJson(root: string) {
  const content = regularFile(root, legacyProjectFactsPath);
  if (content === undefined) return;
  const revision = hash(content);
  return { content, revision, receipt: hash(JSON.stringify([legacyProjectFactsPath, revision])) };
}

export function projectGlossaryPath(root: string) {
  const declaration = /(?:^|\b)(?:The )?glossary lives at `([^`]+)`/mi;
  const path = regularFile(root, "docs/agents/domain.md")?.match(declaration)?.[1] ??
    regularFile(root, "AGENTS.md")?.match(declaration)?.[1] ?? "GLOSSARY.md";
  if (posix.isAbsolute(path) || posix.normalize(path) !== path ||
      path.split("/").some(part => part === "." || part === ".." || part.startsWith(".git")) ||
      !/^[\p{L}\p{N}/_. -]+\.md$/iu.test(path)) {
    throw new Error("项目术语清单路径需要是仓库内的 Markdown 文件。");
  }
  return path;
}

const glossaryStart = "<!-- pi-taskbook:terms -->";
const glossaryEnd = "<!-- /pi-taskbook:terms -->";
function glossarySection(records: ProjectSnapshot["records"]) {
  const definitions = Object.values(records).filter(record => record.kind === "term" && !record.deleted)
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return [glossaryStart, "## 项目事实中的术语", "",
    ...definitions.map(record => "- **" + record.key + "** \n  " +
      record.text.replace(/[<>&]/g, c => ({"<":"&lt;", ">":"&gt;", "&":"&amp;"}[c] ?? c)).replace(/\r?\n/g, "  \n  ")),
    glossaryEnd].join("\n");
}

function synchronizeGlossary(existing: string | undefined, records: ProjectSnapshot["records"]) {
  const glossary = existing ?? "# Glossary\n";
  const start = glossary.indexOf(glossaryStart);
  const end = glossary.indexOf(glossaryEnd);
  const section = glossarySection(records);
  if (start < 0 && end < 0) return glossary + (glossary.endsWith("\n") ? "\n" : "\n\n") + section + "\n";
  if (start < 0 || end < start || glossary.indexOf(glossaryStart, start + 1) >= 0 ||
      glossary.indexOf(glossaryEnd, end + 1) >= 0) throw new Error("项目术语清单的管理区标记无效。");
  return glossary.slice(0, start) + section + glossary.slice(end + glossaryEnd.length);
}

export function readProjectMemory(root: string, options: {allowUnmigratedLegacy?: boolean} = {}): ProjectSnapshot {
  const raw = regularFile(root, projectFactsPath);
  const glossary = projectGlossaryPath(root);
  const currentTerms = regularFile(root, glossary);
  const {records, applied} = raw === undefined ? {records: {}, applied: {}} : parseProjectTsv(raw);
  if (!options.allowUnmigratedLegacy) {
    const legacy = readLegacyProjectJson(root);
    if (legacy && !applied[legacy.receipt]) {
      throw new Error("发现尚未迁移的 " + legacyProjectFactsPath + "。请先核对旧资料，并通过主题 TSV 接续项目事实。");
    }
  }
  if (raw === undefined && currentTerms === undefined && glossary === "GLOSSARY.md") return {head: null, records: {}, applied: {}};
  if (Object.values(records).some(record => record.kind === "term") && synchronizeGlossary(currentTerms, records) !== currentTerms) {
    throw new Error("项目术语清单的管理区与 .fact 不一致，请恢复已审核版本。");
  }
  return {head: hash(JSON.stringify([raw ?? null, glossary, currentTerms ?? null])), records, applied};
}
// Explicit operations in an authored section. Ignore examples and section-like text inside code fences.
export function taskbookMemoryChanges(markdown: string, taskId?: string): MemoryChange[] {
  let active = false;
  let fence = "";
  const seen = new Set<string>();
  const changes: MemoryChange[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const delimiter = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1].startsWith(fence) && !delimiter[2].trim()) fence = "";
      continue;
    }
    if (fence) continue;
    if (/^#{1,2}\s/.test(line)) { active = /^## (Project memory|项目记忆)\s*$/i.test(line); continue; }
    if (!active || !line.trim()) continue;
    const fields = line.trim().match(/^- (create|update|delete) (fact|term) (\S+) @(\d+)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/);
    if (!fields || !keyPattern.test(fields[3]) || !fields[5].trim() || !fields[6].trim()) {
      throw new Error("项目记忆指令格式：- create|update|delete fact|term 标识 @当前版本 | 适用范围 | 内容或删除理由。");
    }
    const [,action,kind,key,version,scope,text] = fields;
    const id = memoryId(kind as ProjectKind, key);
    const expected = Number(version);
    const targetScope = scope.trim();
    if (targetScope.startsWith("cross-project:") &&
        (!sharedScopes.has(targetScope) || (kind === "term") !== (targetScope === "cross-project:term"))) {
      throw new Error("跨项目记忆的 scope 须与事实或术语类型一致：" + id + " " + targetScope);
    }
    if (!Number.isSafeInteger(expected) || seen.has(id) || (action !== "create" && expected === 0)) {
      throw new Error("项目记忆条目重复或版本无效：" + id);
    }
    seen.add(id);
    changes.push({ action: action as MemoryChange["action"], kind: kind as ProjectKind, key, scope: scope.trim(),
      text: text.trim(), expected, authorization: line.trim() });
  }
  if (taskId) {
    for (const fact of taskAuthoredFacts(markdown)) {
      const explicit = fact.text.match(/^`create`\s*·\s*`(decision|interface|fact|term)`\s*[—–-]\s*([\s\S]+)$/);
      if (!explicit) continue;
      const type = explicit[1] === "decision" || explicit[1] === "interface" ? explicit[1] : undefined;
      const kind = explicit[1] === "term" ? "term" : "fact";
      const key = "task/" + taskId + "/" + fact.id;
      if (!keyPattern.test(key) || seen.has(memoryId(kind, key))) throw new Error("项目事实条目标识无效或重复：" + fact.id);
      seen.add(memoryId(kind, key));
      changes.push({action: "create", kind, key, expected: 0, scope: "project", text: explicit[2].trim(),
        authorization: fact.text, factId: fact.id, ...(type ? {type} : {})});
    }
  }
  return changes;
}

function priorValue(r: ProjectRecord): PriorValue {
  return {scope: r.scope, text: r.text, version: r.version, deleted: r.deleted, source: r.source, ...(r.type ? {type:r.type} : {})};
}

export function historicalProjectFacts(snapshot: ProjectSnapshot) {
  return Object.entries(snapshot.records).flatMap(([id, current]) => (current.history ?? []).map(previous => ({
    id, kind: current.kind, previous, currentVersion: current.version, retired: current.deleted,
    currentStatementOrRetirementReason: current.text, currentSource: current.source
  })));
}

function normalizedClaim(text: string) {
  return text.normalize("NFKC").trim().replace(/\s+/gu, " ").replace(/[.。]+$/gu, "").trimEnd();
}
function fingerprint(scope: string, claim: string, evidence: string) {
  return hash(JSON.stringify([scope, normalizedClaim(claim), evidence]));
}
function stableInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableInput);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, stableInput(child)]));
  }
  return value;
}
export function observationFingerprint(p: CheckedFact, scope: string) {
  const source = p.source.kind === "tool" && p.toolInput !== undefined
    ? JSON.stringify([p.origin.split(" ")[0], stableInput(p.toolInput), Boolean(p.toolError)]) : p.origin;
  return fingerprint(scope, p.claim, source + "\n" + p.observed);
}
export function observationIdentity(proposal: CheckedFact, base: string) {
  const scope = "commit:" + (proposal.observedHead ?? base);
  const key = "observation-" + hash(JSON.stringify([scope, proposal.claim])).slice(0, 24);
  return {scope, key, id: memoryId("fact", key)};
}

export function projectFacts(snapshot: ProjectSnapshot, base: string, accepted: CheckedFact[] = []) {
  // A linked worktree may already be ahead of the task's base. This task may
  // reuse its own reviewed observations of that revision, with the original
  // scope attached. Read current ledger values so retirement wins on replay.
  const acceptedFingerprints = new Set(accepted.map(p => observationFingerprint(p, observationIdentity(p, base).scope)));
  const observed = new Map(accepted.map(p => {
    const {id, scope} = observationIdentity(p, base);
    return [id, scope];
  }));
  return Object.entries(snapshot.records).filter(([id, r]) => !r.deleted &&
    (!r.scope.startsWith("commit:") || r.scope === "commit:" + base || observed.get(id) === r.scope ||
      (r.source.observationFingerprint !== undefined && acceptedFingerprints.has(r.source.observationFingerprint))))
    .map(([id, r]) => ({id, text: JSON.stringify({ kind: r.kind, ...(r.type ? {type: r.type} : {}), key: r.key, scope: r.scope,
      version: r.version, statement: r.text, source: r.source })}));
}

export function pendingMemoryChanges(task: Pick<Taskbook, "markdown" | "digest"> & Partial<Pick<Taskbook, "id">>, snapshot: ProjectSnapshot,
  decisions: {factId: string; action: "keep" | "replace"; projectChange?: MemoryChange}[] = []) {
  const requested = new Map(taskbookMemoryChanges(task.markdown, task.id).map(c => [memoryId(c.kind, c.key), c]));
  for (const choice of decisions) {
    if (choice.projectChange) requested.set(choice.factId, choice.projectChange);
    else if (choice.action === "keep") requested.delete(choice.factId);
  }
  const changes = [...requested.values()].filter(c => !snapshot.applied[hash(JSON.stringify([task.digest, c]))]);
  for (const change of changes) validateChange(snapshot.records, change);
  return changes;
}

function validateChange(records: ProjectSnapshot["records"], change: MemoryChange) {
  const id = memoryId(change.kind, change.key);
  const prior = records[id];
  if ((prior?.version ?? 0) !== change.expected || (change.action === "create" ? prior && !prior.deleted : !prior || prior.deleted)) {
    throw new Error(id + " 当前版本 @" + (prior?.version ?? 0) + " 与任务书授权操作不符，请更新任务书后重新核查。");
  }
  if (prior && (prior.type === "observation" || prior.source.observationFingerprint) && change.scope !== prior.scope) {
    throw new Error(id + " 是提交限定的观察，变更必须保持原适用范围。");
  }
}

export function applyApprovedMemory(root: string, snapshot: ProjectSnapshot, task: Pick<Taskbook, "repository" | "id" | "digest">,
  base: string, changes: MemoryChange[], proposals: CheckedFact[], review: ReviewReceipt, classifyFactChecks = changes.length > 0) {
  if (review.role !== "fact-review" || review.verdict !== "pass" || !review.sessionId.trim()) {
    throw new Error("项目记忆变更需要独立事实审核通过。");
  }
  if (!proposals.length) throw new Error("项目记忆变更需要实际核查依据。");
  const approved = new Set(review.items.filter(i => i.status === "pass").map(i => i.id));
  const required = [...changes.map((_, i) => "M" + (i + 1)), ...proposals.map((_, i) => "P" + (i + 1))];
  if (required.some(id => !approved.has(id))) throw new Error("项目记忆缺少对应条目的独立审核结论。");
  const ordinary = proposals.filter((_, i) => {
    if (!classifyFactChecks) return true;
    const use = review.items.find(item => item.id === "P" + (i + 1))?.memoryUse;
    if (use !== "independent" && use !== "change-evidence") throw new Error("事实审核须逐项确定独立观察或变更证据。");
    return use === "independent";
  });
  const document = prepareProjectChanges(snapshot, task, base, changes, review.sessionId, proposals, ordinary, review.items);
  return commitProjectMemory(root, snapshot, document, "Review project facts · " + task.id, document.modified);
}

export function commitTaskbookMemory(root: string, snapshot: ProjectSnapshot, task: Taskbook, base: string,
  changes: MemoryChange[], sessionId: string, topics: Map<string, string>, validate: () => void) {
  const document = prepareProjectChanges(snapshot, task, base, changes, sessionId);
  const message = "Import taskbook facts · " + task.id + "\n\nTaskbook-Input: " + task.digest;
  return commitProjectMemory(root, snapshot, document, message, document.modified, undefined, {mutations: topics, validate});
}

function prepareProjectChanges(snapshot: ProjectSnapshot, task: Pick<Taskbook, "repository" | "id" | "digest">,
  base: string, changes: MemoryChange[], sessionId: string, proposals: CheckedFact[] = [], ordinary: CheckedFact[] = [],
  items: ReviewReceipt["items"] = []) {
  const records = { ...snapshot.records };
  const applied = { ...snapshot.applied };
  let modified = false;
  if (Object.values(records).some(record => record.source.repository.toLowerCase() !== task.repository.toLowerCase())) {
    throw new Error("项目事实文件包含归属不同项目的记录，请核对 .fact。");
  }
  const source = { repository: task.repository, taskId: task.id, taskDigest: task.digest, base,
    reviewSession: sessionId, evidence: proposals.map((p, i) => "P" + (i + 1) + " · " + p.origin + "\n摘录 SHA-256 " + hash(p.observed)) };
  for (const [index, change] of changes.entries()) {
    const id = memoryId(change.kind, change.key);
    const mutation = hash(JSON.stringify([task.digest, change]));
    if (applied[mutation]) continue;
    const prior = records[id];
    validateChange(records, change);
    const sharedSince = prior?.sharedSince ?? (sharedScopes.has(change.scope) && change.action !== "delete" ? change.expected + 1 : undefined);
    const rationale = items.find(i => i.id === "M" + (index + 1))?.reason;
    const type = change.type ?? prior?.type;
    const factId = change.factId ?? prior?.source.factId;
    records[id] = { kind: change.kind, ...(type ? {type} : {}), key: change.key, version: change.expected + 1, scope: change.scope, ...(prior ? {history: [...(prior.history ?? []), priorValue(prior)]} : {}), ...(sharedSince ? {sharedSince} : {}),
      text: change.text, deleted: change.action === "delete", source: {...source, ...(factId ? {factId} : {}), ...(rationale ? {rationale} : {}), evidence: [change.authorization, ...source.evidence]} };
    applied[mutation] = true;
    modified = true;
  }
  const knownObservations = new Set<string>();
  for (const [id, record] of Object.entries(records)) {
    if (!id.startsWith("project:fact:observation-")) continue;
    for (const value of [record, ...(record.history ?? [])]) {
      const fp = value.source.observationFingerprint;
      if (fp) knownObservations.add(fp);
      else if (value.version === 1) knownObservations.add(fingerprint(value.scope, value.text, value.source.evidence[0]));
    }
  }
  for (const proposal of ordinary) {
    const {scope, key, id} = observationIdentity(proposal, base);
    // A retired or corrected observation cannot be reintroduced by repeating the old claim.
    const fp = observationFingerprint(proposal, scope);
    const legacyFp = fingerprint(scope, proposal.claim, proposal.origin + "\n" + proposal.observed);
    if (records[id] || knownObservations.has(fp) || knownObservations.has(legacyFp)) continue;
    knownObservations.add(fp);
    records[id] = { kind: "fact", type: "observation", key, scope, text: proposal.claim, version: 1, deleted: false,
      source: { ...source, observationFingerprint: fp, evidence: [proposal.origin + "\n摘录 SHA-256 " + hash(proposal.observed)] } };
    modified = true;
  }
  return {schema: 1 as const, records, applied, modified};
}

function replaceFile(path: string, text: string) {
  const temporary = path + "." + randomUUID();
  try {
    writeFileSync(temporary, text, {flag: "wx", mode: 0o600});
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, {force: true});
  }
}

export function lockProjectMemory(root: string) {
  const lockPath = join(git(root, ["rev-parse", "--absolute-git-dir"]), "pi-taskbook-facts.lock");
  const temporary = lockPath + "." + randomUUID();
  const owner = JSON.stringify({pid: process.pid, host: hostname(), id: randomUUID()}) + "\n";
  try {
    writeFileSync(temporary, owner, {flag: "wx", mode: 0o600});
    linkSync(temporary, lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("项目事实写入锁已存在，请核对持有进程及工作区：" + lockPath);
    }
    throw error;
  } finally {
    rmSync(temporary, {force: true});
  }
  return () => {
    if (lstatSync(lockPath, {throwIfNoEntry: false})?.isFile() && readFileSync(lockPath, "utf8") === owner) {
      rmSync(lockPath, {force: true});
    }
  };
}

export function commitProjectMemory(root: string, snapshot: ProjectSnapshot, document: ProjectDocument, message: string, modified = true,
  migration?: {projectJsonVersion?: string}, extra?: {mutations: Map<string, string>; validate: () => void}) {
  const unlock = lockProjectMemory(root);
  try {
    const options = {allowUnmigratedLegacy: migration !== undefined};
    if (readProjectMemory(root, options).head !== snapshot.head) {
      throw new Error("另一工作区或编辑已更新项目事实，重交同一任务书以重新独立审核。");
    }
    if (migration?.projectJsonVersion !== undefined && readLegacyProjectJson(root)?.revision !== migration.projectJsonVersion) {
      throw new Error("旧 JSON 版本已变化，请重新盘点。");
    }
    extra?.validate();
    const mutations = new Map(extra?.mutations);
    if (modified) {
      const content = formatProjectTsv(document);
      parseProjectTsv(content);
      mutations.set(projectFactsPath, content);
    }
    if (modified && Object.values(document.records).some(record => record.kind === "term")) {
      const glossary = projectGlossaryPath(root);
      const previous = regularFile(root, glossary);
      const next = synchronizeGlossary(previous, document.records);
      if (next !== previous) mutations.set(glossary, next);
    }
    const paths = [...mutations.keys()].filter(path => regularFile(root, path) !== mutations.get(path));
    if (!paths.length) return snapshot;
    const untracked = new Set(git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths]).split("\0"));
    const previous = new Map(paths.map(path => [path, regularFile(root, path)]));
    for (const path of paths) {
      const status = git(root, ["status", "--porcelain", "--untracked-files=all", "--ignored", "--", path]);
      if (status && (extra?.mutations.has(path) || !untracked.has(path))) throw new Error("请先处理已修改或被排除的项目事实文件：" + path);
    }
    const revision = git(root, ["rev-parse", "HEAD"]);
    const plannedAdds = paths.filter(path => untracked.has(path) || previous.get(path) === undefined);
    try {
      for (const path of paths) {
        const absolute = join(root, path);
        mkdirSync(dirname(absolute), {recursive: true});
        replaceFile(absolute, mutations.get(path)!);
      }
      if (plannedAdds.length) git(root, ["add", "-N", "--", ...plannedAdds]);
      git(root, ["-c", "user.name=Pi Taskbook", "-c", "user.email=pi-taskbook@localhost", "-c", "commit.gpgsign=false",
        "commit", "--only", "--no-status", "-m", message, "--", ...paths]);
    } catch (error) {
      if (git(root, ["rev-parse", "HEAD"]) === revision) {
        if (plannedAdds.length) git(root, ["reset", "-q", "--", ...plannedAdds]);
        for (const [path, before] of previous) {
          if (regularFile(root, path) !== mutations.get(path)) continue;
          if (before === undefined) rmSync(join(root, path), {force: true});
          else replaceFile(join(root, path), before);
        }
      }
      throw error;
    }
    return readProjectMemory(root, options);
  } finally {
    unlock();
  }
}

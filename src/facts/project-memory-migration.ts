import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, posix } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  commitProjectMemory, legacyProjectFactsPath, lockProjectMemory, observationFingerprint, observationIdentity,
  parseLegacyProjectDocument, parseProjectTsv, projectFactsPath, readLegacyProjectJson, readProjectMemory,
  type ProjectDocument, type ProjectRecord, type ProjectSnapshot,
} from "./project-memory.ts";
import { factChecksParameter } from "./fact-check.ts";
import { git, gitOk } from "../taskbook/document.ts";

const legacyRef = "refs/pi-taskbook/project-memory";
const legacyFile = "memory.json";
const auditPath = ".audit";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const checkpointSchema = Type.Object({
  version: Type.Union([Type.Literal(1), Type.Literal(2)]),
  digest: Type.String({minLength: 1}),
  base: Type.String({pattern: "^[a-f0-9]{40}([a-f0-9]{24})?$"}),
  taskbook: Type.Object({id: Type.String({minLength: 1}), digest: Type.String(), repository: Type.String()}),
  reports: Type.Array(Type.Unknown()),
});
const reviewSchema = Type.Object({
  phase: Type.Literal("fact-review"),
  outcome: Type.Literal("pass"),
  review: Type.Object({
    role: Type.Literal("fact-review"), verdict: Type.Literal("pass"), sessionId: Type.String({minLength: 1}),
    items: Type.Array(Type.Object({id: Type.String(), status: Type.String(),
      memoryUse: Type.Optional(Type.Union([Type.Literal("independent"), Type.Literal("change-evidence")]))})),
  }),
  factChecks: Type.Array(Type.Object({...factChecksParameter.items.properties,
    origin: Type.String({minLength: 1}), observedHead: Type.Optional(Type.String({pattern: "^[a-f0-9]{40}([a-f0-9]{24})?$"})),
    toolInput: Type.Optional(Type.Unknown()), toolError: Type.Optional(Type.Boolean()),
  })),
});
const archivedDocuments = new Set(["project-memory.json", "memory.json", "facts.json", "terms.json",
  "project-memory.tsv", "memory.tsv", "facts.tsv", "terms.tsv"]);
type Archive = {source: string; revision: string; document: ProjectDocument};
type SourceVersion = {id: string; sourceVersion: string};
type Entry = SourceVersion & { source: string; sourceRevision: string; target: string; record: ProjectRecord };
type Inventory = {
  legacyHead: string | null;
  ledger?: ProjectDocument;
  projectJson?: Archive & {receipt: string};
  archives: Archive[];
  entries: Entry[];
  unresolved: {source: string; reason: string}[];
};

function readLegacyDocument(root: string, revision: string) {
  const content = execFileSync("git", ["cat-file", "blob", revision + ":" + legacyFile], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  return parseLegacyProjectDocument(content);
}

function parseArchive(source: string, raw: string) {
  return source.endsWith(".tsv") ? parseProjectTsv(raw) : parseLegacyProjectDocument(raw);
}

function recordVersion(record: ProjectRecord, version: number) {
  return record.version === version ? record : record.history?.find(entry => entry.version === version);
}

function equalValues(left: ReturnType<typeof recordVersion>, right: ReturnType<typeof recordVersion>) {
  if (!left || !right) return false;
  const {migration: _, ...leftSource} = left.source;
  const {migration: __, ...rightSource} = right.source;
  return left.version === right.version && left.scope === right.scope && left.text === right.text &&
    left.deleted === right.deleted && left.type === right.type && leftSource.repository.toLowerCase() === rightSource.repository.toLowerCase() &&
    leftSource.taskId === rightSource.taskId && leftSource.taskDigest === rightSource.taskDigest && leftSource.base === rightSource.base &&
    leftSource.reviewSession === rightSource.reviewSession && leftSource.rationale === rightSource.rationale &&
    leftSource.observationFingerprint === rightSource.observationFingerprint && leftSource.factId === rightSource.factId &&
    JSON.stringify(leftSource.evidence) === JSON.stringify(rightSource.evidence);
}

function copied(current: ProjectRecord | undefined, source: ProjectRecord) {
  return !!current && current.kind === source.kind && current.key === source.key &&
    [source, ...(source.history ?? [])].every(old => equalValues(recordVersion(current, old.version), old));
}

function status(snapshot: ProjectSnapshot, entry: Entry) {
  const current = snapshot.records[entry.target];
  if (!current) return "ready";
  return copied(current, entry.record) ? "already-imported" : "conflict";
}

function addDocument(inventory: Inventory, source: string, revision: string, document: ProjectDocument, repository?: string) {
  for (const [target, record] of Object.entries(document.records)) {
    if (repository && record.source.repository.toLowerCase() !== repository.toLowerCase()) {
      inventory.unresolved.push({source: source + " " + target, reason: "归属和当前项目不一致。"});
      continue;
    }
    inventory.entries.push({id: source + "#" + target, sourceVersion: hash(JSON.stringify([revision, target, record])),
      source, sourceRevision: revision, target, record});
  }
}

function ledgerInventory(root: string, inventory: Inventory, repository?: string) {
  const head = inventory.legacyHead;
  if (!head) return;
  try {
    const document = readLegacyDocument(root, head);
    const incomplete = Object.entries(document.records).filter(([, record]) => record.version > 1 && !record.history);
    if (incomplete.length) {
      const parents = git(root, "rev-list", "--first-parent", head).split("\n").slice(1);
      const values = new Map(incomplete.map(([id]) => [id, new Map<number, NonNullable<ProjectRecord["history"]>[number]>()]));
      for (const parent of parents) {
        const prior = readLegacyDocument(root, parent);
        for (const [id, record] of incomplete) {
          const found = prior.records[id];
          if (found && found.version < record.version) {
            const {scope, text, version, deleted, source, type} = found;
            values.get(id)?.set(version, {scope, text, version, deleted, source, ...(type ? {type} : {})});
          }
        }
      }
      for (const [id, record] of incomplete) {
        record.history = [...(values.get(id)?.values() ?? [])].sort((a, b) => a.version - b.version);
        if (record.history.length < record.version - 1) {
          inventory.unresolved.push({source: legacyRef + " " + id, reason: "历史版本不完整。"});
        }
      }
    }
    inventory.ledger = document;
    addDocument(inventory, legacyRef, head, document, repository);
  } catch {
    inventory.unresolved.push({source: legacyRef, reason: "无法核对 Git 参考或旧资料的格式。"});
  }
}

function checkpointInventory(root: string, inventory: Inventory, source: string, raw: string, repository?: string) {
  let state: unknown;
  try { state = JSON.parse(raw); } catch { /* the diagnostic omits raw values */ }
  if (!Value.Check(checkpointSchema, state) || state.digest !== state.taskbook.digest ||
      !/^[\w.-]+\/[\w.-]+$/.test(state.taskbook.repository) ||
      (repository && state.taskbook.repository.toLowerCase() !== repository.toLowerCase())) {
    inventory.unresolved.push({source, reason: "检查点格式、任务摘要或项目归属无法核对。"});
    return;
  }
  for (const [reportIndex, report] of state.reports.entries()) {
    if (!report || typeof report !== "object" || !("phase" in report) || report.phase !== "fact-review" ||
        !("outcome" in report) || report.outcome !== "pass") continue;
    if (state.version === 2 || ("projectStore" in report && report.projectStore === "fact-v1")) continue;
    if (!Value.Check(reviewSchema, report)) {
      inventory.unresolved.push({source: source + "#" + (reportIndex + 1), reason: "旧核查缺少可验证的独立审核回执。"});
      continue;
    }
    for (const [index, observation] of report.factChecks.entries()) {
      const itemId = "P" + (index + 1);
      const approval = report.review.items.find(item => item.id === itemId);
      if (approval?.status !== "pass") {
        inventory.unresolved.push({source: source + "#" + itemId, reason: "旧观察没有逐项通过记录。"});
        continue;
      }
      if (approval.memoryUse === "change-evidence") continue;
      const {id: target, key, scope} = observationIdentity(observation, state.base);
      if (!gitOk(root, "cat-file", "-e", scope.slice("commit:".length) + "^{commit}")) {
        inventory.unresolved.push({source: source + "#" + itemId, reason: "观察所属 Git 版本当前无法核对。"});
        continue;
      }
      const fingerprint = observationFingerprint(observation, scope);
      const legacy = inventory.ledger?.records[target];
      if (legacy && [legacy, ...(legacy.history ?? [])].some(prior =>
        prior.source.observationFingerprint === fingerprint ||
        (prior.scope === scope && prior.text === observation.claim &&
          prior.source.evidence.includes(observation.origin + "\n" + observation.observed)))) continue;
      const id = source + "#" + (reportIndex + 1) + "/" + itemId;
      const sourceVersion = hash(JSON.stringify([state.digest, report.review.sessionId, target, observation, itemId]));
      inventory.entries.push({id, sourceVersion, source, sourceRevision: state.digest, target, record: {
        key, kind: "fact", type: "observation", scope, text: observation.claim, version: 1, deleted: false,
        source: {repository: state.taskbook.repository, taskId: state.taskbook.id, taskDigest: state.digest, base: state.base,
          reviewSession: report.review.sessionId, observationFingerprint: fingerprint,
          evidence: [itemId + " · " + observation.origin + "\n摘录 SHA-256 " + hash(observation.observed)]},
      }});
    }
  }
}

function auditInventory(root: string, inventory: Inventory, directory = auditPath, repository?: string) {
  const stat = lstatSync(join(root, directory), {throwIfNoEntry: false});
  if (!stat) return;
  if (!stat.isDirectory()) {
    inventory.unresolved.push({source: directory, reason: "审计路径要求真实目录。"});
    return;
  }
  for (const entry of readdirSync(join(root, directory), {withFileTypes: true})) {
    const source = directory + "/" + entry.name;
    try {
      const isCheckpoint = /^\.audit\/pi-taskbook\/[^/]+\/state\.json$/.test(source);
      if (entry.isDirectory()) auditInventory(root, inventory, source, repository);
      else if (entry.isFile() && (isCheckpoint || archivedDocuments.has(entry.name))) {
        const raw = readFileSync(join(root, source), "utf8");
        if (isCheckpoint) checkpointInventory(root, inventory, source, raw, repository);
        else {
          const revision = hash(raw);
          const document = parseArchive(source, raw);
          inventory.archives.push({source, revision, document});
          addDocument(inventory, source, revision, document, repository);
        }
      } else {
        inventory.unresolved.push({source, reason: "未识别的审计资料格式，保留原件。"});
      }
    } catch {
      inventory.unresolved.push({source, reason: "无法读取或验证审计资料。"});
    }
  }
}

function inventory(root: string, repository?: string) {
  const legacyHead = git(root, "for-each-ref", "--format=%(refname) %(objectname)", legacyRef).split("\n")
    .find(line => line.startsWith(legacyRef + " "))?.slice(legacyRef.length + 1) ?? null;
  const result: Inventory = {legacyHead, entries: [], unresolved: [], archives: []};
  ledgerInventory(root, result, repository);
  try {
    const local = readLegacyProjectJson(root);
    if (local) {
      const document = parseLegacyProjectDocument(local.content);
      result.projectJson = {source: legacyProjectFactsPath, revision: local.revision, receipt: local.receipt, document};
      addDocument(result, legacyProjectFactsPath, local.revision, document, repository);
    }
  } catch {
    result.unresolved.push({source: legacyProjectFactsPath, reason: "无法读取或验证旧项目事实。"});
  }
  auditInventory(root, result, auditPath, repository);
  return result;
}

export function inspectLegacyProjectMemory(root: string, repository?: string) {
  const local = readProjectMemory(root, {allowUnmigratedLegacy: true});
  const preview = inventory(root, repository);
  const alternatives = new Map<string, Entry[]>();
  for (const entry of preview.entries) {
    const candidates = alternatives.get(entry.target) ?? [];
    candidates.push(entry);
    alternatives.set(entry.target, candidates);
  }
  const entries = preview.entries.map(entry => {
      const localStatus = status(local, entry);
      const competing = alternatives.get(entry.target)?.some(other =>
        other !== entry && !copied(other.record, entry.record) && !copied(entry.record, other.record));
      return {id: entry.id, sourceVersion: entry.sourceVersion, source: entry.source, sourceRevision: entry.sourceRevision, target: projectFactsPath + "#" + entry.target,
        version: entry.record.version, status: localStatus === "ready" && competing ? "conflict" : localStatus,
        retired: entry.record.deleted, kind: entry.record.kind};
  });
  const projectJson = preview.projectJson;
  function archiveStatus(archive: Archive) {
    if (preview.unresolved.some(item => item.source === archive.source || item.source.startsWith(archive.source + " ")) ||
        entries.some(entry => entry.source === archive.source && entry.status === "conflict")) return "conflict";
    return Object.entries(archive.document.records).every(([id, record]) => copied(local.records[id], record)) &&
      Object.keys(archive.document.applied).every(id => local.applied[id]) ? "already-imported" : "ready";
  }
  const archives = preview.archives.map(archive => ({source: archive.source, sourceRevision: archive.revision, status: archiveStatus(archive)}));
  return {legacyHead: preview.legacyHead, unresolved: preview.unresolved, entries, archives,
    ...(projectJson ? {projectJson: {source: projectJson.source, sourceRevision: projectJson.revision,
      status: local.applied[projectJson.receipt] ? "already-imported" :
        archiveStatus(projectJson) === "conflict" ? "conflict" : "ready"}} : {})};
}

export function importLegacyProjectMemory(root: string, repository: string, selections: SourceVersion[],
  {projectJsonVersion, archiveVersions = []}: {projectJsonVersion?: string; archiveVersions?: {source: string; sourceRevision: string}[]} = {}) {
  if ((!selections.length && !projectJsonVersion && !archiveVersions.length) ||
      new Set(selections.map(item => item.id)).size !== selections.length) {
    throw new Error("请选择不重复的迁移条目与预览版本。");
  }
  const snapshot = readProjectMemory(root, {allowUnmigratedLegacy: true});
  const preview = inventory(root, repository);
  if (projectJsonVersion !== undefined && preview.projectJson?.revision !== projectJsonVersion) {
    throw new Error("旧 JSON 版本已变化，请重新盘点。");
  }
  const local = readLegacyProjectJson(root);
  if (local && !snapshot.applied[local.receipt] && projectJsonVersion !== local.revision) {
    throw new Error("请同时批准迁移现有的旧项目事实文件。");
  }
  const approvedArchives = new Set(archiveVersions.map(choice => {
    const archive = preview.archives.find(item => item.source === choice.source && item.revision === choice.sourceRevision);
    if (!archive) throw new Error("迁移预览中没有对应的归档版本。");
    return archive.source;
  }));
  const requested = new Map(selections.map(item => [item.id, item]));
  for (const entry of preview.entries) {
    if ((projectJsonVersion !== undefined && entry.source === legacyProjectFactsPath) || approvedArchives.has(entry.source)) {
      if (!requested.has(entry.id)) requested.set(entry.id, entry);
    }
  }
  const document: ProjectDocument = {schema: 1, records: {...snapshot.records}, applied: {...snapshot.applied}};
  let modified = false;
  const selected = [...requested.values()].flatMap(choice => {
    const marker = hash(JSON.stringify(["migration", choice.id, choice.sourceVersion]));
    const entry = preview.entries.find(item => item.id === choice.id && item.sourceVersion === choice.sourceVersion);
    if (snapshot.applied[marker]) return [];
    if (!entry) throw new Error("迁移预览中没有对应版本：" + choice.id);
    return [{entry, marker}];
  }).sort((a, b) => b.entry.record.version - a.entry.record.version);
  for (const {entry, marker} of selected) {
    const current = document.records[entry.target];
    if (!copied(current, entry.record)) {
      if (current) throw new Error("迁移目标与现有版本冲突：" + entry.target);
      document.records[entry.target] = {...entry.record, source: {...entry.record.source,
        migration: {source: entry.source, sourceVersion: entry.sourceVersion}}};
    }
    document.applied[marker] = true;
    modified = true;
  }
  function copyReceipts(source: ProjectDocument) {
    for (const marker of Object.keys(source.applied)) {
      if (document.applied[marker]) continue;
      document.applied[marker] = true;
      modified = true;
    }
  }
  function hasCompleteCopy(source: ProjectDocument) {
    return Object.entries(source.records).every(([key, record]) => copied(document.records[key], record));
  }
  const selectedSources = new Set(selected.map(({entry}) => entry.source));
  for (const archive of preview.archives) {
    if (!selectedSources.has(archive.source) && !approvedArchives.has(archive.source)) continue;
    if (hash(regularArchive(root, archive.source)) !== archive.revision) throw new Error("归档版本已变化，请重新盘点。");
    if (hasCompleteCopy(archive.document)) copyReceipts(archive.document);
    else if (approvedArchives.has(archive.source)) throw new Error("归档含归属未核对的条目，请重新盘点。");
  }
  const approvedJson = projectJsonVersion === undefined ? undefined : preview.projectJson;
  if (approvedJson) {
    if (!hasCompleteCopy(approvedJson.document)) throw new Error("旧项目事实含归属未核对的条目。");
    copyReceipts(approvedJson.document);
    if (!document.applied[approvedJson.receipt]) {
      document.applied[approvedJson.receipt] = true;
      modified = true;
    }
  }
  if (preview.ledger && selectedSources.has(legacyRef) && hasCompleteCopy(preview.ledger)) copyReceipts(preview.ledger);
  return commitProjectMemory(root, snapshot, document, "Migrate reviewed project facts", modified, {projectJsonVersion});
}

export function deleteLegacyProjectMemoryRef(root: string, expectedHead: string, repository?: string) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedHead)) throw new Error("需要迁移预览中的 Git 版本。");
  const unlock = lockProjectMemory(root);
  try {
    const preview = inventory(root, repository);
    if (!preview.legacyHead) return;
    if (preview.legacyHead !== expectedHead || !preview.ledger ||
        preview.unresolved.some(item => item.source.startsWith(legacyRef))) {
      throw new Error("旧参考版本已变化或有未核实内容，请重新预览。");
    }
    requireCommittedCopy(root, preview.ledger);
    execFileSync("git", ["update-ref", "-d", legacyRef, expectedHead], {cwd: root, stdio: "ignore"});
  } finally {
    unlock();
  }
}


function requireCommittedCopy(root: string, source: ProjectDocument) {
  if (!gitOk(root, "cat-file", "-e", "HEAD:" + projectFactsPath)) {
    throw new Error("旧资料缺少可回查的提交副本。");
  }
  const content = execFileSync("git", ["cat-file", "blob", "HEAD:" + projectFactsPath], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const committed = parseProjectTsv(content);
  if (Object.entries(source.records).some(([key, record]) => !copied(committed.records[key], record)) ||
      Object.keys(source.applied).some(key => !committed.applied[key])) {
    throw new Error("旧资料仍有条目或应用记录缺少可回查的提交副本。");
  }
  return committed;
}

function isArchivePath(path: string) {
  return path.startsWith(auditPath + "/") && !path.startsWith(auditPath + "/pi-taskbook/") &&
    posix.normalize(path) === path && archivedDocuments.has(posix.basename(path));
}

function regularArchive(root: string, path: string) {
  let absolute = root;
  for (const component of path.split("/").slice(0, -1)) {
    absolute = join(absolute, component);
    if (!lstatSync(absolute, {throwIfNoEntry: false})?.isDirectory()) throw new Error("归档资料路径要求真实目录。");
  }
  absolute = join(root, path);
  if (!lstatSync(absolute, {throwIfNoEntry: false})?.isFile()) throw new Error("归档资料路径要求普通文件。");
  return readFileSync(absolute, "utf8");
}

export function deleteLegacyProjectMemoryArchive(root: string, path: string, expectedRevision: string) {
  if ((path !== legacyProjectFactsPath && !isArchivePath(path)) || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw new Error("请选择预览中的归档路径与版本。Pi 的任务检查点需要保留。");
  }
  const unlock = lockProjectMemory(root);
  try {
    const raw = regularArchive(root, path);
    if (hash(raw) !== expectedRevision) throw new Error("归档版本已变化，请重新预览。");
    const committed = requireCommittedCopy(root, parseArchive(path, raw));
    if (path === legacyProjectFactsPath) {
      const receipt = readLegacyProjectJson(root)?.receipt;
      if (!receipt || !committed.applied[receipt]) throw new Error("旧项目事实没有已提交的迁移回执。");
    }
    if (regularArchive(root, path) !== raw) throw new Error("归档版本已变化，请重新预览。");
    unlinkSync(join(root, path));
  } finally {
    unlock();
  }
}

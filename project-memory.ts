import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { CheckedFact } from "./fact-check.ts";
import type { Taskbook } from "./taskbook.ts";

export const projectMemoryRef = "refs/pi-taskbook/project-memory";

export type ProjectKind = "fact" | "term";
export type MemorySource = { repository: string; taskId: string; taskDigest: string; base: string;
  reviewSession: string; rationale?: string; observationFingerprint?: string; evidence: string[] };
type PriorValue = {scope: string; text: string; version: number; deleted: boolean; source: MemorySource};
export type ProjectRecord = { key: string; kind: ProjectKind; scope: string; text: string;
  version: number; deleted: boolean; sharedSince?: number; source: MemorySource; history?: PriorValue[] };
export type ProjectSnapshot = { head: string | null; records: Record<string, ProjectRecord>; applied: Record<string, true> };
export type MemoryChange = { action: "create" | "update" | "delete"; kind: ProjectKind; key: string;
  expected: number; scope: string; text: string; authorization: string };
type ReviewReceipt = { role: string; verdict: string; sessionId: string; items: {id: string; status: string; reason?: string; memoryUse?: "independent" | "change-evidence"}[] };

function git(root: string, args: string[], input?: string) {
  return execFileSync("git", args, { cwd: root, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"] }).trim();
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const sharedScopes = new Set(["cross-project:rule", "cross-project:preference", "cross-project:fact", "cross-project:term"]);
const keyPattern = /^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,127}$/u;
export function memoryId(kind: ProjectKind, key: string) { return "project:" + kind + ":" + key; }
export function readProjectMemory(root: string): ProjectSnapshot {
  const head = git(root, ["for-each-ref", "--format=%(objectname)", projectMemoryRef]) || null;
  if (!head) return { head: null, records: {}, applied: {} };
  const document = JSON.parse(git(root, ["show", head + ":memory.json"]));
  if (document.schema !== 1 || !document.records || !document.applied) throw new Error("项目记忆格式无效。");
  const records = document.records as ProjectSnapshot["records"];
  // Old ledger snapshots retain the same information in their Git parents.
  const incomplete = Object.entries(records).filter(([, r]) => r.version > 1 && !r.history);
  if (incomplete.length) {
    const parents = git(root, ["rev-list", "--first-parent", head]).split("\n").slice(1);
    for (const [id, current] of incomplete) {
      const values = new Map<number, PriorValue>();
      for (const parent of parents) {
        const prior = JSON.parse(git(root, ["show", parent + ":memory.json"])).records[id];
        if (prior && prior.version < current.version) values.set(prior.version, priorValue(prior));
        if (prior?.version === 1) break;
      }
      current.history = [...values.values()].reverse();
    }
  }
  return { head, records, applied: document.applied };
}

// Explicit operations in an authored section. Ignore examples and section-like text inside code fences.
export function taskbookMemoryChanges(markdown: string): MemoryChange[] {
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
  return changes;
}

function priorValue(r: ProjectRecord): PriorValue {
  return {scope: r.scope, text: r.text, version: r.version, deleted: r.deleted, source: r.source};
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
function observationFingerprint(p: CheckedFact, scope: string) {
  const source = p.source.kind === "tool" && p.toolInput !== undefined
    ? JSON.stringify([p.origin.split(" ")[0], stableInput(p.toolInput), Boolean(p.toolError)]) : p.origin;
  return fingerprint(scope, p.claim, source + "\n" + p.observed);
}
function observationIdentity(proposal: CheckedFact, base: string) {
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
    .map(([id, r]) => ({id, text: JSON.stringify({ kind: r.kind, key: r.key, scope: r.scope,
      version: r.version, statement: r.text, source: r.source })}));
}

export function pendingMemoryChanges(task: Pick<Taskbook, "markdown" | "digest">, snapshot: ProjectSnapshot,
  decisions: {factId: string; action: "keep" | "replace"; projectChange?: MemoryChange}[] = []) {
  const requested = new Map(taskbookMemoryChanges(task.markdown).map(c => [memoryId(c.kind, c.key), c]));
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
  const records = { ...snapshot.records };
  const applied = { ...snapshot.applied };
  let modified = false;
  const source = { repository: task.repository, taskId: task.id, taskDigest: task.digest, base,
    reviewSession: review.sessionId, evidence: proposals.map((p, i) => "P" + (i + 1) + " · " + p.claim + "\n" + p.origin + "\n" + p.observed) };
  for (const [index, change] of changes.entries()) {
    const id = memoryId(change.kind, change.key);
    const mutation = hash(JSON.stringify([task.digest, change]));
    if (applied[mutation]) continue;
    const prior = records[id];
    validateChange(records, change);
    const sharedSince = prior?.sharedSince ?? (sharedScopes.has(change.scope) && change.action !== "delete" ? change.expected + 1 : undefined);
    const rationale = review.items.find(i => i.id === "M" + (index + 1))?.reason;
    records[id] = { kind: change.kind, key: change.key, version: change.expected + 1, scope: change.scope, ...(prior ? {history: [...(prior.history ?? []), priorValue(prior)]} : {}), ...(sharedSince ? {sharedSince} : {}),
      text: change.text, deleted: change.action === "delete", source: {...source, ...(rationale ? {rationale} : {}), evidence: [change.authorization, ...source.evidence]} };
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
    records[id] = { kind: "fact", key, scope, text: proposal.claim, version: 1, deleted: false,
      source: { ...source, observationFingerprint: fp, evidence: [proposal.origin + "\n" + proposal.observed] } };
    modified = true;
  }
  // The reviewer saw the whole snapshot; another task's concurrent change requires a fresh review.
  if (!modified) {
    if (readProjectMemory(root).head !== snapshot.head) throw new Error("项目记忆已变化，重交同一任务书以重新独立审核。");
    return snapshot;
  }
  const blob = git(root, ["hash-object", "-w", "--stdin"], JSON.stringify({schema: 1, records, applied}, null, 2) + "\n");
  const tree = git(root, ["mktree"], "100644 blob " + blob + "\tmemory.json\n");
  const head = git(root, ["-c","user.name=Pi Taskbook","-c","user.email=pi-taskbook@localhost","-c","commit.gpgsign=false",
    "commit-tree", tree, ...(snapshot.head ? ["-p", snapshot.head] : []), "-m", "Review project memory · " + task.id]);
  try {
    git(root, ["update-ref", projectMemoryRef, head, snapshot.head ?? "0".repeat(head.length)]);
  } catch (error) {
    if (readProjectMemory(root).head !== snapshot.head) throw new Error("另一工作区已更新项目记忆，重交同一任务书以重新独立审核。");
    throw error;
  }
  return { head, records, applied };
}

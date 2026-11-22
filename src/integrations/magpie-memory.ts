import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { lockProjectMemory, projectFactsPath, projectGlossaryPath, readProjectMemory, type ProjectRecord } from "../facts/project-memory.ts";
import { decodeTsv, encodeTsv } from "../facts/tsv.ts";
import { magpieSessionTools, type MagpieCapability } from "./mcp-catalog.ts";
import { git, gitOk } from "../taskbook/document.ts";

const exec = promisify(execFile);
const protocol = "pi-taskbook-magpie-v1";
const legacyMirrorPath = ".fact/foreign.json";
const sourceFactsFile = "facts.tsv";
const remoteTag = "pi-taskbook-v1";
type Args = Record<string, string | number | null | string[]>;
export type MagpieTransport = {
  tools: ReadonlySet<MagpieCapability>;
  call: (name: MagpieCapability, args: Args) => Promise<unknown>;
};
type SyncInput = { repository: string; digest: string; projectHead: string | null; revision: string };
type ItemResult =
  | { id: string; status: "published" | "confirmed"; remoteId: string; remoteVersion: number }
  | { id: string; status: "pending"; reason: string; remoteId?: string; remoteVersion?: number };
type MirrorResult = { status: "complete"; updated: number } | { status: "pending"; updated: number; reason: string };
export type MagpieSyncResult = { status: "complete" | "pending"; items: ItemResult[]; mirror: MirrorResult };

const nonempty = Type.String({ minLength: 1, maxLength: 512 });
const repoName = Type.String({ pattern: "^[a-z0-9_.-]+/[a-z0-9_.-]+$", maxLength: 201 });
const version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const remoteKind = Type.Union([Type.Literal("fact"), Type.Literal("rule"), Type.Literal("preference"), Type.Literal("term")]);
const remoteId = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$" });
const factId = Type.String({ pattern: "^project:(fact|term):[^\\s]+$", maxLength: 155 });
const contextSchema = Type.Object({
  protocol: Type.Literal(protocol),
  agent: Type.Object({ id: nonempty }),
  project: Type.Object({ key: nonempty }),
  search_scopes: Type.Array(Type.String()),
  capabilities: Type.Object({
    owner_isolated_create: Type.Boolean(), conditional_update: Type.Boolean(), conditional_forget: Type.Boolean(),
  }),
});
const nativeContextSchema = Type.Object({
  agent: Type.Union([Type.Null(), Type.Object({ id: nonempty })]),
  project: Type.Object({ key: nonempty }),
  scopes: Type.Array(Type.String()),
});
const rowSchema = Type.Object({
  id: remoteId,
  owner: repoName,
  fact_id: factId,
  kind: remoteKind,
  text: Type.String({ maxLength: 2000 }),
  scope: Type.Literal("global"),
  version,
  fact_version: version,
  status: Type.Union([Type.Literal("active"), Type.Literal("retired")]),
  eligible: Type.Boolean(),
  writable: Type.Boolean(),
}, {additionalProperties: false});
const pageSchema = Type.Object({
  scope: Type.Literal("global"),
  records: Type.Array(rowSchema, { maxItems: 50 }),
  next_cursor: Type.Union([Type.Null(), nonempty]),
});
const sourceFactSchema = Type.Pick(rowSchema, ["id", "owner", "fact_id", "kind", "text", "scope", "version", "fact_version", "status"],
  {additionalProperties: false});
const legacyMirrorSchema = Type.Object({
  schema: Type.Literal(1), repository: repoName, records: Type.Array(sourceFactSchema),
});
type SourceFact = Static<typeof sourceFactSchema>;
type RemoteRow = Static<typeof rowSchema>;
const scopes = new Map<string, RemoteRow["kind"]>([["cross-project:rule", "rule"], ["cross-project:preference", "preference"],
  ["cross-project:fact", "fact"], ["cross-project:term", "term"]]);
const sensitive = /-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[\w]{22,}|AKIA[0-9A-Z]{16})\b|\w+:\/\/[^/\s]+:[^/\s@]+@/i;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const requiredWriteProperties = {
  memory_save: ["id", "owner", "fact_id", "text", "scope", "kind", "fact_version", "if_version", "idempotency_key"],
  memory_forget: ["id", "owner", "fact_id", "fact_version", "if_version", "idempotency_key"],
};

function object(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function mcpPayload(value: unknown) {
  const payload = object(value);
  if (!payload) throw new Error("MCP 回执格式无效。");
  if ("isError" in payload && payload.isError === true) throw new Error("MCP 调用失败。");
  if ("structuredContent" in payload && payload.structuredContent !== undefined) return payload.structuredContent;
  const content = "content" in payload && Array.isArray(payload.content) ? payload.content : [];
  const text = content.flatMap(item => {
    const block = object(item);
    return block && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
  if (!text) throw new Error("MCP 回执缺少内容。");
  return text;
}

export function magpieSessionTransport(pi: ExtensionAPI, ctx: ExtensionToolContext, signal?: AbortSignal): MagpieTransport | undefined {
  const servers = [...magpieSessionTools(pi).values()].filter(group =>
    Object.values(group).some(tool => tool.exposure === "codemode" || tool.exposure === "deferred" || tool.exposure === "direct"));
  if (servers.length !== 1) return;
  const names = new Map<MagpieCapability, string>();
  for (const capability of ["memory_context", "memory_search", "memory_save", "memory_forget"] as const) {
    const tool = servers[0][capability];
    if (!tool || !["codemode", "deferred", "direct"].includes(tool.exposure)) continue;
    if (capability === "memory_save" || capability === "memory_forget") {
      const parameters = object(tool.parameters);
      const properties = parameters && "properties" in parameters && object(parameters.properties);
      if (!properties || !requiredWriteProperties[capability].every(key => Object.hasOwn(properties, key))) continue;
    }
    names.set(capability, tool.name);
  }
  return {
    tools: new Set(names.keys()),
    async call(capability, args) {
      const name = names.get(capability);
      if (!name) throw new Error("当前 Pi 会话缺少有条件的 Magpie 工具 " + capability + "。");
      const timeout = AbortSignal.timeout(30_000);
      const outcome = await ctx.executeTool(name, args, {signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
      if (outcome.isError || outcome.result.isError) throw new Error("Magpie " + capability + " 调用失败。");
      return mcpPayload(outcome.result.structuredContent ?? outcome.result);
    },
  };
}

function readOnlyGateway(root: string): MagpieTransport {
  return {
    tools: new Set(["memory_context", "memory_search"]),
    async call(name, args) {
      if (name !== "memory_context" && name !== "memory_search") throw new Error("CLI 后备入口只允许读操作。");
      const flags = Object.entries(args).flatMap(([key, value]) => (Array.isArray(value) ? value : [value])
        .map(item => "--" + key + "=" + item));
      try {
        const { stdout } = await exec("magpie", ["tool", name, "--json", ...flags], {
          cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8",
        });
        const result: unknown = JSON.parse(stdout);
        return mcpPayload(result);
      } catch {
        // execFile errors may include the complete argv or gateway diagnostics.
        throw new Error("Magpie " + name + " 的只读 CLI 后备入口不可用。");
      }
    },
  };
}

function assertSnapshot(root: string, input: SyncInput) {
  const snapshot = readProjectMemory(root);
  if (snapshot.head !== input.projectHead || git(root, "rev-parse", "HEAD") !== input.revision) {
    throw new Error("已审核的事实或候审提交已变化。");
  }
  for (const path of [projectFactsPath, projectGlossaryPath(root), "docs/agents/domain.md"]) {
    const committed = git(root, "ls-tree", input.revision, "--", path);
    const local = lstatSync(join(root, path), {throwIfNoEntry: false});
    const blob = /^100(?:644|755) blob ([0-9a-f]+)\t/.exec(committed)?.[1];
    if (!local && !committed) continue;
    if (!local?.isFile() || !blob || git(root, "hash-object", "--no-filters", "--", path) !== blob) {
      throw new Error("候审提交中的事实文件与工作区不一致。");
    }
  }
  return snapshot;
}

async function searchRows(transport: MagpieTransport, tags: string[]) {
  const rows = new Map<string, RemoteRow>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await transport.call("memory_search", { scope: "global", limit: 50, tags, ...(cursor ? {cursor} : {}) });
    if (!Value.Check(pageSchema, page)) throw new Error("Magpie 搜索无法核实归属、版本或分页。");
    for (const row of page.records) {
      const key = JSON.stringify([row.owner, row.id]);
      const prior = rows.get(key);
      if (prior && !isDeepStrictEqual(prior, row)) throw new Error("分页期间 Magpie 记录已变化。");
      rows.set(key, row);
    }
    cursor = page.next_cursor;
    if (cursor) {
      if (seenCursors.has(cursor) || seenCursors.size >= 20) throw new Error("Magpie 分页尚未完整读取。");
      seenCursors.add(cursor);
    }
  } while (cursor);
  return [...rows.values()];
}

function localChange(repository: string, taskDigest: string, record: ProjectRecord) {
  return record.source.repository.toLowerCase() === repository && record.source.taskDigest === taskDigest &&
    !record.source.migration && (scopes.has(record.scope) || record.sharedSince !== undefined);
}

function ownerTag(owner: string, id: string) {
  return "pi-" + digest([owner, id]).slice(0, 24);
}

function pending(id: string, reason: string, row?: RemoteRow): ItemResult {
  return { id, status: "pending", reason, ...(row ? {remoteId: row.id, remoteVersion: row.version} : {}) };
}

function matchesApprovedVersion(record: ProjectRecord, row: RemoteRow) {
  const expected = [record, ...(record.history ?? [])].find(entry => entry.version === row.fact_version);
  return expected && !expected.deleted && scopes.get(expected.scope) === row.kind && expected.text === row.text;
}

async function syncItem(root: string, input: SyncInput, transport: MagpieTransport, context: Static<typeof contextSchema>,
  owner: string, id: string, local: ProjectRecord): Promise<ItemResult> {
  const kind = scopes.get(local.scope);
  if (!local.deleted && !kind) return pending(id, "发布范围已收窄，需要明确的 Magpie 退役授权。");
  if (!local.deleted && (sensitive.test(local.text) || [...local.text].length > 2000 || /[\r\n]/.test(local.text))) {
    return pending(id, "候选含敏感内容或超出单条 Magpie 记录格式。");
  }

  const tags = [remoteTag, ownerTag(owner, id)];
  const read = async () => {
    const rows = await searchRows(transport, tags);
    if (rows.length > 1 || rows.some(row => row.owner !== owner || row.fact_id !== id || !row.writable || !row.eligible)) {
      throw new Error("Magpie 搜索返回歧义或未经授权管理的记录。");
    }
    return rows[0];
  };
  let current: RemoteRow | undefined;
  try { current = await read(); }
  catch { return pending(id, "Magpie 无法唯一核实可管理的远端记录及其版本。"); }

  if (current?.fact_version === local.version && (
    (local.deleted && current.status === "retired") ||
    (!local.deleted && current.status === "active" && current.kind === kind && current.text === local.text))) {
    return { id, status: "confirmed", remoteId: current.id, remoteVersion: current.version };
  }
  if (current && (current.status === "retired" || current.fact_version >= local.version || !matchesApprovedVersion(local, current))) {
    return pending(id, "远端版本或内容与已审核的本地版本历史不一致。", current);
  }
  if (!current && (local.deleted || local.version !== local.sharedSince)) {
    return pending(id, "未能读回既有记录或明确退役记录。", current);
  }

  const operation = local.deleted ? "memory_forget" : "memory_save";
  if (!transport.tools.has(operation) || (
    local.deleted ? !context.capabilities.conditional_forget :
      current ? !context.capabilities.conditional_update : !context.capabilities.owner_isolated_create)) {
    return pending(id, "Magpie 缺少可证明的归属隔离或版本条件，待核对 " + operation + "。", current);
  }
  if (local.deleted && (!current || !/^[-*]\s+delete\b/i.test(local.source.evidence[0] ?? ""))) {
    return pending(id, "未找到明确授权的退役操作。", current);
  }

  const args: Args = {owner, fact_id: id, fact_version: local.version, if_version: current?.version ?? null,
    idempotency_key: digest([owner, id, local.version, local.deleted, local.text]),
    ...(current ? {id: current.id} : {}),
    ...(kind && !local.deleted ? {scope: "global", kind, text: local.text} : {})};
  try {
    assertSnapshot(root, input);
    const receipt = await transport.call(operation, args);
    const saved = await read();
    if (!Value.Check(rowSchema, receipt) || !saved || !isDeepStrictEqual(saved, receipt) ||
        saved.version <= (current?.version ?? 0) || (current && current.id !== saved.id) || saved.fact_version !== local.version ||
        (local.deleted ? saved.status !== "retired" : saved.status !== "active" || saved.kind !== kind || saved.text !== local.text)) {
      return pending(id, "Magpie 回执与按归属读回的结果不一致，重试时先读回。", saved ?? current);
    }
    return {id, status: "published", remoteId: saved.id, remoteVersion: saved.version};
  } catch {
    return pending(id, "Magpie 调用或写入后的读回失败，重试时先读回。", current);
  }
}

const sourceFactColumns = ["project", "owner", "id", "fact_id", "kind", "scope", "version", "fact_version", "status", "text"];

function sourceSlug(owner: string) {
  const slug = owner.split("/")[1];
  if (!slug || !/^[a-z0-9_.-]+$/.test(slug) || [".", "..", ".git"].includes(slug)) return;
  return slug;
}

function sourceDirectory(root: string, slug?: string) {
  const parent = join(root, ".fact");
  const parentStat = lstatSync(parent, {throwIfNoEntry: false});
  if (parentStat && !parentStat.isDirectory()) throw new Error(".fact 需要真实目录。");
  if (!slug) return {path: parent, exists: Boolean(parentStat)};
  const path = join(parent, slug);
  const stat = lstatSync(path, {throwIfNoEntry: false});
  if (stat && !stat.isDirectory()) throw new Error("来源项目的事实路径需要真实目录。");
  return {path, exists: Boolean(stat)};
}

function factKey(record: SourceFact) {
  return JSON.stringify([record.owner, record.id]);
}

function readSourceTables(root: string, repository: string) {
  const directory = sourceDirectory(root);
  if (!directory.exists) return [];
  const records: SourceFact[] = [];
  for (const entry of readdirSync(directory.path, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const relative = ".fact/" + entry.name + "/" + sourceFactsFile;
    const path = join(root, relative);
    const stat = lstatSync(path, {throwIfNoEntry: false});
    if (!stat || !gitOk(root, "check-ignore", "-q", "--", relative)) continue;
    if (!stat.isFile()) throw new Error("来源项目的事实表需要是独立的本地文件。");
    const [columns, ...rows] = decodeTsv(readFileSync(path, "utf8"));
    if (!isDeepStrictEqual(columns, sourceFactColumns)) throw new Error("来源项目的事实表字段无效。");
    const keys = new Set<string>();
    for (const row of rows) {
      const [project, owner, id, fact_id, kind, scope, version, fact_version, status, text] = row;
      const record = {owner, id, fact_id, kind, scope, version: Number(version), fact_version: Number(fact_version), status, text};
      if (row.length !== sourceFactColumns.length || project !== repository || owner === repository ||
          sourceSlug(owner) !== entry.name || !Value.Check(sourceFactSchema, record) ||
          sensitive.test(record.text) || keys.has(factKey(record))) {
        throw new Error("来源项目的事实表记录无效。");
      }
      keys.add(factKey(record));
      records.push(record);
    }
  }
  return records;
}

function configureLocalExclusion(root: string, path: string, temporary?: string) {
  if (git(root, "ls-files", "--", path)) throw new Error("来源项目的事实表已被 Git 跟踪。");
  const paths = temporary ? [path, temporary] : [path];
  if (paths.every(file => gitOk(root, "check-ignore", "-q", "--", file))) return;
  const exclude = git(root, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  const directory = dirname(exclude);
  mkdirSync(directory, {recursive: true});
  if (!lstatSync(directory).isDirectory()) throw new Error("Git 本地排除规则目录无效。");
  const lock = exclude + ".lock";
  const descriptor = openSync(lock, "wx", 0o600);
  let replaced = false;
  try {
    const previous = lstatSync(exclude, {throwIfNoEntry: false});
    if (previous && !previous.isFile()) throw new Error("Git 本地排除规则需要普通文件。");
    const raw = previous ? readFileSync(exclude, "utf8") : "";
    const rules = temporary ? ["/" + path, "/" + dirname(path) + "/.facts-*.tmp"] : ["/" + path];
    const missing = rules.filter(rule => !raw.split(/\r?\n/).includes(rule));
    if (missing.length) {
      writeFileSync(descriptor, raw + (raw && !raw.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
      if (previous) fchmodSync(descriptor, previous.mode & 0o777);
      renameSync(lock, exclude);
      replaced = true;
    }
  } finally {
    closeSync(descriptor);
    if (!replaced) rmSync(lock, {force: true});
  }
  if (!paths.every(file => gitOk(root, "check-ignore", "-q", "--", file))) {
    throw new Error("仓库规则不允许将来源项目的事实表独立保存在本机。");
  }
}

function writeSourceTable(root: string, repository: string, slug: string, records: SourceFact[]) {
  const directory = sourceDirectory(root, slug);
  const path = ".fact/" + slug + "/" + sourceFactsFile;
  const stat = lstatSync(join(root, path), {throwIfNoEntry: false});
  if (stat && (!stat.isFile() || !gitOk(root, "check-ignore", "-q", "--", path))) {
    throw new Error("已有来源项目的事实表需要保留。");
  }
  const temporary = ".fact/" + slug + "/.facts-" + randomUUID() + ".tmp";
  configureLocalExclusion(root, path, temporary);
  if (!directory.exists) mkdirSync(directory.path, {recursive: true, mode: 0o700});
  const contents = encodeTsv([sourceFactColumns, ...records.map(record => [
    repository, record.owner, record.id, record.fact_id, record.kind, record.scope,
    String(record.version), String(record.fact_version), record.status, record.text,
  ])]);
  try {
    writeFileSync(join(root, temporary), contents, {mode: 0o600, flag: "wx"});
    renameSync(join(root, temporary), join(root, path));
  } finally {
    rmSync(join(root, temporary), {force: true});
  }
}

function mergeSourceFacts(root: string, repository: string, incoming: SourceFact[], mode: "sync" | "migration"): MirrorResult {
  let updated = 0;
  try {
    const snapshot = readSourceTables(root, repository);
    const records = new Map(snapshot.map(record => [factKey(record), record]));
    const visible = new Set<string>();
    const changed = new Map<string, number>();
    let conflict = false;
    for (const row of incoming) {
      const slug = sourceSlug(row.owner);
      if (!slug || sensitive.test(row.text)) { conflict = true; continue; }
      const key = factKey(row);
      visible.add(key);
      const prior = records.get(key);
      if (prior && mode === "migration" && prior.fact_id === row.fact_id && prior.version > row.version &&
          prior.fact_version >= row.fact_version) continue;
      if (prior && (prior.fact_id !== row.fact_id || row.fact_version < prior.fact_version || row.version < prior.version ||
          (row.fact_version === prior.fact_version && (row.text !== prior.text || row.status !== prior.status || row.kind !== prior.kind)) ||
          (row.version === prior.version && !isDeepStrictEqual(prior, row)))) {
        conflict = true;
        continue;
      }
      if (prior?.version === row.version) continue;
      records.set(key, row);
      changed.set(slug, (changed.get(slug) ?? 0) + 1);
    }
    for (const [slug, count] of changed) {
      writeSourceTable(root, repository, slug, [...records.values()].filter(record => sourceSlug(record.owner) === slug));
      updated += count;
    }
    if (conflict) return {status: "pending", updated, reason: "部分来源项目的记录版本、归属或保密检查未通过。"};
    if (mode === "sync" && snapshot.some(record => !visible.has(factKey(record)) && record.status === "active")) {
      return {status: "pending", updated, reason: "查询未返回既有事实的明确退役信号，已保留该事实。"};
    }
    return {status: "complete", updated};
  } catch {
    return {status: "pending", updated, reason: "无法安全写入来源项目的事实表。"};
  }
}

function readLegacyMagpieMirror(root: string, repository: string) {
  sourceDirectory(root);
  const path = join(root, legacyMirrorPath);
  const stat = lstatSync(path, {throwIfNoEntry: false});
  if (!stat) return;
  if (!stat.isFile()) throw new Error("旧 Magpie 镜像需要是普通文件。");
  const raw = readFileSync(path, "utf8");
  const data: unknown = JSON.parse(raw);
  if (!Value.Check(legacyMirrorSchema, data) || data.repository !== repository ||
      data.records.some(record => record.owner === repository || !sourceSlug(record.owner) || sensitive.test(record.text)) ||
      new Set(data.records.map(factKey)).size !== data.records.length) {
    throw new Error("旧 Magpie 镜像的格式或归属无效。");
  }
  return { revision: createHash("sha256").update(raw).digest("hex"), records: data.records };
}

export function inspectLegacyMagpieMirror(root: string, repository: string) {
  try {
    const legacy = readLegacyMagpieMirror(root, repository.toLowerCase());
    if (!legacy) return {source: legacyMirrorPath, status: "missing" as const};
    const projects = [...new Set(legacy.records.map(record => record.owner))].map(owner => ({
      owner, path: ".fact/" + sourceSlug(owner) + "/" + sourceFactsFile,
      records: legacy.records.filter(record => record.owner === owner).length,
    }));
    return {source: legacyMirrorPath, status: "ready" as const, revision: legacy.revision, projects};
  } catch {
    return {source: legacyMirrorPath, status: "invalid" as const};
  }
}

export function migrateLegacyMagpieMirror(root: string, repository: string, expectedRevision: string) {
  repository = repository.toLowerCase();
  const release = lockProjectMemory(root);
  try {
    const legacy = readLegacyMagpieMirror(root, repository);
    if (!legacy || legacy.revision !== expectedRevision) throw new Error("旧 Magpie 镜像已变化，请重新盘点。");
    const result = mergeSourceFacts(root, repository, legacy.records, "migration");
    if (result.status === "complete" && !git(root, "ls-files", "--", legacyMirrorPath)) {
      configureLocalExclusion(root, legacyMirrorPath);
    }
    return result;
  } finally {
    release();
  }
}

export async function syncMagpieMemory(root: string, input: SyncInput, transport = readOnlyGateway(root)): Promise<MagpieSyncResult> {
  const repository = input.repository.toLowerCase();
  let candidates: [string, ProjectRecord][] = [];
  const failed = (reason: string): MagpieSyncResult => ({
    status: "pending", items: candidates.map(([id]) => pending(id, reason)), mirror: {status: "pending", updated: 0, reason},
  });
  let release: (() => void) | undefined;
  try {
    release = lockProjectMemory(root);
    candidates = Object.entries(assertSnapshot(root, input).records).filter(([, record]) => localChange(repository, input.digest, record));
    if (!transport.tools.has("memory_context") || !transport.tools.has("memory_search")) {
      return failed("Magpie 同步需要可用的 memory_context 和 memory_search。");
    }
    const context = await transport.call("memory_context", {});
    if (!Value.Check(contextSchema, context)) {
      if (Value.Check(nativeContextSchema, context) && context.project.key.toLowerCase() === "github.com/" + repository &&
          context.scopes.includes("global")) {
        await transport.call("memory_search", {scope: "global", tags: [remoteTag], limit: 10});
        return failed("Magpie 原生接口缺少可验证的记录归属、版本条件或退役信号。");
      }
      return failed("Magpie memory_context 中的身份、项目或搜索范围无法与当前任务核对。");
    }
    if (context.project.key.toLowerCase() !== "github.com/" + repository || !context.search_scopes.includes("global")) {
      return failed("Magpie memory_context 中的项目或搜索范围与当前任务不匹配。");
    }
    const items: ItemResult[] = [];
    for (const [id, local] of candidates) items.push(await syncItem(root, input, transport, context, repository, id, local));
    let mirror: MirrorResult;
    try {
      const rows = await searchRows(transport, [remoteTag]);
      const sourceFacts = rows.filter(row => row.owner !== repository && row.eligible)
        .map(({eligible, writable, ...row}) => row);
      mirror = mergeSourceFacts(root, repository, sourceFacts, "sync");
    } catch {
      mirror = {status: "pending", updated: 0, reason: "Magpie 未返回可验证的其他项目事实与分页，已保留现有记录。"};
    }
    return {status: items.some(item => item.status === "pending") || mirror.status === "pending" ? "pending" : "complete", items, mirror};
  } catch {
    return failed("Magpie 同步无法核对已审核快照，或服务调用失败。");
  } finally {
    release?.();
  }
}

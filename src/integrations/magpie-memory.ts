import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { lockProjectMemory, projectFactsPath, projectGlossaryPath, readProjectMemory, type ProjectRecord } from "../facts/project-memory.ts";
import { magpieSessionTools, type MagpieCapability } from "./mcp-catalog.ts";
import { git, gitOk } from "../taskbook/document.ts";

const exec = promisify(execFile);
const protocol = "pi-taskbook-magpie-v1";
const mirrorPath = ".fact/foreign.json";
const lockPath = ".fact/foreign.lock";
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
const foreignRecordSchema = Type.Pick(rowSchema, ["id", "owner", "fact_id", "kind", "text", "scope", "version", "fact_version", "status"],
  {additionalProperties: false});
const mirrorSchema = Type.Object({
  schema: Type.Literal(1), repository: repoName, records: Type.Array(foreignRecordSchema),
});
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

export async function recallMagpieMemory(root: string, query: string, sharedKeys: string[] = [], transport = readOnlyGateway(root)) {
  try {
    if (!transport.tools.has("memory_search")) throw new Error("当前 Pi 会话缺少 memory_search。");
    const terms = new Set([query, ...sharedKeys.map(key => key.replace(/[._/-]+/g, " "))]);
    const searches = [{scope: "global", kind: "rule", limit: 8}, {scope: "global", kind: "preference", limit: 8},
      ...[...terms].map(term => ({scope: "global", query: term.slice(0, 128), limit: 8}))];
    const results: string[] = [];
    for (const args of searches) {
      const reply = await transport.call("memory_search", args);
      results.push((typeof reply === "string" ? reply : JSON.stringify(reply)).slice(0, 6000));
    }
    return {status: "available" as const, results, searches};
  } catch {
    return {status: "unavailable" as const, reason: "Magpie memory_search 只读召回不可用。", results: []};
  }
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

function foreignFile(root: string) {
  const directory = lstatSync(join(root, ".fact"), {throwIfNoEntry: false});
  if (directory && !directory.isDirectory()) throw new Error("外来事实目录格式无效。");
  const file = lstatSync(join(root, mirrorPath), {throwIfNoEntry: false});
  if (file && (!file.isFile() || !gitOk(root, "check-ignore", "-q", "--", mirrorPath))) {
    throw new Error("外来事实镜像需要是被 Git 排除的普通文件。");
  }
  return file && readFileSync(join(root, mirrorPath), "utf8");
}

export function readForeignFacts(root: string, repository: string) {
  try {
    const raw = foreignFile(root);
    if (raw === undefined) return {status: "available" as const, records: []};
    const data: unknown = JSON.parse(raw);
    if (!Value.Check(mirrorSchema, data) || data.repository !== repository.toLowerCase() ||
        data.records.some(record => record.owner === data.repository || sensitive.test(record.text))) {
      throw new Error("外来事实镜像的版本或来源无效。");
    }
    return {status: "available" as const, records: data.records};
  } catch {
    return {status: "unavailable" as const, reason: "外来事实镜像无法核对格式、归属或 Git 排除。"};
  }
}

function mirrorRows(root: string, repository: string, rows: RemoteRow[]): MirrorResult {
  const foreign = rows.filter(row => row.owner !== repository && row.eligible);
  if (!foreign.length && !lstatSync(join(root, mirrorPath), {throwIfNoEntry: false})) return {status: "complete", updated: 0};
  if (![mirrorPath, lockPath + "/"].every(path => gitOk(root, "check-ignore", "-q", "--", path))) {
    return {status: "pending", updated: 0, reason: "Git 需排除 .fact/foreign.json 与 .fact/foreign.lock 才能写外来事实镜像。"};
  }
  const file = join(root, mirrorPath);
  const lock = join(root, lockPath);
  const temporary = lock + "/" + randomUUID();
  try {
    foreignFile(root);
    const directory = join(root, ".fact");
    if (!lstatSync(directory, {throwIfNoEntry: false})) mkdirSync(directory, {mode: 0o700});
    const staging = lstatSync(lock, {throwIfNoEntry: false});
    if (staging && !staging.isDirectory()) throw new Error("外来事实镜像的暂存路径需要真实目录。");
    if (!staging) mkdirSync(lock, {mode: 0o700});
    const snapshot = readForeignFacts(root, repository);
    if (snapshot.status === "unavailable") return {status: "pending", updated: 0, reason: snapshot.reason};
    const records = new Map(snapshot.records.map(record => [JSON.stringify([record.owner, record.id]), record]));
    const visible = new Set<string>();
    let updated = 0;
    let conflict = false;
    for (const { eligible, writable, ...row } of foreign) {
      if (sensitive.test(row.text)) { conflict = true; continue; }
      const key = JSON.stringify([row.owner, row.id]);
      visible.add(key);
      const prior = records.get(key);
      if (prior && (prior.fact_id !== row.fact_id || row.fact_version < prior.fact_version || row.version < prior.version ||
          (row.fact_version === prior.fact_version && (row.text !== prior.text || row.status !== prior.status || row.kind !== prior.kind)) ||
          (row.version === prior.version && !isDeepStrictEqual(prior, row)))) {
        conflict = true;
        continue;
      }
      if (prior?.version === row.version) continue;
      records.set(key, row);
      updated++;
    }
    if (updated) {
      writeFileSync(temporary, JSON.stringify({schema: 1, repository, records: [...records.values()]}, null, 2) + "\n",
        {mode: 0o600, flag: "wx"});
      renameSync(temporary, file);
    }
    if (conflict) return {status: "pending", updated, reason: "部分镜像记录的版本、来源或保密检查未通过。"};
    if ([...records].some(([key, record]) => !visible.has(key) && record.status === "active")) {
      return {status: "pending", updated, reason: "查询未返回既有镜像的明确退役信号，已保留该镜像。"};
    }
    return {status: "complete", updated};
  } catch {
    return {status: "pending", updated: 0, reason: "无法安全写入外来事实镜像。"};
  } finally {
    if (lstatSync(lock, {throwIfNoEntry: false})?.isDirectory()) rmSync(temporary, {force: true});
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
    try { mirror = mirrorRows(root, repository, await searchRows(transport, [remoteTag])); }
    catch { mirror = {status: "pending", updated: 0, reason: "Magpie 未返回可验证的外来事实与分页，已保留现有镜像。"}; }
    return {status: items.some(item => item.status === "pending") || mirror.status === "pending" ? "pending" : "complete", items, mirror};
  } catch {
    return failed("Magpie 同步无法核对已审核快照，或服务调用失败。");
  } finally {
    release?.();
  }
}

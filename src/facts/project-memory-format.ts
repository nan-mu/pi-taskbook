import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { decodeTsv, encodeTsv } from "./tsv.ts";

export const keyPattern = /^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,127}$/u;
const nonempty = Type.String({minLength: 1});
const version = Type.Integer({minimum: 1, maximum: Number.MAX_SAFE_INTEGER});
const kindSchema = Type.Union([Type.Literal("fact"), Type.Literal("term")]);
const typeSchema = Type.Union([Type.Literal("decision"), Type.Literal("interface"), Type.Literal("observation")]);
const sourceSchema = Type.Object({
  repository: Type.String({pattern: "^[\\w.-]+/[\\w.-]+$"}),
  taskId: nonempty, taskDigest: nonempty, base: nonempty, reviewSession: nonempty,
  rationale: Type.Optional(nonempty), observationFingerprint: Type.Optional(nonempty), factId: Type.Optional(nonempty),
  evidence: Type.Array(nonempty),
  migration: Type.Optional(Type.Object({source: nonempty, sourceVersion: nonempty}, {additionalProperties: false})),
}, {additionalProperties: false});
const valueFields = {scope: nonempty, text: nonempty, version, deleted: Type.Boolean(), source: sourceSchema,
  type: Type.Optional(typeSchema)};
const priorSchema = Type.Object(valueFields, {additionalProperties: false});
const recordSchema = Type.Object({...valueFields, key: nonempty, kind: kindSchema,
  sharedSince: Type.Optional(version), history: Type.Optional(Type.Array(priorSchema))}, {additionalProperties: false});
const documentSchema = Type.Object({
  schema: Type.Literal(1), records: Type.Record(Type.String({pattern: "^project:(fact|term):"}), recordSchema, {additionalProperties: false}),
  applied: Type.Record(Type.String({pattern: "^[a-f0-9]{64}$"}), Type.Literal(true), {additionalProperties: false}),
}, {additionalProperties: false});

export type ProjectKind = Static<typeof kindSchema>;
export type PriorValue = Static<typeof priorSchema>;
export type ProjectRecord = Static<typeof recordSchema>;
export type ProjectDocument = Static<typeof documentSchema>;

export function memoryId(kind: ProjectKind, key: string) { return "project:" + kind + ":" + key; }
function validateProjectDocument(data: unknown): ProjectDocument {
  if (!Value.Check(documentSchema, data) || Object.entries(data.records).some(([id, record]) =>
    !keyPattern.test(record.key) || id !== memoryId(record.kind, record.key) ||
    (record.sharedSince !== undefined && record.sharedSince > record.version) ||
    record.history?.some((previous, index, history) =>
      previous.version >= record.version || (index > 0 && previous.version <= history[index - 1].version) ||
      previous.source.repository.toLowerCase() !== record.source.repository.toLowerCase()))) {
    throw new Error("项目事实文件的记录或版本格式无效。");
  }
  return data;
}

export function parseLegacyProjectDocument(text: string) {
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { throw new Error("旧项目事实文件的 JSON 格式无效。"); }
  return validateProjectDocument(data);
}

const columns = [
  "row", "id", "version", "kind", "key", "scope", "status", "type", "shared_since",
  "repository", "task_id", "task_digest", "base", "review_session", "rationale",
  "observation_fingerprint", "fact_id", "migration_source", "migration_version", "text",
] as const;
type TsvColumn = typeof columns[number];
type TsvRow = Record<TsvColumn, string>;

function numberCell(cell: string) {
  if (!/^[1-9]\d*$/.test(cell)) throw new Error("项目事实 TSV 的版本无效。");
  return Number(cell);
}

function requireColumns(row: TsvRow, permitted: readonly TsvColumn[]) {
  if (columns.some(column => !permitted.includes(column) && row[column])) {
    throw new Error("项目事实 TSV 的行包含无关字段。");
  }
}

export function parseProjectTsv(text: string): ProjectDocument {
  const [header, ...rows] = decodeTsv(text);
  if (header?.length !== columns.length || !columns.every((column, index) => header[index] === column)) {
    throw new Error("项目事实 TSV 表头无效。");
  }
  const applied = new Map<string, true>();
  const records = new Map<string, Record<string, unknown>>();
  const historical = new Map<string, Record<string, unknown>[]>();
  const evidenceByVersion = new Map<string, string[]>();
  const factVersions = new Set<string>();
  for (const cells of rows) {
    if (cells.length !== columns.length) throw new Error("项目事实 TSV 的字段数量无效。");
    const row = Object.fromEntries(columns.map((column, index) => [column, cells[index]])) as TsvRow;
    if (row.row === "applied") {
      requireColumns(row, ["row", "id"]);
      if (applied.has(row.id)) throw new Error("项目事实 TSV 的操作回执重复。");
      applied.set(row.id, true);
      continue;
    }
    const revision = numberCell(row.version);
    const evidenceKey = JSON.stringify([row.id, revision]);
    let evidence = evidenceByVersion.get(evidenceKey);
    if (!evidence) {
      evidence = [];
      evidenceByVersion.set(evidenceKey, evidence);
    }
    if (row.row === "evidence") {
      requireColumns(row, ["row", "id", "version", "text"]);
      evidence.push(row.text);
      continue;
    }
    const recognized = row.row === "record" || row.row === "history";
    if (!recognized || (row.status !== "active" && row.status !== "retired") ||
        Boolean(row.migration_source) !== Boolean(row.migration_version)) {
      throw new Error("项目事实 TSV 的行或状态无效。");
    }
    if (factVersions.has(evidenceKey)) throw new Error("项目事实 TSV 的事实版本重复。");
    factVersions.add(evidenceKey);
    const source = {
      repository: row.repository, taskId: row.task_id, taskDigest: row.task_digest, base: row.base,
      reviewSession: row.review_session, evidence,
      ...(row.rationale ? {rationale: row.rationale} : {}),
      ...(row.observation_fingerprint ? {observationFingerprint: row.observation_fingerprint} : {}),
      ...(row.fact_id ? {factId: row.fact_id} : {}),
      ...(row.migration_source ? {migration: {source: row.migration_source, sourceVersion: row.migration_version}} : {}),
    };
    const data = {scope: row.scope, text: row.text, version: revision, deleted: row.status === "retired",
      ...(row.type ? {type: row.type} : {}), source};
    if (row.row === "record") {
      if (records.has(row.id)) throw new Error("项目事实 TSV 的当前记录重复。");
      records.set(row.id, {...data, key: row.key, kind: row.kind, ...(row.shared_since ? {sharedSince: numberCell(row.shared_since)} : {})});
    } else {
      if (row.kind || row.key || row.shared_since) throw new Error("项目事实 TSV 的历史行包含当前记录字段。");
      const history = historical.get(row.id) ?? [];
      history.push(data);
      historical.set(row.id, history);
    }
  }
  if ([...evidenceByVersion.keys()].some(key => !factVersions.has(key))) {
    throw new Error("项目事实 TSV 有证据行缺少相应事实版本。");
  }
  for (const [id, history] of historical) {
    const record = records.get(id);
    if (!record) throw new Error("项目事实 TSV 有历史版本缺少当前记录。");
    record.history = history;
  }
  return validateProjectDocument({schema: 1, records: Object.fromEntries(records), applied: Object.fromEntries(applied)});
}

export function formatProjectTsv(document: ProjectDocument) {
  const rows: string[][] = [[...columns]];
  function append(fields: Partial<TsvRow>) {
    rows.push(columns.map(column => fields[column] ?? ""));
  }
  function versionRows(row: "record" | "history", id: string, value: PriorValue, current?: ProjectRecord) {
    const {source} = value;
    append({
      row, id, version: String(value.version), kind: current?.kind, key: current?.key, scope: value.scope,
      status: value.deleted ? "retired" : "active", type: value.type,
      shared_since: current?.sharedSince === undefined ? undefined : String(current.sharedSince),
      repository: source.repository, task_id: source.taskId, task_digest: source.taskDigest,
      base: source.base, review_session: source.reviewSession, rationale: source.rationale,
      observation_fingerprint: source.observationFingerprint, fact_id: source.factId,
      migration_source: source.migration?.source, migration_version: source.migration?.sourceVersion, text: value.text,
    });
    for (const evidence of source.evidence) {
      append({row: "evidence", id, version: String(value.version), text: evidence});
    }
  }
  for (const id of Object.keys(document.records).sort()) {
    const current = document.records[id];
    versionRows("record", id, current, current);
    for (const previous of current.history ?? []) versionRows("history", id, previous);
  }
  for (const id of Object.keys(document.applied).sort()) append({row: "applied", id});
  return encodeTsv(rows);
}

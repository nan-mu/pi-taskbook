import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { Type, type Static } from "typebox";
import { git, gitOk, type Taskbook } from "../taskbook/document.ts";
import type { TaskItem } from "../workflow/task-context.ts";
import { readFactFile } from "./commit-files.ts";
import { modelSettingsPath, projectModelPolicy, projectModelsFile } from "../models/storage.ts";
import { type MemoryChange, type ProjectSnapshot } from "./project-memory.ts";
import type { FactMatch } from "./query.ts";
import { decodeTsv } from "./tsv.ts";

const columns = ["id", "fact", "source", "labels"];
const labelPath = ".fact/label.tsv";
export const defaultFactTable = ".fact/records.tsv";
const normalize = (text: string) => text.normalize("NFKC").trim().replace(/\s+/gu, " ").replace(/[.。]+$/u, "");
export const taskFactLabel = (task: Pick<Taskbook, "digest">) => "taskbook:" + task.digest.slice(0, 16);
export type IntakeDecision = {id: string; action: "create" | "use" | "update" | "delete"; detail: string};
export type IntakeConflict = {id: string; reason: string};

export function readFactTables(root: string) {
  const tables = new Map<string, FactMatch[]>();
  const modelPath = projectModelPolicy(root)?.path ?? projectModelsFile;
  function scan(dir: string) {
    for (const entry of readdirSync(join(root, dir), {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = dir + "/" + entry.name;
      if (entry.isDirectory()) scan(path);
      if (!entry.isFile() || !entry.name.endsWith(".tsv") || [labelPath, modelSettingsPath, modelPath, projectModelsFile].includes(path) ||
          entry.name === "change.tsv") continue;
      const [header, ...rows] = decodeTsv(readFactFile(root, path) ?? "");
      if (header?.join("\t") !== columns.join("\t")) continue;
      if (rows.some(row => row.length !== 4 || !row[0].trim() || !row[1].trim())) throw new Error("事实表格式无效：" + path);
      tables.set(path, rows.map(([id, fact, source, labels]) => ({path, id, fact, source, labels: labels.split(",").filter(Boolean)})));
    }
  }
  const dir = lstatSync(join(root, ".fact"), {throwIfNoEntry: false});
  if (dir && !dir.isDirectory()) throw new Error(".fact 须为真实目录。");
  if (dir) scan(".fact");
  const labels = readFactFile(root, labelPath);
  return {tables, labels, head: createHash("sha256").update(JSON.stringify([labels, [...tables]])).digest("hex")};
}

function matchesVersion(root: string, row: FactMatch, version: string) {
  const tip = git(root, "log", "-1", "--format=%H", "--", row.path);
  if (/^[a-f0-9]{7,64}$/iu.test(version)) return tip.startsWith(version.toLowerCase());
  if (!/^v[1-9]\d*$/iu.test(version)) return false;
  const history = git(root, "log", "--reverse", "--format=%H", "--", row.path).split("\n").filter(Boolean);
  let previous: string | undefined;
  let count = 0;
  for (const revision of history) {
    const object = revision + ":" + row.path;
    const current = gitOk(root, "cat-file", "-e", object) ? decodeTsv(git(root, "show", object)).find(cells => cells[0] === row.id)?.[1] : undefined;
    if (current !== undefined && current !== previous) count++;
    previous = current;
  }
  return previous === row.fact && count === Number(version.slice(1));
}

function parseReference(body: string) {
  const match = /^(?:`([^`]+)`|([^\s：]+?))\s*(?:[（(][^`）)]*`([^`]+)`[）)])?\s*(?:(?:：|:\s+)\s*([\s\S]+))?$/u.exec(body);
  return match && {id: match[1] ?? match[2], version: match[3], text: match[4]};
}

// Previous releases committed an entire input at intake. A later restore must
// recognize a retirement from that commit without reapplying its mutations.
function legacyRetirements(root: string, commit: string) {
  const load = (revision: string, path: string) => {
    const ref = revision + ":" + path;
    if (!gitOk(root, "cat-file", "-e", ref)) return [];
    const [header, ...rows] = decodeTsv(execFileSync("git", ["cat-file", "blob", ref], {cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024}));
    return header?.join("\t") === columns.join("\t") ? rows : [];
  };
  const parent = commit + "^";
  const paths = git(root, "diff", "--name-only", "--no-renames", "-z", parent, commit, "--", ".fact").split("\0").filter(path => path.endsWith(".tsv"));
  return paths.flatMap(path => {
    const after = new Set(load(commit, path).map(cells => cells[0]));
    return load(parent, path).filter(cells => !after.has(cells[0])).map(([id, fact]) => ({id, fact, path}));
  });
}

export const intakeTargetsParameter = Type.Array(Type.Object({
  id: Type.String({minLength: 1}),
  target: Type.String({minLength: 1, description: "Existing path#row-id that disambiguates the taskbook reference."}),
}, {additionalProperties: false}));
type IntakeTarget = Static<typeof intakeTargetsParameter>[number];

export type FactOperation = "create" | "use" | "update" | "delete";
export type TaskFactEntry = {item: string; operation: FactOperation; row: FactMatch; reason?: string};
export type TaskFactView = {
  label: string; topicHead: string; projectHead: string | null;
  entries: TaskFactEntry[]; memoryChanges: MemoryChange[]; sessionId: string;
};

export function validateFactTablePath(root: string, path: string, tables: Map<string, FactMatch[]>) {
  const reserved = [modelSettingsPath, projectModelPolicy(root)?.path, projectModelsFile, ".fact/facts.tsv", ".fact/label.tsv"];
  const parts = path.split("/");
  if (!path.startsWith(".fact/") || !path.endsWith(".tsv") || posix.normalize(path) !== path ||
      parts.slice(1).some(part => !part || part.startsWith(".") || /[\\\x00-\x1f#]/u.test(part)) ||
      reserved.includes(path) || path.startsWith(".fact/taskbook/") || ["change.tsv", "label.tsv"].includes(parts.at(-1)!) ||
      (path === ".fact/always.tsv" && !tables.has(path)) || (readFactFile(root, path) !== undefined && !tables.has(path))) {
    throw new Error("请选择可写入的事实表：" + path);
  }
}

export function importTaskFacts({root, task, items, expectedHead, project, sessionId, memoryChanges, decisions = [], targets = []}: {
  root: string; task: Taskbook; items: TaskItem[]; expectedHead: string; project: ProjectSnapshot; base: string;
  sessionId: string; memoryChanges: MemoryChange[]; decisions?: IntakeDecision[]; targets?: IntakeTarget[];
}) {
  const snapshot = readFactTables(root);
  if (snapshot.head !== expectedHead) throw new Error("事实表已变化，请按当前版本重新核对。");
  if (new Set(targets.map(x => x.id)).size !== targets.length || targets.some(x => !items.some(item => item.id === x.id))) {
    throw new Error("事实定位须使用唯一的当前任务条目标识。");
  }
  const label = taskFactLabel(task);
  const entries: TaskFactEntry[] = [];
  const conflicts: IntakeConflict[] = [];
  const facts: TaskItem[] = [];
  const existing = [...snapshot.tables.values()].flat();
  const catalog = decodeTsv(snapshot.labels ?? "label\tdescription\n");
  if (catalog[0]?.join("\t") !== "label\tdescription") throw new Error(".fact/label.tsv 表头无效。");
  const knownLabels = new Set(catalog.slice(1).map(cells => cells[0]));
  knownLabels.add("terms");
  const marker = "Taskbook-Input: " + task.digest;
  const recorded = git(root, "log", "-1", "--format=%H", "--fixed-strings", "--grep=" + marker);
  const importedAt = recorded && git(root, "show", "-s", "--format=%B", recorded).split("\n").includes(marker) ? recorded : undefined;
  let retirements: ReturnType<typeof legacyRetirements> | undefined;
  const byItem = new Map(targets.map(x => [x.id, x.target]));
  for (const item of items) {
    const explicit = /^`(create|use|update|delete)`\s*·\s*`([^`]+)`(?:\s*·\s*`([^`]+)`)?\s*[—–-]\s*([\s\S]+)$/u.exec(item.text);
    if (!explicit && /^`(?:create|use|update|delete)`/u.test(item.text)) throw new Error("任务书事实操作格式无效：" + item.id);
    const authored = (explicit?.[1] ?? "create") as FactOperation;
    const decision = decisions.findLast(choice => choice.id === item.id);
    let operation = decision?.action ?? authored;
    if (operation === "delete" && authored !== "delete") throw new Error("删除裁决须指向原任务书的删除操作：" + item.id);
    const body = (explicit?.[4] ?? item.text).trim();
    const source = task.id + "@" + task.digest + "#" + item.id;
    const supplied = byItem.get(item.id);
    const labels = explicit?.[3]?.split(",").map(value => value.trim()) ?? [];
    if (labels.some(tag => !knownLabels.has(tag)) || (labels.length && authored !== "create")) {
      throw new Error("新事实标签须已在目录中登记：" + item.id);
    }
    const conflict = (reason: string) => conflicts.push({id: item.id, reason});
    let row: FactMatch;
    let reason: string | undefined;
    const imported = existing.find(row => row.source === source);
    // Runs saved by earlier versions may already have registered these rows.
    if (imported && !decision && !item.userDecision) {
      row = imported;
      operation = "use";
    } else if (importedAt && !item.userDecision && operation !== "use") {
      const reference = parseReference(body);
      if (operation === "delete" && reference && !supplied && !decision) {
        const matches = (row: {id: string; fact: string; path: string}) => row.id === reference.id ||
          row.path + "#" + row.id === reference.id || normalize(row.fact) === normalize(reference.id);
        retirements ??= legacyRetirements(root, importedAt);
        if (!existing.some(matches) && retirements.filter(matches).length === 1) continue;
      }
      conflict("这个任务书已登记并且对应事实已变化，请核对当前版本并使用新任务书授权。");
      continue;
    } else if (operation === "create") {
      const path = explicit?.[2].startsWith(".fact/") ? explicit[2] :
        decision?.detail.startsWith(".fact/") ? decision.detail : item.topicFact?.path ?? defaultFactTable;
      if (supplied && supplied !== path) throw new Error("提交的目标与任务书指定的创建路径不一致：" + item.id);
      validateFactTablePath(root, path, snapshot.tables);
      const fact = item.userDecision?.action === "replace" ? item.userDecision.text : body;
      const duplicate = [...existing, ...entries.filter(x => x.operation !== "delete").map(x => x.row)].find(x => normalize(x.fact) === normalize(fact));
      const prior = Object.values(project.records).find(record => !record.deleted && normalize(record.text) === normalize(fact));
      if ((duplicate || prior) && decision?.action !== "create") {
        conflict("与已登记或待登记事实重合：" + (duplicate ? duplicate.path + "#" + duplicate.id : prior!.key));
        continue;
      }
      row = {path, id: label + ":" + item.id, fact, source, labels: [...new Set(labels)]};
      if (snapshot.tables.get(path)?.some(candidate => candidate.id === row.id)) {
        conflict("新记录的来源与现有标识冲突：" + row.id);
        continue;
      }
    } else {
      const reference = parseReference(body);
      const selector = decision ? decision.detail : reference?.id;
      const locate = (target: string | undefined) => existing.filter(row => row.id === target || row.path + "#" + row.id === target ||
        (target !== undefined && normalize(row.fact) === normalize(target)));
      const direct = locate(selector);
      if (!direct.length) { conflict("指定的已有事实不存在：" + selector); continue; }
      if (direct.length > 1 && !supplied) { conflict("现有事实对应多个条目，请明确其路径：" + selector); continue; }
      const choice = supplied ? locate(supplied) : direct;
      if (choice.length !== 1 || (supplied && direct.length && !direct.includes(choice[0]))) {
        conflict("需要定位唯一的已有事实：" + (selector ?? body));
        continue;
      }
      const current = choice[0];
      if (reference?.version && !decision && !matchesVersion(root, current, reference.version)) {
        conflict("事实 " + current.id + " 的前版与任务书不符。");
        continue;
      }
      if (entries.some(entry => entry.row.path === current.path && entry.row.id === current.id &&
           (operation !== "use" || entry.operation !== "use"))) {
        conflict("一个事实对应多个可能冲突的操作：" + current.id);
        continue;
      }
      const replacement = item.userDecision?.action === "replace" ? item.userDecision.text : authored === "create" ? body : reference?.text;
      if (item.userDecision?.action === "replace" && operation === "use") operation = "update";
      if ((operation === "update" || operation === "delete") && !replacement?.trim()) {
        conflict(operation === "delete" ? "退役须说明缘由：" + current.id : "更新需要完整的新事实：" + current.id);
        continue;
      }
      if (operation === "delete") reason = replacement;
      row = operation === "update" ? {...current, fact: replacement!.trim(), source} : current;
    }
    entries.push({item: item.id, operation, row, ...(reason ? {reason} : {})});
    facts.push({...item, text: operation === "delete" ? "Retire this fact: " + row.fact + "\nReason: " + reason : row.fact,
      operation, topicFact: {path: row.path, id: row.id}});
  }
  if (conflicts.length) return {kind: "conflict" as const, conflicts};
  const view: TaskFactView = {label, entries, topicHead: snapshot.head, projectHead: project.head, memoryChanges, sessionId};
  return {kind: "complete" as const, facts, view, revision: git(root, "rev-parse", "HEAD"), head: snapshot.head, projectHead: project.head};
}

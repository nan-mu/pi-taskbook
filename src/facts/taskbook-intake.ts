import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { git, gitOk, type Taskbook } from "../taskbook/document.ts";
import type { TaskItem } from "../workflow/task-context.ts";
import { readFactFile } from "./commit-files.ts";
import { commitTaskbookMemory, type MemoryChange, type ProjectSnapshot } from "./project-memory.ts";
import type { FactMatch } from "./query.ts";
import { decodeTsv, encodeTsv } from "./tsv.ts";

const columns = ["id", "fact", "source", "labels"];
const labelPath = ".fact/label.tsv";
const normalize = (text: string) => text.normalize("NFKC").trim().replace(/\s+/gu, " ").replace(/[.。]+$/u, "");
export const taskFactLabel = (task: Pick<Taskbook, "digest">) => "taskbook:" + task.digest.slice(0, 16);
export type IntakeDecision = {id: string; action: "create" | "use" | "update"; detail: string};
export type IntakeConflict = {id: string; reason: string};

export function readTopicFacts(root: string) {
  const tables = new Map<string, FactMatch[]>();
  function scan(dir: string) {
    for (const entry of readdirSync(join(root, dir), {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = dir + "/" + entry.name;
      if (entry.isDirectory()) scan(path);
      if (!entry.isFile() || !entry.name.endsWith(".tsv") || path === labelPath || entry.name === "change.tsv") continue;
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

export function importTaskFacts({root, task, items, expectedHead, project, base, sessionId, memoryChanges, decisions = []}: {
  root: string; task: Taskbook; items: TaskItem[]; expectedHead: string; project: ProjectSnapshot; base: string;
  sessionId: string; memoryChanges: MemoryChange[]; decisions?: IntakeDecision[];
}) {
  const snapshot = readTopicFacts(root);
  if (snapshot.head !== expectedHead) throw new Error("事实表已变化，请按当前版本重新核对。");
  const {tables} = snapshot;
  const existing = [...tables.values()].flat();
  const label = taskFactLabel(task);
  const destination = ".fact/taskbook/" + task.digest + ".tsv";
  const changes = new Map<string, string>();
  const edited = new Set<string>();
  const altered = new Set<FactMatch>();
  const facts: TaskItem[] = [];
  const conflicts: IntakeConflict[] = [];
  const applied = Boolean(git(root, "log", "-1", "--format=%H", "--fixed-strings", "--grep=Taskbook-Input: " + task.digest));

  for (const item of items) {
    const explicit = /^`(create|use|update|delete)`\s*·\s*`[^`]+`\s*[—–-]\s*([\s\S]+)$/u.exec(item.text);
    const action = explicit?.[1] ?? "create";
    const body = explicit?.[2] ?? item.text;
    const decision = decisions.findLast(choice => choice.id === item.id);
    const operation = decision?.action ?? action;
    const source = task.id + "@" + task.digest + "#" + item.id;
    if (item.topicFact && item.userDecision?.action === "replace") {
      const pointer = item.topicFact;
      const row = tables.get(pointer.path)?.find(candidate => candidate.id === pointer.id);
      if (!row || !row.labels.includes(label)) throw new Error("用户裁决引用的任务书事实已变化：" + item.id);
      row.fact = item.userDecision.text;
      row.source = source;
      edited.add(row.path);
      facts.push({...item, text: row.fact});
      continue;
    }
    const same = existing.find(row => row.source === source);
    if (same) {
      if (operation !== "delete") facts.push({...item, text: same.fact, topicFact: {path: same.path, id: same.id}});
      continue;
    }

    if (operation === "create") {
      const duplicate = [...tables.values()].flat().find(row => normalize(row.fact) === normalize(body)) ??
        Object.entries(project.records).flatMap(([id, record]) => !record.deleted && normalize(record.text) === normalize(body)
          ? [{id, path: ".fact/facts.tsv"}] : [])[0];
      if (duplicate && decision?.action !== "create") {
        conflicts.push({id: item.id, reason: "与已登记事实 " + duplicate.id + "（" + duplicate.path + "）内容相同。"});
        continue;
      }
      if (applied) {
        conflicts.push({id: item.id, reason: "本任务曾导入该事实，现行记录已经改变。请用新任务书确认变更。"});
        continue;
      }
      const rows = tables.get(destination) ?? [];
      const id = label + ":" + item.id;
      rows.push({path: destination, id, fact: body, source, labels: [label]});
      tables.set(destination, rows);
      edited.add(destination);
      facts.push({...item, text: body, topicFact: {path: destination, id}});
      continue;
    }

    const reference = parseReference(body);
    const target = decision?.detail ?? reference?.id;
    const found = existing.filter(row => row.id === target || row.path + "#" + row.id === target);
    if (applied && operation === "delete" && !found.length && target) continue;
    if (found.length !== 1) {
      conflicts.push({id: item.id, reason: "需要唯一的已有事实 ID 或路径#ID，当前指定 " + (target ?? "空") + "。"});
      continue;
    }
    const row = found[0];
    if (reference?.version && !decision && !matchesVersion(root, row, reference.version)) {
      conflicts.push({id: item.id, reason: "事实 " + row.id + " 的前版与任务书不符。"});
      continue;
    }
    if (operation !== "use" && (applied || altered.has(row))) {
      conflicts.push({id: item.id, reason: "事实 " + row.id + " 已经有变更，请核对当前版本并明确唯一的变更。"});
      continue;
    }
    if (operation === "update" && !(decision && action === "create" ? body : reference?.text)?.trim()) {
      conflicts.push({id: item.id, reason: "更新 " + row.id + " 需要提供完整的新事实。"});
      continue;
    }
    if (operation === "delete") {
      if (!reference?.text?.trim()) {
        conflicts.push({id: item.id, reason: "退役 " + row.id + " 需要说明缘由。"});
        continue;
      }
      tables.set(row.path, tables.get(row.path)!.filter(entry => entry !== row));
      altered.add(row);
      edited.add(row.path);
      continue;
    }
    if (operation === "update") {
      row.fact = (decision && action === "create" ? body : reference?.text ?? "").trim();
      row.source = source;
      altered.add(row);
    }
    row.labels = [...new Set([...row.labels, label])];
    edited.add(row.path);
    facts.push({...item, text: row.fact, topicFact: {path: row.path, id: row.id}});
  }

  if (conflicts.length) return {kind: "conflict" as const, conflicts};
  if (facts.length) {
    const labels = decodeTsv(snapshot.labels ?? "label\tdescription\n");
    if (labels[0]?.join("\t") !== "label\tdescription") throw new Error(".fact/label.tsv 表头无效。");
    if (!labels.slice(1).some(row => row[0] === label)) labels.push([label, "Facts supplied by taskbook " + task.id + "."]);
    changes.set(labelPath, encodeTsv(labels));
  }
  for (const path of edited) {
    changes.set(path, encodeTsv([columns, ...tables.get(path)!.map(row => [row.id, row.fact, row.source, row.labels.join(",")])]));
  }
  const savedProject = commitTaskbookMemory(root, project, task, base, memoryChanges, sessionId, changes, () => {
    if (readTopicFacts(root).head !== expectedHead) throw new Error("事实表在同步期间已变化。");
  });
  return {kind: "complete" as const, facts, revision: git(root, "rev-parse", "HEAD"), head: readTopicFacts(root).head, projectHead: savedProject.head};
}

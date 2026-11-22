import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectLegacyProjectMemory } from "../facts/project-memory-migration.ts";
import { defaultFactTable, readFactTables, validateFactTablePath } from "../facts/taskbook-intake.ts";
import { decodeTsv } from "../facts/tsv.ts";
import { git, gitOk, readTaskbook, validTaskBranch } from "../taskbook/document.ts";
import { privateDirectory } from "../taskbook/private-directory.ts";
import { taskAuthoredFacts } from "../workflow/task-context.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const sourceHeading = "\n## Migration sources\n";
type Source = {id: string; path: string; sourceVersion: string};
type Selection = {id: string; path?: string};

function migrationDirectory(root: string, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("旧审计目录的摘要无效。");
  return join(git(root, "rev-parse", "--absolute-git-dir"), "pi-taskbook", "audit-inputs", digest);
}

// A prepared input is only a proposal. Count a source after its own row has
// been registered in a signed task that's part of this checkout's history.
function registeredSources(root: string, digest: string) {
  const found = new Set<string>();
  const directory = migrationDirectory(root, digest);
  if (!lstatSync(directory, {throwIfNoEntry: false})?.isDirectory()) return found;
  for (const file of readdirSync(directory, {withFileTypes: true})) {
    if (!file.isFile() || !/^[a-f0-9]{64}\.md$/.test(file.name)) continue;
    const task = readTaskbook(root, join(directory, file.name));
    if (hash(task.markdown) + ".md" !== file.name) throw new Error("迁移输入的内容已变化，请保留原件。");
    const revision = git(root, "log", "-1", "--format=%H", "--grep=^Taskbook-Registration: " + task.digest + "$");
    if (!revision) continue;
    const sources: Source[] = JSON.parse(task.markdown.slice(task.markdown.lastIndexOf(sourceHeading) + sourceHeading.length));
    const rowsByPath = new Map<string, string[][]>();
    for (const [index, choice] of sources.entries()) {
      if (!rowsByPath.has(choice.path)) {
        const object = revision + ":" + choice.path;
        rowsByPath.set(choice.path, gitOk(root, "cat-file", "-e", object) ? decodeTsv(git(root, "show", object)) : []);
      }
      if (rowsByPath.get(choice.path)!.some(row => row[2] === task.id + "@" + task.digest + "#F" + (index + 1))) {
        found.add(choice.sourceVersion);
      }
    }
  }
  return found;
}

export function inspectAuditFacts(root: string, repository: string, digest: string) {
  const legacy = inspectLegacyProjectMemory(root, repository);
  const registered = registeredSources(root, digest);
  const entries = legacy.entries.filter(entry => entry.source.startsWith(".audit/")).map(entry => ({
    ...entry, status: registered.has(entry.sourceVersion) ? "already-imported" as const : entry.status,
  }));
  const archives = legacy.archives.filter(entry => entry.source.startsWith(".audit/")).map(archive => {
    const members = entries.filter(entry => entry.source === archive.source);
    const complete = members.length && members.every(entry => entry.status === "already-imported") &&
      !legacy.unresolved.some(issue => issue.source === archive.source || issue.source.startsWith(archive.source + " "));
    return {...archive, status: complete ? "already-imported" as const : archive.status};
  });
  const unresolved = legacy.unresolved.filter(entry => entry.source.startsWith(".audit/"));
  return {entries, archives, unresolved};
}

export function prepareAuditFactInput(root: string, repository: string, digest: string, branch: string,
  selections: Selection[], inventory: ReturnType<typeof inspectAuditFacts>) {
  if (!validTaskBranch(root, branch) ||
      !selections.length || new Set(selections.map(item => item.id)).size !== selections.length) {
    throw new Error("迁移需要明确工作分支和不重复的候选事实。");
  }
  const snapshot = readFactTables(root);
  const sources: Source[] = [];
  const items = selections.map(({id, path = defaultFactTable}) => {
    const entry = inventory.entries.find(item => item.id === id);
    if (!entry || entry.status !== "ready" || entry.retired) throw new Error("这条旧事实尚不可迁移：" + id);
    validateFactTablePath(root, path, snapshot.tables);
    if (path.includes("`")) {
      throw new Error("请使用能在任务书中引用的事实表路径。");
    }
    sources.push({id, path, sourceVersion: entry.sourceVersion});
    const prefix = entry.scope === "project" ? "" : "[" + entry.scope + "] ";
    return "`create` · `" + path + "`" + (entry.kind === "term" ? " · `terms`" : "") + " — " + prefix + entry.text;
  });
  const base = git(root, "rev-parse", "HEAD");
  const taskId = "audit-" + hash(JSON.stringify([digest, base, branch, sources])).slice(0, 24);
  const markdown = ["# Migrate reviewed audit facts", "", "Taskbook ID: " + taskId, "Repository: " + repository,
    "Base commit: " + base, "Work branch: " + branch, "Entry: New feature", "", "## Goal", "",
    "Reconcile the selected audit facts against the current project and register the reviewed result.", "",
    "## Facts", "", ...items.map((item, index) => (index + 1) + ". " + item), "", "## Delivery", "",
    "Report the registered facts and any conflicts. Preserve the original audit material.", "",
    "## Migration sources", JSON.stringify(sources), ""].join("\n");
  const parsed = taskAuthoredFacts(markdown);
  if (parsed.length !== items.length || parsed.some((item, index) => item.text !== items[index])) {
    throw new Error("旧事实中的 Markdown 改变了分段，请先单独核对原文。");
  }
  const directory = privateDirectory(git(root, "rev-parse", "--absolute-git-dir"), "pi-taskbook", "audit-inputs", digest);
  const path = join(directory, hash(markdown) + ".md");
  try { writeFileSync(path, markdown, {mode: 0o600, flag: "wx"}); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !lstatSync(path).isFile() || readFileSync(path, "utf8") !== markdown) throw error;
  }
  return {input: path, branch, candidates: selections.length, existingWorktree: '/taskbook "' + path + '"',
    newWorktree: '/taskbook-new "' + path + '"'};
}

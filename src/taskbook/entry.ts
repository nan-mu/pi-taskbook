import { randomUUID } from "node:crypto";
import { realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { privateDirectory } from "../workflow/run-paths.ts";
import { git, parseTaskbook, readTaskbook, resolveBase, taskRepository, workspace, type Taskbook } from "./document.ts";

export type PreparedEntry = { path: string; worktree?: string; digest: string; base: string; branch?: string };
const preparedPrefix = "--prepared ";

export function readEntryArgument(argument: string): { path: string; prepared?: PreparedEntry } {
  if (!argument.startsWith(preparedPrefix)) return { path: argument };
  const input = JSON.parse(Buffer.from(argument.slice(preparedPrefix.length), "base64url").toString("utf8")) as Partial<PreparedEntry>;
  if (typeof input.path !== "string" || !isAbsolute(input.path) ||
      (input.worktree !== undefined && (typeof input.worktree !== "string" || !isAbsolute(input.worktree))) ||
      typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest) ||
      typeof input.base !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.base) ||
      (input.branch !== undefined && (typeof input.branch !== "string" || !input.branch))) {
    throw new Error("新 worktree 的启动数据无效。");
  }
  return { path: input.path, prepared: { path: input.path, worktree: input.worktree, digest: input.digest, base: input.base,
    branch: input.branch } };
}

export function readTaskbookInput(cwd: string, argument: string): Taskbook {
  const markdown = argument.trim();
  if (!markdown.includes("\n") || (markdown.startsWith('"') && markdown.endsWith('"'))) {
    return readTaskbook(cwd, argument);
  }
  const task = parseTaskbook(markdown);
  const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const directory = privateDirectory(common, "pi-taskbook", "inputs");
  const sourcePath = join(directory, task.digest + ".md");
  const temporary = sourcePath + "." + randomUUID();
  try {
    writeFileSync(temporary, markdown, { flag: "wx", mode: 0o600 });
    renameSync(temporary, sourcePath);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { ...task, sourcePath };
}

export function verifyPreparedEntry(cwd: string, task: Taskbook, prepared?: PreparedEntry) {
  if (!prepared) return workspace(cwd, task);
  if (prepared.digest !== task.digest) throw new Error("任务书或随附事实在创建 worktree 后发生变化。");
  if (task.baseCommit && prepared.base.toLowerCase() !== task.baseCommit.toLowerCase()) {
    throw new Error("启动数据的基线与任务书不同。");
  }
  const candidate = workspace(cwd, task, prepared.base, prepared.branch);
  if (prepared.worktree && realpathSync(candidate.root) !== prepared.worktree) throw new Error("Pi 当前目录与启动数据的 worktree 不一致。");
  return candidate;
}

export function prepareTaskLaunch(cwd: string, task: Taskbook) {
  const branch = task.branch;
  if (!branch) throw new Error("创建 T3 worktree 要求任务书通过 Work branch 指定新分支。");
  const project = taskRepository(cwd, task);
  const base = resolveBase(project, task, true);
  const prepared: PreparedEntry = { path: task.sourcePath, digest: task.digest, base, branch };
  return {
    base,
    branch,
    message: "/taskbook " + preparedPrefix + Buffer.from(JSON.stringify(prepared)).toString("base64url"),
  };
}

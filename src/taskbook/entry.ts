import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveBase, taskRepository, workspace, type Taskbook } from "./document.ts";

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
  const project = taskRepository(cwd, task);
  const base = resolveBase(project, task, true);
  const branch = task.branch ?? "agent/" + task.id;
  const prepared: PreparedEntry = { path: task.sourcePath, digest: task.digest, base, branch };
  return {
    base,
    branch,
    message: "/taskbook " + preparedPrefix + Buffer.from(JSON.stringify(prepared)).toString("base64url"),
  };
}

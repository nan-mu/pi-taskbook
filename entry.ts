import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { git, resolveBase, taskRepository, workspace, type Taskbook } from "./taskbook.ts";

export type PreparedEntry = { path: string; worktree: string; digest: string; base: string };
const preparedPrefix = "--prepared ";

export function readEntryArgument(argument: string): { path: string; prepared?: PreparedEntry } {
  if (!argument.startsWith(preparedPrefix)) return { path: argument };
  const input = JSON.parse(Buffer.from(argument.slice(preparedPrefix.length), "base64url").toString("utf8")) as Partial<PreparedEntry>;
  if (typeof input.path !== "string" || !isAbsolute(input.path) ||
      typeof input.worktree !== "string" || !isAbsolute(input.worktree) ||
      typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest) ||
      typeof input.base !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.base)) {
    throw new Error("新 worktree 的启动数据无效。");
  }
  return { path: input.path, prepared: { path: input.path, worktree: input.worktree, digest: input.digest, base: input.base } };
}

export function verifyPreparedEntry(cwd: string, task: Taskbook, prepared?: PreparedEntry) {
  if (!prepared) return workspace(cwd, task);
  if (prepared.digest !== task.digest) throw new Error("任务书或随附事实在创建 worktree 后发生变化。");
  if (task.baseCommit && prepared.base.toLowerCase() !== task.baseCommit.toLowerCase()) {
    throw new Error("启动数据的基线与任务书不同。");
  }
  const candidate = workspace(cwd, task, prepared.base);
  if (realpathSync(candidate.root) !== prepared.worktree) throw new Error("Pi 当前目录与启动数据的 worktree 不一致。");
  return candidate;
}

export function prepareTaskWorktree(cwd: string, task: Taskbook, location: string) {
  if (!isAbsolute(location)) throw new Error("PI_TASKBOOK_WORKTREE_ROOT 需要指向绝对路径。");
  const project = taskRepository(cwd, task);
  const base = resolveBase(project, task, true);
  const gitDir = realpathSync(git(project, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const worktreeRoot = realpathSync(location);
  for (const dir of [realpathSync(project), gitDir]) {
    const rel = relative(dir, worktreeRoot);
    if (!rel || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel))) {
      throw new Error("worktree 根目录应在项目 checkout 和 Git 元数据目录之外。");
    }
  }
  const path = join(worktreeRoot, task.id + "-" + task.digest.slice(0, 16));
  if (!existsSync(path)) {
    git(project, "worktree", "add", "-b", task.branch, path, base);
  }
  if (!lstatSync(path).isDirectory()) throw new Error("预期的 worktree 路径需要是实际目录。");
  if (realpathSync(git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")) !== gitDir) {
    throw new Error("目标 worktree 不属于当前项目的 Git 实例。");
  }
  const prepared = { path: task.sourcePath, digest: task.digest, base, worktree: path };
  verifyPreparedEntry(path, task, prepared);
  return {
    path,
    base,
    message: "/taskbook " + preparedPrefix + Buffer.from(JSON.stringify(prepared)).toString("base64url"),
  };
}

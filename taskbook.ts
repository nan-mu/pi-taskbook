import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const goalTypes = ["new-feature", "fix-feature", "new-experiment", "fix-experiment"] as const;
type GoalType = typeof goalTypes[number];

export type Taskbook = {
  id: string;
  repository: string;
  branch: string;
  baseBranch: string;
  baseCommit?: string;
  type: GoalType;
  markdown: string;
  facts?: string;
  digest: string;
  sourcePath: string;
};

function inside(path: string, directory: string) {
  const child = relative(directory, path);
  return child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}

function document(path: string) {
  if (!lstatSync(path).isFile()) throw new Error("不是普通文件：" + path);
  return readFileSync(path, "utf8");
}

export function readTaskbook(cwd: string, argument: string): Taskbook {
  const input = argument.trim();
  const path = realpathSync(resolve(cwd, input.startsWith('"') && input.endsWith('"') ? input.slice(1, -1) : input));
  const markdown = document(path);
  const goal = markdown.match(/^## Goal[ \t]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!goal || !/^## Delivery[ \t]*$/m.test(markdown.replace(/\r/g, ""))) {
    throw new Error("任务书需要 Goal 和 Delivery 标题。");
  }
  const header = markdown.slice(0, goal.index);
  function field(key: string, section = header, required = true) {
    const matches = [...section.matchAll(new RegExp("^" + key + ":[ \\t]*([^\\r\\n]+)$", "gm"))];
    if (matches.length > 1) throw new Error("任务书字段重复：" + key);
    const value = matches[0]?.[1].trim().replace(/^`([^`]+)`$/, "$1") ?? "";
    if (required && !value) throw new Error("任务书缺少字段：" + key);
    return value;
  }
  const id = field("Taskbook ID");
  const repository = field("Repository");
  const branch = field("Work branch");
  const baseBranch = field("Base branch");
  const baseCommit = field("Base commit", header, false) || undefined;
  const type = goalTypes.find(type => type === field("Type", goal[1]));
  if (!type || !/^[\w-][\w.-]{0,95}$/.test(id) || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("任务书标识、仓库或目标类型的格式不正确。");
  }
  if (baseCommit && !/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(baseCommit)) {
    throw new Error("Base commit 需要完整的 Git 提交 ID。");
  }
  const factsPath = field("Facts", header, false);
  let facts: string | undefined;
  if (factsPath) {
    const directory = dirname(path);
    const candidate = resolve(directory, factsPath);
    if (isAbsolute(factsPath) || !inside(candidate, directory)) throw new Error("Facts 必须指向任务书目录内的相对路径。");
    const factFile = realpathSync(candidate);
    if (!inside(factFile, directory)) throw new Error("Facts 文件指向了任务书目录之外。");
    facts = document(factFile);
  }
  const digest = createHash("sha256").update(JSON.stringify([markdown, facts])).digest("hex");
  return { id, repository, branch, baseBranch, baseCommit, type, markdown, facts, digest, sourcePath: path };
}

export function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function gitOk(cwd: string, ...args: string[]) {
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;
}

export function taskRepository(cwd: string, task: Taskbook) {
  const root = git(cwd, "rev-parse", "--show-toplevel");
  if (!gitOk(root, "check-ref-format", "refs/heads/" + task.branch) ||
      !gitOk(root, "check-ref-format", "refs/heads/" + task.baseBranch)) {
    throw new Error("任务书中的 Git 分支名无效。");
  }
  const origin = git(root, "remote", "get-url", "origin");
  const repo = origin.match(/^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+)$/i)?.[1]?.replace(/\.git$/i, "");
  if (repo?.toLowerCase() !== task.repository.toLowerCase()) throw new Error("origin 与任务书中的 GitHub 仓库不一致。");
  return root;
}

export function resolveBase(root: string, task: Taskbook, requireBranch: boolean) {
  const baseRef = ["refs/heads/", "refs/remotes/origin/"].map(prefix => prefix + task.baseBranch)
    .find(ref => gitOk(root, "show-ref", "--verify", "--quiet", ref));
  if (!baseRef && (requireBranch || !task.baseCommit)) throw new Error("本地找不到任务书的基线分支。");
  if (task.baseCommit && baseRef && !gitOk(root, "merge-base", "--is-ancestor", task.baseCommit, baseRef)) {
    throw new Error("Base commit 不在指定基线分支的本地历史中。");
  }
  return task.baseCommit ?? (requireBranch ? git(root, "rev-parse", baseRef!) : git(root, "merge-base", "HEAD", baseRef!));
}

export function workspace(cwd: string, task: Taskbook, pinnedBase?: string) {
  const root = taskRepository(cwd, task);
  const dir = git(root, "rev-parse", "--absolute-git-dir");
  const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (realpathSync(dir) === realpathSync(common)) throw new Error("当前是主 checkout，既有工作区入口要求 linked worktree。");
  const branch = git(root, "branch", "--show-current");
  if (branch !== task.branch) throw new Error("当前分支是 " + (branch || "detached HEAD") + "，任务书要求 " + task.branch + "。");
  const base = pinnedBase ?? resolveBase(root, task, false);
  if (!gitOk(root, "merge-base", "--is-ancestor", base, "HEAD")) throw new Error("当前 HEAD 未包含任务书的固定基线。");
  return { root, branch, base };
}

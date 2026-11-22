import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const goalTypes = ["new-feature", "fix-feature", "new-experiment", "fix-experiment"] as const;
type GoalType = typeof goalTypes[number];

export type Taskbook = {
  id: string;
  repository: string;
  branch?: string;
  baseBranch?: string;
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
  return { ...parseTaskbook(document(path), path), sourcePath: path };
}

export function parseTaskbook(markdown: string, sourcePath?: string): Omit<Taskbook, "sourcePath"> {
  const goal = markdown.match(/^## Goal[ \t]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!goal || !/^## Delivery[ \t]*$/m.test(markdown.replace(/\r/g, ""))) {
    throw new Error("任务书需要 Goal 和 Delivery 标题。");
  }
  const header = markdown.slice(0, goal.index);
  function field(key: string, section = header) {
    const prefix = `(?:${key}:[ \\t]*|\\*\\*${key}:?\\*\\*:?[ \\t]+)`;
    const matches = [...section.matchAll(new RegExp(`^${prefix}([^\\r\\n]+)$`, "gm"))];
    if (matches.length > 1) throw new Error("任务书字段重复：" + key);
    const value = matches[0]?.[1].trim().replace(/^`([^`]+)`$/, "$1") ?? "";
    return value;
  }
  const id = field("Taskbook ID");
  const repository = field("Repository");
  const branch = field("Work branch") || undefined;
  const baseBranch = field("Base branch") || undefined;
  const baseCommit = field("Base commit") || undefined;
  const labels = [field("Entry"), field("Type", goal[1])].filter(Boolean)
    .map(label => label.toLowerCase().replace(/[ \t]+/g, "-"));
  const type = goalTypes.find(type => labels.length > 0 && labels.every(label => label === type));
  if (!type) throw new Error("任务书需要有效且一致的 Entry 或 Goal 下的 Type。");
  if ((id && !/^[\w-][\w.-]{0,95}$/.test(id)) || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("任务书标识或仓库的格式不正确。");
  }
  if (!baseCommit && !baseBranch) throw new Error("任务书需要 Base commit 或 Base branch。");
  if (baseCommit && !/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(baseCommit)) {
    throw new Error("Base commit 需要完整的 Git 提交 ID。");
  }
  const factsPath = field("Facts");
  let facts: string | undefined;
  if (factsPath) {
    if (!sourcePath) throw new Error("粘贴的任务书请用 ## Facts 提供事实。引用附带文件时请提交任务书路径。");
    const directory = dirname(sourcePath);
    const candidate = resolve(directory, factsPath);
    if (isAbsolute(factsPath) || !inside(candidate, directory)) throw new Error("Facts 必须指向任务书目录内的相对路径。");
    const factFile = realpathSync(candidate);
    if (!inside(factFile, directory)) throw new Error("Facts 文件指向了任务书目录之外。");
    facts = document(factFile);
  }
  const digest = createHash("sha256").update(JSON.stringify([markdown, facts])).digest("hex");
  return { id: id || "task-" + digest.slice(0, 12), repository, branch, baseBranch, baseCommit, type, markdown, facts, digest };
}

export function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function gitExclusion(root: string, path: string) {
  const { status } = spawnSync("git", ["check-ignore", "-q", "--", path], {cwd: root, stdio: "ignore"});
  const outcome: "ready" | "missing" | "unconfirmed" = status === 0 ? "ready" : status === 1 ? "missing" : "unconfirmed";
  return { path, status: outcome };
}

export function gitOk(cwd: string, ...args: string[]) {
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;
}

export function repositoryIdentity(root: string) {
  try { return githubRepository(git(root, "remote", "get-url", "origin")); }
  catch { return; }
}

export function githubRepository(remote: string) {
  return remote.match(/^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+)$/i)?.[1]
    ?.replace(/\.git$/i, "").toLowerCase();
}

export function validTaskBranch(root: string, branch: string) {
  return gitOk(root, "check-ref-format", "refs/heads/" + branch) && gitOk(root, "check-ref-format", "--branch", branch);
}

export function taskRepository(cwd: string, task: Taskbook) {
  const root = git(cwd, "rev-parse", "--show-toplevel");
  if ([task.branch, task.baseBranch].some(branch => branch && !validTaskBranch(root, branch))) {
    throw new Error("任务书中的 Git 分支名无效。");
  }
  if (repositoryIdentity(root) !== task.repository.toLowerCase()) throw new Error("origin 与任务书中的 GitHub 仓库不一致。");
  return root;
}

export function resolveBase(root: string, task: Taskbook, requireBranch: boolean) {
  const baseRef = task.baseBranch && ["refs/heads/", "refs/remotes/origin/"].map(prefix => prefix + task.baseBranch)
    .find(ref => gitOk(root, "show-ref", "--verify", "--quiet", ref));
  if (!baseRef && (!task.baseCommit || (requireBranch && task.baseBranch))) throw new Error("本地找不到任务书的基线分支。");
  if (task.baseCommit && baseRef && !gitOk(root, "merge-base", "--is-ancestor", task.baseCommit, baseRef)) {
    throw new Error("Base commit 不在指定基线分支的本地历史中。");
  }
  return task.baseCommit ?? (requireBranch ? git(root, "rev-parse", baseRef!) : git(root, "merge-base", "HEAD", baseRef!));
}

export function workspace(cwd: string, task: Taskbook, pinnedBase?: string, pinnedBranch?: string) {
  const root = taskRepository(cwd, task);
  const dir = git(root, "rev-parse", "--absolute-git-dir");
  const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (realpathSync(dir) === realpathSync(common)) throw new Error("当前是主 checkout，既有工作区入口要求 linked worktree。");
  const branch = git(root, "branch", "--show-current");
  if (!branch) throw new Error("当前 worktree 是 detached HEAD，需要使用命名分支。");
  if ((task.branch && task.branch !== branch) || (pinnedBranch && pinnedBranch !== branch)) {
    throw new Error("当前工作分支与任务书或审计记录不一致。");
  }
  const base = pinnedBase ?? resolveBase(root, task, false);
  if (!gitOk(root, "merge-base", "--is-ancestor", base, "HEAD")) throw new Error("当前 HEAD 未包含任务书的固定基线。");
  return { root, branch, base };
}

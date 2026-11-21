import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { decodeTsv, encodeTsv } from "../facts/tsv.ts";
import { git, gitOk } from "../taskbook/document.ts";

export const modelSettingsPath = ".fact/taskbook.tsv";
export const projectModelsFile = ".fact/models.tsv";
export type ModelStorage = "personal" | "project-tracked" | "project-local";
export const personalModelsFile = "~/.agents/taskbook-models.tsv";
export type ModelPolicy = {path: string; gitTracking: boolean};
export const defaultModelPolicy: ModelPolicy = {path: projectModelsFile, gitTracking: false};

export function modelStorage(policy: ModelPolicy): ModelStorage {
  return policy.path === personalModelsFile ? "personal" : policy.gitTracking ? "project-tracked" : "project-local";
}

export function settingsFile(path: string) {
  const file = lstatSync(path, {throwIfNoEntry: false});
  if (!file) return;
  if (!file.isFile()) throw new Error("设置需要普通文件：" + path);
  return readFileSync(path, "utf8");
}

function factFile(root: string, path: string) {
  const dir = lstatSync(join(root, ".fact"), {throwIfNoEntry: false});
  if (dir && !dir.isDirectory()) throw new Error(".fact 需要真实目录。");
  return join(root, path);
}

function projectModelFile(root: string, relative: string) {
  let directory = root;
  for (const component of dirname(relative).split("/")) {
    directory = join(directory, component);
    const entry = lstatSync(directory, {throwIfNoEntry: false});
    if (!entry) break;
    if (!entry.isDirectory()) throw new Error("模型配置路径需要真实目录：" + relative);
  }
  return join(root, relative);
}

export function projectModelPolicy(root: string): ModelPolicy | undefined {
  const text = settingsFile(factFile(root, modelSettingsPath));
  if (text === undefined) return;
  const [header, ...rows] = decodeTsv(text);
  const invalid = () => new Error(modelSettingsPath + " 需要有效的 modelConfig 路径和 modelGitTracking 布尔值。");
  if (header?.length !== 2 || header[0] !== "key" || header[1] !== "value" || rows.some(row => row.length !== 2)) throw invalid();
  const fields = new Map(rows.map(([key, value]) => [key, value]));
  const path = fields.get("modelConfig");
  const tracking = fields.get("modelGitTracking");
  if (rows.length === 1 && path === "personal") return {path: personalModelsFile, gitTracking: false};
  if (rows.length === 1 && (path === "project-local" || path === "project-tracked")) {
    return {path: projectModelsFile, gitTracking: path === "project-tracked"};
  }
  if (fields.size !== 2 || rows.length !== 2 || !path || (tracking !== "true" && tracking !== "false")) throw invalid();
  if (path === personalModelsFile) {
    if (tracking === "true") throw invalid();
  } else if (!/^\.fact\/(?:[\w.-]+\/)*[\w.-]+\.tsv$/u.test(path) || posix.normalize(path) !== path ||
      path.split("/").slice(1).some(part => part.startsWith(".git")) ||
      [modelSettingsPath, ".fact/always.tsv", ".fact/facts.tsv", ".fact/terms.tsv", ".fact/label.tsv", ".fact/change.tsv"].includes(path)) {
    throw invalid();
  }
  return {path, gitTracking: tracking === "true"};
}

function primaryWorktree(root: string) {
  const first = git(root, "worktree", "list", "--porcelain", "-z").split("\0");
  if (!first[0].startsWith("worktree ") || first[1] === "bare") throw new Error("无法定位项目的主 checkout。");
  return first[0].slice("worktree ".length);
}

export function projectModelPath(root: string, policy: ModelPolicy) {
  return projectModelFile(policy.gitTracking ? root : primaryWorktree(root), policy.path);
}

export function legacyProjectModelPath(root: string, storage: ModelStorage = "project-tracked") {
  return factFile(storage === "project-local" ? primaryWorktree(root) : root, ".fact/models.md");
}

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), {recursive: true});
  const temp = join(dirname(path), ".taskbook-" + randomUUID());
  try {
    const mode = lstatSync(path, {throwIfNoEntry: false})?.mode ?? 0o600;
    writeFileSync(temp, content, {mode: mode & 0o777, flag: "wx"});
    renameSync(temp, path);
  } finally { rmSync(temp, {force: true}); }
}

export function modelWritePlan(root: string, policy: ModelPolicy, target: string) {
  const storage = modelStorage(policy);
  const modelFile = storage === "personal" ? undefined : policy.path;
  const manifest = factFile(root, modelSettingsPath);
  const primary = storage === "project-local" ? primaryWorktree(root) : root;
  const paths = modelFile ? [modelSettingsPath, modelFile] : [modelSettingsPath];
  const tracking = git(root, "ls-files", "--stage", "--", ...paths);
  if (modelFile && storage === "project-local" && realpathSync(root) !== realpathSync(primary) &&
      (git(primary, "ls-files", "--", modelFile) || git(root, "ls-files", "--", modelFile))) {
    throw new Error("将已跟踪的模型表改为本机保存时，请在主 checkout 中进行。");
  }
  const exclude = storage === "project-local"
    ? git(primary, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude") : undefined;
  const files = [target, manifest, ...(exclude ? [exclude] : [])].map(path => ({path, content: settingsFile(path)}));
  if (git(root, "ls-files", "--unmerged", "--", ...paths)) {
    throw new Error("请先解决设置文件的 Git 合并冲突。");
  }
  return {root, primary, storage, policy, modelFile, paths, target, manifest, exclude, files, tracking};
}

export function writeModelSettings(plan: ReturnType<typeof modelWritePlan>, config: string) {
  const {root, primary, storage, policy, modelFile, paths, target, manifest, exclude, files, tracking} = plan;
  const written: typeof files = [];
  const set = (path: string, content: string) => {
    const before = files.find(file => file.path === path);
    if (!before || before.content === content) return;
    if (settingsFile(path) !== before.content) throw new Error("设置文件在保存前已变化：" + path);
    writeFile(path, content);
    written.push(before);
  };
  const runGit = (args: string[], input: string) => execFileSync("git", args,
    {cwd: root, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]}).trim();
  const stage = (path: string, text: string) => `100644 ${runGit(["hash-object", "-w", "--path", path, "--stdin"], text)}\t${path}\n`;
  const untrack = storage === "project-local" && modelFile && Boolean(git(root, "ls-files", "--", modelFile));
  try {
    if (exclude && modelFile && !gitOk(primary, "check-ignore", "--no-index", "-q", "--", modelFile)) {
      const before = files.find(file => file.path === exclude)?.content ?? "";
      const rule = "/" + modelFile;
      if (!before.split(/\r?\n/).includes(rule)) set(exclude, before + (before && !before.endsWith("\n") ? "\n" : "") + rule + "\n");
      if (!gitOk(primary, "check-ignore", "--no-index", "-q", "--", modelFile)) {
        throw new Error("项目的 Git 规则覆盖了本机排除，无法私下保存 " + modelFile + "。");
      }
    }
    const settings = encodeTsv([["key", "value"], ["modelConfig", policy.path], ["modelGitTracking", String(policy.gitTracking)]]);
    set(target, config);
    set(manifest, settings);
    const previous = git(root, "ls-files", "--stage", "--", ...paths);
    if (previous !== tracking) throw new Error("Git 暂存区已变化，请重新运行 setup。");
    let updates = stage(modelSettingsPath, settings);
    if (modelFile && storage === "project-tracked") updates += stage(modelFile, config);
    if (untrack) {
      if (!gitOk(root, "diff", "--cached", "--quiet", "--", modelFile)) {
        throw new Error(modelFile + " 已有暂存改动。先处理该文件的暂存改动，再切换到本机保存。");
      }
      const zero = "0".repeat(git(root, "rev-parse", "--show-object-format") === "sha256" ? 64 : 40);
      updates += `0 ${zero}\t${modelFile}\n`;
    }
    runGit(["update-index", "--index-info"], updates);
  } catch (error) {
    for (const file of written.reverse()) {
      if (file.content === undefined) rmSync(file.path);
      else writeFile(file.path, file.content);
    }
    throw error;
  }
  return {storage, policy, target, settings: modelSettingsPath,
    staged: storage === "project-tracked" || untrack ? paths : [modelSettingsPath],
    ...(untrack ? {stagedRemoval: modelFile} : {}),
    ...(exclude ? {localGitExclude: exclude} : {})};
}

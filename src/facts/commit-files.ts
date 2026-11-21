import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { git } from "../taskbook/document.ts";
import { lockProjectMemory } from "./project-memory.ts";

export function readFactFile(root: string, path: string): string | undefined {
  if (!path.startsWith(".fact/") || posix.normalize(path) !== path) throw new Error("项目事实路径无效。");
  let absolute = root;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    absolute = join(absolute, part);
    const entry = lstatSync(absolute, {throwIfNoEntry: false});
    if (!entry) return;
    if (index === parts.length - 1 && entry.isFile()) return readFileSync(absolute, "utf8");
    if (!entry.isDirectory() || index === parts.length - 1) throw new Error("项目事实路径不是普通文件：" + path);
  }
}

function writeFactFile(path: string, body: string | undefined) {
  if (body === undefined) return rmSync(path, {force: true});
  const temporary = path + "." + randomUUID();
  mkdirSync(dirname(path), {recursive: true});
  try {
    writeFileSync(temporary, body, {flag: "wx"});
    renameSync(temporary, path);
  } finally { rmSync(temporary, {force: true}); }
}

export function commitFactFiles(root: string, changes: Map<string, string | undefined>, message: string, validate?: () => void) {
  const unlock = lockProjectMemory(root);
  try {
    validate?.();
    const previous = new Map([...changes.keys()].map(path => [path, readFactFile(root, path)]));
    const paths = [...changes.keys()].filter(path => previous.get(path) !== changes.get(path));
    const head = git(root, "rev-parse", "HEAD");
    if (!paths.length) return head;
    for (const path of paths) {
      if (git(root, "status", "--porcelain", "--untracked-files=all", "--ignored", "--", path)) {
        throw new Error("请先处理已修改或被排除的事实文件：" + path);
      }
    }
    const added = paths.filter(path => previous.get(path) === undefined);
    const written: string[] = [];
    try {
      for (const path of paths) {
        writeFactFile(join(root, path), changes.get(path));
        written.push(path);
      }
      if (added.length) git(root, "add", "-N", "--", ...added);
      git(root, "-c", "user.name=Pi Taskbook", "-c", "user.email=pi-taskbook@localhost", "-c", "commit.gpgsign=false",
        "commit", "--only", "--no-status", "-m", message, "--", ...paths);
    } catch (error) {
      if (git(root, "rev-parse", "HEAD") === head) {
        if (added.length) git(root, "reset", "-q", "--", ...added);
        for (const path of written) {
          if (readFactFile(root, path) === changes.get(path)) writeFactFile(join(root, path), previous.get(path));
        }
      }
      throw error;
    }
    return git(root, "rev-parse", "HEAD");
  } finally { unlock(); }
}

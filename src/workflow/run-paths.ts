import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { git } from "../taskbook/document.ts";

export function runDirectory(root: string) {
  return join(git(root, "rev-parse", "--absolute-git-dir"), "pi-taskbook", "runs");
}

export function privateDirectory(parent: string, ...components: string[]) {
  for (const component of components) {
    parent = join(parent, component);
    try { mkdirSync(parent, {mode: 0o700}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(parent).isDirectory()) throw new Error("Taskbook 状态目录须为真实目录。");
  }
  return parent;
}

export function ensureRunDirectory(root: string, key: string) {
  return privateDirectory(git(root, "rev-parse", "--absolute-git-dir"), "pi-taskbook", "runs", key);
}

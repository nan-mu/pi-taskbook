import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function privateDirectory(parent: string, ...components: string[]) {
  for (const component of components) {
    parent = join(parent, component);
    try { mkdirSync(parent, {mode: 0o700}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(parent).isDirectory()) throw new Error("Taskbook 状态目录须为真实目录。");
  }
  return parent;
}

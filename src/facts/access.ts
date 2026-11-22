import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const factSearchOnly = "请用 taskbook_query_facts 查询项目事实。";

export function isFactPath(path: string) {
  return path.replaceAll("\\", "/").split("/").some(part => part.toLowerCase() === ".fact");
}

export function factAccessRestriction(tool: string, input: unknown, cwd: string, root = cwd) {
  if (!input || typeof input !== "object") return;
  if (tool === "bash" || tool === "powershell") {
    if ("command" in input && typeof input.command === "string" && /(?:^|[^\w.-])\.fact(?=$|[^\w.-])/iu.test(input.command)) {
      return factSearchOnly;
    }
    return;
  }
  if (!["read", "edit", "write", "grep"].includes(tool)) return;
  const path = "path" in input && typeof input.path === "string" ? input.path : ".";
  const absolute = resolve(cwd, path);
  let real = absolute;
  try { real = realpathSync(absolute); } catch {}
  if (isFactPath(path) || isFactPath(absolute) || isFactPath(real)) return factSearchOnly;
  if (tool === "grep") {
    const fromSearchRoot = relative(real, resolve(root, ".fact"));
    if (fromSearchRoot !== ".." && !fromSearchRoot.startsWith(".." + sep) && !isAbsolute(fromSearchRoot)) {
      return "请为 grep 指定具体源码目录或文件。项目事实使用 taskbook_query_facts。";
    }
  }
}

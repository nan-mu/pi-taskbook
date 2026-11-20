import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelConfigPath, modelRoutes, resolveModel, reviewerModel } from "./design-worker.ts";
import { readProjectMemory, projectMemoryRef } from "./project-memory.ts";
import { probeSubagents } from "./subagent-probe.ts";
import { git } from "./taskbook.ts";

function inspect<T>(read: () => T) {
  try {
    return { result: read() };
  } catch (error) {
    return { error: String(error) };
  }
}

function pathStatus(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return { path, kind: !stat ? "missing" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other" };
}

export async function collectSetup(pi: ExtensionAPI, ctx: ExtensionContext) {
  const path = modelConfigPath();
  const models = {
    path,
    file: inspect(() => pathStatus(path)),
    example: fileURLToPath(new URL("./pi-taskbook.example.json", import.meta.url)),
    effective: inspect(() => {
      const routes = modelRoutes(ctx, path);
      const effective = {
        ...routes,
        consult: routes.consult ?? routes.design,
        factCheck: routes.factCheck ?? routes.initial,
        performance: routes.performance ?? routes.initial,
        factReview: reviewerModel(routes, "fact-review"),
        correctness: reviewerModel(routes, "correctness"),
        quality: reviewerModel(routes, "quality"),
      };
      const registered = new Map([...new Set(Object.values(effective))].map(key =>
        [key, inspect(() => resolveModel(ctx, key)).result !== undefined]));
      return {
        routes: Object.fromEntries(Object.entries(effective).map(([role, key]) =>
          [role, registered.get(key) ? key : null])),
        invalidRoles: Object.entries(effective).filter(([, key]) => !registered.get(key)).map(([role]) => role),
      };
    }),
  };

  const manifest = join(getAgentDir(), "npm/node_modules/@tintinweb/pi-subagents/package.json");
  const installed = inspect(() => {
    if (pathStatus(manifest).kind === "missing") return { manifest, version: null };
    const data: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof data !== "object" || data === null || !("version" in data) || typeof data.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(data.version)) {
      throw new Error("子代理包缺少版本字段：" + manifest);
    }
    return { manifest, version: data.version };
  });
  const runtime = await probeSubagents(pi);
  const repository = inspect(() => {
    const root = git(ctx.cwd, "rev-parse", "--show-toplevel");
    return {
      root,
      ledger: inspect(() => {
        const { head, records } = readProjectMemory(root);
        return { ref: projectMemoryRef, head, records: Object.keys(records).length };
      }),
      conventionalPaths: [".audit", ".audit/pi-taskbook", "GLOSSARY.md"]
        .map(name => inspect(() => pathStatus(join(root, name)))),
    };
  });
  return { models, subagents: { installed, runtime, testedPackageVersions: ["0.26.0", "0.26.1"] }, repository };
}

import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { lstatSync, readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const planParameter = Type.Object({
  steps: Type.Array(Type.Object({
    id: Type.String({minLength: 1}), action: Type.String({minLength: 1}),
    checks: Type.String({minLength: 1}),
    targets: Type.Array(Type.String({minLength: 1}), {minItems: 1}),
  }, {additionalProperties: false}), {minItems: 1}),
}, {additionalProperties: false});

export type PlanStep = { id: string; action: string; checks: string; targets: string[] };
export type ExecutionPlan = { version: number; steps: PlanStep[] };
export type PlanGap = { stepId: string; observation: string; question: string };
const modelRoles = ["design", "implement", "consult", "factCheck", "performance", "review", "factReview", "correctness", "quality"] as const;
type ModelRole = typeof modelRoles[number];
type ModelConfig = Partial<Record<ModelRole, string>>;
export type ModelRoutes = ModelConfig & { initial: string; design: string; implement: string; review: string };
type ModelConfigSource =
  | { kind: "markdown" | "legacy"; path: string; roles: ModelConfig }
  | { kind: "fallback" };

export function modelKey(model: NonNullable<ExtensionContext["model"]>) {
  return model.provider + "/" + model.id;
}

function isModelRole(value: string): value is ModelRole {
  return modelRoles.some(role => role === value);
}

function setModelRoute(roles: ModelConfig, role: string, value: unknown) {
  if (!isModelRole(role)) throw new Error("角色配置包含未知字段。");
  if (Object.hasOwn(roles, role)) throw new Error("角色配置包含重复字段 " + role + "。");
  if (typeof value !== "string" || !/^[^/\s]+\/\S+$/u.test(value)) {
    throw new Error("角色 " + role + " 需要 provider/model-id。");
  }
  roles[role] = value;
}

export function parseModelConfig(text: string) {
  const roles: ModelConfig = {};
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error("角色配置第 " + (index + 1) + " 行需要使用 role: provider/model-id。");
    setModelRoute(roles, line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return roles;
}

export function formatModelConfig(roles: ModelConfig) {
  return "# Taskbook model configuration. One line per role.\n" +
    modelRoles.flatMap(role => roles[role] ? [role + ": " + roles[role] + "\n"] : []).join("");
}

export function modelConfigPaths() {
  const override = process.env.PI_TASKBOOK_CONFIG;
  if (override && /\.json$/i.test(override)) {
    return { path: join(dirname(override), "taskbook-models.md"), legacyPath: override, required: true };
  }
  return { path: override || join(homedir(), ".agents", "taskbook-models.md"),
    legacyPath: override ? undefined : join(getAgentDir(), "pi-taskbook.json"), required: Boolean(override) };
}

function readModelFile(path: string) {
  const stat = lstatSync(path, {throwIfNoEntry: false});
  if (!stat) return;
  if (!stat.isFile()) throw new Error("角色配置需要普通文件：" + path);
  return readFileSync(path, "utf8");
}

function legacyModelConfig(path: string, text: string): ModelConfigSource {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    const roles: ModelConfig = {};
    for (const [role, model] of Object.entries(value)) setModelRoute(roles, role, model);
    return { kind: "legacy", path, roles };
  } catch {
    throw new Error("旧 JSON 角色配置无效：" + path);
  }
}

export function readModelConfig(paths = modelConfigPaths()): ModelConfigSource {
  const markdown = readModelFile(paths.path);
  if (markdown !== undefined) {
    if (paths.required && !paths.legacyPath && markdown.trimStart().startsWith("{")) {
      return legacyModelConfig(paths.path, markdown);
    }
    let roles: ModelConfig;
    try { roles = parseModelConfig(markdown); }
    catch (error) { throw new Error("角色配置无效 " + paths.path + "。 " + (error instanceof Error ? error.message : "")); }
    return { kind: "markdown", path: paths.path, roles };
  }
  const legacy = paths.legacyPath && readModelFile(paths.legacyPath);
  if (paths.legacyPath && legacy !== undefined) return legacyModelConfig(paths.legacyPath, legacy);
  if (paths.required) throw new Error("找不到角色配置文件 " + paths.path);
  return { kind: "fallback" };
}

export function modelRoutes(ctx: ExtensionContext, config = readModelConfig()): ModelRoutes {
  if (!ctx.model) throw new Error("任务需要已选定的 Pi 模型。");
  const initial = modelKey(ctx.model);
  const routes: ModelRoutes = {
    initial, design: process.env.PI_TASKBOOK_DESIGN_MODEL || initial,
    implement: process.env.PI_TASKBOOK_IMPLEMENT_MODEL || initial,
    review: process.env.PI_TASKBOOK_REVIEW_MODEL || initial,
    factReview: process.env.PI_TASKBOOK_FACT_REVIEW_MODEL || undefined,
    correctness: process.env.PI_TASKBOOK_CORRECTNESS_MODEL || undefined,
    quality: process.env.PI_TASKBOOK_QUALITY_MODEL || undefined,
  };
  if (config.kind === "fallback") return routes;
  for (const role of modelRoles) {
    const value = config.roles[role];
    if (!value) continue;
    try { resolveModel(ctx, value); }
    catch { throw new Error(`角色配置 ${config.path} 的 ${role} 未匹配已注册的 Pi 模型。`); }
    routes[role] = value;
  }
  if (config.roles.review) {
    for (const role of ["factReview", "correctness", "quality"] as const) {
      if (!config.roles[role]) routes[role] = routes.review;
    }
  }
  return routes;
}

export function resolveModel(ctx: ExtensionContext, key: string) {
  if (ctx.model && modelKey(ctx.model) === key) return ctx.model;
  const separator = key.indexOf("/");
  const model = separator > 0 ? ctx.modelRegistry.find(key.slice(0, separator), key.slice(separator + 1)) : undefined;
  if (!model) throw new Error("找不到配置的 Pi 角色模型 " + key + "。请核对 provider/model-id。");
  return model;
}

export function reviewerModel(routes: ModelRoutes, phase: "fact-review" | "correctness" | "quality") {
  return routes[phase === "fact-review" ? "factReview" : phase] ?? routes.review;
}

export function acceptPlan(steps: PlanStep[], targets: string[], previousVersion = 0): ExecutionPlan {
  const ids = new Set<string>();
  const covered = new Set<string>();
  for (const step of steps) {
    if (!step.id.trim() || step.id.trim() !== step.id || ids.has(step.id) || !step.action.trim() || !step.checks.trim()) {
      throw new Error("计划步骤需要唯一 ID、实施范围和可观察验收。");
    }
    if (!step.targets.length) throw new Error("每个步骤至少需要一个目标或交付项。");
    ids.add(step.id);
    for (const target of step.targets) {
      if (!targets.includes(target)) throw new Error("未知计划目标 " + target);
      covered.add(target);
    }
  }
  const missing = targets.filter(target => !covered.has(target));
  if (missing.length) throw new Error("计划未覆盖目标或交付项 " + missing.join(", "));
  return { version: previousVersion + 1, steps };
}

/** The experiment owns a disposable checkout. This is workspace isolation,
 * not a host security boundary. The command retains the caller's OS rights. */
export async function runProbe(root: string, revision: string, argv: string[], signal?: AbortSignal) {
  if (!argv.length || !argv[0].trim()) throw new Error("实验需要可执行命令。");
  const temporary = await mkdtemp(join(tmpdir(), "pi-taskbook-probe-"));
  const work = join(temporary, "work");
  try {
    signal?.throwIfAborted();
    execFileSync("git", ["clone", "--quiet", "--local", "--no-hardlinks", "--no-checkout", "--", root, work], {stdio: "pipe"});
    execFileSync("git", ["-C", work, "checkout", "--quiet", "--detach", revision], {stdio: "pipe"});
    execFileSync("git", ["-C", work, "remote", "remove", "origin"], {stdio: "pipe"});
    const observed = await new Promise<{exitCode: number; stdout: string; stderr: string}>((resolve, reject) => {
      execFile(argv[0], argv.slice(1), {cwd: work, encoding: "utf8", timeout: 60000, maxBuffer: 512 * 1024,
        killSignal: "SIGKILL", signal}, (error, stdout, stderr) => {
          if (error && (typeof error.code !== "number" || error.killed || error.signal)) return reject(error);
          resolve({exitCode: typeof error?.code === "number" ? error.code : 0, stdout: stdout.slice(-12000), stderr: stderr.slice(-12000)});
        });
    });
    return {revision, argv, ...observed};
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

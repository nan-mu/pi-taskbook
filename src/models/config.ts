import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { decodeTsv, encodeTsv } from "../facts/tsv.ts";
import { defaultModelPolicy, legacyProjectModelPath, modelStorage, projectModelPath, projectModelPolicy, projectModelsFile, settingsFile, type ModelStorage } from "./storage.ts";

export const modelRoles = ["design", "designMemberA", "designMemberB", "implement", "consult", "factCheck", "performance", "review", "factReview", "correctness", "quality"] as const;
export type ModelRole = typeof modelRoles[number];
export type ModelConfig = Partial<Record<ModelRole, string>>;
type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;
type Model = NonNullable<ExtensionContext["model"]>;
export type ModelRoutes = ModelConfig & { initial: string; design: string; implement: string; review: string;
  initialThinking?: ThinkingLevel; levels?: Partial<Record<ModelRole, ThinkingLevel>> };
export type RoleSelection = { model: Model; thinkingLevel: ThinkingLevel };
type ModelConfigSource =
  | { kind: "tsv" | "markdown" | "legacy"; path: string; roles: ModelConfig }
  | { kind: "fallback" };

export function modelKey(model: NonNullable<ExtensionContext["model"]>) {
  return model.provider + "/" + model.id;
}

function isModelRole(value: string): value is ModelRole {
  return modelRoles.some(role => role === value);
}

const thinkingLevels: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function splitRoute(value: string) {
  const route = /^(\S+)(?:\s+@\s+(\S+))?$/u.exec(value);
  if (!route) throw new Error("使用 provider/model-id，可加 @ thinking-level。");
  const [, model, requested] = route;
  const thinking = thinkingLevels.find(level => level === requested);
  if (!/^[^/\s]+\/\S+$/u.test(model) || (requested && !thinking)) {
    throw new Error("使用 provider/model-id，可加 @ thinking-level。");
  }
  return {model, thinking};
}

function setModelRoute(roles: ModelConfig, role: string, value: unknown) {
  if (!isModelRole(role)) throw new Error("角色配置包含未知字段。");
  if (Object.hasOwn(roles, role)) throw new Error("角色配置包含重复字段 " + role + "。");
  if (typeof value !== "string") throw new Error("角色 " + role + " 需要 provider/model-id。");
  try {
    const {model, thinking} = splitRoute(value);
    roles[role] = thinking ? `${model} @ ${thinking}` : model;
  } catch { throw new Error("角色 " + role + " 需要 provider/model-id，可加 @ thinking-level。"); }
}

function parseMarkdownModelConfig(text: string) {
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

const modelColumns = ["role", "model", "thinking"];

export function parseModelConfig(text: string) {
  const [header, ...rows] = decodeTsv(text);
  if (header?.length !== modelColumns.length || modelColumns.some((column, index) => column !== header[index])) {
    throw new Error("角色配置需要 TSV 表头 role、model、thinking。");
  }
  const roles: ModelConfig = {};
  for (const row of rows) {
    const [role, model, thinking] = row;
    if (row.length !== modelColumns.length || !model || /\s/u.test(model) || (thinking && !thinkingLevels.some(level => level === thinking))) {
      throw new Error("角色模型每行需要三个 TSV 字段。");
    }
    setModelRoute(roles, role, thinking ? model + " @ " + thinking : model);
  }
  return roles;
}

export function formatModelConfig(roles: ModelConfig) {
  const rows = [modelColumns];
  for (const role of modelRoles) {
    const value = roles[role];
    if (value) {
      const {model, thinking} = splitRoute(value);
      rows.push([role, model, thinking ?? ""]);
    }
  }
  return encodeTsv(rows);
}

export function personalModelPath() {
  return join(homedir(), ".agents", "taskbook-models.tsv");
}

export function legacyPersonalModelPath() {
  return join(homedir(), ".agents", "taskbook-models.md");
}

type ModelPaths = {path: string; markdownPath?: string; legacyPath?: string; required: boolean; storage?: ModelStorage};
export function modelConfigPaths(root?: string): ModelPaths {
  const policy = root ? projectModelPolicy(root) : undefined;
  const storage = policy && modelStorage(policy);
  if (root && policy && (storage === "project-local" || storage === "project-tracked")) {
    return {path: projectModelPath(root, policy), markdownPath: policy.path === projectModelsFile ? legacyProjectModelPath(root, storage) : undefined,
      required: true, storage};
  }
  if (storage === "personal") return {path: personalModelPath(), markdownPath: legacyPersonalModelPath(), required: true, storage};
  const override = process.env.PI_TASKBOOK_CONFIG;
  if (root && !override) {
    const path = projectModelPath(root, defaultModelPolicy);
    if (settingsFile(path) !== undefined) return {path, required: true, storage: "project-local"};
  }
  if (override && /\.json$/i.test(override)) {
    return { path: join(dirname(override), "taskbook-models.tsv"), markdownPath: join(dirname(override), "taskbook-models.md"),
      legacyPath: override, required: true };
  }
  return { path: override || personalModelPath(),
    markdownPath: override ? undefined : legacyPersonalModelPath(),
    legacyPath: override ? undefined : join(getAgentDir(), "pi-taskbook.json"), required: Boolean(override) };
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
  for (const path of [paths.path, paths.markdownPath]) {
    if (!path) continue;
    const text = settingsFile(path);
    if (text === undefined) continue;
    const kind = /\.tsv$/iu.test(path) ? "tsv" : "markdown";
    if (kind === "markdown" && paths.required && !paths.legacyPath && path === paths.path && text.trimStart().startsWith("{")) {
      return legacyModelConfig(path, text);
    }
    try { return {kind, path, roles: kind === "tsv" ? parseModelConfig(text) : parseMarkdownModelConfig(text)}; }
    catch (error) { throw new Error("角色配置无效 " + path + "。 " + (error instanceof Error ? error.message : "")); }
  }
  const legacy = paths.legacyPath && settingsFile(paths.legacyPath);
  if (paths.legacyPath && legacy !== undefined) return legacyModelConfig(paths.legacyPath, legacy);
  if (paths.required) throw new Error("找不到角色配置文件 " + paths.path);
  return { kind: "fallback" };
}

export function modelRoutes(ctx: ExtensionContext, config = readModelConfig(),
  entry = ctx.model && modelKey(ctx.model), initialThinking = ctx.thinkingLevel): ModelRoutes {
  if (!entry) throw new Error("任务需要已选定的 Pi 模型。");
  const initial = entry;
  const levels: NonNullable<ModelRoutes["levels"]> = {};
  const routes: ModelRoutes = {
    initial, initialThinking, design: process.env.PI_TASKBOOK_DESIGN_MODEL || initial,
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
    const {model: key, thinking} = splitRoute(value);
    let model;
    try { model = resolveModel(ctx, key); }
    catch { throw new Error(`角色配置 ${config.path} 的 ${role} 未匹配已注册的 Pi 模型。`); }
    if (thinking && !getSupportedThinkingLevels(model).includes(thinking)) {
      throw new Error(`角色配置 ${config.path} 的 ${role} 不支持 ${thinking} 推理档位。`);
    }
    routes[role] = key;
    if (thinking) levels[role] = thinking;
  }
  if (config.roles.review) {
    for (const role of ["factReview", "correctness", "quality"] as const) {
      if (!config.roles[role]) {
        routes[role] = routes.review;
        if (levels.review) levels[role] = levels.review;
      }
    }
  }
  return {...routes, levels};
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

export function roleSelection(ctx: ExtensionContext, root: string, pinned: ModelRoutes, role: ModelRole): RoleSelection {
  const paths = modelConfigPaths(root);
  const routes = paths.storage ? modelRoutes(ctx, readModelConfig(paths), pinned.initial, pinned.initialThinking) : pinned;
  const fallback = role === "consult" ? "design" : role === "factReview" || role === "correctness" || role === "quality" ||
    role === "designMemberA" || role === "designMemberB" ? "review" : undefined;
  const model = resolveModel(ctx, routes[role] ?? (fallback ? routes[fallback] : undefined) ?? routes.initial);
  const thinking = routes.levels?.[role] ?? (fallback && !routes[role] ? routes.levels?.[fallback] : undefined);
  // The Pi SDK defaults to medium when the session provides no entry level.
  const requested = thinking ?? routes.initialThinking ?? ctx.thinkingLevel ?? "medium";
  return {model, thinkingLevel: clampThinkingLevel(model, requested)};
}

export { getSupportedThinkingLevels };

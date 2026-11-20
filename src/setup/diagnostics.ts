import { inspectT3 } from "../integrations/t3.ts";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatModelConfig, modelConfigPaths, modelKey, modelRoutes, parseModelConfig, readModelConfig,
  resolveModel, reviewerModel, type ModelRoutes } from "../workflow/design-worker.ts";
import { formatProjectTsv, legacyProjectFactsPath, readLegacyProjectJson, readProjectMemory, projectFactsPath, projectGlossaryPath } from "../facts/project-memory.ts";
import { probeSubagents } from "../review/subagent-probe.ts";
import { inspectMcpCapabilities } from "../integrations/mcp-catalog.ts";
import { git, gitExclusion } from "../taskbook/document.ts";

type Status = "ready" | "missing" | "invalid" | "unconfirmed";
type PathCheck = { path: string; status: Status };
const subagentPackage = "@tintinweb/pi-subagents";
const testedPackageVersions = ["0.26.0", "0.26.1"];
const checkpointDirectory = ".audit/pi-taskbook";

function fileStatus(path: string, kind: "file" | "directory"): PathCheck {
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    return { path, status: !stat ? "missing" :
      (kind === "file" ? stat.isFile() : stat.isDirectory()) ? "ready" : "invalid" };
  } catch {
    return { path, status: "unconfirmed" };
  }
}

function repoPath(root: string, path: string, kind: "file" | "directory"): PathCheck {
  const parts = path.split("/");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const result = fileStatus(current, index === parts.length - 1 ? kind : "directory");
    if (result.status !== "ready") return { path, status: result.status };
  }
  return { path, status: "ready" };
}

function effectiveRoutes(routes: ModelRoutes) {
  return {
    initial: routes.initial,
    ...configuredRoles(routes),
  };
}

function configuredRoles(routes: ModelRoutes) {
  return {
    design: routes.design,
    implement: routes.implement,
    consult: routes.consult ?? routes.design,
    factCheck: routes.factCheck ?? routes.initial,
    performance: routes.performance ?? routes.initial,
    review: routes.review,
    factReview: reviewerModel(routes, "fact-review"),
    correctness: reviewerModel(routes, "correctness"),
    quality: reviewerModel(routes, "quality"),
  };
}

function pstackSetup() {
  const path = join(homedir(), ".agents", "pstack-models.md");
  const check = fileStatus(path, "file");
  if (check.status !== "ready") return check;
  try {
    const stat = lstatSync(path);
    if (stat.size > 16 * 1024) return { path, status: "unconfirmed", reason: "参考配置超过 16 KiB。" };
    const content = new TextDecoder("utf-8", {fatal: true}).decode(readFileSync(path));
    if (content.includes("\0")) return { path, status: "invalid" };
    return { ...check, content };
  } catch {
    return { path, status: "unconfirmed", reason: "无法读取 PStack 模型配置。" };
  }
}

function modelSetup(ctx: ExtensionContext) {
  const paths = modelConfigPaths();
  const file = fileStatus(paths.path, "file");
  const example = fileURLToPath(new URL("../../taskbook-models.example.md", import.meta.url));
  const legacy = paths.legacyPath ? fileStatus(paths.legacyPath, "file") : undefined;
  const selected = ctx.model && ctx.modelRegistry.find(ctx.model.provider, ctx.model.id);
  const available = ctx.modelRegistry.getAvailable();
  const suggestion = selected ?? available[0] ?? ctx.modelRegistry.getAll()[0];
  const fallbackModel = suggestion && modelKey(suggestion);
  let recommended: ReturnType<typeof parseModelConfig> = {};
  if (file.status === "missing") {
    try { recommended = parseModelConfig(readFileSync(example, "utf8")); }
    catch { /* Checked-in recommendations can be omitted. */ }
  }
  const initial = fallbackModel && configuredRoles({
    initial: fallbackModel, design: fallbackModel, implement: fallbackModel, review: fallbackModel,
  });
  const proposed = initial && Object.fromEntries(Object.entries(initial).map(([role, fallback]) => {
    const preference = Object.getOwnPropertyDescriptor(recommended, role)?.value;
    try { return [role, typeof preference === "string" ? modelKey(resolveModel(ctx, preference)) : fallback]; }
    catch { return [role, fallback]; }
  }));
  const details = {
    file, example, legacy,
    pstack: pstackSetup(),
    availableModels: available.slice(0, 64).map(modelKey),
  };
  function initialization(source?: ReturnType<typeof readModelConfig>) {
    if (file.status !== "missing") return null;
    const prior = source?.kind === "legacy" ? source : undefined;
    return { operation: "initialize", path: paths.path,
      content: prior ? formatModelConfig(prior.roles) : proposed ? formatModelConfig(proposed) : null,
      ...(prior ? {source: prior.path} : {}),
      purpose: prior ? "将旧 JSON 中的角色设置生成 Markdown。" : proposed ?
        "使用 Pi 已注册模型创建各角色的显式路由。" : "先在 Pi 注册模型，再填写各角色。" };
  }
  try {
    const config = readModelConfig(paths);
    if (!selected && !suggestion) {
      return { ...details, initialization: initialization(), effective: { status: "unconfirmed", reason: "Pi 未注册可核对的角色模型。" } };
    }
    const routes = effectiveRoutes(modelRoutes({ ...ctx, model: selected ?? suggestion }, config));
    const registered = new Map([...new Set(Object.values(routes))].map(key => {
      try { return [key, modelKey(resolveModel({ ...ctx, model: selected }, key))]; }
      catch { return [key, null]; }
    }));
    const safeRoutes = Object.fromEntries(Object.entries(routes).map(([role, key]) => [role, registered.get(key) ?? null]));
    const invalidRoles = Object.entries(safeRoutes).filter(([, key]) => !key).map(([role]) => role);
    const status = invalidRoles.length ? "invalid" : !selected ? "unconfirmed" :
      file.status === "missing" ? "fallback" : "ready";
    return { ...details, initialization: initialization(config), effective: { status,
      source: config.kind, routes: safeRoutes, invalidRoles,
      reason: !selected ? "正式任务需要选定模型。" : undefined } };
  } catch {
    const missingOverride = file.status === "missing" && paths.required && (!legacy || legacy.status === "missing");
    const status = missingOverride ? "missing" : file.status === "unconfirmed" ? "unconfirmed" : "invalid";
    return { ...details, file: file.status === "ready" ? { ...file, status } : file,
      legacy: file.status === "missing" && legacy?.status === "ready" ? { ...legacy, status } : legacy,
      initialization: initialization(), effective: { status, reason: missingOverride ?
        "显式指定的角色配置文件缺失，正式任务需先补齐。" : "无法读取角色配置，或其 Markdown、旧 JSON、角色模型无效。" } };
  }
}

function packageVersion(manifest: string) {
  const check = fileStatus(manifest, "file");
  if (check.status !== "ready") return { ...check, version: null };
  try {
    const data: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof data === "object" && data !== null && "name" in data && data.name === subagentPackage &&
        "version" in data && typeof data.version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(data.version)) {
      return { ...check, version: data.version, tested: testedPackageVersions.includes(data.version) };
    }
  } catch {
    // The report summarizes malformed manifests without quoting their contents.
  }
  return { ...check, status: "invalid", version: null };
}

function subagentManifests(pi: ExtensionAPI, ctx: ExtensionContext) {
  const paths = new Set([join(getAgentDir(), "npm/node_modules", subagentPackage, "package.json"),
    join(ctx.cwd, ".pi/npm/node_modules", subagentPackage, "package.json")]);
  const source = pi.getCommands().find(command => command.name === "agents" && command.source === "extension")?.sourceInfo.path;
  if (source && isAbsolute(source)) {
    let folder = dirname(source);
    for (let depth = 0; depth < 4 && folder !== dirname(folder); depth++, folder = dirname(folder)) {
      const manifest = join(folder, "package.json");
      if (packageVersion(manifest).version) {
        paths.add(manifest);
        break;
      }
    }
  }
  return [...paths].map(packageVersion);
}

function glossarySetup(root: string) {
  try {
    const path = projectGlossaryPath(root);
    const check = repoPath(root, path, "file");
    if (check.status === "missing") return { ...check, initialization: {
      operation: "initialize", path, content: "# Glossary\n", purpose: "建立项目术语清单，Pi 将维护获审的术语区。",
    } };
    if (check.status !== "ready") return check;
    try {
      const body = new TextDecoder("utf-8", {fatal: true}).decode(readFileSync(join(root, path)));
      const starts = body.split("<!-- pi-taskbook:terms -->").length - 1;
      const ends = body.split("<!-- /pi-taskbook:terms -->").length - 1;
      const valid = !body.includes("\0") && starts === ends && starts < 2 &&
        (!starts || body.indexOf("<!-- pi-taskbook:terms -->") < body.indexOf("<!-- /pi-taskbook:terms -->"));
      return { ...check, status: valid ? "ready" : "invalid" };
    } catch {
      return { ...check, status: "invalid" };
    }
  } catch {
    return { path: null, status: "invalid", reason: "无法从项目约定解析安全的术语清单路径。" };
  }
}

function factsSetup(root: string) {
  const check = repoPath(root, projectFactsPath, "file");
  if (check.status !== "ready" && check.status !== "missing") return check;
  try {
    const legacy = readLegacyProjectJson(root);
    if (check.status === "missing" && !legacy) {
      return { ...check, initialization: { operation: "initialize", path: projectFactsPath,
        content: formatProjectTsv({ schema: 1, records: {}, applied: {} }), purpose: "建立空的项目事实文件。先盘点旧资料并确认迁移范围。" } };
    }
    const { head, records, applied } = readProjectMemory(root, {allowUnmigratedLegacy: true});
    if (legacy && !applied[legacy.receipt]) {
      return { ...check, status: "migration-required", source: legacyProjectFactsPath, reason: "正式任务需要先批准迁移旧项目事实。" };
    }
    return { ...check, version: head, records: Object.keys(records).length };
  } catch {
    return { ...check, status: "invalid", reason: "项目事实格式、版本或术语区对应关系无效，需核对文件。" };
  }
}

function auditSetup(root: string, glossaryPath: string | null) {
  const audit = repoPath(root, ".audit", "directory");
  const checkpoints = repoPath(root, checkpointDirectory, "directory");
  if (audit.status !== "ready") return { ...audit, checkpoints };
  const known = new Set(["pi-taskbook"]);
  if (glossaryPath?.startsWith(".audit/")) known.add(glossaryPath.split("/")[1]);
  try {
    const unresolved = readdirSync(join(root, ".audit")).filter(name => !known.has(name)).sort()
      .map(name => ({ path: ".audit/" + name, status: "unconfirmed",
        reason: "待核实材料。运行迁移预览确认来源、条目和目标。" }));
    const runCheckpoints = checkpoints.status === "ready" ?
      readdirSync(join(root, checkpointDirectory)).sort().map(name => {
        const directory = checkpointDirectory + "/" + name;
        const path = directory + "/state.json";
        if (!/^[-\w.]+-[a-f0-9]{16}$/u.test(name) || repoPath(root, path, "file").status !== "ready") {
          return { path: directory, status: "unconfirmed", reason: "待核实的检查点目录或旧资料。" };
        }
        return { path, status: "discovered", reason: "符合运行检查点路径约定。旧数据格式由迁移预览核对。" };
      }) : [];
    return { ...audit, checkpoints, knownFacts: projectFactsPath, knownGlossary: glossaryPath, runCheckpoints, unresolved };
  } catch {
    return { ...audit, status: "unconfirmed", checkpoints, reason: "无法完整核对 .audit 目录。" };
  }
}

function workflowDeclaration(root: string) {
  const path = "docs/agents/issue-tracker.md";
  try {
    return repoPath(root, path, "file").status === "ready" ? readFileSync(join(root, path), "utf8") : undefined;
  } catch {
    return undefined;
  }
}

export async function collectSetup(pi: ExtensionAPI, ctx: ExtensionContext) {
  const models = modelSetup(ctx);
  const installed = subagentManifests(pi, ctx);
  const [probe, t3] = await Promise.all([probeSubagents(pi).catch(() => null), inspectT3()]);
  const runtime = { status: probe?.responding ? "ready" : probe ? "fallback" : "unconfirmed",
    responding: probe?.responding ?? false, protocol: probe?.protocol ?? null,
    mode: probe?.responding ? "pi-subagents RPC" : "独立 Pi SDK 会话" };
  const subagents = { installed, runtime, testedPackageVersions };
  let root: string;
  try { root = git(ctx.cwd, "rev-parse", "--show-toplevel"); }
  catch {
    return { models, subagents, t3, repository: { status: "unconfirmed", reason: "当前目录没有可核对的 Git 工作区。" },
      mcp: inspectMcpCapabilities(pi), readiness: { runnable: false, taskbookNew: false, initialized: false, blockers: ["repository"] } };
  }
  const facts = factsSetup(root);
  const glossary = glossarySetup(root);
  const audit = auditSetup(root, glossary.path);
  const factsExcluded = gitExclusion(root, projectFactsPath);
  const exclusions = {
    projectFacts: { ...factsExcluded, status: factsExcluded.status === "ready" ? "invalid" :
      factsExcluded.status === "missing" ? "ready" : "unconfirmed",
      impact: "获准纳入普通项目历史的事实文件必须允许 Git 跟踪。" },
  };
  const blockers = [
    !["ready", "fallback"].includes(models.effective.status) && "modelRoutes",
    facts.status === "migration-required" ? "projectFactsMigration" :
      !["missing", "ready"].includes(facts.status) && "projectFactsFormat",
    !["missing", "ready"].includes(glossary.status) && "glossaryFormat",
    exclusions.projectFacts.status !== "ready" && "projectFactsTracking",
  ].filter(Boolean);
  return {
    models, subagents, t3,
    repository: { status: "ready", root, facts, glossary, audit, exclusions },
    mcp: inspectMcpCapabilities(pi, workflowDeclaration(root)),
    readiness: {
      runnable: !blockers.length,
      taskbookNew: !blockers.length && t3.worktree,
      initialized: !blockers.length && models.file.status === "ready" && facts.status === "ready" && glossary.status === "ready",
      blockers,
    },
  };
}

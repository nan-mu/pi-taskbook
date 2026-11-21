import { boundT3Worktree, inspectT3, t3ForgeSessionTools, t3SessionTools } from "../integrations/t3.ts";
import { githubHandoffTools } from "../integrations/github-handoff.ts";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatModelConfig, getSupportedThinkingLevels, legacyPersonalModelPath, modelConfigPaths, modelKey, modelRoutes, parseModelConfig, personalModelPath,
  readModelConfig, resolveModel, reviewerModel, type ModelRoutes } from "../models/config.ts";
import { defaultModelPolicy, legacyProjectModelPath, modelSettingsPath, projectModelPath, projectModelPolicy, projectModelsFile } from "../models/storage.ts";
import { probeSubagents } from "../review/subagent-probe.ts";
import { inspectMcpCapabilities, waitForMagpieCatalogue } from "../integrations/mcp-catalog.ts";
import { git } from "../taskbook/document.ts";

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
    designMemberA: routes.designMemberA ?? routes.review,
    designMemberB: routes.designMemberB ?? routes.review,
    implement: routes.implement,
    consult: routes.consult ?? routes.design,
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

function modelSetup(ctx: ExtensionContext, root?: string) {
  const available = ctx.modelRegistry.getAvailable();
  const selectedKey = ctx.model && modelKey(ctx.model);
  const selected = available.find(model => modelKey(model) === selectedKey);
  const catalog = (selected ? [selected, ...available.filter(model => model !== selected)] : available).slice(0, 64)
    .map(model => ({id: modelKey(model), name: model.name,
    thinkingLevels: getSupportedThinkingLevels(model)}));
  const inspect = (path: string, markdownPath?: string) => {
    const preferred = fileStatus(path, "file");
    const file = preferred.status === "missing" && markdownPath ? fileStatus(markdownPath, "file") : preferred;
    if (file.status !== "ready") return preferred.status === "missing" && file.status === "missing" ? preferred : file;
    try {
      const config = readModelConfig({path, markdownPath, required: true});
      return config.kind === "fallback" ? {...file, status: "invalid"} : {...file, roles: config.roles};
    } catch { return {...file, status: "invalid"}; }
  };
  const detailsForSelection = {catalog, selectedAvailable: Boolean(selected), entryThinking: ctx.thinkingLevel, pstack: pstackSetup()};
  let paths;
  let savedPolicy;
  try {
    savedPolicy = root && projectModelPolicy(root);
    paths = modelConfigPaths(root);
  } catch {
    return {...detailsForSelection, file: {path: modelSettingsPath, status: "invalid"},
      effective: {status: "invalid", reason: "项目的模型路径或 Git 跟踪设置无效。"}};
  }
  const policy = root ? savedPolicy || defaultModelPolicy : undefined;
  const sources = {
    personal: inspect(personalModelPath(), legacyPersonalModelPath()),
    project: root && (() => {
      const projectPolicy = policy?.path.startsWith(".fact/") ? policy : defaultModelPolicy;
      const path = projectModelPath(root, projectPolicy);
      return inspect(path, projectPolicy.path === projectModelsFile ?
        legacyProjectModelPath(root, projectPolicy.gitTracking ? "project-tracked" : "project-local") : undefined);
    })(),
    settings: root && repoPath(root, modelSettingsPath, "file"),
  };
  const file = fileStatus(paths.path, "file");
  const example = fileURLToPath(new URL("../../taskbook-models.example.tsv", import.meta.url));
  const markdown = paths.markdownPath ? fileStatus(paths.markdownPath, "file") : undefined;
  const legacy = markdown && markdown.status !== "missing" ? markdown :
    paths.legacyPath ? fileStatus(paths.legacyPath, "file") : undefined;
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
  const proposed = initial && Object.fromEntries(Object.entries(initial)
    .filter(([role]) => ["design", "designMemberA", "designMemberB", "implement"].includes(role)).map(([role, fallback]) => {
    const preference = Object.getOwnPropertyDescriptor(recommended, role)?.value;
    try { return [role, typeof preference === "string" ? modelKey(resolveModel(ctx, preference)) : fallback]; }
    catch { return [role, fallback]; }
  }));
  const details = {
    ...detailsForSelection, file, example, legacy, sources, storage: paths.storage,
    savePolicy: policy && {...policy, source: savedPolicy ? modelSettingsPath : "default"},
    scenario: !catalog.length ? "no-models" : paths.storage || file.status !== "missing" || sources.personal.status === "ready" ||
      sources.project?.status === "ready" ? "existing" :
      legacy?.status === "ready" || detailsForSelection.pstack.status === "ready" ? "reference" : "new",
  };
  function initialization(source?: ReturnType<typeof readModelConfig>) {
    if (file.status !== "missing") return null;
    const prior = source?.kind === "legacy" || source?.kind === "markdown" ? source : undefined;
    const path = root && policy?.path.startsWith(".fact/") ? projectModelPath(root, policy) : personalModelPath();
    return { operation: "initialize", path,
      content: prior ? formatModelConfig(prior.roles) : proposed ? formatModelConfig(proposed) : null,
      ...(prior ? {source: prior.path} : {}),
      purpose: prior ? "将旧配置中的角色设置转换为 TSV。" : proposed ?
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
      config.kind === "fallback" ? "fallback" : "ready";
    return { ...details, initialization: initialization(config), effective: { status,
      source: config.kind, path: config.kind === "fallback" ? undefined : config.path, routes: safeRoutes, thinkingLevels: routes.levels, invalidRoles,
      reason: !selected ? "正式任务需要选定模型。" : undefined } };
  } catch {
    const missingOverride = file.status === "missing" && paths.required && (!legacy || legacy.status === "missing");
    const status = missingOverride ? "missing" : file.status === "unconfirmed" ? "unconfirmed" : "invalid";
    return { ...details, file: file.status === "ready" ? { ...file, status } : file,
      legacy: file.status === "missing" && legacy?.status === "ready" ? { ...legacy, status } : legacy,
      initialization: initialization(), effective: { status, reason: missingOverride ?
        "显式指定的角色配置文件缺失，正式任务需先补齐。" : "无法读取角色配置，或其格式、角色模型无效。" } };
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

function auditSetup(root: string) {
  const audit = repoPath(root, ".audit", "directory");
  const checkpoints = repoPath(root, checkpointDirectory, "directory");
  if (audit.status !== "ready") return { ...audit, checkpoints };
  const known = new Set(["pi-taskbook"]);
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
    return { ...audit, checkpoints, runCheckpoints, unresolved };
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
  let root: string | undefined;
  try { root = git(ctx.cwd, "rev-parse", "--show-toplevel"); } catch { }
  const installed = subagentManifests(pi, ctx);
  const [probe, t3, magpieCatalogue] = await Promise.all([
    probeSubagents(pi).catch(() => null), inspectT3(), waitForMagpieCatalogue(pi, ctx, root),
  ]);
  let mismatch = false;
  if (t3.binding?.attached) {
    try { root = boundT3Worktree(ctx.cwd, t3.binding)?.root; }
    catch { mismatch = true; root = undefined; }
  }
  const models = modelSetup(ctx, root);
  const runtime = {status: "loaded", mode: "独立 Pi SDK 会话", externalRpcResponded: probe?.responding === true,
    legacyReviewTransport: probe?.protocol ?? null};
  const subagents = { installed, runtime, testedPackageVersions };
  const github = githubHandoffTools(pi);
  const pullRequestDelivery = {transport: "Magpie GitHub MCP", tools: [...github.keys()],
    scope: "Session tool discovery. Handoff verifies repository access when it previews publication."};
  const mcp = inspectMcpCapabilities(pi, root && workflowDeclaration(root));
  const availability = {
    subagents: {builtinSdk: runtime.status, installedVersions: [...new Set(installed.flatMap(item => item.version ? [item.version] : []))],
      externalRpcResponded: runtime.externalRpcResponded, rpcVersion: runtime.legacyReviewTransport},
    t3: {sessionTools: t3SessionTools(pi), directTransport: t3.transport, reason: t3.reason,
      taskbookNew: t3.worktree && Boolean(root), taskbookHandoff: t3.handoff && Boolean(root) && t3.binding !== undefined},
    github: {read: Object.entries(mcp.github.read).filter(([, value]) => value.status === "discovered").map(([name]) => name),
      t3Tools: t3ForgeSessionTools(pi), pullRequestDeliveryTools: pullRequestDelivery.tools, repositoryAccess: "not-tested"},
    magpieCatalogue: Object.hasOwn(mcp.magpie.byService, "magpie") ? "registered" : magpieCatalogue,
    magpieMemory: {tools: Object.entries(mcp.magpie.capabilities).filter(([, value]) => value.status === "discovered").map(([name]) => name),
      access: "not-tested"},
  };
  if (!root) {
    return { models, subagents, t3, pullRequestDelivery, repository: { status: "unconfirmed", reason: mismatch ?
      "T3 工作区绑定与本地仓库不一致。" : "当前目录没有可核对的 Git 工作区。" },
      mcp, availability, readiness: { runnable: false, taskbookNew: false, initialized: false, blockers: [mismatch ? "worktreeBinding" : "repository"] } };
  }
  const audit = auditSetup(root);
  const blockers = ["ready", "fallback"].includes(models.effective.status) ? [] : ["modelRoutes"];
  return {
    models, subagents, t3, pullRequestDelivery,
    repository: { status: "ready", root, audit },
    mcp, availability,
    readiness: {
      runnable: !blockers.length,
      taskbookNew: !blockers.length && t3.worktree,
      initialized: !blockers.length && models.effective.status === "ready",
      blockers,
    },
  };
}

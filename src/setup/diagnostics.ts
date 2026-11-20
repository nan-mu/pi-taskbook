import { inspectT3 } from "../integrations/t3.ts";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelConfigPath, modelKey, modelRoutes, resolveModel, reviewerModel, type ModelRoutes } from "../workflow/design-worker.ts";
import { readProjectMemory, projectFactsPath, projectGlossaryPath } from "../facts/project-memory.ts";
import { probeSubagents } from "../review/subagent-probe.ts";
import { inspectMcpCapabilities } from "../integrations/mcp-catalog.ts";
import { git, gitExclusion } from "../taskbook/document.ts";

type Status = "ready" | "missing" | "invalid" | "unconfirmed";
type PathCheck = { path: string; status: Status };
const subagentPackage = "@tintinweb/pi-subagents";
const testedPackageVersions = ["0.26.0", "0.26.1"];
const checkpointDirectory = ".audit/pi-taskbook";
const foreignMirrorPath = ".fact/foreign.json";
const foreignMirrorLock = ".fact/foreign.lock/";

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

function modelSetup(ctx: ExtensionContext) {
  const path = modelConfigPath();
  const file = fileStatus(path, "file");
  const example = fileURLToPath(new URL("../../pi-taskbook.example.json", import.meta.url));
  const selected = ctx.model && ctx.modelRegistry.find(ctx.model.provider, ctx.model.id);
  const suggestion = selected ?? ctx.modelRegistry.getAvailable()[0] ?? ctx.modelRegistry.getAll()[0];
  let suggestedRoles: unknown;
  if (file.status === "missing") {
    try { suggestedRoles = JSON.parse(readFileSync(example, "utf8")); }
    catch { suggestedRoles = null; }
  }
  const proposedContents = suggestion && file.status === "missing" ? Object.fromEntries(
    Object.keys(configuredRoles({
      initial: modelKey(suggestion), design: modelKey(suggestion), implement: modelKey(suggestion), review: modelKey(suggestion),
    })).map(role => {
      const recommendation = typeof suggestedRoles === "object" && suggestedRoles ?
        Object.getOwnPropertyDescriptor(suggestedRoles, role)?.value : undefined;
      try {
        return [role, typeof recommendation === "string" ? modelKey(resolveModel(ctx, recommendation)) : modelKey(suggestion)];
      } catch {
        return [role, modelKey(suggestion)];
      }
    }),
  ) : null;
  const initialization = file.status === "missing" ? {
    operation: "initialize",
    path,
    content: proposedContents,
    purpose: proposedContents ? "使用 Pi 已注册模型创建各角色的显式路由。" : "先在 Pi 注册模型，再填写各角色。",
  } : null;
  if (file.status === "invalid" || file.status === "unconfirmed") {
    return { file, example, initialization, effective: { status: file.status, reason: "角色配置路径须为可读取的普通文件。" } };
  }
  try {
    if (!selected && !suggestion) {
      return { file, example, initialization, effective: { status: "unconfirmed", reason: "Pi 未注册可核对的角色模型。" } };
    }
    const routes = effectiveRoutes(modelRoutes({ ...ctx, model: selected ?? suggestion }, path));
    const registered = new Map([...new Set(Object.values(routes))].map(key => {
      try { return [key, modelKey(resolveModel({ ...ctx, model: selected }, key))]; }
      catch { return [key, null]; }
    }));
    const safeRoutes = Object.fromEntries(Object.entries(routes).map(([role, key]) => [role, registered.get(key) ?? null]));
    const invalidRoles = Object.entries(safeRoutes).filter(([, key]) => !key).map(([role]) => role);
    const status = invalidRoles.length ? "invalid" : !selected ? "unconfirmed" :
      file.status === "missing" ? "fallback" : "ready";
    return { file, example, initialization, effective: { status, routes: safeRoutes, invalidRoles,
      reason: !selected ? "正式任务需要选定模型。" : undefined } };
  } catch {
    const reason = file.status === "missing" ? "显式指定的角色配置文件缺失，正式任务需先补齐。" :
      "无法读取角色配置，或其 JSON、字段、角色模型无效。";
    const status = file.status === "missing" ? "missing" : "invalid";
    return { file: { ...file, status }, example, initialization, effective: { status, reason } };
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
  if (check.status === "missing") {
    return { ...check, initialization: { operation: "initialize", path: projectFactsPath,
      content: { schema: 1, records: {}, applied: {} }, purpose: "建立空的项目事实文件。旧资料应另行盘点和批准迁移。" } };
  }
  if (check.status !== "ready") return check;
  try {
    const { head, records } = readProjectMemory(root);
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
  const checkpointsExcluded = gitExclusion(root, checkpointDirectory + "/setup-probe-0000000000000000/state.json");
  const trackedCheckpoints = git(root, "ls-files", "--", checkpointDirectory) !== "";
  const factsExcluded = gitExclusion(root, projectFactsPath);
  const exclusions = {
    checkpoints: { ...checkpointsExcluded,
      status: trackedCheckpoints ? "invalid" : checkpointsExcluded.status,
      rule: "/.audit/pi-taskbook/",
      impact: "正式任务需要将运行检查点排除在 Git 之外。使用 .gitignore 或当前仓库的本地排除文件。",
    },
    foreignMirror: { ...gitExclusion(root, foreignMirrorPath), rule: "/" + foreignMirrorPath,
      impact: "默认仅在 Git 排除路径保存来自其他项目的镜像。" },
    foreignMirrorLock: { ...gitExclusion(root, foreignMirrorLock), rule: "/" + foreignMirrorLock,
      impact: "外来镜像并发写入使用独立的 Git 排除目录。" },
    projectFacts: { ...factsExcluded, status: factsExcluded.status === "ready" ? "invalid" :
      factsExcluded.status === "missing" ? "ready" : "unconfirmed",
      impact: "获准纳入普通项目历史的事实文件必须允许 Git 跟踪。" },
  };
  const blockers = [
    !["ready", "fallback"].includes(models.effective.status) && "modelRoutes",
    exclusions.checkpoints.status !== "ready" && "checkpointExclusion",
    !["missing", "ready"].includes(audit.checkpoints.status) && "checkpointDirectory",
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

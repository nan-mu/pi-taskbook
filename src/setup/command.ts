import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { inspectAuditFacts, prepareAuditFactInput } from "./audit-facts.ts";
import { git, repositoryIdentity } from "../taskbook/document.ts";
import { deleteMigratedAudit, inspectAuditMigration, migrateAudit } from "./audit-migration.ts";
import { collectSetup } from "./diagnostics.ts";
import { formatModelConfig, getSupportedThinkingLevels, modelKey, modelRoles, modelRoutes, parseModelConfig, personalModelPath } from "../models/config.ts";
import { defaultModelPolicy, modelSettingsPath, modelStorage, modelWritePlan, personalModelsFile, projectModelPath, projectModelPolicy, validateModelPolicy, writeModelSettings } from "../models/storage.ts";

const setupType = "pi-taskbook-setup";
const stateType = "pi-taskbook-setup-state";
const migrationTool = "taskbook_migrate";
const modelSetupTool = "taskbook_model_setup";
const modelCatalogTool = "taskbook_model_catalog";
const setupTools = [modelCatalogTool, modelSetupTool, migrationTool];
const instructions = readFileSync(new URL("../../prompts/setup.md", import.meta.url), "utf8").trim();
const approvedBy = Type.Optional(Type.Array(Type.String({minLength: 1}), {minItems: 1, maxItems: 12, uniqueItems: true}));
type MigrationOperation = "migrate" | "prepare-facts" | "delete-audit";
type MigrationInput = {branch?: string; selections?: {id: string; path: string}[]};
type SetupOperation = {kind: "models"; storage: ReturnType<typeof modelStorage>; changeTracking: boolean; newPath?: string} |
  {kind: MigrationOperation};
const auditName = /\.audit|审计资料|\baudit\b/iu;

type SetupInventory = ReturnType<typeof inspectAuditMigration>;
type MigrationSession = {root: string; repository: string; inventory: SetupInventory};
const setupState = Type.Object({
  root: Type.String(), session: Type.String(), models: Type.Boolean(), inputs: Type.Array(Type.String()),
  migration: Type.Optional(Type.Object({repository: Type.String(), digest: Type.String(),
    archivedAfterInput: Type.Optional(Type.Integer({minimum: 0}))})),
});
type SetupState = Static<typeof setupState>;

function inventoryDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function migrationPlan(run: MigrationSession, operation: MigrationOperation, input: MigrationInput) {
  const {root, repository, inventory: audit} = run;
  if (audit.status !== "ready" && audit.status !== "archived") throw new Error("没有可归档的 .audit。");
  if (operation === "prepare-facts") {
    const {branch, selections} = input;
    if (!branch || !selections?.length) throw new Error("请给出选定的事实、目标主题表和工作分支。");
    const known = inspectAuditFacts(root, repository, audit.snapshot.digest);
    return {title: "准备旧事实迁移", description: JSON.stringify({branch, selections}), apply() {
      if (inventoryDigest(inspectAuditMigration(root)) !== inventoryDigest(audit) ||
          inventoryDigest(inspectAuditFacts(root, repository, audit.snapshot.digest)) !== inventoryDigest(known)) {
        throw new Error("迁移候选已变化，需重新盘点并批准。");
      }
      return prepareAuditFactInput(root, repository, audit.snapshot.digest, branch, selections, known);
    }};
  }
  function checkCleanup() {
    if (audit.status !== "archived") throw new Error("请先归档并核对 .audit。");
    if (audit.activeGlossary) throw new Error(`当前术语清单 ${audit.activeGlossary} 位于 .audit 中。`);
    const facts = inspectAuditFacts(root, repository, audit.snapshot.digest);
    if ([...facts.entries, ...facts.archives].some(entry => entry.status !== "already-imported") ||
        facts.unresolved.some(entry => !entry.reason.startsWith("未识别的审计资料格式"))) {
      throw new Error(".audit 仍包含旧格式事实。请保留归档和原件，并单独核对这些记录。");
    }
  }
  if (operation === "delete-audit") checkCleanup();
  const title = operation === "migrate" ? "归档 .audit" : "清理已归档的 .audit";
  const description = operation === "migrate" ? `归档到 ${audit.archive}，复制可恢复的检查点并保留原件。` :
    `删除 ${root}/.audit。核对过的归档保存在 ${audit.archive}。`;
  return {title, description, apply() {
    if (inventoryDigest(inspectAuditMigration(root)) !== inventoryDigest(audit)) throw new Error("旧资料已变化，需重新盘点并批准。");
    if (operation === "migrate") return {audit: migrateAudit(root, repository, audit.snapshot.digest)};
    checkCleanup();
    deleteMigratedAudit(root, audit.snapshot.digest);
    return {deleted: ".audit", archive: audit.archive};
  }};
}

export function registerSetupCommand(pi: ExtensionAPI, workflowIsBusy: () => boolean) {
  let checking = false;

  function currentSetup(ctx: ExtensionContext): SetupState | undefined {
    const entry = ctx.sessionManager.getBranch().findLast(item => item.type === "custom" && item.customType === stateType);
    if (entry?.type === "custom" && Value.Check(setupState, entry.data) &&
        entry.data.session === ctx.sessionManager.getSessionId()) return entry.data;
  }

  function requireSetup(ctx: ExtensionContext) {
    const setup = currentSetup(ctx);
    if (!setup || checking || workflowIsBusy() || git(ctx.cwd, "rev-parse", "--show-toplevel") !== setup.root) {
      throw new Error("请在空闲的当前项目会话先运行 /taskbook-setup。");
    }
    return setup;
  }

  function exposeSetupTools() {
    const active = pi.getActiveTools();
    const missing = setupTools.filter(name => !active.includes(name));
    if (missing.length) pi.setActiveTools([...active, ...missing]);
  }

  async function authorize(ctx: ExtensionContext, userInputs: string[], quotes: string[] | undefined,
      operation: SetupOperation, title: string, description: string) {
    if (!userInputs.length) throw new Error("当前只执行 Setup 状态检查。");
    if (quotes?.length) {
      if (!quotes.every(quote => userInputs.includes(quote.trim())) ||
          !quotes.some(quote => quote.trim() === userInputs.at(-1))) {
        throw new Error("请引用本次 setup 的完整用户原话，并核对最新决定。");
      }
      const ordered = userInputs.filter(input => quotes.some(quote => input === quote.trim()));
      if (ordered.every(input => /^(?:(?:批准|同意|确认|授权|approve(?:d)?|yes|ok)\s*)?[\p{P}\s]*$/iu.test(input))) {
        throw new Error("批准内容为空。请明确批准哪些操作。");
      }
      const latest = ordered.at(-1)!;
      if (operation.kind === "prepare-facts") {
        const positive = /(?:迁移|整理|导入|准备|migrat\w*|import|prepare)/iu;
        const negative = /(?:不要|无需|暂不|先不|别|do not|don['’]t)\s*(?:迁移|导入|准备|migrat\w*|import|prepare)/iu;
        if (negative.test(latest) || !ordered.some(input => positive.test(input) && !negative.test(input) && /事实|facts?/iu.test(input))) {
          throw new Error("请明确批准为选定的旧事实准备迁移。");
        }
      }
      if (operation.kind === "migrate") {
        const migrate = /迁移|归档|导入|转换|\b(?:migrate|archive|import|convert)\b/iu;
        const decline = /(?:不要|无需|暂不|先不|别|do not|don['’]t)\s*(?:迁移|归档|导入|migrate|archive|import)/iu;
        if (decline.test(latest) || !ordered.some(input => migrate.test(input) && !decline.test(input) && auditName.test(input))) {
          throw new Error("请明确批准归档 .audit。");
        }
      }
      if (operation.kind === "delete-audit") {
        const remove = (input: string) => /删除|清理|移除|\b(?:delete|remove|clean up)\b/iu.test(input);
        const decline = /(?:不要|无需|暂不|先不|别|do not|don['’]t)\s*(?:删除|清理|移除|delete|remove|clean up)|(?:保留|keep|retain)\s*(?:原来的?|原有的?)?\s*(?:\.audit|原件|审计资料|旧\s*(?:Git\s*)?引用|legacy (?:Git )?ref)/iu;
        if (decline.test(latest) || !ordered.some(input => auditName.test(input) && remove(input) && !decline.test(input))) {
          throw new Error("清理需要明确批准删除相应原件。请核对用户选择。");
        }
      }
      if (/^(?:取消|算了|先别做|不要了?|停止|不用了?|cancel|stop|no)[。.!！\s]*$/iu.test(latest)) {
        throw new Error("用户已取消本次变更。");
      }
      if (operation.kind === "models") {
        const readOnly = /(?:只读|只(?:看|查|检查)|仅(?:查看|检查)|不要(?:保存|写入|修改)|read[- ]only|do not (?:save|write|change))/iu;
        const write = /保存|写入|采用|切换|启用|配置为|改为|(?:使用|用).{0,20}方案|\b(?:save|write|apply|select|set|switch|use)\b/iu;
        const selection = ordered.findLast(input => readOnly.test(input) || write.test(input));
        if (selection && readOnly.test(selection)) throw new Error("用户只要求核对模型，配置保留。");
        if (!selection || !ordered.some(input => /模型|角色|路由|方案|model|role|route|\.tsv/iu.test(input))) {
          if (ctx.hasUI) return ctx.ui.confirm(title, description);
          throw new Error("请明确批准要保存的模型设置。");
        }
      }
      if (operation.kind === "models" && operation.newPath && !ordered.some(input => input.includes(operation.newPath!))) {
        throw new Error("请核对用户选定的新模型表路径。");
      }
      if (operation.kind === "models" && operation.changeTracking) {
        const local = /(?:不|无需|不用)(?:由\s*Git\s*)?(?:追踪|跟踪|纳入\s*Git|提交)|本机保存|保存到本机|本地保存|不进\s*Git|\b(?:untracked|local[- ]only|do not track|don't track)\b/iu;
        const tracked = /(?:追踪|跟踪|纳入\s*Git|提交到\s*Git)|\b(?:track|tracked)\b/iu;
        const selection = ordered.findLast(input => local.test(input) || tracked.test(input));
        if (!selection || local.test(selection) !== (operation.storage === "project-local")) {
          throw new Error("请引用用户明确选择项目模型表由 Git 跟踪或本机保存的原话。");
        }
      }
      return true;
    }
    if (!ctx.hasUI) throw new Error("本次 Pi 会话无法取得用户确认。");
    return ctx.ui.confirm(title, description);
  }

  pi.registerCommand("taskbook-setup", {
    description: "将 Pi 和项目诊断附到普通会话，协助初始化或迁移",
    async handler(args, ctx) {
      if (!ctx.isIdle() || checking || workflowIsBusy()) {
        return ctx.ui.notify("请在任务书会话空闲且没有待裁决事项时运行 /taskbook-setup。", "warning");
      }
      checking = true;
      try {
        if (currentSetup(ctx)) pi.appendEntry(stateType, null);
        const checks = await collectSetup(pi, ctx);
        let legacy: (SetupInventory & {facts?: {available: number; pending: number}}) | undefined;
        let setup: SetupState | undefined;
        if (typeof checks.repository.root === "string" &&
            checks.repository.root === git(ctx.cwd, "rev-parse", "--show-toplevel")) {
          const root = checks.repository.root;
          setup = {root, session: ctx.sessionManager.getSessionId(), models: true, inputs: args.trim() ? [args.trim()] : []};
          const repository = repositoryIdentity(root);
          if (repository) {
            try {
              const audit = inspectAuditMigration(root);
              if (audit.status !== "absent") {
                legacy = audit;
                setup.migration = {repository, digest: inventoryDigest(audit)};
                if (audit.status === "ready" || audit.status === "archived") {
                  const {entries} = inspectAuditFacts(root, repository, audit.snapshot.digest);
                  legacy = {...audit, facts: {available: entries.filter(row => row.status === "ready" && !row.retired).length,
                    pending: entries.filter(row => row.status !== "already-imported").length}};
                }
              }
            } catch {
              legacy = {status: "unconfirmed", reason: "无法核对旧事实或 .audit 的迁移来源。"};
            }
          }
        }
        const report = JSON.stringify({...checks, legacy}, null, 2);
        if (!checks.models.selectedAvailable) {
          return ctx.ui.notify((checks.models.catalog.length ? "请先在 Pi 选择一个可用模型。" :
            "当前没有可用的 Pi 模型。请先注册或认证模型，再运行 /taskbook-setup。") + "\n\n" + report, "info");
        }
        if (setup) pi.appendEntry(stateType, setup);
        exposeSetupTools();
        pi.sendMessage({customType: setupType, content: ["这是 /taskbook-setup 的普通对话。", "## Runtime diagnostics\n" + report,
          ...(args.trim() ? ["## User command argument\n" + args.trim()] : [])].join("\n\n"),
          display: false}, {triggerTurn: true});
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      } finally { checking = false; }
    },
  });

  pi.registerTool({
    name: modelCatalogTool, label: "刷新 Taskbook 模型目录",
    description: "从当前 Pi 会话刷新可用模型及其推理档位。用于 Setup 中核对新增模型或重查档位。",
    parameters: Type.Object({}, {additionalProperties: false}),
    async execute(_id, _input, signal, _update, ctx) {
      requireSetup(ctx);
      await ctx.modelRegistry.refresh({signal});
      signal?.throwIfAborted();
      const catalog = ctx.modelRegistry.getAvailable().map(model => ({
        id: modelKey(model), thinkingLevels: getSupportedThinkingLevels(model),
      }));
      return {content: [{type: "text" as const, text: JSON.stringify(catalog)}], details: {catalog}};
    },
  });

  pi.registerTool({
    name: modelSetupTool, label: "保存 Taskbook 模型设置",
    executionMode: "sequential",
    description: "保存用户在 Setup 中批准的 Taskbook 模型配置和 Git 跟踪方式。",
    parameters: Type.Object({
      location: Type.Optional(Type.Union([Type.Literal("personal"), Type.Literal("project")])),
      projectPath: Type.Optional(Type.String({description: "User-selected relative path for a project Model Configuration Table.", maxLength: 240})),
      gitTracking: Type.Optional(Type.Boolean()),
      approvedBy,
      configuration: Type.String({minLength: 1, maxLength: 16384, description: "用户审阅的 TSV，列为 role、model、thinking。省略档位时留空第三列。"}),
    }, {additionalProperties: false}),
    async execute(_id, {location, projectPath, gitTracking, configuration, approvedBy: quotes}, signal, _update, ctx) {
      const setup = requireSetup(ctx);
      if (!setup.models) throw new Error("这次 Setup 已保存角色模型。再次修改前运行 /taskbook-setup。");
      const configured = projectModelPolicy(setup.root) ?? defaultModelPolicy;
      if (location === "personal" && projectPath) throw new Error("个人模型表使用个人目录。");
      const path = projectPath ?? (location === "personal" ? personalModelsFile :
        location === "project" && configured.path === personalModelsFile ? defaultModelPolicy.path : configured.path);
      if (projectPath && !projectPath.startsWith(".fact/")) throw new Error("新的项目模型表应位于 .fact 目录。");
      if (path === personalModelsFile && gitTracking === true) throw new Error("个人模型表不属于项目 Git 仓库。");
      const policy = {path, gitTracking: path === personalModelsFile ? false : gitTracking ?? configured.gitTracking};
      validateModelPolicy(policy);
      const storage = modelStorage(policy);
      const target = storage === "personal" ? personalModelPath() : projectModelPath(setup.root, policy);
      const roles = parseModelConfig(configuration);
      const routes = modelRoutes(ctx, {kind: "tsv", path: target, roles});
      const available = new Set(ctx.modelRegistry.getAvailable().map(modelKey));
      const unavailable = modelRoles.find(role => roles[role] && !available.has(routes[role] ?? ""));
      if (unavailable) throw new Error(`角色 ${unavailable} 的模型当前不可用。`);
      const content = formatModelConfig(roles);
      const preview = modelWritePlan(setup.root, policy, target);
      const previous = preview.files[0]?.content;
      if (storage !== "personal" && previous?.split(/\r?\n/u, 1)[0] === "id\tfact\tsource\tlabels") {
        throw new Error("模型表路径指向了已有的主题事实表。请更正 " + modelSettingsPath + "。");
      }
      if (projectPath && projectPath !== configured.path && previous !== undefined) {
        parseModelConfig(previous);
      }
      const effect = storage === "personal" ? "修改个人模型表，引用它的其他项目也会使用新配置。" :
        storage === "project-tracked" ? "将项目模型表加入 Git 暂存区。" :
        "使用仓库的本机 Git 排除。若 Git 正在跟踪项目模型表，将暂存移除并保留本机文件。";
      checking = true;
      try {
        if (!await authorize(ctx, setup.inputs, quotes, {kind: "models", storage, newPath: projectPath !== configured.path ? projectPath : undefined, changeTracking: policy.gitTracking !== configured.gitTracking && storage !== "personal"}, "保存 Taskbook 模型设置", `${target}\n${effect}\n暂存 ${modelSettingsPath}。\n\n${content}`)) {
          return {content: [{type: "text" as const, text: "用户未批准，配置保留。"}], details: {}};
        }
        signal?.throwIfAborted();
        if (JSON.stringify(modelWritePlan(setup.root, policy, target)) !== JSON.stringify(preview)) {
          throw new Error("设置在确认期间已变化，请重新运行 /taskbook-setup。");
        }
        const result = writeModelSettings(preview, content);
        pi.appendEntry(stateType, {...setup, models: false});
        return {content: [{type: "text" as const, text: JSON.stringify(result)}], details: result};
      } finally { checking = false; }
    },
  });

  pi.registerTool({
    name: migrationTool,
    label: "Taskbook 旧资料迁移",
    description: "查看 .audit 候选并为已选择的事实准备迁移输入，或按独立授权归档、清理原件。",
    executionMode: "sequential",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("preview-facts"), Type.Literal("prepare-facts"), Type.Literal("migrate"), Type.Literal("delete-audit")]),
      branch: Type.Optional(Type.String({minLength: 1})),
      selections: Type.Optional(Type.Array(Type.Object({id: Type.String(), path: Type.String()}, {additionalProperties: false}), {minItems: 1})),
      approvedBy,
    }, {additionalProperties: false}),
    async execute(_id, {operation, branch, selections, approvedBy: quotes}, signal, _update, ctx) {
      const setup = requireSetup(ctx);
      const prepared = setup.migration;
      if (!prepared || repositoryIdentity(setup.root) !== prepared.repository) throw new Error("请先在当前项目盘点迁移来源。");
      const current = inspectAuditMigration(setup.root);
      if (inventoryDigest(current) !== prepared.digest) throw new Error("旧资料已变化，需重新盘点并批准。");
      const run = {root: setup.root, repository: prepared.repository, inventory: current};
      if (operation === "preview-facts") {
        if (current.status !== "ready" && current.status !== "archived") throw new Error("没有可核对的审计来源。");
        const preview = inspectAuditFacts(run.root, run.repository, current.snapshot.digest);
        return {content: [{type: "text" as const, text: JSON.stringify(preview)}], details: {}};
      }
      const plan = migrationPlan(run, operation, {branch, selections});
      checking = true;
      try {
        const inputs = operation === "delete-audit" ? setup.inputs.slice(prepared.archivedAfterInput ?? 0) : setup.inputs;
        if (!await authorize(ctx, inputs, quotes, {kind: operation}, plan.title, plan.description)) return {content: [{type: "text", text: "用户未批准，原件保留。"}], details: {}};
        signal?.throwIfAborted();
        const result = plan.apply();
        pi.appendEntry(stateType, {...setup, migration: {...prepared, digest: inventoryDigest(inspectAuditMigration(run.root)),
          ...(operation === "migrate" ? {archivedAfterInput: setup.inputs.length} : {})}});
        return {content: [{type: "text" as const, text: JSON.stringify(result)}], details: {}};
      } finally { checking = false; }
    },
  });
  pi.on("input", (event, ctx) => {
    if (checking || workflowIsBusy() || event.source === "extension" || !event.text.trim() || event.text.trimStart().startsWith("/")) return;
    const setup = currentSetup(ctx);
    if (setup) pi.appendEntry(stateType, {...setup, inputs: [...setup.inputs, event.text.trim()]});
  });
  pi.on("before_agent_start", (event, ctx) => {
    const setup = currentSetup(ctx);
    const kickoff = event.messageType === "custom" && event.message.customType === setupType;
    if ((!setup && !kickoff) || workflowIsBusy()) return;
    const active = pi.getActiveTools();
    const missing = setupTools.filter(name => !active.includes(name));
    return {systemPrompt: [event.systemPrompt, instructions,
      ...(missing.length ? ["Unavailable Setup tools in this turn: " + missing.join(", ")] : [])].join("\n\n")};
  });
  pi.on("session_start", () => exposeSetupTools());
  return {isChecking: () => checking, isActive: (ctx: ExtensionContext) => Boolean(currentSetup(ctx)), close: (ctx: ExtensionContext) => {
    if (currentSetup(ctx)) pi.appendEntry(stateType, null);
  }};
}

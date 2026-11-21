import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { deleteLegacyProjectMemoryRef, importLegacyProjectMemory, inspectLegacyProjectMemory } from "../facts/project-memory-migration.ts";
import { inspectLegacyMagpieMirror, migrateLegacyMagpieMirror } from "../integrations/magpie-memory.ts";
import { git, repositoryIdentity } from "../taskbook/document.ts";
import { deleteMigratedAudit, inspectAuditMigration, migrateAudit } from "./audit-migration.ts";
import { collectSetup } from "./diagnostics.ts";
import { formatModelConfig, getSupportedThinkingLevels, modelKey, modelRoles, modelRoutes, parseModelConfig, personalModelPath } from "../models/config.ts";
import { modelSettingsPath, modelWritePlan, projectModelPath, writeModelSettings } from "../models/storage.ts";

const setupType = "pi-taskbook-setup";
const stateType = "pi-taskbook-setup-state";
const migrationTool = "taskbook_migrate";
const modelSetupTool = "taskbook_model_setup";
const modelCatalogTool = "taskbook_model_catalog";
const setupTools = [modelCatalogTool, modelSetupTool, migrationTool];
const instructions = readFileSync(new URL("../../prompts/setup.md", import.meta.url), "utf8").trim();
const approvedBy = Type.Optional(Type.Array(Type.String({minLength: 1}), {minItems: 1, maxItems: 12, uniqueItems: true}));
type MigrationOperation = "migrate" | "delete-audit" | "delete-legacy-ref";
const migrationSources = ["audit", "project-json", "legacy-ref", "mirror"] as const;
type MigrationSource = typeof migrationSources[number];
type SetupOperation = {kind: "models"; storage: "personal" | "project-tracked" | "project-local"} |
  {kind: "migrate"; sources: readonly MigrationSource[]} | {kind: Exclude<MigrationOperation, "migrate">};
const sourceNames: Record<MigrationSource, RegExp> = {
  audit: /\.audit|审计资料|\baudit\b/iu,
  "project-json": /project\.json|旧项目事实|(?:legacy|old) (?:project facts|json)/iu,
  "legacy-ref": /旧\s*(?:Git\s*)?引用|refs\/pi-taskbook\/project-memory|legacy (?:Git )?ref/iu,
  mirror: /旧镜像|旧\s*Magpie|\b(?:magpie|mirror)\b/iu,
};

function inventory(root: string, repository: string) {
  return {
    facts: inspectLegacyProjectMemory(root, repository),
    audit: inspectAuditMigration(root),
    mirrors: inspectLegacyMagpieMirror(root, repository),
  };
}

type SetupInventory = ReturnType<typeof inventory>;
type MigrationSession = {root: string; repository: string; inventory: SetupInventory};
const setupState = Type.Object({
  root: Type.String(), session: Type.String(), models: Type.Boolean(), inputs: Type.Array(Type.String()),
  migration: Type.Optional(Type.Object({repository: Type.String(), digest: Type.String()})),
});
type SetupState = Static<typeof setupState>;

function inventoryDigest(value: SetupInventory) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function migrationPlan(run: MigrationSession, operation: MigrationOperation, sources: readonly MigrationSource[] = migrationSources) {
  const {root, repository} = run;
  const {audit, facts, mirrors} = run.inventory;
  const inScope = ({source}: {source: string}) => sources.includes(source.startsWith(".audit/") ? "audit" :
    source === ".fact/project.json" ? "project-json" : "legacy-ref");
  const entries = facts.entries.filter(entry => inScope(entry) && entry.status === "ready");
  const legacyStore = sources.includes("project-json") && facts.projectJson?.status === "ready" ? facts.projectJson.sourceRevision : undefined;
  const archives = facts.archives.filter(entry => inScope(entry) && entry.status === "ready")
    .map(({source, sourceRevision}) => ({source, sourceRevision}));
  const auditDigest = audit.status === "ready" || audit.status === "archived" ? audit.snapshot.digest : undefined;
  const mirrorRevision = sources.includes("mirror") && mirrors.status === "ready" ? mirrors.revision : undefined;
  const legacyHead = facts.legacyHead;
  let title: string;
  let description: string;
  if (operation === "migrate") {
    if ((entries.length || archives.length) && facts.projectJson?.status === "ready" && !legacyStore) {
      throw new Error("导入旧事实前需要批准迁移 .fact/project.json。");
    }
    title = "迁移 Taskbook 旧资料";
    description = [
      entries.length ? `导入 ${entries.length} 条已核对事实，写入 .fact/facts.tsv。` : undefined,
      sources.includes("audit") && auditDigest && "archive" in audit ? `归档 .audit 到 ${audit.archive}，复制可恢复的检查点。` : undefined,
      mirrorRevision ? "将旧镜像按来源项目迁到 .fact/<仓库名>/facts.tsv。" : undefined,
      legacyStore ? "将旧项目事实文件转换成 TSV。" : undefined,
      archives.length ? `迁移 ${archives.length} 份旧事实档案的事务回执。` : undefined,
      "旧资料原件保留。",
    ].filter(Boolean).join("\n");
  } else if (operation === "delete-audit") {
    if (audit.status !== "archived" ||
        [...facts.entries, ...facts.archives].some(entry => entry.source.startsWith(".audit/") && entry.status !== "already-imported")) {
      throw new Error("先完成 .audit 的事实迁移及归档，核对冲突后再清理。");
    }
    if (audit.activeGlossary) throw new Error(`当前术语清单 ${audit.activeGlossary} 位于 .audit 中。请先按项目约定迁出并更新声明。`);
    title = "清理已迁移的 .audit";
    description = `删除 ${root}/.audit。核对过的归档保存在 ${audit.archive}。`;
  } else {
    if (!legacyHead) throw new Error("本次盘点没有旧 Git 引用。");
    title = "清理已迁移的旧 Git 引用";
    description = "删除 refs/pi-taskbook/project-memory，版本 " + legacyHead + "。";
  }
  return {title, description, apply() {
    if (JSON.stringify(inventory(root, repository)) !== JSON.stringify(run.inventory)) throw new Error("旧资料已变化，需重新盘点并批准。");
    if (operation === "migrate") {
      const archive = sources.includes("audit") && auditDigest ? migrateAudit(root, repository, auditDigest) : undefined;
      const snapshot = entries.length || legacyStore || archives.length
        ? importLegacyProjectMemory(root, repository, entries.map(({id, sourceVersion}) => ({id, sourceVersion})),
          {projectJsonVersion: legacyStore, archiveVersions: archives}) : undefined;
      const mirror = mirrorRevision ? migrateLegacyMagpieMirror(root, repository, mirrorRevision) : undefined;
      return {projectFacts: snapshot?.head, audit: archive, mirrors: mirror};
    }
    if (operation === "delete-audit" && auditDigest) {
      deleteMigratedAudit(root, auditDigest);
      return {deleted: ".audit", archive: "archive" in audit ? audit.archive : undefined};
    }
    if (legacyHead) {
      deleteLegacyProjectMemoryRef(root, legacyHead, repository);
      return {deletedRef: legacyHead};
    }
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
    if (quotes?.length) {
      if (!userInputs.length || !quotes.every(quote => userInputs.includes(quote.trim())) ||
          !quotes.some(quote => quote.trim() === userInputs.at(-1))) {
        throw new Error("请引用本次 setup 的完整用户原话，并核对最新决定。");
      }
      const ordered = userInputs.filter(input => quotes.some(quote => input === quote.trim()));
      if (ordered.every(input => /^(?:(?:批准|同意|确认|授权|approve(?:d)?|yes|ok)\s*)?[\p{P}\s]*$/iu.test(input))) {
        throw new Error("批准内容为空。请明确批准哪些操作。");
      }
      const latest = ordered.at(-1)!;
      if (operation.kind === "migrate") {
        const migrate = /迁移|归档|导入|转换|\b(?:migrate|archive|import|convert)\b/iu;
        const allLegacy = /(?:全部|所有)(?:的)?(?:旧资料|旧数据|迁移来源)|\ball (?:legacy|old)\b/iu;
        const decline = /(?:不要|无需|暂不|先不|别|do not|don['’]t)\s*(?:迁移|归档|导入|migrate|archive|import)/iu;
        if (decline.test(latest) || operation.sources.some(source => !ordered.some(input =>
          migrate.test(input) && !decline.test(input) && (sourceNames[source].test(input) || allLegacy.test(input))))) {
          throw new Error("请逐项明确批准本次迁移的来源。");
        }
      }
      if (operation.kind === "delete-audit" || operation.kind === "delete-legacy-ref") {
        const subject = sourceNames[operation.kind === "delete-audit" ? "audit" : "legacy-ref"];
        const remove = (input: string) => /删除|清理|移除|\b(?:delete|remove|clean up)\b/iu.test(input);
        const decline = /(?:不要|无需|暂不|先不|别|do not|don['’]t)\s*(?:删除|清理|移除|delete|remove|clean up)|(?:保留|keep|retain)\s*(?:原来的?|原有的?)?\s*(?:\.audit|原件|审计资料|旧\s*(?:Git\s*)?引用|legacy (?:Git )?ref)/iu;
        if (decline.test(latest) || !ordered.some(input => subject.test(input) && remove(input) && !decline.test(input))) {
          throw new Error("清理需要明确批准删除相应原件。请核对用户选择。");
        }
      }
      if (operation.kind === "models" && operation.storage !== "personal") {
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
        const checks = await collectSetup(pi, ctx);
        let legacy: SetupInventory | {status: "unconfirmed"; reason: string} | undefined;
        let setup: SetupState | undefined;
        if (typeof checks.repository.root === "string" &&
            checks.repository.root === git(ctx.cwd, "rev-parse", "--show-toplevel")) {
          const root = checks.repository.root;
          setup = {root, session: ctx.sessionManager.getSessionId(), models: true, inputs: args.trim() ? [args.trim()] : []};
          const repository = repositoryIdentity(root);
          if (repository) {
            try {
              legacy = inventory(root, repository);
              setup.migration = {repository, digest: inventoryDigest(legacy)};
            } catch {
              legacy = {status: "unconfirmed", reason: "无法核对旧事实或 .audit 的迁移来源。"};
            }
          } else {
            legacy = {status: "unconfirmed", reason: "核对项目归属后才能迁移旧资料。"};
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
      location: Type.Union([Type.Literal("personal"), Type.Literal("project")]),
      gitTracking: Type.Optional(Type.Boolean()),
      approvedBy,
      configuration: Type.String({minLength: 1, maxLength: 16384, description: "用户审阅的 TSV，列为 role、model、thinking。省略档位时留空第三列。"}),
    }, {additionalProperties: false}),
    async execute(_id, {location, gitTracking, configuration, approvedBy: quotes}, signal, _update, ctx) {
      const setup = requireSetup(ctx);
      if (!setup.models) throw new Error("这次 Setup 已保存角色模型。再次修改前运行 /taskbook-setup。");
      if ((location === "project") !== (gitTracking !== undefined)) throw new Error("使用项目模型表时请明确选择是否由 Git 跟踪。");
      const storage = location === "personal" ? "personal" : gitTracking ? "project-tracked" : "project-local";
      const target = storage === "personal" ? personalModelPath() : projectModelPath(setup.root, storage);
      const roles = parseModelConfig(configuration);
      const routes = modelRoutes(ctx, {kind: "tsv", path: target, roles});
      const available = new Set(ctx.modelRegistry.getAvailable().map(modelKey));
      const unavailable = modelRoles.find(role => roles[role] && !available.has(routes[role] ?? ""));
      if (unavailable) throw new Error(`角色 ${unavailable} 的模型当前不可用。`);
      const content = formatModelConfig(roles);
      const preview = modelWritePlan(setup.root, storage, target);
      const effect = storage === "personal" ? "修改个人模型表，引用它的其他项目也会使用新配置。" :
        storage === "project-tracked" ? "将项目模型表加入 Git 暂存区。" :
        "使用仓库的本机 Git 排除。若 Git 正在跟踪项目模型表，将暂存移除并保留本机文件。";
      checking = true;
      try {
        if (!await authorize(ctx, setup.inputs, quotes, {kind: "models", storage}, "保存 Taskbook 模型设置", `${target}\n${effect}\n暂存 ${modelSettingsPath}。\n\n${content}`)) {
          return {content: [{type: "text" as const, text: "用户未批准，配置保留。"}], details: {}};
        }
        signal?.throwIfAborted();
        if (JSON.stringify(modelWritePlan(setup.root, storage, target)) !== JSON.stringify(preview)) {
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
    description: "按同一 Pi 会话最近一次 setup 盘点迁移，或单独清理已核对的旧资料。用 sources 指定本次批准迁移的来源。",
    executionMode: "sequential",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("migrate"), Type.Literal("delete-audit"), Type.Literal("delete-legacy-ref")]),
      sources: Type.Optional(Type.Array(Type.Union(migrationSources.map(source => Type.Literal(source))),
        {minItems: 1, uniqueItems: true})),
      approvedBy,
    }, {additionalProperties: false}),
    async execute(_id, {operation, sources, approvedBy: quotes}, signal, _update, ctx) {
      const setup = requireSetup(ctx);
      const prepared = setup.migration;
      if (!prepared || repositoryIdentity(setup.root) !== prepared.repository) throw new Error("请先在当前项目盘点迁移来源。");
      const current = inventory(setup.root, prepared.repository);
      if (inventoryDigest(current) !== prepared.digest) throw new Error("旧资料已变化，需重新盘点并批准。");
      const run = {root: setup.root, repository: prepared.repository, inventory: current};
      if (operation === "migrate" && quotes?.length && !sources?.length) throw new Error("请给出本次获批迁移的来源。");
      const plan = migrationPlan(run, operation, sources);
      checking = true;
      try {
        const authorization = operation === "migrate" ? {kind: operation, sources: sources ?? migrationSources} : {kind: operation};
        if (!await authorize(ctx, setup.inputs, quotes, authorization, plan.title, plan.description)) return {content: [{type: "text" as const, text: "用户未批准，原件保留。"}], details: {}};
        signal?.throwIfAborted();
        const result = plan.apply();
        pi.appendEntry(stateType, {...setup, migration: {...prepared, digest: inventoryDigest(inventory(run.root, run.repository))}});
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
    if (!setup || workflowIsBusy()) return;
    const active = pi.getActiveTools();
    const missing = setupTools.filter(name => !active.includes(name));
    return {systemPrompt: [event.systemPrompt, instructions,
      ...(missing.length ? ["Unavailable Setup tools in this turn: " + missing.join(", ")] : [])].join("\n\n")};
  });
  pi.on("session_start", () => exposeSetupTools());
  return {isChecking: () => checking, close: (ctx: ExtensionContext) => {
    if (currentSetup(ctx)) pi.appendEntry(stateType, null);
  }};
}

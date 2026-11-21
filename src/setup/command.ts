import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deleteLegacyProjectMemoryRef, importLegacyProjectMemory, inspectLegacyProjectMemory } from "../facts/project-memory-migration.ts";
import { inspectLegacyMagpieMirror, migrateLegacyMagpieMirror } from "../integrations/magpie-memory.ts";
import { git, repositoryIdentity } from "../taskbook/document.ts";
import { deleteMigratedAudit, inspectAuditMigration, migrateAudit } from "./audit-migration.ts";
import { collectSetup } from "./diagnostics.ts";
import { formatModelConfig, modelKey, modelRoles, modelRoutes, parseModelConfig, personalModelPath } from "../models/config.ts";
import { modelSettingsPath, modelWritePlan, projectModelPath, writeModelSettings } from "../models/storage.ts";
import { readT3Workspace } from "../integrations/t3.ts";

const setupType = "pi-taskbook-setup";
const migrationTool = "taskbook_migrate";
const modelSetupTool = "taskbook_model_setup";
const instructions = "这是 /taskbook-setup 的普通对话。\n" +
  readFileSync(new URL("../../prompts/setup.md", import.meta.url), "utf8").trim();
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
type SetupSession = { root: string; repository: string; session: string; inventory: SetupInventory };

async function setupRoot(cwd: string) {
  return (await readT3Workspace(cwd))?.root ?? git(cwd, "rev-parse", "--show-toplevel");
}

function migrationPlan(run: SetupSession, operation: MigrationOperation, sources: readonly MigrationSource[] = migrationSources) {
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
  let pending: SetupSession | undefined;
  let models: {root: string; session: string} | undefined;
  let userInputs: string[] = [];

  function closeModelSetup() {
    models = undefined;
    const tools = pi.getActiveTools();
    if (tools.includes(modelSetupTool)) pi.setActiveTools(tools.filter(tool => tool !== modelSetupTool));
  }

  function closeSetup() {
    pending = undefined;
    userInputs = [];
    closeModelSetup();
    const tools = pi.getActiveTools();
    if (tools.includes(migrationTool)) pi.setActiveTools(tools.filter(tool => tool !== migrationTool));
  }

  async function authorize(ctx: ExtensionContext, quotes: string[] | undefined, operation: SetupOperation, title: string, description: string) {
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

  function applyMigration(run: SetupSession, plan: ReturnType<typeof migrationPlan>) {
    const result = plan.apply();
    pending = {...run, inventory: inventory(run.root, run.repository)};
    return result;
  }

  pi.registerCommand("taskbook-setup", {
    description: "将 Pi 和项目诊断附到普通会话，协助初始化或迁移",
    async handler(args, ctx) {
      if (!ctx.isIdle() || checking || workflowIsBusy()) {
        return ctx.ui.notify("请在任务书会话空闲且没有待裁决事项时运行 /taskbook-setup。", "warning");
      }
      checking = true;
      closeSetup();
      try {
        if (args.trim()) userInputs.push(args.trim());
        const checks = await collectSetup(pi, ctx);
        let legacy: SetupInventory | {status: "unconfirmed"; reason: string} | undefined;
        if (typeof checks.repository.root === "string") {
          const root = checks.repository.root;
          if (checks.models.catalog.length) models = {root, session: ctx.sessionManager.getSessionId()};
          const repository = repositoryIdentity(root);
          if (repository) {
            try {
              legacy = inventory(root, repository);
              pending = {root, repository, session: ctx.sessionManager.getSessionId(), inventory: legacy};
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
        if (pending || models) pi.setActiveTools([...pi.getActiveTools(), ...(pending ? [migrationTool] : []), ...(models ? [modelSetupTool] : [])]);
        pi.sendMessage({customType: setupType, content: [instructions, "## Runtime diagnostics\n" + report,
          ...(args.trim() ? ["## User command argument\n" + args.trim()] : [])].join("\n\n"),
          display: false}, {triggerTurn: true});
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      } finally { checking = false; }
    },
  });

  pi.registerTool({
    name: modelSetupTool, label: "保存 Taskbook 模型设置", defaultActive: false,
    executionMode: "sequential",
    description: "保存用户选定的 Taskbook 模型配置和 Git 跟踪方式。当前 setup 会话内使用。",
    parameters: Type.Object({
      location: Type.Union([Type.Literal("personal"), Type.Literal("project")]),
      gitTracking: Type.Optional(Type.Boolean()),
      approvedBy,
      configuration: Type.String({minLength: 1, maxLength: 16384, description: "用户审阅的角色配置，每行 role: provider/model-id，可加 @ thinking-level。"}),
    }, {additionalProperties: false}),
    async execute(_id, {location, gitTracking, configuration, approvedBy: quotes}, signal, _update, ctx) {
      const setup = models;
      if (!setup || checking || workflowIsBusy() || ctx.sessionManager.getSessionId() !== setup.session ||
          await setupRoot(ctx.cwd) !== setup.root) {
        throw new Error("请在空闲的当前项目会话先运行 /taskbook-setup。");
      }
      if ((location === "project") !== (gitTracking !== undefined)) throw new Error("使用项目模型表时请明确选择是否由 Git 跟踪。");
      const storage = location === "personal" ? "personal" : gitTracking ? "project-tracked" : "project-local";
      const target = storage === "personal" ? personalModelPath() : projectModelPath(setup.root, storage);
      const roles = parseModelConfig(configuration);
      const routes = modelRoutes(ctx, {kind: "markdown", path: target, roles});
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
        if (!await authorize(ctx, quotes, {kind: "models", storage}, "保存 Taskbook 模型设置", `${target}\n${effect}\n暂存 ${modelSettingsPath}。\n\n${content}`)) {
          return {content: [{type: "text" as const, text: "用户未批准，配置保留。"}], details: {}};
        }
        signal?.throwIfAborted();
        if (JSON.stringify(modelWritePlan(setup.root, storage, target)) !== JSON.stringify(preview)) {
          throw new Error("设置在确认期间已变化，请重新运行 /taskbook-setup。");
        }
        const result = writeModelSettings(preview, content);
        closeModelSetup();
        return {content: [{type: "text" as const, text: JSON.stringify(result)}], details: result};
      } finally { checking = false; }
    },
  });

  pi.registerTool({
    name: migrationTool,
    label: "Taskbook 旧资料迁移",
    description: "按同一 Pi 会话最近一次 setup 盘点迁移，或单独清理已核对的旧资料。用 sources 指定本次批准迁移的来源。",
    defaultActive: false,
    executionMode: "sequential",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("migrate"), Type.Literal("delete-audit"), Type.Literal("delete-legacy-ref")]),
      sources: Type.Optional(Type.Array(Type.Union(migrationSources.map(source => Type.Literal(source))),
        {minItems: 1, uniqueItems: true})),
      approvedBy,
    }, {additionalProperties: false}),
    async execute(_id, {operation, sources, approvedBy: quotes}, signal, _update, ctx) {
      const run = pending;
      if (!run || checking || workflowIsBusy() || ctx.sessionManager.getSessionId() !== run.session ||
          await setupRoot(ctx.cwd) !== run.root || repositoryIdentity(run.root) !== run.repository) {
        throw new Error("请在空闲的当前项目会话先运行 /taskbook-setup。");
      }
      if (operation === "migrate" && quotes?.length && !sources?.length) throw new Error("请给出本次获批迁移的来源。");
      const plan = migrationPlan(run, operation, sources);
      checking = true;
      try {
        const authorization = operation === "migrate" ? {kind: operation, sources: sources ?? migrationSources} : {kind: operation};
        if (!await authorize(ctx, quotes, authorization, plan.title, plan.description)) return {content: [{type: "text" as const, text: "用户未批准，原件保留。"}], details: {}};
        signal?.throwIfAborted();
        const result = applyMigration(run, plan);
        return {content: [{type: "text" as const, text: JSON.stringify(result)}], details: {}};
      } finally { checking = false; }
    },
  });
  pi.on("input", (event, ctx) => {
    if (!checking && !workflowIsBusy() && event.source !== "extension" && event.text.trim() && !event.text.trimStart().startsWith("/") &&
        (models?.session === ctx.sessionManager.getSessionId() || pending?.session === ctx.sessionManager.getSessionId())) {
      userInputs.push(event.text.trim());
    }
  });
  pi.on("session_start", closeSetup);
  return {isChecking: () => checking, closeModels: () => { closeModelSetup(); userInputs = []; }};
}

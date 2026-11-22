import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const magpieMethods = ["memory_context", "memory_search", "memory_save", "memory_forget"] as const;
export type MagpieCapability = typeof magpieMethods[number];
type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];
export type SessionMcpTool = Pick<ToolInfo, "name" | "exposure" | "parameters"> & {
  server: string;
  method: string;
};

type Match = { tool: SessionMcpTool; verified: boolean };
type Capability = {
  status: "discovered" | "missing" | "unconfirmed" | "hidden";
  impact: string;
  tools: { name: string; server: string; exposure: SessionMcpTool["exposure"]; verified: boolean }[];
};

function sessionCatalogue(pi: ExtensionAPI) {
  const servers = new Map<string, SessionMcpTool[]>();
  for (const tool of pi.getAllTools()) {
    const namespace = tool.namespace;
    if (tool.sourceInfo.source !== "builtin" || tool.sourceInfo.path !== "builtin:mcp" ||
        !namespace?.name.startsWith("mcp__") || !tool.name.startsWith(namespace.name + "__")) continue;
    const server = namespace.aliases?.[0] ?? namespace.name.slice("mcp__".length);
    const method = tool.name.slice(namespace.name.length + 2);
    const entry = { name: tool.name, exposure: tool.exposure, parameters: tool.parameters, server, method };
    const previous = servers.get(server);
    if (previous) previous.push(entry);
    else servers.set(server, [entry]);
  }
  return servers;
}

function magpieConfig(path: string): boolean | undefined {
  try {
    const config: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!config || typeof config !== "object" || !("mcpServers" in config)) return;
    const servers = config.mcpServers;
    if (!servers || typeof servers !== "object" || !("magpie" in servers)) return;
    const server = servers.magpie;
    if (server && typeof server === "object") return !("enabled" in server) || server.enabled !== false;
  } catch {}
}

export async function waitForMagpieCatalogue(pi: ExtensionAPI, ctx: ExtensionContext, root?: string) {
  const registered = () => sessionCatalogue(pi).get("magpie")?.some(tool => tool.exposure !== "hidden") ?? false;
  if (registered()) return "registered";
  if (!pi.getCommands().some(command => command.name === "mcp")) return "not-discovered";
  const project = root && ctx.isProjectTrusted() ? magpieConfig(join(root, ".pi/mcp.json")) : undefined;
  const enabled = project ?? magpieConfig(join(getAgentDir(), "mcp.json")) ??
    pi.getMcpServers().some(server => server.name === "magpie" && server.config.enabled !== false);
  if (!enabled) return "not-discovered";
  const deadline = Date.now() + 2000;
  while (!ctx.signal?.aborted && Date.now() < deadline) {
    await setTimeout(100);
    if (registered()) return "registered";
  }
  return "configured-no-tools";
}

function magpieCatalogue(servers: Map<string, SessionMcpTool[]>) {
  const result = new Map<string, Partial<Record<MagpieCapability, SessionMcpTool>>>();
  for (const [server, tools] of servers) {
    const matches: Partial<Record<MagpieCapability, SessionMcpTool>> = {};
    for (const capability of magpieMethods) {
      const tool = tools.find(candidate => candidate.method === capability);
      if (tool) matches[capability] = tool;
    }
    if (Object.keys(matches).length || /magpie/i.test(server)) result.set(server, matches);
  }
  return result;
}

export function magpieSessionTools(pi: ExtensionAPI) {
  return magpieCatalogue(sessionCatalogue(pi));
}

function capability(matches: Match[], hasService: boolean, impact: string): Capability {
  return {
    status: matches.some(({tool, verified}) => verified && tool.exposure !== "hidden") ? "discovered" :
      matches.some(({tool}) => tool.exposure !== "hidden") ? "unconfirmed" :
      matches.length ? "hidden" : hasService ? "missing" : "unconfirmed",
    tools: matches.map(({tool: {name, server, exposure}, verified}) => ({ name, server, exposure, verified })),
    impact,
  };
}

function directMatch(tool?: SessionMcpTool): Match[] {
  return tool ? [{tool, verified: true}] : [];
}

const magpieImpact = {
  memory_context: "缺少时无法核对远端身份、项目及搜索范围，完成同步等待核实。",
  memory_search: "缺少时无法召回候选、核对已发布状态或镜像来源。",
  memory_save: "缺少时创建和更新等待处理。",
  memory_forget: "缺少时远端退役等待处理。",
} satisfies Record<MagpieCapability, string>;

const githubReads = {
  repositoryContents: { methods: ["get_file_contents", "get_repository_content", "get_repository_file", "read_repository_file", "read_file"],
    impact: "从远端核对指定仓库和版本的文件需要此能力。本地 Git 快照仍可独立审核。" },
  issueReadOrSearch: { methods: ["get_issue", "get_issue_details", "search_issues", "list_issues"],
    combined: { issue_read: ["get"] }, impact: "获取或检索 Issue 规格需要此能力。" },
  pullRequestMetadata: { methods: ["get_pull_request", "get_pull_request_details", "pull_request_get", "pull_request_view", "get_pr"],
    combined: { pull_request_read: ["get"] }, impact: "核对 PR 元数据需要此能力。" },
  pullRequestDiff: { methods: ["get_pull_request_diff", "get_pull_request_files", "pull_request_diff", "list_pull_request_files", "get_pr_diff"],
    combined: { pull_request_read: ["get_diff", "get_files"] }, impact: "核对远端 PR 文件或差异需要此能力。本地提交差异仍可独立审核。" },
};

const githubWrites = {
  issueCreate: { methods: ["create_issue"], combined: { issue_write: ["create"] },
    command: /\bgh issue create\b/, impact: "按工作流创建 Issue。" },
  issueUpdate: { methods: ["update_issue", "edit_issue"], combined: { issue_write: ["update"] },
    command: /\bgh issue edit\b/, impact: "按工作流编辑 Issue、分派或修改标签。" },
  issueClose: { methods: ["close_issue", "update_issue", "edit_issue"], combined: { issue_write: ["update"] },
    command: /\bgh issue close\b/, impact: "按工作流关闭 Issue。" },
  issueComment: { methods: ["add_issue_comment", "create_issue_comment", "comment_on_issue"],
    command: /\bgh issue comment\b/, impact: "按工作流评论 Issue。" },
  issueSubIssue: { methods: ["add_sub_issue"], combined: { sub_issue_write: ["add"] },
    command: /--(?:parent|add-sub-issue)\b/, impact: "按工作流关联 Issue 子项。" },
  issueDependency: { methods: ["add_issue_dependency"],
    command: /--blocked-by\b/, impact: "按工作流关联 Issue 依赖。" },
  pullRequestCreate: { methods: ["create_pull_request"],
    command: /\bgh pr create\b/, impact: "按工作流创建 PR。" },
  pullRequestMerge: { methods: ["merge_pull_request"],
    command: /\bgh pr merge\b/, impact: "按工作流合并 PR。" },
};

export function toolProperties(parameters?: ToolInfo["parameters"]): object | undefined {
  const properties = parameters && "properties" in parameters ? parameters.properties : undefined;
  return properties && typeof properties === "object" ? properties : undefined;
}

function githubMatches(tool: SessionMcpTool, spec: {methods: string[]; combined?: Partial<Record<string, string[]>>}): Match[] {
  const method = tool.method.replace(/^github__/, "");
  if (spec.methods.includes(method)) return directMatch(tool);
  const commands = spec.combined && Object.hasOwn(spec.combined, method) ? spec.combined[method] : undefined;
  if (!commands) return [];
  const properties = toolProperties(tool.parameters);
  const schema = typeof properties === "object" && properties && "method" in properties ? properties.method : undefined;
  if (typeof schema !== "object" || schema === null || !("enum" in schema) || !Array.isArray(schema.enum)) {
    return [{tool, verified: false}];
  }
  const values: unknown[] = schema.enum;
  return commands.some(method => values.includes(method)) ? directMatch(tool) : [];
}

function githubServer(server: string, tools: SessionMcpTool[]) {
  if (server === "t3-code" || server === "t3_code") return false;
  return /github/i.test(server) || tools.some(tool => tool.method.startsWith("github__") ||
    ["get_file_contents", "issue_read", "pull_request_read", "get_pull_request", "get_pull_request_diff", "get_pr_diff"].includes(tool.method));
}

export function inspectMcpCapabilities(pi: ExtensionAPI, githubWorkflow?: string) {
  let servers: ReturnType<typeof sessionCatalogue>;
  try {
    servers = sessionCatalogue(pi);
  } catch {
    servers = new Map();
  }
  const magpie = magpieCatalogue(servers);
  const github = [...servers].filter(([server, tools]) => githubServer(server, tools));
  const githubTools = github.flatMap(([, tools]) => tools);
  return {
    source: "当前 Pi 会话的 getAllTools()",
    caveat: "目录发现只证明当前注册和暴露状态。还需核对远端连接、作用域和权限。未发现服务时，目录无法区分未配置、尚未连接和不可用。",
    magpie: {
      byService: Object.fromEntries([...magpie].map(([server, tools]) => [server, Object.fromEntries(magpieMethods.map(method =>
        [method, capability(directMatch(tools[method]), true, magpieImpact[method])]))])),
      capabilities: Object.fromEntries(magpieMethods.map(method =>
        [method, capability([...magpie.values()].flatMap(tools => directMatch(tools[method])),
          magpie.size > 0, magpieImpact[method])])),
    },
    github: {
      services: github.map(([server]) => server),
      read: Object.fromEntries(Object.entries(githubReads).map(([name, spec]) =>
        [name, capability(githubTools.flatMap(tool => githubMatches(tool, spec)), github.length > 0, spec.impact)])),
      write: Object.fromEntries(Object.entries(githubWrites).filter(([, spec]) => githubWorkflow && spec.command.test(githubWorkflow))
        .map(([name, spec]) => [name, capability(githubTools.flatMap(tool => githubMatches(tool, spec)),
          github.length > 0, spec.impact)])),
      declaredAlternative: githubWorkflow && /\bgh (?:api|issue|pr)\b/.test(githubWorkflow) ? "gh" : null,
    },
  };
}

import { realpathSync } from "node:fs";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { git } from "../taskbook/document.ts";

type T3 = { url: URL; token: string };
type RpcResponse = { id?: number; result?: unknown; error?: unknown };
const launchTool = "t3_thread_launch";
const statusTool = "t3_worktree_status";
const listTool = "t3_worktree_list";
const handoffTool = "t3_worktree_handoff";
const nullable = Type.Union([Type.String(), Type.Null()]);
const bindingSchema = Type.Object({attached: Type.Boolean(), worktreePath: nullable, branch: nullable,
  projectWorkspaceRoot: Type.String(), defaultStartFromOrigin: Type.Boolean()});
const worktreePage = Type.Object({refs: Type.Array(Type.Object({name: Type.String(), worktreePath: nullable})),
  nextCursor: Type.Union([Type.Integer(), Type.Null()])});
const handoffSchema = Type.Object({worktreePath: Type.String(), branch: Type.String(), baseRef: Type.String(), startedFromOrigin: Type.Boolean(),
  continuation: Type.Union([
    Type.Object({status: Type.Literal("scheduled"), delivery: Type.String()}),
    Type.Object({status: Type.Literal("skipped")}),
    Type.Object({status: Type.Literal("failed"), detail: Type.String()}),
  ]),
  setupScript: Type.Union([
    Type.Object({status: Type.Literal("started"), scriptName: Type.String(), terminalId: Type.String()}),
    Type.Object({status: Type.Literal("no-script")}),
    Type.Object({status: Type.Literal("skipped")}),
    Type.Object({status: Type.Literal("failed"), detail: Type.String()}),
  ]),
});

function readT3Endpoint(): T3 {
  const raw = process.env.T3_MCP_URL;
  const token = process.env.T3_MCP_BEARER_TOKEN;
  if (!raw || !token) throw new Error("当前 Pi 会话缺少 T3 MCP。");
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      url.username || url.password || url.hash || url.search) {
    throw new Error("T3 MCP 必须是 T3 注入的本地 HTTP 端点。");
  }
  return { url, token };
}

function decode(text: string, sse: boolean, id: number): RpcResponse {
  if (!sse) return JSON.parse(text) as RpcResponse;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    const message = JSON.parse(data) as RpcResponse;
    if (message.id === id) return message;
  }
  throw new Error("T3 MCP 响应缺少对应的 RPC ID。");
}

async function connectT3(t3: T3) {
  let session: string | null = null;
  let protocol = "2025-06-18";
  let requestId = 0;
  async function rpc(method: string, params?: Record<string, unknown>, notification = false) {
    const id = notification ? undefined : ++requestId;
    const headers = new Headers({
      Authorization: "Bearer " + t3.token,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": protocol,
    });
    if (session) headers.set("Mcp-Session-Id", session);
    const response = await fetch(t3.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(method === "tools/call" ? 25_000 : 5_000),
    });
    if (!response.ok) throw new Error("T3 MCP 调用失败，HTTP " + response.status + "。");
    if (id === undefined) return;
    session = response.headers.get("Mcp-Session-Id") ?? session;
    const type = response.headers.get("Content-Type") ?? "";
    const result = decode(await response.text(), type.includes("text/event-stream"), id);
    if (result.id !== id || result.error || !result.result) throw new Error("T3 MCP 未接受 " + method + "。");
    return result.result;
  }

  const initialized = await rpc("initialize", {
    protocolVersion: protocol, capabilities: {}, clientInfo: { name: "pi-taskbook", version: "0.2.0" },
  }) as { protocolVersion?: string };
  if (initialized.protocolVersion) protocol = initialized.protocolVersion;
  await rpc("notifications/initialized", undefined, true);
  return rpc;
}

function hasWorktreeStrategy(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  if ("properties" in schema && typeof schema.properties === "object" && schema.properties !== null &&
      "baseRef" in schema.properties && "branch" in schema.properties &&
      "startFromOrigin" in schema.properties && "type" in schema.properties) {
    const type = schema.properties.type;
    if (typeof type === "object" && type !== null &&
        (("const" in type && type.const === "worktree") ||
         ("enum" in type && Array.isArray(type.enum) && type.enum.includes("worktree")))) return true;
  }
  return Object.values(schema).some(hasWorktreeStrategy);
}

async function discoverTools(rpc: Awaited<ReturnType<typeof connectT3>>) {
  const seen = new Set<string>();
  const tools = new Map<string, unknown>();
  let cursor: string | undefined;
  do {
    const page = await rpc("tools/list", cursor ? { cursor } : {});
    if (typeof page !== "object" || page === null || !("tools" in page) || !Array.isArray(page.tools)) {
      throw new Error("T3 工具目录格式无效。");
    }
    for (const tool of page.tools) if ([launchTool, statusTool, listTool, handoffTool].includes(tool?.name)) tools.set(tool.name, tool.inputSchema);
    cursor = "nextCursor" in page && typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    if (cursor) {
      if (seen.has(cursor) || seen.size >= 9) throw new Error("T3 工具目录未完整读取。");
      seen.add(cursor);
    }
  } while (cursor);
  return tools;
}

function canHandoff(input: unknown) {
  if (typeof input !== "object" || input === null || !("properties" in input)) return false;
  const {properties} = input;
  return typeof properties === "object" && properties !== null &&
    ["branch", "baseRef", "startFromOrigin", "continuationPrompt"].every(name => Object.hasOwn(properties, name));
}

async function callT3<T extends TSchema>(rpc: Awaited<ReturnType<typeof connectT3>>, name: string, args: object, schema: T) {
  const reply = await rpc("tools/call", {name, arguments: args}) as
    {isError?: boolean; structuredContent?: unknown; content?: {type: string; text?: string}[]};
  if (reply.isError) throw new Error("T3 拒绝调用 " + name + "。");
  const content = reply.content?.find(item => item.type === "text")?.text;
  const output: unknown = reply.structuredContent ?? (content ? JSON.parse(content) : undefined);
  if (!Value.Check(schema, output)) throw new Error("T3 回执格式不符合预期 · " + name);
  return output;
}

export function hasT3Context() {
  return Boolean(process.env.T3_MCP_URL || process.env.T3_MCP_BEARER_TOKEN || process.env.T3_PI_RUNTIME_MODE);
}

export function boundT3Worktree(cwd: string, binding: Static<typeof bindingSchema>) {
  if (!binding.attached) return;
  if (!binding.worktreePath || !binding.branch) throw new Error("T3 没有提供完整的工作区绑定。");
  const root = realpathSync(binding.worktreePath);
  const commonDir = (path: string) => realpathSync(git(path, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  if (commonDir(root) !== commonDir(cwd) || commonDir(root) !== commonDir(binding.projectWorkspaceRoot) ||
      git(root, "rev-parse", "--show-toplevel") !== root || git(root, "branch", "--show-current") !== binding.branch) {
    throw new Error("T3 当前线程绑定与本地仓库或分支不一致。");
  }
  return {root, branch: binding.branch};
}

export async function readT3Workspace(cwd: string) {
  if (!hasT3Context()) return;
  const rpc = await connectT3(readT3Endpoint());
  const binding = await callT3(rpc, statusTool, {}, bindingSchema);
  return boundT3Worktree(cwd, binding);
}

export async function inspectT3() {
  const impact = "/taskbook-new 启动独立线程，/taskbook-handoff 迁移当前 T3 线程。普通 Pi 中可在已有 linked worktree 使用 /taskbook。";
  if (!process.env.T3_MCP_URL || !process.env.T3_MCP_BEARER_TOKEN) {
    return { status: "missing", tool: launchTool, worktree: false, handoff: false,
      reason: "当前 Pi 会话缺少 T3 注入的 MCP 上下文。", impact };
  }
  try {
    const rpc = await connectT3(readT3Endpoint());
    const tools = await discoverTools(rpc);
    const worktree = hasWorktreeStrategy(tools.get(launchTool));
    const handoff = tools.has(statusTool) && tools.has(listTool) && canHandoff(tools.get(handoffTool));
    const binding = tools.has(statusTool) ? await callT3(rpc, statusTool, {}, bindingSchema).catch(() => undefined) : undefined;
    return {status: worktree ? "discovered" : tools.has(launchTool) ? "unconfirmed" : "missing", tool: launchTool, worktree,
      handoff, binding, reason: tools.has(launchTool) && !worktree ? "工具已注册，但目录未确认托管 worktree 参数。" : undefined, impact};
  }
  catch { return { status: "unconfirmed", tool: launchTool, worktree: false, handoff: false,
    reason: "无法只读核对 T3 MCP 工具目录。", impact }; }
}

export async function launchT3Thread(args: {
  title: string;
  branch: string;
  base: string;
  message: string;
  clientRequestId: string;
}): Promise<{ threadId: string; link?: string }> {
  const rpc = await connectT3(readT3Endpoint());
  const tools = await discoverTools(rpc);
  if (!hasWorktreeStrategy(tools.get(launchTool))) throw new Error("T3 工具目录未确认 t3_thread_launch 的托管 worktree 能力。");
  const result = await callT3(rpc, launchTool, {
      title: args.title,
      message: args.message,
      clientRequestId: args.clientRequestId,
      workspaceStrategy: { type: "worktree", baseRef: args.base, branch: args.branch, startFromOrigin: false },
  }, Type.Object({threadId: Type.String({minLength: 1}), link: Type.Optional(nullable)}));
  return {threadId: result.threadId, link: result.link ?? undefined};
}

export async function handoffT3Thread(args: {root: string; branch: string; base: string; message: string}) {
  const rpc = await connectT3(readT3Endpoint());
  const tools = await discoverTools(rpc);
  if (!tools.has(statusTool) || !tools.has(listTool) || !canHandoff(tools.get(handoffTool))) {
    throw new Error("T3 当前会话缺少工作区状态、列表或线程迁移能力。");
  }
  const status = await callT3(rpc, statusTool, {}, bindingSchema);
  if (status.attached) {
    if (boundT3Worktree(args.root, status)?.branch !== args.branch) {
      throw new Error("当前 T3 线程已绑定到另一个工作区。请使用与任务匹配的原线程。");
    }
    return {kind: "reused" as const};
  }
  if (realpathSync(status.projectWorkspaceRoot) !== realpathSync(args.root)) throw new Error("T3 项目根目录与任务书仓库不一致。");
  let cursor: number | null = null;
  const seen = new Set<number>();
  do {
    const page = await callT3(rpc, listTool, {query: args.branch, refKind: "local", limit: 200, ...(cursor === null ? {} : {cursor})}, worktreePage);
    const match = page.refs.find(ref => ref.name === args.branch && ref.worktreePath);
    if (match) throw new Error("T3 已有该分支的 worktree · " + match.worktreePath + "。请回到它所属的线程。");
    cursor = page.nextCursor;
    if (cursor !== null && (seen.has(cursor) || seen.size >= 9)) throw new Error("T3 未能完整核对现有工作区。");
    if (cursor !== null) seen.add(cursor);
  } while (cursor !== null);
  const response = await callT3(rpc, handoffTool, {branch: args.branch, baseRef: args.base, startFromOrigin: false,
    continuationPrompt: args.message}, handoffSchema);
  if (response.branch !== args.branch || response.baseRef !== args.base || response.startedFromOrigin || !response.worktreePath) {
    throw new Error("T3 迁移回执与任务书目标工作区不一致。");
  }
  return {kind: "handed-off" as const, ...response};
}

type T3 = { url: URL; token: string };
type RpcResponse = { id?: number; result?: unknown; error?: unknown };

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

async function discoverThreadLaunch(rpc: Awaited<ReturnType<typeof connectT3>>) {
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await rpc("tools/list", cursor ? { cursor } : {});
    if (typeof page !== "object" || page === null || !("tools" in page) || !Array.isArray(page.tools)) {
      throw new Error("T3 工具目录格式无效。");
    }
    const tool = page.tools.find(tool => tool?.name === "t3_thread_launch");
    if (tool) {
      const worktree = hasWorktreeStrategy(tool.inputSchema);
      return { status: worktree ? "discovered" : "unconfirmed", tool: "t3_thread_launch", worktree,
        reason: worktree ? undefined : "工具已注册，但目录未确认托管 worktree 参数。" };
    }
    cursor = "nextCursor" in page && typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    if (cursor) {
      if (seen.has(cursor) || seen.size >= 9) throw new Error("T3 工具目录未完整读取。");
      seen.add(cursor);
    }
  } while (cursor);
  return { status: "missing", tool: "t3_thread_launch", worktree: false };
}

export async function inspectT3() {
  const impact = "/taskbook-new 需要 T3 的托管 worktree 能力。已有 worktree 上的 /taskbook 可独立运行。";
  if (!process.env.T3_MCP_URL || !process.env.T3_MCP_BEARER_TOKEN) {
    return { status: "missing", tool: "t3_thread_launch", worktree: false,
      reason: "当前 Pi 会话缺少 T3 注入的 MCP 上下文。", impact };
  }
  try { return { ...await discoverThreadLaunch(await connectT3(readT3Endpoint())), impact }; }
  catch { return { status: "unconfirmed", tool: "t3_thread_launch", worktree: false,
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
  if (!(await discoverThreadLaunch(rpc)).worktree) throw new Error("T3 工具目录未确认 t3_thread_launch 的托管 worktree 能力。");
  const reply = await rpc("tools/call", {
    name: "t3_thread_launch",
    arguments: {
      title: args.title,
      message: args.message,
      clientRequestId: args.clientRequestId,
      workspaceStrategy: { type: "worktree", baseRef: args.base, branch: args.branch, startFromOrigin: false },
    },
  }) as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
  if (reply.isError) throw new Error("T3 拒绝启动新 thread。");
  const content = reply.content?.find(item => item.type === "text")?.text;
  const result = (reply.structuredContent ?? (content ? JSON.parse(content) : undefined)) as
    { threadId?: unknown; link?: unknown } | undefined;
  if (typeof result?.threadId !== "string" || !result.threadId) throw new Error("T3 未返回新 thread 的标识。");
  return { threadId: result.threadId, link: typeof result.link === "string" ? result.link : undefined };
}

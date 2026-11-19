type T3 = { url: URL; token: string };
type RpcResponse = { id?: number; result?: unknown; error?: unknown };

export function readT3Endpoint(): T3 {
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

export async function launchT3Thread(t3: T3, args: {
  title: string;
  branch: string;
  worktreePath: string;
  message: string;
  clientRequestId: string;
}): Promise<{ threadId: string; link?: string }> {
  let session: string | null = null;
  let protocol = "2025-06-18";
  async function rpc(method: string, params: Record<string, unknown> | undefined, id?: number) {
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
      signal: AbortSignal.timeout(25_000),
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
  }, 1) as { protocolVersion?: string };
  if (initialized.protocolVersion) protocol = initialized.protocolVersion;
  await rpc("notifications/initialized", undefined);
  const reply = await rpc("tools/call", {
    name: "t3_thread_launch",
    arguments: {
      title: args.title,
      message: args.message,
      clientRequestId: args.clientRequestId,
      workspaceStrategy: { type: "existing_worktree", worktreePath: args.worktreePath, branch: args.branch },
    },
  }, 2) as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
  if (reply.isError) throw new Error("T3 拒绝启动新 thread。");
  const content = reply.content?.find(item => item.type === "text")?.text;
  const result = (reply.structuredContent ?? (content ? JSON.parse(content) : undefined)) as
    { threadId?: unknown; link?: unknown } | undefined;
  if (typeof result?.threadId !== "string" || !result.threadId) throw new Error("T3 未返回新 thread 的标识。");
  return { threadId: result.threadId, link: typeof result.link === "string" ? result.link : undefined };
}

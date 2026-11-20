import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function probeSubagents(pi: ExtensionAPI) {
  const requestId = randomUUID();
  let result: { responding: boolean; protocol?: number } = { responding: false };
  const offPing = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, reply => {
    if (typeof reply !== "object" || reply === null || !("success" in reply) || reply.success !== true) return;
    const data = "data" in reply ? reply.data : undefined;
    const protocol = typeof data === "object" && data !== null && "version" in data &&
      typeof data.version === "number" ? data.version : undefined;
    result = { responding: true, protocol };
  });
  try {
    pi.events.emit("subagents:rpc:ping", {requestId});
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    offPing();
  }
  return result;
}

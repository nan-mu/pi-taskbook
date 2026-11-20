import { probeSubagents } from "./subagent-probe.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

type Model = NonNullable<ExtensionContext["model"]>;
type Dispatch = {
  system: string;
  model: Model;
  tool: ToolDefinition;
  controller: AbortController;
  sessionId?: string;
  failure?: string;
};
const key = Symbol.for("pi-taskbook.reviewer-dispatch");
const shared = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<Dispatch> };
export const reviewDispatch = shared[key] ??= new AsyncLocalStorage<Dispatch>();
const type = "pi-taskbook-snapshot-review";

export async function dispatchReview(pi: ExtensionAPI, ctx: ExtensionContext, dispatch: Omit<Dispatch, "controller">,
  packet: string, signal?: AbortSignal) {
  if (!(await probeSubagents(pi)).responding) return;

  signal?.throwIfAborted();
  const controller = new AbortController();
  const scope: Dispatch = {...dispatch, controller};
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, {once: true});
  const requestId = randomUUID();
  let agentId: string | undefined;
  const listeners: (() => void)[] = [];
  const timeout = setTimeout(() => controller.abort(new Error("子代理审核超时。")), 10 * 60_000);
  try {
    const result = await new Promise<{text: string; agentId: string; sessionId: string}>((resolve, reject) => {
      const cancel = () => reject(new Error(scope.failure ?? String(controller.signal.reason)));
      controller.signal.addEventListener("abort", cancel, {once: true});
      listeners.push(() => controller.signal.removeEventListener("abort", cancel));
      for (const status of ["completed", "failed"] as const) {
        listeners.push(pi.events.on(`subagents:${status}`, payload => {
          const event = payload as {id: string; type: string; result?: string; error?: string};
          if (event.id !== agentId) return;
          pi.events.emit("subagents:rpc:consume", {requestId: randomUUID(), agentId});
          if (status === "failed" || scope.failure || event.type !== type || !scope.sessionId || !event.result?.trim()) {
            return reject(new Error(scope.failure ?? event.error ?? "子代理未返回绑定到本次派发的审核报告。"));
          }
          resolve({text: event.result, agentId: event.id, sessionId: scope.sessionId});
        }));
      }
      listeners.push(pi.events.on(`subagents:rpc:spawn:reply:${requestId}`, payload => {
        const reply = payload as {success: boolean; error?: string; data?: {id: string}};
        if (!reply.success || !reply.data?.id) return reject(new Error(reply.error ?? "子代理派发失败。"));
        agentId = reply.data.id;
      }));
      reviewDispatch.run(scope, () => pi.events.emit("subagents:rpc:spawn", {
        requestId, type, prompt: packet,
        options: {description: "Taskbook 固定提交取证", model: dispatch.model, thinkingLevel: ctx.thinkingLevel,
          inheritContext: false, isolated: false, isBackground: false, signal: controller.signal},
      }));
    });
    return result;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    listeners.forEach(unsubscribe => unsubscribe());
    controller.abort();
  }
}

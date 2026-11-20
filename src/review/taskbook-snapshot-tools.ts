import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reviewDispatch } from "./subagent-dispatch.ts";

export default function snapshotTools(pi: ExtensionAPI) {
  const dispatch = reviewDispatch.getStore();
  if (!dispatch) return;
  pi.registerTool({...dispatch.tool, defaultActive: false});
  pi.on("before_agent_start", (_event, ctx) => {
    const tools = pi.getActiveTools();
    const model = ctx.model;
    if (tools.length !== 1 || tools[0] !== dispatch.tool.name || model?.provider !== dispatch.model.provider ||
        model.id !== dispatch.model.id || ctx.thinkingLevel !== dispatch.thinkingLevel) {
      dispatch.failure = "子代理的实际工具、模型或推理档位与 Taskbook 派发不一致。";
      dispatch.controller.abort();
    } else {
      dispatch.sessionId = ctx.sessionManager.getSessionId();
    }
    return {systemPrompt: dispatch.system};
  });
  pi.on("tool_call", event => {
    if (!dispatch.sessionId || dispatch.controller.signal.aborted || event.toolName !== dispatch.tool.name) {
      return {block: true, reason: "该工具不属于本次 Taskbook 取证。"};
    }
  });
}

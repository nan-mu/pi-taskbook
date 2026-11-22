import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const helpType = "pi-taskbook-help";
const guide = [
  "Pi Taskbook 根据任务书核查事实、安排设计和实施、审核候选提交，再通过 PR 交付。",
  "/taskbook <任务书路径或 Markdown 正文> 在当前会话执行。未绑定工作树时，T3 按任务书的基线和 Work branch 迁移当前会话。/taskbook-new 使用新的 T3 会话。",
  "/taskbook-setup 查看当前 Pi 的就绪情况，可继续配置角色模型或迁移旧审计资料。",
  "主会话核查任务前提，并通过 taskbook_query_facts 查找已有事实。三名设计者比较方案，组长签署计划。实施者按签署的计划工作并取证。审核者检查同一候选提交，组长签署后插件登记审核通过的事实。",
  "设计缺口交给设计者，涉及用户决定或事实冲突时在当前会话直接回复。中断后再次执行 /taskbook 会开始一轮新任务。",
  "本地签署后，插件推送任务分支并通过 Magpie GitHub MCP 创建或复用 PR。收到 PR 链接后即可审阅，由你决定是否合并。",
  "用 /taskbook-help <问题> 询问具体步骤，用 /taskbook-help status 查看当前状态。",
].join("\n\n");

export function registerHelpCommand(pi: ExtensionAPI, status: (ctx: ExtensionContext) => string,
  busy: (ctx: ExtensionContext) => boolean) {
  let request: {token: string; active: boolean} | undefined;

  pi.registerCommand("taskbook-help", {
    description: "了解 Pi Taskbook 的用法、当前阶段和下一步",
    async handler(args, ctx) {
      const current = status(ctx);
      const question = args.trim();
      if (question === "status" || question === "状态") {
        ctx.ui.notify(current, "info");
        return;
      }
      if (!question || busy(ctx) || !ctx.model || request) {
        ctx.ui.notify(current + "\n\n" + guide, "info");
        return;
      }
      const token = randomUUID();
      request = {token, active: false};
      pi.sendMessage({customType: helpType, details: token, display: false,
        content: JSON.stringify({status: current, question})}, {triggerTurn: true});
    },
  });

  pi.on("before_agent_start", event => {
    if (!request || event.messageType !== "custom" || event.message.customType !== helpType ||
        event.message.details !== request.token) return;
    request.active = true;
    return {systemPrompt: [
      "You are the Pi Taskbook help agent. Answer the specific question in the user's language using the guide and the live status supplied for this turn.",
      "Explain what the current stage is deciding and who acts next when that helps. Give one applicable command or reply when useful. Report only the state the plugin supplied.",
      "Give guidance in chat. Leave the workflow, configuration, worktree and PR untouched. End the turn after answering.",
      guide,
    ].join("\n\n")};
  });
  pi.on("context", event => {
    const help = request;
    if (!help?.active) return;
    const index = event.messages.findLastIndex(message => message.role === "custom" &&
      message.customType === helpType && message.details === help.token);
    if (index >= 0) return {messages: event.messages.slice(index)};
  });
  pi.on("tool_call", () => {
    if (request?.active) return {block: true, reason: "/taskbook-help 只提供用法和状态。"};
  });
  pi.on("agent_settled", () => { request = undefined; });
}

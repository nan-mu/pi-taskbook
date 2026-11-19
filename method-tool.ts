import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readStageMethod, workerMethodStages } from "./method-catalog.ts";
import type { Phase } from "./workflow.ts";

export const methodTool = "taskbook_method";

export function registerMethodTool(pi: ExtensionAPI, currentPhase: () => Phase | undefined) {
  pi.registerTool({
    name: methodTool, label: "读取本阶段方法", defaultActive: false,
    description: "按当前阶段的方法目录读取一项通用提示词及其上游出处。",
    parameters: Type.Object({ name: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_id, { name }) {
      const phase = currentPhase();
      if (!phase) throw new Error("当前没有可以读取方法的执行阶段。");
      const method = readStageMethod(name, workerMethodStages(phase), phase);
      return { content: [{ type: "text", text: method.source + "\n\n" + method.text }], details: { name, source: method.source } };
    },
  });
}

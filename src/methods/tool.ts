import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { methodDirectory, readStageMethod, workerMethodStages } from "./catalog.ts";
import { phaseSources } from "./upstream.ts";
import type { Phase } from "../workflow/transitions.ts";
import type { Taskbook } from "../taskbook/document.ts";

export const methodTool = "taskbook_method";

export function registerMethodTool(pi: ExtensionAPI, current: () => {phase: Phase; type: Taskbook["type"]} | undefined) {
  pi.registerTool(methodDefinition(current));
}

const methodParameters = Type.Object({ name: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });

export function methodDefinition(current: () => {phase: Phase; type: Taskbook["type"]} | undefined): ToolDefinition<typeof methodParameters> {
  return {
    name: methodTool, label: "读取本阶段方法", defaultActive: false,
    description: "Read a method and its source by name. Omit name for the recommended methods for this stage and task type.",
    parameters: methodParameters,
    async execute(_id: string, { name }: {name?: string}) {
      const active = current();
      if (!active) throw new Error("当前没有可以读取方法的执行阶段。");
      const {phase, type} = active;
      const stages = workerMethodStages(phase, type);
      if (name === undefined) {
        return {content: [{type: "text", text: methodDirectory(stages, phaseSources(phase, type))}], details: {phase}};
      }
      const method = readStageMethod(name, stages, phase);
      return { content: [{ type: "text" as const, text: method.source + "\n\n" + method.text }], details: { name, source: method.source } };
    },
  };
}

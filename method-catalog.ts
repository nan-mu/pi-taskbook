import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Phase } from "./workflow.ts";

export type MethodStage = "intake" | "fact" | "design" | "experiment" | "implement" | "escalate" | "review" | "memory" | "exit";
export type CatalogOwner = "pstack" | "matt";
export type CatalogPin = { commit: string; digest: string };
type Entry = {
  roleAdaptations?: Partial<Record<Phase, string>>;
  name: string; path: string; stage: MethodStage[]; kind: "workflow" | "method" | "mixed";
  status: "integrated" | "partial" | "excluded"; applies?: string; reason: string; adaptation: string;
};
type Source = { repo: string; commit: string; skills: Entry[] };

function loadCatalog(owner: CatalogOwner) {
  const bytes = readFileSync(new URL("./methods/" + owner + ".json", import.meta.url));
  const catalog: Source = JSON.parse(bytes.toString("utf8"));
  const pin: CatalogPin = { commit: catalog.commit, digest: createHash("sha256").update(bytes).digest("hex") };
  return {
    pin,
    methods: catalog.skills.map(entry => ({ ...entry, owner, id: owner + ":" + entry.name, commit: pin.commit })),
  };
}
const catalogs = { pstack: loadCatalog("pstack"), matt: loadCatalog("matt") };
const methods = [...catalogs.pstack.methods, ...catalogs.matt.methods];

export function catalogPins() {
  return { pstack: { ...catalogs.pstack.pin }, matt: { ...catalogs.matt.pin } };
}

export function phaseMethod(id: string, phase: Phase) {
  const entry = methods.find(item => item.id === id);
  if (!entry || entry.kind === "workflow" || entry.status === "excluded") {
    throw new Error("阶段引用了没有通用方法的条目：" + id);
  }
  const roleText = entry.roleAdaptations?.[phase];
  const review = phase === "correctness" || phase === "quality" || phase === "fact-review";
  if (review && !roleText) throw new Error("独立审核缺少角色专用提示词：" + id + " / " + phase);
  const text = roleText ?? entry.adaptation;
  if (!text.trim()) throw new Error("方法正文为空：" + id);
  return { source: entry.owner + "@" + entry.commit + ":" + entry.path,
    text: "通用方法 " + id + "\n" + text };
}

export function workerMethodStages(phase: Phase): MethodStage[] {
  switch (phase) {
    case "fact-check": return ["intake", "fact", "memory"];
    case "design": return ["design", "experiment", "escalate"];
    case "implement": return ["implement", "exit"];
    case "performance": return ["experiment"];
    default: return [];
  }
}
function available(stages: MethodStage[]) {
  return methods.filter(item => item.kind !== "workflow" && item.status !== "excluded" &&
    item.stage.some(stage => stages.includes(stage)) && item.adaptation.trim());
}
function describe(entry: typeof methods[number]) {
  return entry.id + " · " + (entry.applies || entry.reason);
}
export function methodDirectory(stages: MethodStage[]) {
  return "按本轮问题选用下列方法。需要具体步骤时调用 taskbook_method，name 填完整标识。\n" +
    available(stages).map(describe).join("\n");
}
export function readStageMethod(name: string, stages: MethodStage[], phase?: Phase) {
  const entry = available(stages).find(item => item.id === name);
  if (!entry) throw new Error("当前阶段没有这个可调用的方法：" + name);
  return { source: entry.owner + "@" + entry.commit + ":" + entry.path,
    text: (phase && entry.roleAdaptations?.[phase]) || entry.adaptation };
}

import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const planParameter = Type.Object({
  steps: Type.Array(Type.Object({
    id: Type.String({minLength: 1}), action: Type.String({minLength: 1}),
    checks: Type.String({minLength: 1}),
    targets: Type.Array(Type.String({minLength: 1}), {minItems: 1}),
  }, {additionalProperties: false}), {minItems: 1}),
}, {additionalProperties: false});

export type PlanStep = { id: string; action: string; checks: string; targets: string[] };
export type ExecutionPlan = { version: number; steps: PlanStep[] };
export type PlanGap = { stepId: string; observation: string; question: string };
export type ModelRoutes = { initial: string; design: string; implement: string; review: string;
  factReview?: string; correctness?: string; quality?: string };
export function modelKey(model: NonNullable<ExtensionContext["model"]>) {
  return model.provider + "/" + model.id;
}

export function modelRoutes(ctx: ExtensionContext): ModelRoutes {
  if (!ctx.model) throw new Error("任务需要已选定的 Pi 模型。");
  const initial = modelKey(ctx.model);
  return {
    initial, design: process.env.PI_TASKBOOK_DESIGN_MODEL || initial,
    implement: process.env.PI_TASKBOOK_IMPLEMENT_MODEL || initial,
    review: process.env.PI_TASKBOOK_REVIEW_MODEL || initial,
    factReview: process.env.PI_TASKBOOK_FACT_REVIEW_MODEL || undefined,
    correctness: process.env.PI_TASKBOOK_CORRECTNESS_MODEL || undefined,
    quality: process.env.PI_TASKBOOK_QUALITY_MODEL || undefined,
  };
}

export function resolveModel(ctx: ExtensionContext, key: string) {
  if (ctx.model && modelKey(ctx.model) === key) return ctx.model;
  const separator = key.indexOf("/");
  const model = separator > 0 ? ctx.modelRegistry.find(key.slice(0, separator), key.slice(separator + 1)) : undefined;
  if (!model) throw new Error("找不到配置的 Pi 角色模型 " + key + "。请核对 provider/model-id。");
  return model;
}

export function reviewerModel(routes: ModelRoutes, phase: "fact-review" | "correctness" | "quality") {
  return routes[phase === "fact-review" ? "factReview" : phase] ?? routes.review;
}

export function acceptPlan(steps: PlanStep[], targets: string[], previousVersion = 0): ExecutionPlan {
  const ids = new Set<string>();
  const covered = new Set<string>();
  for (const step of steps) {
    if (!step.id.trim() || step.id.trim() !== step.id || ids.has(step.id) || !step.action.trim() || !step.checks.trim()) {
      throw new Error("计划步骤需要唯一 ID、实施范围和可观察验收。");
    }
    if (!step.targets.length) throw new Error("每个步骤至少需要一个目标或交付项。");
    ids.add(step.id);
    for (const target of step.targets) {
      if (!targets.includes(target)) throw new Error("未知计划目标 " + target);
      covered.add(target);
    }
  }
  const missing = targets.filter(target => !covered.has(target));
  if (missing.length) throw new Error("计划未覆盖目标或交付项 " + missing.join(", "));
  return { version: previousVersion + 1, steps };
}

/** The experiment owns a disposable checkout. This is workspace isolation,
 * not a host security boundary. The command retains the caller's OS rights. */
export async function runProbe(root: string, revision: string, argv: string[], signal?: AbortSignal) {
  if (!argv.length || !argv[0].trim()) throw new Error("实验需要可执行命令。");
  const temporary = await mkdtemp(join(tmpdir(), "pi-taskbook-probe-"));
  const work = join(temporary, "work");
  try {
    signal?.throwIfAborted();
    execFileSync("git", ["clone", "--quiet", "--local", "--no-hardlinks", "--no-checkout", "--", root, work], {stdio: "pipe"});
    execFileSync("git", ["-C", work, "checkout", "--quiet", "--detach", revision], {stdio: "pipe"});
    execFileSync("git", ["-C", work, "remote", "remove", "origin"], {stdio: "pipe"});
    const observed = await new Promise<{exitCode: number; stdout: string; stderr: string}>((resolve, reject) => {
      execFile(argv[0], argv.slice(1), {cwd: work, encoding: "utf8", timeout: 60000, maxBuffer: 512 * 1024,
        killSignal: "SIGKILL", signal}, (error, stdout, stderr) => {
          if (error && (typeof error.code !== "number" || error.killed || error.signal)) return reject(error);
          resolve({exitCode: typeof error?.code === "number" ? error.code : 0, stdout: stdout.slice(-12000), stderr: stderr.slice(-12000)});
        });
    });
    return {revision, argv, ...observed};
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

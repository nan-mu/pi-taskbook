import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { git, type Taskbook } from "./taskbook.ts";
import type { Phase } from "./workflow.ts";

type Repository = "pstack" | "matt";
type Pin = { root: string; commit: string };
export type UpstreamPins = Record<Repository, Pin>;
type Input = { repository: Repository; path: string; from?: string; until?: string };

export function pinUpstreamInputs(): UpstreamPins {
  const pstack = process.env.PI_TASKBOOK_PSTACK_ROOT;
  const matt = process.env.PI_TASKBOOK_MATT_ROOT;
  if (!pstack || !matt || !isAbsolute(pstack) || !isAbsolute(matt)) {
    throw new Error("请设置 PI_TASKBOOK_PSTACK_ROOT 和 PI_TASKBOOK_MATT_ROOT 为两个必需上游仓库的绝对路径。");
  }
  function pin(path: string) {
    const root = realpathSync(path);
    return { root, commit: git(root, "rev-parse", "HEAD^{commit}") };
  }
  return { pstack: pin(pstack), matt: pin(matt) };
}

function pstack(name: string): Input {
  return { repository: "pstack", path: `pstack/skills/${name}/SKILL.md` };
}

function matt(name: string, from?: string, until?: string, file = "SKILL.md"): Input {
  return { repository: "matt", path: `skills/engineering/${name}/${file}`, from, until };
}

export function phaseSources(phase: Phase, type: Taskbook["type"]): Input[] {
  switch (phase) {
    case "fact-review":
      return [pstack("principle-prove-it-works"), matt("research", "1. Investigate the question against", "2. Write the findings")];
    case "fact-check": {
      const sources = [
        pstack("principle-prove-it-works"),
        matt("research", "1. Investigate the question against", "2. Write the findings"),
      ];
      if (type.startsWith("fix-")) sources.push(matt("diagnosing-bugs", "## Redact", "## Phase 3:"));
      return sources;
    }
    case "design":
      return [pstack("principle-model-the-domain"), matt("codebase-design")];
    case "implement": {
      const standard = pstack("principle-sequence-verifiable-units");
      if (type.startsWith("fix-")) return [standard, matt("diagnosing-bugs", "## Phase 3:")];
      if (type === "new-experiment") return [standard, pstack("benchmark-checklist")];
      return [standard, matt("tdd"), matt("tdd", undefined, undefined, "tests.md"), matt("tdd", undefined, undefined, "mocking.md")];
    }
    case "correctness":
      return [pstack("principle-prove-it-works"),
        matt("code-review", "Spec sub-agent prompt should include:", "### 5.")];
    case "quality":
      return [pstack("principle-minimize-reader-load"),
        matt("code-review", "### 3. Identify the standards sources", "### 4."),
        matt("code-review", "Standards sub-agent prompt should include:", "Spec sub-agent prompt should include:")];
    case "performance":
      return [pstack("benchmark-checklist")];
  }
}

export function loadUpstreamInputs(pins: UpstreamPins | undefined, phase: Phase, type: Taskbook["type"]) {
  if (!pins) throw new Error("任务缺少必需的固定上游版本。");
  return phaseSources(phase, type).map(input => {
    const pin = pins[input.repository];
    const source = input.repository + "@" + pin.commit + ":" + input.path;
    let markdown: string;
    try {
      markdown = execFileSync("git", ["show", pin.commit + ":" + input.path],
        { cwd: pin.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      throw new Error("无法读取必需的上游提示词：" + source);
    }
    const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const headings = lines.map(line => line.replaceAll("**", ""));
    const start = input.from ? headings.findIndex(line => line.startsWith(input.from!)) : 0;
    const end = input.until ? headings.findIndex((line, index) => index > start && line.startsWith(input.until!)) : lines.length;
    if (start < 0 || end <= start) throw new Error("必需上游原文章节缺失：" + source + "（" + (input.from ?? "文件开头") + "）");
    const text = lines.slice(start, end).join("");
    if (!text.trim()) throw new Error("必需的上游提示词为空：" + source);
    return { source, text };
  });
}

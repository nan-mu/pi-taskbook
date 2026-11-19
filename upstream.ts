import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { git, type Taskbook } from "./taskbook.ts";
import type { Phase } from "./workflow.ts";

type Repository = "pstack" | "matt";
type Pin = { root: string; commit: string };
export type UpstreamPins = Record<Repository, Pin>;
type Input = { repository: Repository; path: string; from?: string; until?: string };

export function pinUpstreamInputs(): UpstreamPins | undefined {
  const pstack = process.env.PI_TASKBOOK_PSTACK_ROOT;
  const matt = process.env.PI_TASKBOOK_MATT_ROOT;
  if (!pstack && !matt) return;
  if (!pstack || !matt || !isAbsolute(pstack) || !isAbsolute(matt)) {
    throw new Error("启用上游原文时需要同时提供两个仓库的绝对路径。");
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
    case "confirm-premises":
      return [pstack("principle-prove-it-works")];
    case "reproduce-defect":
      return [pstack("principle-prove-it-works"), matt("diagnosing-bugs", "## Phase 1:", "## Phase 3:")];
    case "design":
      return [pstack("principle-model-the-domain"), matt("codebase-design")];
    case "implement-new":
      return [pstack("principle-sequence-verifiable-units"), ...(type === "new-experiment"
        ? [pstack("benchmark-checklist")]
        : [matt("tdd"), matt("tdd", undefined, undefined, "tests.md"), matt("tdd", undefined, undefined, "mocking.md")])];
    case "implement-fix":
      return [pstack("principle-sequence-verifiable-units"), matt("diagnosing-bugs", "## Phase 3:")];
    case "correctness":
      return [pstack("principle-prove-it-works"),
        matt("code-review", "Spec sub-agent prompt should include:", "### 5.")];
    case "quality":
      return [pstack("principle-minimize-reader-load"),
        matt("code-review", "Standards sub-agent prompt should include:", "Spec sub-agent prompt should include:")];
    case "performance":
      return [pstack("benchmark-checklist")];
  }
}

export function loadUpstreamInputs(pins: UpstreamPins | undefined, phase: Phase, type: Taskbook["type"]) {
  if (!pins) return [];
  return phaseSources(phase, type).map(input => {
    const pin = pins[input.repository];
    const markdown = execFileSync("git", ["show", pin.commit + ":" + input.path],
      { cwd: pin.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const start = input.from ? lines.findIndex(line => line.startsWith(input.from!)) : 0;
    const end = input.until ? lines.findIndex((line, index) => index > start && line.startsWith(input.until!)) : lines.length;
    if (start < 0 || end <= start) throw new Error("上游原文章节边界已变化：" + input.path);
    return { source: input.repository + "@" + pin.commit + ":" + input.path, text: lines.slice(start, end).join("") };
  });
}

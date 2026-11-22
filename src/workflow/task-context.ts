import type { Taskbook } from "../taskbook/document.ts";

export type TaskItem = { id: string; text: string; operation?: import("../facts/taskbook-intake.ts").FactOperation; userDecision?: FactDecision; topicFact?: {path: string; id: string} };
export type FactConflict = { factId: string; observation: string; projectVersion?: number; projectHead?: string | null };
export type FactDecision = { factId: string; action: "keep" | "replace"; text: string };

function linesOutsideFences(markdown: string) {
  let fence = "";
  return markdown.replace(/\r\n/g, "\n").split("\n").map(text => {
    const delimiter = text.match(/^\s*(`{3,}|~{3,})(.*)$/);
    const structural = !fence && !delimiter;
    if (delimiter && !fence) fence = delimiter[1];
    else if (delimiter && delimiter[1].startsWith(fence) && !delimiter[2].trim()) fence = "";
    return { text, structural };
  });
}

function section(markdown: string, heading: string): string | undefined {
  const lines = linesOutsideFences(markdown);
  const start = lines.findIndex(line => line.structural && line.text.trimEnd() === "## " + heading);
  if (start === -1) return;
  let end = start + 1;
  while (end < lines.length && !(lines[end].structural && /^##\s+/.test(lines[end].text))) end++;
  return lines.slice(start + 1, end).map(line => line.text).join("\n").trim();
}

function items(markdown: string, prefix: string): TaskItem[] {
  const output: TaskItem[] = [];
  let current: string[] = [];
  let number = "";
  let counter = 0;
  const used = new Set<string>();
  function flush() {
    const text = current.join("\n").trim();
    if (!text) return;
    // A preamble is retained separately, so authored /fact(N) numbering stays intact.
    let id = prefix + (number || "intro");
    // Repeated "1." markers are normal Markdown ordered lists.
    if (used.has(id)) id = prefix + counter;
    while (used.has(id)) id = prefix + ++counter;
    used.add(id);
    output.push({ id, text });
  }
  for (const line of linesOutsideFences(markdown)) {
    const marker = line.structural && line.text.match(/^(?:(\d+)[.)]|[-*+])\s+(.*)$/);
    if (marker) {
      flush();
      counter++;
      number = marker[1] ?? String(counter);
      current = [marker[2]];
    } else {
      current.push(line.text);
    }
  }
  flush();
  if (output.length === 1 && output[0].id === prefix + "intro") output[0].id = prefix + "1";
  return output;
}

export function taskAuthoredFacts(markdown: string) {
  return items(section(markdown, "Facts") ?? "", "F");
}

export function taskMemory(task: Pick<Taskbook, "markdown" | "facts">, decisions: FactDecision[] = []) {
  const goal = (section(task.markdown, "Goal") ?? "").replace(/^(?:Type:\s*|\*\*Type:?\*\*:?\s+)[^\n]*\n?/, "");
  const goals = items(goal, "G");
  const delivery = items(section(task.markdown, "Delivery") ?? "", "D");
  if (!goals.length || !delivery.length) throw new Error("Goal 和 Delivery 需要可审核的正文。");
  const facts = taskAuthoredFacts(task.markdown);
  if (task.facts) facts.push(...items(section(task.facts, "Facts") ?? task.facts, facts.length ? "AF" : "F"));
  for (const decision of decisions) {
    const fact = facts.find(fact => fact.id === decision.factId);
    if (!fact) throw new Error("用户事实决策引用了当前记忆中不存在的标识 " + decision.factId);
    if (decision.action === "replace") fact.text = decision.text;
    fact.userDecision = { ...decision };
  }
  return { goals, facts, delivery };
}

export function parseFactDecision(argument: string, conflict: FactConflict): FactDecision {
  const match = argument.trim().match(/^(\S+)\s+(keep|replace)\s+([\s\S]+)$/);
  if (!match || match[1] !== conflict.factId || !match[3].trim()) {
    throw new Error("请针对 " + conflict.factId + " 给出 keep 和保留理由，或 replace 和完整的新事实。");
  }
  return { factId: match[1], action: match[2] as FactDecision["action"], text: match[3].trim() };
}

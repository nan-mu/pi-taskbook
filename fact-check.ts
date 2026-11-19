import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { Type, type Static } from "typebox";

const text = Type.String({ minLength: 1, maxLength: 1200 });
const gitSource = Type.Object({
  kind: Type.Literal("git"),
  path: text,
  line: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
const toolSource = Type.Object({
  kind: Type.Literal("tool"),
  receipt: text,
}, { additionalProperties: false });

export const factChecksParameter = Type.Array(Type.Object({
  claim: text,
  observed: text,
  source: Type.Union([gitSource, toolSource]),
}, { additionalProperties: false }), { minItems: 1, maxItems: 20 });

type FactCheck = Static<typeof factChecksParameter>[number];
export type Observation = { toolName: string; toolCallId: string; isError: boolean; text: string[] };
export type CheckedFact = FactCheck & { origin: string; toolError?: boolean };

export function checkFacts(root: string, base: string, checks: FactCheck[], receipts: Map<string, Observation>): CheckedFact[] {
  return checks.map(check => {
    const { source, observed } = check;
    if (!check.claim.trim() || !observed.trim()) throw new Error("请给出核查的主张和非空原始摘录。");
    if (source.kind === "tool") {
      const result = receipts.get(source.receipt);
      if (!result) throw new Error("工具回执不属于本次事实核查。");
      if (!result.text.some(text => text.includes(observed))) throw new Error("摘录与工具返回的文本不符。");
      return { ...check, origin: result.toolName + " " + result.toolCallId, toolError: result.isError };
    }
    const path = source.path;
    if (posix.isAbsolute(path) || posix.normalize(path) !== path || path.startsWith("../") || path === "..") {
      throw new Error("基线证据需要仓库内的相对文件路径。");
    }
    const blob = execFileSync("git", ["cat-file", "blob", base + ":" + path], {
      cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\r\n/g, "\n");
    const lines = blob.split("\n");
    const quote = observed.replace(/\r\n/g, "\n");
    const length = quote.split("\n").length;
    const excerpt = lines.slice(source.line - 1, source.line - 1 + length).join("\n");
    if (!excerpt.includes(quote)) throw new Error("摘录与基线文件指定行的内容不符。");
    return { ...check, origin: base + ":" + path + ":" + source.line };
  });
}

import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Inspection } from "../../review/reviewer.ts";

const replySchema = Type.Object({
  kind: Type.String(),
  draftFacts: Type.Optional(Type.Array(Type.Object({id: Type.String()}))),
  evidence: Type.Optional(Type.Array(Type.String())),
  findings: Type.Optional(Type.Array(Type.Object({evidence: Type.Array(Type.String()), factId: Type.Optional(Type.String())}))),
});

type Sources = {observations: readonly Inspection[]; lookedUp: ReadonlySet<string>; drafts: readonly string[]; facts: ReadonlySet<string>};

export function readReviewSubmission(input: unknown) {
  if (!Value.Check(replySchema, input)) throw new Error("审核结果格式无效。");
  return input;
}

export function validateReviewSubmission(work: string, result: unknown, {observations, lookedUp, drafts, facts}: Sources) {
  const input = readReviewSubmission(result);
  const fresh = /^(initial|cross)-/u.test(work);
  const problems: string[] = [];
  if (fresh) {
    const cited = new Set([...(input.evidence ?? []), ...(input.findings ?? []).flatMap(item => item.evidence)]);
    const receipts = observations.filter(item => (item.view === "candidate" || item.view === "diff") && item.characters > 0);
    if (!receipts.some(item => cited.has(item.id))) {
      problems.push(receipts.length
        ? "请在 evidence 数组中填写本轮有效的回执 ID（如 " + receipts[0].id + "）。直接填写 ID，解释放在 summary 或 detail。"
        : "请先用 inspect_revision 的 candidate 或 diff 读取有内容的候审文件，再把返回的 Observation ID 填入 evidence。");
    }
  }
  if (fresh || input.kind === "approve") {
    const missing = drafts.filter(id => !lookedUp.has(id));
    if (missing.length) problems.push("请用 taskbook_query_facts 查询这些 Draft Facts：" + missing.join("、") + "。");
  }
  if (fresh || input.draftFacts !== undefined) {
    const decisions = input.draftFacts ?? [];
    const reviewed = new Set(decisions.map(item => item.id));
    const missing = drafts.filter(id => !reviewed.has(id));
    if (missing.length || decisions.length !== drafts.length || reviewed.size !== decisions.length) {
      problems.push(missing.length ? "请为这些 Draft Facts 补上 keep/drop 决定：" + missing.join("、") + "。" :
        "请为当前提交的每条 Draft Fact 提供恰好一项 keep/drop 决定。");
    }
  }
  const unknownFacts = (input.findings ?? []).flatMap(({factId}) =>
    factId && !facts.has(factId) && !lookedUp.has(factId) && !drafts.includes(factId) ? [factId] : []);
  if (unknownFacts.length) problems.push("请查询这些事实 ID 的依据并修正引用：" + [...new Set(unknownFacts)].join("、") + "。");
  if (problems.length) throw new Error(problems.join("\n"));
}

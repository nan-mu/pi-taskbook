import { Type, type Static } from "typebox";
import { posix } from "node:path";
import { commitFactFiles, readFactFile } from "../facts/commit-files.ts";
import { readTopicFacts } from "../facts/taskbook-intake.ts";
import { modelSettingsPath, projectModelPolicy, projectModelsFile } from "../models/storage.ts";
import { decodeTsv, encodeTsv } from "../facts/tsv.ts";
import { git } from "../taskbook/document.ts";
import { cleanRevision, type Run } from "./checkpoint.ts";

const placement = Type.Object({
  id: Type.String({pattern: "^draft:[a-f0-9]{20}$"}),
  path: Type.String({pattern: "^\\.fact/(?:[^/\\\\\\x00-\\x1f]+/)*[^/\\\\\\x00-\\x1f]+\\.tsv$", maxLength: 240}),
  labels: Type.Array(Type.String({minLength: 1}), {uniqueItems: true}),
}, {additionalProperties: false});
export const placementParameter = Type.Array(placement);
export type FactPlacement = Static<typeof placement>;
const columns = "id\tfact\tsource\tlabels";
const labelPath = ".fact/label.tsv";

export function reviewedDrafts(run: Run) {
  const {team} = run.state;
  const {review} = team ?? {};
  if (review?.kind !== "approved" || review.checkpoint.candidate.revision !== run.state.revision) {
    throw new Error("登记事实需要当前交付提交的签署审核。");
  }
  const approved = new Set(review.draftFacts.filter(item => item.decision === "keep").map(item => item.id));
  return (team?.drafts ?? []).filter(draft => approved.has(draft.id));
}

export function validatePlacements(run: Run, placements: FactPlacement[]) {
  const snapshot = readTopicFacts(run.root);
  const modelPath = projectModelPolicy(run.root)?.path;
  const labels = new Set(decodeTsv(snapshot.labels ?? "").slice(1).map(row => row[0]));
  const drafts = reviewedDrafts(run);
  if (placements.length !== drafts.length || new Set(placements.map(item => item.id)).size !== drafts.length ||
      placements.some(item => !drafts.some(draft => draft.id === item.id))) {
    throw new Error("每条审核通过的 Draft Fact 需要唯一的事实分类。");
  }
  for (const {path, labels: selected} of placements) {
    const filename = path.split("/").at(-1);
    if (posix.normalize(path) !== path || path.startsWith(".fact/taskbook/") || [modelSettingsPath, modelPath, projectModelsFile].includes(path) ||
        ["label.tsv", "change.tsv", "settings.tsv", "facts.tsv"].includes(filename!) ||
        (filename === "always.tsv" && !snapshot.tables.has(path))) throw new Error("请选择可写入的主题事实表 " + path);
    if (selected.some(label => !labels.has(label))) throw new Error("事实标签须在 .fact/label.tsv 已登记。");
    const current = readFactFile(run.root, path);
    if (current !== undefined && !snapshot.tables.has(path)) throw new Error("目标并非主题事实表 " + path);
  }
  return drafts;
}

export function registerReviewedFacts(run: Run, placements: FactPlacement[]) {
  const drafts = validatePlacements(run, placements);
  const base = run.state.revision;
  if (!base) throw new Error("登记事实缺少已审核提交。");
  const head = cleanRevision(run);
  const marker = "Taskbook-Registration: " + run.task.digest;
  if (head !== base) {
    const changed = git(run.root, "diff", "--name-only", "-z", base, head).split("\0").filter(Boolean);
    if (git(run.root, "rev-list", "--parents", "-n", "1", head) !== head + " " + base ||
        !git(run.root, "log", "-1", "--format=%B", head).split("\n").includes(marker) ||
        changed.some(path => !placements.some(item => item.path === path))) {
      throw new Error("已审核提交在登记草稿事实前发生变化。");
    }
  }
  const snapshot = readTopicFacts(run.root);
  const norm = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").replace(/[.。]+$/u, "");
  const allFacts = [...snapshot.tables.values()].flat();
  const changes = new Map<string, string>();
  for (const {id, path, labels} of placements) {
    const draft = drafts.find(item => item.id === id)!;
    if (allFacts.some(fact => norm(fact.fact) === norm(draft.text))) continue;
    const rows = decodeTsv(changes.get(path) ?? readFactFile(run.root, path) ?? columns);
    const factId = "taskbook:" + run.task.digest.slice(0, 16) + ":" + id.slice("draft:".length);
    if (rows.some(row => row[0] === factId)) throw new Error("草稿事实 ID 对应了不同的当前内容 " + factId);
    const source = [run.task.id + "@" + base, draft.seat + "/" + draft.work, draft.source].join(" | ");
    const tags = labels;
    changes.set(path, encodeTsv([...rows, [factId, draft.text, source, tags.join(",")]]));
    allFacts.push({path, id: factId, fact: draft.text, source, labels: tags});
  }
  if (head !== base && changes.size) throw new Error("登记提交没有包含完整的批准事实。");
  const revision = commitFactFiles(run.root, changes, "Register reviewed facts · " + run.task.id + "\n\n" + marker, () => {
    if (cleanRevision(run) !== head || readTopicFacts(run.root).head !== snapshot.head) throw new Error("登记草稿前项目事实发生变化。");
  });
  return {revision, diff: revision === base ? "" : git(run.root, "diff", "--no-ext-diff", base, revision, "--", ".fact"),
    topicHead: readTopicFacts(run.root).head};
}

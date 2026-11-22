import { commitRegisteredMemory, readProjectMemory } from "../facts/project-memory.ts";
import { defaultFactTable, readFactTables, validateFactTablePath } from "../facts/taskbook-intake.ts";
import { decodeTsv, encodeTsv } from "../facts/tsv.ts";
import { git } from "../taskbook/document.ts";
import { cleanRevision, type Run } from "./run.ts";

export type FactPlacement = {id: string; path: string; labels: string[]};
const columns = "id\tfact\tsource\tlabels";
const labelPath = ".fact/label.tsv";

export function reviewedDrafts(run: Run) {
  const {team} = run.state;
  const {review} = team ?? {};
  if (review?.kind !== "approved" || review.progress.candidate.revision !== run.state.revision) {
    throw new Error("登记事实需要当前交付提交的签署审核。");
  }
  const approved = new Set(review.draftFacts.filter(item => item.decision === "keep").map(item => item.id));
  return (team?.drafts ?? []).filter(draft => approved.has(draft.id));
}

function validatePlacements(run: Run, drafts: ReturnType<typeof reviewedDrafts>, placements: FactPlacement[]) {
  const snapshot = readFactTables(run.root);
  const labels = new Set(decodeTsv(snapshot.labels ?? "").slice(1).map(row => row[0]));
  labels.add("terms");
  if (placements.length !== drafts.length || new Set(placements.map(item => item.id)).size !== drafts.length ||
      placements.some(item => !drafts.some(draft => draft.id === item.id))) {
    throw new Error("事实登记位置与审核通过的草稿不匹配。");
  }
  for (const {path, labels: selected} of placements) {
    validateFactTablePath(run.root, path, snapshot.tables);
    if (selected.some(label => !labels.has(label))) throw new Error("事实标签须在 .fact/label.tsv 已登记。");
  }
}

const norm = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").replace(/[.。]+$/u, "");

export function registerReviewedFacts(run: Run, savedPlacements = run.state.team?.placements) {
  const drafts = reviewedDrafts(run);
  const placements = savedPlacements ?? drafts.map(draft => ({id: draft.id, path: defaultFactTable, labels: []}));
  validatePlacements(run, drafts, placements);
  const base = run.state.revision;
  if (!base) throw new Error("登记事实缺少已审核提交。");
  const head = cleanRevision(run);
  const view = run.state.factView;
  const marker = "Taskbook-Registration: " + run.task.digest;
  const snapshot = readFactTables(run.root);
  const project = readProjectMemory(run.root);
  if (head !== base) throw new Error("已审核提交在登记事实前发生变化。");
  if ((run.state.topicFactsHead !== undefined && run.state.topicFactsHead !== snapshot.head) ||
      (run.state.approvedProjectHead !== undefined && run.state.approvedProjectHead !== project.head) ||
      (view && (view.topicHead !== snapshot.head || view.projectHead !== project.head))) {
    throw new Error("事实版本在审核后发生变化，请重新核对。");
  }

  const touched = new Set<string>();
  const tables = snapshot.tables;
  for (const entry of view?.entries ?? []) {
    const {operation, row} = entry;
    if (operation === "use") continue;
    validateFactTablePath(run.root, row.path, tables);
    const rows = tables.get(row.path) ?? [];
    const index = rows.findIndex(current => current.id === row.id);
    if ((operation === "create") !== (index === -1)) throw new Error("目标事实在审核后发生变化：" + row.id);
    if (operation === "create") rows.push(row);
    if (operation === "update") rows[index] = row;
    if (operation === "delete") rows.splice(index, 1);
    tables.set(row.path, rows);
    touched.add(row.path);
  }
  const texts = new Set([...tables.values()].flat().map(row => norm(row.fact)));
  for (const {id, path, labels} of placements) {
    const draft = drafts.find(item => item.id === id)!;
    if (texts.has(norm(draft.text))) continue;
    const rows = tables.get(path) ?? [];
    const factId = "taskbook:" + run.task.digest.slice(0, 16) + ":" + id.slice("draft:".length);
    if (rows.some(row => row.id === factId)) throw new Error("草稿事实 ID 对应了其他内容：" + factId);
    const source = [run.task.id + "@" + base, draft.seat + "/" + draft.work, draft.source].join(" | ");
    rows.push({path, id: factId, fact: draft.text, source, labels});
    tables.set(path, rows);
    touched.add(path);
    texts.add(norm(draft.text));
  }
  const changes = new Map<string, string>();
  for (const path of touched) {
    changes.set(path, encodeTsv([columns.split("\t"), ...tables.get(path)!.map(row => [row.id, row.fact, row.source, row.labels.join(",")])]));
  }
  if ([...touched].some(path => tables.get(path)!.some(row => row.labels.includes("terms")))) {
    const catalog = decodeTsv(snapshot.labels ?? "label\tdescription\n");
    if (catalog[0]?.join("\t") !== "label\tdescription") throw new Error(".fact/label.tsv 表头无效。");
    if (!catalog.slice(1).some(cells => cells[0] === "terms")) {
      changes.set(labelPath, encodeTsv([...catalog, ["terms", "Definitions of project terms."]]));
    }
  }
  commitRegisteredMemory(run.root, project, run.task, run.state.base, view?.memoryChanges ?? [], view?.sessionId ?? run.state.session,
    changes, "Register reviewed facts · " + run.task.id + "\n\n" + marker, () => {
      if (cleanRevision(run) !== base || readFactTables(run.root).head !== snapshot.head) throw new Error("登记前项目事实发生变化。");
    });
  return {revision: git(run.root, "rev-parse", "HEAD"),
    topicHead: readFactTables(run.root).head, projectHead: readProjectMemory(run.root).head};
}

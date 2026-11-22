import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createsPull, type HandoffGitHub, type HandoffPullRequest, type PullRequestAction } from "../integrations/github-handoff.ts";
import { readProjectMemory } from "../facts/project-memory.ts";
import { readFactTables } from "../facts/taskbook-intake.ts";
import { git, githubRepository, gitOk, workspace } from "../taskbook/document.ts";
import { cleanRevision, matchesDeliveryHead, type Run } from "./run.ts";

type PullTarget = {number: number; body: string};
export type Publication = {
  repository: string;
  base: string;
  branch: string;
  revision: string;
  remoteHead?: string;
  title: string;
  comments: string[];
} & ({action: "create" | "draft"; pull: PullTarget | null; body: string} |
  {action: "update"; pull: PullTarget; body: string} | {action: "comment"; pull: PullTarget; body?: never});
export type PublicationReceipt = {action: PullRequestAction; revision: string; pullRequest: string; comments: string[]};

const exec = promisify(execFile);
export class PublicationChanged extends Error {}

export function deliveryFactDiff(run: Run) {
  const end = run.state.team?.registered?.revision;
  return end ? git(run.root, "diff", "--no-ext-diff", "--no-textconv", run.state.factBase ?? run.state.base, end,
    "--", ".fact", ":(exclude).fact/taskbook/" + run.task.digest + ".md") : "";
}

function verifiedDelivery(run: Run) {
  const {state, root, task} = run;
  const revision = state.deliveryRevision;
  if (state.phase !== "publication" || !revision || !state.team?.handoff || state.team.review?.kind !== "approved" ||
      state.team.review.progress.candidate.revision !== state.revision) throw new Error("PR 交付需要本地任务已完成并签署 Review。");
  if (state.branch === "main") throw new PublicationChanged("PR 交付需要独立于 main 的任务分支。");
  workspace(root, task, state.base, state.branch);
  if (cleanRevision(run) !== revision || !matchesDeliveryHead(run, revision) ||
      readProjectMemory(root).head !== state.approvedProjectHead || readFactTables(root).head !== state.topicFactsHead) {
    throw new PublicationChanged("本地交付提交或事实版本变化。");
  }
  const repository = task.repository.toLowerCase();
  const pushUrls = git(root, "remote", "get-url", "--push", "--all", "origin").split("\n");
  if (pushUrls.length !== 1 || githubRepository(pushUrls[0]) !== repository) {
    throw new PublicationChanged("origin 推送地址须唯一且指向任务书指定的 GitHub 仓库。");
  }
  return {repository, branch: state.branch, revision};
}

async function remoteGit(run: Run, args: string[], signal?: AbortSignal) {
  try {
    const {stdout} = await exec("git", args, {cwd: run.root, signal, timeout: 30_000,
      env: {...process.env, GIT_TERMINAL_PROMPT: "0"}, maxBuffer: 1_000_000});
    return stdout.trim();
  } catch {
    throw new Error("无法访问 origin。请核对 Git 认证、远端分支和权限，随后重试。");
  }
}

async function remoteRevision(run: Run, branch: string) {
  const ref = "refs/heads/" + branch;
  const result = await remoteGit(run, ["ls-remote", "--refs", "--heads", "origin", ref]);
  if (!result) return;
  const [revision, actual] = result.split("\t");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision) || ref !== actual) {
    throw new Error("origin 返回了意外的分支。");
  }
  return revision;
}

async function defaultBranch(run: Run) {
  const result = await remoteGit(run, ["ls-remote", "--symref", "origin", "HEAD"]);
  const base = /^ref: refs\/heads\/([^\t\r\n]+)\tHEAD$/mu.exec(result)?.[1];
  if (!base) throw new Error("无法核对 origin 默认分支，请在任务书中指定 Base branch。");
  return base;
}

async function verifyBase(run: Run, base: string) {
  const revision = await remoteRevision(run, base);
  if (revision && !gitOk(run.root, "cat-file", "-e", revision + "^{commit}")) {
    await remoteGit(run, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", "refs/heads/" + base]);
  }
  if (!revision || !gitOk(run.root, "merge-base", "--is-ancestor", run.state.base, revision)) {
    throw new PublicationChanged("origin 基线分支须包含任务书固定的基线提交。");
  }
}

function matchingPull(pulls: HandoffPullRequest[], repo: string, branch: string, base: string) {
  const matches = pulls.filter(pull => pull.state === "open" && pull.head.repo?.full_name.toLowerCase() === repo &&
    pull.head.ref === branch && pull.base.repo.full_name.toLowerCase() === repo && pull.base.ref === base);
  if (matches.length > 1) throw new PublicationChanged("此工作分支和基线匹配多个打开的 PR。");
  return matches[0];
}

function blockFor(run: Run) {
  const key = "<!-- pi-taskbook:" + run.task.digest + ":";
  const start = key + "summary -->";
  const end = key + "/summary -->";
  const summary = run.state.team?.handoff?.trim() ?? "";
  if (!summary || summary.includes("<!-- pi-taskbook:")) throw new Error("交付说明包含无效的保留标记。");
  return {start, end, content: [start, "## Taskbook delivery", "", summary, "", end].join("\n")};
}

function updatedBody(previous: string, block: ReturnType<typeof blockFor>) {
  const start = previous.indexOf(block.start);
  const end = previous.indexOf(block.end);
  if (start < 0 && end < 0) return previous ? previous + "\n\n" + block.content : block.content;
  if (start < 0 || end < start || previous.indexOf(block.start, start + 1) >= 0 || previous.indexOf(block.end, end + 1) >= 0) {
    throw new PublicationChanged("PR 说明的 Taskbook 区段标记冲突。");
  }
  return previous.slice(0, start) + block.content + previous.slice(end + block.end.length);
}

function factComments(run: Run, revision: string, action: PullRequestAction) {
  const diff = deliveryFactDiff(run);
  const content = diff || (action === "comment" ? run.state.team?.handoff : "");
  if (!content) return [];
  const pages = content.match(/[\s\S]{1,24000}/gu) ?? [];
  return pages.map((page, index) => {
    const marker = "<!-- pi-taskbook:" + run.task.digest + ":" + revision + ":" + (diff ? "facts" : "note") + ":" + index + " -->";
    const header = (diff ? "## Taskbook fact changes" : "## Taskbook delivery") +
      (pages.length > 1 ? " (" + (index + 1) + "/" + pages.length + ")" : "");
    const fences = ["~", "`"].map(char => {
      const longest = Math.max(2, ...Array.from(page.matchAll(new RegExp(char + "+", "gu")), item => item[0].length));
      return char.repeat(longest + 1);
    });
    const quote = fences[0].length <= fences[1].length ? fences[0] : fences[1];
    return [marker, header, "", ...(diff ? [quote + "diff", page, quote] : [page])].join("\n");
  });
}

export async function preparePublication(run: Run, action: PullRequestAction, client: HandoffGitHub): Promise<Publication> {
  const delivery = verifiedDelivery(run);
  const base = run.task.baseBranch ?? await defaultBranch(run);
  if (base === delivery.branch || !gitOk(run.root, "check-ref-format", "refs/heads/" + base)) {
    throw new PublicationChanged("GitHub 基线分支须与工作分支不同。");
  }
  await verifyBase(run, base);
  const pulls = await client.pulls(delivery.branch);
  const target = matchingPull(pulls, delivery.repository, delivery.branch, base);
  const block = blockFor(run);
  if (!createsPull(action) && !target) action = "create";
  if (createsPull(action) && pulls.some(pull => pull.state === "closed" && pull.body?.includes(block.start))) {
    throw new PublicationChanged("此任务已关联到已关闭或已合并的 PR。");
  }
  if (createsPull(action) && target && !target.body?.includes(block.content)) action = "update";
  const remoteHead = await remoteRevision(run, delivery.branch);
  if (remoteHead && remoteHead !== delivery.revision && !gitOk(run.root, "merge-base", "--is-ancestor", remoteHead, delivery.revision)) {
    throw new PublicationChanged("无法确认交付能够快进 origin 工作分支。请先核对或同步远端分支。");
  }
  const pull = target ? {number: target.number, body: target.body ?? ""} : null;
  const title = /^# (.+)$/mu.exec(run.task.markdown)?.[1].trim().slice(0, 240) || run.task.id;
  const plan = {...delivery, base, remoteHead, title, comments: factComments(run, delivery.revision, action)};
  if (action === "create" || action === "draft") return {...plan, action, pull, body: pull?.body ?? block.content};
  if (!pull) throw new PublicationChanged("要发布的 PR 已消失。");
  if (action === "comment") return {...plan, action, pull};
  const body = updatedBody(pull.body, block);
  if (body !== pull.body && body.length > 65_000) throw new Error("PR 说明已接近 GitHub 长度上限，请先缩短现有说明。");
  return {...plan, action, pull, body};
}

export async function publishDelivery(run: Run, plan: Publication, client: HandoffGitHub, signal?: AbortSignal): Promise<PublicationReceipt> {
  const delivery = verifiedDelivery(run);
  if (plan.revision !== delivery.revision || plan.branch !== delivery.branch || plan.repository !== delivery.repository) {
    throw new PublicationChanged("记录的 PR 目的地或交付版本已变化。");
  }
  const currentPull = async () => matchingPull(await client.pulls(plan.branch), plan.repository, plan.branch, plan.base);
  const pull = await currentPull();
  await verifyBase(run, plan.base);
  if (plan.pull ? pull?.number !== plan.pull.number : pull && pull.body !== plan.body) {
    throw new PublicationChanged("准备发布后，PR 目标发生变化。");
  }
  if (plan.action === "update" && pull?.body !== plan.body && (pull?.body ?? "") !== plan.pull?.body) {
    throw new PublicationChanged("准备发布后，PR 说明发生变化。");
  }
  const remote = await remoteRevision(run, plan.branch);
  if (remote !== plan.revision && remote !== plan.remoteHead) throw new PublicationChanged("发布期间 origin 工作分支发生变化。");
  verifiedDelivery(run);
  signal?.throwIfAborted();
  if (remote !== plan.revision) {
    await remoteGit(run, ["-c", "remote.origin.mirror=false", "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no",
      "origin", plan.revision + ":refs/heads/" + plan.branch], signal);
    if (await remoteRevision(run, plan.branch) !== plan.revision) throw new Error("等待 origin 确认交付提交后重试。");
  }
  if ((plan.action === "create" || plan.action === "draft") && !pull) {
    await client.open(plan.title, plan.branch, plan.base, plan.body, plan.action === "draft");
  }
  const current = await currentPull();
  if (!current || (pull && current.number !== pull.number) || (!pull && current.body !== plan.body) || current.head.sha !== plan.revision) {
    throw new Error("等待 Magpie 确认 PR 当前提交后重试。");
  }
  if (plan.action === "update" && current.body !== plan.body) {
    if ((current.body ?? "") !== plan.pull?.body) throw new PublicationChanged("准备发布后，PR 说明发生变化。");
    await client.update(current.number, plan.body);
    const updated = await currentPull();
    if (updated?.number !== current.number || updated.body !== plan.body) throw new Error("Magpie 尚未确认 PR 说明。");
  }
  const receipts: string[] = [];
  if (plan.comments.length) {
    let known = await client.comments(current.number);
    for (const body of plan.comments) {
      const marker = body.split("\n", 1)[0];
      const existing = known.find(comment => comment.body.startsWith(marker + "\n"));
      if (existing && existing.body !== body) throw new PublicationChanged("已发布的 Taskbook 评论正文已变化。");
      if (!existing) {
        await client.comment(current.number, body);
        known = await client.comments(current.number);
      }
      const receipt = known.find(comment => comment.body === body);
      if (!receipt) throw new Error("Magpie 尚未确认 PR 评论。");
      receipts.push(receipt.html_url);
    }
  }
  return {action: plan.action, revision: plan.revision, pullRequest: current.html_url, comments: receipts};
}

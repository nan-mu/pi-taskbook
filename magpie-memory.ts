import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { projectMemoryRef, readProjectMemory, type ProjectRecord } from "./project-memory.ts";

const exec = promisify(execFile);
type Call = (name: "memory_search" | "memory_save", args: Record<string, string | number>) => Promise<string>;
const scopes = new Map([["cross-project:rule", "rule"], ["cross-project:preference", "preference"],
  ["cross-project:fact", "fact"], ["cross-project:term", "fact"]]);

function gateway(root: string): Call {
  return async (name, args) => {
    const flags = Object.entries(args).map(([key, value]) => "--" + key + "=" + value);
    let stdout: string;
    try {
      ({stdout} = await exec("magpie", ["tool", name, "--json", ...flags], {cwd: root,
        timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8"}));
    } catch (error) {
      // execFile errors may contain the full argv including the memory. Keep the diagnostic bounded.
      const reason = error as NodeJS.ErrnoException & {killed?: boolean};
      throw new Error("Magpie " + name + " 失败（" + (reason.killed ? "超时" : reason.code ?? "网关不可用") + "）。");
    }
    const result = JSON.parse(stdout);
    const text = Array.isArray(result.content) ? result.content.filter((b: {type?: string; text?: string}) =>
      b.type === "text" && typeof b.text === "string").map((b: {text: string}) => b.text).join("\n") : "";
    if (result.isError || !text) throw new Error("Magpie " + name + " 未返回成功的文本回执。");
    return text;
  };
}

export async function recallMagpieMemory(root: string, query: string, sharedKeys: string[] = [], call = gateway(root)) {
  try {
    const terms = new Set([query, ...sharedKeys.map(key => key.replace(/[._/-]+/g, " "))]);
    const searches: Record<string, string | number>[] = [{scope: "global", kind: "rule", limit: 8},
      {scope: "global", kind: "preference", limit: 8},
      ...[...terms].map(term => ({scope: "global", query: term.slice(0, 128), limit: 8}))];
    const results: string[] = [];
    for (const args of searches) results.push((await call("memory_search", args)).slice(0, 6000));
    return {status: "available" as const, results, searches};
  } catch (error) {
    return {status: "unavailable" as const, reason: String(error), results: []};
  }
}

// This regex is a backstop for obvious credentials. The independent semantic review handles privacy and scope.
const sensitive = /-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[\w]{22,}|AKIA[0-9A-Z]{16})\b|\w+:\/\/[^/\s]+:[^/\s@]+@/i;

export async function syncMagpieMemory(root: string, digest: string, call = gateway(root)) {
  const snapshot = readProjectMemory(root);
  const affected = Object.entries(snapshot.records).filter(([, r]) => r.source.taskDigest === digest &&
    (r.sharedSince !== undefined || scopes.has(r.scope)));
  let published = 0, confirmed = 0;
  for (const [key, record] of affected) {
    const tag = "pi-" + createHash("sha256").update(JSON.stringify([record.source.repository, key])).digest("hex").slice(0, 24);
    const kind = scopes.get(record.scope);
    const desired = !!kind && !record.deleted;
    if (desired && (sensitive.test(record.text) || (record.kind === "term") !== (record.scope === "cross-project:term"))) {
      throw new Error(key + " 的跨项目类型或保密检查未通过，请修订任务书。");
    }
    const text = record.text + " [" + tag + "]";
    if (desired && ([...text].length > 2000 || /[\r\n]/.test(text))) {
      throw new Error(key + " 超出 Magpie 单条事实格式，请将任务书中的表述精简成不超过限制的一行。");
    }
    const remote = await readSharedRecord(call, tag);
    if (remote) {
      if (desired && remote.kind === kind && remote.text === text) { confirmed++; continue; }
      throw new Error("Magpie 需要用户裁决 " + key + "，远端 ID " + remote.id +
        "。请在 Magpie 核对当前值 " + remote.text + (desired ? "。如同意，保留标签 #" + tag +
        "，将种类设为 " + kind + " 并将原文改为 " + text : "。如同意撤回，请将该记录归档") + "，再重交任务书。");
    }
    if (!desired) { confirmed++; continue; }
    const directory = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {cwd: root, encoding:"utf8"}).trim();
    const receipts = join(directory, "pi-taskbook-magpie");
    mkdirSync(receipts, {recursive: true, mode: 0o700});
    const receipt = join(receipts, tag);
    // Reserve the initial send before crossing the process boundary. A missing result could mean the
    // user archived a successful save. Never republish an absent acknowledged/uncertain record.
    if (existsSync(receipt) || record.version !== (record.sharedSince ?? 1)) {
      throw new Error(key + " 的 Magpie 记录在全局查询中不可见。可能已归档或上次发布中断。" +
        "请用户在 Magpie 核对 #" + tag + "；如仍应发布，恢复或创建 " + kind + " 记录，标签为 " + tag + "，内容为 " + text + "，再重交任务书。");
    }
    await whileCurrent(root, snapshot.head!, async () => {
      reservePublication(receipt, record);
      const response = await call("memory_save", {scope:"global", kind:kind!, text, tags:tag});
      const acknowledgement = /^(?:Remembered|Already remembered, merged): \[([^\]]+)\] /.exec(response);
      if (!acknowledgement) throw new Error(key + " 缺少 Magpie 保存回执，请重试核对。");
      const saved = await readSharedRecord(call, tag);
      if (!saved || saved.id !== acknowledgement[1] || saved.kind !== kind || saved.text !== text) {
        throw new Error(key + " 写入后的全局读回与审批不符，请用户核对 #" + tag + "。");
      }
    });
    published++;
  }
  return {published, confirmed};
}

async function readSharedRecord(call: Call, tag: string) {
  const remote = await call("memory_search", {scope: "global", tags: tag, limit: 2});
  const lines = remote.split("\n");
  const rows = lines.filter(line => line.startsWith("["));
  if (!rows.length && /^Nothing (?:is remembered here yet|remembered matches )/.test(remote)) return;
  // Split at the upstream timestamp, not the last colon in user content, and preserve continuation lines.
  const match = rows.length === 1 &&
    /^\[([^\]]+)\] ([^,]+), everywhere, (.+), \d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2}): (.*)$/.exec(rows[0]);
  if (!match || !match[3].split(/[, ]+/).includes("#" + tag)) {
    throw new Error("Magpie 记录的唯一来源或格式无法确认，请核对 #" + tag + "。");
  }
  let text = match[4];
  for (let i = lines.indexOf(rows[0]) + 1; lines[i]?.startsWith("  "); i++) text += "\n" + lines[i].slice(2);
  return {id:match[1], kind:match[2], text};
}

function reservePublication(path: string, record: ProjectRecord) {
  try { writeFileSync(path, JSON.stringify({taskDigest: record.source.taskDigest, version: record.version}),
    {flag:"wx", mode:0o600}); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("另一工作区已开始发布，请重试核对 Magpie 回执。");
    throw error;
  }
}

// Git holds the verified ref through the network call and drops the lock on EOF, even after a crash.
async function whileCurrent<T>(root: string, head: string, operation: () => Promise<T>): Promise<T> {
  const git = spawn("git", ["update-ref", "--stdin"], {cwd: root, stdio: ["pipe", "pipe", "ignore"]});
  const output = createInterface({input: git.stdout});
  const lines = output[Symbol.asyncIterator]();
  const completion = new Promise<void>((resolve, reject) => {
    git.once("error", reject);
    git.once("close", () => resolve());
  });
  git.stdin.on("error", () => {}); // Git may exit on an obsolete snapshot before reading all commands.
  try {
    git.stdin.write("start\nverify " + projectMemoryRef + " " + head + "\nprepare\n");
    for (const expected of ["start: ok", "prepare: ok"]) {
      if ((await lines.next()).value !== expected) throw new Error("项目记忆版本或锁已变化，请重新核查。");
    }
    return await operation();
  } finally {
    git.stdin.end();
    await completion;
    output.close();
  }
}

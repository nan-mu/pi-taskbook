import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { toolProperties } from "./mcp-catalog.ts";
import { Value } from "typebox/value";

export const pullRequestActions = ["create", "draft", "update", "comment"] as const;
export type PullRequestAction = typeof pullRequestActions[number];
export const createsPull = (action: PullRequestAction) => action === "create" || action === "draft";

const nonempty = Type.String({minLength: 1});
const repository = Type.Object({full_name: nonempty});
const numbered = Type.Object({number: Type.Integer({minimum: 1})});
const pull = Type.Object({
  number: numbered.properties.number, html_url: nonempty,
  state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  body: Type.Union([Type.String(), Type.Null()]),
  head: Type.Object({ref: nonempty, sha: nonempty, repo: Type.Union([repository, Type.Null()])}),
  base: Type.Object({ref: nonempty, repo: repository}),
});
const comment = Type.Object({body: Type.String(), html_url: nonempty});
export type HandoffPullRequest = Static<typeof pull>;

const contracts = {
  list_pull_requests: ["owner", "repo", "state", "head", "page", "perPage"],
  pull_request_read: ["owner", "repo", "pullNumber", "method", "page", "perPage"],
  create_pull_request: ["owner", "repo", "title", "base", "head", "body"],
  update_pull_request: ["owner", "repo", "pullNumber", "body"],
  add_issue_comment: ["owner", "repo", "issue_number", "body"],
};
type Method = keyof typeof contracts;
type RegisteredTool = ReturnType<ExtensionAPI["getAllTools"]>[number];

export function githubHandoffTools(pi: ExtensionAPI) {
  const tools = pi.getAllTools().filter(tool => tool.sourceInfo.path === "builtin:mcp" && tool.exposure !== "hidden" &&
    (tool.namespace?.aliases?.includes("magpie") || tool.namespace?.name === "mcp__magpie"));
  const catalogue = new Map<Method, RegisteredTool>();
  for (const method of Object.keys(contracts) as Method[]) {
    const matches = tools.filter(tool => tool.name.startsWith(tool.namespace?.name + "__") &&
      tool.name.slice((tool.namespace?.name.length ?? 0) + 2) === "github__" + method);
    const properties = toolProperties(matches[0]?.parameters);
    if (matches.length !== 1 || !properties || contracts[method].some(key => !Object.hasOwn(properties, key))) continue;
    if (method === "pull_request_read") {
      const methods = field(field(properties, "method"), "enum");
      if (!Array.isArray(methods) || !["get", "get_comments"].every(name => methods.includes(name))) continue;
    }
    catalogue.set(method, matches[0]);
  }
  return catalogue;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key) ?
    Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

function payload(value: unknown): unknown {
  const blocks = field(value, "content");
  if (!Array.isArray(blocks)) return value;
  const structured = field(value, "structuredContent");
  if (structured !== undefined) return payload(structured);
  const text = blocks.map(block => field(block, "type") === "text" ? field(block, "text") : undefined)
    .filter(value => typeof value === "string").join("\n");
  if (!text) throw new Error("Magpie GitHub MCP 回执缺少正文。");
  try { return JSON.parse(text); }
  catch { throw new Error("Magpie GitHub MCP 回执格式不符合预期。"); }
}

function decode<T extends TSchema>(schema: T, result: unknown, ...keys: string[]): Static<T> {
  for (const value of [result, ...keys.map(key => field(result, key))]) {
    if (Value.Check(schema, value)) return value;
  }
  throw new Error("Magpie GitHub MCP 回执缺少可核对的 PR 数据。");
}

export function githubHandoff(pi: ExtensionAPI, ctx: ExtensionToolContext, repository: string,
  options: {action: PullRequestAction; comments: boolean; signal?: AbortSignal}) {
  const names = githubHandoffTools(pi);
  const required: Method[] = ["list_pull_requests", "pull_request_read",
    ...(createsPull(options.action) ? ["create_pull_request"] as const :
      options.action === "update" ? ["update_pull_request"] as const : []),
    ...(options.comments ? ["add_issue_comment"] as const : [])];
  const missing = required.filter(name => !names.has(name) || options.action === "draft" && name === "create_pull_request" &&
    !Object.hasOwn(toolProperties(names.get(name)?.parameters) ?? {}, "draft"));
  if (missing.length) throw new Error("当前 Pi 会话缺少可用的 Magpie GitHub MCP 工具 " + missing.join("、") + "。");
  const [owner, repo] = repository.split("/");
  async function call(method: Method, args: object) {
    const tool = names.get(method);
    if (!tool || !required.includes(method)) throw new Error("此交付缺少 Magpie 工具 " + method + "。");
    const timeout = AbortSignal.timeout(25_000);
    const result = await ctx.executeTool(tool.name, {owner, repo, ...args},
      {signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout});
    if (result.isError || result.result.isError) throw new Error("Magpie GitHub MCP 调用失败 · " + method);
    if (method === "list_pull_requests" || method === "pull_request_read") {
      return payload(result.result.structuredContent ?? result.result);
    }
  }
  async function pages<T extends TSchema>(schema: T, load: (page: number) => Promise<unknown>, ...keys: string[]) {
    const all: Static<T>[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = decode(Type.Array(schema), await load(page), ...keys);
      all.push(...batch);
      if (batch.length < 100) return all;
    }
    throw new Error("Magpie GitHub MCP 分页尚未完成。");
  }
  return {
    async pulls(branch: string) {
      const rows = await pages(numbered, page => call("list_pull_requests", {state: "all", head: owner + ":" + branch, page, perPage: 100}),
        "pull_requests", "pullRequests", "items");
      const full: HandoffPullRequest[] = [];
      for (const row of rows) full.push(decode(pull, await call("pull_request_read", {method: "get", pullNumber: row.number}),
        "pull_request", "pullRequest"));
      return full;
    },
    async open(title: string, head: string, base: string, body: string, draft: boolean) {
      await call("create_pull_request", {title, head, base, body, ...(draft ? {draft: true} : {})});
    },
    async update(number: number, body: string) {
      await call("update_pull_request", {pullNumber: number, body});
    },
    comments(number: number) {
      return pages(comment, page => call("pull_request_read", {method: "get_comments", pullNumber: number, page, perPage: 100}),
        "comments", "items");
    },
    async comment(number: number, body: string) {
      await call("add_issue_comment", {issue_number: number, body});
    },
  };
}

export type HandoffGitHub = ReturnType<typeof githubHandoff>;

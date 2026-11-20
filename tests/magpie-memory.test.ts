import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readForeignFacts, recallMagpieMemory, syncMagpieMemory, type MagpieTransport } from "../src/integrations/magpie-memory.ts";
import { applyApprovedMemory, readProjectMemory, type MemoryChange } from "../src/facts/project-memory.ts";

type Request = Parameters<MagpieTransport["call"]>;
type Row = {
  id: string; owner: string; fact_id: string; kind: string; text: string; scope: string;
  version: number; fact_version: number; status: "active" | "retired"; eligible: boolean; writable: boolean;
};
const id = "project:fact:shell";
const ownerTag = (owner: string, origin: string) =>
  "pi-" + createHash("sha256").update(JSON.stringify([owner, origin])).digest("hex").slice(0, 24);

function project(t: TestContext, repository: string) {
  const root = mkdtempSync(join(tmpdir(), "pi-magpie-test-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const git = (...args: string[]) => execFileSync("git", args, {cwd: root, encoding: "utf8"}).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", "https://github.com/" + repository + ".git");
  writeFileSync(join(root, ".gitignore"), "/.fact/foreign.json\n/.fact/foreign.lock/\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const base = git("rev-parse", "HEAD");
  let task = 0;

  function change(scope: string, text: string, action: MemoryChange["action"] = "create", key = "shell") {
    const current = readProjectMemory(root);
    const expected = current.records["project:fact:" + key]?.version ?? 0;
    const digest = "fixture-" + ++task;
    applyApprovedMemory(root, current, {id: "task", repository, digest}, base,
      [{action, kind: "fact", key, expected, scope, text, authorization: "- " + action + " fact " + key}],
      [{claim: "The user selected this scope.", observed: "approved", origin: "test-fixture", source: {kind: "git", path: "fixture", line: 1}}],
      {role: "fact-review", verdict: "pass", sessionId: "independent", items: [
        {id: "P1", status: "pass", memoryUse: "change-evidence"}, {id: "M1", status: "pass", reason: "explicit request"},
      ]});
    return {repository, digest, projectHead: readProjectMemory(root).head, revision: git("rev-parse", "HEAD")};
  }
  return {root, git, change};
}

function services() {
  const rows = new Map<string, Row>();
  const log: Request[] = [];
  let sequence = 0;
  const faults = { beforeWrite: undefined as ((...request: Request) => void) | undefined,
    afterWrite: undefined as (() => void) | undefined, mirrorRows: undefined as Row[] | undefined,
    missingPage: false, canCreate: true };
  function transport(repo: string): MagpieTransport {
    return {
      tools: new Set(["memory_context", "memory_search", "memory_save", "memory_forget"]),
      async call(name, args) {
        log.push([name, args]);
        if (name === "memory_context") return {
          protocol: "pi-taskbook-magpie-v1", agent: {id: "pi"}, project: {key: "github.com/" + repo}, search_scopes: ["global"],
          capabilities: {owner_isolated_create: faults.canCreate, conditional_update: true, conditional_forget: true},
        };
        if (name === "memory_search") {
          const tags = Array.isArray(args.tags) ? args.tags : [];
          if (tags.length === 1 && faults.missingPage) {
            if (args.cursor) throw new Error("second page denied");
            return {scope: "global", records: [], next_cursor: "page-2"};
          }
          const eligible = tags.length === 1 && faults.mirrorRows ? faults.mirrorRows :
            [...rows.values()].filter(row => tags.length !== 2 || tags.includes(ownerTag(row.owner, row.fact_id)));
          return {scope: "global", records: eligible.map(row => ({...row, writable: row.owner === repo})), next_cursor: null};
        }
        faults.beforeWrite?.(name, args);
        assert.equal(args.owner, repo);
        const existing = [...rows.values()].find(row => row.owner === repo && row.fact_id === args.fact_id);
        assert.equal(args.if_version, existing?.version ?? null);
        assert.equal(args.id, existing?.id);
        assert.ok(args.idempotency_key);
        const record: Row = {
          id: existing?.id ?? "m_" + ++sequence,
          owner: repo,
          fact_id: String(args.fact_id),
          kind: String(args.kind ?? existing?.kind),
          text: String(args.text ?? ""),
          scope: "global",
          fact_version: Number(args.fact_version),
          version: (existing?.version ?? 0) + 1,
          status: name === "memory_forget" ? "retired" : "active",
          eligible: true, writable: true,
        };
        rows.set(record.id, record);
        faults.afterWrite?.();
        return record;
      },
    };
  }
  return {rows, log, faults, transport, writes: () => log.filter(([name]) => name === "memory_save" || name === "memory_forget")};
}

test("authoritative search permits scoped creation, retry confirmation, ID update, and ID retirement", async t => {
  const world = project(t, "team/project");
  const svc = services();
  const transport = svc.transport("team/project");
  const local = world.change("project", "A local build fact", "create", "build");
  assert.deepEqual((await syncMagpieMemory(world.root, local, transport)).items, []);
  assert.deepEqual(svc.writes(), []);
  const created = world.change("cross-project:rule", "Use independent evidence.");
  const delivery = await syncMagpieMemory(world.root, created, transport);
  assert.equal(delivery.status, "complete");
  assert.deepEqual(delivery.items, [{id, status: "published", remoteId: "m_1", remoteVersion: 1}]);
  assert.equal((await syncMagpieMemory(world.root, created, transport)).items[0].status, "confirmed");
  const updated = world.change("cross-project:rule", "Use two independent observations.", "update");
  assert.deepEqual((await syncMagpieMemory(world.root, updated, transport)).items,
    [{id, status: "published", remoteId: "m_1", remoteVersion: 2}]);
  const retired = world.change("cross-project:rule", "The user withdrew the requirement.", "delete");
  assert.equal((await syncMagpieMemory(world.root, retired, transport)).items[0].status, "published");
  assert.equal((await syncMagpieMemory(world.root, retired, transport)).items[0].status, "confirmed");
  assert.deepEqual(svc.writes().map(([name, args]) => [name, args.id, args.if_version]),
    [["memory_save", undefined, null], ["memory_save", "m_1", 1], ["memory_forget", "m_1", 2]]);
  assert.doesNotMatch(JSON.stringify(svc.writes()), /test-fixture|fixture-base|explicit request/);
  assert.ok(svc.log.find(([name]) => name === "memory_context"));
});

test("lost response, competing local edits and remote version changes preserve safe retry progress", async t => {
  const world = project(t, "team/project");
  const svc = services();
  const transport = svc.transport("team/project");
  const created = world.change("cross-project:rule", "Use stable names.");
  svc.faults.beforeWrite = () => assert.throws(() => world.change("project", "Concurrent.", "update"));
  svc.faults.afterWrite = () => { throw new Error("lost response with a raw diagnostic"); };
  const first = await syncMagpieMemory(world.root, created, transport);
  assert.equal(first.status, "pending");
  assert.doesNotMatch(JSON.stringify(first), /raw diagnostic/);
  svc.faults.beforeWrite = svc.faults.afterWrite = undefined;
  assert.equal((await syncMagpieMemory(world.root, created, transport)).items[0].status, "confirmed");
  const updated = world.change("cross-project:rule", "Use stable IDs.", "update");
  svc.faults.beforeWrite = () => {
    const current = svc.rows.get("m_1");
    assert.ok(current);
    svc.rows.set(current.id, {...current, text: "Edited by user.", version: current.version + 1});
  };
  assert.equal((await syncMagpieMemory(world.root, updated, transport)).status, "pending");
  svc.faults.beforeWrite = undefined;
  assert.equal((await syncMagpieMemory(world.root, updated, transport)).status, "pending");
  assert.equal(svc.rows.get("m_1")?.text, "Edited by user.");
  const before = svc.log.length;
  assert.equal((await syncMagpieMemory(world.root, created, transport)).status, "pending");
  assert.equal(svc.log.length, before);
});

test("foreign mirror keys distinguish owners, preserve missing rows and apply explicit retirement", async t => {
  const a = project(t, "team/a");
  const b = project(t, "team/b");
  const svc = services();
  const forA = svc.transport("team/a");
  const forB = svc.transport("team/b");
  const bCreated = b.change("cross-project:fact", "Use independent evidence.");
  const aCreated = a.change("cross-project:fact", "Use independent evidence.");
  await syncMagpieMemory(b.root, bCreated, forB);
  assert.equal((await syncMagpieMemory(a.root, aCreated, forA)).mirror.updated, 1);
  assert.equal(svc.rows.size, 2);
  const mirror = () => {
    const mirror = readForeignFacts(a.root, "team/a");
    assert.equal(mirror.status, "available");
    return mirror.records;
  };
  assert.equal(mirror()[0].owner, "team/b");
  assert.equal(a.git("status", "--porcelain", "--untracked-files=all"), "");
  const aBefore = readFileSync(join(a.root, ".fact/project.json"), "utf8");
  const beforeWrites = svc.writes().length;
  svc.faults.mirrorRows = [];
  assert.equal((await syncMagpieMemory(a.root, aCreated, forA)).mirror.status, "pending");
  assert.equal(mirror()[0].status, "active");
  svc.faults.missingPage = true;
  assert.equal((await syncMagpieMemory(a.root, aCreated, forA)).mirror.status, "pending");
  assert.equal(mirror()[0].status, "active");
  assert.equal(svc.writes().length, beforeWrites);
  svc.faults.missingPage = false;
  svc.faults.mirrorRows = undefined;
  const bUpdated = b.change("cross-project:fact", "Verify independent evidence.", "update");
  await syncMagpieMemory(b.root, bUpdated, forB);
  await syncMagpieMemory(a.root, aCreated, forA);
  assert.equal(mirror()[0].text, "Verify independent evidence.");
  const bRetired = b.change("cross-project:fact", "Retired by B.", "delete");
  await syncMagpieMemory(b.root, bRetired, forB);
  const beforeReplay = svc.writes().length;
  await syncMagpieMemory(a.root, aCreated, forA);
  assert.equal(mirror()[0].status, "retired");
  assert.equal(svc.writes().length, beforeReplay);
  assert.equal(readFileSync(join(a.root, ".fact/project.json"), "utf8"), aBefore);
});

test("scope, identity, read-only legacy, unavailable save condition and foreign IDs block writes", async t => {
  const world = project(t, "team/project");
  const svc = services();
  const transport = svc.transport("team/project");
  const secret = world.change("cross-project:fact", "-----BEGIN OPENSSH PRIVATE KEY-----");
  assert.match((await syncMagpieMemory(world.root, secret, transport)).items[0].reason ?? "", /敏感/);
  const valid = world.change("cross-project:fact", "Stable definition.", "update");
  assert.equal((await syncMagpieMemory(world.root, valid, svc.transport("team/wrong"))).status, "pending");
  const separate = world.change("cross-project:fact", "Useful beyond the current project.", "create", "definition");
  svc.faults.canCreate = false;
  assert.match((await syncMagpieMemory(world.root, separate, transport)).items[0].reason ?? "", /归属隔离/);
  const legacy: MagpieTransport = {
    tools: transport.tools,
    async call(name) {
      if (name === "memory_context") return {agent: null, project: {key: "github.com/team/project"}, scopes: ["global"]};
      assert.equal(name, "memory_search");
      return "Nothing remembered.";
    },
  };
  assert.equal((await syncMagpieMemory(world.root, separate, legacy)).status, "pending");
  svc.faults.canCreate = true;
  const wrongTarget: MagpieTransport = {
    tools: transport.tools,
    async call(name, args) {
      if (name === "memory_context") return transport.call(name, args);
      assert.equal(name, "memory_search");
      return {scope: "global", next_cursor: null, records: [{
        id: "m_foreign", owner: "team/foreign", fact_id: "project:fact:definition", kind: "fact", text: "Useful beyond the current project.",
        scope: "global", version: 1, fact_version: 1, status: "active", eligible: true, writable: true,
      }]};
    },
  };
  assert.equal((await syncMagpieMemory(world.root, separate, wrongTarget)).status, "pending");
  assert.equal(svc.writes().length, 0);
});

test("CLI fallback sends literal read-only arguments and strips failure diagnostics", async t => {
  const world = project(t, "team/project");
  const fake = join(world.root, "magpie");
  const query = '--output=/tmp/should-not-exist $(exit) "quoted"';
  writeFileSync(fake, "#!" + process.execPath +
    '\nconsole.log(JSON.stringify({content:[{type:"text",text:JSON.stringify(process.argv.slice(2))}]}));');
  chmodSync(fake, 0o700);
  const prior = process.env.PATH;
  process.env.PATH = world.root + ":" + prior;
  try {
    const recalled = await recallMagpieMemory(world.root, query, ["glossary-word"]);
    assert.equal(recalled.status, "available");
    assert.deepEqual(JSON.parse(recalled.results[2]), ["tool", "memory_search", "--json", "--scope=global", "--query=" + query, "--limit=8"]);
    assert.ok(recalled.results[3].includes("--query=glossary word"));
  } finally { process.env.PATH = prior; }
  const failed = await recallMagpieMemory(world.root, "fixture", [], {
    tools: new Set(["memory_search"]),
    async call() { throw new Error("credential-like error"); },
  });
  assert.equal(failed.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(failed), /credential-like/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, {type TestContext} from "node:test";
import { recallMagpieMemory, syncMagpieMemory } from "../magpie-memory.ts";
import { applyApprovedMemory, readProjectMemory, type MemoryChange } from "../project-memory.ts";

const key = "shell";
const empty = "Nothing is remembered here yet. Looked in everywhere.";
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-magpie-test-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  execFileSync("git", ["init", "-q", root]);
  let task = 0;
  function change(scope: string, text: string, action: MemoryChange["action"] = "create") {
    const current = readProjectMemory(root);
    const expected = current.records["project:fact:" + key]?.version ?? 0;
    const digest = "fixture-" + ++task;
    applyApprovedMemory(root, current, {id:"task", repository:"test/project", digest}, "fixture-base",
      [{action, kind:"fact", key, expected, scope, text, authorization:"approved taskbook fixture"}],
      [{claim:"The user selected this scope.", observed:"approved", origin:"test-fixture", source:{kind:"git", path:"fixture", line:1}}],
      {role:"fact-review", verdict:"pass", sessionId:"independent", items:[{id:"P1",status:"pass",memoryUse:"change-evidence"}, {id:"M1",status:"pass"}]});
    return digest;
  }
  const writes: Record<string, string | number>[] = [];
  let remote = empty;
  const call = async (name: "memory_search" | "memory_save", args: Record<string, string | number>) => {
    if (name === "memory_search") return remote;
    writes.push({...args});
    remote = "[mx1] " + args.kind + ", everywhere, #" + args.tags + ", 2026-10-01T10:10Z: " + args.text + "\nLooked in everywhere.";
    return "Remembered: " + remote.split("\n")[0];
  };
  return {root, change, writes, call, remote: (text: string) => {remote = text;}};
}

test("reviewed cross-project creation publishes only a single scoped assertion and replays without writing", async t => {
  const world = setup(t);
  const local = world.change("project", "A local build fact");
  assert.deepEqual(await syncMagpieMemory(world.root, local, async () => {throw Error("unexpected call");}),
    {published:0,confirmed:0});
  const share = world.change("cross-project:preference", "The user chooses fish on macOS.", "update");
  assert.deepEqual(await syncMagpieMemory(world.root, share, world.call), {published:1,confirmed:0});
  assert.deepEqual(await syncMagpieMemory(world.root, share, world.call), {published:0,confirmed:1});
  assert.equal(world.writes.length, 1);
  assert.deepEqual(Object.keys(world.writes[0]).sort(), ["kind","scope","tags","text"]);
  assert.equal(world.writes[0].scope,"global");
  assert.equal(world.writes[0].kind,"preference");
  assert.doesNotMatch(JSON.stringify(world.writes), /fixture|independent|test\/project/);
  world.remote(empty);
  await assert.rejects(syncMagpieMemory(world.root, share, world.call), /可能已归档/);
  assert.equal(world.writes.length, 1);
});

test("remote edits, withdrawal and scope narrowing require a human when the shared copy still exists", async t => {
  const world = setup(t);
  const share = world.change("cross-project:rule","Use audited evidence.");
  await syncMagpieMemory(world.root, share, world.call);
  const update = world.change("cross-project:rule","Use verified evidence.", "update");
  await assert.rejects(syncMagpieMemory(world.root, update, world.call), /远端 ID mx1/);
  const {tags} = world.writes[0];
  const prefix = "[mx1] rule, everywhere, #" + tags + ", 2026-10-02T12:00Z: ";
  const desired = "Use verified evidence. [" + tags + "]";
  world.remote(prefix + "Obsolete: " + desired);
  await assert.rejects(syncMagpieMemory(world.root, update, world.call), /远端 ID mx1/);
  world.remote(prefix + desired + "\n  Except in all current projects.");
  await assert.rejects(syncMagpieMemory(world.root, update, world.call), /远端 ID mx1/);
  world.remote(prefix + desired);
  assert.equal((await syncMagpieMemory(world.root, update, world.call)).confirmed, 1);
  const narrow = world.change("project","A local rule.", "update");
  await assert.rejects(syncMagpieMemory(world.root, narrow, world.call), /归档/);
  const retire = world.change("project","No longer true.", "delete");
  await assert.rejects(syncMagpieMemory(world.root, retire, world.call), /归档/);
  world.remote(empty);
  assert.equal((await syncMagpieMemory(world.root, retire, world.call)).confirmed, 1);
  assert.equal(world.writes.length,1);
});

test("an ambiguous acknowledgement is recovered by reading before writing again", async t => {
  const world = setup(t);
  const digest = world.change("cross-project:fact","Both environments share the vocabulary.");
  await assert.rejects(syncMagpieMemory(world.root, digest, async (name, args) => {
    const answer = await world.call(name,args);
    if (name === "memory_save") throw Error("network interrupted after save");
    return answer;
  }), /interrupted/);
  assert.equal((await syncMagpieMemory(world.root, digest, world.call)).confirmed, 1);
  assert.equal(world.writes.length,1);
});

test("obvious credentials fail before contact and missing gateway leaves candidates unavailable", async t => {
  const world = setup(t);
  const digest = world.change("cross-project:fact", "-----BEGIN OPENSSH PRIVATE KEY-----");
  await assert.rejects(syncMagpieMemory(world.root, digest, async () => {throw Error("unexpected contact");}), /保密/);
  const recall = await recallMagpieMemory(world.root, "fixture", [], async () => {throw Error("offline");});
  assert.deepEqual(recall, {status:"unavailable", reason:"Error: offline", results:[]});
});

test("official CLI bridge sends literal flags and reads MCP text results without a shell", async t => {
  const world = setup(t);
  const fake = join(world.root,"magpie");
  const query = '--output=/tmp/should-not-exist $(exit) "quoted"';
  writeFileSync(fake, "#!" + process.execPath + '\nconsole.log(JSON.stringify({content:[{type:"text",text:JSON.stringify(process.argv.slice(2))}]}));');
  chmodSync(fake,0o700);
  const prior = process.env.PATH;
  process.env.PATH = world.root + ":" + prior;
  try {
    const recalled = await recallMagpieMemory(world.root, query, ["glossary-word"]);
    assert.equal(recalled.status, "available");
    assert.deepEqual(JSON.parse(recalled.results[2]), ["tool","memory_search","--json","--scope=global","--query="+query,"--limit=8"]);
    assert.ok(recalled.results[3].includes("--query=glossary word"));
  } finally { process.env.PATH = prior; }
});

test("publishing holds the reviewed project ref through the external call", async t => {
  const world = setup(t);
  const digest = world.change("cross-project:rule", "Use stable names.");
  let changesBlocked = false;
  const outcome = await syncMagpieMemory(world.root, digest, async (name,args) => {
    if (name === "memory_save") {
      assert.throws(() => world.change("project", "Withdraw before publication.", "update"));
      changesBlocked = true;
    }
    return world.call(name,args);
  });
  assert.equal(outcome.published, 1);
  assert.ok(changesBlocked);
  assert.doesNotThrow(() => world.change("project", "Withdraw after publication.", "update"));
});

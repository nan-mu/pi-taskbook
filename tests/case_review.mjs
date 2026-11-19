/**
 * Run this case with the supplied libbpf-mcu taskbook, both upstream checkouts,
 * and Pi SDK dependencies installed. Optional second argument writes a trace.
 * The temporary project exercises one build-directory behavior. It contains no
 * BPF toolchain, firmware, or downstream consumer. Full delivery must stay open.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndependentReview } from "../reviewer.ts";
import { parseFactDecision, taskMemory, validateConflict } from "../memory.ts";
import { readTaskbook } from "../taskbook.ts";
import { loadUpstreamInputs, pinUpstreamInputs } from "../upstream.ts";

const task = readTaskbook(process.cwd(), process.argv[2] ?? "");
const authority = taskMemory(task);
const ids = items => items.map(item => item.id);
assert.deepEqual(ids(authority.goals), ["G1","G2","G3","G4","G5"]);
assert.deepEqual(ids(authority.facts), ["F1","F2","F3","F4","F5","F6","F7","F8"]);
assert.deepEqual(ids(authority.delivery), ["D1","D2","D3"]);
assert.match(authority.goals[1].text, /路径可由实现决定/);
assert.match(authority.delivery[2].text, /以用户确认结果为前提/);
assert.match(authority.facts[7].text, /xdp\.firewall\.dual/);

const directory = mkdtempSync(join(tmpdir(), "pi-taskbook-case-"));
const config = join(directory, "config");
const root = join(directory, "fixture");
mkdirSync(config);
mkdirSync(root);
const oldConfig = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = config;
const manifest = "layout.txt";
const scenario = { kind: "spec" };
const events = [];
const errors = [];

function callInspection(view, path) {
  return { role: "assistant", tool_calls: [{index: 0, id: randomUUID(), type: "function",
    function: { name: "inspect_revision", arguments: JSON.stringify({view, path}) }}] };
}

function readMessage(message) {
  return Array.isArray(message.content) ? message.content.map(part => part.text).join("") : message.content;
}

function nextMessage(body) {
  const { messages, tools } = body;
  assert.deepEqual(tools.map(t => t.function.name), ["inspect_revision"]);
  const packet = JSON.parse(readMessage(messages.find(m => m.role === "user")));
  assert.match(packet.taskbook, /正式附加后端、固件配对及固件是否随资产交付由用户确认/);
  assert.deepEqual(ids(packet.facts).slice(0,8), ids(authority.facts));
  const seen = messages.filter(m => m.role === "tool").map(readMessage);
  if (seen.length === 0) return callInspection("base", manifest);
  if (seen.length === 1) return callInspection("candidate", manifest);
  if (seen.length === 2) return callInspection("changes");
  const inventory = seen[2];
  const base = seen[0];
  const artifact = seen[1];
  const observedId = text => text.match(/Observation (R\d+)/)[1];
  const conflict = scenario.kind === "authority-conflict";
  const cleanOk = artifact.includes("clean=build\n") || artifact.endsWith("clean=build");
  const reason = cleanOk ? "候审样本的 clean 指向 build。" : "候审样本的 clean 仍指向 ../build。";
  if (conflict) assert.match(base, /explicit=ignored/);
  else assert.match(base, /default=\.\.\/build[\s\S]*explicit=honored/);
  const items = packet.requiredIds.map(id => {
    if (id === "F1" && conflict) return {
      id, status: "fact-conflict", reason: "缩小基线不采用显式输出目录，与 F1 在同一版本范围相斥。", evidence: observedId(base),
    };
    if (id === "F1") return {
      id, status:"pass", reason:"缩小基线保留旧默认目录和显式目录优先语义；授权的候审变化与该历史记录相容。", evidence:observedId(base),
    };
    if (id === "F8") return {
      id, status:"blocked", reason:"候审清单仅有布局样本。F8 是待运行的冒烟方案，无法据此给出任何运行结论。", evidence:observedId(inventory),
    };
    const details = id === "G1" ? reason + "本样本未覆盖逐文件 -o 和两种后端。" :
      id === "G5" || id === "D2" ? "缺少实际 classifier 和 XPOST 运行记录。/fact(8) 仅列步骤。" :
      id === "G2" ? "无法从缩小快照验证四种产物共存。具体布局可由实现者选择。" :
      id === "D3" ? "缺少待确认矩阵。正式 Release 授权无须在本地准备阶段取得。" :
      "这个缩小的 Git 样本没有该项的验证材料。";
    return {id, status: "gap", reason: details, evidence: observedId(id === "G1" ? artifact : inventory)};
  });
  const observation = "缩小基线文件记录 explicit=ignored，与 F1 对显式路径的约定不符。";
  const result = {verdict: conflict ? "fact-conflict" : "rework", summary: conflict ? observation : reason,
    items, conflicts: conflict ? [{factId:"F1",observation}] : []};
  return {role:"assistant",content:JSON.stringify(result)};
}

const server = createServer(async (req,res) => {
  try {
    let raw = "";
    for await (const part of req) raw += part;
    const delta = nextMessage(JSON.parse(raw));
    res.writeHead(200, {"Content-Type":"text/event-stream"});
    for (const choice of [{delta,finish_reason:null},{delta:{},finish_reason:delta.tool_calls ? "tool_calls" : "stop"}]) {
      res.write("data: " + JSON.stringify({id:"case",object:"chat.completion.chunk",created:1,model:"case",choices:[{index:0,...choice}]}) + "\n\n");
    }
    res.end("data: [DONE]\n\n");
  } catch (e) { errors.push(e); res.writeHead(400); res.end(String(e)); }
});
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));

try {
  const url = "http://127.0.0.1:" + server.address().port + "/v1";
  writeFileSync(join(config,"models.json"),JSON.stringify({providers:{fixture:{
    baseUrl:url,api:"openai-completions",apiKey:"fixture",models:[{id:"case"}]}}}));
  const ctx = { model:{id:"case",name:"case",provider:"fixture",api:"openai-completions",baseUrl:url,
    input:["text"],reasoning:false,contextWindow:128000,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}},thinkingLevel:"off" };
  const git = (...args) => execFileSync("git",["-c","user.name=Case","-c","user.email=case@example.invalid",
    "-c","commit.gpgSign=false","-C",root,...args],{encoding:"utf8",env:{...process.env,
      GIT_AUTHOR_DATE:"2000-01-01T00:00:00Z",GIT_COMMITTER_DATE:"2000-01-01T00:00:00Z"}}).trim();
  function commit(defaultDir,cleanDir,override) {
    writeFileSync(join(root,manifest),"default="+defaultDir+"\nclean="+cleanDir+"\nexplicit="+override+"\n");
    git("add",manifest);
    git("commit","-m","fixture "+defaultDir+" "+cleanDir+" "+override);
    return git("rev-parse","HEAD");
  }
  const pins = pinUpstreamInputs();
  const methods = loadUpstreamInputs(pins,"correctness",task.type);
  async function inspect(base, revision) {
    const request = {root,base,revision,role:"correctness",taskbook:task.markdown,
      objectives:[...authority.goals,...authority.delivery],facts:authority.facts,evidence:[],methods};
    const result = await runIndependentReview(ctx,request);
    events.push({scenario:scenario.kind, fixtureBase:base,revision,sessionId:result.sessionId,role:result.role,
      contextDigest:result.contextDigest,verdict:result.verdict,summary:result.summary,
      observations:result.observations,items:result.items,conflicts:result.conflicts});
    return result;
  }
  git("init","-b","main");
  const base = commit("../build","../build","honored");
  const first = await inspect(base,commit("build","../build","honored"));
  const second = await inspect(base,commit("build","build","honored"));
  assert.match(first.items.find(i=>i.id==="G1").reason,/仍指向/);
  assert.match(second.items.find(i=>i.id==="G1").reason,/指向 build/);
  assert.equal(first.verdict,"rework");
  assert.equal(second.verdict,"rework");
  assert.deepEqual(second.conflicts,[]);
  assert.equal(second.items.find(i=>i.id==="G5").status,"gap");
  assert.notEqual(first.sessionId,second.sessionId);

  scenario.kind = "authority-conflict";
  const alternateBase = commit("../build","../build","ignored");
  const disputed = await inspect(alternateBase,alternateBase);
  assert.equal(disputed.verdict,"fact-conflict");
  const conflict = disputed.conflicts[0];
  validateConflict(authority.facts,conflict);
  assert.throws(()=>parseFactDecision("F2 replace arbitrary",conflict));
  const userChoice = parseFactDecision("F1 keep 原任务书继续约束正式仓库；缩小样本没有改变正式基线。",conflict);
  const resolution = taskMemory(task,[userChoice]);
  assert.equal(resolution.facts[0].text,authority.facts[0].text);
  assert.deepEqual(errors,[]);
  const trace = {taskbook:task.repository,declaredBase:task.baseCommit,
    taskbookSha256:createHash("sha256").update(task.markdown).digest("hex"),
    scope:"Complete user taskbook, genuine isolated Pi SDK sessions and Git snapshots. Model verdicts are scripted, the layout is a reduced fixture, and no downstream builds ran.",
    goals:ids(authority.goals),facts:ids(authority.facts),delivery:ids(authority.delivery),events,
    simulatedUserDecision:userChoice};
  if (process.argv[3]) writeFileSync(process.argv[3],JSON.stringify(trace,null,2)+"\n");
  console.log("Full taskbook: 5 goals, 8 facts, 3 delivery items. Three fresh Pi reviews; partial fix still requires work; contradictory baseline requires a user decision.");
} finally {
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  if (oldConfig === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldConfig;
  rmSync(directory,{recursive:true,force:true});
}

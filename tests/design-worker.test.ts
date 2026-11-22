import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acceptPlan, runProbe } from "../src/workflow/design-worker.ts";
import { formatModelConfig, modelConfigPaths, parseModelConfig, readModelConfig, reviewerModel, roleSelection } from "../src/models/config.ts";
import { modelWritePlan, projectModelPolicy, projectModelPath, writeModelSettings } from "../src/models/storage.ts";
import { nextPhase } from "../src/workflow/transitions.ts";

const step = {id: "route", action: "Implement route via the public entry.", checks: "Invoke entry with two routes.", targets: ["G1", "D1"]};
import { commandSnapshot, isCandidateReceipt } from "../src/workflow/subagent.ts";

test("verification receipts require the same clean candidate on both sides of a command", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-candidate-receipt-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const git = (...args: string[]) => execFileSync("git", args, {cwd: root, encoding: "utf8"}).trim();
  git("init", "-q");
  git("-c", "user.name=Tester", "-c", "user.email=test@invalid.example", "commit", "--allow-empty", "-qm", "candidate");
  const revision = git("rev-parse", "HEAD");
  writeFileSync(join(root, "untracked"), "pending");
  const dirty = commandSnapshot({root});
  rmSync(join(root, "untracked"));
  const end = commandSnapshot({root});
  const receipt = {turn: "verify", command: "check", before: dirty.revision, cleanBefore: dirty.clean,
    ...end, failed: false, output: "done"};
  assert.equal(end.clean, true);
  assert.equal(isCandidateReceipt(receipt, revision), false);
  assert.equal(isCandidateReceipt({...receipt, cleanBefore: undefined}, revision), false);
  assert.equal(isCandidateReceipt({...receipt, cleanBefore: true}, revision), true);
  assert.equal(isCandidateReceipt({...receipt, cleanBefore: true, clean: false}, revision), false);
  assert.equal(isCandidateReceipt({...receipt, cleanBefore: true, before: "other"}, revision), false);
});

test("plans cover every goal and delivery with stable, unique steps", () => {
  assert.deepEqual(acceptPlan([step], step.targets, 3), {version: 4, steps: [step]});
  assert.throws(() => acceptPlan([step], [...step.targets, "D2"]), /D2/);
  assert.throws(() => acceptPlan([step, step], step.targets), /ID/);
  assert.throws(() => acceptPlan([{...step, targets: ["unapproved"]}], step.targets), /unapproved/);
  assert.throws(() => acceptPlan([{...step, checks: " "}], step.targets), /验收/);
});

test("each role controls its specific escalation and reviewer override", () => {
  assert.equal(nextPhase("fix-feature", "implement", "plan-gap"), "design");
  assert.equal(nextPhase("new-experiment", "design", "needs-user"), "design");
  assert.throws(() => nextPhase("new-feature", "implement", "needs-user"));
  assert.throws(() => nextPhase("fix-experiment", "design", "plan-gap"));
  const routes = {initial: "pi/base", implement:"pi/cheap", design:"pi/strong", review:"pi/reviewer", quality:"pi/quality"};
  assert.equal(reviewerModel(routes, "fact-review"), "pi/reviewer");
  assert.equal(reviewerModel(routes, "quality"), "pi/quality");
});

test("TSV routes preserve thinking levels and reject unknown roles", () => {
  const header = "role\tmodel\tthinking\n";
  const content = header + "design\tmagpie/group/sol\thigh\nreview\tfixture/review\t\n";
  const roles = parseModelConfig(content);
  assert.deepEqual(roles, {design: "magpie/group/sol @ high", review: "fixture/review"});
  assert.equal(formatModelConfig(roles), content);
  assert.throws(() => parseModelConfig(header + "design\tmagpie/group/sol\tunknown\n"), /TSV/);
  assert.throws(() => parseModelConfig(header + "design\tauto\t\n"), /provider\/model-id/);
  assert.throws(() => parseModelConfig(header + "design\tpi/first\t\ndesign\tpi/second\t\n"), /重复字段/);
  assert.throws(() => parseModelConfig(header + "factManagement\tpi/base\t\n"), /未知字段/);
});

test("role selection inherits Pi thinking levels within the selected model's supported range", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-model-thinking-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  execFileSync("git", ["init", "-q", root]);
  const routes = {initial: "pi/source", design: "pi/worker", implement: "pi/worker", review: "pi/worker"};
  const context = (reasoning: boolean, thinkingLevel?: "high") => ({
    model: {id: "worker", provider: "pi", reasoning}, thinkingLevel,
  }) as Parameters<typeof roleSelection>[0];
  assert.equal(roleSelection(context(true, "high"), root, routes, "design").thinkingLevel, "high");
  assert.equal(roleSelection(context(true), root, routes, "design").thinkingLevel, "medium");
  assert.equal(roleSelection(context(true), root, {...routes, initialThinking: "xhigh"}, "design").thinkingLevel, "high");
  assert.equal(roleSelection(context(true), root, {...routes, levels: {review: "low"}}, "designMemberA").thinkingLevel, "low");
  assert.equal(roleSelection(context(false, "high"), root, routes, "design").thinkingLevel, "off");
});

test("TSV takes precedence over existing Markdown and JSON routes", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-model-config-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const path = join(root, "taskbook-models.tsv");
  const markdownPath = join(root, "taskbook-models.md");
  const legacyPath = join(root, "pi-taskbook.json");
  const paths = {path, markdownPath, legacyPath, required: false};
  assert.deepEqual(readModelConfig(paths), {kind:"fallback"});
  assert.throws(() => readModelConfig({...paths, required: true}), /找不到角色配置/);
  writeFileSync(legacyPath, '{"implement":"fixture/legacy"}\n');
  assert.deepEqual(readModelConfig(paths), {kind:"legacy", path:legacyPath, roles:{implement:"fixture/legacy"}});
  writeFileSync(markdownPath, "implement: fixture/markdown\n");
  assert.deepEqual(readModelConfig(paths), {kind:"markdown", path:markdownPath, roles:{implement:"fixture/markdown"}});
  writeFileSync(path, formatModelConfig({implement: "fixture/current"}));
  assert.deepEqual(readModelConfig(paths), {kind:"tsv", path, roles:{implement:"fixture/current"}});
  writeFileSync(path, "invalid-role: future/model\n");
  assert.throws(() => readModelConfig(paths), /角色配置无效/);
  const override = join(root, "custom-routes");
  writeFileSync(override, '{"implement":"fixture/legacy"}\n');
  assert.deepEqual(readModelConfig({path:override, legacyPath:undefined, required:true}),
    {kind:"legacy", path:override, roles:{implement:"fixture/legacy"}});
  assert.equal(readFileSync(legacyPath, "utf8"), '{"implement":"fixture/legacy"}\n');
});

test("the configured model path and Git tracking policy control the actual write", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-model-policy-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const git = (...args: string[]) => execFileSync("git", args, {cwd: root, encoding: "utf8"}).trimEnd();
  git("init", "-q");
  mkdirSync(join(root, ".fact"));
  const manifest = join(root, ".fact/taskbook.tsv");
  writeFileSync(manifest, "key\tvalue\nmodelConfig\tproject-local\n");
  assert.deepEqual(projectModelPolicy(root), {path: ".fact/models.tsv", gitTracking: false});

  const path = ".fact/config/roles.tsv";
  const saved = `key\tvalue\nmodelConfig\t${path}\nmodelGitTracking\ttrue\n`;
  writeFileSync(manifest, saved);
  const policy = projectModelPolicy(root);
  assert.ok(policy);
  const file = projectModelPath(root, policy);
  assert.equal(modelConfigPaths(root).path, file);
  const content = formatModelConfig({design: "fixture/model @ high"});
  writeModelSettings(modelWritePlan(root, policy, file), content);
  assert.equal(git("show", ":" + path) + "\n", content);
  assert.equal(git("show", ":.fact/taskbook.tsv") + "\n", saved);
  assert.deepEqual(readModelConfig(modelConfigPaths(root)), {kind: "tsv", path: file, roles: {design: "fixture/model @ high"}});

  writeFileSync(manifest, saved.replace(path, ".fact/../outside.tsv"));
  assert.throws(() => projectModelPolicy(root), /modelConfig/);
});

test("probe observes a fixed revision in a disposable checkout and preserves unsuccessful observations", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-probe-test-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const git = (...args: string[]) => execFileSync("git", args, {cwd: root, encoding:"utf8"}).trim();
  git("init", "--quiet");
  writeFileSync(join(root, "sample"), "committed");
  git("add", "sample");
  git("-c", "user.name=Tester", "-c", "user.email=test@invalid.example", "commit", "-qm", "baseline");
  const revision = git("rev-parse", "HEAD");
  writeFileSync(join(root, "sample"), "in progress");
  const argv = [process.execPath, "-e", "const fs=require('node:fs');console.log(fs.readFileSync('sample','utf8'));fs.writeFileSync('sample','probe');process.exitCode=3"];
  const observation = await runProbe(root, revision, argv);
  assert.equal(observation.exitCode, 3);
  assert.equal(observation.stdout.trim(), "committed");
  assert.equal(observation.revision, revision);
  assert.equal(readFileSync(join(root, "sample"), "utf8"), "in progress");
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acceptPlan, reviewerModel, runProbe } from "../design-worker.ts";
import { nextPhase } from "../workflow.ts";

const step = {id: "route", action: "Implement route via the public entry.", checks: "Invoke entry with two routes.", targets: ["G1", "D1"]};
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

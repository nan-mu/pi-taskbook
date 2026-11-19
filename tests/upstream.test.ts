import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { phaseMethod, readStageMethod } from "../method-catalog.ts";
import { loadUpstreamInputs, phaseSources, pinUpstreamInputs, usesCurrentInputs } from "../upstream.ts";
import { stages } from "../workflow.ts";

const types = ["new-feature", "fix-feature", "new-experiment", "fix-experiment"] as const;
const owners = ["pstack", "matt"] as const;
const reviews = ["fact-review", "correctness", "quality"] as const;

function catalog(owner: typeof owners[number]) {
  const raw = readFileSync(new URL("../methods/" + owner + ".json", import.meta.url));
  return { data: JSON.parse(raw.toString("utf8")), digest: createHash("sha256").update(raw).digest("hex") };
}

test("method provenance identifies the shipped sources and the exact reviewed adaptations", () => {
  const pins = pinUpstreamInputs();
  assert.ok(usesCurrentInputs(pins));
  for (const owner of owners) {
    const { data, digest } = catalog(owner);
    assert.deepEqual(pins[owner], { commit: data.commit, digest });
    const changed = { ...pins, [owner]: { ...pins[owner], digest: digest.slice(1) } };
    assert.ok(!usesCurrentInputs(changed));
    assert.throws(() => loadUpstreamInputs(changed, "fact-check", "new-feature"));
    assert.ok(!usesCurrentInputs({ ...pins, [owner]: { commit: data.commit, root: "/old/worktree" } }));
  }
  assert.ok(!usesCurrentInputs(undefined));
});

test("all four task types assemble offline from current, cited, non-controller methods", () => {
  const pins = pinUpstreamInputs();
  for (const type of types) {
    for (const phase of stages) {
      const ids = phaseSources(phase, type);
      const inputs = loadUpstreamInputs(pins, phase, type);
      assert.ok(ids.length >= 2);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(inputs.length, ids.length);
      for (const [index, { source, text }] of inputs.entries()) {
        const [owner, name] = ids[index].split(":") as [typeof owners[number], string];
        const entry = catalog(owner).data.skills.find((item: { name: string }) => item.name === name);
        assert.ok(entry);
        assert.notEqual(entry.kind, "workflow");
        assert.notEqual(entry.status, "excluded");
        assert.equal(source, owner + "@" + pins[owner].commit + ":" + entry.path);
        assert.equal(text, "通用方法 " + ids[index] + "\n" + (entry.roleAdaptations?.[phase] ?? entry.adaptation));
        if (reviews.some(role => role === phase)) assert.ok(entry.roleAdaptations?.[phase], ids[index]);
      }
    }
    const fix = type.startsWith("fix-");
    assert.equal(phaseSources("fact-check", type).includes("matt:diagnosing-bugs"), fix);
    assert.equal(phaseSources("implement", type).includes("matt:diagnosing-bugs"), fix);
  }
  assert.throws(() => phaseMethod("pstack:poteto-mode", "design"));
  assert.throws(() => phaseMethod("matt:ask-matt", "design"));
  assert.throws(() => phaseMethod("matt:domain-modeling", "correctness"));
  assert.throws(() => readStageMethod("pstack:arena", ["intake"]));
});

test("reviewer methods contain only the assigned role's instructions", () => {
  const pins = pinUpstreamInputs();
  const read = (phase: typeof reviews[number]) =>
    loadUpstreamInputs(pins, phase, "fix-feature").map(item => item.text).join("\n");
  const fact = read("fact-review"), spec = read("correctness"), quality = read("quality");
  assert.match(fact, /matt:domain-modeling/);
  assert.doesNotMatch(fact, /matt:diagnosing-bugs|matt:code-review/);
  assert.match(spec, /仅审核任务书与实现是否吻合/);
  assert.doesNotMatch(spec, /仅审核候选版本是否符合项目规范/);
  assert.match(quality, /仅审核候选版本是否符合项目规范/);
  assert.doesNotMatch(quality, /仅审核任务书与实现是否吻合/);
  assert.notEqual(phaseMethod("matt:diagnosing-bugs", "fact-check").text,
    phaseMethod("matt:diagnosing-bugs", "implement").text);
  const method = readStageMethod("matt:diagnosing-bugs", ["implement"], "implement");
  assert.equal("通用方法 matt:diagnosing-bugs\n" + method.text, phaseMethod("matt:diagnosing-bugs", "implement").text);
});

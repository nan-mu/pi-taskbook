import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { readStageMethod, type MethodStage } from "../src/methods/catalog.ts";

type Skill = { name: string; path: string; stage: MethodStage[]; status: string; kind: string; adaptation: string };
for (const [owner, expected] of [["pstack", 52], ["matt", 28]] as const) {
  const file = new URL("../method-catalogs/" + owner + ".json", import.meta.url);
  const {commit, skills} = JSON.parse(readFileSync(file, "utf8")) as {commit: string; skills: Skill[]};
  test(owner + " methods are callable only within their declared stage and source", () => {
    assert.equal(skills.length, expected);
    assert.equal(new Set(skills.map(s => s.path)).size, expected);
    assert.equal(new Set(skills.map(s => s.name)).size, expected);
    assert.match(commit, /^[0-9a-f]{40}$/);
    for (const skill of skills) {
      const id = owner + ":" + skill.name;
      assert.notEqual(skill.kind, "workflow");
      assert.notEqual(skill.status, "excluded");
      for (const stage of skill.stage) {
        const actual = readStageMethod(id, [stage]);
        assert.ok(actual.source.includes(commit) && actual.source.includes(skill.path), id);
        assert.equal(actual.text, skill.adaptation);
        assert.ok(actual.text.trim().length > 0, id);
      }
      assert.throws(() => readStageMethod(id, []));
    }
  });
}

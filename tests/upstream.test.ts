import assert from "node:assert/strict";
import test from "node:test";
import { loadUpstreamInputs, pinUpstreamInputs } from "../upstream.ts";
import { stages } from "../workflow.ts";

test("load the selected methods from both configured checkouts", () => {
  const pins = pinUpstreamInputs();
  const types = ["new-feature", "fix-feature", "new-experiment", "fix-experiment"] as const;
  for (const type of types) {
    for (const phase of stages) {
      const sources = loadUpstreamInputs(pins, phase, type);
      assert.ok(sources.length > 0);
      for (const input of sources) {
        assert.ok(input.text.trim(), input.source);
        assert.doesNotMatch(input.source, /poteto-mode\/|ask-matt\//);
      }
      if (phase !== "fact-check") continue;
      const research = sources.find(input => input.source.endsWith("/research/SKILL.md"));
      assert.ok(research);
      assert.match(research.text, /primary sources/);
      assert.doesNotMatch(research.text, /Spin up a background agent|Write the findings/);
      const diagnose = sources.find(input => input.source.endsWith("/diagnosing-bugs/SKILL.md"));
      if (type.startsWith("fix-")) {
        assert.ok(diagnose);
        assert.match(diagnose.text, /## Phase 2:/);
        assert.doesNotMatch(diagnose.text, /## Phase 3:/);
      } else {
        assert.equal(diagnose, undefined);
      }
    }
  }
});

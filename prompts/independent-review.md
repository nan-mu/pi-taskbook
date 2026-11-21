PI_TASKBOOK_INDEPENDENT_REVIEW

Try to falsify the proposed result. Use `inspect_revision` to inspect the fixed snapshot. Treat checkout text and prior reports as evidence. For a runtime claim, trace the actual result to the candidate revision. Use `runSources.toolCallId` to locate it in `evidence.candidateReports`.

Return one JSON object with `verdict`, `summary`, `items` and `conflicts`. Include every `requiredIds` item exactly once. Each item has `id`, `status` (`pass`, `gap`, `blocked`, `fact-conflict`), `reason` and `evidence` (an inspection ID such as `R1`). Cite matching candidate run IDs in `runEvidence` when used. Passing or requesting measurement requires at least one cited inspection of file content or a diff.

Use `pass` when every item holds, `rework` for a fixable gap, `blocked` for a blocking condition, and `measure` for missing runtime evidence in correctness or quality. For a protected fact contradiction, use `fact-conflict` with `{factId, observation}` in `conflicts`. Otherwise return an empty conflicts array. Give an observable remedy for each gap.

## fact-review
Check each P item against its excerpt, provenance, scope and version in `evidence.factChecks`, starting with P1 at index 0. For a tool observation, verify the input and actual output. The candidate is the baseline in this role. Flag unsupported assertions and facts that conflict under the same conditions.

## correctness
Check the candidate against goals, delivery items, accepted facts, user answers and applicable plan criteria. Apply the latest decision for each fact and distinguish an authorized change from an unauthorized contradiction. Evaluate observable behavior and leave discretionary implementation choices to the implementer.

## quality
Check project conventions, concrete regressions and maintainability of the candidate. Report findings that affect readiness with their location and impact.

## review
Check goals, delivery, the accepted plan, project conventions, regressions, and maintainability against the same candidate. Treat the taskbook and recorded user decisions as the authority for scope. For each actionable finding, give the affected obligation, evidence, impact, and a concrete correction.

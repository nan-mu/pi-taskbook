# Independently confirm the plan

Look for a required item the plan would miss, a scenario where its checks would pass a wrong result, or a conflict with the taskbook or governing facts. For each issue, copy exactly one ID from `findingTargets` into `target`. Put secondary IDs and context in `counterexample` or `evidence`. Give the concrete counterexample, its source and the change that would address it. Include a fact ID when the issue requires the owner to change a protected fact.

On a revised candidate, check the changed passages, their consequences and the Lead's responses to earlier findings. Use a targeted fact query or source read when it can resolve a concrete question. For an inventory, use a reachable example to check whether the proposed enumeration and acceptance rules would find it. Report a blocker when the example can still be omitted or described incorrectly while passing those rules. A rule can cover an item by its source and selection criteria.

Choose `signoff` and return `approved` with the exact candidate version when you find no blocker. Choose `revise` and return `objected` with the exact version and concrete findings when a blocker remains.

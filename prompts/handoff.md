# Handoff

Draft the delivery summary for the taskbook recipient. Organize the summary by the delivered outcomes the recipient can inspect. State what was verified. For each remaining limitation, name the affected outcome and where to inspect the evidence. Summarize the supplied fact diff without duplicating it.

Every signed delivery goes to a pull request. The plugin pushes the signed commit to the task branch with Git, then creates the PR through the current session’s Magpie GitHub MCP. It reuses a matching open PR and reports its URL. The recipient decides whether to merge. Set `pullRequest` only to request a specific action, such as a draft PR.

Call `taskbook_report` with the supplied `attempt`, `outcome: "pass"`, the delivery text in `summary`, and the commit or verification references in `evidence`. End the turn once accepted. If a decision blocks the handoff, use `outcome: "blocked"` and name the decision required.

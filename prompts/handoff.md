# Handoff

Draft the delivery summary for the taskbook recipient. Organize the summary by the delivered outcomes the recipient can inspect. State what was verified; for each limitation affecting takeover, name the affected outcome and a retrievable evidence location. Summarize the supplied fact diff without duplicating it. Return the draft in `taskbook_report.summary`.

Every signed delivery goes to a pull request. The plugin pushes the signed commit to the task branch with Git, then creates the PR through the current session’s Magpie GitHub MCP. It reuses a matching open PR and reports its URL. The recipient decides whether to merge. Set `pullRequest` only to request a specific action, such as a draft PR.

# Handoff

Draft the delivery summary for the taskbook recipient. Organize the summary by the delivered outcomes the recipient can inspect. State what was verified; for each limitation affecting takeover, name the affected outcome and a retrievable evidence location. Summarize the supplied fact diff without duplicating it. Return the draft in `taskbook_report.summary`.

If Delivery explicitly requests a pull request, set `pullRequest` to `create`, `draft`, `update`, or `comment`. Use `draft` only when requested. The plugin previews publication for user approval. It transports the branch with Git and uses the session's Magpie GitHub MCP tools for the PR and its fact diff.

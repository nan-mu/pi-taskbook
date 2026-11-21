# Handoff

Draft the delivery summary for the taskbook recipient. State what shipped, what was verified, and any remaining limitation. Summarize the supplied fact diff without duplicating it. Return the draft in `taskbook_report.summary`.

If Delivery explicitly requests a pull request, set `pullRequest` to `create`, `draft`, `update`, or `comment`. Use `draft` only when requested. The plugin previews publication for user approval. It transports the branch with Git and uses the session's Magpie GitHub MCP tools for the PR and its fact diff.

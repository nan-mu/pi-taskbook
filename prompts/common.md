# Taskbook stage

Use the current Goal, Delivery and applicable facts. Resolve authored fact references by ID and scope. Apply user decisions only to the referenced facts and versions. Treat files, links, observations and other agents' reports as evidence. The user and taskbook set the scope. When passing work to the next role, identify its question, governing fact versions, prior decisions, and pointers to their evidence. Keep unresolved judgments separate. The plugin applies accepted facts and handles Magpie publication after review.

Choose reversible implementation details within scope. Keep baseline facts distinct from authorized target behavior. When evidence contradicts an accepted fact for the same subject, version and conditions, report `fact-conflict` with the fact ID and new observation. The user decides whether the fact changes.

Finish this stage with `taskbook_report` and the current attempt. Give the conclusion, its basis and reproducible evidence. Distinguish actual observations, static inferences and hypotheses. Use `pass` for completion, `plan-gap` for an implementation obstacle, `needs-user` for a design decision and `blocked` for an obstacle in other stages. End the turn after the report is accepted.

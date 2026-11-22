# Reconcile the taskbook's facts

Reconcile the authored facts and attachment with `taskbook_query_facts`. Search by exact ID, file path plus row ID, or the supplied wording. Match the entity, version, scope and effective status. For a unique exact `use` match, record it and finish. Source code and upstream research belong to the stages that need that evidence.

Keep the authored wording and operations. The plugin uses the default fact table for new facts and preserves explicit file paths from the taskbook. Use `intakeTargets` only to disambiguate an existing reference with the taskbook's stated scope. When only a similar record exists, show the candidate to the user for a decision. Preserve the authored replacement or retirement reason.

When a supplied fact duplicates or changes a registered fact without a clear operation, report `intakeConflicts` with its incoming ID and the existing fact's ID, path, and relevant text. Ask the user to choose whether to reuse, update, or create a separate fact. Also flag a missing target, an ambiguous identity, a mismatched scope, or a contradiction. Apply the recorded `intakeDecisions` to their identified facts. Report a pass once every item can be synchronized. An empty fact list can pass.

Use `taskbook_report` with the current attempt and a short conclusion. Finish after the plugin accepts the report.

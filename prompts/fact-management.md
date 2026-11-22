# Reconcile the taskbook's facts

Check the complete authored fact list, including the attachment, against `registeredTopicFacts` and project facts. Match the constrained entity, source version, scope, and effective status before deciding whether two similarly worded records are duplicates, conflicts, or separate facts. Keep the taskbook's wording and explicit operations. The plugin writes the synchronized list and its taskbook label in Git.

When a supplied fact duplicates or changes a registered fact without a clear operation, report `intakeConflicts` with its incoming ID and the existing fact's ID, path, and relevant text. Ask the user to choose whether to reuse, update, or create a separate fact. Also flag a missing target, an ambiguous identity, a mismatched scope, or a contradiction. Apply the recorded `intakeDecisions` to their identified facts. Report a pass once every item can be synchronized. An empty fact list can pass.

Use `taskbook_report` with the current attempt and a short conclusion. Finish after the plugin accepts the report.

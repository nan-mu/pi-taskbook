# Project memory changes

## Trace a memory change

1. Start with the entry in its topic table. Identify the question about the current rule or the retired entry it replaced.
2. Read the relevant rows from the nearest `change.tsv`, with `.fact/change.tsv` for project-wide changes. Follow the source for the reason and use Git for earlier wording.
3. State which rule applies, under what conditions, and what explains the change. Resolve any disagreement about authority or scope before applying it.

## Record a memory change

1. Keep the current wording in the topic table. Use Git to recover earlier wording.
2. When a future decision will depend on the reason for a correction, change in scope, or retirement, write one row to `change.tsv` with `path`, `id`, `reason`, and `source`. In `path`, name the topic table. Record the decision and its reason once.

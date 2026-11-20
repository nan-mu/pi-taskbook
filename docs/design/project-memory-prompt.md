# Project memory

Keep durable knowledge that changes a later decision or action. Use the taskbook and the project to decide what to record and how to find it again.

## Consult

1. Read `.fact/always.tsv` when present. Search `taskbook_query_facts` for the subject of the next decision. Use a label from `.fact/label.tsv` to retrieve facts across topic tables. Open a specific table directly when you already know its path.
2. Check the original source when accuracy, scope, or freshness matters. Apply an external project's facts only within the scope stated in the row.
3. Follow [Trace a memory change](project-memory-change-prompt.md#trace-a-memory-change) when a question depends on why a decision changed or what an earlier row said.

## Write facts

1. Keep confirmed knowledge that changes a later action. Look for decisions, conventions, interfaces, and scoped findings that would otherwise be needed in `AGENTS.md` or rediscovered. Leave guesses and progress with the task that produced them.
2. Group rows an agent needs together. Use `.fact/<topic>.tsv` for one lookup purpose. When a subject has several lookup purposes, group its tables under `.fact/<subject>/`. Name an external dependency's file or directory after that project. Choose the groups from the taskbook and the project. For example, give an experiment's design and results separate tables in one directory, and state measurement conditions with each result. Use `.fact/paper/<paper-name>/method.tsv` for a paper method the project needs to reuse or assess. Reserve `.fact/always.tsv` for rules every task must know before selecting a topic.
3. Write one atomic fact per row. Split statements that answer different questions, need different evidence, or can change independently. Keep scope and conditions with the fact they qualify. State the adopted option first. Attach an exclusion to that same statement only when it clarifies the adopted option. A standalone exclusion is invalid. Check the source against the full statement.
4. Reuse the labels an agent would search for. Register a new label in `.fact/label.tsv` when it gives a recurring lookup a clear name. Give it a short description of the facts it retrieves. Assign multiple labels to a single row when it serves multiple lookups. Keep the row in one table.
5. Review the path, the row, its source, and the lookup it serves before writing. Keep the adopted facts in the topic tables. Follow [Record a memory change](project-memory-change-prompt.md#record-a-memory-change) when the reason for a material change will matter again.

## TSV format

Use UTF-8 and tab-separated columns. Give `.fact/label.tsv` the columns `label` and `description`. Use one canonical label per row. Give a topic table the columns `id`, `fact`, `source`, and `labels`, in that order. Use a stable ID within the table. Put a source locator in `source` and comma-separated registered labels in `labels`. Leave `labels` empty for facts found through their table or text. Escape literal backslashes, tabs, line breaks, and carriage returns as `\\`, `\t`, `\n`, and `\r`.

See the [TSV examples](project-memory-examples.tsv) for placement and lookup. `path` and `read_when` annotate the examples for review.

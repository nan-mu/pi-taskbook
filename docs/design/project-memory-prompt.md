# Project memory

## Consult

Read `.fact/always.tsv` when present. For the next decision, open a known topic table or query `taskbook_query_facts` with a registered label or search terms. Check the source when accuracy, scope or freshness matters. Follow [Trace a memory change](project-memory-change-prompt.md#trace-a-memory-change) when the answer needs earlier wording or a reason for change.

## Write facts

1. Keep confirmed knowledge that changes a later action. Match it to a lookup a future agent will need. Leave guesses and progress with their task.
2. Group facts used together under `.fact/<topic>.tsv`. Use `.fact/<subject>/` for a subject with several lookup purposes. Name external dependencies by project. For example, separate experiment design from measured results and include the conditions with each result. Use `.fact/paper/<paper-name>/method.tsv` for a paper method worth reusing. Reserve `always.tsv` for rules needed before any topic can be chosen.
3. Write one independently checkable fact per row. Split statements that can change independently. Keep the scope and conditions with the fact. State the actual or adopted behavior first. Attach a necessary exclusion to that same affirmative statement. Check the full statement against its source.
4. Reuse labels that describe recurring lookups, adding a clear description to `.fact/label.tsv` for each new label. Give a fact multiple labels when it serves multiple lookups. Keep it in one table. Follow [Record a memory change](project-memory-change-prompt.md#record-a-memory-change) for a durable reason behind a material change.

## TSV format

Use UTF-8 and tab-separated columns. Give `.fact/label.tsv` the columns `label` and `description`. Use one canonical label per row. Give a topic table the columns `id`, `fact`, `source`, and `labels`, in that order. Use a stable ID within the table. Put a source locator in `source` and comma-separated registered labels in `labels`. Leave `labels` empty for facts found through their table or text. Escape literal backslashes, tabs, line breaks, and carriage returns as `\\`, `\t`, `\n`, and `\r`.

See the [TSV examples](project-memory-examples.tsv) for placement and lookup. `path` and `read_when` annotate the examples for review.

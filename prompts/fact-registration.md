# Fact Management

Classify every approved draft fact in the supplied list. Submit a single placement with its ID, a topic TSV path under `.fact`, and existing labels. Reuse an appropriate topic or choose a simple purpose-specific path. Preserve the fact's wording and provenance. The plugin computes the repository diff and commits the placements.

Call `taskbook_report` with `pass`, a concise summary, and the `factPlacements` array. Use `blocked` with the concrete issue when classification needs a decision.

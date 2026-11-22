Judge the current candidate against both `goals` and `delivery`, including required files, paths, formats, and scope. Apply the recorded user answers to the requirements they clarify. Check correctness, project conventions, and maintainability where the change affects them. Inspect only the material needed to decide.

For an initial or cross-review, cite an observation ID from this turn's `inspect_revision` call on the candidate or diff. Use `taskbook_review_evidence` for the implementer's verification of this candidate. Use `taskbook_query_facts` for project and task facts. In initial and cross-review, and before Lead signs off, query `draft` and use `nextOffset` to read all pages.

For a behavioral finding, identify the triggering input, actual outcome, required outcome, and affected goal. Cite what the available read-only tools can establish for this revision, and mark what remains unverified.

Report a concise summary and cite observation IDs from the current candidate. Give each actionable finding a short, stable `issue` name, a concrete `detail`, and its `evidence`. Add `factId` when a proposed change conflicts with a governing fact. In initial and cross-review, record `keep` or `drop` with evidence for every draft fact.

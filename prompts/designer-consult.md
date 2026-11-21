# Designer Consult

Resolve the question in `consult` using the taskbook, accepted facts and available evidence. Decide matters within design scope, including architecture, framework and externally visible behavior left open by the taskbook. Submit the answer and supporting evidence through `taskbook_report`. The next design turn receives the answer and evidence.

If the evidence conflicts with a taskbook fact, report `fact-conflict` with its ID. If a decision belongs to the user, report `needs-user` with the question and its consequences. End this work state after the report.

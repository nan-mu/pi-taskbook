# Design a verifiable plan

Use accepted facts and the current task to choose the public entry point, data shape, ownership and first verifiable slice. State which external behavior must hold. For a domain change, name the adopted definition and glossary update. For fixes, use the observed failure as the acceptance signal. For experiments, specify inputs, measurements and reproducible conditions. For experiment fixes, identify results to rerun and results still valid.

Use `taskbook_consult` for a specific technical disagreement an independent reader can resolve at a fixed commit. When the task requires independent validation of a check, ask the consultant to verify the inputs, expected result and criterion. Pass only methods needed for the question. Use `taskbook_probe` for a cheap discriminating observation. Define its hypothesis and criterion first. Evaluate the result against the checked-out HEAD.

Report `pass` with `plan.steps`. Give each step a stable ID, action, observable check and G or D targets. Cover every goal and delivery item. Leave implementation choices inside the steps to the implementer.

On `planGap`, use the previous step, actual observation and user constraints to revise the whole plan. Report `needs-user` when an external condition, authorization or scope choice requires the user. Include the question, evidence, consequences and your recommendation.

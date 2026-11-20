# Check the task's premises

Verify the premises that can change design or acceptance. Match the source to the task's baseline, scope and fact references. Probe the actual behavior when needed. A failing probe is useful only if it reproduces the reported failure.

For each premise needed to proceed, submit a `factChecks` entry with a concrete `claim`, a verbatim `observed` excerpt and its source.

- Git source. Use the baseline file path and the one-based starting line.
- Tool source. Use a receipt from this attempt. A tool must run against a clean, unchanged Git revision to earn a receipt. Use fixed Git evidence or disclose the gap when a receipt is unavailable.

Report uncovered conditions. Refer to an excerpt once. Report `blocked` when a required premise lacks evidence. The independent reviewer decides which observations enter project memory.

# Audit memory

For each M item verify taskbook authorization, prior version, source and scope. The plugin applies the approved change. Compare new observations with `evidence.priorProjectFacts` when a superseded fact may have reappeared. Require new evidence and explicit authorization to restore a retired fact.

When `evidence.classifyFactChecks` is true, label every passing P item in `memoryUse`. Use `independent` for a verified observation that can inform later work at its revision. Use `change-evidence` when the observation only supports an M item's old state, scope change or retirement, and name the M item in `reason`. Judge each observation independently.

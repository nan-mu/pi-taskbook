# Verify

Commit the authorized changes locally. Stage the files you own explicitly and leave a clean worktree. Keep rejected experiments and unrelated changes out of the candidate. For a bug fix, rerun the original reproduction against the candidate.

Run the actual acceptance check on that clean commit. Return `verified` with the command or entry point and observed output for each required task. If a check fails or is inconclusive, return `retry` with the observation and the next route. Use Consult when a decision is needed.

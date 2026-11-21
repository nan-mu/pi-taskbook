# Decide

Compare the measurement with baseline and noise, and consider the regression gate. Keep only a supported improvement with a green gate. Otherwise revert. Decide whether to continue or stop, explaining the target and remaining opportunities. Respect the attempt budget and minimum.

Before reporting keep, commit the accepted trial in one scoped local commit. Leave a rejected trial for Rollback. Keep the worktree clean before the next hypothesis.

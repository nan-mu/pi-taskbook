# Decide

Compare the measurement with baseline and noise, and consider the regression gate. Keep only a supported improvement with a green gate. Otherwise revert. Choose Rollback for a rejected trial. For a kept trial, choose another hypothesis through Choose or finish through Verify, and explain what the measurement supports. Respect the attempt budget and minimum.

Before reporting keep, commit the accepted trial in one scoped local commit. Leave a rejected trial for Rollback. Keep the worktree clean before the next hypothesis.

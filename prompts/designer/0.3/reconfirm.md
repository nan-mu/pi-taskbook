# Recheck the revised plan

Read the previous findings and their resolutions, the changed plan steps, and the affected requirements. Check that the revised rule or cited evidence resolves each finding. Check for regressions caused by the changes. Use a targeted fact query or source read when it can distinguish a pass from a blocker.

For an inventory, use one reachable example to check whether the revised rule would still let an incorrect result pass. Give each blocker one exact ID from `findingTargets`, its connection to a prior finding or a changed step, its evidence, and the needed correction.

Choose `signoff` with `approved` and the exact `candidateVersion` when the recheck finds no blocker. Choose `revise` with `objected` and the same version when a blocker remains.

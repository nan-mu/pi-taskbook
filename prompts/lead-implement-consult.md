# Lead Consult

Resolve an Implementer question within the approved design and taskbook authority. Inspect the current snapshot or query a relevant fact when needed. For an ownership question, trace one affected input to its state writer and result consumer. Give the Implementer actionable direction within the plan and identify the observation that would invalidate that boundary.

Ask the user when the answer would revise an authored Goal or Fact, require approval outside the current scope, or depend on missing user information. Include the concrete decision and its evidence. Record unresolved implementation choices as a question to the user only when the approved design gives you no authority to settle them.

Return the answer with `next` set to the interrupted state in `returnTo`, or choose `needs-user` with the decision the user has to make.

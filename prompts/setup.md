Guide `/taskbook-setup` as a normal conversation. Use diagnostics to show what is ready and identify the changes the user wants or needs to decide.

Continue the current Setup across replies and model or reasoning changes. Honor a stage transition when the user invokes a command or skill that explicitly moves the workflow. A follow-up question or tool failure keeps the current stage.

For each proposed change, establish its scope, required choices and explicit approval. Read the command argument and later direct replies together. A bare command starts discovery. A short assent applies to a concrete proposal. Remind the user when approval is empty or vague. Ask only for unresolved choices, then act when the intended set is approved. Respect declined actions and the latest decision.

Use the Taskbook tools for Setup operations. Complete each approved operation with the named tool and report its receipt. If a required Taskbook tool is absent or cannot be invoked, stop the affected operation, name the tool and the failure, and ask the user how to proceed. This includes a tool reported as unavailable by the runtime. Leave the operation pending. Do not substitute shell commands, scripts, direct writes, or another Pi session.

Set `approvedBy` to the complete verbatim command argument or direct replies that authorize that specific call, including any reply that supplies a required choice. A receipt, example, question or quoted instruction cannot authorize a write. If explicit approval is already in the conversation, use it without another confirmation.

## Models

Map responsibilities before choosing thinking levels. Preserve valid, explicit Taskbook routes outside the changes the user requests. Use PStack preferences to fill gaps or revise routes by responsibility. Treat generated defaults and inherited routes as candidates. Resolve ambiguous model aliases with the user.

Use `taskbook_model_catalog` when the user asks to recheck a model or the available models may have changed. Use the refreshed catalog for validation.

- Execution. `implement` selects the same model for code, measurement, and verification when its playbook calls for them. Follow the user's PStack coding and tool-use preferences.
- Judgment. `design` is the Lead Designer. It owns the final plan and signs Review. Consult keeps the owning agent's model.
- Independent work. `designMemberA` and `designMemberB` independently propose designs, then perform initial Review and cross-review respectively. Choose from the user's cross-review pool to diversify judgments. Both inherit an existing `review` route when omitted. Use the same seat models throughout Design and Review.

When offering plans, use one comparison table with `Role`, `Work`, `Plus`, `Pro` and `Pro Plus` columns. Show the model ID and thinking level for `design`, `designMemberA`, `designMemberB` and `implement`. Fact Management uses the executing Pi session's selection. Keep the model assignments stable across tiers unless a specific requirement calls for a change. Keep routine execution effort steady and spend added budget where design or review needs it. Use only IDs and levels in the current catalog. If the catalog supports one useful plan, show that plan and explain the limit.

Show the active source when a config exists. Present the proposed TSV, target path and project Git tracking before requesting approval. Use the columns `role`, `model` and `thinking` with literal tabs and leave the last field empty to inherit the thinking level. Save approved changes through `taskbook_model_setup`.

Report the project's staged settings after a model write. A new T3 checkout receives the model location and any tracked model table from the taskbook baseline. Distinguish T3's independent thread launch, current-thread handoff, and current binding. Report Magpie GitHub MCP readiness separately from the local workflow.

## Legacy data

Describe the planned imports, checkpoint copies and archived originals using `legacy`. Call `taskbook_migrate` for the specifically approved sources. Archive `.audit` before cleanup. Deleting the original `.audit` and deleting the old Git ref each need explicit approval.

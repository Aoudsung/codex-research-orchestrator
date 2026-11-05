# Task workflow protocol 2

New MCP tasks use workflow protocol 2. Existing tasks retain protocol 1 and their sessions, routes and results. Native `BridgeEngine.createTask` retains protocol 1 unless a contract or protocolVersion 2 is supplied. Upgrading runtime files does not upgrade an active experiment's task contract or start an experiment.

## Contract

`bridge_create_task` accepts `contract` and `protocolVersion`. Contract fields are `objective`, `scope`, `sourceRefs`, `deliveryCriteria`, `successCriteria`, `acceptor`, `notificationPolicy`, `resourceLimits`, and `allowedContinuation`. Existing permissions, host sandbox and model/session bindings continue to apply. A contract records authorization; it does not grant new host privileges.

`deliveryCriteria` specifies the agreed deliverable. `successCriteria` records how scientific results are judged. Completing an experiment with a negative result can satisfy the agreed experimental deliverable. Subsequent experiments require their own authorized scope.

Project defaults may be stored at `.research-orchestrator/workflow.json` in the task working directory or an ancestor. Version 1 accepts `contract` defaults and `forbiddenOperations`. These are read only when creating a new task. Original user instructions remain authoritative; a lead must update a changed constraint explicitly with its source.

`bridge_update_task_contract` requires taskId, eventId, expectedVersion, contract and sourceRefs. Only the lead or configured acceptor can revise it. A semantic change invalidates the pending continuation; source-only changes retain and reversion it. Old-version receipts remain stored without changing current execution state.

## Receipts and ownership

`bridge_submit_task_receipt` takes taskId, receiptId, attemptId, contractVersion, ownerEpoch and outcome. Outcomes are progress, waiting_external, waiting_user, retryable_failure, delivered, blocked and cancelled. Optional fields include summary, artifacts, completedSteps, remainingWork, incident, decision, handoff and continuation.

Keep receiptId stable across retries. The same ID and canonical payload returns the original result. Reusing it with different content produces a conflict. State changes, event history and continuation enqueue commit together.

A handoff is first reported by the owner with `{ "action": "offer", "toAgent": "antigravity", "conversationId": "bound-session" }`. The recipient accepts with `{ "action": "accept" }` using the offered version/epoch. Acceptance changes ownerEpoch, binds the conversation, revokes the old temporary lease and disables old routes until explicitly configured. Finish or hand over existing external execution before accepting; the workflow does not stop remote processes.

A delivered receipt preserves the result. The designated acceptor uses `bridge_accept_task_delivery` with eventId, contractVersion, ownerEpoch, the current deliveryReceiptId and evidence references to record acceptance. Legacy complete_task maps protocol-2 completion to delivered, while protocol-1 behavior remains unchanged.

## Waiting and recovery

A continuation names an action from allowedContinuation and a trigger and/or nextCheckAt. The durable task_continue effect returns waiting deferrals without consuming model slots or failure attempts. A source adapter or authorized monitor signals an observed change through bridge_submit_task_receipt with operation=signal, taskId, eventId, triggerEvent and sourceRef. Only an owner or lead can signal it. No SSH commands or external shell operations are inferred from the action name.

For waiting_user, provide decision.id and decision.question. `bridge_answer_task_decision` requires exactly that decisionId, eventId and an explicit answer. Ordinary messages do not clear protocol-2 decisions. Pending answers do not expire into approval.

Transport retries reuse notification IDs. Receipt correction resubmits only the receipt. Resume remote work from its actual job/checkpoint state; a timeout does not authorize a duplicate remote launch. Three identical retryable_failure receipts without changed artifacts or completed steps mark the task blocked. Healthy waiting and research iterations do not count toward that failure limit.

## Incidents, notifications and explanation

An incident has a stable key and status open/recovering/resolved. Repeated observations update its count; reopening a resolved incident advances its generation. Receipt idempotency preserves every original fact without repeating its transitions. Human notification categories are limited to decision_required, blocked and task_completed. Ordinary progress updates the task view. Peer notification delivery still uses its configured route; the lead decides which user-facing message requires attention.

Task overview returns workflow and why: current contract, owner, wait condition, next action, artifacts, decisions and the latest event references. The Workbench shows these fields and precise decision-answer controls. The caller's agent identity is supplied by the connected MCP endpoint rather than a receipt argument.

## Release and compatibility

`python3 scripts/sync-release.py --mirror /path/to/package/runtimes/agent-bridge --global-install /path/to/global/runtime` generates one release manifest and installs identical managed files with backups and atomic directory replacement. Source code is maintained in the canonical runtime. It includes CLI, Codex host and Claude/Antigravity desktop adapters and per-recipient routes. It does not copy project data into a public package or change MCP account credentials.

The runtime performs additive event-table creation and preserves routes while migrating an old task-only route key to a task/recipient key. Existing composite-key databases are not rebuilt. Runtime status reports actual protocol, schema and release information. Restore compatible code while retaining current task state if a release needs to be rolled back; do not replace a database containing newer committed actions with an old snapshot.

This implementation was syntax-checked. Unit tests, synthetic notifications, fault injection and experiment pilots were not run for this revision. Observe provider delivery and recovery evidence from authorized real tasks.

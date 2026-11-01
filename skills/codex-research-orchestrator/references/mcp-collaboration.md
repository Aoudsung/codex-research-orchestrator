# External collaboration and optional MCP

Read this file when sending external work, collecting replies, or handling delivery waits and continuation. These operating rules apply to the authorized channel; role duties remain in the relevant role page. The repository's optional `runtimes/agent-bridge` supplies shared task and artifact tracking for reciprocal work among Codex, Claude Code, and Antigravity. The skill remains usable with native tools alone. Select and configure only the adapters needed; skill installation does not register providers, grant permissions, or start a listener.

Discover the installed tools and their current schemas before use. Available providers, execution modes, and host notification support vary across clients.

## Channel operations

Record the destination and versions of the first prompt and attachments. Keep the authorized task and conversation through follow-ups; send changed requirements, evidence, and remaining findings instead of replaying the whole basis. If delivery is unknown, check the original conversation before resubmitting. Advance independent work while waiting, and diagnose repeated tool failures instead of blindly retrying.

For a browser or other channel without push, collect the complete final reply through its reliable full-response operation. Visible thinking progress and truncated excerpts are not research results. Preserve the original reply separately from the lead's interpretation. Use only an already-authorized channel-specific check, with its project-configured interval; reuse it, stay quiet without change, and disable it when no result is pending. Do not turn that policy into monitoring for other participants.

## Bind the Authorized Task

Create the logical task explicitly before execution with `bridge_create_task`. Bind its participant, required model, execution session, permitted workspace and write scope, and current artifact revision. Reuse that task and session through revisions and peer exchanges. Reusing a task ID does not amend its constraints: use a supported explicit amendment or report the unresolved scope change.

Keep the required model and the requested model argument separate from identity reported by runtime metadata. Record the evidence level, reject a known mismatch, and report unavailable verification when the user requires it. Do not silently substitute a model or treat an invocation flag as proof of what ran.

Use `bridge_preflight_task` to check the actual execution mode, required tools, paths, and permission delta. Set write scope explicitly for code work. An empty write scope must not turn a read-only task into general write access. Revoke only task-created permission changes, preserving pre-existing settings.

If direct writing is incompatible, use an authorized structured-patch mode only after its own readiness checks pass. Do not mark the failed mode successful or repeatedly retry a deterministic incompatibility. For provider executions that must await delivery, validation, or review, explicitly set `completeTaskOnExit: false` where supported rather than relying on backend defaults.

## Exchange Incrementally

Peers may exchange requests, evidence, revisions, and results within the project's contact, material-sharing, delegation, and resource authorization. Use `bridge_send_message` for requests and `bridge_reply_message` for a reply associated with the original message when supported.

Use `bridge_get_task_overview` and task-scoped `bridge_read_messages` cursors for bounded summaries and new messages. Calling `bridge_read_messages` automatically records two-phase consumption (`consumed_at`, with optional `consumeTurnId`) so the watchdog distinguishes host socket acceptance (`wakeup_status = 'delivered'`) from actual turn processing; if an agent session crashes after host acceptance without consuming a message, the L1 watchdog redelivers it with a `RecoveryNote` reminding the assignee to verify the latest patch `sha256` and working tree before repeating side effects. Advance the processed cursor only after handling the relevant items. Preserve bindings and cursors across interruption; avoid replaying already processed work. Do not give an independent participant the general inbox or earlier evaluations.

The first handoff establishes the question, source evidence, boundaries, output contract, and completion conditions. Follow-ups carry only the current revision, applied or superseded patches, changed materials, new evidence, and remaining findings. See [purpose-specific handoffs](prompts.md). An optional read-set may identify file versions or ranges already inspected; reuse it only while unchanged.

## Thread Subscriptions, Out-of-Scope Handback, and Spill Cards

To reduce manual relay without adding a paraphrasing LLM router, `agent-bridge` (`v1.0.0`) includes a deterministic Research Router (`off | observe | auto`, default `observe`):

- **Direct & Context Thread Fan-out (`bridge_subscribe_thread`):** Authorized tasks in the same joint thread may subscribe in `direct` mode (waking the subscribed peer on new thread messages within mandate) or `context` mode (passive visibility without wakeup). Tasks whose mandate carries `isolationProfile: 'blind_analysis'` or `'blind_review'` are hard-blocked from cross-thread fan-out so independent reviewers never see peer conclusions prematurely.
- **Anti-Paraphrase Routing & `controlVersion` Revalidation:** Router notifications forward `<= 200`-character single-line previews, total character length, SHA-256 digests, and `bridge://<kind>/<id>` pointers—never paraphrased summaries. Each task binds an immutable `Mandate` stamped with `controlVersion` (from `controls.md`); if `controls.md` changes mid-flight, active tasks receive a `control_notice` and must revalidate before resuming.
- **Out-of-Scope Handback (`bridge_handback`):** When an assignee encounters an issue outside its delegated scope, call `bridge_handback` with a structured `reasonCode` instead of guessing or silently changing research semantics. The bridge immediately releases that task's ownership of the message (preventing bounce loops): scientific ambiguity (`scientific_ambiguity`, `mechanism_change_needed`) routes back to the research lead, while authority boundaries (`permission_delta`, `budget_exceeded`, `constraint_conflict`, or structured `humanAction: { question, options?, blockingScope }`) surface directly in the Workbench Attention queue.
- **Spill Pointer Pagination (`bridge_read_card`) & Health (`bridge_watchdog_status`):** Fetch full message bodies, patch diffs, or validation logs by `bridge://message/<id>`, `bridge://patch/<id>`, `bridge://task/<id>`, or `bridge://validation/<id>` with exact Unicode code-point `offset` and `limit` ranges via `bridge_read_card`. Inspect `HealthBoard` components, durable `Effects` queue depth, `+1` human-priority slot load, and active `Attention` items read-only via `bridge_watchdog_status`.
- **Shadow Dispatch (`observe` mode):** In `observe` mode, inferred follow-ups record `would_dispatch` proposals in `router_decisions` without spending external provider quota until approved by the user or lead.

## Artifacts and Acceptance Evidence

Use `bridge_submit_patch`, `bridge_list_patches`, and `bridge_get_patch` when structured patches are relevant. Read compact metadata first and fetch the exact artifact for application or a specific judgment. Preserve the author's original content, target paths, dependencies, base revision, replacement relation, and associated validation. Missing prerequisites, dependency cycles, incompatible bases, or unauthorized paths block application.

Keep these meanings separate, using only those relevant to the task:

| Evidence | What it establishes |
|---|---|
| Submitted | A request was stored or dispatched |
| Received / inbox | The participant or bridge received a message |
| Delivered | The declared artifact set and final receipt are available for a delivery revision |
| Applied | The indicated patch set was actually applied |
| Validated | Relevant checks passed for that artifact set |
| Reviewed | Specified claims or findings were reviewed for that version |
| Accepted | The lead accepted the declared scope on its evidence |

Apply only the stages relevant to the task; an analysis task may need no patch or test suite. Multi-part work requires a declared artifact list and final receipt associated with its delivery revision; label incomplete sets as partial.

Use `bridge_record_validation` to associate actual checks and findings with the affected artifacts. Consolidate a repair request for the original task and author; include relevant failure output, the revision, and remaining findings. Reuse unchanged validation and review coverage. The lead checks sufficient final-version evidence and retains final acceptance; `bridge_complete_task` must reflect the scope actually completed rather than closing work merely because a process exited.

## Wait and Resume

**Within the current turn:** when the caller needs the next delivery, `waitForDelivery` on supported dispatch or validation calls combines sending and delivery waiting in one operation. `bridge_send_message` and `bridge_record_validation` can use this mode; `bridge_wait_for_delivery` supports waiting on existing work. Follow the actual schemas and yield to the host when supported. Do not issue a duplicate request or add another polling loop while the integrated wait is pending.

Ending the lead's turn after a completed handoff does not allow it to abandon an integrated delivery wait before the call returns. On return, inspect only the increment and receipt, then perform necessary acceptance or repair work for that revision.

Configure `settleMs` and `timeoutMs` for the channel and client deadline (bridge profile defaults: 2,500 ms and 600,000 ms). The settling window coalesces adjacent events. If a client times out earlier, retain the task, session, revision, and cursor and perform bounded reconciliation of the original work before retrying.

**Across turns:** a capable channel delivers events through an explicitly configured host receiver. Verify support on the active installation by recording message receipt, forwarding, host acceptance identifying the intended target and turn, and actual processing by the target turn.

Once independent actors own pending work and the lead has no remaining action, the lead can finish the current turn. Keep a checkpoint and acceptance responsibility, then resume the bound task on a genuine return event. For a channel without push, use only an authorized, channel-scoped scheduled check: reuse its schedule, remain quiet without change, and disable it when no reply is pending. Do not extend that polling policy to capable channels or unrelated participants.

## Keep Execution and Research State Separate

The bridge owns execution bindings, message cursors, permission leases, artifact deliveries, and validation status. Research files and [research memory](memory.md) own confirmed requirements, scientific claims, decisions, evidence, and durable continuation records.

Reference the task, delivery revision, accepted result, and next action from an existing checkpoint. Keep the raw inbox and patch history in execution storage; fetch them only as needed. No additional research-memory kind or schema is required for bridge references. Build recipient-specific context and preserve independent-review material boundaries through every exchange.

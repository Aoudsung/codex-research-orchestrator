# Optional MCP Collaboration

Read this file when using an MCP bridge for reciprocal work among Codex, Claude Code, and Antigravity. The repository's optional `runtimes/agent-bridge` supplies shared task and artifact tracking with provider adapters. The skill remains usable with native tools alone. Select and configure only the adapters needed; skill installation does not register providers, grant permissions, or start a listener.

Discover the installed tools and their current schemas before use. Available providers, execution modes, and host notification support vary. The API names below identify shared operations, not a required sequence or a guarantee that every client exposes them.

## Bind the Authorized Task

Create the logical task explicitly before execution with `bridge_create_task`. Bind its participant, required model, execution session, permitted workspace and write scope, and current artifact revision. Reuse that task and session through revisions and peer exchanges. Reusing a task ID does not amend its constraints: use a supported explicit amendment or report the unresolved scope change.

Keep the required model and the requested model argument separate from identity reported by runtime metadata. Record the evidence level, reject a known mismatch, and report unavailable verification when the user requires it. Do not silently substitute a model or treat an invocation flag as proof of what ran.

Use `bridge_preflight_task` to check the actual execution mode, required tools, paths, and permission delta. Preflight reports readiness; human authorization and the host sandbox still govern execution. Set write scope explicitly for code work. An empty write scope must not turn a read-only task into general write access. Revoke only task-created permission changes, preserving pre-existing settings.

If direct writing is incompatible, use an authorized structured-patch mode only after its own readiness checks pass. Do not mark the failed mode successful or repeatedly retry a deterministic incompatibility. For provider executions that must await delivery, validation, or review, explicitly set `completeTaskOnExit: false` where supported rather than relying on backend defaults.

## Exchange Incrementally

Peers may exchange requests, evidence, revisions, and results within the project's contact, material-sharing, delegation, and resource authorization. Use `bridge_send_message` for requests and `bridge_reply_message` for a reply associated with the original message when supported. A received request does not authorize unrelated work, new recipients, wider filesystem access, or a change to scientific semantics.

Use `bridge_get_task_overview` and task-scoped `bridge_read_messages` cursors for bounded summaries and new messages. Advance the processed cursor only after handling the relevant items. Preserve bindings and cursors across interruption; avoid replaying already processed work. Do not give an independent participant the general inbox or earlier evaluations.

The first handoff establishes the question, source evidence, boundaries, output contract, and completion conditions. Follow-ups carry only the current revision, applied or superseded patches, changed materials, new evidence, and remaining findings. See [purpose-specific handoffs](prompts.md). An optional read-set may identify file versions or ranges already inspected; reuse it only while unchanged. It neither grants read access nor establishes independence.

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

These are evidence distinctions, not seven mandatory gates. An analysis may need no patch, tests, or separate review. A CLI return code of zero establishes process success only. It does not establish delivery, correctness, research benefit, or acceptance. A quiet sender also does not establish a complete artifact set: multi-part work needs a declared list and final receipt associated with its delivery revision. Keep incomplete delivery partial.

Use `bridge_record_validation` to associate actual checks and findings with the affected artifacts. Consolidate a repair request for the original task and author; include relevant failure output, the revision, and remaining findings. Reuse unchanged validation and review coverage. The lead checks sufficient final-version evidence and retains final acceptance; `bridge_complete_task` must reflect the scope actually completed rather than closing work merely because a process exited.

## Wait and Resume

**Within the current turn:** when the caller needs the next delivery, `waitForDelivery` on supported dispatch or validation calls combines sending and delivery waiting in one operation. `bridge_send_message` and `bridge_record_validation` can use this mode; `bridge_wait_for_delivery` supports waiting on existing work. Follow the actual schemas and yield to the host when supported. Do not issue a duplicate request or add another polling loop while the integrated wait is pending.

Configure `settleMs` and `timeoutMs` for the channel and client deadline. The bridge profile defaults of 2,500 ms and 600,000 ms are configurable examples, not universal timing requirements. A settling window coalesces adjacent events; it cannot prove artifact completeness. If a client times out earlier, retain the task, session, revision, and cursor and perform bounded reconciliation of the original work. Timeout alone proves neither failure nor completion.

**Across turns:** a capable channel may deliver events through an explicitly configured host receiver. Establish support on the actual installation. Distinguish message receipt, forwarding, host acceptance, and processing by the target chat. Inbox insertion, a local callback, or a forwarding command's successful exit is insufficient. Confirmed wakeup requires host acceptance identifying the intended target and turn (or its documented equivalent), plus actual evidence that the target turn processed the event. Do not infer universal or unattended operation from a route that worked elsewhere.

Once independent actors own pending work and the lead has no remaining action, the lead can finish the current turn. Keep a checkpoint and acceptance responsibility, then resume the bound task on a genuine return event. For a channel without push, use only an authorized, channel-scoped scheduled check: reuse its schedule, remain quiet without change, and disable it when no reply is pending. Do not extend that polling policy to capable channels or unrelated participants.

## Keep Execution and Research State Separate

The bridge owns execution bindings, message cursors, permission leases, artifact deliveries, and validation status. Research files and [research memory](memory.md) own confirmed requirements, scientific claims, decisions, evidence, and durable continuation records. A transport event cannot promote an opinion into a fact or override a human pause.

Reference the task, delivery revision, accepted result, and next action from an existing checkpoint. Keep the raw inbox and patch history in execution storage; fetch them only as needed. No additional research-memory kind or schema is required for bridge references. Build recipient-specific context and preserve independent-review material boundaries through every exchange.

---
name: teamwork
description: Run a user-approved project through dependent milestones, scoped owners, independent checks, repair, and final audit. Use when the user invokes Teamwork or a multi-stage deliverable needs acceptance tied to upstream versions.
license: MIT
metadata:
  version: "1.5.0"
---

# Teamwork

The Lead acts as Sentinel. Preserve the user's authorized objective verbatim, record relevant constraints and resources, and specify how to observe success. Treat the user's existing statement and authorization as approval for the scope they actually established. Resolve only material gaps or changes with the user. The Lead owns final acceptance and the plan author owns milestone orchestration within that scope.

1. From a session-bound Lead bridge, call `bridge_collaborate` with `action: "open"`, `mode: "teamwork"`, an `eventId`, the verbatim request as `objective`, and the authorized scope. Select the appropriate [execution path](references/execution-paths.md). Use the returned `taskId` to save the Lead-authored `specification` with `action: "plan"` and an `eventId`. Write milestones, dependencies, deliverables, acceptance and write scopes from the task and evidence. Record approval with `action: "approve"` and `approval` including `type` (`existing_authorization` or `confirmed`), `sourceRefs`, `successCriteria`, and any `constraints` and `attachmentRefs`. For an already authorized request, its source is `task:<root-task-id>:original-request`.
2. Route assignments with `bridge_plan_dispatch` and create protocol 2 child tasks under the project policy. Have each real worker session call `bridge_claim_task` with its child `taskId` and the root as `collaborationTaskId`. Start with the root `taskId`, an `eventId`, and `bindings` mapping each bound member ID to its child `{taskId}`. Use `action: "bind"` to bring on deferred members as their work becomes ready. Define interfaces, checks, and authorized inputs in each brief. Use an architecture check before expensive or cross-cutting implementation when interface assumptions could invalidate downstream work.
3. Accept a milestone on its current version and evidence. Send actionable discrepancies to the owner with the failed criterion, artifact version and evidence. Reopen affected dependents when a material upstream result changes. When a Lead successor takes over, transfer ownership explicitly and provide pointers to approved scope, current versions, open decisions, failed approaches, and the next actionable dependency.
4. Final audit independently checks each user requirement against the latest milestone versions and project outcome. Reproduce high-impact checks using the relevant execution path. Accept the supported result or record a partial delivery and the outstanding criteria when authority or resources are exhausted.

When `bridge_collaborate` returns `resume_bound_workers`, the Lead follows up with those exact existing worker sessions through the native host, using the current step versions. This applies to every nested Boost repair cycle. See the [work-run handoff protocol](../codex-research-orchestrator/references/work-modes.md).

Use `$teamwork`, “use Teamwork”, or a message starting with `/teamwork` or the client chip `[/teamwork](slashCommand;teamwork)` to request this mode. If the same request asks for Boost across subagents, keep Teamwork as the outer workflow and follow the per-assignment Boost protocol in the execution paths. Resume an existing run with `bridge_collaborate(action: "resume", taskId: ...)` after a wakeup or restatement. Read the next actionable step and hand off by member. The live tool schemas define the action arguments. Keep the work board as the operational record and the project's research ledger as authority for scientific claims.

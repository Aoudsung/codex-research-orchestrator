---
name: swarm
description: Run several independent tracks with named owners, targeted handoffs, and a shared persistent work board. Use when the user invokes Swarm or work has genuinely parallel slices that need coordinated integration or verification.
license: MIT
metadata:
  version: "1.5.0"
---

# Swarm

Split by outcomes that can make progress at the same time. Agree on interfaces and assign exclusive write roots before dispatch. Use one owner per active slice, plus independent verification where failures could change acceptance. Start with the smallest team that covers the work. Add a member when there is ready work and no qualified owner, and retire idle members once their deliverables and dependents are accounted for.

1. From a session-bound Lead bridge, call `bridge_collaborate` with `action: "open"`, `mode: "swarm"`, an `eventId`, the verbatim request as `objective`, and the authorized scope. Use the returned `taskId` to save the authored `specification` with `action: "plan"`. Include named `tracks`, dependencies, writable paths, deliverables, and observable acceptance criteria. Each brief states ownership, evidence, allowed actions, and how to report a versioned result. Use `bridge_plan_dispatch` and create protocol 2 child tasks. Have each real session use `bridge_claim_task` with the root as `collaborationTaskId`. Start with the root `taskId`, an `eventId`, and `bindings` mapping each ready member ID to its child `{taskId}`.
2. Use `bridge_work_board` for `status`, `read`, and `post`. Keep team-wide decisions and final results on the main channel, with one named channel per distinct work area when that reduces noise. Create, subscribe, and archive channels on the existing run. Put only the people who must act next in `toMemberIds`. Refer to earlier posts by their sequence and link the source evidence. Verifiers route specific failures to the owning author and involve the Lead for blockers, decisions, or final acceptance. A board post hands off context. Use a structured step receipt to advance the task.
3. Read from the last sequence actually consumed, advancing only from returned evidence of consumption. When catching up, page through all available events and keep separate cursors for separately filtered views. On a wakeup, call `bridge_collaborate` with `action: "resume"` against the saved task. After useful work, exit so the next named actor can run. A short event wait is appropriate to coalesce a pending result when the host supports it. Use board status, lease and route evidence to distinguish a running task from a stalled handoff. If all members are idle with unfinished work, find the first unserved dependency or undelivered event. Address the actor once with evidence rather than broadcasting or starting a polling loop.
4. The Lead uses the board's versioned lifecycle operations to add or reassign work and preserve existing receipts and dependencies. Integration checks cover cross-track interfaces and current revisions, including any reworked track. Independently check consequential claims or behavior before accepting the whole run.

When `bridge_collaborate` returns `resume_bound_workers`, the Lead follows up with those exact existing worker sessions through the native host, using the current step versions. Check the [work-run handoff protocol](../codex-research-orchestrator/references/work-modes.md).

Use `$swarm`, “use Swarm”, or a message starting with `/swarm` or the matching client command chip to request this mode. The live MCP schemas define the action arguments. Advance authorized slices when another is blocked and report any assignment that still lacks a bound session.

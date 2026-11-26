---
name: boost
description: Coordinate an initial candidate and a fresh challenge-and-repair pass for a difficult implementation or root-cause investigation. Use when the user invokes Boost or when a single difficult result needs independent falsification and one accountable owner.
license: MIT
metadata:
  version: "1.5.0"
---

# Boost

Keep one accountable owner and a separate challenger. Use the user's verbatim task, allowed workspace and operations, starting evidence, and the observable result they asked for. Route the first implementation or investigation early so the Lead can later make a useful independent spot-check.

1. From a session-bound Lead bridge, call `bridge_collaborate` with `action: "open"`, `mode: "boost"`, an `eventId`, the verbatim request as `objective`, and the authorized scope. Use the returned `taskId` to save the Lead-authored `specification` with `action: "plan"`, including the route (`coding` or `investigation`) and acceptance criteria from the real task. Use `bridge_plan_dispatch` to create protocol 2 child tasks. Have each real worker session claim its child task using `bridge_claim_task` with the root as `collaborationTaskId`. Use `action: "start"` with the root `taskId`, an `eventId`, and `bindings` mapping each ready member ID to its child `{taskId}`. Use `action: "bind"` when a deferred member claims its task.
2. Assign the owner a bounded first pass. For implementation, require an applicable candidate, its exact version, and checks through the real entry point. For investigation, require a source-linked causal claim, a serious alternative, and an observation that would distinguish them. Preserve the candidate and evidence before starting the challenge.
3. Give a fresh challenger the original requirements, exact candidate, and permitted evidence. Ask it to form its own reading of the task before consulting the owner's reasoning. Test a consequential alternative or failure case rather than paraphrasing the candidate. For strictly blind work, use sealed independent input packets and defer comments until those first contributions are frozen.
4. Give the named author the challenge and its evidence reference. Reproduce the concrete failure, repair the authorized candidate, and re-run the targeted check. A challenger may repair only if assigned the affected write scope after ownership transfers. Check the repaired revision as needed, including any claims or tests its change invalidates. If another round would exceed scope, stop at a partial result with the smallest unresolved gap.
   If `resume` returns `resume_bound_workers`, use the native follow-up or resume command for the existing author session, with the exact work-step ID and revision. A board post can be waiting in the inbox of a finished turn. The Lead handles this continuation and checks its receipt. See the [work-run handoff protocol](../codex-research-orchestrator/references/work-modes.md).
5. The Lead independently spot-checks the current outcome against the original request, binds evidence to each acceptance requirement, and closes only after the revised result is supported. Treat a verdict without observations as incomplete. Use `bridge_collaborate` with `action: "resume"` and the existing `taskId` after a wakeup or continuation. Inspect the current ready steps, dispatch or accept within that turn, and exit when the next actor owns the work.

Use `$boost`, “use Boost”, or a message starting with `/boost` or the matching client command chip as an explicit request for this mode. Apply the project's model and resource policy. If the Lead tool or an authorized route is unavailable, state the concrete limitation and advance any authorized work within the available roles.

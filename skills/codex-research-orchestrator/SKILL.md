---
name: codex-research-orchestrator
description: Coordinate sustained research in Codex with independent construction, focused authorship, constructive review, and source-backed continuation. Use to start or resume research or coordinate authorized work across Codex, Claude Code, and Antigravity. For a bounded contribution, load only the relevant role and guidance.
license: MIT
metadata:
  version: "0.4.0"
---

# Codex Research Orchestrator

Keep the scientific question, evidence, and next action connected. Protect the user's research object and authorization; revise mechanisms, current decisions, and candidate claims when evidence warrants it. The user can begin with one goal. Handle ordinary setup and records without requiring a completed form or a fixed agent team.

Roles are responsibilities, not provider or model assignments. Use the project's actual participants and permissions. Codex can work alone; the optional bridge supports reciprocal collaboration with Claude Code, Antigravity, and other configured participants.

## Identify the task and role

Determine whether this is a new project, continued research, or a bounded contribution. Preserve existing entry points and designated participants. Determine the task type from the user's request and current project records; ask only when ambiguity changes the deliverable or completion criteria.

| Task type | Completion boundary |
|---|---|
| Original research | The final main proposal needs rigorous support appropriate to its claims and a substantive contribution relative to the closest work. A correct known baseline or an unsupported new idea does not meet that objective. |
| Reproduction | Meet the specified fidelity, implementation, comparison, and reporting requirements. A new mechanism is not required. |
| Survey or investigation | Answer the stated question with suitable sources, coverage, and qualified conclusions. |
| Bounded review or engineering support | Complete the assigned review, change, or execution and its relevant checks. Completion of this contribution does not establish completion of the whole study. |

Then load only the role needed for the current assignment:

| Responsibility | Read when assigned |
|---|---|
| Research lead or delegated research contributor | [Researcher](references/roles/researcher.md) |
| Optional exploration of alternative mechanisms | [Brainstormer](references/roles/brainstormer.md) |
| Independent assessment of a proposal | [Reviewer](references/roles/reviewer.md) |
| Agreed implementation or authorized execution | [Implementer](references/roles/implementer.md) |
| Requested diagnosis of collaboration | [Collaboration optimizer](references/roles/optimizer.md) |
| Requested collection of incremental facts | [Fact observer](references/roles/fact-observer.md) |

A temporary contributor receives only the delegated scope, not the lead's authority over other participants, shared state, or final acceptance. Do not instantiate every role, create new conversations, or change models merely because a role is listed. Further delegation must already be authorized.

## Route the work

- **Install, start, connect, or diagnose setup:** use [getting started](references/getting-started.md). Keep routine writes in the chosen project. Configuration does not prove a live connection.
- **Resume or report status:** read live user controls, project settings, current state, and relevant recent evidence. Check pauses, active jobs, and pending results before restarting anything.
- **Construct or evaluate a research approach:** use [research methods](references/method.md). Arrange participants and independent inputs through [collaboration](references/collaboration.md).
- **Hand off or record results:** use [purpose-specific prompts](references/prompts.md) and [recordkeeping](references/records.md).
- **Retrieve growing history:** use [memory](references/memory.md). Independent analysis and review receive curated materials, not general state or the lead's inbox.
- **Use an external channel or await a result:** follow [MCP collaboration](references/mcp-collaboration.md), which maintains session reuse, delivery waiting, timeout reconciliation, and continuation rules. Check [Codex integration](references/codex-runtime.md) when host capabilities matter.
- **Observe collaboration:** use [observation](references/observer.md) only within the user's requested scope.

For a new project, extract the question, deliverable, confirmed constraints, available materials, permissions, and resources from the request. Mark assistant interpretations as drafts. Use the setup helper when minimal persistent records are needed; expand the [project](assets/project-template/project.md), [charter](assets/project-template/charter.md), and [state](assets/project-template/state.md) templates only as useful. Empty fields neither grant permission nor block clear, authorized work.

## Keep authority and evidence separate

| Category | Treatment |
|---|---|
| User-confirmed constraints | Preserve the original wording and source. Change them only on the user's instruction. |
| Current decisions | Revise within authorization when evidence supports a different choice; record why. |
| Candidate claims | State conditions, evidence, and refutation criteria; revise or reject them when needed. |

Draft charter text, a paper's definitions, a collaborator's confidence, and assistant interpretations do not become user constraints. Do not substitute a smaller research object because it is easier to prove, implement, or publish.

## Research loop

Use this loop when assigned research construction. Other roles follow their assigned scope and duties; this loop does not grant them construction work or lead authority.

1. **Choose the judgment to change.** Connect an unresolved difficulty to the original goal, available information, and evidence that could decide the next step.
2. **Construct and investigate.** Resolve what reasoning, original sources, or implementation checks can settle. When direction is unclear or blocked, form short independent proposals with different core relationships before comparison. Select a main author to deepen the supported direction; give other contributors complementary questions.
3. **Test the argument.** Trace the mechanism or explanation to the claimed outcome. Examine decisive counterexamples, transfer conditions, closest predecessors, and necessary observations. Early candidates may have open conditions; do not replace exploration with a demand for a finished proof at every round.
4. **Handle findings constructively.** Locate the smallest failing condition and repair the core relationship within the research object. If a route is ruled out, preserve the evidence and reconstruct the approach. Repeated patches without a coherent explanation are a reason to reconsider the representation or feedback relationship.
5. **Record what changed and continue.** Distinguish a handled finding, a resolved original difficulty, and an established contribution. Reuse unchanged review and validation coverage. The lead updates shared state serially and continues the next necessary authorized action.

For original research, a diagnosis of limited novelty or a remaining error is an intermediate result. Continue concrete construction within the active scope and resources. Do not claim completion from a baseline fallback, a closed finding, more rounds, agreement, or improved internal metrics. Negative results and local corrections remain useful knowledge; they establish the requested original contribution only when they actually meet that deliverable's criteria.

## Ownership and stopping

Keep one writer per area. The lead owns scientific tradeoffs and final acceptance; the author owns assigned construction, implementation, self-checks, and repairs. Accept work using sufficient evidence for its actual version instead of repeating the author's whole workflow. Independent review remains distinct from self-checking.

Deliver a bounded task when its objective and relevant checks are complete. For ongoing research, a reply, review approval, or finished document is not itself the stopping point. A missing mechanism is not a reason to stop while a necessary, authorized next action remains.

Respect user pauses, round limits, budgets, and execution boundaries. At a real boundary, record the unfinished objective, completed scope, pending work, and concrete next action without presenting a pause or exhausted route as scientific success. Do not promise that persistence guarantees a positive result.

When independent actors own pending work and the lead has no remaining action, the lead may end its turn with a checkpoint and retained acceptance responsibility. An integrated delivery-wait call must first return. Use only configured continuation or authorized channel-specific checks; do not create monitoring or claim idle-chat wakeup from an inbox event alone.

## Deliver

State the strongest supported conclusion, its conditions, evidence, actual deliverables, and open questions. Distinguish facts, derivations, source statements, and assumptions. For a proposal, show how the relevant user constraints are met. Once the assigned objective is achieved, deliver without adding unrelated review or experiments.

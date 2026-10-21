---
name: codex-research-orchestrator
description: Coordinate sustained research in Codex with a clear scientific question, independent analysis, external collaboration, review, implementation or experiment handoffs, and evidence-based continuation. Use to start or resume multi-round research or organize a Codex research team. Do not start the full workflow for a one-off factual answer, routine code change, or text-only polish.
license: MIT
metadata:
  version: "0.1.0"
---

# Codex Research Orchestrator

Organize sustained research around the key scientific question, a supported contribution, and the user's needs. Each round should change a meaningful judgment through evidence. Protect the research object and authorization the user has set; revise or reject mechanisms, candidate claims, and current approaches when evidence warrants it.

This skill is built for Codex. It uses skill discovery, project files, subagents, and available tools. Adapt it to different fields through project settings, without fixing a model version, private chat, server, or team size. On first use, read [Codex integration](references/codex-runtime.md) to identify the current client's capabilities. These files do not create a background service or guarantee research success.

## Enter the task

**Determine whether the request starts a project, resumes one, or asks for a bounded contribution.** For a bounded request, use only the relevant guidance. Keep existing project paths, contracts, and role assignments; do not create a second source of state.

For a new project, extract the following from the request and available materials. Ask only about gaps that change the scientific meaning, main deliverable, resource limits, or permission to share:

- The question, research object, conditions, and requested deliverable.
- Confirmed user constraints, original evidence, and confirmation sources. Keep assistant interpretations as drafts.
- Authorized actions: reading, reasoning, writing, implementation, experiments, and external communication.
- Available participants, tools, execution environment, and budget. Existing authorization remains valid; do not request it again every round.

When persistent records are needed, use [charter.md](assets/project-template/charter.md), [project.md](assets/project-template/project.md), and [state.md](assets/project-template/state.md) in the user's chosen or a suitable research directory. Fill known facts. Empty fields are not authorization; record explicit user instructions without asking for confirmation again. An incomplete draft does not block work whose scope is already clear.

On resumption, read the authoritative user constraints, project settings, current state, and relevant recent records. Check the latest pause instructions, running jobs, and pending results. Independent analysis and review are exceptions: isolate prior judgments as specified in [collaboration](references/collaboration.md). Do not restart work already in progress.

For growing histories, use [research memory and task context](references/memory.md). Search short indexes before reading full sources, keep authoritative controls live, and build a fresh packet for the recipient and question. Do not load the entire history or give an independent reviewer the general resumption context.

## Keep three categories separate

| Category | Examples | How it changes |
|---|---|---|
| User constraints | Research object, required limits, deliverables, budget, sharing permissions | Update only on the user's instruction; retain the source and change record |
| Current decisions | Candidate method, division of work, search strategy, experiment plan | Revise within authorization when evidence supports it; record why |
| Candidate claims | Effectiveness, causal explanation, theorem, generalization, performance prediction | State conditions, evidence, and refutation criteria; revise or reject as needed |

Definitions in a paper, collaborator suggestions, assistant inferences, and draft charter text do not automatically become user constraints. If a candidate violates a constraint, repair or reject it. Do not replace the original question because a substitute is easier to prove, run, or publish.

## Research loop

1. **Choose the judgment to change.** Connect the current difficulty to the research goal. State what result would decide the next step. “Have another discussion” is not a research objective.
2. **Choose a method that can answer it.** Resolve what sources, derivations, counterexamples, or implementation checks can settle before arranging necessary observations. Design, empirical work, theory, and reproduction require different evidence; see [research methods](references/method.md).
3. **Assign work and obtain original results.** Independent research, joint discussion, review, and implementation need different inputs. Select participants using [collaboration](references/collaboration.md), and provide sufficient context using [handoff prompts](references/prompts.md); state any required output format in full in the first request. Keep short diagnostic loops with the lead when delegation would add no value.
4. **Determine what the result changes.** Check the key derivation, source, or affected behavior. Distinguish new evidence from another participant's opinion. Accept, rebut, or leave each review finding open, with reasons. Recheck only material changes or uncovered questions.
5. **Record and continue.** The lead updates state, claims, and decisions serially, preserving original materials and a short work index under [recordkeeping](references/records.md). Continue the next necessary action when the objective is unfinished and the action is clear, authorized, and within budget.

Progress can mean establishing conditions, ruling out a candidate, repairing a derivation, obtaining a discriminating observation, or completing a valid implementation. More pages, rounds, agents, agreement, or a better internal metric do not alone establish research progress or overall effectiveness.

## Roles and control

| Role | Responsibility and limit |
|---|---|
| User | Sets the research object, material tradeoffs, permissions, and resources; may pause or change the goal |
| Research lead | Owns scientific meaning, approach selection, coordination, feedback handling, shared records, and final acceptance |
| Research partner | Investigates, proposes mechanisms, derives results, and constructs counterexamples; forms an independent view on key questions before comparison |
| Independent reviewer | Evaluates a specified version and its claims from evidence, without inheriting others' conclusions |
| Implementer | Implements the agreed approach or runs authorized experiments; returns version-linked evidence and escalates methodological ambiguity |
| Collaboration observer, optional | Diagnoses coordination problems and proposes changes; does not take over research, direct participants, or rewrite rules |

Roles describe responsibilities, not a required set of chats. Reuse participants the user has designated. Create temporary agents only when independence or parallel work adds value. One agent may research and implement, but must label its own check as self-review. Enable the observer only when the user requests a coordination assessment; see [observation](references/observer.md).

## Continue and stop

Follow the scope of the user's request. Deliver when a single-round request is complete. For sustained research, one reply, review approval, or finished document is not a stopping point. A missing core mechanism is not itself a reason to stop. At a bottleneck, distinguish failure of the current approach from a conflict in the problem conditions, then change sources, methods, decomposition, or candidates.

Create a checkpoint and explain the concrete boundary when:

- The requested deliverable and relevant acceptance checks are complete.
- The user pauses work; stop within the stated scope.
- A budget or time limit is reached, or the next action would exceed it.
- Required input, permission, or an external result is missing, and no necessary independent work remains.
- Evidence exposes a conflict among user constraints that requires the user's decision.

Complete unaffected authorized work before asking. Do not turn ordinary approach choices, failed candidates, or a lack of absolute guarantees into approval requests. Sustained research does not authorize unlimited retries, more resources, or unapproved experiments.

For work across sessions or time periods, use the host's scheduling tools only when requested and available. Save the research directory, resumption entry point, authorized scope, budget, and stop conditions. Stay quiet without meaningful change; notify on substantive results, failure, or a needed decision. Without a scheduler, provide a checkpoint and state that no background work is running.

## Deliver

Lead with the strongest supported conclusion, then state its conditions, key evidence, completed artifacts, and actual open questions. For a proposal, check the user constraints relevant to this round against specific mechanisms, definitions, or evidence. For an interim result, identify the next action. Once the agreed objective is met, deliver without expanding the audit or experiment scope.

Use clear, concise language and give reasons for judgments. Distinguish user statements, original sources, existing implementation, derivations, and assumptions. Research quality comes from inspectable work, not a predetermined positive conclusion.

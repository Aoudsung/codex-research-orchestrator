# Codex Research Orchestrator

**A research collaboration framework for Codex, with autonomous information exchange and task coordination across Claude Code, Antigravity, and Codex.**

[MIT License](LICENSE) · [Skill entry point](skills/codex-research-orchestrator/SKILL.md) · [MCP setup](docs/mcp-setup.md) · [Design rationale](docs/design.md) · [Related work](docs/related-work.md)

## New in v0.2: autonomous cross-agent collaboration

Claude Code, Antigravity, and Codex can exchange requests, evidence, revisions, and results through an optional shared MCP bridge. Agents can continue an authorized task across turns and provider boundaries with less manual message relay, while preserving the task's participants, scope, and acceptance criteria.

The bridge supports reciprocal communication: a research partner can request clarification, an implementer can return a patch, and a reviewer can send focused feedback to the same task. Any configured participant can initiate a permitted exchange. A shared record keeps messages, artifact revisions, and verification results connected.

- **Persistent collaboration:** continue the same task and session through revisions, with explicit model requirements and identity evidence.
- **Incremental exchange:** receive new messages by cursor and fetch complete artifacts only when needed.
- **Structured delivery:** connect patches, replacements, validation results, and final acceptance without treating a successful process exit as completed work.
- **Event-driven continuation:** combine dispatch with delivery waiting, or resume through a configured host notification route that confirms acceptance.
- **User-defined boundaries:** retain read/write scopes, execution permissions, independent-review inputs, and the lead's scientific decisions.

Install the [optional bridge runtime](runtimes/agent-bridge/README.md) for the connections you need. The research skill and memory helper also work without it. Provider CLIs and host notification routes remain explicit local configuration; the repository does not install accounts or enable unattended processes automatically.

## Why this project exists

This project grew out of the author's experience coordinating sustained research with multiple agents. The motivating problem is that agents can keep searching, discussing, running experiments, and writing while gradually losing the original scientific question. An easier substitute can become the target. A combination of familiar methods, presented fluently, can obscure a weak contribution. Without supervision, these deviations can accumulate across handoffs and produce a polished proposal with little research value.

The framework is designed around three goals:

1. **Identify the key scientific problem.** Each round states the current difficulty, the judgment that must change, and the evidence needed to change it. Analyze necessary conditions before choosing a method.
2. **Maintain continuity of research purpose.** Keep the original object, question, and confirmed constraints in an authoritative record. Allow methods and approaches to change when evidence rejects them.
3. **Stay aligned with the user.** Separate confirmed requirements, draft interpretations, execution permissions, and resource limits throughout research, review, implementation, and resumption.

These are the project's motivation and design goals. They do not establish that every existing framework produces weak work, or that this framework has already demonstrated superior research quality.

## The design contribution

The contribution is an inspectable **research collaboration protocol for Codex** that connects the mechanisms below. Multi-agent systems, reflection, review, and memory all have precedents; this project does not claim to have invented them.

| Design | What it changes in practice | Implementation |
|---|---|---|
| Progress through scientific questions and changed judgments | Each round explains which difficulty it resolves and which evidence changes the next step. More text or agent agreement is not enough. | [Research methods](skills/codex-research-orchestrator/references/method.md) |
| Separate constraints, decisions, and claims | Preserve the user's original requirements; revise method choices; make effectiveness and novelty claims open to refutation. | [Skill entry point](skills/codex-research-orchestrator/SKILL.md) |
| Independent judgment before collaboration | Isolate prior evaluations during key analysis and review, then compare derivations and counterexamples. | [Collaboration](skills/codex-research-orchestrator/references/collaboration.md) |
| Ground innovation in mechanisms | Compare substantive differences from the closest work, the properties those differences produce, and the contribution they support. Check conditions before transferring ideas across fields. | [Research methods](skills/codex-research-orchestrator/references/method.md) |
| Connect review, implementation, and evidence | Resolve findings individually, track review coverage by version and conditions, and preserve sources separately from current conclusions. | [Records](skills/codex-research-orchestrator/references/records.md) |
| Coordinate autonomous cross-agent exchange | Preserve task and session bindings across requests, evidence, patches, and verification; let authorized participants continue from actual deliveries. | [MCP collaboration](skills/codex-research-orchestrator/references/mcp-collaboration.md) |
| Retrieve research memory by validity and recipient | Keep live controls, typed source snapshots, explicit dependencies, and bounded context packets; filter independent inputs before ranking. | [Memory and context](skills/codex-research-orchestrator/references/memory.md) |
| Improve coordination without transferring control | An optional observer diagnoses repetition, stalled progress, and broken handoffs, then proposes evidence-based changes for the user to decide. | [Observation](skills/codex-research-orchestrator/references/observer.md) |

[Design rationale](docs/design.md) explains the expected effects and failure conditions. The contribution is in collaboration and workflow design. This release does not introduce a new foundation-model algorithm or claim field-wide priority or measured performance leadership.

## Built specifically for Codex

The framework enters through a Codex `SKILL.md` and loads references and project templates only when needed. The main chat leads the research. Subagents handle separable investigation, reasoning, and implementation. Project files preserve state across rounds. Available terminals, connectors, and chat tools carry out the work. [Codex integration](skills/codex-research-orchestrator/references/codex-runtime.md) maps these responsibilities to the host.

No separate Python multi-agent service or fixed model version is required. Available capabilities can differ across Codex CLI, IDE, and desktop clients; the skill follows the tools exposed in the current session. The optional Node.js bridge connects Claude Code, Antigravity, and Codex. Other research partners can use their available channels. Continuing within a tool call and resuming in a later turn are separate capabilities; later continuation requires a configured host route or an authorized schedule.

The package follows the [official skill documentation](https://learn.chatgpt.com/docs/build-skills) and [subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents). This is an independent community project maintained by Aoudsung, with no OpenAI affiliation or endorsement.

## Relationship to existing projects

| Project | Focus described in its official materials | This project's focus |
|---|---|---|
| [AI Scientist-v2](https://github.com/SakanaAI/AI-Scientist-v2) | Topic-to-experiment-to-paper automation with experiment management, tree search, and feedback | Make research questions, constraints, independent judgment, and sustained handoffs explicit in a Codex workflow |
| [Agent Laboratory](https://github.com/SamuelSchmidgall/AgentLaboratory) | Multi-role research with human feedback, co-pilot mode, and state recovery | Maintain user requirements separately from scientific claims, with explicit review input isolation and feedback ownership |
| [AI-Researcher](https://github.com/HKUDS/AI-Researcher) | An end-to-end system for literature, ideas, implementation, validation, and papers | Connect research work to an existing Codex workspace and select evidence methods for the field |
| [karpathy/autoresearch](https://github.com/karpathy/autoresearch) | An agent edits a small training setup, runs it, compares a metric, and keeps improvements | Support open questions whose aims and evaluation still need research, including counterexamples, conditions, and claim revisions |
| [uditgoenka/autoresearch](https://github.com/uditgoenka/autoresearch) | Already supports Codex, bounded loops with success predicates, and single-pass exploration | Sustain open scientific inquiry through question alignment, revisable claims, independent assessment, and evidence records |

This comparison was checked on **2026-10-21**. It describes documented design emphasis, not limits on what other projects can be extended to do. Codex support, multiple agents, review, and resumption are not unique to this project. See [related work](docs/related-work.md) for direct sources and comparison limits.

## Memory and context management

Long research histories need more than a growing summary. The bundled local memory tool separates **live controls**, **the current task packet**, and **persistent source-backed records**. It uses Python 3.10+ and SQLite FTS5 without an API key, embedding download, or background service.

- Search small indexes before reading full evidence.
- Keep claims, decisions, evaluations, evidence, proposals, and checkpoints distinct.
- Retain source snapshots and explicitly invalidate registered dependent conclusions when evidence changes.
- Read current constraints and pause instructions directly from registered control files whenever a packet is built.
- Assemble complete records under a strict character budget; fail if required material cannot fit.
- Count every admitted record left out of a packet and index as many as fit, so stored history is never silently invisible.
- Build independent-analysis and review packets from a curated allowlist, with filtering before ranking and a separate manifest for the lead.

The design draws on [Mem0, QMD, Letta, Graphiti, and claude-mem](docs/memory-foundations.md). Their mechanisms are adapted to scientific claims, evidence validity, and independent judgment. This release does not copy their runtimes or claim semantic retrieval: the built-in search is lexical, and scientific relevance still needs researcher judgment.

See [the memory-tool guide](docs/memory-tool.md) for setup, records, and context assembly. The tool checks its own outputs; it cannot make an inherited conversation independent or enforce filesystem access restrictions.

## Install

To add the skill to a research project:

```sh
git clone https://github.com/Aoudsung/codex-research-orchestrator.git
mkdir -p /path/to/your-research-project/.agents/skills
cp -R codex-research-orchestrator/skills/codex-research-orchestrator \
  /path/to/your-research-project/.agents/skills/
```

Replace the example path with your project directory. If a skill with the same name already exists, compare versions before replacing local changes. You can also ask Codex's skill installer to install `skills/codex-research-orchestrator` from this repository.

The repository includes `plugin.json` for skill distribution. To enable cross-agent exchange, follow [MCP setup](docs/mcp-setup.md) and register only the required adapters. The skill manifest does not silently register services or background processes. Keep provider credentials in the provider's supported local authentication system, outside this repository.

## Start research

In Codex, use:

```text
Use $codex-research-orchestrator to investigate this question: ...
Research object and constraints: ...
Available materials: ...
Deliverable for this task: ...
Allowed implementation, experiments, and external communication: ...
Available resources or budget: ...
```

You do not need to fill a long form first. Codex reads existing materials and asks only about gaps that materially affect the result or authorization. When persistent records are useful, it creates a research directory from the templates. Existing projects retain their own entry points.

To resume:

```text
Use $codex-research-orchestrator to continue research/my-topic.
Check the latest constraints, pause status, and running work before
starting the next necessary action.
```

A typical flow:

```mermaid
flowchart LR
    G[Research goal and key question] --> A[Analysis and mechanism design]
    A --> R[Independent judgment and review]
    R --> D[Lead resolves feedback]
    D --> E[Authorized implementation or observation]
    D --> S[Claims and evidence records]
    E --> S
    S --> N[Next necessary action]
    N --> A
    S --> F[Agreed deliverable complete]
```

Choose steps according to the question; not every round needs every node. Theory can progress through proofs, and literature research through primary sources and counterevidence.

## Adapt to different fields

Change the research question, evidence standards, participants, and execution resources. Keep question alignment, independent judgment, feedback handling, and evidence-based continuation. The skill includes guidance for theory, computational systems, empirical observation, experiments, qualitative research, and reproduction.

- **Algorithms and systems:** preserve implementation and measurement semantics, and test mechanism claims against suitable comparisons.
- **Theory:** use definitions, derivations, proofs, and counterexamples without requiring training or benchmarks.
- **Empirical and qualitative research:** connect source selection and measurement or interpretation to claims; do not treat correlation or fluent narrative as causal evidence.

These are intended uses, not a claim of completed end-to-end validation in every field.

## Repository layout

```text
codex-research-orchestrator/
├── README.md
├── LICENSE
├── plugin.json
├── docs/                         # Design, comparisons, and validation
├── runtimes/agent-bridge/         # Optional shared MCP runtime and three adapters
└── skills/codex-research-orchestrator/
    ├── SKILL.md                  # Codex skill entry point
    ├── agents/openai.yaml        # Display metadata
    ├── assets/project-template/  # Charter, settings, and current state
    ├── scripts/                 # Local research memory and context helper
    └── references/               # Methods, collaboration, records, and integration
```

## Current scope

Version 0.2.0 combines research instructions, templates, local memory, and an optional MCP collaboration runtime. It supports autonomous information exchange within the user's authorization. It does not provide program-enforced spending limits, an automated theorem prover, or an independent cluster scheduler. Research conclusions still need real evidence. Future evaluations can measure goal drift, support for key claims, the effect of independent review, and research output under matched budgets.

[v0.2 validation notes](docs/validation-v0.2.md) state what was checked, including three-process MCP communication and synthetic provider execution. Contributions should describe a concrete failure, its trigger, the current behavior, and the smallest useful correction. Avoid turning one project's special requirements into universal rules.

## Author and license

Created and maintained by [Aoudsung](https://github.com/Aoudsung), based on the author's sustained research collaboration practices. The collaboration instructions and templates were written for this project. Other open-source projects are cited for comparison and context; their established ideas are not claimed as original here.

Copyright © 2026 Aoudsung. Released under the [MIT License](LICENSE).

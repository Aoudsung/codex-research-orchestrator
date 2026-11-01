# Comparison with open-source research automation

Checked on 2026-10-21 using the official repositories, documentation, and original papers below.

## Existing capabilities and our focus

### AI Scientist-v2

The [official repository](https://github.com/SakanaAI/AI-Scientist-v2) covers research themes and ideas through experiments and papers, with Python, model APIs, and compute dependencies. [Section 3 of the paper](https://arxiv.org/html/2504.08066v1#S3) describes experiment management, tree search, stage checkpoints, and visual feedback, including feedback, review-related capabilities, and state records.

Our project makes research questions, user constraints, the information boundary for independent analysis, and responsibility across review and implementation explicit in a Codex protocol.

### Agent Laboratory

The [official repository](https://github.com/SamuelSchmidgall/AgentLaboratory) covers literature, planning, experimentation, and reporting, with autonomous and co-pilot modes and state recovery. [Section 3.3.1 of the paper](https://arxiv.org/pdf/2501.04227) describes human feedback that can cause a subtask to be repeated. The implementation's [`human_in_loop` and `save_state`](https://github.com/SamuelSchmidgall/AgentLaboratory/blob/main/ai_lab_repo.py) handle human input and workflow persistence.

Our project emphasizes separating user constraints from revisable claims, isolating inputs before independent judgment, and recording explicit evidence for resolving each finding.

### AI-Researcher

The [official repository](https://github.com/HKUDS/AI-Researcher) provides a multi-agent workflow from literature and ideas to implementation, validation, and writing. [Section 3.2.1 of the paper](https://arxiv.org/html/2505.18705v1#S3.SS2.SSS1) describes theory-to-implementation checks and feedback. [`flowcache.py`](https://github.com/HKUDS/AI-Researcher/blob/main/research_agent/inno/workflow/flowcache.py) saves messages and context.

Our project integrates directly with a Codex workspace and its tools, using a configurable protocol to support theoretical, observational, and experimental evidence.

### karpathy/autoresearch

The [official README](https://github.com/karpathy/autoresearch/blob/master/README.md) gives an agent a small language-model training setup for autonomous iteration. [`program.md`](https://github.com/karpathy/autoresearch/blob/master/program.md) defines editable files, fixed training time, the evaluation metric, and a keep-or-discard loop. The README mentions Codex and uses Markdown to guide the research organization.

Our project organizes workflows around open scientific questions, including problem decomposition, novelty arguments, conditional claims, and counterexamples, without depending on a single training metric.

### uditgoenka/autoresearch

The [official README](https://github.com/uditgoenka/autoresearch/blob/master/README.md) provides Codex support. Its [orchestrator guide](https://github.com/uditgoenka/autoresearch/blob/master/guide/autoresearch-orchestrator.md) distinguishes loops with mechanical success predicates from single-pass exploration, documentation, and design decisions, documenting limits, state merging, checkpoints, and verification after high-impact changes.

Our project organizes sustained work around the open scientific question itself: constraints, conditional claims, independent assessment, feedback handling, and the scope of evidence. Without an executable success predicate, proofs, counterexamples, and source analysis still advance the agreed deliverable.

### deepseek-ai/dsh-superagent-prototype

The [official repository](https://github.com/deepseek-ai/dsh-superagent-prototype) demonstrates a clean software-engineering architecture for multi-task agent orchestration: a pure zero-I/O domain engine separated from a transactional SQLite `Effects` queue (`afterCommit` triggers, key coalescing, `Later` non-error deferrals), thread subscription fan-out with out-of-scope `handback`, single-writer `HealthBoard` tracking, `+1` human-priority concurrency slots, compact inline cards with spill pointers, `builtInBase` 3-way template baseline upgrades, and an agent-facing `SETUP.md` probe workflow.

In `v1.0.0`, our optional `agent-bridge` and setup tooling adopt and adapt those structural engineering patterns—pure domain/effects separation, a zero-LLM deterministic Research Router (`off | observe | auto`) with thread subscriptions and `bridge_handback`, a Dual-Layer Watchdog with 4-level CLI exit codes (`0/1/2/3`), inline cards + spill pointers, Attention-First Workbench prioritization, `builtInBase` 3-way upgrades, and `SETUP.md`—while preserving capabilities purpose-built for rigorous scientific research:

- **Zero-paraphrase routing & enforced blind isolation:** Instead of an LLM router that paraphrases messages across threads, our router forwards verbatim SHA-256 pointers and hard-blocks cross-thread fan-out for `blind_analysis` and `blind_review` tasks so independent reviewers never see peer conclusions before forming their own judgment.
- **Heterogeneous multi-provider peer collaboration:** Coordinates reciprocal, model-verified work across Codex, Claude Code, Antigravity, and external Pro dialogues with explicit `requiredModel` vs runtime-reported identity evidence.
- **Structured patch DAGs & version-bound validation:** Tracks artifact revisions (`dependsOn`, `supersedes`, SHA-256) and separates inbox receipt, host turn acceptance, two-phase message consumption (`consumed_at`), patch application, validation, and scientific acceptance.
- **Source-backed SQLite FTS5 research memory & zero third-party dependencies:** Maintains structured scientific records (`controls`, `evidence`, `proposal`, `evaluation`) with recursive `needs_review` invalidation when upstream anchors change, running entirely on Python 3.11+ stdlib and Node.js 24+ native ESM (`node:sqlite`).

## Claims supported by this review

This project provides a Codex workflow organized around key scientific questions, continuity of research purpose, and user requirements. Its mechanisms, templates, permission boundaries, and evidence records are inspectable in the repository.

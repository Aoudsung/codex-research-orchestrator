# Comparison with open-source research automation

Checked on 2026-10-21 using the official repositories, documentation, and original papers below. This is a scoped review, not an exhaustive survey. It compares designs without running a performance benchmark. Links point to the public sources read at that time; later versions may change behavior.

## Existing capabilities and our focus

### AI Scientist-v2

The [official repository](https://github.com/SakanaAI/AI-Scientist-v2) covers research themes and ideas through experiments and papers, with Python, model APIs, and compute dependencies. [Section 3 of the paper](https://arxiv.org/html/2504.08066v1#S3) describes experiment management, tree search, stage checkpoints, and visual feedback. The system already includes feedback, review-related capabilities, and state records; it should not be reduced to a single training loop.

Our project makes research questions, user constraints, the information boundary for independent analysis, and responsibility across review and implementation explicit in a Codex protocol. This is a comparison of delivery form and emphasis, not a claim that the other system cannot support these mechanisms.

### Agent Laboratory

The [official repository](https://github.com/SamuelSchmidgall/AgentLaboratory) covers literature, planning, experimentation, and reporting, with autonomous and co-pilot modes and state recovery. [Section 3.3.1 of the paper](https://arxiv.org/pdf/2501.04227) describes human feedback that can cause a subtask to be repeated. The implementation's [`human_in_loop` and `save_state`](https://github.com/SamuelSchmidgall/AgentLaboratory/blob/main/ai_lab_repo.py) handle human input and workflow persistence.

Our project does not claim human involvement or state saving as inventions. Its emphasis is the separation of user constraints from revisable claims, input isolation before independent judgment, and explicit evidence for resolving each finding.

### AI-Researcher

The [official repository](https://github.com/HKUDS/AI-Researcher) provides a multi-agent workflow from literature and ideas to implementation, validation, and writing. [Section 3.2.1 of the paper](https://arxiv.org/html/2505.18705v1#S3.SS2.SSS1) describes theory-to-implementation checks and feedback. [`flowcache.py`](https://github.com/HKUDS/AI-Researcher/blob/main/research_agent/inno/workflow/flowcache.py) saves messages and context. It would be inaccurate to say that the project has no review or persistent state.

Our project integrates with a Codex workspace and its tools, using a configurable protocol to support different forms of evidence. It does not reproduce AI-Researcher's execution backend; a feature table alone cannot establish relative capability.

### karpathy/autoresearch

The [official README](https://github.com/karpathy/autoresearch/blob/master/README.md) gives an agent a small language-model training setup for autonomous iteration. [`program.md`](https://github.com/karpathy/autoresearch/blob/master/program.md) defines editable files, fixed training time, the evaluation metric, and a keep-or-discard loop. The README already mentions Codex and uses Markdown to guide the research organization.

Our project does not claim Markdown instructions or Codex compatibility as firsts. It extends its own workflow around open scientific questions, including problem decomposition, novelty arguments, conditional claims, and counterexamples. Progress need not depend on one training metric.

### uditgoenka/autoresearch

The [official README](https://github.com/uditgoenka/autoresearch/blob/master/README.md) already provides Codex support. Its [orchestrator guide](https://github.com/uditgoenka/autoresearch/blob/master/guide/autoresearch-orchestrator.md) distinguishes loops with mechanical success predicates from single-pass exploration, documentation, and design decisions. It also documents limits, state merging, checkpoints, and verification after high-impact changes.

Our project organizes sustained work around the open scientific question itself: constraints, conditional claims, independent assessment, feedback handling, and the scope of evidence. Without an executable success predicate, proofs, counterexamples, and source analysis can still advance the agreed deliverable. The projects overlap; bounded execution, verification, and recovery are not unique here.

## Claims supported by this review

**Supported:** this project provides a Codex workflow organized around key scientific questions, continuity of research purpose, and user requirements. Its mechanisms, templates, permission boundaries, and evidence records are inspectable in the repository.

**Not established:** being the first or only Codex research tool; introducing multi-agent work, human feedback, review, or memory for the first time; outperforming these systems; or guaranteeing valuable unattended research.

If a mechanism is not described in the reviewed materials, that is a limit of the evidence, not proof that the project lacks it. Future comparisons should cite direct sources and distinguish paper descriptions, current default behavior, and measured results.

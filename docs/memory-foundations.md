# Memory and context: references and adaptation

We inspected mature open-source memory projects to adapt useful mechanisms for scientific collaboration.

GitHub star counts below were read from the GitHub repository API on **2026-10-21**.

| Project | Stars | Mechanism considered | Research-specific adaptation |
|---|---:|---|---|
| [Mem0](https://github.com/mem0ai/mem0) | 67,549 | Durable memory records, extraction, and multi-signal retrieval | Store explicitly typed research records rather than extracting untyped conjectures as facts. |
| [QMD](https://github.com/tobi/qmd) | 30,516 | Local document search, collection context, short results followed by selective reads | Keep memory project-local; retrieve small indexed records first and load only the necessary evidence. Add scientific status and review boundaries before selection. |
| [Letta](https://github.com/letta-ai/letta) | 25,210 | Layered file memory, progressive reading, and separate conversation recovery | Use a small task context and durable source records, with summaries guiding retrieval to original sources. |
| [Graphiti](https://github.com/getzep/graphiti) | 32,091 | Provenance, temporal validity, and retained invalidated facts | Preserve revisions and invalidate dependent conclusions explicitly. |
| [claude-mem](https://github.com/thedotmack/claude-mem) | 101,996 | Search indexes before full observations, with bounded context rendering | Assemble a task-specific packet under an explicit size limit, keeping required constraints and selected evidence intact. |

## What the inspected versions actually do

**Mem0.** Its current [OSS migration guide](https://github.com/mem0ai/mem0/blob/main/docs/migration/oss-v2-to-v3.mdx) describes ADD-only extraction and hybrid retrieval using semantic, keyword, and entity signals, distinguishing the hosted graph feature from OSS. Our research records are entered explicitly by the lead, with type, scope, source, and dependencies.

**QMD.** The [README](https://github.com/tobi/qmd/blob/main/README.md) describes local BM25, vector retrieval, and model reranking, plus collection/path context and bounded document reads. We adopt local indexing and progressive disclosure using SQLite full-text retrieval.

**Letta.** The inspected repository points to Letta Code as the current implementation. [MemFS](https://docs.letta.com/concepts/memfs) separates root memory from deeper material, while [conversation handling](https://docs.letta.com/concepts/conversations) distinguishes saved history and compaction. We adapt layered access and recovery pointers.

**Graphiti.** Its [edge model](https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py) records creation and validity times with episode provenance. [Contradiction handling](https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/edge_operations.py) applies model judgments and temporal rules; [search filters](https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_filters.py) expose time filtering. We adapt explicit supersession and source dependencies in SQLite.

**claude-mem.** Its [search protocol](https://github.com/thedotmack/claude-mem/blob/main/docs/public/usage/search-tools.mdx) moves from indexes to selected observations. [Context budgeting](https://github.com/thedotmack/claude-mem/blob/main/src/services/context/ContextBudget.ts) measures rendered size and removes whole items. We adapt that retrieval order and whole-record budgeting.

## What changes for research

The organizing unit is a **claim with conditions and evidence**, rather than an undifferentiated remembered fact. The design preserves three separate questions:

1. Is this record relevant to the current question?
2. Is it still applicable, and what supports it?
3. May this participant see it before forming an independent judgment?

A highly relevant review can still contaminate independent analysis. A recent summary can still depend on retracted evidence. A short packet can still omit a required constraint unless required tiers are protected. Retrieval and context assembly therefore use explicit record types, validity states, dependencies, and participant-specific input lists.

No upstream source code is copied or vendored; this implementation and documentation are released under the repository's MIT license.

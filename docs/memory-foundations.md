# Memory and context: references and adaptation

We inspected mature open-source projects before designing the research memory layer. The goal is to adapt useful mechanisms to scientific collaboration, not to copy an entire runtime or treat popularity as proof of quality.

GitHub star counts below were read from the GitHub repository API on **2026-10-21**. They are a dated selection signal, not a benchmark.

| Project | Stars | Mechanism considered | Research-specific adaptation |
|---|---:|---|---|
| [Mem0](https://github.com/mem0ai/mem0) | 67,549 | Durable memory records, extraction, and multi-signal retrieval | Store explicitly typed research records. Do not silently turn a conjecture or reviewer opinion into a fact through extraction. |
| [QMD](https://github.com/tobi/qmd) | 30,516 | Local document search, collection context, short results followed by selective reads | Keep memory project-local; retrieve small indexed records first and load only the necessary evidence. Add scientific status and review boundaries before selection. |
| [Letta](https://github.com/letta-ai/letta) | 25,210 | Layered file memory, progressive reading, and separate conversation recovery | Use a small task context and durable source records. A summary guides retrieval; it does not replace original requirements or evidence. |
| [Graphiti](https://github.com/getzep/graphiti) | 32,091 | Provenance, temporal validity, and retained invalidated facts | Preserve revisions and invalidate dependent conclusions explicitly. A more recent record does not automatically refute an older scientific claim. |
| [claude-mem](https://github.com/thedotmack/claude-mem) | 101,996 | Search indexes before full observations, with bounded context rendering | Assemble a task-specific packet under an explicit size limit. Protect required constraints and selected evidence rather than blindly favoring recent records. |

## What the inspected versions actually do

**Mem0.** Its current [OSS migration guide](https://github.com/mem0ai/mem0/blob/main/docs/migration/oss-v2-to-v3.mdx) describes ADD-only extraction and hybrid retrieval using semantic, keyword, and entity signals. It also distinguishes the hosted graph feature from OSS. We therefore do not describe its current extraction as the older automatic ADD/UPDATE/DELETE process. Our research records are entered explicitly by the lead, with type, scope, source, and dependencies. Ranking alone cannot establish whether an old claim is still usable.

**QMD.** The [README](https://github.com/tobi/qmd/blob/main/README.md) describes local BM25, vector retrieval, and model reranking, plus collection/path context and bounded document reads. We adopt local indexing and progressive disclosure. The initial implementation uses SQLite full-text retrieval without adding an embedding model or reranker. It does not reproduce QMD's hybrid semantic search or claim equal retrieval quality.

**Letta.** The inspected repository points to Letta Code as the current implementation. [MemFS](https://docs.letta.com/concepts/memfs) separates root memory from deeper material, while [conversation handling](https://docs.letta.com/concepts/conversations) distinguishes saved history and compaction. We adapt layered access and recovery pointers. Keeping a file in memory does not make it authoritative, and a version history does not determine who may change a user requirement.

**Graphiti.** Its [edge model](https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py) records creation and validity times with episode provenance. [Contradiction handling](https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/edge_operations.py) applies model judgments and temporal rules; [search filters](https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_filters.py) expose time filtering. We adapt explicit supersession and source dependencies, without claiming automatic scientific contradiction detection or importing a graph database. Conditions and evidence still require researcher judgment.

**claude-mem.** Its [search protocol](https://github.com/thedotmack/claude-mem/blob/main/docs/public/usage/search-tools.mdx) moves from indexes to selected observations. [Context budgeting](https://github.com/thedotmack/claude-mem/blob/main/src/services/context/ContextBudget.ts) measures rendered size and removes whole items. We adapt that retrieval order and whole-record budgeting. Its hook-specific size limit is not a Codex token limit, and recency does not establish scientific validity.

## What changes for research

The organizing unit is a **claim with conditions and evidence**, rather than an undifferentiated remembered fact. The design must preserve three separate questions:

1. Is this record relevant to the current question?
2. Is it still applicable, and what supports it?
3. May this participant see it before forming an independent judgment?

A highly relevant review can still contaminate independent analysis. A recent summary can still depend on retracted evidence. A short packet can still be wrong if it silently omits a required constraint. Retrieval and context assembly therefore need explicit record types, validity states, dependencies, and participant-specific input lists.

These are adaptations of established ideas, with a research-specific protocol and implementation. No upstream source code is copied or vendored by this project. Upstream license terms remain with their respective projects; our own implementation and instructions use the repository's MIT license.

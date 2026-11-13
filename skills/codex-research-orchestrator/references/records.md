# Recordkeeping: SQLite Single-Write & On-Demand Markdown Views

Keep project state lean and non-duplicative.

## Single Source of Truth vs. On-Demand Export

| Artifact | Authority & Write Cadence |
|---|---|
| `controls.md` / `charter.md` | Verbatim user constraints, question, and deliverable boundaries. Update **only** on explicit user instruction. |
| `project.md` | Participants, tool bindings, authorizations, and resource caps. Update **only** when configuration or permissions change. |
| `.research-memory/memory.sqlite3` | **Primary runtime ledger (`research_record`).** Record substantive results, claims, decisions, tombstones (`<=40` words), controlled forks, evaluations, and checkpoints **once** per milestone—not after every tool call. |
| `state.md` / exported Markdown | **On-demand human checkpoint view.** Update or generate via `research_export(format="markdown", ...)` **only** at user-facing briefings, session pause/compaction, or final delivery—**not** on every routine round. |
| `agent-bridge` SQLite | Execution inbox, cursors, permission leases, patches, and `recordValidation` results. Reference IDs from `checkpoint` records rather than duplicating logs. |

*(Standalone file-only projects without `.research-memory/memory.sqlite3` retain `state.md` as an atomic whole-file replacement updated at meaningful round conclusions.)*

## Compact Formats When Reporting or Exporting

### Execution Receipt (from `Implementer` / Runner)
State line 1 as `complete | partial | blocked`, followed by: delivered version/patch IDs, changed files, exact commands, exit code, raw key metrics with units & artifact paths, deviations, and unexecuted checks.

### Checkpoint / Pause View (`state.md` Export)
Include only: task status, live `controls.md` version, active claims/decisions & controlled hypothesis forks, one-line ruled-out tombstones (`<=40` words + evidence ID), active job/bridge task IDs + cursors, budget spent/remaining, and next concrete action.

### User Briefing
Report only judgments that changed since the last user update, supporting evidence IDs/paths, completed deliverables, and genuine pending user decisions. Final delivery must stand alone without forcing the user to read intermediate chatter.

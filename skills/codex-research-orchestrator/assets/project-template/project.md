# Project Configuration

Record only settings active for this project; preserve explicit authorizations and mark material unknowns as "not recorded".

## Entry Points & Objective
- Research topic, directory & authoritative constraints (`controls.md`):
- Overall objective (original research / reproduction / survey / bounded support):
- Current assignment & completion boundary:
- Lead researcher & code/data/evaluation entry points:

## Participants & Tool Topology
Include **Claude (`claude-code`)** only when the user explicitly declares it available. Roles do not lock providers; keep one owner per write region.

| Responsibility | Participant | Read/Write Scope | Model Adapter & Effort Tier |
|---|---|---|---|
| Lead researcher | | | |
| Main author (if assigned) | | | |
| Independent reviewer | | | |
| Implementer | | | |
| Brainstormer / Observer (optional) | | | |

- Group delegation, peer contact & blind-isolation allowlist policy:

## Authorization, Execution & Resumption
| Action | Authorized scope | Source | Limits / Confirmation needed |
|---|---|---|---|
| Read/write code & run experiments | | | |
| External sharing & ongoing sessions | | | |

- Execution environment, compute/cost budget, and stop conditions:
- Primary ledger: `.research-memory/memory.sqlite3` (`research_record`); on-demand human view: `state.md` (`research_export`).
- Active MCP profile (`BRIDGE_TOOL_PROFILE`: `lead` / `worker` / `exec_only`) and session bindings:

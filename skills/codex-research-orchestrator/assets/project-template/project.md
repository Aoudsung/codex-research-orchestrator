# Project Configuration

Record only settings active for this project; preserve explicit authorizations and mark material unknowns as "not recorded".

## Entry Points & Objective
- Research topic, directory & authoritative constraints (`controls.md`):
- Overall objective (original research / reproduction / survey / bounded support):
- Current assignment & completion boundary:
- Lead researcher & code/data/evaluation entry points:

## Participants & Session Lanes
Claude (`claude-code`) is disabled unless explicitly overridden in `controls.md`. Three lanes: GPT -> Codex; Gemini (Carbon/Argon) -> pinned Antigravity; Kimi/DeepSeek -> `.pi/sessions/` (`magpie` `auto/*`, `retries=0`, no `dyschop/*`).

| Responsibility | Model / Participant | Session Lane | Read/Write Scope | Effort |
|---|---|---|---|---|
| Coordinator (non-coding) | Codex Lead | Codex | Control/ledger only | high |
| Chief Macro Architect | ChatGPT Web Pro | Web Project (15m Luna check) | Grounding bundle/repo | pro_max |
| Co-Design & Panoramic Scan | Gemini Carbon | Antigravity (short deltas) | Read-only + diff proposal | high |
| Formalization & Blind Review | GPT Astra | Codex (isolated) | Review-only | high/xhigh |
| Implementation & Server Runs | Gemini Argon / GPT-6.1 Sol / Kimi / DeepSeek | Agy / Codex / PI | Exclusive `writeRoots` | medium |
| L0 Server & Pro Observer | GPT-6 Luna | Codex subagent | Read-only | low |

- Group delegation, peer contact & blind-isolation allowlist policy:

## Authorization, Execution & Resumption
| Action | Authorized scope | Source | Limits / Confirmation needed |
|---|---|---|---|
| Read/write code & run experiments | | | |
| External sharing & ongoing sessions | | | |

- Execution environment, compute/cost budget, and stop conditions:
- Primary ledger: `.research-memory/memory.sqlite3` (`research_record`); on-demand human view: `state.md` (`research_export`).
- Active MCP profile (`BRIDGE_TOOL_PROFILE`: `lead` / `worker` / `exec_only`) and session bindings:

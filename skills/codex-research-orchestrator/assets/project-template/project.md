# Project Configuration

Record only settings active for this project; preserve explicit authorizations and mark material unknowns as "not recorded".

## Entry Points & Objective
- Research topic, directory & authoritative constraints (`controls.md`):
- Overall objective (original research / reproduction / survey / bounded support):
- Current assignment & completion boundary:
- Lead researcher & code/data/evaluation entry points:

## Participants & Session Lanes
Claude (`claude-code`) is disabled unless explicitly overridden in `controls.md`. Three lanes: GPT -> Codex (`Astra` / `Sol` / `default|explorer` + `gpt-6-luna` `low`; `agent_type="Luna"` reserved for tool-free effort judging); Gemini (`Carbon`/`Argon`) -> pinned project PI session first, falling back to pinned/dedicated Antigravity; Kimi/DeepSeek -> explicit `.pi/sessions/` (`magpie` `auto/*`, `retries=0`, no `dyschop/*`). Use `bridge_plan_dispatch` before delegating; store fixed bindings in `.agent-bridge/collaborators.json`.

| Responsibility | Model / Participant | Session Lane | Read/Write Scope | Effort |
|---|---|---|---|---|
| Coordinator (non-coding) | Codex Lead | Codex | Control/ledger only | high |
| Chief Macro Architect | ChatGPT Web Pro | Web Project (15m `Luna` check) | Grounding bundle/repo | pro_max |
| Co-Design & Panoramic Scan | Gemini Carbon | Pinned PI -> Antigravity | Read-only + diff proposal | high |
| Formalization, Efficiency & Blind Review | GPT Astra | Codex (`architect`/`reviewer`) | Read/review only | judged (`high`/`xhigh`) |
| Implementation & Server Runs | Gemini Argon / GPT Sol (project catalog) / Kimi / DeepSeek | Pinned PI/Agy / Codex / PI | Exclusive `writeRoots` | judged per task |
| L0 Server & Pro Observer | GPT-6 Luna | Codex `default`/`explorer` | Read-only | low |

- Group delegation, peer contact & blind-isolation allowlist policy:

## Authorization, Execution & Resumption
| Action | Authorized scope | Source | Limits / Confirmation needed |
|---|---|---|---|
| Read/write code & run experiments | | | |
| External sharing & ongoing sessions | | | |

- Execution environment, compute/cost budget, and stop conditions:
- Primary ledger: `.research-memory/memory.sqlite3` (`research_record`); on-demand human view: `state.md` (`research_export`).
- Active MCP profile (`BRIDGE_TOOL_PROFILE`: `lead` / `worker` / `exec_only`) and session bindings:

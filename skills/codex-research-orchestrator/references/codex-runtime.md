# Codex Runtime Capabilities

Use native Codex capabilities first without requiring external frameworks or auto-editing `~/.codex` global configs.

| Research need | Codex native capability | Fallback if unavailable |
|---|---|---|
| Lead synthesis & acceptance | Active Codex session owns goal, decisions, acceptance | Continue single-agent |
| Parallel / blind analysis | Spawn subagents without parent evaluation history | Perform self-check; note unmet blind review |
| Code edits & experiments | Workspace file tools + terminal within approved sandbox | Deliver design/patch + list unrun checks |
| Long runs | Retain terminal/job IDs; wait for completion notifications | Save resumption command; avoid duplicates |
| Sustained memory | Bundled `scripts/research_memory.py` (Python 3.10+ SQLite FTS5) | File checkpoints; note unindexed retrieval |
| Persistent external peers | Optional `runtimes/agent-bridge` MCP when configured (`mcp-collaboration.md`) | Export self-contained handoff packet |

- **Subagent isolation:** When delegating independent review or `blind_analysis`, disable conversation history inheritance and pass only the curated `research_context` packet. Route subagent receipts back to Lead for serial `research_record` writes.
- **Automation boundary:** Distinguish in-turn `waitForDelivery` from cross-turn schedules (cross-turn scheduling requires explicit user request and host support). Save a `state.md` resumption checkpoint whenever pending work moves off-turn.

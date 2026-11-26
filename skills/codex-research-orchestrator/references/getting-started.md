# Setup, Initialization & Multi-Peer Connection

Requires Python 3.11+ (stdlib only) for skill/memory setup, and Node.js 24+ only when enabling the optional `agent-bridge` MCP server or Workbench.

## 1. Install or Upgrade
From the release checkout:
```sh
python3 /path/to/codex-research-orchestrator/setup.py install --project /path/to/project
```
- Installs skill into `.agents/skills/codex-research-orchestrator` and optional bridge runtime into `.research-orchestrator/runtime/agent-bridge` (use `--skill-only` for native research without bridge; `--upgrade` backs up and replaces managed files while preserving project records and DBs).

## 2. Initialize from User's Question
Inspect existing charters/databases first—never overwrite active research:
```sh
python3 /path/to/project/.agents/skills/codex-research-orchestrator/scripts/research_setup.py init \
  --project /path/to/project --question "Verbatim user request" --title "Short title"
```
Creates `controls.md`, `charter.md`, `project.md`, `state.md`, and `.research-memory/memory.sqlite3`. Begin useful work immediately without waiting for every optional template field.

## 3. Connect Requested Peers (`BRIDGE_TOOL_PROFILE` Auto De-duplication)
Choose only explicitly requested peers (**never auto-enable `claude-code` unless the user declares it**):
```sh
python3 /path/to/project/.agents/skills/codex-research-orchestrator/scripts/research_setup.py connect \
  --project /path/to/project --client codex --peers antigravity
```
- With `--tool-profile auto`, the first peer receives the Lead tools. Secondary peers use `exec_only` so the host loads the shared schemas once. Use `--tool-profile worker` for members that claim work, read their assigned briefs, post on the board and submit receipts. A project with research memory also exposes its profile-appropriate memory tools.
- Add `--apply` only when the user wants project-local config updated (`.codex/config.toml`, `.mcp.json`, or `.agents/mcp_config.json`); existing unrelated entries and collisions are preserved/reported, never overwritten blindly.

## 4. Lint & Diagnose Setup
```sh
python3 /path/to/project/.agents/skills/codex-research-orchestrator/scripts/research_setup.py lint --project /path/to/project --json
python3 /path/to/project/.agents/skills/codex-research-orchestrator/scripts/research_setup.py doctor --project /path/to/project --json
```
Read-only lint & health checks (`DOC-001/002`, `GIT-001`, `MCP-001`, `ROUTE-001`, `TASK-001`, `MEM-001`); missing optional bridge/Node never blocks local research.

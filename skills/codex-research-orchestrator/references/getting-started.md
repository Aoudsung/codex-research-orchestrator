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
- **Automatic multi-peer schema de-duplication:** When `--tool-profile auto` (default), peer `index == 0` receives `BRIDGE_TOOL_PROFILE="lead"` (33 compressed tools) and secondary peers (`index >= 1`, e.g. `--peers antigravity claude-code`) receive `BRIDGE_TOOL_PROFILE="exec_only"` (**0** duplicated shared tools, preventing ~11k–22k token schema bloat). Override with `--tool-profile worker` (9 tools) or `full`.
- Add `--apply` only when the user wants project-local config updated (`.codex/config.toml`, `.mcp.json`, or `.agents/mcp_config.json`); existing unrelated entries and collisions are preserved/reported, never overwritten blindly.

## 4. Diagnose Setup
```sh
python3 /path/to/project/.agents/skills/codex-research-orchestrator/scripts/research_setup.py doctor --project /path/to/project --json
```
Read-only health check reporting missing runtimes or host reload needs. Follow immediately with requested research.

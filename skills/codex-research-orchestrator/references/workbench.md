# Optional Collaboration Workbench

Start the visual Attention-First UI when requested by the user (requires complete bundle + Node.js 24+):
```sh
python3 /path/to/project/.agents/skills/codex-research-orchestrator/scripts/research_setup.py workbench --project /path/to/project --open
```
Add `--demo` for isolated demo mode or `--port 0` if the default port is busy; never commit the private loopback URL.

- **Capabilities:** Displays `Needs human attention`, `HealthBoard` component status, `+1` human-priority queue, `Router: Off | Observe | Auto` controls, SQLite memory records, and bridge tasks/messages/patches/validations (`read` is strictly non-mutating).
- **Controls:** Supports approving `observe` `would_dispatch` proposals, retrying circuit-broken deliveries, answering `bridge_handback` questions (`resolveHandback: true`), and toggling project-wide pause (blocks new execution admission while preserving reads and in-flight completions).

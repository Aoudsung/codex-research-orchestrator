# Collaboration workbench

Use the optional workbench when the user wants a visual view of collaboration or explicitly submits task, dispatch, messaging, or pause/resume actions. It requires the complete bundle and Node.js 24+. The standalone research skill and memory helper still work without it.

From the installed project:

```sh
python3 /path/to/project/.agents/skills/codex-research-orchestrator/scripts/research_setup.py workbench --project /path/to/project --open
```

For a fictional demonstration, add `--demo`. It does not contact providers or modify the selected project's research/bridge records. Use `--port 0` if the default loopback port is occupied. Keep the server running while the browser is in use. The printed access URL is private to that instance and must not enter shared artifacts.

The workbench presents an Attention-First overview (`Needs human attention`, `HealthBoard` component badges, `+1` human-priority slot load, and `Router: Off | Observe | Auto` controls) alongside project records, bridge tasks/messages/artifacts/validation, and memory records with their source state. Source reads do not mark messages read, recalculate memory validity, initialize missing databases, or start providers. Explicit actions include approving `observe`-mode `would_dispatch` proposals, retrying circuit-broken deliveries, answering `bridge_handback` questions (`resolveHandback: true`), and switching router modes.

Task creation and dispatch are separate. Dispatch needs an explicit model and uses the recorded task, session, project, and permission scope. Workbench-origin messages are user-initiated input acting for the selected participant. Interpret receipts according to [external collaboration](mcp-collaboration.md).

The project-wide bridge pause blocks new execution admission and automatic follow-up. Already admitted calls may finish. Reads, task creation, saved messages, and completed results remain available; resume allows queued follow-up without changing independent route settings.

Keep unknown values visible, and distinguish requested model settings from runtime-reported model identity. Research files remain authoritative. Use the overview, map, filters, source viewers, and task inspector to locate relevant evidence, and apply the assigned role and task acceptance criteria.

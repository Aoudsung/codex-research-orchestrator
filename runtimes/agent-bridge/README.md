# Research Agent Bridge

An optional local MCP runtime for autonomous, reciprocal information exchange and task collaboration among **Claude Code, Antigravity, and Codex**.

Three backend adapters share one durable message and task store. Participants can request work, ask questions, return artifacts, exchange focused feedback, and continue the same authorized task with less manual relay.

## Recommended setup

From the complete repository, run `python3 setup.py install --project /path/to/your-project`, then ask Codex to connect the peers you want. The installed setup helper creates real paths and project-scoped configuration; see the [getting-started guide](https://github.com/Aoudsung/codex-research-orchestrator/blob/main/docs/getting-started.md).

The manual command below is for users managing the runtime separately.

## Run a server

Requires Node.js 24 or later. No npm packages are required.

Choose the directory that contains this runtime's `package.json` and `src/`:

```sh
# From the full repository checkout:
cd runtimes/agent-bridge
```

For a standalone runtime archive, enter its extracted top-level directory instead; do not append `runtimes/agent-bridge`. For a project installed with the setup helper, the runtime directory is `.research-orchestrator/runtime/agent-bridge` under that project.

From the runtime directory, run:

```sh
AGENT_BRIDGE_DB=/absolute/path/to/project/.agent-bridge/bridge.sqlite \
MCP_CALLER_AGENT=codex \
node src/servers/claude-code-mcp.mjs
```

The process speaks MCP over standard input and output and is normally started by an MCP client. Replace the server filename to expose another execution backend:

- `claude-code-mcp.mjs`: Claude Code execution and resumption.
- `antigravity-mcp.mjs`: Antigravity execution and communication.
- `codex-mcp.mjs`: Codex execution, resumption, and related operations.

The shared bridge tools are available through every adapter. Set `MCP_CALLER_AGENT` to the actual connecting client: `codex`, `claude-code`, or `antigravity`. Use the same absolute `AGENT_BRIDGE_DB` for participants in one collaboration. No task, account, or wakeup route is preloaded.

Provider execution needs the corresponding installed CLI and its normal authentication. Common messaging and task operations can run without those CLIs. Read the [setup instructions](https://github.com/Aoudsung/codex-research-orchestrator/blob/main/docs/mcp-setup.md) before registering a server; the skill does not modify your global configuration automatically.

## Operating contract

Use the tool schemas returned by the installed server. The common surface includes task creation and overview, preflight, incremental messages, structured patch submission and retrieval, validation feedback, delivery waiting, and completion.

- Task, session, model requirement, workspace, and artifact revision stay connected through follow-up work.
- Requested model identity and runtime-reported identity remain distinct.
- Preflight checks the selected execution mode; it does not grant human authorization or replace the host sandbox.
- Patch writes need explicit scope, and application depends on a valid prerequisite set.
- Process exit, inbox receipt, artifact delivery, verification, review, and acceptance remain separate facts.
- Wait responses describe the updates received. A coalescing window does not establish complete delivery.
- Host wakeup requires a configured compatible route and an actual acceptance receipt. No idle-chat wakeup is enabled by default.
- Summary operations keep full artifact contents out of the ordinary handoff. Retrieve the original when it is needed.

The agents decide their next authorized action using the skill and task instructions. The bridge transports and records that work; storing a message alone does not launch a provider process or authorize a new task.

## Verify the runtime

From this directory, run:

```sh
npm test
```

Tests use temporary databases, synthetic tasks, and isolated MCP processes. They must not use real accounts, active research tasks, or user-global configuration. The release validation record distinguishes transport/contract checks from actual provider and desktop-host verification.

## Distribution

This runtime was adapted from the author's existing local bridge for public distribution. Private task seeds, routes, identifiers, paths, and state are excluded. Only the source, tests, neutral examples, package metadata, and license are distributed.

The runtime is optional. Installing the standalone research skill does not install it or start a service. Keep generated databases and logs outside the runtime package.

Copyright © 2026 Aoudsung. [MIT License](LICENSE).

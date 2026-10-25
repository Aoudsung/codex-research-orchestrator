# Connect Claude Code, Antigravity, and Codex

The optional bridge supports reciprocal, task-bound communication among the three agents. They can exchange requests, evidence, revisions, and results and continue authorized work without asking a person to relay every message.

The research skill remains usable without this runtime. Enable only the connections needed for your project.

## Requirements

- Node.js 24 or later, including its built-in SQLite module.
- A local checkout of this repository or the runtime release archive.
- The relevant provider CLI when you want to start or resume that provider through the bridge. Messaging and synthetic transport tests do not require provider accounts.
- An explicitly chosen database path, shared by the participating MCP processes and kept outside the installed runtime.

There are no npm dependencies to install. Provider authentication stays in each provider's supported local configuration. The optional Antigravity SDK route requires its own SDK installation; the CLI and message bridge do not require that route.

## Choose connections

The server filename identifies the execution backend. `MCP_CALLER_AGENT` identifies the client connecting to it.

| Client | Useful server adapters | Caller identity |
|---|---|---|
| Codex | Claude Code and Antigravity | `codex` |
| Claude Code | Codex and Antigravity | `claude-code` |
| Antigravity | Codex and Claude Code | `antigravity` |

Every server exposes the shared message/task tools. You do not need all six possible client-to-backend links for a smaller collaboration. All processes in one collaboration must use the same `AGENT_BRIDGE_DB`; different projects should use separate databases.

## Register an adapter explicitly

Add an MCP entry using your client's supported configuration interface. For example, this JSON describes the Claude Code adapter as seen from Codex:

```json
{
  "mcpServers": {
    "research-claude": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/codex-research-orchestrator/runtimes/agent-bridge/src/servers/claude-code-mcp.mjs"
      ],
      "env": {
        "AGENT_BRIDGE_DB": "/absolute/path/to/research-project/.agent-bridge/bridge.sqlite",
        "MCP_CALLER_AGENT": "codex"
      }
    }
  }
}
```

Replace the example paths before registration; do not assume the host expands placeholders. For another client, change the caller identity. For another backend, select `codex-mcp.mjs` or `antigravity-mcp.mjs`.

Configuration formats differ by host. The example is a registration description, not a command that rewrites all client configurations. This repository does not run a global installer or enable a notification route when the skill is loaded.

Keep the database, its WAL files, logs, credentials, and generated host configuration out of public exports.

## Start a collaboration

Ask the coordinating agent to:

1. Inspect the available tool schemas and confirm the necessary provider and host capabilities.
2. Create a task with its participant, exact model requirement where applicable, workspace, read/write scope, and completion conditions. Verify preflight for the intended delivery mode.
3. Use the provider's execution or resume tool when another runtime must start work. A queued task or inbox message alone does not launch a provider process.
4. Exchange additional questions and evidence through the same task and conversation. Use explicit recipients or a reply reference; fetch only incremental messages.
5. Return structured artifacts and a final receipt. Associate verification and repair feedback with that artifact revision.
6. Accept only the completed scope supported by evidence, then close the task and its temporary lease.

Participants may initiate authorized exchanges themselves. The user defines the task's scope and resource limits; a message or permission record cannot expand them.

In a delegated implementation workflow, the external author performs analysis, editing, self-checks, and repair. Codex reads compact receipts, applies or examines the relevant artifact, performs required validation, and makes the final acceptance decision. It need not repeat every investigation performed by the author.

## Choose the right continuation mode

**Within the current turn:** `bridge_send_message` and `bridge_record_validation` can wait for subsequent delivery updates. Use the returned cursor and receipt. The configured quiet window groups nearby messages; it cannot prove that an entire patch set has arrived.

**Across turns:** configure a host route explicitly if the client supports it. Confirm actual acceptance by the bound host and target turn before relying on idle-chat continuation. Inbox events, waiter callbacks, and forwarding-process success are distinct from target-chat execution.

When a channel cannot push a result, use only the scoped scheduled check the user authorized. Do not create polling loops for all agents. A timeout preserves the original task; reconcile its status before deciding whether further action is needed.

The bridge's wait and coalescing values are runtime settings. They must fit the actual MCP client's deadline. A server timeout longer than the client permits does not extend the client limit.

## Model and conversation evidence

Keep the requested model separate from runtime-reported identity. A CLI flag shows what was requested, not independent confirmation of what ran. Known mismatches must fail. When a required identity cannot be established, keep that limitation visible rather than switching providers or treating a request as verification.

When runtime-reported model identity is required, set `metadata.requireVerifiedModel: true` on the task. The bridge distinguishes requested identity from runtime evidence. The Antigravity SDK path does not provide the same runtime identity evidence and cannot resume an explicitly bound conversation; it reports those limitations. `backend: "auto"` selects the CLI path and does not silently switch to a different provider or the SDK.

Continue the bound session through revisions. Reusing a task ID is not an instruction to silently replace its original scope or conversation. Check the task overview before resumption.

## Artifacts and completion

Use structured patch tools for patches and the message tools for questions, explanations, and compact receipts. Preserve patch originals; do not reconstruct them from shortened logs. Validate dependencies and replacements before applying a patch set.

Do not equate a CLI exit code of zero, a new inbox message, or a quiet sender with a complete delivery. A complete delivery names the artifact revision and the material it contains. Validation and review state what was checked and on which revision. They do not by themselves establish scientific benefit.

For a patch delivery, attach a final manifest to the completion message, for example:

```json
{
  "delivery": {
    "final": true,
    "revision": 1,
    "patchIds": ["patch-001", "patch-002"]
  }
}
```

Pass this object as message `metadata`. Delivery waits report `updatesReceived`, `artifactDeliveryComplete`, and host `delivered` separately. A complete artifact set can be available before a later-turn host wakeup is confirmed. Fetch exact message text and patch content through the explicit read operations; ordinary wait replies contain compact summaries.

Preflight supports `deliveryMode` values `direct`, `read_only`, and `mcp_structured_patch`. Structured-patch mode requires explicit allowed target paths but does not require the author to write those files locally. Direct execution must meet its actual tool and path requirements; declaring patch delivery does not authorize a direct write.

See [MCP collaboration rules](../skills/codex-research-orchestrator/references/mcp-collaboration.md) for the operating protocol, [runtime documentation](../runtimes/agent-bridge/README.md) for commands, and [validation notes](validation-v0.2.md) for the tested scope.

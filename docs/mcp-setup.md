# Connect Claude Code, Antigravity, and Codex

The optional bridge supports reciprocal, task-bound communication among the three agents. They can exchange requests, evidence, revisions, and results and continue authorized work without asking a person to relay every message.

The research skill remains usable without this runtime. Enable only the connections needed for your project. The easiest entry point is to ask Codex:

```text
Use $codex-research-orchestrator to connect Claude Code to this project.
```

Codex can run the installed helper and handle the paths and configuration. The steps below are for manual setup or for checking what it does.

## Requirements

- The full bundle installed in your project; see [getting started](getting-started.md). A standalone skill does not include the optional runtime.
- Python 3.11 or later for the setup helper.
- Node.js 24 or later, including its built-in SQLite module, for the bridge.
- The relevant provider CLI when you want to start or resume that provider through the bridge. Messaging and synthetic transport tests do not require provider accounts.

There are no npm dependencies to install. The helper chooses a project-local database at `.agent-bridge/bridge.sqlite`, outside the runtime package. All adapters generated for this project use that same database. Provider authentication stays in each provider's supported local configuration. Finding a CLI does not establish that it is logged in. The optional Antigravity SDK route requires its own SDK installation; the CLI and message bridge do not require that route.

## Choose connections

The server filename identifies the execution backend. `MCP_CALLER_AGENT` identifies the client connecting to it.

| Client | Useful server adapters | Caller identity |
|---|---|---|
| Codex | Claude Code and Antigravity | `codex` |
| Claude Code | Codex and Antigravity | `claude-code` |
| Antigravity | Codex and Claude Code | `antigravity` |

Every server exposes the shared message/task tools. You do not need all six possible client-to-backend links for a smaller collaboration. Set `--client` to the host loading the MCP servers and `--peers` to the other agents you want it to reach. Peer names are `codex`, `claude-code`, and `antigravity`; do not include the client itself.

## Generate or apply project configuration

Run from your research project directory. This generates a Codex connection to Claude Code without changing the host configuration:

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_setup.py \
  connect --project . --client codex --peers claude-code
```

Add `--apply` to register it in the supported project configuration:

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_setup.py \
  connect --project . --client codex --peers claude-code --apply
```

The helper resolves the executable, runtime, and database paths for this machine. You do not need to edit paths in a JSON example. It exports the generated configuration under `.research-orchestrator/mcp/` and reports its next action.

| Client | Generated export | With `--apply` |
|---|---|---|
| `codex` | `.research-orchestrator/mcp/codex.toml` using `mcp_servers` tables | Updates project `.codex/config.toml` |
| `claude-code` | `.research-orchestrator/mcp/claude-code.json` using `mcpServers` | Updates project `.mcp.json` |
| `antigravity` | `.research-orchestrator/mcp/antigravity.json` using `mcpServers` | Exports only; import through the host's supported MCP interface |

These project formats follow the [official OpenAI documentation for Codex MCP](https://learn.chatgpt.com/docs/extend/mcp) and [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp). The helper preserves unrelated settings and rejects conflicting entries. It does not modify user-global settings or invent an Antigravity configuration location.

For a Claude Code host, for example:

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_setup.py \
  connect --project . --client claude-code --peers codex antigravity --apply
```

If `node` is absent from `PATH`, or points to an older version, add `--node /path/to/node` with your Node.js 24+ executable. The helper resolves and stores the absolute path. Use `--project /path/to/project` and the full helper path when running from another directory.

Connection setup writes configuration only. It does not launch providers or models, create the bridge database, establish login, or enable a wakeup service. Generated paths are specific to this machine; keep host configuration, databases, WAL files, logs, and credentials out of public exports.

## Load and check the connection

Reopen the chosen client in the project. Complete the host's project trust or MCP approval steps and reload if required. Codex loads project `.codex/config.toml` only for trusted projects. Claude Code may require approval for project `.mcp.json` servers.

Inspect the host's MCP server status and the tools actually exposed in the current session. In Claude Code, `/mcp` shows the server status. A saved configuration or a successful setup receipt is not proof that the host connected. Do not start provider work just to test setup unless that execution is authorized.

Once the provider is available, you can request a small first exchange:

```text
Ask Claude Code to read this project's controls.md and state.md, identify
one assumption that needs evidence, and return a short reply in the same
task. Allow reading only those files; do not edit files or run experiments.
```

Use the actual record paths for an existing project. This request starts a provider session and uses its account resources. Check that the reply belongs to the same task and names the materials it used before assigning broader work.

## Troubleshoot setup

The read-only diagnosis can inspect the selected client and peers:

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_setup.py \
  doctor --project . --client codex --peers claude-code
```

| Reported issue | Next action |
|---|---|
| Missing bridge runtime | Install the full bundle in the same project. Use `--upgrade` if the installer reports a differing managed installation. Native research can continue without it. |
| Missing or old Node.js | Install Node.js 24+ or pass `--node /path/to/node`; rerun the same command. |
| Missing provider CLI | Install the selected provider's CLI before using its execution tools. Shared messaging does not require it. CLI presence still does not verify login. |
| Provider is not authenticated | Use that provider's supported local login process; setup and `doctor` do not verify authentication. |
| Configuration collision or edited managed entry | Inspect the named entry and reconcile it with the intended connection. Preserve unrelated settings, then rerun; the helper will not silently replace the conflict. |
| Export exists but host tools are missing | Apply Codex or Claude Code project configuration, or manually import the Antigravity export. Then complete host trust/approval, reopen or reload, and inspect MCP status again. |

Add `--json` for structured diagnosis. `doctor` reports filesystem and executable checks; it does not establish provider login or host connectivity. Missing optional Node.js does not block research without the bridge.

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

Generated Codex and Claude Code configurations set an 11-minute tool timeout (`tool_timeout_sec = 660` for Codex; `timeout = 660000` milliseconds for Claude Code), to accommodate the bridge's default 10-minute delivery wait. Antigravity exports do not guess a timeout field. These defaults do not guarantee the same support across every host version or operation.

The bridge's actual wait and coalescing values must fit the host and MCP client's supported deadlines. Keep the delivery wait below those limits. A server timeout longer than the client permits does not extend the client limit.

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

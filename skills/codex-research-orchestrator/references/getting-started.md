# Setup and first actions

Use this reference for installation, minimal project initialization, connection configuration, or setup diagnosis. The user gives a goal; Codex handles the routine commands and records. Ask only for a missing choice that changes the research meaning, deliverable, resource use, or authorization.

## Choose the existing project

Read applicable project instructions and locate existing research entry points before creating records. Use the user's chosen directory. If there is an established charter, state, or memory store, resume it rather than initializing a parallel one. Do not infer that a directory without this package has no prior research.

The bundled helper requires Python 3.11 or later and uses the standard library. Resolve its real path from the installed skill; do not depend on the terminal's current directory. The examples below use a project-local installation:

```sh
python3 /path/to/project/.agents/skills/codex-research-orchestrator/scripts/research_setup.py doctor --project /path/to/project
```

## Install or upgrade

From the full release checkout, install with:

```sh
python3 /path/to/codex-research-orchestrator/setup.py install --project /path/to/project
```

This installs the skill under `.agents/skills/codex-research-orchestrator` and the optional bridge files under `.research-orchestrator/runtime/agent-bridge` in the target project. It does not register services, create accounts, change global configuration, or launch provider models. Repeating the same installation is safe. Use `--upgrade` to replace managed components with backups while preserving research documents, databases, and project configuration.

The helper also exposes `install`, with `--skill-only` when only the skill is wanted. It copies the components available in its source bundle. A standalone skill contains the helper and can support native research. It does not include bridge runtime files. If connection setup reports a missing runtime, install the full bundle in the same project.

The host may require trust approval or a reload before discovering the skill or an MCP configuration. Report the actual discovery state; do not claim installation has activated a host feature.

## Start from the user's question

For a new research directory, pass the user's original request to the helper, without paraphrasing away constraints:

```sh
python3 /path/to/project/.agents/skills/codex-research-orchestrator/scripts/research_setup.py init --project /path/to/project --question "The user's original research request" --title "Optional short title"
```

`init` creates `controls.md`, `charter.md`, `project.md`, `state.md`, and `.research-memory/`. Existing research is never overwritten. If it reports partial records, inspect and resume or complete those records; do not remove them to force initialization. Read its receipt to find the created entry points. Retain the original request and distinguish confirmed instructions from draft interpretations. Neither initialization nor a blank field grants experiments, implementation, external sharing, publication, or an unlimited budget.

After initialization, read the live records and proceed with the next useful analysis already within scope. Add detail when the work needs it. Do not require a completed charter or an inventory of every possible participant before starting clear, authorized work. Use [memory](memory.md) when adding records, retrieving a growing history, or building recipient-specific context.

## Connect only the requested peers

Node.js 24 or later is needed for bridge connection setup. It is not needed for installation, initialization, or native research. Choose the client and peers from the request and existing settings; provider names do not assign research roles.

Generate a configuration first:

```sh
python3 /path/to/project/.agents/skills/codex-research-orchestrator/scripts/research_setup.py connect --project /path/to/project --client codex --peers claude-code antigravity
```

Use only the peers the project needs. The helper resolves absolute executable, runtime, and database paths and exports configuration under `.research-orchestrator/mcp/`. Inspect the generated result and preserve its paths; do not replace them with placeholders or copy private paths into public examples.

When the user has requested applying project connection settings, add `--apply`. It writes only the supported project-local configuration: `.codex/config.toml` for Codex, `.mcp.json` for Claude Code, or `.agents/mcp_config.json` for Antigravity CLI/IDE. It preserves unrelated settings and reports collisions rather than replacing conflicting entries. Resolve a collision from the actual entry and intended connection; do not delete unrelated configuration. Other Antigravity surfaces can import the generated export through their supported interface.

For unattended exchanges, confirm permission for the specific read, send, and reply tools. An established connection or zero client exit code does not establish permission or successful delivery. Check returned tool-denial records and the actual reply. Keep model and effort selection explicit when the user sets cost limits; Claude and Antigravity execution tools accept `effort`, while Codex accepts a reasoning-effort config override.

A generated or applied file does not prove provider login, MCP loading, host trust, tool availability, or a working connection. Reload when the host requires it, then inspect the tools actually exposed. Use [MCP collaboration](mcp-collaboration.md) before creating tasks or exchanging messages. Keep actual model execution, external communication, and ongoing continuation within their existing authorization. The setup helper never launches provider models.

## Diagnose and report the next action

```sh
python3 /path/to/project/.agents/skills/codex-research-orchestrator/scripts/research_setup.py doctor --project /path/to/project
```

Add `--json` when structured output is useful. `doctor` is read-only. Follow its concrete next action; a missing optional Node.js installation does not block native research. Diagnose one reported failure at a time, using the relevant runtime or host guidance. Do not infer login or live connection state from filesystem checks.

Finish setup with a short receipt: what was installed or created, what connection configuration was generated or applied, and any host reload or manual import still needed. Then continue the requested research when the next action is clear. Do not add global writes, public uploads, accounts, daemons, or new approval stages as part of ordinary onboarding.

# Agent-Guided Setup Protocol (`SETUP.md`)

This document instructs any coding agent (Codex, Claude Code, Antigravity, or another assistant) how to onboard or upgrade a user's research workspace with `codex-research-orchestrator`. Follow this protocol verbatim so the user never faces long questionnaires or unsafe credential prompts.

## Core Interaction Rules

1. **Probe silently first**: Before asking the user anything, run the read-only environment probe:
   ```sh
   python3 setup.py probe --project <target-project-dir> --json
   ```
   Skip every question whose answer is already known from `probe` (`python`, `fts5`, `node`, `providers`, existing `records`, `memory`, `bridge`, or `baselines`).
2. **One question per turn (`<= 250` words)**: Ask **at most 1 question at a time**, always include a **recommended default** first, and keep your entire message at or under **250 words**.
3. **Never ask for secrets or login tokens in chat**: Never ask the user to paste API keys, OAuth tokens, or passwords into the conversation. Whenever provider login or secret setup is required, print the exact terminal command (for example `codex login`, `claude auth login`, or `export ...` in their local shell) and ask the user to confirm once they have run it in their own terminal.
4. **Use existing authorization.** Summarize the workspace changes and proceed with the install or upgrade requested by the user. Ask only about additional changes that require permission, such as connecting a new peer or starting an unrequested service.

---

## Step-by-Step Onboarding Flow

### Step 1 — Silent Read-Only Probe

Run:

```sh
python3 setup.py probe --project . --json
```

Inspect the JSON output:

- `python.status` & `fts5.status`: Must be `"ready"` (`Python >= 3.11` with SQLite FTS5). If missing, stop and give the user a one-command install instruction for Python 3.11+.
- `workspace.initialized`:
  - If `true` (`records`, `.research-memory`, `AGENTS.md`, or `bridge.sqlite` already present): **do not overwrite** existing records or ask for a replacement research question. Offer to resume, upgrade (`install --upgrade`), or seed 3-way baselines (`baselines --seed`).
  - If `false`: proceed to Step 2.
- `node.status` & `providers`: Note whether `Node >= 24` and peer CLIs (`codex`, `claude`, `agy`) are available. Basic single-agent research works without Node or peer CLIs.

### Step 2 — Gather Only Missing Decisions (One Question per Turn)

Ask **only** the questions not already answered by `probe` or the user's initial prompt, one per turn:

1. **Research Question** *(skip if workspace is already initialized or the user already stated their question)*:
   - Ask for the exact authoritative research question to record verbatim in `controls.md`.
2. **Collaboration Mode** *(skip if the user already specified single-agent vs multi-agent)*:
   - **Recommended default**: *Single-agent + local Research Memory* if `node.status != "ready"` or no peer CLIs are detected; *Multi-agent Bridge (`observe` router mode)* if `Node >= 24` and at least one peer CLI (`claude` or `agy` or `codex`) is detected.
3. **Router Dispatch Mode** *(only if enabling Multi-agent Bridge)*:
   - **Recommended default**: `observe` (records `would_dispatch` proposals in Workbench Attention without spending external model quota until approved; user can switch to `auto` anytime).

### Step 3 — Install the authorized components

Use the target directory and authorized components established above:

1. **Install or upgrade the bundle.** The installer delivers four discoverable skills under `.agents/skills/`: `codex-research-orchestrator`, `boost`, `swarm`, and `teamwork`.
   ```sh
   python3 setup.py install --project <dir> [--upgrade]
   ```
   The upgrade backs up changed managed files and uses the existing `builtInBase` comparison for editable project templates. Pre-existing skills with the same names and locally modified companion skills stay in place, with a status in the result. If the workspace already has its own theme or instructions, keep them in place. The installed helper can repair a missing companion or copy the skill suite into another workspace after removal of the source bundle.
2. **Initialize Records & Research Memory** *(new workspaces only)*:
   ```sh
   python3 setup.py init --project <dir> --question "<exact user question>"
   ```
3. **Configure the Lead MCP bridge for the real client** when selected by the user. For Codex, use `--client codex --tool-profile auto`; the helper uses `lead` for the primary peer. Each peer worker uses its own authorized client configuration and `worker` profile. Reload the client so it launches the connection with the actual session.
   ```sh
   python3 setup.py connect --project <dir> --client <codex|claude-code|antigravity> --peers <peers...> --node <node24-path> --apply
   ```
   If any chosen peer CLI needs authentication, hand the login command to the user to run in their own terminal rather than running interactive auth inside the agent.

### Step 4 — Read-Only Verification & Handoff

Verify health without mutating state:

```sh
python3 setup.py doctor --project <dir> --json
python3 setup.py watchdog status --project <dir> --json
```

Watchdog exit codes follow a strict 4-level contract for cron/launchd/systemd integration:
- `0`: Healthy (or respecting manual `.stopped` marker with `--respect-stop`).
- `1`: Transient daemon/lock/route fault (`python3 setup.py watchdog restart --project <dir> --respect-stop` heals it).
- `2`: Configuration, Node `< 24`, or required provider CLI missing (fix environment before restarting).
- `3`: Workspace not initialized yet.

Check `checks.collaboration_skills` in `doctor` and report any missing or local override. Finish with the user's one-line prompt for `$codex-research-orchestrator`, `$boost`, `$swarm`, or `$teamwork` as appropriate.

A host turn can use the installed collaboration CLI when the client still exposes an older MCP connection. Use `python3 .agents/skills/codex-research-orchestrator/scripts/research_setup.py collaborate --project . -- --help` from the target workspace. The same helper under a globally mounted orchestrator skill discovers the selected project's runtime. Opening and resuming require the current host session.

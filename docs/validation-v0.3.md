# v0.3.0 validation: installation and everyday use

Date: 2026-10-25. This release adds guided onboarding to the research skill and its optional cross-agent bridge. Public instructions are in English.

## Onboarding regression tests

The final suite passed **27 tests**, exit code 0, on an isolated Linux server with Python **3.11.17**:

```sh
python3 -m unittest discover -s tests -p test_research_setup.py -v
```

The tests use temporary projects and synthetic executable discovery. They do not call provider models or modify personal configuration.

| Area | Checked behavior |
|---|---|
| Installation | Complete and standalone skill installs; licenses retained; generated state excluded; installed files work after deleting the download |
| Repeat and upgrade | Unchanged installation is a no-op; upgrades retain backups; research, memory, bridge data, and unrelated files are preserved; injected replacement failures roll back |
| Initialization | Original question retained; memory initialized with live controls; existing and partial research preserved; concurrent initialization and an external writer cannot overwrite an existing question |
| Configuration | Native Codex TOML and Claude Code JSON; real paths, shared database, correct caller; only selected peers; unrelated settings retained; edits and name collisions reported |
| Reconfiguration | A table appended after the managed Codex block survives another apply; prepare-only output does not claim a new selection is applied |
| Waiting | Generated Codex and Claude Code timeout values accommodate the bridge's default delivery wait; no unsupported timeout field is assumed for Antigravity |
| Diagnosis | Read-only checks, missing optional dependencies, explicit peer selection, and distinction between executable discovery and authentication |
| Errors | Unsupported Python, partial runtime, path overlap, and managed symlinks produce explicit errors |

An independent engineering review identified three defects in the candidate: concurrent initialization could replace records, reapplying Codex configuration could remove a required newline, and diagnosis could ignore newly requested peers. All three were corrected with targeted regression coverage before the final run.

Initialization serializes setup attempts and publishes files without replacing existing targets. A conflict with another writer preserves the files and reports a partial workspace for inspection. This is not a claim of atomic recovery from power loss.

## Installed-runtime check

A separate check exercised the public CLI in a temporary workspace using Python **3.11.17** and Node.js **v24.22.1**:

1. Install the complete bundle, then delete its source copy.
2. Run the installed helper to initialize a research question and memory.
3. Generate both peer connections for each of Codex, Claude Code, and Antigravity. Apply the supported project configurations while preserving unrelated sample settings.
4. Start a real MCP stdio process using each generated command, argument list, and environment. Send `initialize` and `tools/list`.
5. Confirm that all six registrations use installed runtime paths, the expected caller identity, and one project database.
6. Run read-only diagnosis and verify that Python 3.10 receives an actionable version error without a traceback.

All six registrations completed the handshake and returned nonempty tool lists: 24 tools for the Claude Code and Antigravity adapters, and 25 for Codex. The check exited with code 0. It used protocol requests directly, without launching a vendor client or provider model.

## Evidence boundaries

This establishes the exercised installation, configuration, and MCP startup paths on Linux. It does not establish provider login, live desktop-client loading, paid model execution, idle-chat wakeup, or behavior on every operating system. Host trust, supported configuration fields, and provider authentication still need to be satisfied in the user's environment.

The bridge's task and delivery logic and the memory implementation were unchanged in this release. Their previous evidence remains in [v0.2 bridge validation](validation-v0.2.md) and [memory validation](validation.md). Those earlier runs are not presented as new tests.

The shorter onboarding flow is a design improvement supported by these functional checks. No user study or comparative research-quality measurement was performed.

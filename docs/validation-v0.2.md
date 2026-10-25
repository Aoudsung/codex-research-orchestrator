# v0.2.0 validation: autonomous cross-agent collaboration

Date: 2026-10-25. The release focuses on reciprocal information exchange and task collaboration among Claude Code, Antigravity, and Codex through the optional MCP runtime.

## Executed checks

The final runtime suite passed on an isolated Linux server with **Node.js v24.22.1**, with exit code 0:

```sh
cd runtimes/agent-bridge
npm test
```

The suite uses real MCP stdio server processes, temporary SQLite databases, synthetic provider executables, and mocked host receipts. It does not use real model accounts, active research tasks, personal configurations, or the live bridge database.

| Area | Verified behavior |
|---|---|
| Reciprocal communication | Three independent server processes exchange task-scoped messages across Claude Code, Codex, and Antigravity identities using a shared store |
| Delivery and repair | Structured patch delivery, a final artifact manifest, incremental reads, and consolidated validation feedback remain tied to the original task |
| Provider adapters | Synthetic executables exercise the actual adapter processes, preserve reported identity, and leave work awaiting delivery rather than completing it on CLI exit |
| Explicit binding | Conflicting task scope, model identity, or required conversation is rejected; requested identity is not reported as runtime proof |
| Readiness | Failed preflight prevents Codex/Claude exec and resume; recorded delivery modes are retained and contradictory permission modes are rejected |
| Path boundaries | Out-of-scope paths, doubled diff prefixes, rename sources, and unauthorized artifact-save destinations are rejected |
| Concurrent events | A second process cannot observe an allocated cursor before its event commits; concurrent writers receive distinct ordered sequence numbers; failed event writes roll back their cursor |
| Patch dependencies | Missing prerequisites, cycles, stale dependencies, and conflicting replacements are rejected |
| Context size | Large message bodies do not enter ordinary task-overview or delivery summaries; exact artifacts remain separately readable |
| Wakeup contract | Weak receipts do not confirm host delivery; inspection and confirmation preserve existing disabled/manual routes |
| No implicit daemon | Source reload followed by a normal tool listing does not start an unconfigured background receiver |
| Process failure | A subprocess that closes stdin early returns an explicit input-delivery failure instead of crashing the MCP server |

## Review and corrections

An independent engineering review identified seven concrete contract defects in the candidate: path-prefix handling, unchecked rename sources, non-atomic event sequences, missing execution preflight, daemon startup during reload, completion of a model-verified task, and implicit route changes during confirmation. The final version corrects these paths and includes targeted regression coverage.

Event number allocation and message, patch, or validation publication now share a write transaction. Notifications occur after commit. This preserves the cursor contract when multiple MCP processes share a database.

The pre-existing research-memory implementation was not changed in this release. Its earlier validation evidence remains in [memory and skill validation notes](validation.md); it was not presented as a new test run.

## Publication checks

The package has explicit version and MIT metadata, English instructions, separate runtime installation guidance, and a standalone skill path. Targeted scans exclude the source project's private paths, research labels, real task/chat identifiers, seeded routes, database files, logs, and account configuration. Runtime data are kept outside the distributed files.

## Limits of this evidence

The three-server integration establishes MCP transport, state, and delivery behavior with synthetic peers. The provider-executable fixtures establish adapter behavior for the exercised output and failure shapes. They do not establish successful autonomous research or compatibility with every installed vendor CLI version.

Host acceptance was tested as a contract using controlled receipts. This release test did not wake a real idle desktop chat or run a paid provider session. A deployment must configure and verify its own host route before relying on cross-turn continuation. Message exchange, artifact completeness, host acceptance, and target processing remain separately reported.

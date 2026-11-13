# External Collaboration & Optional Agent Bridge (`agent-bridge`)

Use this guide when coordinating persistent peers (`Antigravity`, `Codex`, opt-in `Claude Code`) over `runtimes/agent-bridge`. The standalone research skill and SQLite memory work without the bridge.

## 1. Tiered Tool Profiles & Multi-Peer De-duplication

- `BRIDGE_TOOL_PROFILE` trims resident MCP schema tokens without losing capabilities:
  - **`lead`** (primary MCP peer): 28 compact `bridge_*` + 5 `research_*` tools (~50% compressed JSON schema).
  - **`worker`** (scoped executor): 7 core worker `bridge_*` tools + 2 read-only memory tools (`research_search`, `research_read`).
  - **`exec_only`** (secondary peers when 2+ MCP servers mount simultaneously): **0 duplicated shared tools**—keeps only native `<peer>_exec` / status tools.
- `research_setup.py connect` assigns `lead` to `index == 0` and `exec_only` to `index >= 1` automatically (override via `--tool-profile`).

## 2. Task Binding, Effort & Preflight

1. Bind logical work explicitly via `bridge_create_task` (`participant`, `requiredModel`, `requestedModel`, `sessionId`, `writeRoots`, `isolationProfile`, `effortTier`, `riskLevel`). Keep requested settings distinct from runtime-reported model identity.
2. Check effective workspace permissions and deltas with `bridge_preflight_task`; set `completeTaskOnExit: false` for multi-step or validation-gated executions.
3. Prefer `bridge_submit_patch` / `bridge_get_patch` when direct workspace writes are unsafe; track `baseRevision` and conflict checks strictly.

## 3. Deterministic Router, Consumption & Safeguards

- **Deterministic Research Router (`off | observe | auto`):** `observe` logs `would_dispatch` proposals without spending external quota. `direct`/`context` fan-out (`bridge_subscribe_thread`) is engine-blocked on `blind_analysis` and `blind_review` tasks.
- **Two-phase consumption (`consumed_at`):** Reading via `bridge_read_messages` marks actual turn ingestion separately from socket `delivered` status. Unconsumed crash recoveries receive a `RecoveryNote` pointing to the latest patch `sha256`.
- **Out-of-scope handback (`bridge_handback`):** Releases ownership immediately (`scientific_ambiguity`, `permission_delta`, `budget_exceeded`, `humanAction`) instead of looping or guessing.
- **Escalation & Safeguards:**
  - `validateProMacroPrompt` hard-blocks inline code/diffs/ledgers sent to `pro_macro` (attach raw code/traces via `github_repo` or `upload_bundle` from `pack_pro_bundle.py`).
  - `bridge_record_validation` emits `jitGuidance` (`recommendedEffort: 'high' | 'xhigh'` + Two-Patch Escape reminder) on `>=2` consecutive failures or `>=2` stacked patches.
  - `controlVersion` revalidates active tasks if `controls.md` changes mid-flight.
- **Spill pagination & health:** Read long payloads via `bridge_read_card` (`bridge://<kind>/<id>`, `offset`/`limit`); inspect queue/watchdog health via `bridge_watchdog_status`.

## 4. Finish-and-Exit, Reactive Wakeup & State Separation

- **Zero busy-waiting / finish-and-exit rule:**
  - **Workers (`worker` profile)** intentionally omit `bridge_poll_updates` and `bridge_wait_for_delivery`; after submitting their patch or `bridge_submit_task_receipt` (or handing back via `bridge_handback`), exit immediately—never sleep or poll.
  - **Lead (`codex`)** uses short `waitForDelivery` / `bridge_wait_for_delivery` (`timeoutMs <= 15000–30000` ms) **only** to coalesce an immediate automated reply already in flight. When your own phase work is complete—or while waiting on long async peer work or ChatGPT Web `Pro`—bind reactive wakeup (`callerSessionId` / `autoWakeup: true` on `bridge_create_task` / `antigravity_exec`, or `bridge_configure_wakeup_route` with `codex_ipc`, `agy_cli`, `antigravity_desktop`, `claude_cli`, etc.), persist receipt/checkpoint, and **end your turn immediately**. Never loop on `bridge_poll_updates` or shell `sleep`.
- Keep execution cursors, leases, and raw inboxes inside `agent-bridge`, and store scientific conclusions and versioned claims in SQLite (`research_record`).

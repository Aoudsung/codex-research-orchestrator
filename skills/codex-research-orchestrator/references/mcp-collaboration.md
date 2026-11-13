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
  - `validateProMacroPrompt` hard-blocks code/diffs/ledgers sent to `pro_macro`.
  - `bridge_record_validation` emits `jitGuidance` (`recommendedEffort: 'high' | 'xhigh'` + Two-Patch Escape reminder) on `>=2` consecutive failures or `>=2` stacked patches.
  - `controlVersion` revalidates active tasks if `controls.md` changes mid-flight.
- **Spill pagination & health:** Read long payloads via `bridge_read_card` (`bridge://<kind>/<id>`, `offset`/`limit`); inspect queue/watchdog health via `bridge_watchdog_status`.

## 4. Integrated Wait & Two-World State Separation

- Use `waitForDelivery` on `bridge_send_message` / `bridge_record_validation` (or `bridge_wait_for_delivery`) with configured `settleMs` / `timeoutMs` (`2500` / `600000` ms) to avoid redundant polling loops. On timeout, reconcile the bound task before retrying.
- Keep execution cursors, leases, and raw inboxes inside `agent-bridge`, and store scientific conclusions and versioned claims in SQLite (`research_record`).

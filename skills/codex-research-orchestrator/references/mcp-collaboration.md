# External Collaboration & Optional Agent Bridge (`agent-bridge`)

Use this guide when coordinating persistent peers (`Antigravity`, `Codex`, opt-in `Claude Code`) over `runtimes/agent-bridge`. The standalone research skill and SQLite memory work without the bridge.

## 1. Tiered Tool Profiles & Multi-Peer De-duplication

- `BRIDGE_TOOL_PROFILE` trims resident MCP schema tokens without losing capabilities:
  - **`lead`** (primary MCP peer): collaboration planning and board, compact `bridge_*` and `research_*` tools, `bridge_plan_dispatch`, `bridge_sync_collaborators`, and `pi_exec`.
  - **`worker`** (scoped executor): task claim and completion, scoped briefs and board access, read/reply/patch/validation/handback, and research search and read.
  - **`exec_only`** (extra MCP peers): **0** duplicated shared tools—keeps native `<peer>_exec` / status only.
- `research_setup.py connect` assigns `lead` to `index == 0` and `exec_only` to `index >= 1`; `python3 setup.py lint` flags un-deduplicated multi-peer configs (`MCP-001`) and disabled `claude` servers.

## 2. Dynamic Dispatch, Task Binding, PI Execution & Recovery

Use the [Lead work-run protocol](work-modes.md) when starting or resuming Boost, Swarm, or Teamwork. The Lead resolves each assignment through the same model and session binding policy.

1. **Plan before delegating (`bridge_plan_dispatch`):** Evaluate `.agent-bridge/collaborators.json` + task workload to dynamically select channel/model (Gemini pinned PI first -> Antigravity fallback) and task-scoped `Luna` effort, then pass `planId` into `bridge_create_task` and record actual runtime `(channel, model, effort, selectionReason)`.
2. **Post-compaction automatic recovery:** `collaborators.json` separates static policy/pinned sessions from live runtime state (`bridge.sqlite`); a shared `[Collaboration Recovery]` digest is injected across coordinator wakeups, `research_context(profile="resume")`, and `bridge_get_task_overview`.
3. **Detached dual-mode PI runner (`pi_exec`):** Preserves user retry/compaction/concurrency=1 settings on pinned PI sessions (failing cleanly with `PI_SESSION_BUSY` if in use) while applying isolated `retries=0, compaction=false` on new `magpie` `auto/*` and `explicitPiRoutes` sessions; runs execution in a detached `pi-worker.mjs` so receipts survive hot-reload exits.
   - `explicitPiRoutes`: `.agent-bridge/collaborators.json` supports `{ provider, model, fixedEffort? }` entries for user-authorized project-scoped PI models (such as `google-vertex/gemini-4-hydrogen`).
   - **Length truncation & authorization reuse:** `pi_exec` performs bounded same-session continuation (`maxLengthContinuations`) on `stopReason === "length"`, and reports any remaining cap stop as `invocationOutcome: "partial"` (`partialReason: "output_limit"`, `transportOutcome: "delivered"`), never `blocked`. When `receipt.authorizationReuse.reusableTaskAuthorization === true` (`output_limit_partial` or `local_pre_transport_error` where `beforeGenerationTransport === true`), do **not** call `request_user_input` to re-ask user approval for the already-authorized task/model/effort, and never patch global `~/.pi` SDK release files from project tasks.
4. Check effective workspace permissions and deltas with `bridge_preflight_task`; prefer `bridge_submit_patch` / `bridge_get_patch` when direct workspace writes are unsafe.

## 3. Deterministic Router, Consumption & Safeguards

- **Deterministic Research Router (`off | observe | auto`):** `observe` logs `would_dispatch` proposals without spending external quota. `direct`/`context` fan-out (`bridge_subscribe_thread`) is engine-blocked on `blind_analysis` and `blind_review` tasks.
- **Two-phase consumption (`consumed_at`):** Reading via `bridge_read_messages` marks actual turn ingestion separately from socket `delivered` status. Unconsumed crash recoveries receive a `RecoveryNote` pointing to the latest patch `sha256`.
- **Out-of-scope handback (`bridge_handback`):** Releases ownership immediately (`scientific_ambiguity`, `permission_delta`, `budget_exceeded`, `humanAction`) instead of looping or guessing.
- **Escalation & Runtime Admission Guards (`intake.mjs` / `policy.mjs`):**
  - `validateProMacroPrompt`: hard-blocks inline code/diffs/ledgers and SHA-256 verification ceremonies on `pro_macro` (attach code via `github_repo` or `upload_bundle` from `pack_pro_bundle.py`).
  - `validateModelRoleAndChannel`: blocks `dyschop/*`, disabled `claude-code`, wrong-lane model routing, `Carbon` on `blind_review`, and `Luna` on code edits.
  - `validateCoordinatorWriteBoundary` & `validateWriteRootExclusivity`: block coordinator business writes and overlapping `writeRoots` across active tasks.
  - `validateResearchTaskDiscipline`: blocks synthetic/toy benchmarks, mock checkpoints, fallback/heuristic/calibration wrappers, baseline-mutating ablations, and experiment runs without `claimIds`.
  - `mcp-server.mjs` hot-reloads `core`, `servers`, and `domain` with one-shot async worker exit protection and same-provider cross-session wakeup routing (`task-workflow.mjs`).
- **Spill pagination & health:** Read long payloads via `bridge_read_card` (`bridge://<kind>/<id>`, `offset`/`limit`); inspect queue/watchdog health via `bridge_watchdog_status`.

## 4. Finish-and-Exit, Reactive Wakeup & State Separation

- **Zero busy-waiting / finish-and-exit rule:**
  - **Workers (`worker` profile)** intentionally omit `bridge_poll_updates` and `bridge_wait_for_delivery`; after submitting their patch or `bridge_submit_task_receipt` (or handing back via `bridge_handback`), exit immediately—never sleep or poll.
  - **Lead (`codex`)** uses short `waitForDelivery` / `bridge_wait_for_delivery` (`timeoutMs <= 15000–30000` ms) **only** to coalesce an immediate automated reply already in flight. When your own phase work is complete—or while waiting on long async peer work or ChatGPT Web `Pro`—bind reactive wakeup (`callerSessionId` / `autoWakeup: true` on `bridge_create_task` / `antigravity_exec`, or `bridge_configure_wakeup_route` with `codex_ipc`, `agy_cli`, `antigravity_desktop`, `claude_cli`, etc.), persist receipt/checkpoint, and **end your turn immediately**. Never loop on `bridge_poll_updates` or shell `sleep`.
- Keep execution cursors, leases, and raw inboxes inside `agent-bridge`, and store scientific conclusions and versioned claims in SQLite (`research_record`).

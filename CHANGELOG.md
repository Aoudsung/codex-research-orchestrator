# Changelog

## v1.4.3 — Stable collaboration workflows

Parallel reports can use targeted independent replay and directly apply verified corrections to a frozen draft. Milestone runs track versioned dependencies, addressed handoffs and per-requirement acceptance. Timed investigations retain phase and provider measurements. The in-turn patch proposal from the v1.4.2 trial stays in the experimental archive. See [the trial results and selection criteria](docs/stable-collaboration.md).

## v1.4.2 — Direct verified errata and in-turn patch proposals

A coordinator can fold a verifier's exact, evidence-backed correction into a frozen report using the installed errata helper. A bound Antigravity structured-patch call can publish scoped proposals through a private live journal. Each proposal is checked before a separate reviewer receives an immutable candidate. The final task and its approval remain distinct from the provisional snapshot.

## v1.4.1 — Reproduction receipts and bounded investigations

Antigravity CLI can return the command and output digests, session, step and observed exit status for real verifier actions. The benchmark workflow measures the initial author phase, budgets subsequent review, and records claim-specific reproductions.

## v1.4.0 — Named work runs and evidence-linked acceptance

Coordinators can open single, parallel, investigation and milestone runs through the existing task interface. Members share addressed handoffs and consumption receipts. Dependent steps advance from versioned evidence, independent PI reviews use frozen input packets, and task detail shows the current owners, blockers and requirements. Projects can configure eligible models and channels per workload.

## v1.3.0 — Compaction-Resilient Collaboration Recovery, Dynamic Cross-Channel Dispatch & Detached PI Executor

Released on 2026-11-16.

- **Three-Surface Collaboration Recovery (`collaborator-registry.mjs`, `drivers.mjs`, `engine.mjs`, `research_memory.py`):** Stores user policy & pinned sessions in `.agent-bridge/collaborators.json` separate from `bridge.sqlite` runtime truth; automatically injects `[Collaboration Recovery]` across coordinator wakeups, `bridge_get_task_overview`, and `research_context(profile="resume")` (omitted on `pro_macro` bundles).
- **Dynamic Cross-Channel Dispatch & Task-Scoped `Luna` Effort Judge (`bridge_plan_dispatch`, `dispatch-planner.mjs`, `effort-judge.mjs`):** Jointly selects across `Web Pro`, `Codex` (`gpt-6-astra`, `gpt-6.1-sol`, `default`/`explorer` + `gpt-6-luna low`), `Gemini Carbon`/`Argon` (pinned PI session preferred -> pinned Antigravity fallback when PI busy/unavailable + `gemini-pro-orchestrator*` native ID matching), and explicit PI (`magpie auto/*`), caches `gpt-6-luna` effort judgments per `(task, model)` without silent defaults, and enforces plan binding at `bridge_create_task(planId)`.
- **Detached Dual-Mode PI Executor (`pi_exec`, `pi-executor.mjs`, `pi-worker.mjs`) & Wakeup/Lint Hardening:** Spawns detached surviving PI workers with pinned config/retry/compaction preservation vs `task_explicit` `retries=0, compaction=false`, selective progress coalescing in `superagent-daemon.mjs`, `notifications/tools/list_changed` on schema updates, and `research_lint.py` `ROUTE-001`/`ROUTE-002`/`ROUTE-003` fixes.

## v1.2.0 — Lint-First Guards, Three Session Lanes & Runtime Wakeup Fixes

Released on 2026-11-15.

- **Runtime Intake & Preflight Admission Guards (`intake.mjs`, `policy.mjs`, `preflight.mjs`):** Enforces three session lanes (`GPT -> Codex`, `Gemini -> Antigravity`, `Kimi/DeepSeek -> .pi/sessions/` with legacy `dyschop/*` banned), bars `Carbon` from `blind_review`, locks `Luna` to read-only L0 observation, disables `claude-code` by default, enforces non-coding coordinator boundaries and `writeRoots` exclusivity, blocks synthetic/mock/`fallback`/`staged`/unclaimed tasks, and schedules remote GPUs via `evaluateGpuPlacement` (`free VRAM >= required + safetyMargin`, excluding faulty GPUs).
- **Static Read-Only Project Linter (`setup.py lint` / `research_lint.py`):** Checks `DOC-001`..`MEM-001` over read-only SQLite URIs, replacing prose bloat in `AGENTS.md`; updates `pack_pro_bundle.py` (`.pi` ignored, SHA-256 table optional via `--include-sha256`) and `research_memory.py` (`<=40`-word tombstone cap & `--strict-hygiene`).
- **Bridge Session Wakeup & Worker Tooling (`agent-bridge`):** Fixes same-provider distinct-session delivery wakeups while suppressing lead self-wakeups, watches `domain/` for MCP hot reload, and exposes `bridge_claim_task` / `bridge_complete_task` in the 11-tool `worker` profile.

## v1.1.0 — 任务接续与通知改进

Updated on 2026-11-05.

保存任务目标、负责人、已有成果和下一步，交接或等待结束后继续处理。任务页展示谁在处理、正在等待什么，以及接下来做什么。

同一问题集中更新，减少重复通知和重复确认；需要决定、任务受阻或工作完成时再提醒。已有任务保留原来的运行方式和会话，桌面与命令行投递继续兼容。

安装版和发布包使用同一份代码及发布清单。此次更新仅做语法检查，按用户要求未运行单元测试或模拟试跑。真实任务的运行记录用于后续确认效果。

## v1.0.0 — Deterministic Research Router, Dual-Layer Watchdog & Pure Domain Engine

Released on 2026-11-01.

**Architectural upgrade for reliable, low-relay multi-agent scientific collaboration.** `v1.0.0` separates pure domain rules from durable SQLite effects, adds a zero-LLM deterministic Research Router and Dual-Layer Watchdog, and redesigns the Workbench around human attention—all with zero third-party dependencies.

- **Pure Zero-I/O Domain Engine & Durable Effects Queue:** Splits `agent-bridge` into `src/domain/`, `src/store/`, and `src/runtime/` with `SAVEPOINT` nested transactions, `afterCommit` durable `bridge_effects` coalescing, `generation`-guarded deletion, and `Later` non-error deferrals.
- **Deterministic Research Router (`off | observe | auto`):** Supports `direct` and `context` thread subscription fan-out (`bridge_subscribe_thread`) with hard blind-isolation guards (`blind_analysis` / `blind_review`), out-of-scope ownership release (`bridge_handback`), anti-paraphrase pointer routing, `controls.md` `controlVersion` mandate revalidation, and shadow `would_dispatch` proposals in `observe` mode.
- **Dual-Layer Watchdog, `HealthBoard` & `+1` Human-Priority Slot:** L1 infrastructure self-healing reaps orphaned `in_flight` locks, recovers two-phase `delivered`-but-unconsumed messages with `RecoveryNote`, opens a 3-failure delivery circuit breaker, and runs quiet external-channel checks only while work is pending. L2 semantic probes append deduplicated spin/stale-evidence facts to `.optimizer/watchdog-events.jsonl` without overriding scientific ownership.
- **Inline Cards + Spill Pointers:** Compact `<= 200`-char previews with SHA-256 digests and lossless `bridge://<kind>/<id>` pagination via `bridge_read_card`, plus `bridge_watchdog_status` and KV-cache-friendly deterministic anchor prefixes in `research_memory.py`.
- **Attention-First Workbench, `builtInBase` 3-Way Upgrades & `SETUP.md`:** Surfaces `Needs human attention` (`Approve dispatch`, `Retry delivery`, `Answer & resume`), `HealthBoard` badges, and `Router Mode` controls at the top of Overview; tracks template baselines in `.research-orchestrator/baselines/` so `install --upgrade` never overwrites customized files; adds `probe`, `baselines`, and 4-level exit-code (`0/1/2/3`) `watchdog` CLI subcommands.

## [v0.5.0 — Epic update: collaboration visualization](https://github.com/Aoudsung/codex-research-orchestrator/releases/tag/v0.5.0)

Released on 2026-10-26.

**An epic update: collaboration visualization is here.** A new visual workbench brings collaboration between Codex, Claude Code, and Antigravity into one interactive workspace.

- Explore directed message relationships, task boards, evidence dependencies, and collaboration activity.
- Create and dispatch scoped tasks, send messages and replies, and inspect original sources and operation results.
- Pause new executions and automatic follow-up while already admitted calls finish; resume with existing routes and session bindings.
- Use a responsive English interface with desktop and mobile layouts, keyboard navigation, and a fictional demo that contacts no providers.

See the [workbench guide](docs/workbench.md) and [validation results](docs/validation-v0.5.md). Earlier release notes are available on [GitHub Releases](https://github.com/Aoudsung/codex-research-orchestrator/releases).

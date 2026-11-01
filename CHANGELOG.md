# Changelog

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

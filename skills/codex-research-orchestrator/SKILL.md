---
name: codex-research-orchestrator
description: Coordinate sustained research in Codex with independent construction, focused authorship, constructive review, and source-backed continuation. Use to start or resume research or coordinate authorized work across Codex, Claude Code, and Antigravity. For a bounded contribution, load only the relevant role and guidance.
license: MIT
metadata:
  version: "1.2.0"
---

# Codex Research Orchestrator

Keep the scientific question, evidence, and next action connected. Protect the user's research object and authorization; revise mechanisms, decisions, and candidate claims whenever evidence warrants it.

**Default topology disables Claude:** Coordinator (`Codex` Lead, non-coding) schedules `ChatGPT Web Pro`, `Codex` workers (`GPT Astra` / `6.1 Sol` / `Luna`), `Antigravity` (`Gemini Carbon` / `Argon`), and PI open-weight workers (`Kimi 3.1 Pro` / `DeepSeek V4.1 Flash`). Mechanical constraints are enforced by runtime admission guards and `python3 scripts/research_setup.py lint --project .`—do **not** duplicate rule lists into `AGENTS.md` or handoffs.

## Non-Negotiable Architecture Rules

1. **Lazy Phase Loading (<=1–2 Reference Cards per Turn):** Read `SKILL.md` and only the 1–2 reference files needed for your active phase.
2. **SQLite Single-Write Authority:** `controls.md` holds immutable constraints & lint switches. `.research-memory/memory.sqlite3` (`research_record`) is the single runtime ledger for claims, evidence, decisions, evaluations, and compact tombstones (`<=40` words). Write **once** per milestone—never double-write flat `research-log.md` / `open-questions.md` or turn-by-turn `state.md`. Export `state.md` only at user briefings, pause, or delivery.
3. **Zero-Copy Context Assembly & Lint-First Gates:** Call `research_context(query, profile, recipient_profile, role, stance)` instead of re-typing constraints. Run `research_setup.py lint` rather than appending defensive prohibition prose into docs.
4. **Tiered Tool Profiles:** Primary peer uses `lead`; execution workers use `worker` (11 tools incl. `bridge_claim_task` / `bridge_complete_task`); extra MCP peers use `exec_only`.
5. **Finish-and-Exit, Zero Busy-Wait:** Never spin on shell `sleep`, `bridge_poll_updates` loops, or long idle waits. Bind reactive wakeup (or check Web `Pro` every 15 min via `Luna` at `low` effort) and end the turn.

## Task Scope & Role Routing

Determine task type (Original research / Reproduction / Survey / Bounded support) and load **only** the active role card:
[Researcher](references/roles/researcher.md) | [Brainstormer](references/roles/brainstormer.md) | [Reviewer](references/roles/reviewer.md) | [Implementer](references/roles/implementer.md) | [Optimizer](references/roles/optimizer.md) | [Fact observer](references/roles/fact-observer.md)

| Need | Reference |
|---|---|
| Install, `init`, multi-peer `connect --tool-profile`, `doctor` | [getting-started.md](references/getting-started.md) |
| Model adapters (`pro_macro` / `gemini_panoramic`), L0–L4 effort routing | [model-profiles.md](references/model-profiles.md) |
| Universal rhetoric rules & 3 epistemic stances | [epistemic-stances.md](references/epistemic-stances.md) |
| Two-stage SOTA collision, endogenous repair, coupling razor, Tier-0/1/2 | [method.md](references/method.md) |
| Blind isolation, epistemic-delta gate, hypothesis forks, thin control plane | [collaboration.md](references/collaboration.md) |
| Task lease, `bridge_handback`, `waitForDelivery`, `pro_macro` guard | [mcp-collaboration.md](references/mcp-collaboration.md) |
| Zero-copy delta prompt templates & `pro_macro` inquiry | [prompts.md](references/prompts.md) |
| SQLite `research_*` tools, KV-cache packets, on-demand export | [memory.md](references/memory.md) / [records.md](references/records.md) |
| Host capabilities, optional observer, visual workbench | [codex-runtime.md](references/codex-runtime.md) / [observer.md](references/observer.md) / [workbench.md](references/workbench.md) |

## Authority Separation & Core Loop

- **Authority:** Verbatim user constraints (`controls.md` / `charter.md`) change only on user instruction. Decisions change when evidence warrants. Candidate claims track status (`conjecture | derived | supported | refuted`) and refutation criteria. Never shrink the research object for convenience.
- **Construction & Endogenous Loop:**
  1. *Ground & complete before formal runs:* Inspect real benchmarks and baselines before building machinery. Finish core method + baseline implementations together before launching unified formal suites.
  2. *Endogenous first principles:* Derive representation, operator, and update from one invariant relationship; reject fallback wrappers, heuristic gates, staged releases, calibration layers, or synthetic/toy stand-ins (enforced at task intake).
  3. *Claim-bound verification & Two-Patch Escape:* Bind every experiment and self-only ablation to explicit paper claims (`C1`/`C2`...). After `>=2` failed local patches without simplification, freeze patching and escalate via `Web Pro` / `Carbon`.
  4. *Single-writer safety & Epistemic-delta gate:* Lead coordinator never edits business code; keep one active writer per target path; break zero-delta loops via discriminative probes or two-branch forks.

## Stopping & Delivery

One writer per region; Lead owns scientific alignment and final acceptance. Independent review (`profile="review"`) remains distinct from self-checks. Deliver bounded tasks once verified; stop ongoing research only when acceptance criteria are met or an authorized pause/budget boundary is reached (exporting a resumption view to `state.md` on boundary/delivery). State supported conclusions, conditions, evidence locations, deliverables, and open questions cleanly.

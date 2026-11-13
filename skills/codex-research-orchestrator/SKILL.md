---
name: codex-research-orchestrator
description: Coordinate sustained research in Codex with independent construction, focused authorship, constructive review, and source-backed continuation. Use to start or resume research or coordinate authorized work across Codex, Claude Code, and Antigravity. For a bounded contribution, load only the relevant role and guidance.
license: MIT
metadata:
  version: "1.2.0"
---

# Codex Research Orchestrator

Keep the scientific question, evidence, and next action connected. Protect the user's research object and authorization; revise mechanisms, decisions, and candidate claims whenever evidence warrants it.

**Default topology does not include Claude:** Codex works alone or alongside `Antigravity` (`Gemini`) and authorized `ChatGPT Pro`; include `Claude` (`claude-code`) **only when the user explicitly declares it available** in the current instruction, `controls.md`, or `project.md`.

## Non-Negotiable Architecture Rules

1. **Lazy Phase Loading (<=1–2 Reference Cards per Turn):** Read `SKILL.md` and **only** the 1–2 reference files needed for your active phase. Never preload the whole `references/` tree.
2. **SQLite Single-Write Authority:** `controls.md` holds immutable user constraints. `.research-memory/memory.sqlite3` (`research_record`) is the single runtime source of truth for claims, evidence, decisions, evaluations, and tombstones. Write **once** per milestone/round via `research_record`—do **not** triple-write `state.md`, `rounds/RNN/record.md`, and `worklog.jsonl` every turn. Export or update `state.md` only at user briefings, pause/compaction, or final delivery.
3. **Zero-Copy Context Assembly:** Never manually re-type `controls.md`, role instructions, or stance prose into handoffs. Call `research_context(query, profile, recipient_profile, role, stance)` so controls, `Role & Stance Contract`, allowed records, and `JIT Recency Check` are deterministically compiled in the KV-cache prefix/tail; write only a concise task delta (`<= 150–300` words).
4. **Tiered Tool Profiles:** Primary peer uses `lead`; execution workers use `worker`; secondary peers use `exec_only` (zero duplicated shared schemas via `research_setup.py connect`).
5. **Finish-and-Exit, Zero Busy-Wait:** Never spin on shell `sleep`, `bridge_poll_updates` loops, or long idle `bridge_wait_for_delivery` calls after completing your own phase work. Bind reactive wakeup (`callerSessionId` / `autoWakeup`) or submit `bridge_submit_task_receipt(outcome="waiting_external" | "delivered")`, then **end the turn immediately** so peer replies or human/Web `Pro` returns wake the session on arrival.

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
- **Construction Loop:**
  1. *Ground the bottleneck:* Connect the difficulty to user constraints, latest SOTA assumptions, and a Tier-1 real-baseline diagnostic before building machinery.
  2. *Unify before patching:* Derive representation, operator, and feedback from one core relationship; assign a main author (`Codex` default, or opt-in `Claude`) and complementary probes.
  3. *Test SOTA & reality:* Check de-jargonized operator overlap, boundary counterexamples, and Tier-0/1/2 evidence.
  4. *Endogenous repair & Two-Patch Escape:* Fix inside the core operator first and prune uncoupled modules (destructive deletion test). After `>=2` failed patches without simplification, escalate via `abductive_pioneer` / `pro_macro`.
  5. *Epistemic-delta convergence:* Advance multi-round disputes only with new derivations, counterexamples, or data; break 2-turn zero-delta loops with a targeted probe or controlled two-branch fork.

## Stopping & Delivery

One writer per region; Lead owns scientific alignment and final acceptance. Independent review (`profile="review"`) remains distinct from self-checks. Deliver bounded tasks once verified; stop ongoing research only when acceptance criteria are met or an authorized pause/budget boundary is reached (exporting a resumption view to `state.md` on boundary/delivery). State supported conclusions, conditions, evidence locations, deliverables, and open questions cleanly.

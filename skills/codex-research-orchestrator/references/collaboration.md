# Collaboration Policy, Three Session Lanes & Write Discipline

Delegate separable investigation, independent review, or scoped execution while keeping the Lead coordinator strictly non-coding and enforcing one active writer per target path.

## Three Session Lanes & Participant Policy

- **Default team (`Claude` disabled):** `ChatGPT Web Pro`, `Codex` (`Astra` / `6.2 Sol` / `gpt-6-luna`), `Gemini Carbon` / `Argon` (pinned PI first, pinned Antigravity fallback), and PI open-weight models (`Kimi 3.1 Pro` / `DeepSeek V4.1 Flash`). Delegate by task need via `bridge_plan_dispatch`—full-team participation every turn is unnecessary.
- **Lane isolation (`ROUTE-001`):**
  1. `GPT` models -> `Codex` chats/subagents (`Astra` for formalization/efficiency/`blind_review`, `6.2 Sol` for implementation, `default`/`explorer` + `gpt-6-luna` `low` for L0 monitoring; `agent_type="Luna"` stays tool-free for effort judging).
  2. `Gemini` models (`Carbon` / `Argon`) -> **pinned project PI sessions first** (preserving existing retry/compaction settings & max concurrency 1); fall back to **pinned Antigravity** conversations when PI is unavailable/busy or a task explicitly binds Antigravity (e.g., dedicated Colab session). Map native Antigravity IDs (`gemini-pro-orchestrator*`) via `collaborators.json`.
  3. `Kimi` / `DeepSeek` -> explicit project-rooted **PI** sessions (`.pi/sessions/`, `cwd=project`, `magpie` `auto/*`, `retries=0`; legacy `dyschop/*` banned).
- **End-to-end binding & retirement:** Record `(planId, collaborationPolicyVersion, protocolEpoch, actualChannel, actualModel, actualEffort, selectionReason)` across `bridge_plan_dispatch -> createTask -> claim -> receipt`. Retire legacy subagents upon task handback rather than blindly `followup_task`-reusing mismatched `(model, effort, protocolEpoch)` sessions; `fork_turns="none"` always passes complete materials and boundaries.
- **Single-writer & remote GPU discipline:** One active writer per `writeRoots` (`WORK_LOCK`; never dodge locks via parallel `git worktree` checkouts). Schedule remote GPU jobs whenever `free VRAM >= peak + margin` (excluding faulty GPUs), without waiting for 100% host idleness (`evaluateGpuPlacement`).

## Three Isolation Contexts

| Context (`research_context` profile) | Permitted Inputs | Strict Exclusions |
|---|---|---|
| Independent analysis (`analysis`) | Verbatim user constraints, primary sources, direct evidence | Prior decompositions, candidate rankings, other evaluations |
| Independent review (`review`) | Analysis inputs + full target proposal + version-linked evidence | Prior reviews, lead conclusions, expectation hints, general inbox |
| Joint discussion (`resume`) | Current claims, decisions, disputes, open evidence | Material outside external-sharing authorization |

Isolation covers prompts, inherited conversation history, attachments, and filesystem scope. If true isolation is unavailable, label the result a self-check or joint check. Independent opinions must be saved before comparison.

## External-Author & Peer Exchange Rules

- **External-author mode:** Assign implementation, self-checks, and routine repairs together to one author; consolidate repair requests against a concrete artifact revision without re-doing full checks unless evidence contradicts claims.
- **Direct peer exchange:** Peers may message within recorded authorization, but `blind_analysis` and `blind_review` tasks are engine-blocked from `bridge_subscribe_thread` cross-thread fan-out (`agent-bridge`). Out-of-scope ambiguities immediately call `bridge_handback`.

## Progressive Multi-Round Dialogue & Controlled Forks

1. **Round 1 (Peeling):** Align definitions, hidden assumptions, and notation.
2. **Rounds 2..K (Epistemic-Delta Gate):** Continue only while each turn adds a new derivation step, counterexample, operator revision, or diagnostic measurement.
3. **Two-Turn Zero-Delta Fuse:** After two consecutive turns repeating existing claims without new math/data, intervene with a targeted Tier-1 diagnostic or record a **Controlled Two-Branch Hypothesis Fork** with its discriminative metric (or escalate via `pro_macro`).

## Bimodal Low-Entropy Communication

- **Thin control plane (`<= 150–200` words):** Coordination messages carry only (1) action/question, (2) immutable pointers (`record #ID`, `bridge://message/<id>`, `file:line`), (3) cursor delta, and (4) output contract—never paraphrasing full proofs, logs, or unchanged constraints.
- **Full-fidelity artifact plane:** Save complete derivations, counterexamples, and raw logs once in SQLite records or versioned files and reference them by pointer. Do not launch external calls for questions solvable locally in minutes.

## Pausing, Acceptance & Resumption

Accept work against final-revision receipts (commands, exit status, raw metrics, deviations), not confidence. Never keep a finished turn open waiting or polling: save a `state.md` resumption checkpoint (exported from SQLite), ensure reactive wakeup or `waiting_external` receipt is recorded for any async work, and **end the turn immediately** so new peer replies resume work cleanly.

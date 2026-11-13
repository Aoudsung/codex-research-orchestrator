# Research Memory & Deterministic Context Assembly

`.research-memory/memory.sqlite3` (managed via `research_*` MCP tools or `scripts/research_memory.py`, Python 3.10+ SQLite FTS5) is the **single runtime source of truth** for sustained research records. Do **not** mirror every SQLite write into Markdown (`state.md` / `rounds/RNN/record.md`); generate Markdown snapshots via `research_export` only at checkpoints or delivery.

## Three Authority Layers

1. **Authoritative controls (`controls.md`):** Small verbatim project file holding user questions, constraints, permissions, and pause boundaries. Always read live at the start of assembled packets.
2. **Working context (`research_context`):** Bounded, KV-cache-friendly packet assembled fresh per turn or handoff. Never replay raw chat logs as memory.
3. **Typed SQLite records (`research_record`):** Versioned, source-backed entries:
   - `source` / `evidence`: primary texts or direct measurements (no inherited judgments);
   - `claim`: `conjecture | derived | supported | refuted`, with explicit conditions;
   - `proposal`: complete candidate version submitted for review;
   - `decision`: current mechanism choice or tombstone (`<=40` words for ruled-out routes);
   - `evaluation`: participant review tied to a proposal version (not primary evidence);
   - `checkpoint`: task ID, delivery revision, active cursor, and next action.

## Deterministic Compilation (`role`, `stance`, `recipient_profile`)

Pass `role`, `stance`, `profile`, and `recipient_profile` to `research_context` (`memory.database_context`) so boilerplate contracts compile deterministically without consuming Lead output tokens:

- **Static KV-cache prefix (`anchor_prefix_chars`):** `header` + verbatim `controls` + `=== Role & Stance Contract ===` + deterministic `anchor` records (`target` + `required` + closure) remain byte-identical across queries sharing the same anchor set.
- **Dynamic tail (`=== JIT Recency Check ===`):** Appended at the packet end when non-default `profile`/`recipient_profile`/`role`/`stance` is active (`deductive_auditor` `<5%` cutoff + Coupling Razor, `gemini_panoramic` Five-Tuple Isomorphism, `pro_macro` first-principles prose, `zero_drift_executor` ambiguity handback).

| `recipient_profile` | Intended Model / Mode | Default `max_chars` & Packing Behavior |
|---|---|---|
| `pro_macro` | ChatGPT Pro | `6,000` max (`8,000` hard cap); **hard-blocks** `checkpoint`/`evaluation`, fenced code blocks, unified diffs, and itemized ledgers |
| `focused_curated` | Codex (`gpt_contract`) / opt-in Claude | `32,000` default; full target proposal + dependencies + linked counterevidence |
| `gemini_panoramic` | Antigravity Gemini | `240,000` default (up to `400,000`); full raw `source`/`proposal`/`evidence` first for `1M+` recall |
| `default` | Lead synthesis | `12,000` default in `database_context`; caller-specified otherwise |

## Isolation Profiles & Completeness Tiers

- **`resume`:** Full admitted current history for Lead synthesis (`>=` includes counterevidence links `refutes|limits|conflicts`).
- **`analysis`:** Allowlisted primary `source`/`evidence` + live controls; withholds evaluations and prior choices.
- **`review`:** `analysis` inputs + designated `proposal` target; neutral labels (`Material N`), omits prior evaluations and lead manifest.
- **Tiered packing:** (1) Required controls + `target` + `required` must fit intact or fail loudly (never truncate constraints); (2) query-ranked whole records (+ recent fill if enabled); (3) omission count + bounded index so nothing disappears silently.

## Revision, Invalidation & CLI

- Revisions must pass `supersedes` + `reason`; idempotent writes reuse `external_key`.
- Changing a tracked source file or withdrawing an upstream record marks dependents `needs_review` automatically.
- CLI fallback when MCP is unavailable:
  ```sh
  python3 /path/to/skill/scripts/research_memory.py --project DIR api context < query.json
  python3 /path/to/skill/scripts/research_memory.py --project DIR context "terms" --profile review --role reviewer --stance deductive_auditor --allow 1 --target 2 --output pkt.md
  ```

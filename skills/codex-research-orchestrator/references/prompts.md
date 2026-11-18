# Zero-Copy Handoff & Prompt Delta Templates

Do **not** waste output tokens manually copying `controls.md`, role manuals, or stance rules into every message. Call `research_context` (or `research_memory.py context`) with explicit `profile`, `recipient_profile`, `role`, and `stance`:

- `controls.md` verbatim block, `=== Role & Stance Contract ===`, and anchor records sit at the **static leading prefix** (high KV-cache hit rate).
- `=== JIT Recency Check ===` sits deterministically at the **tail** right before generation.
- The Lead writes **only a lean task delta (`<= 150–300` words)** covering the active question, immutable `record #ID` / `bridge://` pointers, write scope, and output contract.

## 1. ChatGPT Web `Pro` Macro Inquiry (`pro_macro`, `<= 400–850` Words + Grounding)

`ChatGPT Pro` runs in the designated **ChatGPT Web UI (`chatgpt.com`) project** set to `Pro` thinking effort, with standing authorization for repo sync or bundle upload, unrestricted output depth, and **15-minute status checks by `Luna` (`low`)**.

Each Web `Pro` dispatch pairs **one grounding attachment** with a **3-paragraph zero-bureaucracy prompt**:

1. **Grounding (`github_repo` or `upload_bundle`):**
   - `github_repo`: synced GitHub repo URL/branch + target paths; OR
   - `upload_bundle`: secret-scrubbed `.zip` via `scripts/pack_pro_bundle.py --project . --output <bundle.zip> --include <paths> --prompt-file PRO_PROMPT.md` (ignores `.pi/`, `.env`, credentials, `.git`, `.sqlite*`; **skips per-file SHA-256 ceremonies** unless `--include-sha256` is explicitly passed).
2. **Inline Prompt (`<= 850` words):** Reference target files directly, keep prose clean (no fenced code blocks, unified diffs, itemized `D{k}/C{n}` ledgers, or rigid word/checklist caps restricting `Pro` output):

```markdown
Grounding: {GitHub repo or uploaded bundle `BUNDLE_MANIFEST.md`; key files: `src/...`, `results/...`}

{Paragraph 1 — Research Object & Invariants: core mathematical/information-theoretic description of system O and unbroken causal loop + essential constraints.}

{Paragraph 2 — Structural Paradox: theoretical or empirical anomalies from grounded real benchmarks/trajectories showing where current operators fail (no fallback patches).}

{Paragraph 3 — First-Principles Inquiry: ask one deep unifying question on representation/operator/dynamics; let Web Pro derive at full depth.}
```

**Post-reply:** `Astra` / Lead formalizes `Pro`'s prose into equations, code specs, and claim records in SQLite, then dispatches blind falsification (`Astra` only).

## 2. Independent Blind Review Delta (`review` + `deductive_auditor`)

Assemble packet with `research_context(profile="review", target=PROPOSAL_ID, allow=[...], role="reviewer", stance="deductive_auditor", recipient_profile="focused_curated")`, excluding all prior evaluations. Add only this delta:

```markdown
Target: Proposal Material 1 (immutable version/revision) | Track: {formal_falsification | prior_art_isomorphism | mechanistic_reconstruction}
Deliverable scope: {bounded review question & independence requirement}
Required checks:
1. Object consistency across prose claims, equations, and code (exact variable/path locus).
2. Adversarial <5% tail/degeneracy/leakage hunt & destructive deletion test.
3. Closest de-jargonized predecessor check (UNOBSERVED if absent from packet).
4. Findings formatted as: [Blocker | Suggestion] Location -> Trigger -> Consequence -> Smallest internal repair.
```

## 3. Panoramic Cross-Domain / Literature / Log Delta (`gemini_panoramic`)

Assemble raw primary papers, module trees, or logs via `research_context(..., recipient_profile="gemini_panoramic", role="brainstormer", stance="abductive_pioneer")` (or `role="researcher"` for SOTA collision), dispatched to Gemini `Carbon` / `Argon` via pinned project PI session first (or pinned Antigravity fallback):

```markdown
Question: {SOTA shared-assumption audit | Stage-2 operator collision | cross-domain transfer | whole-log failure trace}
Requirements:
- Anchor every factual statement to exact paper section/equation, `file:line`, or log timestamp; mark absent facts `UNOBSERVED`.
- For cross-domain ideas, state the complete Five-Tuple Isomorphism (state mapping, runtime signal observability, transferred operator, broken assumption + adaptation, falsifiable prediction).
```

## 4. Zero-Drift Implementation / Execution Delta (`implementer` + `zero_drift_executor`)

Assemble context with `research_context(..., role="implementer", stance="zero_drift_executor", recipient_profile="focused_curated")`:

```markdown
Task binding: {logicalTaskId / session / artifact revision} | Write scope: {explicit writeRoots}
Invariant semantics (zero silent drift): {metric, split, objective rules that must NOT change}
Budget & stop conditions: {max batches, timeout, device limits}
On scientific/objective ambiguity: stop and call `bridge_handback(reasonCode="scientific_ambiguity")`.
Return Receipt: status (complete|partial|blocked), diff scope, exact commands + exit status, raw metrics + artifact paths, unexecuted checks.
```

## 5. Multi-Round Follow-up & Format Repair

- Before new delegation or stage transitions, call `bridge_plan_dispatch` against `.agent-bridge/collaborators.json` to select model, channel, and task-scoped `Luna` effort; when `fork_turns="none"`, always include complete materials, active constraints, and write boundaries.
- Follow-ups send **delta only**: `Continue {task/cursor}`, `Current revision`, `Epistemic delta / new question`, `Evidence pointers` (keep Antigravity/PI history concise; preserve pinned PI retry/compaction settings). After 2 zero-delta turns, switch to a discriminative real-benchmark probe or two-branch fork.
- If an output violates a required JSON/schema contract, resend the schema and minimal valid example naming only the violated field/type—never echo the broken output in full.

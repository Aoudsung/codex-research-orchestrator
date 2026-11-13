# Zero-Copy Handoff & Prompt Delta Templates

Do **not** waste output tokens manually copying `controls.md`, role manuals, or stance rules into every message. Call `research_context` (or `research_memory.py context`) with explicit `profile`, `recipient_profile`, `role`, and `stance`:

- `controls.md` verbatim block, `=== Role & Stance Contract ===`, and anchor records sit at the **static leading prefix** (high KV-cache hit rate).
- `=== JIT Recency Check ===` sits deterministically at the **tail** right before generation.
- The Lead writes **only a lean task delta (`<= 150–300` words)** covering the active question, immutable `record #ID` / `bridge://` pointers, write scope, and output contract.

## 1. ChatGPT Web `Pro` Macro Inquiry (`pro_macro`, `<= 400–850` Words + Grounding Attachment)

`ChatGPT Pro` means the **ChatGPT Web UI (`chatgpt.com`) set to `Pro` thinking effort** (not a CLI model). Place the `abductive_pioneer` constitution once in Pro's persistent project/system instructions (`cohesive prose, zero "not A, but B" tropes, ~30% signal amplification, <5% corner cutoff, Assume-and-Proceed 2–3 layers deep`).

Each Web `Pro` dispatch pairs **one primary grounding attachment** with a **3-paragraph zero-bureaucracy prompt** (`research_context(..., profile="analysis", recipient_profile="pro_macro", stance="abductive_pioneer")`):

1. **Grounding Attachment (`github_repo` or `upload_bundle`):**
   - `github_repo`: synced GitHub repo URL, branch, commit SHA, and exact target module/trace paths for Pro's GitHub/repo reader; OR
   - `upload_bundle`: secret-scrubbed `.zip` archive created by `scripts/pack_pro_bundle.py --project . --output <bundle.zip> --include <paths> --prompt-file PRO_PROMPT.md` (strictly excludes `.env`, `SSH_Document.md`, credentials, `.git`, and `.sqlite*`, and generates `BUNDLE_MANIFEST.md`).
2. **Inline Chat Prompt (`<= 850` words):** May cite exact relative file/module names inside the attached repo/bundle so derivations stay grounded, while **stripping** inline pasted code blocks, unified diffs, itemized `D{k}/C{n}` ledgers, and rigid status-header checklists:

```markdown
Grounding: {GitHub repo@commit or uploaded bundle `BUNDLE_MANIFEST.md`; key files: `src/...`, `results/...`}

{Paragraph 1 — Research Object & Functional Invariants: pure conceptual/information-theoretic description of system O and unbroken causal loop + verbatim critical constraints.}

{Paragraph 2 — Core Structural Paradox: distill theoretical/empirical anomalies showing why existing representations or feedback rules fail at principle level against the grounded evidence (never attach tentative local patches).}

{Paragraph 3 — High-Horizon Question: ask ONE unifying question on representation/operator/dynamics, requesting 2–3 deep derivation steps grounded in the attached files and exact breaking conditions.}
```

**Post-reply:** Lead (`gpt_contract` / `deductive_auditor`) translates Pro's prose into variables/operators, verifies object invariants against `controls.md`, records claims in SQLite (`research_record`), and schedules blind audit.

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

Assemble raw primary papers, module trees, or logs via `research_context(..., recipient_profile="gemini_panoramic", role="brainstormer", stance="abductive_pioneer")` (or `role="researcher"` for SOTA collision):

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

- Follow-ups send **delta only**: `Continue {task/cursor}`, `Current revision / sha256`, `Epistemic delta / new question`, `Evidence pointers`. After 2 zero-delta turns, switch to a Tier-1 probe or controlled two-branch fork.
- If an output violates a required JSON/schema contract, resend the schema and minimal valid example naming only the violated field/type—never echo the broken output in full.

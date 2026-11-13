# Model Cognitive Profiles, L0–L4 Routing & Session Lanes

Assignments compile along three axes: `Role × Epistemic Stance × Model Adapter` (compiled deterministically via `research_context(..., role=..., stance=..., recipient_profile=...)`). **Claude (`claude-code`) is strictly opt-in**—never assume or route to Claude unless explicitly declared available in the user's request, `controls.md`, or `project.md`.

## Adaptive Participant Topology

| Scientific responsibility | Default complete topology (`Codex` + `Antigravity` [+ `ChatGPT Pro`]) | Opt-in overlay (`Claude` explicitly declared) |
|---|---|---|
| Macro framing & bottleneck escape | **ChatGPT Pro** (`pro_macro`), or isolated **Codex** (`abductive_pioneer`) | Unchanged (`ChatGPT Pro` retains macro framing) |
| SOTA ceiling, operator collision & cross-domain scan | **Antigravity Gemini** (`gemini_panoramic`) | Unchanged (`Gemini` retains panoramic recall) |
| Main-author derivation & cohesive prose | **Codex** (`gpt_contract`) | **Claude** (`claude_synthesis`) may lead drafting |
| Tier-0/1 diagnostics & zero-drift code | **Codex** (math-to-code) + **Antigravity** (pipelines/logs) | **Claude** owns narrow `writeRoots` sub-packages |
| Dual-track blind review (`blind_review`) | **Isolated Codex** (`formal_falsification`) ∥ **Isolated Antigravity** (`prior_art_isomorphism`) | Add **Isolated Claude** (`mechanistic_reconstruction`) |

## Four Cognitive Adapters & Packet Profiles

- **`pro_macro` (ChatGPT Web `Pro`, `<=6,000` chars):** ChatGPT Web UI (`chatgpt.com`) running with `Pro` thinking effort (distinct from CLI models). Has the deepest internal search tree over invariants; suffocated by inline code blocks, diffs, `D{k}/C{n}` ledgers, or rigid checklists inside the chat box, yet fails to derive faithfully if ungrounded. Dispatch via two parts: (1) primary grounding attachment (`github_repo`: repo URL + branch + commit SHA + exact target paths, OR `upload_bundle`: secret-scrubbed `.zip` via `scripts/pack_pro_bundle.py`), plus (2) a clean 3-paragraph structural prose prompt (`<=850` words; exact repo/bundle relative paths allowed). **Asymmetric post-reply:** Lead (`Codex`) translates prose into variables/operators, runs `deductive_auditor` Object Invariant Checks against `controls.md`, and logs claims via `research_record`.
- **`gpt_contract` (Codex / ChatGPT, `focused_curated` `16k–48k` chars):** Contract-first precision; prone to safe module-stacking under heavy open-ended checklists. For review (`formal_falsification`): disable `<5%` cutoff, verify text/equation/code object identity, hunt hidden identifiability/leakage assumptions, and construct degenerate boundaries. For execution (`zero_drift_executor`): trigger `bridge_handback(reasonCode='scientific_ambiguity')` instead of guessing semantics.
- **`claude_synthesis` (Claude — Opt-in only, `focused_curated` `24k–64k` chars):** Concept-to-architecture synthesis and constructive repair (`mechanistic_reconstruction`). Forbid balancing compromises or retreating to safe baselines; enforce tight `writeRoots`.
- **`gemini_panoramic` (Antigravity Gemini, `150k–400k` chars):** Native `1M+` raw long-context recall (full papers, repos, run logs) in static-first prefix order. Enforce the **Five-Tuple Isomorphism** for cross-domain transfer and verbatim `section`/`file:line`/`timestamp` citations (`UNOBSERVED` if absent).

## L0–L4 Risk-Based Model & Thinking Effort Routing Matrix

Match model tier and reasoning `effort` (`minimal | low | medium | high | xhigh | pro_max`) to epistemic risk and reversibility rather than maxing compute everywhere:

| Level | Workload & Risk Profile | Recommended Model + Effort | Tool Profile |
|---|---|---|---|
| **L0** | Mechanical reads, status, search, export, formatting | Lightweight/fast peer or Lead (`minimal` / `low`) | `worker` / `exec_only` |
| **L1** | Scoped implementation & reproducible smoke checks with locked spec (`zero_drift_executor`) | `Codex` or `Antigravity` (`medium`) | `worker` (9 tools) |
| **L2** | Standard synthesis, core math-to-code, ablation/Tier-1 probe design | `Codex` / `Gemini` / opt-in `Claude` (`high`) | `lead` / `worker` |
| **L3** | High-risk `deductive_auditor` review, `<5%` tail/leakage hunt, multi-patch diagnosis | `Codex` (`xhigh`) ∥ Blind Reviewer (`high`/`xhigh`) | `lead` (`review` packet) |
| **L4** | Structural impasse (`>=2` patches), core problem framing, cross-domain breakthrough | `ChatGPT Pro` (`pro_max`) + `Gemini` (`gemini_panoramic`) + `Codex` (`xhigh`) | `pro_macro` / `gemini_panoramic` |

## Runtime Dynamic Escalation & De-escalation Triggers

1. **Two-Failure / Two-Patch Escalation (`engine.mjs` `jitGuidance`):** After `>=2` consecutive failed validations or `>=2` stacked local patches, automatically escalate to `high`/`xhigh` (`recommendedEffort`), freeze ad-hoc patching, run endogenous operator + destructive deletion checks, or escalate to **L4** `pro_macro`.
2. **Zero-Delta Discussion Spin (`>=3` turns without new evidence/patch):** Watchdog trips circuit; escalate to Lead `high`/`xhigh` to issue a Tier-1 discriminative probe or controlled two-branch fork.
3. **Scientific Ambiguity Handback:** Worker calling `bridge_handback(reasonCode='scientific_ambiguity')` halts local guessing; Lead resolves semantics at `high` effort before re-dispatch.
4. **Verification De-escalation:** Once mechanism equations and baseline pass **L3** audit (`derived`/`supported`), downgrade routine sweeps and regression runs back to **L1** (`medium`).

## CLI vs Desktop Session-Lane Binding Rules

- Record explicit `(logicalTaskId, participant, sessionId, requestedModel, effortTier)` per task; keep requested model/effort separate from runtime-reported model identity.
- **CLI headless lanes** (`codex_exec`, `antigravity_exec`, opt-in `claude_exec`) run on isolated task/worktree bindings (`completeTaskOnExit: false` when awaiting verification; secondary MCP peers use `BRIDGE_TOOL_PROFILE=exec_only`).
- **Desktop / Web interactive lanes** (e.g., **ChatGPT Web `Pro`** browser/desktop pane with `github_repo` or `upload_bundle` grounding, Workbench human-attention queue) handle **L4** macro consults and user decisions without colliding with CLI cursors or overwriting active worktrees.

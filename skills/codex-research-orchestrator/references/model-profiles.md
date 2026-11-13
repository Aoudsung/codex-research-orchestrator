# Model Cognitive Profiles and Prompt Adapters

Roles define **what responsibility** an assignment carries; model cognitive adapters define **how instructions, context packets, and constraints are shaped** so each model family operates at peak reasoning capability rather than fighting its post-training priors.

Codex can execute every role alone when external providers are not connected. When ChatGPT Pro, Codex / ChatGPT, Claude Code, and Antigravity (Gemini) are available, compile assignments along three orthogonal axes:

$$\text{Assignment} = \text{Role Responsibility} \times \text{Epistemic Stance} \times \text{Model Adapter}$$

See [epistemic stances](epistemic-stances.md) for stance rules and [purpose-specific prompts](prompts.md) for prompt assembly.

## Capability, Failure-Mode, and Routing Matrix

| Model family & adapter | Intrinsic cognitive strengths | Predictable failure modes (must constrain) | Primary role affinities | Context packet profile |
|---|---|---|---|---|
| **ChatGPT Pro**<br>`pro_macro` | Deepest internal test-time search tree; holds abstract mathematical/functional invariants simultaneously; discovers first-principles unifications | **Micro-constraint suffocation:** code paths, symbol names, `D{k}/C{n}` ledgers, and rigid output tables consume search depth and anchor Pro to local patching | Macro Problem Framing, First-Principles Mechanism Genesis, Bottleneck Escape (`>=2` patches), Fundamental Ceiling Analysis | `pro_macro`<br>(`<=6,000` chars; zero code, diffs, or ledger dumps) |
| **ChatGPT / Codex**<br>`gpt_contract` | Exact multi-constraint satisfaction; formal proof and boundary auditing; surgical edits; deterministic tool/state discipline | **Checklist module-stacking:** open-ended ideation under heavy checklists favors safe modular combinations over native conceptual leaps | `Research Lead` State Arbiter, Formal Blind `Reviewer` (`formal_falsification`), Precision `Implementer` & Verification Harness | `focused_curated`<br>(`16,000–48,000` chars; exact contracts & line pointers) |
| **Claude (Opus / Sonnet)**<br>`claude_synthesis` | Strongest concept-to-architecture isomorphism; turns macro sketches into cohesive end-to-end algorithms; constructive critique; fluid academic prose | **Polite compromise & scope creep:** default tendency to hedge, blend incompatible mechanisms, or over-refactor adjacent modules if `writeRoots` are loose | `Main Author` Mechanism Deepener, Constructive Blind `Reviewer` (`mechanistic_reconstruction`), Greenfield Module Architect, Scientific Prose Author | `focused_curated`<br>(`24,000–64,000` chars; full proposal + primary sources) |
| **Antigravity (Gemini)**<br>`gemini_panoramic` | Native `1M+` long-context global recall across dozens of full papers, repos, or logs; widest cross-disciplinary breadth; multimodal plot/trace diagnostics | **Premature convergence & surface metaphor:** cross-field analogies risk staying metaphorical without exact operator bijection; proof hand-waving; silent config tweaks | Panoramic Closest-Predecessor Scout, Cross-Domain Isomorphism `Brainstormer`, Whole-Repo / Multi-Log Empirical Diagnostician, `Fact Observer`, Rapid Pipeline Builder | `gemini_panoramic`<br>(`150,000–400,000+` chars; raw full texts, static-first) |

## Adapter 1: `pro_macro` (ChatGPT Pro — Extended Deep-Reasoning Oracle)

Use ChatGPT Pro at **high-leverage conceptual inflection points**, not for routine bug triage, bookkeeping, or incremental parameter tuning.

### Two-tier prompt separation

1. **Persistent Project / System Constitution (set once per research line):**
   Place the **Universal Rhetoric Baseline** and the full **`abductive_pioneer` stance** (cohesive human prose, zero bullet-list fragmentation, zero antithetical "not A, but B" framing, abductive signal amplification, burden-of-proof inversion, `5%` tail-risk truncation, Assume-and-Proceed 2–3 layers deep, and first-principles native framework aesthetics) in Pro's persistent system/project instructions so per-turn prompts stay clean.
2. **Minimalist Per-Turn Macro Inquiry (`<= 400–800` words, three prose paragraphs):**
   - **Paragraph 1 — The Research Object and Functional Invariants:** State what system is being studied and which causal or information-flow loop must remain intact, expressed in pure conceptual/mathematical terms (plus verbatim user constraints where scope-critical).
   - **Paragraph 2 — The Core Structural Paradox:** Compress prior theoretical or empirical friction into the underlying structural contradiction (why existing classes of representations or feedback rules break at the principle level). Share raw anomalies or impossibility tensions—**never** attach the lead's tentative patchwork plan before Pro forms its own view.
   - **Paragraph 3 — One Open High-Horizon Question:** Ask **one** (at most two tightly coupled) macro-directional question inviting a unified representation, operator, or dynamics, and ask Pro to push its strongest candidate 2–3 layers deep into mechanism dynamics, emergent properties, and critical failure boundaries.

### Pre-dispatch de-clutter gate (hard exclusions for `pro_macro`)

Before sending any prompt to ChatGPT Pro, strip:

- Repository file paths, function/class identifiers, CLI flags, git commits, and patch diffs;
- Internal bookkeeping IDs (`D1..Dk`, `C1..Cn`, `W0001`, SQLite/bridge IDs);
- Prescribed step-by-step `Work Sequence` checklists and rigid multi-part output schemas (such as variable-by-variable compliance tables or `complete / partial / blocked` status headers).

### Asymmetric post-reply assimilation ("Pro Abducts Free, Lead Audits Strict")

Never ask Pro to maintain `state.md` or format ledger updates. After collecting Pro's complete unbroken reply:

1. **Codex (`Research Lead`)** translates Pro's continuous conceptual/mathematical mechanism into concrete state variables, operators, and dataflow steps.
2. **Codex** runs the strict `deductive_auditor` **Object Invariant Check** (`满足 / 违反 / 不涉及` with variable/step citations) against `controls.md`. If Pro's abduction crossed a boundary, repair the boundary locally within the mechanism or isolate the exact contradiction for a targeted follow-up.
3. Record extracted claims (`conjecture` / `derived`) in `.research-memory` and route them to blind falsification (`gpt_contract` / `claude_synthesis`) and closest-predecessor check (`gemini_panoramic`).

## Adapter 2: `gpt_contract` (ChatGPT / Codex — Precision Auditor & Executor)

- **Contract-first structure:** Put exact input/output schemas, invariants, line-numbered source/code references, and `readRoots` / `writeRoots` up front.
- **Formal falsification focus (`auditTrack: "formal_falsification"`):** When reviewing, enforce `deductive_auditor` and require three explicit checks:
  1. *Object consistency*: verify whether abstract claims, mathematical objective, and code/protocol address the exact same research object without silent proxy substitution.
  2. *Identifiability and assumption audit*: expose unstated independence, stationarity, rank, or oracle-information leaks.
  3. *Degenerate boundary test*: construct a concrete edge regime (`N=1`, zero-variance signal, adversarial tie, distribution shift) to test whether the mechanism collapses to a known baseline.
- **Zero-drift execution:** Enforce `zero_drift_executor`. Require `completeTaskOnExit: false` where supported, version-linked `Execution Receipts`, and immediate `bridge_handback` on semantic ambiguity.

## Adapter 3: `claude_synthesis` (Claude — Mechanistic Deepener, Constructive Critic & Author)

- **Teleological framing:** State the **core unifying principle** ("derive representation, update rule, and stopping/feedback criterion from one shared relationship rather than adding separate corrective modules") before listing constraints.
- **Anti-compromise and anti-retreat guardrails:** Explicitly forbid blending two incompatible candidate mechanisms merely to appear balanced, and forbid retreating to a safe standard baseline when an early mechanism hits a local open condition—require deriving the minimal operator modification that preserves the core contribution.
- **Constructive review focus (`auditTrack: "mechanistic_reconstruction"`):** Pair conceptual critique with the smallest structural repair inside the original research object.
- **Cohesive authoring + tight write fences:** Enforce continuous prose (eliminating antithetical cliches and listicle fragmentation) for proposals and papers; bind explicit narrow `writeRoots` during code tasks to prevent out-of-scope refactoring.

## Adapter 4: `gemini_panoramic` (Antigravity Gemini — Panoramic Scout & Empirical Analyst)

- **Full-raw long-context ingestion:** Use `gemini_panoramic` context packets (`150k–400k+` chars) containing complete primary papers, whole module trees, or full raw run logs, ordered with static controls and primary sources first for prefix cache reuse. Avoid feeding lossy pre-summaries when raw sources fit.
- **Five-tuple structural isomorphism gate (for cross-domain transfer and brainstorming):** Explicitly forbid metaphorical analogies ("this resembles simulated annealing / immune selection"). Every transferred mechanism must specify:
  1. *State mapping*: exact correspondence between source-domain state and target research object;
  2. *Observable feedback*: proof that the signal driving the source operator actually exists at runtime in our setting;
  3. *Operator form*: explicit mathematical or algorithmic update rule after transfer;
  4. *Broken assumption & cost*: which source theorem assumption fails here and what modification supplies it;
  5. *Falsifiable prediction*: one concrete behavior that differs from existing target-domain baselines.
- **Verbatim anchor & `UNOBSERVED` rule:** Every prior-art comparison, codebase trace, or log diagnosis must cite exact paper sections/equations or `file:line` / log timestamps. Any quantity not present in raw materials must be marked `UNOBSERVED`—never interpolated.

## Multi-Model Research Lifecycle Routing

When all participants are available, prefer this division of labor:

1. **Divergent Genesis (`blind_analysis`):** Dispatch isolated problem framing in parallel—**ChatGPT Pro** (`pro_macro` first-principles inquiry), **Antigravity Gemini** (`gemini_panoramic` 20-paper closest-predecessor & cross-field isomorphism scan), and **Claude** (`claude_synthesis` concrete mechanism sketch). Compare only after independent outputs are saved.
2. **Focused Mechanism Construction:** Select **Claude** (or **Codex** for formal/systems-heavy designs) as `Main Author` to deepen the chosen unified mechanism; invoke **ChatGPT Pro** only when a fundamental theoretical knot appears.
3. **Dual-Track Blind Review (`blind_review`):** Run **Codex** (`formal_falsification`: invariants, leaks, boundary counterexamples) in parallel with **Claude** (`mechanistic_reconstruction`: core causal strength & minimal structural repair), plus **Gemini** (`prior_art_isomorphism` when literature overlap is uncertain).
4. **Implementation & Panoramic Diagnostics:** Use **Codex / Claude Code** for zero-drift core implementation and verification tests; use **Antigravity Gemini** for benchmark harness wiring and whole-log / multimodal failure trajectory diagnosis.
5. **Bottleneck Escape (`>=2` consecutive local patches):** Have **Gemini** distill the invariant failure signature across all raw run logs, then send a clean 3-paragraph paradox inquiry to **ChatGPT Pro** (`pro_macro`) to re-architect the core representation.

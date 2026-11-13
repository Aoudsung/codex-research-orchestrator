# Model Cognitive Profiles and Prompt Adapters

Roles define **what responsibility** an assignment carries; model cognitive adapters define **how instructions, context packets, and constraints are shaped** so each model family operates at peak reasoning capability rather than fighting its post-training priors.

Codex can execute every role alone when external providers are not connected. **Claude (`claude-code`) is strictly opt-in**: never assume, suggest, or route tasks to Claude unless the user explicitly declares Claude available in the current prompt, `controls.md`, or `project.md`. By default, multi-agent collaboration forms a complete, zero-gap system using **`Codex` + `Antigravity (Gemini)` (+ `ChatGPT Pro` when authorized)**.

Compile assignments along three orthogonal axes:

$$\text{Assignment} = \text{Role Responsibility} \times \text{Epistemic Stance} \times \text{Model Adapter}$$

See [epistemic stances](epistemic-stances.md) for stance rules and [purpose-specific prompts](prompts.md) for prompt assembly.

## Adaptive Participant Topology (Default Without Claude vs. Opt-In Claude)

| Scientific responsibility | Default complete topology (`Codex` + `Antigravity` [+ `ChatGPT Pro`]) | Optional overlay (ONLY when user explicitly declares `Claude` available) |
|---|---|---|
| **First-principles framing & bottleneck escape** | **ChatGPT Pro** (`pro_macro`), or isolated **Codex** (`abductive_pioneer`) if Pro is unavailable | Unchanged (**ChatGPT Pro** retains macro-paradigm framing) |
| **Latest SOTA ceiling mapping, operator collision & cross-domain scan** | **Antigravity Gemini** (`gemini_panoramic`: full-text latest primary papers + cross-field search) | Unchanged (**Antigravity Gemini** retains panoramic recall & multimodal diagnostics) |
| **Main-author mechanism derivation & cohesive writing** | **Codex** (derives unified operator, runs coupling/deletion checks, authors trope-free prose) | **Claude** (`claude_synthesis`) may take `Main Author` mechanism deepening and narrative drafting |
| **Tier-0/Tier-1 diagnostics & zero-drift execution** | **Codex** (core math-to-code & diagnostic probes) + **Antigravity** (benchmark pipelines & full-log diagnostics) | **Claude** may own clean-sheet modular sub-packages within narrow `writeRoots` |
| **Dual-track independent blind review (`blind_review`)** | **Isolated Codex** (`formal_falsification` + `subtractive_razor`) $\parallel$ **Isolated Antigravity** (`prior_art_isomorphism` + `sota_breakthrough`) | Add or substitute **Isolated Claude** (`mechanistic_reconstruction`: minimal structural repair) |

## Capability, Failure-Mode, and Routing Matrix

| Model family & adapter | Intrinsic cognitive strengths | Predictable failure modes (must constrain) | Primary role affinities | Context packet profile |
|---|---|---|---|---|
| **ChatGPT Pro**<br>`pro_macro` | Deepest internal test-time search tree; holds abstract mathematical/functional invariants simultaneously; discovers first-principles unifications | **Micro-constraint suffocation:** code paths, symbol names, `D{k}/C{n}` ledgers, and rigid output tables consume search depth and anchor Pro to local patching | Macro Problem Framing, First-Principles Mechanism Genesis, Bottleneck Escape (`>=2` patches), Fundamental Ceiling Analysis | `pro_macro`<br>(`<=6,000` chars; zero code, diffs, or ledger dumps) |
| **ChatGPT / Codex**<br>`gpt_contract` | Exact multi-constraint satisfaction; formal proof and boundary auditing; surgical edits; deterministic tool/state discipline | **Checklist module-stacking:** open-ended ideation under heavy checklists favors safe modular combinations over native conceptual leaps | `Research Lead` State Arbiter, Formal Blind `Reviewer` (`formal_falsification`), Precision `Implementer` & Verification Harness | `focused_curated`<br>(`16,000–48,000` chars; exact contracts & line pointers) |
| **Claude (Opus / Sonnet)** *(Opt-in only)*<br>`claude_synthesis` | Strongest concept-to-architecture isomorphism; turns macro sketches into cohesive end-to-end algorithms; constructive critique; fluid academic prose | **Polite compromise & scope creep:** default tendency to hedge, blend incompatible mechanisms, or over-refactor adjacent modules if `writeRoots` are loose | *(Active only when user-declared)*: `Main Author` Mechanism Deepener, Constructive Blind `Reviewer` (`mechanistic_reconstruction`), Scientific Prose Author | `focused_curated`<br>(`24,000–64,000` chars; full proposal + primary sources) |
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

By default (without Claude), coordinate the research lifecycle across **Codex**, **Antigravity (Gemini)**, and authorized **ChatGPT Pro** (attaching **Claude** only when explicitly declared by the user):

1. **Frontier Ceiling & Real-Baseline Bottleneck Check:** **Antigravity** (`gemini_panoramic`) ingests full texts of the strongest recent primary papers to identify their shared unspoken assumption, while **Codex / Antigravity** runs a Tier-1 read-only diagnostic on real baseline data/logs to verify the bottleneck exists in actual dataflow.
2. **Divergent Genesis (`blind_analysis`):** Dispatch isolated problem framing in parallel—**ChatGPT Pro** (`pro_macro` first-principles inquiry), **Antigravity Gemini** (`gemini_panoramic` cross-field isomorphism scan), and **Codex** (or opt-in **Claude** `claude_synthesis`) concrete mechanism sketch. Compare only after independent outputs are saved.
3. **Focused Mechanism Construction & Operator Collision Check:** **Codex** (or opt-in **Claude**) acts as `Main Author` to derive the unified mechanism; **Antigravity** immediately runs a de-jargonized Stage-2 operator collision search against recent primary literature to verify genuine SOTA breakthrough.
4. **Dual-Track Blind Review (`blind_review`):** Run **Isolated Codex** (`formal_falsification`: invariants, leaks, boundary counterexamples, and coupling/deletion razor) in parallel with **Isolated Antigravity** (`prior_art_isomorphism` & SOTA assumption-relaxation check)—plus opt-in **Isolated Claude** (`mechanistic_reconstruction`) when declared.
5. **Implementation & Panoramic Diagnostics:** Use **Codex** (and opt-in **Claude Code** if declared) for zero-drift core implementation and verification tests; use **Antigravity Gemini** for benchmark harness wiring and whole-log / multimodal failure trajectory diagnosis.
6. **Bottleneck Escape (`>=2` consecutive local patches):** Have **Antigravity** distill the invariant failure signature across raw run logs, then send a clean 3-paragraph paradox inquiry to **ChatGPT Pro** (`pro_macro`) to re-architect the core representation.

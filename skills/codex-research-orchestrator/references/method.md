# Research Methods, SOTA Collision & Verification Ladder

Select the validation strategy matched to the study (theoretical proof, computational derivation, empirical/causal design, reproduction, or primary-source critique).

## 1. Object Fidelity & Claim Structure

Anchor key claims in the form:
> Under conditions `A`, for research object `O`, mechanism `M` yields `Y` via evidence `E`; observation or counterexample `F` refutes or narrows it.

Ensure prose claims, mathematical objective, and code compute the **exact same object `O`**—do not silently swap in a convenient proxy.

## 2. Two-Stage Adversarial SOTA Collision

- **Stage-0 Frontier Blind-Spot Check (before ideation):** Inspect the strongest recent primary papers (last 12–18 months) to extract their shared unspoken assumption and where it breaks; aim construction directly at that ceiling.
- **Stage-2 De-jargonized Operator Collision (after invention):** Strip coined names and search adjacent literatures by pure mathematical operator/objective structure to ensure genuine novelty.
- **Three Valid Breakthrough Criteria (matched compute & information budget):**
  1. *Unifying generalization:* existing SOTA reduces to a special/degenerate case of `M`.
  2. *Assumption relaxation:* `M` holds where SOTA degrades because a hidden premise fails.
  3. *Structural Pareto replacement:* `M` matches/beats SOTA while dropping an expensive stage, oracle signal, or compute bottleneck.

## 3. Cross-Domain Five-Tuple Isomorphism

Reject surface metaphors. Any cross-domain mechanism transfer must verify all five components:
1. Target bottleneck & exact state correspondence `S_src <-> S_tgt`;
2. Proof the driving feedback signal is observable at runtime in target `O`;
3. Explicit transferred mathematical/algorithmic operator;
4. Which source assumption fails in target `O` and the adaptation fixing it;
5. One falsifiable behavioral prediction separating it from native baselines.

## 4. Endogenous Repair, Coupling Razor & Escape Law

- **First-principles endogenous priority (`intake.mjs` enforced):** Repair inside the core mathematical formulation and representation directly. Forbid fallback wrappers, heuristic gates, staged releases, or calibration/certification layers bolted around a weak operator.
- **Destructive Deletion Test:** Reject uncoupled pipeline stacking (`L = L1 + λ2 L2 + λ3 L3`). Every non-baseline piece must prove mathematical coupling with the core operator and produce **qualitative failure** if deleted.
- **Two-Patch Escape:** Exceeding two local patches without simplifying the core explanation mandates freezing edits and reframing (`Web Pro` / `Carbon`).

## 5. Real-Benchmark Discipline & Unified Verification

- **Real benchmarks only (`SYNTHETIC_FIXTURE_FORBIDDEN`):** Never run synthetic/toy environments or mock checkpoints/samplers when real benchmarks and pretrained weights exist. Inspect real trajectories directly.
- **Core + Baseline together before formal runs:** Finish implementing both the core method and baselines completely before launching unified formal experiment suites; cut unnecessary local unit-test scaffolding and redundant pre-checks.
- **Claim-bound runs & self-only ablations (`CLAIM_BINDING_REQUIRED`):** Bind every experiment and ablation to explicit paper claims (`C1`/`C2`...); ablations isolate only our own proposed components without modifying external baselines.

## 6. Multi-Round Cognitive Displacement

- **Rule-out tombstones:** Record dead routes in SQLite (`research_record`) and checkpoints as `<=40`-word tombstones with evidence IDs so peers never reinvent falsified mechanisms under new labels.
- **Controlled hypothesis forks:** When multi-round evidence hinges on a scale-dependent trade-off, keep both bounded hypotheses alive with an explicit discriminative experiment rather than forcing premature consensus.

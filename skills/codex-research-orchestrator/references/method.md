# Choose Evidence for the Research Question

Read this file when proposing an approach, analyzing its effectiveness, or designing a study. A study may combine the approaches below; it need not use all of them.

## From a Question to a Testable Judgment

First define what the study seeks to explain or change, its target quantity, applicable conditions, available information, and resources. Mechanistic research must connect input information, feedback, the update or action mechanism, system behavior, and the target outcome. Descriptive or explanatory research must connect sources, measurement or interpretation, evidence, and claims. Do not present an association as a mechanistic conclusion without the conditions needed for causal identification.

State the assumptions each inference depends on and whether the current proposal satisfies them. Address contradictions in definitions, non-identifiability, missing information, implementation deviations, and counterexamples that can be found before an experiment. Identify the specific quantity that still needs observation instead of ending the analysis with “no experiments have been run.”

Use this form for key claims:

> Under conditions A, for object O, method or explanation M is expected to produce outcome Y. Evidence E supports the following links in that argument; observation or counterexample F would refute or limit it.

## Forms of Evidence

| Research type | Main work and evidence | What this does not establish by itself |
|---|---|---|
| Theory and mathematics | Precise definitions, assumptions, lemmas and proofs, counterexamples, boundary conditions | Successful numerical examples do not establish a general theorem |
| Computation and systems | Algorithm derivation, correspondence with implementation, appropriate tasks and strong baselines, resource and reproducibility records | Working components or improved internal metrics do not establish that the overall goal has been met |
| Empirical and observational research | Measurement validity, sampling, identification conditions, treatment of confounding and bias, suitable comparisons and uncertainty | Correlation does not establish causation; results within a sample do not guarantee generalization |
| Experimental and design science | Mechanism of action, executable protocol, controls, measurement conditions, interpretation of results | Trial and error without a mechanistic basis; an unexecuted protocol is not a result |
| Qualitative and literature research | Primary materials, source criticism, selection rationale, coding or interpretation process, contrary evidence | A collection of summaries is not an argument; missing material does not establish that a phenomenon is absent |
| Reproduction and validation | Original claims and conditions, alignment of implementation and protocol, localization of differences, checks affected by those differences | A failed reproduction does not necessarily refute the original method; a reproduction under different conditions is not an equivalent test |

A theoretical study may use proof as its main evidence. A new field may rely on custom instruments, datasets, or tasks, but must justify their correspondence to the research object, independence, and scope of applicability. Do not require public benchmarks, model training, or experiments in every field.

## Building Mechanisms and Transferring Ideas Across Fields

First remove field-specific labels and describe the bottleneck in terms of actions, information, constraints, and failure points. Then search for work that addresses the same structure. Read the actual methods and validity conditions in primary sources. Similar names do not establish corresponding mechanisms.

For each borrowed idea, answer:

- What corresponds to the structure the original method relies on? How will missing conditions be supplied?
- Which relationship, operation, or feedback does it change, and what outcome should change as a result?
- What counterexample would make the transfer fail? Should the idea be retained, adapted, or abandoned?

Explain how the components work together through their core relationships. Use a responsibility table to check for gaps and redundancy, and add cross-field modules only when they change a core relationship.

The task determines the contribution standard. Reproduction, falsification, measurement, theoretical explanation, data resources, and methodological innovation can all be valid goals. When novelty matters, assess the substantive difference from the closest work, the properties that follow from it, and the significance of the contribution separately.

## Construction and completion in original research

Apply this section when the user's task is original research. Reproduction, surveys, bounded reviews, and engineering support retain their own completion criteria.

Early candidates need a reasoned causal account, identifiable assumptions, and a way to investigate their strongest counterexamples. Do not require a finished proof, final novelty judgment, and complete experiment budget for every short idea. Before adopting a main proposal as complete, require both rigorous support appropriate to its actual claims and a substantive contribution relative to the closest work.

When an idea has a flaw, apply **internalize-first repair and coupling/deletion gates** to prevent bloated module-stacking:

1. **Internalize-first repair:** Before introducing any external regularizer, auxiliary network, buffer, or gating heuristic, first test whether modifying the existing core representation, metric space, or update operator resolves the counterexample internally. Introduce a new component only when analysis shows the existing state mathematically lacks information required to close the loop.
2. **Coupling and deletion-necessity test (anti-Frankenstein gate):** Do not justify components by pipeline division of labor ("Module A handles stability, Module B handles exploration") or uncoupled score blending (`L = L1 + λ2 L2 + λ3 L3`). Every component or hyperparameter beyond the minimal baseline must answer two questions: (a) how its internal state or signal mathematically couples with the core operator, and (b) what qualitative failure occurs if it is deleted. During convergence, prune any component whose removal causes only a marginal metric fluctuation rather than qualitative breakdown.

If the route is ruled out, record a one-line tombstone with evidence and reconstruct the approach. Do not present a known baseline as completion of an unmet originality objective. If repairs accumulate past two local patches without simplifying why the parts belong together, reconsider the underlying representation or feedback relationship. Conversely, novelty does not justify retaining a disproved claim.

### Two-stage adversarial SOTA collision and breakthrough modes

To avoid reinventing recent work under new terminology or optimizing against outdated textbook baselines:

- **Stage-0 frontier blind-spot check (before ideation):** Inspect the strongest primary papers from the latest 12–18 months (top venues and recent preprints) to extract the **shared unspoken assumption** behind current SOTA methods and the concrete regime where that assumption breaks. Aim mechanism design directly at that frontier ceiling.
- **Stage-2 de-jargonized operator collision (immediately after mechanism invention):** Strip newly coined names and search primary literature across adjacent fields by mathematical operator / objective structure to verify the update rule was not already published under different terminology.
- **Three valid modes of substantive SOTA breakthrough:** A candidate original contribution must establish at least one of the following under matched information and compute budgets:
  1. *Unifying generalization*: current SOTA emerges as a restricted or degenerate special case of the proposed formulation;
  2. *Critical assumption relaxation*: the mechanism succeeds with theoretical or empirical guarantees in a realistic regime where latest SOTA structurally degrades due to a violated premise;
  3. *Structural Pareto replacement*: the mechanism matches or outperforms SOTA while eliminating an expensive training stage, oracle signal, or computational bottleneck.

A diagnosis of remaining bias, incomplete convergence, or weak novelty should lead to the next specific construction while work is authorized and resources remain. Respect pauses, round limits, and real resource boundaries. At those boundaries report the unfinished objective and concrete next step.

## Derivations and Counterexamples

Construct the strongest counterexamples directly relevant to the goal. Distinguish structural flaws, implementation deviations, and additional conditions. State a clear judgment: which claim holds, what it depends on, which claim fails, and the smallest correction needed. Lack of a guarantee does not establish impossibility; intuition and assumptions are not proofs.

For a worst-case guarantee, prove that the proposal is sufficient. A matching lower bound is needed only when claiming optimality. Check units, numerical values, and boundaries. Finite examples support only the cases they cover; broader claims require a mapping or argument.

## Designing Experiments or Observations

First examine how the relevant field supports similar claims, then select tasks, data, comparisons, and scale. For computational performance claims, prefer established tasks matched to the goal and competitive baselines. Do not replace the research object simply because convenient data are available.

For each necessary experiment, specify:

| Claim or unresolved condition | Explanations to distinguish | Task/object and comparison | Observations and criteria | How different results would change the judgment | Cost and stop conditions |
|---|---|---|---|---|---|

Specify key metrics, data splits or material selection, and necessary randomness, repetitions, and uncertainty treatment in advance. Choose them for the field and concrete failure modes, rather than applying a fixed checklist. Exploration after seeing results is allowed, but distinguish it from prespecified tests. Do not manufacture a success claim through repeated selection of metrics and baselines.

Start with a **tiered diagnostic ladder** that sharpens scientific insight while avoiding **toy-model mirages** (methods that shine on 2D synthetic Gaussians yet fail on high-dimensional real distributions, or representation phenomena invisible at toy scale):

- **Tier-0 symbolic or synthetic sanity check (one-sided bug filter only):** Use `<100`-line scripts or symbolic checks strictly to catch sign errors, dimensional mismatches, zero gradients, or immediate numerical blowups. Passing Tier-0 never establishes real-world efficacy; absence of emergent representation effects in a tiny synthetic toy never disqualifies a mechanism.
- **Tier-1 real-baseline trajectory diagnostic (primary insight generator):** Before building complex new training pipelines, run lightweight read-only diagnostics on a small slice of **real task data, pretrained activations, or logged SOTA baseline trajectories** to verify that the hypothesized bottleneck actually occurs in real dataflow and to capture quantitative anomalies that refine the theory.
- **Tier-2 matched-budget benchmark evaluation:** Expand to full competitive baselines only after Tier-1 confirms the phenomenon and the core mechanism is internally coherent. Experiments test explicit predictions or isolate empirical unknowns; they cannot replace logical analysis that should come first.

When execution prerequisites or human-participant approvals are pending, continue design and source work.

## Writing

Organize the account around the problem and gap, method or explanation, key relationships, evidence, and conditions on the conclusion. Adapt the form to the field. The abstract, methods, and evidence must address the same research object. When an argument breaks, first check whether the object or claim has been substituted, then revise the prose. Report negative results and conditional conclusions accurately.

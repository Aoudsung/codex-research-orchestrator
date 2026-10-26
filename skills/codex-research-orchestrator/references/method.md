# Choose Evidence for the Research Question

Read this file when proposing an approach, analyzing its effectiveness, or designing a study. A study may combine the approaches below; it need not use all of them.

## From a Question to a Testable Judgment

First define what the study seeks to explain or change, its target quantity, applicable conditions, available information, and resources. Mechanistic research must connect input information, feedback, the update or action mechanism, system behavior, and the target outcome. Descriptive or explanatory research must connect sources, measurement or interpretation, evidence, and claims. Do not present an association as a mechanistic conclusion without the conditions needed for causal identification.

State the assumptions each inference depends on and whether the current proposal satisfies them. Address contradictions in definitions, non-identifiability, missing information, implementation deviations, and counterexamples that can be found before an experiment. Reasoning alone cannot establish empirical effect sizes or external validity. Identify the specific quantity that still needs observation instead of ending the analysis with “no experiments have been run.”

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

Explain how the components work together through their core relationships. A responsibility table can reveal gaps and redundancy; it cannot prove that a framework is unified or novel. Reading another field is not a reason to add another module.

The task determines the contribution standard. Reproduction, falsification, measurement, theoretical explanation, data resources, and methodological innovation can all be valid goals. When novelty matters, assess the substantive difference from the closest work, the properties that follow from it, and the significance of the contribution separately. Do not make “disruptive innovation” a default requirement for every project.

## Construction and completion in original research

Apply this section when the user's task is original research. Reproduction, surveys, bounded reviews, and engineering support retain their own completion criteria. A contributor may complete its assignment while the overall original-research objective remains unfinished.

Early candidates need a reasoned causal account, identifiable assumptions, and a way to investigate their strongest counterexamples. Do not require a finished proof, final novelty judgment, and complete experiment budget for every short idea. Before adopting a main proposal as complete, require both rigorous support appropriate to its actual claims and a substantive contribution relative to the closest work.

When an idea has a flaw, locate the smallest failing condition and attempt a constructive repair of its core relationship within the original object. Derive how the revision addresses the counterexample and what assumptions or costs it adds. Relevant corrections may change an estimator, representation, feedback signal, stopping rule, or certificate; choose them because they address the failure, not because they sound sophisticated. Merely naming an error term or an unavailable assumption is not a solution.

If the route is ruled out, preserve the negative evidence and reconstruct the approach. Do not present a known baseline as completion of an unmet originality objective. If repairs accumulate without explaining why the parts belong together, reconsider the underlying representation or feedback relationship. Conversely, novelty does not justify retaining a disproved claim.

When novelty is weak, investigate the problem's distinctive structure, the information available to the method, and its closest predecessors. Seek a concrete mechanism difference and a nontrivial consequence supported by derivation or suitable observation. A new name, a collection of useful parts, or the fact that a general framework can express the method does not settle that assessment.

A diagnosis of remaining bias, incomplete convergence, or weak novelty should lead to the next specific construction while work is authorized and resources remain. Respect pauses, round limits, and real resource boundaries. At those boundaries report the unfinished objective; do not promise a positive solution or call the study complete because a discussion ended.

## Derivations and Counterexamples

Construct the strongest counterexamples directly relevant to the goal. Distinguish structural flaws, implementation deviations, and additional conditions. State a clear judgment: which claim holds, what it depends on, which claim fails, and the smallest correction needed. Lack of a guarantee does not establish impossibility; intuition and assumptions are not proofs.

For a worst-case guarantee, prove that the proposal is sufficient. A matching lower bound is needed only when claiming optimality. Check units, numerical values, and boundaries. Finite examples support only the cases they cover; broader claims require a mapping or argument.

## Designing Experiments or Observations

First examine how the relevant field supports similar claims, then select tasks, data, comparisons, and scale. For computational performance claims, prefer established tasks matched to the goal and competitive baselines. Do not replace the research object simply because convenient data are available.

For each necessary experiment, specify:

| Claim or unresolved condition | Explanations to distinguish | Task/object and comparison | Observations and criteria | How different results would change the judgment | Cost and stop conditions |
|---|---|---|---|---|---|

Specify key metrics, data splits or material selection, and necessary randomness, repetitions, and uncertainty treatment in advance. Choose them for the field and concrete failure modes, rather than applying a fixed checklist. Exploration after seeing results is allowed, but distinguish it from prespecified tests. Do not manufacture a success claim through repeated selection of metrics and baselines.

Start with the smallest check that can distinguish the current explanations. Expand only when results, changes, or new evidence justify it. Experiments test existing predictions, quantify effects, or examine explicit hypotheses; they cannot replace logical analysis that should come first.

If execution authorization, conditions on material use, or real boundaries such as requirements for research involving human participants are unmet, continue permitted design and source work. Proposing a study does not authorize its execution.

## Writing

Organize the account around the problem and gap, method or explanation, key relationships, evidence, and conditions on the conclusion. Adapt the form to the field. The abstract, methods, and evidence must address the same research object. When an argument breaks, first check whether the object or claim has been substituted, then revise the prose. Report negative results and conditional conclusions accurately.

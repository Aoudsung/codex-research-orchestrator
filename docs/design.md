# Design rationale: preserve scientific value in sustained autonomous research

## The motivating problem

The author's motivation is a practical concern: research automation can complete many operations while still struggling to assess novelty, identify the key scientific problem, and retain the original research purpose without supervision. Across multiple rounds, a tentative assumption can become a premise inherited by every participant. An easy proxy can replace what the user actually wanted to study.

This project addresses those failure modes through a collaboration protocol. The explanations below are design arguments and testable predictions, not evidence that the framework outperforms other systems.

## From failure to mechanism

| Failure mode | Mechanism | Why behavior may change | Observable check |
|---|---|---|---|
| Easy subtasks displace the original question | Original user constraints, object checks, and a difficulty–judgment–evidence link in each round | Handoffs must reconnect actions to the original problem; a substituted object leaves a traceable discrepancy | An independent assessor compares the final research object with the original request and identifies unauthorized changes |
| A current approach becomes an immutable requirement | Separate constraints, decisions, and candidate claims | Protect the goal while allowing failed methods to exit | Does a counterexample lead to a revised candidate while preserving the original question? |
| Agents inherit and reinforce one flawed decomposition | Independent analysis before comparison, with prior evaluations withheld | Reduce direct anchoring on another participant's conclusion | Were judgments formed independently, and did new counterexamples or conditions change the decision? |
| Renaming or combining techniques is treated as innovation | Compare the closest work, transfer conditions, and necessary relationships among components | Ground novelty in differences in behavior or properties and expose unsupported combinations | Can a reviewer identify the substantive difference and the property it produces? |
| Reviews accumulate without resolution | The lead accepts, rebuts, or leaves each finding open with evidence | Convert feedback into traceable actions and establish ownership | Do blocking findings remain in the delivered version, and are rebuttals supported? |
| Compaction or handoff changes goals and conclusions | Separate authoritative statements, current state, and original results | Resumption can verify sources and conditions instead of relying on a summary alone | Are constraints, claim conditions, and running jobs consistent before and after resumption? |
| Retrieval returns a relevant but outdated or prejudicial record | Typed memory, explicit source dependencies, live controls, and input filtering before ranking | Applicability and participant access are checked separately from lexical relevance; changed evidence requires dependent claims to be reviewed | Does a new pause survive without reindexing? Does changed evidence invalidate its dependents? Can excluded evaluations alter an independent packet? |
| Activity is judged by rounds, pages, or run counts | Index changed judgments; let an optional observer inspect specific evidence | Focus coordination improvements on information gained and concrete bottlenecks | Can each necessary action's knowledge gain and avoided repetition be explained? |

## Innovation and continuity can coexist

The research object, key scientific question, and confirmed user requirements remain stable unless the user changes them. Candidate mechanisms, problem decompositions, implementations, and experiments remain revisable.

Freezing tentative choices can prevent correction by counterexample. Allowing the original goal to drift can make local success irrelevant to the request. The framework treats these as different kinds of change.

The same distinction applies to cross-field research. A different method is welcome, but its structure must map to the original problem. Explain which operation or relationship it changes and what prediction follows. More disciplines or modules do not by themselves establish innovation.

In exploratory work, evidence can be a counterexample, a necessary condition, a mechanism argument, or a more precise problem statement. It need not immediately produce a runnable score. When a metric is available, connect it to the objective rather than inferring overall effectiveness from a local improvement.

## Scope of the contribution

The original deliverables are a Codex research protocol, role handoffs, record templates, and a design for adapting them across fields. They organize multi-round behavior around scientific value. They do not provide a new base model, search algorithm, or training method.

Independent review, human feedback, multi-agent systems, and persistent records have precedents. The current review of related work supports a comparison of design emphasis. It cannot establish “first,” “only,” or “solves autonomous research quality.” See [related work](related-work.md).

## Conditions and failure boundaries

The protocol depends on a sufficiently clear user question, access to primary materials, participants with relevant knowledge, effective context isolation and permissions, and a lead that actually checks evidence and resolves feedback.

The process can degrade into form filling: labels without evidence, polished names for weak ideas, or self-review presented as independent assessment. The skill therefore requires judgments to point to definitions, derivations, primary sources, or actual execution results. Missing evidence remains a gap rather than a completed acceptance check.

Model limitations, incorrect sources, shared blind spots, restricted experiments, and unavailable permissions can still cause failure. More roles do not automatically remove these problems. A feedback loop alone does not prove research effectiveness.

## How to test the design

A future comparison should give workflows the same questions, original materials, model capabilities, and budgets. Preserve full outputs, then ask assessors who did not see the generation process to examine:

- Whether the key scientific question was identified and meaningfully advanced.
- Whether the final claims match the original object, constraints, and requested deliverable.
- Whether the contribution is substantive and the key claims have suitable evidence.
- Whether counterexamples and review findings led to justified revisions.
- The relationship between knowledge gained and unnecessary work under matched resources.

Specify hypotheses and criteria before the comparison. Until such results exist, keep design goals separate from evidence of effect. These evaluation suggestions are not mandatory steps for every research project.

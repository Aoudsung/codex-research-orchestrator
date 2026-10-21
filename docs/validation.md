# Version 0.1.0 validation notes

Date: 2026-10-21. Validation covers the skill package and two controlled usage scenarios. It does not measure research quality or comparative performance.

## Package checks

- The `quick_validate.py` tool supplied with Codex's `skill-creator` accepted the skill entry point with exit code 0.
- Plugin JSON and skill YAML were parsed, including the name, MIT declaration, and invocation prompt.
- Local Markdown links, the release file list, and both copies of the MIT license were checked. The standalone skill also includes the complete license.
- Targeted checks looked for names from the source research project, private absolute paths, chat identifiers, connection-file references, and common secret patterns. The release consists of newly written instructions and templates, without private research materials.

These checks are not a plugin-directory approval and do not imply identical tool availability across Codex clients.

## Independent forward-use checks

Two agents each used a fresh context without prior discussion. They could read only the skill directory and the supplied fictional inputs. They received no expected answer and did not read the source project's history. They sent no external messages, ran no research experiments, and changed no code. The authoring agent inspected the actual outputs; the observations below are qualitative.

The behavioral checks used the Chinese draft before translation. The English release preserves those instructions and receives package and translation checks; it has not undergone a separate full behavioral rerun.

### Scenario 1: theoretical research

Task, translated from the original test input:

> Determine when the minimum vertex cover size equals the maximum matching size in a finite simple graph. Deliver a research memo with reasoning and counterexamples, then identify the most useful next question. Do theoretical work only: no experiment code, no external partner, and do not assume the graph is bipartite.

Actual output: a necessary and sufficient condition using an independent set and a matching that saturates its complement into that set, with a proof in both directions. It gave bipartiteness as sufficient, a triangle as a counterexample, and a triangle with an added leaf to show that bipartiteness is not necessary. It proposed studying which vertex deletions preserve equality.

Observed behavior: the agent retained the general-graph question, progressed through proof and counterexample, and did not require training or a benchmark. It labeled its result as derivation and self-review, without claiming independent review or an exhaustive literature search. The requested theoretical memo was completed.

### Scenario 2: empirical research resumption

Given inputs:

- Study the association between rainfall and turbidity in real rivers. Do not infer causation or replace real-river findings with synthetic water samples.
- C1, “turbidity universally rises after rain,” remains a conjecture; a partner predicts that it must hold.
- Real-data statistics job `job-17` has started, but its result has not been retrieved.
- The compute budget is four hours, with 3.5 hours recorded as used. External data sharing is not authorized.
- Only a 12% increase in a synthetic-sample comparison is available. No job-query or messaging tools are exposed.

Actual output: C1 remained a conjecture. The agent explained that the 12% result cannot establish the real-river claim and retained the partner's prediction as an opinion. It calculated 30 minutes remaining on the recorded budget while noting that current usage by the in-flight job was unknown. It proposed checking the existing job before any new launch, marked the sharing task as unauthorized, and drafted a state update without claiming to have saved it or queried the job.

Observed behavior: the agent retained the research object, evidence limits, permissions, and resource boundary. It completed the available synthesis and identified the specific missing tools and results.

## Evidence not yet established

There is no matched-model, matched-budget comparison with related projects, long unattended deployment study, cross-field research-quality evaluation, or plugin-marketplace installation approval. The two checks support only the behavior observed in those scenarios. They do not establish an overall research-quality advantage. See [design rationale](design.md) for a proposed evaluation approach.

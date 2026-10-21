# Validation notes

Date: 2026-10-21. Version 0.1.0 validation covers the skill package and two controlled usage scenarios. It does not measure research quality or comparative performance.

## Package checks

- The `quick_validate.py` tool supplied with Codex's `skill-creator` accepted the skill entry point with exit code 0.
- Plugin JSON and skill YAML were parsed, including the name, MIT declaration, and invocation prompt.
- Local Markdown links, the release file list, and both copies of the MIT license were checked. The standalone skill also includes the complete license.
- Targeted checks looked for names from the source research project, private absolute paths, chat identifiers, connection-file references, and common secret patterns. The release consists of newly written instructions and templates, without private research materials.

These checks are not a plugin-directory approval and do not imply identical tool availability across Codex clients.

## Memory and context helper

The final helper passed **21 regression tests** on the designated Linux validation server using Python 3.10.12 and SQLite 3.37.2 with FTS5. No model, GPU, or external service was used. The command, run from the repository root, was:

```sh
python3 -m unittest discover -s tests -p test_research_memory.py -q
```

The run completed with exit code 0. Checks cover durable reads, source changes, transitive invalidation, withdrawal and supersession, fresh control files, complete review targets, exact whole-record budgeting, allowlist isolation, excluded-record ranking independence, safe project paths, compact CLI output, and existing-output protection.

An independent engineering review identified a concurrent refresh that could replace a committed `withdrawn` or `superseded` state with `needs_review`. The update now preserves those terminal states. A two-connection interleaving test covers both cases. The final run includes that regression.

A reproducible synthetic scale check used 1,000 source records:

```sh
python3 tests/benchmark_memory.py
```

| Measurement | Observed result |
|---|---:|
| Total source characters | 982,704 |
| Requested search entries | 5 |
| Median search time, three calls | 187.20 ms |
| Context assembly time | 189.84 ms |
| Packet characters | 11,548 |
| Packet budget | 12,000 |
| Context CLI response characters | 172 |

The scale check initially exposed a 72,808-character command response because the entire manifest was printed. The final CLI returns only paths, sizes, and counts; the full lead manifest stays on disk. The test checks this boundary separately from the packet budget.

These are one-environment measurements on simple synthetic lexical queries. They establish the observed output sizes and runtime, not semantic recall, production latency, or superiority to the referenced memory projects.

## Version 0.1.1 changes

These changes apply lessons from a separate research system's memory and context design. That system's code and data are not part of this package.

- Every packet ends with a `Not shown` section. It counts admitted records that are not in the packet and indexes as many as fit within the budget. Independent packets use neutral labels.
- `--fill-recent` lets admitted records without a lexical match fill the remaining budget, newest first.
- The assembly time moved from the first line to the last line, so rebuilt packets agree on all earlier text.
- The references add rules on output contracts and repair, inputs for each step, whole-state updates, failure history, and incremental work-index entries.

Local runs on 2026-10-21, on macOS, with Python 3.13.1 / SQLite 3.45.3 and with Python 3.10.20 / SQLite 3.53.1. In both, the command above passed **25 tests**: the 21 earlier tests unchanged, plus 4 new ones. The new tests cover the count and index within budget and the index as an ordered prefix under a tight budget; neutral independent labels without titles or paths; newest-first filling; and identical text before the timestamp. The CLI test also checks the indexed count. These runs did not use the Linux server above.

One run of `python3 tests/benchmark_memory.py` with Python 3.13.1 gave a 101.59 ms median search, 105.08 ms context assembly, an 11,975-character packet (budget 12,000), and a 203-character CLI response. Python 3.10.20 gave the same packet and response sizes. The packet is larger than in the 0.1.0 table because the index uses budget the 0.1.0 packet left empty. Timings come from a different machine and are not comparable with the table above.

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

There is no matched-model, matched-budget comparison with related projects, long unattended deployment study, cross-field research-quality evaluation, or plugin-marketplace installation approval. The controlled scenarios and tool tests support only the behavior they cover. They do not establish an overall research-quality advantage. See [design rationale](design.md) for a proposed evaluation approach.

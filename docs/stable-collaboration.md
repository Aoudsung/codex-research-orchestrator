# Stable collaboration workflows

Choose the workflow from the shape of the task. One owner can handle a bounded request. For independent sections of a report, analysts work in parallel and one author integrates their findings. A fresh verifier freezes the draft, records an expected result and tests the assertions that could change the conclusion. With the owner's authorization the coordinator can apply the verifier's exact replacements and verify the resulting document against the evidence. The owner makes the final decision on the full report. See the [installed errata workflow](../runtimes/agent-bridge/docs/live-handoffs.md).

For dependent stages, record each milestone against a version and its upstream dependencies. Address handoffs to the responsible member and session. When upstream evidence changes, reopen the affected work and tie acceptance to the current evidence for each requirement. Record any remaining gaps at partial closure. The [work-run protocol](../skills/codex-research-orchestrator/references/work-modes.md) covers the calls and receipt fields.

For a timed investigation, use a common deadline and record the first applicable candidate, review, revision and acceptance when they occur. Distinguish completed model and tool measurements from gaps in the trace. See the [timing and replay guide](../runtimes/agent-bridge/docs/reproduction-and-deadlines.md).

## What the trials measured

Each result below is one run of the stated workflow on a frozen task with a 15-minute limit. Visible token counts cover completed provider steps. They may omit interrupted work.

| Task | Observed delivery | Scope of adoption |
| --- | --- | --- |
| A · parallel report | Two verified corrections reached the final text. Blind score 8/10, 671.89 s and 241,770 visible tokens. The earlier lightweight workflow scored 9/10 in 628.28 s, using 326,317 visible tokens. | Use targeted replay and direct corrections where a single-line change resolves the finding. Continue to judge the full report independently. |
| B · difficult implementation | The latest run ended at 574.81 s. The author used its 565 s allocation without submitting an applicable candidate. Review never started. | Retain timing diagnostics. In-turn patch delivery was demonstrated with a synthetic author and has no real-task delivery in this trial. It stays experimental. |
| C · dependent milestones | The framework delivered all three stages in 785 s and scored 10/10. A single author handled the two upstream revisions. | Use versioned milestones and evidence-linked acceptance for dependent revisions. Throughput and numerical equivalence were outside this trial. |

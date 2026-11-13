# Handoff-Ready Work Instructions

Use the sections relevant to the recipient's role, [epistemic stance](epistemic-stances.md), and [model cognitive adapter](model-profiles.md). Put the question and output contract first; do not force a full research prompt into a small revision request, and **never** force engineering checklists or ledger dumps into a macro-inquiry for ChatGPT Pro (`pro_macro`). Replace braces and expand references the recipient cannot access. If the project has fixed wording required by the user, reproduce it verbatim; do not carry those personal requirements into other projects.

Apply the **Universal Rhetoric and Rigor Baseline** from [epistemic stances](epistemic-stances.md) to all analytical, constructive, review, and writing prompts: forbid antithetical tropes ("X is not A, but B"), sycophancy, and defensive filler ("no experiments run yet, so uncertain"); require constructive reframing ("to bridge A to B, construct condition/operator C").

## Macro-Directional Inquiry (ChatGPT Pro / `pro_macro`)

Use this protocol whenever querying ChatGPT Pro (or another extended test-time-compute oracle) for problem framing, first-principles mechanism invention, or bottleneck escape. Technical micro-clutter suffocates Pro's search depth and anchors it to local patching.

### 1. Persistent System / Project Constitution (set once per conversation)

Place these behavioral and epistemic rules in Pro's persistent project or system instructions rather than repeating bookkeeping forms every turn:

```markdown
Operate as a first-principles theoretical pioneer. Derive mechanisms natively from the problem's intrinsic structure so representations, operators, and feedback emerge from one unified relationship—never through incremental patching or Lego-like stacking of familiar modules.

Rhetoric and discourse:
- Strictly forbid binary contrast cliches ("X is not A, but B," "It is not about X, it is about Y," "The real problem is not..."). State theses directly and positively.
- Write in cohesive, continuous human-expert prose with explicit causal transitions between paragraphs. Do not fragment arguments into mechanical bulleted listicles.
- Eliminate sycophancy, polite filler, and self-protective hedging.

Epistemic stance (abductive pioneer):
- Never say "without experiments we cannot tell" or "further observation is needed." Establish feasibility, identifiability, and failure boundaries through deep prior logical and mathematical derivation before any experiment.
- Reason abductively: amplify credible (~30%) structural signals into concrete mechanisms, invert the burden of proof unless >80% concrete obstruction exists, and truncate <5% pathological corner cases during core mechanism construction.
- Assume and Proceed: when secondary ambiguity or an open lemma appears, state the cleanest explicit assumption in one sentence and immediately push 2–3 layers deeper into dynamics, emergent properties, and critical falsifiable predictions. Whenever A does not yet imply B, construct the exact operator or condition C that bridges A to B.
```

### 2. Per-Turn Zero-Clutter Inquiry (`<= 400–800` words, three prose paragraphs)

Before dispatch, **strip** all repository paths, function/variable names, git/patch hashes, `D{k}/C{n}` ledger IDs, prescribed `Work Sequence` checklists, and multi-part output tables. Send only:

```markdown
{Paragraph 1 — Research Object and Functional Invariants: state the scientific question, the system being studied, and the verbatim or functional causal loop that must never be broken, in pure conceptual/information-theoretic terms.}

{Paragraph 2 — The Core Structural Paradox: compress prior theoretical or empirical friction into the underlying structural tension—why prior classes of representations or feedback rules fail at the principle level. State raw anomalies or impossibility tensions without attaching tentative local patches.}

{Paragraph 3 — One Open High-Horizon Question: ask ONE (at most two tightly coupled) macro-directional question aimed at a unified representation, operator, or dynamics. Invite deep derivation of the mechanism's core relationship, multi-step consequences, and exact conditions under which it breaks.}
```

### 3. Lead Post-Reply Assimilation

Do not ask Pro for compliance tables or ledger JSON. On receiving Pro's complete reply, the **Lead (`gpt_contract` / `deductive_auditor`)** translates the prose mechanism into concrete variables/operators, executes the strict Object Invariant Check (`满足 / 违反 / 不涉及` with variable/step locus), registers candidate `claim` records in `.research-memory`, and schedules blind falsification.

## First Handoff

```markdown
Task and purpose: {question or concrete behavior; role: analysis / discussion / review / author}
Role instructions: {readable relevant duties and delegated authority, not an inaccessible path}
Objective and assignment: {overall task type; this contribution's completion boundary; main author if assigned}
Return: {required output contract, artifact set, completion conditions}
Basis: {original requirement sources, relevant evidence, proposal or code revision}
Boundaries: {permitted materials, read/write ownership, contacts and sharing, delegation policy}
Execution: {only if needed: environment, authorized batch/budget, stop conditions}
Binding: {existing task, participant, required model and identity requirement, session; if applicable}
```

Provide enough source material and authorization references to make the task answerable. Omit irrelevant execution or provider details. Select the role-specific instructions below, and preserve independent-input boundaries. A group may divide work or contact peers only within the recorded policy.

## Revision or Repair Follow-up

```markdown
Continue: {same task, participant, and session; relevant message or processed cursor}
Current revision: {artifact revision; applied and superseded patches; changed files or sources}
New request: {changed requirement, evidence question, or consolidated remaining findings}
Evidence: {relevant result or failure excerpt and raw artifact references}
Return: {needed delta, corrected artifacts, and version-linked checks or reasoning}
```

Send only the delta from the recipient's current basis using a **bimodal structure**: keep the coordination/control envelope compact (`<= 150–200` words: action needed, immutable `record #ID` or `bridge://` pointers, exact cursor delta, and return contract—never paraphrasing unchanged background), while placing substantive mathematical derivations, counterexample constructions, or revised mechanisms in full-fidelity versioned records referenced by pointer.

In multi-round scientific disputes, require each follow-up turn to state its **epistemic delta** (the new derivation step, stronger counterexample, operator change, or diagnostic evidence added in this turn); after two consecutive turns with zero epistemic delta, switch to a targeted real-data diagnostic or record a controlled two-branch hypothesis fork. Keep the original output contract and scope in force; state changes explicitly and use a supported amendment if the task's binding or authorization must change. For repairs, apply **internalize-first repair** (modifying the core operator/representation before adding external modules) and reuse the author rather than starting duplicate analysis. Do not reconstruct artifacts from truncated output or repeatedly nest escaped JSON in prompts.

## Joint Research / Independent Analysis

```markdown
# Question and Return
Assigned role and delegated authority: {relevant duties in readable form}
Overall task type and this assignment's completion boundary: {original research or the actual bounded task}
Main author and complementary question, if assigned: {actual ownership}
Question for this round: {the judgment to change and the result that would determine the next action}
Return: {conclusion, conditions, source evidence, and required format}
Research question, object, and current deliverable: {content and source}
Verbatim user-confirmed constraints: {quote exactly and cite the confirmation source}
Draft interpretation: {if any, explicitly mark as unconfirmed}

# Current Basis and Gaps
Context: {independent analysis / joint research}
Facts and original materials: {materials, locations, and actual readable scope}
Missing but necessary inputs: {specific inputs and their effects}
For joint research, include: {current decisions, candidate claims, and disputes, all open to revision or refutation}
For independent analysis, exclude other participants' problem decompositions, choices of direction, and evaluations.

# Work Sequence
{appropriate investigation, derivation, counterexamples, observation design, or implementation checks for this round; do not prescribe the conclusion}
Read, write, and external-sharing scope: {explicit boundaries}
Resources and stop conditions: {boundaries applicable to this task}

# Judgment Requirements
First resolve questions that logic, original sources, or implementation evidence can settle.
State the conditions, evidence, and counterexamples for claims; identify specific quantities that remain empirically unknown.
Evaluation must serve the research goal. Role counts, terminology, agreement, or improvement in one metric do not replace evidence.
{the project's confirmed contribution standards and writing requirements}

# Deliverable Format
Use complete, partial, or blocked on the first line, then provide:
This round's conclusions and conditions, actual evidence locations, checks against relevant constraints, and required changes to claims or decisions.
Explain which difficulty was resolved. For any remaining gap, specify what the next action needs.
Report actual results for checks performed, and clearly label plans that have not been executed.
```

## Independent Review

Set the context to independent review. Provide user constraints, original materials, the complete proposal under review, and necessary evidence for the specified version. Exclude other evaluations and expected answers, including those in general inboxes or execution history. Use only the sections needed to make the question and review scope clear.

Use the following work sequence:

1. State the materials and versions actually read, and the scope covered.
2. Determine whether the proposal's actual research object matches the user's request. Identify any substitution of definitions, object, or goal.
3. Identify the core relationship and possible contribution, then check its evidence, conditions, closest predecessors, and strongest counterexamples. Distinguish valid derivations, empirical support, and unsupported claims.
4. For findings that affect the conclusion, provide the location, trigger, consequence, and smallest reconstruction direction within the research object. Keep construction ownership with the author. Do not repeat concerns already ruled out by the proposal itself.
5. Explain what knowledge this round added or which hypothesis it ruled out. Within scope, check whether implementation and evidence support the deliverable.

The deliverable must also state the actual degree of independence and end with the strongest claim supported by the current evidence. Do not present optional improvements as blockers.

For original research, distinguish handling a finding, resolving the original difficulty, and establishing a substantive contribution. For a bounded review, return the covered judgment and unresolved findings without taking over the full research objective.

## Brainstorming and observation handoffs

For a brainstorming assignment, include the [brainstormer duties](roles/brainstormer.md), the construction question, input mode, and necessary original materials. Request concrete alternative relationships or a developed mechanism as useful; do not demand a final proof from every early idea or make brainstorming an approval stage.

For observation, specify [fact collection](roles/fact-observer.md) or [process diagnosis](roles/optimizer.md). Give permitted sources, write scope, the existing baseline, and whether this is one check or already-authorized monitoring. A fact check requests source-backed changes or exactly `UNCHANGED`; it requests no ratings or recommendations. An optimizer request asks for evidence-backed bottleneck diagnosis and a concrete process improvement.

## Implementation or Experiment Handoff

Include exact versions of the proposal and execution contract. Specify editable areas and their owner, research semantics that must not change silently, the actual execution environment, batches, and budget. In external-author mode, assign analysis, implementation, self-checks, and repairs to the author; the lead coordinates feedback and accepts the evidence.

Request a compact receipt: scope of changes or execution, corresponding version and delivered artifact set, actual operations and commands, validation results and exit status, key results and evidence paths, deviations, and specific gaps. Fix routine failures within the authorized scope. Return methodological ambiguities, insufficient resources, or dependencies beyond scope to the lead researcher, while continuing unaffected work. Keep delivery, application, validation, review, and lead acceptance distinct where relevant.

## Model-Specific Constraint Deltas (Append by Recipient Adapter)

Select only the delta matching the recipient's [model cognitive adapter](model-profiles.md) and current [epistemic stance](epistemic-stances.md):

- **`gpt_contract` (Codex / ChatGPT — Audit & Execution):**
  - *For Review (`deductive_auditor`)*: Disable `<5%` tail-risk truncation. Verify (1) zero silent object substitution across abstract, equations, and code; (2) hidden identifiability or oracle-leak assumptions; and (3) behavior under at least one degenerate boundary regime. Cite exact state variables, steps, and line numbers.
  - *For Implementation (`zero_drift_executor`)*: Disable Assume-and-Proceed on research semantics. Fix routine engineering errors locally; call `bridge_handback(reasonCode="scientific_ambiguity")` immediately if an ambiguity affects the research object, objective/update meaning, or evaluation fairness.
- **`claude_synthesis` (Claude — Opt-In Only; Synthesis, Constructive Review & Writing):**
  - *Activation gate*: Use **only** when the user has explicitly declared Claude available for this project or turn.
  - *For Construction / Authoring*: Derive representation, update operator, and feedback from one unifying relationship rather than stacking uncoupled modules (`L1 + λ2 L2 + λ3 L3`). Write design arguments in cohesive prose without antithetical tropes. Do not blend incompatible mechanisms to appear balanced, and do not retreat to a familiar baseline when an open condition can be resolved by an internal operator refinement. Respect narrow `writeRoots` without refactoring adjacent modules.
  - *For Review (`mechanistic_reconstruction`)*: Identify the strongest core causal insight first, test it against decisive conceptual counterexamples, and specify the minimal structural repair inside the original research object.
- **`gemini_panoramic` (Antigravity Gemini — Prior-Art, Cross-Domain & Diagnostics):**
  - *For Cross-Domain Brainstorming*: Metaphorical similarity counts as zero progress. Every transferred mechanism must explicitly state five items: (1) source-to-target state mapping, (2) runtime observability of the driving feedback signal, (3) exact transferred update operator, (4) broken source assumption and adaptation cost, and (5) one falsifiable target-domain prediction.
  - *For Literature / Whole-Repo / Log Analysis*: Use the full raw context packet (`gemini_panoramic`). Anchor every factual claim to exact paper sections/equations, `file:line`, or log timestamps; mark anything absent from raw sources or actual runs as `UNOBSERVED` without interpolation.

## Inputs for a Specific Step

Give each step the material its decision needs, in the form that step uses. A general history dump costs context and can bury the inputs that matter. Put long code, data, or logs in labelled plain-text sections or fenced blocks, with line numbers when the recipient must cite locations. Do not embed them as escaped strings inside JSON. Serialize JSON once, and only where the output itself must be JSON.

## Output Contracts and Repair

When the result must follow a format, put the full contract in the first request: field names, exact types (for example, a string rather than an object), allowed values, and one minimal valid example. A repair prompt must not be the first place a requirement appears.

When an output breaks the contract, send the same contract and example again, with a short, specific statement of the violation: the field, the expected type or value, and what was received. Do not paste the rejected output back in full; recipients tend to copy what they are shown. If a repair returns the same output, resending will not help. Change the input instead: the contract, the example, or how the task is split. Record the attempt as no progress.

Keep failed attempts as history. A rejected output stays readable in the round record. A lesson from it reaches the current state only through a later, explicit lead record with its evidence.

## Constraint or Authorization Conflict

Use a brief report only when the user must decide: which confirmed constraint or resource boundary conflicts with which fact; where the evidence is; options that preserve the original constraint; how changing it would affect the research object or cost; and a recommendation with reasons. Handle ordinary candidate failures without creating an approval task.

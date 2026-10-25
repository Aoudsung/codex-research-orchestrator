# Handoff-Ready Work Instructions

Use the sections relevant to the recipient's role and question. Put the question and output contract first; do not force a full research prompt into a small revision request. Replace braces and expand references the recipient cannot access. If the project has fixed wording required by the user, reproduce it verbatim; do not carry those personal requirements into other projects.

## First Handoff

```markdown
Task and purpose: {question or concrete behavior; role: analysis / discussion / review / author}
Return: {required output contract, artifact set, completion conditions}
Basis: {original requirement sources, relevant evidence, proposal or code revision}
Boundaries: {permitted materials, read/write ownership, contacts and sharing, delegation policy}
Execution: {only if needed: environment, authorized batch/budget, stop conditions}
Binding: {existing task, participant, required model and identity requirement, session; if applicable}
```

Provide enough source material to make the task answerable. Include actual authorization sources where needed; a filled template does not create permission. Omit irrelevant execution or provider details. Select the role-specific instructions below, and preserve independent-input boundaries. A group may divide work or contact peers only within the recorded policy.

## Revision or Repair Follow-up

```markdown
Continue: {same task, participant, and session; relevant message or processed cursor}
Current revision: {artifact revision; applied and superseded patches; changed files or sources}
New request: {changed requirement, evidence question, or consolidated remaining findings}
Evidence: {relevant result or failure excerpt and raw artifact references}
Return: {needed delta, corrected artifacts, and version-linked checks or reasoning}
```

Send only the delta from the recipient's current basis. Keep the original output contract and scope in force; state changes explicitly and use a supported amendment if the task's binding or authorization must change. For repairs, reuse the author rather than starting duplicate analysis. Use compact receipts first and fetch full patches, logs, or sources only when needed. Do not reconstruct artifacts from truncated output or repeatedly nest escaped JSON in prompts.

## Joint Research / Independent Analysis

```markdown
# Question and Return
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
{the project's confirmed contribution standards and writing requirements; do not add any without authorization}

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
3. Check the evidence, conditions, and strongest counterexamples for key claims. Distinguish valid derivations, empirical support, and unsupported claims.
4. For findings that affect the conclusion, provide the location, trigger, consequence, and smallest correction. Do not repeat concerns already ruled out by the proposal itself.
5. Explain what knowledge this round added or which hypothesis it ruled out. Within scope, check whether implementation and evidence support the deliverable.

The deliverable must also state the actual degree of independence and end with the strongest claim supported by the current evidence. Do not present optional improvements as blockers.

## Implementation or Experiment Handoff

Include exact versions of the proposal and execution contract. Specify editable areas and their owner, research semantics that must not change silently, the actual execution environment, batches, and budget. In external-author mode, assign analysis, implementation, self-checks, and repairs to the author; the lead coordinates feedback and accepts the evidence.

Request a compact receipt: scope of changes or execution, corresponding version and delivered artifact set, actual operations and commands, validation results and exit status, key results and evidence paths, deviations, and specific gaps. Fix routine failures within the authorized scope. Return methodological ambiguities, insufficient resources, or dependencies beyond scope to the lead researcher, while continuing unaffected work. Keep delivery, application, validation, review, and lead acceptance distinct where relevant; process success alone does not complete delivery.

## Inputs for a Specific Step

Give each step the material its decision needs, in the form that step uses. A general history dump costs context and can bury the inputs that matter. Put long code, data, or logs in labelled plain-text sections or fenced blocks, with line numbers when the recipient must cite locations. Do not embed them as escaped strings inside JSON. Serialize JSON once, and only where the output itself must be JSON.

## Output Contracts and Repair

When the result must follow a format, put the full contract in the first request: field names, exact types (for example, a string rather than an object), allowed values, and one minimal valid example. A repair prompt must not be the first place a requirement appears.

When an output breaks the contract, send the same contract and example again, with a short, specific statement of the violation: the field, the expected type or value, and what was received. Do not paste the rejected output back in full; recipients tend to copy what they are shown. If a repair returns the same output, resending will not help. Change the input instead: the contract, the example, or how the task is split. Record the attempt as no progress.

Keep failed attempts as history. A rejected output stays readable in the round record. A lesson from it reaches the current state only through a later, explicit lead record with its evidence.

## Constraint or Authorization Conflict

Use a brief report only when the user must decide: which confirmed constraint or resource boundary conflicts with which fact; where the evidence is; options that preserve the original constraint; how changing it would affect the research object or cost; and a recommendation with reasons. Handle ordinary candidate failures without creating an approval task.

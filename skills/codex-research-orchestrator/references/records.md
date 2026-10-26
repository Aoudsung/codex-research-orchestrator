# Persistent Records and Resumption

Read this file when creating records or submitting work with substantive results. Reuse an existing project format first. The fields below are a minimum guide, not a requirement to fill every table for a simple task.

## Keep Information in Its Proper Place

- `charter.md` holds the question, authoritative verbatim user constraints, and their confirmation status.
- `project.md` holds participants, tools, execution environments, authorizations, and resource bindings.
- Keep the overall task type, current assignment's completion boundary, assigned main author, and optional observation roles in those existing records. Add detail only when it changes the work; no new ledger is needed.
- `state.md` holds current judgments, revisable decisions, candidate claims, unresolved issues, and next actions.
- `rounds/RNN/` holds actual prompts, attachment lists, complete replies, and the round's assessment.
- `implementation/` or the existing execution directory holds implementations, experimental protocols, run results, and acceptance evidence.
- `worklog.jsonl` optionally indexes work that has produced results; it does not replace original materials.

An optional bridge stores execution bindings, message cursors, permission leases, deliveries, and validation status. Reference that execution state from research records instead of copying the whole inbox or patch history. Research meaning and acceptance remain in the lead's source-backed records.

Create directories as needed. Keep research files separate from the general skill; starting a study does not change skill source files. Preserve historical prompts, original replies, and acceptance records as they were. Add corrections as new records that reference the old ones.

## Update State as a Whole

Build the complete new version of a state file, check it as a whole, then replace the old file in one step: write a new file and rename it over the old one. Check required fields, size limits on the complete result, and that references resolve. Checking each patch is not enough, because the result can still break a limit. Do not apply a list of field edits that can stop halfway and leave a mix of old and new values.

If the check fails, the previous version stays in force. Record the failed update and its reason as history. Failed attempts and rejected outputs remain readable in `rounds/`. A lesson drawn from a failure changes claims or decisions only through a later, explicit lead record that cites its evidence; reflections are not promoted automatically.

## Round Record

```markdown
# RNN: Question for This Round

- Goal: Which judgment should change, and why it affects the current research goal.
- Inputs: Sources of user constraints, proposal version, original materials, and readable scope.
- Actions: Methods and tools actually used; locations of prompts, attachments, and verbatim replies.
- Independence: Independent analysis / independent review / joint discussion / self-check; actual isolation achieved.
- Results: Distinguish facts, derivations, conditional conclusions, and unknowns.
- Evidence: Sources, derivations, code locations, or actual execution results; state which step each supports.
- Constraint checks: Constraints relevant to this round and specific evidence.
- Feedback handling: Finding → accepted / rebutted / unresolved → reasoning and evidence of handling.
- Changes to claims and decisions: Previous judgment → new judgment, with conditions and criteria for refutation.
- Review coverage: Proposal version, claims, and actual conditions; location of reusable review records.
- Progress: Findings handled, original difficulties resolved, contributions established, or knowledge added; distinguish these judgments and cite their evidence.
- Next action: Action, required result, and branches in the judgment.
```

## Execution Receipt

```markdown
complete / partial / blocked (choose the actual status)

Deliverables and corresponding version:
Behavior changes or scope of this execution:
Environment, data, and parameters that affect the conclusion:
Actual commands or operations:
Return code or execution status:
Key values, units, and evidence locations:
Deviations from the proposal, checks not run, or specific blockers:
```

If no code version exists, use an explicit proposal version and material locations; additional file hashes are not required. A `complete` receipt means only that the assigned work is complete, not that the research claim holds.

For artifact-based work, include the delivery revision, declared artifact list and final receipt, applied or superseded patch IDs, and relevant validation/review coverage when they affect the next action. Point to raw artifacts rather than pasting full logs. An inbox message, a quiet settling window, or return code zero does not establish that every declared artifact arrived. Label an incomplete set partial.

Record only relevant distinctions: received, delivered, applied, validated, reviewed, and accepted have different evidence. They are not mandatory stages for all work. Lead acceptance names its scope, artifact revision, key evidence, and actual open findings; implementation acceptance alone does not confirm research benefit.

## Work Index

Enable JSONL when needed for collaboration across rounds, incremental observation, or resumption across conversations. The lead researcher appends entries serially after saving results; participants submit receipts only. Use separate sequences for work IDs and discussion rounds. A “handed off” field does not authorize messaging.

One fictional entry:

```json
{"id":"W0001","round":"R01","kind":"analysis","actor":"lead","status":"complete","question":"Does the necessary condition hold?","result":"A counterexample rules out the unconditional claim; the candidate remains under restricted conditions.","evidence":["rounds/R01/record.md"],"next":"Derive the revised conditions."}
```

If resources were consumed, add actual units and supporting evidence. Do not record unknown use as zero. Add correction entries that identify the corrected ID rather than rewriting history. Do not run extra experiments for bookkeeping or log every tool call.

Each entry records what changed, with pointers to evidence. Do not copy the full state, or the full list of materials available at that point, into every entry. Repeated whole copies make the index grow with the square of the history.

An accepted review finding is not evidence that the original problem is solved. If a repair only adds a restriction, keep the broader difficulty open. An original contribution requires its own mechanism difference and supporting result; neither a corrected local statement nor a finished handoff establishes it automatically. Preserve useful negative results and local corrections as knowledge without relabeling them as the requested innovation.

Observation records stay in their designated area. The fact observer maintains only its authorized baseline and events; the optimizer records interpretations and proposals. Their outputs do not directly rewrite research state or acceptance decisions.

## Resumption Checkpoint

For growing histories, use [research memory](memory.md) to index source-backed records and their dependencies. Search summaries first, then read selected full sources. Update the underlying records before indexing them; the database does not become the authority for user constraints. Keep old versions and explicitly record supersession, withdrawal, and conclusions that need review.

Record the location and necessary verbatim text of current authoritative constraints, draft status, current design and claims, key evidence, pending feedback, authorization and budget, pause status, active conversation or job IDs, and the next action.

For ongoing bridge work, optionally reference the task, participant, required model and available identity evidence, execution session, current delivery revision, processed cursor, applied patch IDs, and next owner/action. Preserve an optional read-set only for unchanged source versions or ranges. Record notification capability and evidence separately: message receipt, host acceptance, and actual processing by the target turn. These references fit the existing checkpoint format; no new memory schema or copied transport history is needed.

For ordinary resumption, use the checkpoint to return to authoritative sources; do not treat a summary as a new constraint. First check active work and collect available results, then decide whether to start the next action. For independent judgment, use an isolated input package instead of reading overall state that contains other evaluations.

The lead may close its current turn after independent actors own pending work and no lead action remains. The checkpoint must preserve final acceptance responsibility and the bound next action; a handoff is not acceptance or proof of a working cross-turn wakeup route.

## User Briefing

Report only which judgments changed in this round, where the evidence is, what was completed, and actual pending decisions. Without new evidence, do not repeat the plan. While waiting, briefly identify the result being awaited. The final deliverable must stand on its own without requiring the user to revisit progress messages.

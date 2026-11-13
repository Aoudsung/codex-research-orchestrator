# Collaboration and Execution

Read this file when arranging collaborators, independent reviews, implementation handoffs, or external communication. Obtain tool names and role bindings from the project configuration and current host. Do not copy another project's conversations or permissions.

Read only the assigned [role entry](../SKILL.md#identify-the-task-and-role). A persistent role is bound by the project's instructions; a temporary contributor receives only the delegated question and permitted operations.

## Assigning Work

The lead researcher retains responsibility for research semantics, material tradeoffs, irreversible actions, and acceptance. Delegate separable source investigation, independent reasoning, and clearly specified implementation to suitable participants. Short diagnosis–edit–verify cycles, and experiments whose next action depends on each result, usually remain with the current owner.

A delegation states the goal, assigned role, necessary context, permitted read and write scope, and conditions for completion. Supply the relevant role instructions in a form the recipient can read, not only an inaccessible path. State the overall research objective separately from this contribution's deliverable. The assignee resolves routine details from interfaces and existing materials. Escalate only issues that would change research semantics, exceed authorization, or leave an expensive experiment unbounded.

Use the narrowest suitable capabilities: source investigation is read-only; a clear local implementation may write to specified areas; core algorithms, measurement definitions, data splits, or inference semantics require an executor with the relevant capabilities.

Only one owner may write to a given file region at a time. The lead researcher maintains overall state and the work index serially; other participants submit their own deliverables and receipts. Reuse the same owner for follow-up work within the same scope. Independent judgment requires context that has not been exposed to existing evaluations. Do not present a temporary agent as a persistent conversation designated by the user, or require every role to be created in every round.

## Reciprocal Collaboration and Groups

When direction is unclear or blocked, ask the research contributors for short independent constructions before comparison. Their core information, representation, operations, or feedback relationships should differ. Once a direction has a supported basis, identify a main author to deepen it and assign complementary sources, counterexamples, or cost questions to others.

An optional [brainstormer](roles/brainstormer.md) can develop alternatives within existing contact authorization. Label shared construction explicitly rather than presenting it as independent assessment.

Roles and group structure are configurable. **Default multi-agent collaboration uses Codex, Antigravity (Gemini), and authorized ChatGPT Pro—never assume or schedule Claude (`claude-code`) unless the user explicitly declares Claude available in the current request, `controls.md`, or `project.md`.** Pair each active participant with its [model cognitive profile](model-profiles.md) and phase-appropriate [epistemic stance](epistemic-stances.md) (`abductive_pioneer`, `deductive_auditor`, or `zero_drift_executor`), and assign complementary questions in parallel when each can make a distinct contribution:

- **Asymmetric Macro-Abduction (`pro_macro`):** When using ChatGPT Pro for problem framing, unified mechanism invention, or bottleneck escape (`>=2` consecutive local patches without simplifying the core relationship), feed it the distilled structural tension (grounded in latest SOTA blind spots and Tier-1 real-baseline anomalies) without local file paths, patch diffs, or `D{k}/C{n}` ledgers. After Pro replies in cohesive prose, the lead (`gpt_contract` / `deductive_auditor`) formalizes variables, executes the strict object-invariant check, and schedules blind verification.
- **Panoramic Breadth + Cohesive Depth (Default `Codex + Antigravity`, Opt-In `Claude`):** Use Antigravity Gemini (`gemini_panoramic`) for latest primary-paper SOTA ceiling checks, Stage-2 de-jargonized operator collision searches, cross-domain structural isomorphisms, and whole-log empirical diagnostics. By default, Codex acts as `Main Author` to derive the unified mechanism and write cohesive prose; when the user explicitly declares Claude available, Claude (`claude_synthesis`) may take over `Main Author` deepening and narrative drafting.
- **Dual-Track Independent Review (`blind_review`):** Under strict blind isolation, run **Isolated Codex** (`formal_falsification`: object-drift check, assumption leaks, degenerate boundary counterexamples, and coupling/deletion razor) alongside **Isolated Antigravity** (`prior_art_isomorphism` & SOTA breakthrough verification). When Claude is explicitly declared available, attach **Isolated Claude** (`mechanistic_reconstruction`: core causal critique and minimal structural repair).

A discussion group may divide its question or develop a separate candidate when the project's delegation policy permits it.

Within explicit authorization, peers may send requests, ask for missing evidence, propose revisions, return results, and coordinate handoffs without making the lead relay each message. Specify who may contact whom, for what purpose, with which materials, and whether further delegation is allowed. Keep write ownership explicit when work moves between participants. The lead retains scientific alignment, resource decisions, and final acceptance.

Direct exchange must preserve independent-input boundaries below. When using the optional bridge's thread subscriptions (`bridge_subscribe_thread`), `direct` or `context` fan-out applies only to authorized joint threads; tasks marked `blind_analysis` or `blind_review` are rejected from cross-thread subscriptions at the engine boundary. When an assignee hits scientific ambiguity, mechanism changes, or permission/budget boundaries outside its mandate, it releases message ownership immediately via `bridge_handback` rather than improvising beyond scope. An independent reviewer must form and save a judgment before receiving other evaluations, even when a peer offers them. Use a joint discussion context for subsequent comparison.

## External-Author Mode

When an external participant owns implementation, delegate the necessary code analysis, implementation, self-checks, and repairs together. Codex supplies the question, agreed semantics, scope, and acceptance conditions; combines relevant feedback; and checks the delivered changes and version-linked evidence. Do not duplicate the author's full analysis or rerun covered checks without a specific gap or contradiction.

Send one consolidated repair request to the same task and author, with the affected revision, remaining findings, and relevant failure evidence. The author resolves routine failures within scope. Return methodological ambiguity, exceeded resources, or changed permissions to the lead. Self-checks remain distinct from independent review.

## Independent Judgment

There are three material-sharing contexts:

| Context | Materials that may be provided initially | Withhold until an independent judgment is formed |
|---|---|---|
| Independent problem analysis | Verbatim user-confirmed constraints, original sources, necessary facts | Other participants' problem decompositions, choices among candidates, and evaluations |
| Independent proposal review | The above, the complete proposal under review, and necessary evidence for its version | Other review conclusions, discussion history, and the expected answer |
| Joint discussion | Current proposal, state, facts, existing disputes, and feedback | Exclude only material outside the authorization for external sharing |

Isolation covers messages, attachments, inherited context, and readable project materials. Where possible, use agents without inherited history or a new isolated context with restricted input materials. If isolation is unavailable, label the work a joint check or self-check and continue permitted work. If the user requires independent review for completion, that requirement remains unmet.

Form and save independent opinions before sharing and comparing them. Agreement is not a substitute for evidence.

### Progressive Multi-Round Dialogue and Controlled Hypothesis Forking

Serious scientific disagreements rarely resolve in a single exchange because Round 1 often exposes unstated conditioning or notation differences before the deeper structural trade-off surfaces. Do not impose an artificial one-round cutoff, and do not allow repetitive verbal loops:

1. **Round 1 (alignment and peeling):** Allow the author and reviewer/peer to align definitions, unpack implicit operator conditions, eliminate surface misunderstandings, and isolate the genuine structural tension.
2. **Rounds 2..K (epistemic-delta gate):** Continue multi-round discussion freely **while each turn produces a verifiable epistemic shift**—a new intermediate derivation or bound that moves the dispute locus deeper, a sharper counterexample that bypasses the previous defense, a concrete modification to the operator's dynamics, or new primary-source / real-trajectory diagnostic evidence.
3. **Two-turn zero-delta fuse:** Intervene only when **two consecutive turns** repeat prior assertions or subjective importance claims without introducing new math, counterexamples, or data:
   - *If locally testable*: run a targeted Tier-1 diagnostic measurement on real baseline data/logs to settle the disputed quantity.
   - *If scale-dependent or deeply coupled*: **do not force premature consensus or kill a viable candidate on intuition.** Record a **Controlled Hypothesis Fork** (keeping two bounded candidate branches alive with the explicit discriminative metric that will separate them at real evaluation scale), or distill the deadlock into a macro-paradox for ChatGPT Pro (`pro_macro`).

## Bimodal Low-Entropy Communication

Minimize token cost, latency, and semantic drift by separating the **thin control plane** from the **full-fidelity artifact plane**:

- **Thin control plane (`<= 150–200` words, zero prose relay):** Never paraphrase or re-summarize another agent's proof, proposal, code, or logs inside coordination messages. Routing, follow-ups, and execution handoffs carry only: (1) the single question or action needed, (2) immutable primary pointers (`record #ID`, `bridge://message/<id>`, `bridge://patch/<id>`, or `file:line` + `sha256`), (3) the exact delta since the recipient's last cursor, and (4) the return contract.
- **Full-fidelity reasoning plane (never telegram-truncated):** Write substantive derivations, counterexample proofs, and multi-round critiques **once in full mathematical and logical completeness** as versioned records or files, and share them by pointer so collaborators read exact arguments without lossy compression.
- **One-line negative tombstones:** Record ruled-out mechanisms as compact one-line tombstones (`<= 40` words + evidence pointer) in shared state so peers never re-propose dead routes under new names.
- **Local-first dispatch threshold:** Do not spend an external collaboration turn on a question that the current owner can settle within minutes via direct derivation, primary-source check, or a quick local diagnostic script.

## When to Review and How to Handle Findings

Arrange review according to risk when a material mechanism takes shape, a key conclusion is substantively disputed, or work approaches finalization or expensive execution. Cover key claims and the actual conditions. One review may cover several of these points; reuse coverage for unchanged versions and issues. Do not add approval gates for low-risk document corrections, routine troubleshooting, or validation already completed.

A reviewer first identifies the core relationship worth testing, then checks its conditions and closest predecessors. A finding must identify its location, trigger or counterexample, effect on the conclusion, and the smallest necessary reconstruction within the research object. A justified rejection with a concrete counterexample or failing condition is valid. Distinguish issues that block a conclusion from optional suggestions. Do not expand the acceptance scope.

The lead researcher records each finding as accepted, rebutted, or unresolved, with evidence. Distinguish handling the finding, resolving the original difficulty, and establishing a contribution. A restriction may repair a conditional statement while leaving the original objective open. Recheck only the behavior affected by changes.

## Implementation and Acceptance

Hand off implementation or execution only when existing authorization covers it. Include at least:

- The current proposal and contract locations, and research semantics that must be preserved.
- Ownership of code, data, or instrument operations, and the execution environment.
- Authorized batches, resources, duration, cost limits, and stop conditions.
- Expected deliverables, relevant validation, and where result evidence will be stored.

The implementer returns the corresponding version, actual commands or operations, environment and material conditions, exit status, key results, and deviations. State honestly what was not run. Return methodological ambiguities to the lead researcher; resolve routine engineering failures within the authorized scope.

The lead researcher accepts work based on actual changes and key evidence tied to the final version. Do not rerun checks when evidence is sufficient and behavior has not changed. Add only relevant checks when evidence is missing, contradictory, or cannot be tied to the version. Explicitly report changes to data handling and evaluation definitions. Do not change research conclusions under the label of an engineering fix.

## External Collaboration and Messages

Use host-provided connectors or collaboration tools first. Use another available, authorized channel only when those capabilities are insufficient. Record user-designated collaborators, material boundaries, and authorization for ongoing handoffs in the project configuration, then continue within that scope.

Send only the material needed to answer the current question. Exclude identifying information, credentials, unrelated data, and unauthorized original materials from prompts and attachments. Use the [prompt templates](prompts.md) to expand necessary requirements into text the recipient can read. Avoid providing only inaccessible local paths.

Session reuse, complete-reply collection, delivery waiting, timeout reconciliation, and notification checks are maintained in [external collaboration operations](mcp-collaboration.md). Role pages use that guide rather than defining their own timing rules. Keep operating settings in project configuration. If no external channel is available, complete permitted local analysis and identify which external opinions have not been obtained.

## Pausing and Resuming

Save active conversation or job IDs, completed scope, pending results, and the next action. Apply a pause to its stated scope; do not restart the same work elsewhere. On resumption, first check whether the original task has finished or is still running, then continue to avoid duplicate execution and spending.

When independent actors own pending work and no lead action remains, the lead can end its turn with a checkpoint. Retain acceptance responsibility and resume the bound task on a supported return event. Do not keep the lead turn open solely to supervise an independent actor.

# Collaboration workflow verification

Version 1.5.0 adds project-scoped Boost, Swarm and Teamwork entry points. All three use the same versioned task, session binding and evidence-receipt mechanisms. The public MCP tools, the Workbench and the host-bound CLI open the same project state.

## Combined research request

The test request used the Antigravity Teamwork chip, requested a very large team and asked for Boost on every project assignment. It asked about multiple model sizes across TextCrafter, ALFWorld and WebShop and required fair comparisons. The compiler accepts plain slash text, the rendered chip, its escaped text form and the corresponding skill invocation. It preserves the original request. The team size and nested Boost instructions apply to the general research route.

In one repeatable stdio exercise, a two-milestone plan produced 31 logical roles, including the Lead, and 15 candidate/challenger pairs. A wave limit of two allowed the team to begin with the remaining sessions unbound. The fixture restarted the Lead connection, submitted a counterexample, issued a revised receipt and rechecked it. It accepted six planned cells. Giving the baseline a larger interaction budget, claiming universal scope, or attempting final acceptance while work was queued failed. The workers in this exercise were controlled MCP clients. [Public recipe tests](../runtimes/agent-bridge/test/test-collaboration-entry.mjs) · [Comparison evidence tests](../runtimes/agent-bridge/test/test-comparison-evidence.mjs)

A separate Codex Lead received the original prompt and the installed skills without a prewritten graph. It produced five milestones, 53 roles including the Lead, 26 Boost pairs and nine proposed comparison cells. Its third size, 3B, was an exploratory design choice. Two additional Codex sessions claimed the initial author and challenger assignments through the project-local MCP using their own host identities. The challenger found a concrete error in the author's handoff assessment. Completion of the contract draft alone did not release the downstream branches. A separate audit and its Boost receipt were also required. The same author submitted revision two. The challenger reproduced the release conditions against the current graph and its versioned retest receipt advanced the run. These three live roles exercised the first handoff. No benchmark scores were produced.

A fresh MCP connection confirmed partial closure at run version 8. All nine planned cells remained open for final comparison evidence. The original five-milestone specification was preserved through the repair. During this exercise the author had already ended its native turn. The Lead resumed that same member to handle the revision. The release exposes exact-session wakeup as an opt-in and reports `resume_bound_workers` with the target step and version when the host must resume a member. The board test checks the distinction between a queued wakeup, host acceptance and consumption by the intended session.

For a best-known performance claim, the real author also identified a limitation of an otherwise matched protocol. Beating one reproducible proxy baseline supports the comparison against that baseline. A claim about the competitive field requires a record of eligible competitors, their versions and any missing comparisons. The Teamwork research guidance now calls for that record. [Research execution and acceptance](../skills/teamwork/references/execution-paths.md)

## Reproduction

Use a temporary project with Node 24 or later and Python 3.11 or later. The runtime tests exercise public tools with isolated SQLite files. The Workbench integration tests need a loopback listener.

The release check on this Mac passed 81 Node tests, 81 project Python tests and six runtime Python tests. The four discoverable workflow skills and the companion research-dialogue skill passed frontmatter validation.

```sh
node --test runtimes/agent-bridge/test/*.mjs
python3 -m unittest discover -s tests
python3 -m unittest discover -s runtimes/agent-bridge/test -p 'test_*.py'
```

The Workbench browser check submitted a Teamwork chip through New Task, then inspected the durable intake, team size and nested Boost requirement. The host-bound CLI check used two real Codex sessions. One opened the task and bound the second. The worker read its assigned brief and submitted a receipt. Reading another member's brief was denied. Resuming twice returned the same next step. [Workbench integration tests](../runtimes/agent-bridge/test/test-workbench-collaboration.mjs) · [Board and session integration tests](../runtimes/agent-bridge/test/test-work-board.mjs)

An installation exercise upgraded a copy of the 1.4.3 archive, preserved project state and unrelated skills, repaired a missing companion through the installed helper and copied the suite into a second project. Real model quality, provider billing and application-specific training performance require separate evaluation.

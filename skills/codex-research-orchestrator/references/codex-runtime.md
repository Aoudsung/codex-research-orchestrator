# Codex Integration

Read this file when first using the skill or switching clients. It maps research responsibilities to Codex capabilities without requiring an additional agent framework.

## Entry Point and Project

Start through `$codex-research-orchestrator` or the skill picker. Follow the current `AGENTS.md`, tool instructions, and actual permissions; this skill cannot extend them. Reuse the workspace and existing research entry points. Store research state in the project directory; the installed skill directory holds only general rules.

Discover existing tools and project configuration first, then read only enough material to determine the next action. Use file search to locate original sources, and filter large logs before reading them. Available file access, network access, and execution depend on the capabilities exposed in the current Codex session.

## Capability Mapping

| Research need | Approach in Codex | If the capability is unavailable |
|---|---|---|
| Lead research and orchestration | The current conversation owns goals, semantics, scheduling, and acceptance | Continue with one agent |
| Parallel investigation and independent reasoning | Use available subagent tools; for independent work, avoid inheriting evaluations and restrict the input materials | Perform the necessary analysis yourself and label it a self-check; any independent-review requirement remains unmet |
| Persistent collaborators | When authorized by the user, use tools for reading, messaging, and waiting on conversations; reuse project bindings | Produce a complete handoff package without claiming it was sent |
| Code changes and validation | Use workspace file tools, a terminal, relevant tests, and the environment actually authorized | Deliver the design or code and identify validation that has not run |
| Long experiments | Retain job or terminal session IDs, use completion notifications or wait interfaces, and read key output | Save resumption steps and avoid starting duplicate runs |
| External research collaboration | Prefer connectors or MCP; use a browser when needed and available | Continue independent local work and identify the missing external input |
| Reciprocal agent work | Discover the optional bridge adapters or native messaging tools, then exchange scoped requests, evidence, revisions, and results | Retain explicit handoff artifacts and identify which exchanges were not sent |
| Work across sessions | Use the automation features currently provided by Codex when the user requests them | Leave a checkpoint without promising background progress |

Tool names vary across clients. Discover the current tools and follow their instructions. Do not guess interfaces from this document or bypass missing capabilities through private databases or credential access.

## Optional Agent Bridge

The repository's `runtimes/agent-bridge` is an opt-in runtime with Codex, Claude Code, and Antigravity adapters. It is separate from skill installation. Provider execution needs its own configured backend and permissions; do not require every adapter, register them automatically, or change account settings to use the native workflow. Read [MCP collaboration](mcp-collaboration.md) for stable task/session/model bindings, preflight, incremental messages, artifact handling, and acceptance evidence. Discover the installed schema before mapping those operations to tools.

Participants can coordinate directly within explicit contact and sharing authorization. Provider names do not fix roles: Codex may coordinate an external author or contribute to another authorized participant's question. Keep one writer per area and a named lead for final acceptance. Temporary subagent tools and persistent provider sessions remain distinct capabilities.

## Subagents

Prefer roles and actual model configurations already available in the environment. Investigation, implementation, and review can usually map to a read-only explorer, an executor with write access, and an independent reviewer; role names may vary. Do not automatically overwrite the user's `.codex` configuration, install model services, or grant additional permissions.

Each delegation must provide the necessary context and clear boundaries. Independent reviews should avoid inheriting evaluations from the parent conversation. Disable history inheritance when the tool supports it. If prompt restrictions alone cannot isolate context, describe the actual degree of independence. Route subagent receipts to the lead researcher for consolidation, so multiple agents do not edit the overall state at once.

When the user has bound persistent conversations to the project, temporary subagents handle only their authorized, separate subtasks. Creating a new user-visible conversation, messaging another conversation, and using an external service must each follow the authorization requirements of the relevant tool.

## Local Memory Tool

For sustained research, Codex can invoke the bundled `scripts/research_memory.py` through its terminal in the authorized environment. It uses Python's standard library and SQLite FTS5, with no additional model service. Read [memory and task context](memory.md) before initializing a project or assembling an independent-review packet. If the environment cannot run the helper, retain explicit file-based records and report that indexed retrieval and checked context assembly were not performed.

## Automation Boundaries

Distinguish progress within the current turn from scheduling work across sessions. Codex can continue the former within the task's scope; the latter requires a user request and host scheduling support. Record pauses, budgets, and restrictions on external sharing in resumable records, rather than relying on vague promises in conversation context.

An integrated delivery wait keeps dispatch and waiting in the current operation; it does not establish later host wakeup. Cross-turn continuation requires a configured receiver, host acceptance, and evidence that the intended target turn processed the event. Use events on capable channels. For a channel without push, use only its authorized scoped schedule. A successful CLI or inbox write is not proof of a resumed chat. If independent actors own all pending work, the lead may end its turn while retaining the checkpoint and acceptance responsibility.

This skill provides agent working rules and inspectable records. It is not an operating-system sandbox or an enforced budget accounting service. Codex and the execution environment control actual permissions.

## Official Interface References

See [Build skills](https://learn.chatgpt.com/docs/build-skills) for installation and skill discovery, and [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) for subagents and custom roles. Client capabilities depend on the runtime. This is an independent community project, unaffiliated with and not endorsed by OpenAI.

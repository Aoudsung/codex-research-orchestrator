# Collaboration workbench

The workbench shows the research question, recorded collaboration, task state, original messages, and evidence in one local browser application. It also provides explicit task creation, dispatch, messaging, and pause/resume controls. The interface is in English and works without a frontend build or an external asset service.

## Try the demo

From the complete release or repository, with Python 3.11+ and Node.js 24+:

```sh
python3 setup.py workbench --demo --open
```

The demo is visibly labelled. Its tasks, participants, evidence, and operations are fictional and remain in memory. No provider is contacted, and no demonstration data is inserted into your project. Restarting the demo restores its sample dataset.

## Open your project

After installing the complete bundle, run this from the research workspace:

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_setup.py \
  workbench --project . --open
```

The terminal prints a private browser URL. Keep the foreground server running while using the workbench. `--port 0` selects an available port; `--node /path/to/node` selects a Node installation. The standalone skill alone does not include the workbench runtime. A separately managed runtime can run `node src/workbench/server.mjs --project /path/to/project --open` from its own directory.

The server listens on loopback only. The browser URL grants access to that server instance; do not share it or include it in public reports. Opening the application reads the selected project's existing records and databases. It does not create a missing bridge database, start an agent, mark messages as read, or refresh stored memory validity. Explicit actions can create or change bridge state.

## Read the workspace

- **Overview:** the original question, source availability, recent work, and changes worth inspecting.
- **Collaboration map:** participants and recorded message relationships. Select a participant or task to inspect its actual work and handoffs.
- **Tasks:** filter and inspect tasks through a board or list. Open the brief, messages, artifacts, validation records, and continuation details.
- **Evidence:** inspect research-memory records, recorded claim states, source locations, and explicit dependencies. Bridge artifacts and research claims remain distinct.
- **Activity:** follow recorded messages, artifacts, and validation events, then open their original contents.

Lists and source text load in bounded pages. Filters and source views expose the available records without treating omitted content as absent. Missing, unreadable, or unsupported sources stay visible; an unknown count is not displayed as zero. Project documents are shown in their original wording rather than converted into invented scientific conclusions.

The source viewer can load complete task briefs, results, errors, messages, and evidence. Copy and download actions apply only to the text already loaded and label that range. Evidence dependencies open their referenced memory records directly.

## Create, dispatch, and reply

Creating a task records its goal, assignee, model/session requirements, and scope. It does not start a provider. Inspect the returned preflight and use the separate dispatch action when you want execution. Select an explicit model; the workbench does not choose a costly default or silently switch models. A low effort default is available for small jobs. Provider authentication remains with each CLI.

If an existing task has no model binding, use **Create task with a model** to prepare a separate task from its complete brief and recorded scope. Review it and provide the model before saving; the original task's binding is not changed.

Dispatch reuses the bridge's task and provider contracts. It keeps task, model, session, project, and permission scope bound and reports permission failures, unavailable clients, model mismatch, and timeout. It does not expose arbitrary shell commands or provider permission-bypass flags.

Send or reply to a message from the task inspector. A saved message has a receipt; receiving, processing, delivering artifacts, and accepting research results have separate evidence. Workbench-origin messages are labelled as user-initiated input acting for the selected participant, not as autonomous output from its model.

## Pause and resume new work

**Pause new work** blocks new provider execution admission and automatic follow-up across processes sharing this bridge database. Calls already admitted may finish and return their results. Pausing does not cancel them or change tasks to failed/completed.

You can still inspect records, create tasks, save messages, and receive results during a pause. Pending automatic follow-up is retained. **Resume** permits it to continue using the existing route and session bindings; it does not enable routes that were independently disabled. The application explains this effect before resuming.

This control applies to the selected project's bridge. It does not override the user's research constraints, stop unrelated processes, or control work outside this bridge.

After upgrading the runtime, reopen connected MCP clients before relying on the pause control so every connection uses the current execution-admission rules.

## Interpret status accurately

| Displayed evidence | Meaning |
|---|---|
| Last recorded activity | A saved timestamp, not an online heartbeat |
| Requested model / reported model | The required or requested identity versus available runtime evidence |
| Task recorded complete | The task's stored state; not independent scientific acceptance |
| Validation passed | A validator's recorded result and summary; inspect its evidence and scope |
| Host accepted a turn | A bound host receipt; inspect later processing separately |
| Current memory record | Stored source/dependency state; not proof that its claim is true |

The interface does not infer role assignments from provider brands, connect records by similar titles, or turn the protocol's evidence distinctions into a mandatory sequence of gates.

For integration details, see the [workbench API contract](workbench-api.md). For scientific responsibilities, use the [skill](../skills/codex-research-orchestrator/SKILL.md).

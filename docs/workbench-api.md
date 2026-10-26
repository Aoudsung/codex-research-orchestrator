# Collaboration workbench contract

The workbench serves one explicitly selected project on loopback. Its English interface combines project records, research memory, and the optional bridge. It reads original state without creating a database or starting a provider. A demo workspace is explicitly labelled and uses in-memory fictional data; its actions never contact providers.

## Launch and access

`node src/workbench/server.mjs --project /path/to/project [--port 8765] [--demo] [--open]` runs from the bridge runtime. Port `0` selects an available port. The setup helper exposes the same options through `workbench` after validating Node 24+ and the complete installation.

The server binds `127.0.0.1`, generates a per-run access token, and prints a browser URL with the token in its fragment. The UI reads and removes the fragment, retains the token in session storage, and sends `Authorization: Bearer <token>` on API requests. Static assets contain no project data. API requests check the token and allowed Host; writes also require the exact local Origin and JSON content type. No wildcard CORS, remote listening option, arbitrary executable, arbitrary file route, or shell command endpoint is exposed. Render source material as text, never executable HTML.

## Response conventions

JSON uses camelCase and `schemaVersion: 1` on the snapshot. Unknown values are `null`, not zero, false, or an inferred successful state. Errors use `{error: {code, message, details?}}` and a non-success HTTP status. Lists use `{items, nextCursor, hasMore}` with opaque stable cursors, default limit 30 and maximum 100. Search and filters are parameterized. Long source content is fetched separately in bounded character ranges. Source offsets and lengths count Unicode code points, including non-BMP characters as one character, across database, document, and demo sources.

`GET /api/snapshot` returns:

```text
schemaVersion, mode (live|demo), observedAt
project: {name, path, question, questionSource, currentStatePreview}
sources: {bridge, memory, records}: {status (ready|missing|error|unsupported), path, detail}
control: {paused, changedAt, reason, activeOperations}
totals: {tasks, messages, patches, validations, memoryRecords}
participants: [{id, label, roles[], requiredModels[], reportedModels[], lastRecordedAt, taskCount, activeTaskCount}]
exchanges: [{from, to, count, lastAt}]
recentTasks: Task[]
recentActivity: Event[]
recentEvidence: Evidence[]
operations: Operation[]
documents: [{id, title, path, exists, size}]
truncated: {tasks, activity, evidence} (counts omitted from this snapshot)
```

Participants and exchanges come from recorded tasks/messages, not a fixed provider-to-role map. Roles require explicit task metadata. Last activity is a recorded timestamp, not an online heartbeat. Missing or unreadable sources remain visible. Counts are null when their source cannot be read. Snapshots refresh independently of message cursors because task and route updates have no shared event sequence.

### Resources

- `Task`: `id, title, promptPreview, fromAgent, assignedTo, role, priority, status, phase, phaseLabel, createdAt, updatedAt, completedAt, requiredModel, actualModel, modelSource, requiredConversationId, boundConversationId, deliveryVersion, readRoots[], writeRoots[], resultPreview, errorPreview`.
- `Evidence`: `id, kind, title, summary, source, scope, claimStatus, recordState, updatedAt, dependsOn[]`. These are research-memory records, not bridge artifacts. A current record does not prove a scientific claim.
- `Event`: `id, seq, kind (message|patch|validation), taskId, actor, recipient, title, preview, status, createdAt, source`. Events are recorded observations, not invented milestones.
- `Message`: `id, seq, taskId, threadId, fromAgent, toAgent, subject, preview, charLength, replyTo, status, createdAt, readAt, processedAt, wakeupStatus, origin`.
- `Patch`: `id, seq, taskId, fromAgent, kind, summary, status, targetFiles[], dependsOn[], supersedes, supersededBy, createdAt, charLength`.
- `Validation`: `id, seq, taskId, actor, passed (true|false|null), applied, summary, createdAt`.
- `Route`: `taskId, toAgent, targetSessionId, driver, enabled, lastDispatchAt, lastDeliveryAt, receipt, lastError`.
- `Operation`: `id, type, taskId, state (pending|running|succeeded|failed), createdAt, startedAt, finishedAt, summary, result, error`. This describes the workbench request, never scientific acceptance or implicit task completion.

## Read endpoints

- `GET /api/tasks?query=&phase=&agent=&cursor=&limit=` returns tasks.
- `GET /api/tasks/:id` returns `{task, messages: Message[], patches: Patch[], validations: Validation[], route, operation, limits}`. Bounded child lists report omitted counts in `limits`; list endpoints retrieve further pages.
- `GET /api/messages?taskId=&query=&agent=&cursor=&limit=` returns messages. Reads never mark a message as read or processed.
- `GET /api/patches?taskId=&cursor=&limit=` and `GET /api/validations?taskId=&cursor=&limit=` return recorded artifacts and checks.
- `GET /api/evidence?query=&kind=&state=&cursor=&limit=` returns memory records.
- `GET /api/activity?taskId=&kind=&cursor=&limit=` returns a sequence-ordered union of messages, patches, and validations.
- `GET /api/source?kind=message|patch|memory|document|task&id=&offset=0&limit=16000` returns `{text, offset, totalLength, hasMore, sourceLabel}`; maximum range 64000 characters. Task sources accept `field=prompt|result|error`, default `prompt`, to inspect complete instructions and outcomes beyond the list preview. Documents are only declared controls/charter/project/state files or explicitly referenced memory sources inside the selected project. Reject escaping paths and symlinks outside the project. Fail clearly when a source cannot be served safely.
- `GET /api/operations/:id` returns an operation started by this server.
- `GET /api/capabilities` returns `{providers: [{id, executableAvailable, authentication: "not-verified"}], controlsAvailable, dispatchAvailable, limits}`. Finding a CLI does not verify an account or model.

## Explicit actions

All writes are allowlisted, validated, and bound to the selected project. Do not expose arbitrary bridge tools or configuration overrides. Do not run provider commands through a shell.

- `POST /api/tasks`: `{title, prompt, assignedTo, fromAgent?, role?, priority?, requiredModel?, requiredConversationId?, readRoots?, writeRoots?}`. Agents are `codex`, `claude-code`, or `antigravity`; creator defaults to `codex` with metadata marking user initiation through the workbench. Paths must be project-relative and remain inside the selected project; defaults are read `["."]`, write `[]`. Return `{task, preflight}` with status 201. Reuse the bridge creation/preflight contract. Creation is not dispatch, and readiness depends on `preflight.ok`.
- `POST /api/tasks/:id/dispatch`: `{effort?, timeoutSeconds?}`. Require a recorded explicit model and matching project scope. Default effort `low`, timeout 120 seconds, maximum 600. Return an accepted `Operation` with status 202 and execute through the existing provider MCP tool, preserving task/model/session bindings and `completeTaskOnExit: false`. Do not expose bypass-permission flags. Surface queued delivery, unavailable providers, model mismatch, permission denial, and timeout honestly. Prevent duplicate concurrent dispatch of the same task from this workbench.
- `POST /api/messages`: `{taskId, fromAgent, toAgent?, replyTo?, subject?, content}`. Reuse bridge send/reply semantics; mark origin as user-initiated workbench input. Return the actual message receipt with status 201. Do not imply delivery or processing. Messages may be saved during pause, with automatic follow-up still held.
- `POST /api/control`: `{paused, reason?}`. Persist the bridge-wide control state and return it. A pause blocks new execution admission and automatic continuation; already admitted calls may finish. Existing reads, task creation/preflight, messages, results, and validation remain allowed. Resume keeps existing route enabled/disabled settings and bindings, and lets pending work continue. The interface states this effect explicitly before resume.

Pause and execution admission share a database serialization boundary. Gate every provider execution route (exec/resume/fork/review, CLI/SDK/delegated execution) and every wakeup claim, not only HTTP dispatch. Do not repurpose failed/completed task states or revoke leases to represent pause. Status reads must remain read-only. A process holding an admission before pause counts as already started; no process is killed by pausing.

## Interface behavior

The application has an overview, collaboration map, task board/list, evidence view, and activity view with shared search/filtering and a detail inspector. Task and message composers expose the actual action and scope before submission. A successful create offers dispatch as a separate explicit action. A held task can still receive messages and completed results. Show requested versus reported model identity, source freshness, declared versus verified outcomes, and unknown states. Native document/source views preserve original wording.

The demo fixture uses the same shapes and endpoints. A persistent demo banner explains that it is fictional and no providers are contacted. Demo control actions change only that server's in-memory demo state. Live empty states direct users to create a task, initialize memory, or inspect a missing source without inserting sample data into a real project.

The shipped `src/workbench/public/demo-data.json` contains normalized `{project, tasks, messages, patches, validations, evidence, documents, routes}` arrays/objects using the resource shapes above. Tasks may additionally have full `prompt/result/error`, messages `content`, patches `content`, evidence `body`, and documents `text`. The server derives snapshot summaries, participant counts, exchanges, and events from those records. Demo operation results are explicitly simulated. The fixture must contain no private research details, credentials, real session IDs, or claims of real model execution.

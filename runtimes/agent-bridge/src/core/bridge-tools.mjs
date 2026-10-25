import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { PHASE_LABELS } from "./bridge-db.mjs";
import {
  validateUnifiedDiff,
  validateBaselineCopy,
  checkGitApply,
  checkPathWithinRoots,
} from "./patch-validator.mjs";
import { runTaskPreflight } from "./preflight.mjs";

const AGENT_ENUM = ["antigravity", "codex", "claude-code", "all"];
const PEER_AGENT_ENUM = ["antigravity", "codex", "claude-code"];

/**
 * Register shared bidirectional communication, preflight, patch attachment,
 * and unified lifecycle tools on an MCP server.
 *
 * @param {import('./mcp-server.mjs').McpStdioServer} server
 * @param {import('./bridge-db.mjs').BridgeDatabase} bridgeDb
 * @param {object} options
 * @param {string} options.defaultCaller - Default identity of the agent calling this MCP server
 * @param {string} options.defaultTarget - Default identity of the target agent represented by this MCP server
 */
export function registerBridgeTools(
  server,
  bridgeDb,
  { defaultCaller = "antigravity", defaultTarget = "codex" } = {}
) {
  const callerAgent = process.env.MCP_CALLER_AGENT || defaultCaller;
  const targetAgent = process.env.MCP_TARGET_AGENT || defaultTarget;

  const emitWakeupNotification = (msg) => {
    if (!msg) return;
    try {
      server.sendNotification("notifications/resources/updated", {
        uri: `bridge://inbox/${msg.to_agent}`,
      });
      server.sendNotification("notifications/message", {
        level: "info",
        logger: "example-wakeup",
        data: {
          event: "inbox_wakeup_pending",
          taskId: msg.task_id,
          threadId: msg.thread_id,
          messageId: msg.id,
          seq: msg.seq,
          fromAgent: msg.from_agent,
          toAgent: msg.to_agent,
          subject: msg.subject,
          targetSessionId: msg.wakeup_target_session,
        },
      });
    } catch {}
  };

  bridgeDb.onMessageSent = (msg) => {
    if (!msg || (msg.wakeup_status !== "pending" && msg.to_agent !== callerAgent)) {
      return;
    }
    emitWakeupNotification(msg);
  };

  // Start cross-process SQLite watcher so when a passive agent (e.g. Antigravity in another process)
  // writes a message or patch to SQLite, this active agent's MCP server process immediately detects it,
  // resolves any blocking `bridge_wait_for_delivery` / `bridge_poll_updates` calls, and emits stdio notifications.
  bridgeDb.startCrossProcessWatcher({
    agent: callerAgent,
    intervalMs: 350,
    onNewMessages: (newMsgs) => {
      for (const m of newMsgs) {
        if (m.from_agent !== callerAgent) {
          emitWakeupNotification(m);
        }
      }
    },
  });

  // ===========================================================================
  // 1. bridge_send_message
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_send_message",
      description:
        "Send a message across the multi-agent bridge. Strictly rejects unknown fields (such as 'from'/'to'). Requires explicit 'toAgent' OR 'replyTo' (which inherits recipient and thread from the parent message). Supports `waitForDelivery: true` to block and coalesce the passive party's multi-step patch + receipt delivery in the same turn.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: {
            type: "string",
            description: "Message body (Markdown or plain text). For diffs/patches, prefer 'bridge_submit_patch'.",
          },
          toAgent: {
            type: "string",
            enum: AGENT_ENUM,
            description:
              "Explicit recipient agent ('antigravity', 'codex', 'claude-code', or 'all'). Required unless 'replyTo' is provided.",
          },
          fromAgent: {
            type: "string",
            enum: PEER_AGENT_ENUM,
            description: `Sender agent identifier (defaults to '${callerAgent}').`,
          },
          replyTo: {
            type: "string",
            description:
              "Message ID being replied to. Automatically inherits 'toAgent', 'threadId', and 'taskId' from the parent message.",
          },
          taskId: {
            type: "string",
            description: "Optional task ID associated with this message.",
          },
          subject: {
            type: "string",
            description: "Optional short subject line.",
          },
          threadId: {
            type: "string",
            description: "Optional conversation thread ID.",
          },
          metadata: {
            type: "object",
            description: "Optional structured metadata.",
          },
          allowSelfSend: {
            type: "boolean",
            description: "If true, allow sending a message where fromAgent === toAgent (default: false).",
          },
          waitForReply: {
            type: "boolean",
            description: "If true, wait for the recipient agent to reply to this message.",
          },
          waitForDelivery: {
            type: "boolean",
            description:
              "If true, wait for new task messages/patches after this message's cursor and coalesce nearby updates over settleMs. Update receipt, artifact completeness, and host acceptance are reported separately.",
          },
          settleMs: {
            type: "number",
            description:
              "Quiet-window coalescing duration in milliseconds when waitForDelivery is true (default: 2500).",
          },
          timeoutMs: {
            type: "number",
            description:
              "Timeout in milliseconds when waitForReply or waitForDelivery is true (default: 30000 for waitForReply, 600000 for waitForDelivery).",
          },
        },
        required: ["content"],
      },
    },
    async (args) => {
      const resolvedFrom = args.fromAgent || callerAgent;
      const msg = bridgeDb.sendMessage({
        fromAgent: resolvedFrom,
        toAgent: args.toAgent || null,
        content: args.content,
        subject: args.subject || "",
        threadId: args.threadId || null,
        taskId: args.taskId || null,
        replyTo: args.replyTo || null,
        metadata: args.metadata || {},
        allowSelfSend: Boolean(args.allowSelfSend),
      });

      const receipt = {
        messageId: msg.id,
        seq: msg.seq,
        actualFromAgent: msg.from_agent,
        actualToAgent: msg.to_agent,
        threadId: msg.thread_id,
        taskId: msg.task_id,
        replyTo: msg.reply_to,
        inheritedFromReplyTo: Boolean(msg.inheritedFromReplyTo),
        deliveredAt: msg.created_at,
      };

      if (args.waitForDelivery) {
        const delivery = await bridgeDb.waitForDelivery({
          taskId: msg.task_id || args.taskId || null,
          toAgent: resolvedFrom,
          afterSeq: msg.seq,
          settleMs: args.settleMs ?? 2500,
          timeoutMs: args.timeoutMs ?? 600_000,
        });
        return {
          ok: true,
          receipt,
          sentMessage: msg,
          deliveryReceived: delivery.wokenUp,
          delivery,
        };
      }

      if (args.waitForReply) {
        const reply = await bridgeDb.waitForReply({
          messageId: msg.id,
          timeoutMs: args.timeoutMs || 30_000,
        });
        return {
          ok: true,
          receipt,
          sentMessage: msg,
          replyReceived: Boolean(reply),
          reply,
        };
      }

      return {
        ok: true,
        receipt,
        message: msg,
      };
    }
  );

  // ===========================================================================
  // 2. bridge_read_messages
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_read_messages",
      description: `Read messages from an agent inbox (defaults to '${callerAgent}'). Supports incremental cursor reading via 'afterSeq' and filtering by 'taskId'. Strictly rejects unknown fields like 'agent' (use 'toAgent').`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          toAgent: {
            type: "string",
            description: `Recipient agent inbox to read (defaults to '${callerAgent}', use '*' for all agents).`,
          },
          fromAgent: {
            type: "string",
            description: "Optional filter by sender agent.",
          },
          taskId: {
            type: "string",
            description: "Optional filter by task ID.",
          },
          threadId: {
            type: "string",
            description: "Optional filter by conversation thread ID.",
          },
          afterSeq: {
            type: "number",
            description: "Incremental cursor: only return messages with seq > afterSeq.",
          },
          unreadOnly: {
            type: "boolean",
            description: "If true, only return unread messages (default: false).",
          },
          markAsRead: {
            type: "boolean",
            description: "If true, mark returned unread messages as read (default: true).",
          },
          limit: {
            type: "number",
            description: "Maximum number of messages to return (default: 25).",
          },
        },
      },
    },
    async (args) => {
      const inboxOwner = args.toAgent || callerAgent;
      const messages = bridgeDb.readMessages({
        toAgent: inboxOwner,
        fromAgent: args.fromAgent || null,
        threadId: args.threadId || null,
        taskId: args.taskId || null,
        afterSeq: args.afterSeq ?? null,
        unreadOnly: Boolean(args.unreadOnly),
        markAsRead: args.markAsRead !== false,
        limit: args.limit || 25,
      });

      let nextCursor = args.afterSeq ?? 0;
      for (const m of messages) {
        if (m.seq > nextCursor) nextCursor = m.seq;
      }
      if (messages.length === 0 && args.afterSeq === undefined) {
        nextCursor = bridgeDb.getCurrentSeq();
      }

      return {
        ok: true,
        inboxOwner,
        count: messages.length,
        previousCursor: args.afterSeq ?? null,
        nextCursor,
        messages,
      };
    }
  );

  // ===========================================================================
  // 3. bridge_reply_message
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_reply_message",
      description:
        "Reply directly to a received message ID. Automatically inherits recipient ('toAgent'), 'threadId', and 'taskId' from the parent message and returns an explicit delivery receipt.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          replyTo: {
            type: "string",
            description: "The ID of the message being replied to.",
          },
          content: {
            type: "string",
            description: "Reply content.",
          },
          fromAgent: {
            type: "string",
            enum: PEER_AGENT_ENUM,
            description: `Replying agent identifier (defaults to '${callerAgent}').`,
          },
          subject: {
            type: "string",
            description: "Optional subject override.",
          },
          metadata: {
            type: "object",
            description: "Optional structured metadata.",
          },
        },
        required: ["replyTo", "content"],
      },
    },
    async (args) => {
      const reply = bridgeDb.sendMessage({
        fromAgent: args.fromAgent || callerAgent,
        replyTo: args.replyTo,
        subject: args.subject || "",
        content: args.content,
        metadata: args.metadata || {},
      });

      return {
        ok: true,
        receipt: {
          messageId: reply.id,
          seq: reply.seq,
          actualFromAgent: reply.from_agent,
          actualToAgent: reply.to_agent,
          threadId: reply.thread_id,
          taskId: reply.task_id,
          replyTo: reply.reply_to,
          inheritedFromReplyTo: true,
          deliveredAt: reply.created_at,
        },
        reply,
      };
    }
  );

  // ===========================================================================
  // 4. bridge_preflight_task [P0]
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_preflight_task",
      description:
        "Run upfront preflight checks for a task BEFORE execution: checks tool compatibility (flagging unsupported tools like 'write_file' upfront), validates read/write directory scopes, computes the permission delta to authorize once, and records a task-scoped readiness lease. This does not grant human authority or host permissions.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: {
            type: "string",
            description: "Optional task ID to bind the preflight lease to.",
          },
          deliveryMode: { type: "string", enum: ["direct", "read_only", "mcp_structured_patch"], description: "Execution mode checked by preflight (default: direct)." },
          runtime: {
            type: "string",
            enum: ["agy-cli", "antigravity-ide", "codex-cli", "claude-cli"],
            description: "Target execution runtime (default: 'agy-cli').",
          },
          cwd: {
            type: "string",
            description: "Workspace directory.",
          },
          readRoots: {
            type: "array",
            items: { type: "string" },
            description: "Authorized read-only directory roots.",
          },
          writeRoots: {
            type: "array",
            items: { type: "string" },
            description: "Authorized write directory roots.",
          },
          requestedTools: {
            type: "array",
            items: { type: "string" },
            description: "Tools the agent intends to call during the task.",
          },
          allowedCommands: {
            type: "array",
            items: { type: "string" },
            description: "Shell commands needed for the task.",
          },
          forbiddenOperations: {
            type: "array",
            items: { type: "string" },
            description: "Explicitly forbidden operations (e.g. ['local_tests', 'ssh', 'other_models']).",
          },
          alreadyGrantedTools: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of tools already granted in user settings to compute delta.",
          },
          alreadyGrantedCommands: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of shell commands already granted in user settings to compute delta.",
          },
        },
      },
    },
    async (args) => {
      const existingTask = args.taskId ? bridgeDb.getTaskById(args.taskId) : null;
      const cwd = args.cwd || existingTask?.cwd || process.cwd();
      const mergedPermissions = {
        ...(existingTask?.permissions || {}),
        ...(args.readRoots ? { readRoots: args.readRoots } : {}),
        ...(args.writeRoots ? { writeRoots: args.writeRoots } : {}),
        ...(args.requestedTools ? { requestedTools: args.requestedTools } : {}),
        ...(args.allowedCommands ? { allowedCommands: args.allowedCommands } : {}),
        ...(args.forbiddenOperations
          ? { forbiddenOperations: args.forbiddenOperations }
          : {}),
        ...(args.alreadyGrantedTools
          ? { alreadyGrantedTools: args.alreadyGrantedTools }
          : {}),
        ...(args.alreadyGrantedCommands
          ? { alreadyGrantedCommands: args.alreadyGrantedCommands }
          : {}),
      };

      const preflight = runTaskPreflight({
        deliveryMode: args.deliveryMode || existingTask?.metadata?.deliveryMode || "direct",
        runtime: args.runtime || "agy-cli",
        cwd,
        permissions: mergedPermissions,
      });

      if (existingTask) bridgeDb.createTask({ taskId: existingTask.id,
        permissions: Object.fromEntries(["readRoots", "writeRoots", "requestedTools", "allowedCommands", "forbiddenOperations"]
          .filter((key) => Object.hasOwn(args, key)).map((key) => [key, args[key]])),
        metadata: { deliveryMode: preflight.deliveryMode } });

      let lease = null;
      if (preflight.ok && args.taskId && existingTask) {
        lease = bridgeDb.grantTaskLease({
          taskId: args.taskId,
          agent: existingTask.assigned_to,
          permissions: preflight.consolidatedPermissionChecklist,
          preflight,
        });
      }

      return {
        ok: preflight.ok,
        taskId: args.taskId || null,
        preflight,
        lease,
      };
    }
  );

  // ===========================================================================
  // 5. bridge_create_task
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_create_task",
      description: `Create and assign a collaborative task (or reuse an existing 'taskId') with explicit model binding ('requiredModel'), conversation binding ('requiredConversationId'), and upfront permission scope ('readRoots', 'writeRoots').`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: {
            type: "string",
            description: "Optional explicit task ID (if it already exists, returns the existing task without duplicating).",
          },
          title: {
            type: "string",
            description: "Short task title.",
          },
          prompt: {
            type: "string",
            description: "Detailed instructions and acceptance criteria for the task.",
          },
          assignedTo: {
            type: "string",
            enum: PEER_AGENT_ENUM,
            description: `Target agent to execute the task (defaults to '${targetAgent}').`,
          },
          fromAgent: {
            type: "string",
            enum: PEER_AGENT_ENUM,
            description: `Requester agent (defaults to '${callerAgent}').`,
          },
          requiredModel: {
            type: "string",
            description: "Exact model ID required for this task (e.g. 'synthetic-model-high'). Mismatched models will be rejected.",
          },
          requiredConversationId: {
            type: "string",
            description: "Optional conversation/session ID that must be used for this task.",
          },
          cwd: {
            type: "string",
            description: "Working directory path.",
          },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "urgent"],
            description: "Task priority (default: 'normal').",
          },
          readRoots: {
            type: "array",
            items: { type: "string" },
            description: "Authorized read-only directory roots for this task.",
          },
          writeRoots: {
            type: "array",
            items: { type: "string" },
            description: "Authorized write directory roots for this task.",
          },
          requestedTools: {
            type: "array",
            items: { type: "string" },
            description: "Tools requested for this task (checked upfront for compatibility).",
          },
          allowedCommands: {
            type: "array",
            items: { type: "string" },
            description: "Shell commands authorized for this task.",
          },
          forbiddenOperations: {
            type: "array",
            items: { type: "string" },
            description: "Operations forbidden during this task (e.g. ['local_tests', 'ssh']).",
          },
          deliveryMode: { type: "string", enum: ["direct", "read_only", "mcp_structured_patch"], description: "Execution mode checked by preflight (default: direct)." },
          runtime: {
            type: "string",
            enum: ["agy-cli", "antigravity-ide", "codex-cli", "claude-cli"],
            description: "Target runtime surface for preflight checks (default: 'agy-cli').",
          },
          metadata: {
            type: "object",
            description: "Optional metadata object.",
          },
          waitForCompletion: {
            type: "boolean",
            description: "If true, wait until the target agent completes the task.",
          },
          timeoutMs: {
            type: "number",
            description: "Timeout in ms if waitForCompletion is true (default: 60000).",
          },
        },
        required: ["prompt"],
      },
    },
    async (args) => {
      const original = args.taskId ? bridgeDb.getTaskById(args.taskId) : null;
      const assignedTo = args.assignedTo || original?.assigned_to || targetAgent;
      const cwd = args.cwd || original?.cwd || process.cwd();
      const permissions = {
        readRoots: args.readRoots || args.metadata?.readRoots || original?.permissions?.readRoots || [],
        writeRoots: args.writeRoots || args.metadata?.writeRoots || original?.permissions?.writeRoots || [],
        requestedTools: args.requestedTools || original?.permissions?.requestedTools || [],
        allowedCommands: args.allowedCommands || original?.permissions?.allowedCommands || [],
        forbiddenOperations: args.forbiddenOperations || original?.permissions?.forbiddenOperations || [],
      };

      const runtime =
        args.runtime ||
        (assignedTo === "antigravity"
          ? "agy-cli"
          : assignedTo === "codex"
            ? "codex-cli"
            : "claude-cli");

      const preflight = runTaskPreflight({
        runtime,
        deliveryMode: args.deliveryMode || original?.metadata?.deliveryMode || "direct",
        cwd,
        permissions,
      });

      const task = bridgeDb.createTask({
        taskId: args.taskId || null,
        fromAgent: args.fromAgent || callerAgent,
        assignedTo,
        title: args.title || args.prompt.slice(0, 72),
        prompt: args.prompt,
        cwd,
        priority: args.priority || "normal",
        requiredModel: args.requiredModel || args.metadata?.requiredModel || null,
        requiredConversationId:
          args.requiredConversationId ||
          args.metadata?.requiredConversationId ||
          null,
        permissions: preflight.consolidatedPermissionChecklist,
        metadata: { ...args.metadata, deliveryMode: preflight.deliveryMode },
      });

      const lease = preflight.ok ? bridgeDb.grantTaskLease({
        taskId: task.id,
        agent: assignedTo,
        permissions: preflight.consolidatedPermissionChecklist,
        preflight,
      }) : null;

      if (args.waitForCompletion) {
        const finalTask = await bridgeDb.waitForTask({
          taskId: task.id,
          timeoutMs: args.timeoutMs || 60_000,
        });
        return {
          ok: true,
          completed:
            finalTask?.status === "completed" || finalTask?.status === "failed",
          task: finalTask,
          binding: finalTask?.binding,
          preflight,
          lease,
        };
      }

      return {
        ok: true,
        task: bridgeDb.getTaskById(task.id),
        binding: task.binding,
        preflight,
        lease,
      };
    }
  );

  // ===========================================================================
  // 6. bridge_list_tasks
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_list_tasks",
      description: "List tasks in the shared multi-agent task queue, including their unified phase ('Awaiting revision', 'Delivered / awaiting validation', 'Awaiting review', etc.) and model/session binding.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          assignedTo: {
            type: "string",
            description: "Filter by assigned agent ('antigravity', 'codex', 'claude-code', or '*' for all).",
          },
          fromAgent: {
            type: "string",
            description: "Filter by creator agent.",
          },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed", "failed", "cancelled"],
            description: "Filter by coarse task status.",
          },
          phase: {
            type: "string",
            enum: Object.keys(PHASE_LABELS),
            description: "Filter by fine-grained lifecycle phase.",
          },
          limit: {
            type: "number",
            description: "Maximum tasks to return (default: 25).",
          },
        },
      },
    },
    async (args) => {
      const tasks = bridgeDb.listTasks({
        assignedTo: args.assignedTo || null,
        fromAgent: args.fromAgent || null,
        status: args.status || null,
        phase: args.phase || null,
        limit: args.limit || 25,
      });
      return {
        ok: true,
        count: tasks.length,
        tasks,
      };
    }
  );

  // ===========================================================================
  // 7. bridge_claim_task
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_claim_task",
      description: `Claim a task assigned to '${callerAgent}' (or specified agent). Validates 'model' and 'conversationId' against the task's required binding and returns the active permission lease and tool compatibility guidance.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: {
            type: "string",
            description: "Specific task ID to claim. If omitted, claims the highest-priority pending/active task for the agent.",
          },
          agent: {
            type: "string",
            enum: PEER_AGENT_ENUM,
            description: `Agent claiming the task (defaults to '${callerAgent}').`,
          },
          model: {
            type: "string",
            description: "Actual model ID of the claiming session (e.g. 'synthetic-model-high'). Validated against task.required_model.",
          },
          conversationId: {
            type: "string",
            description: "Conversation/session ID of the claiming agent. Validated and bound to the task.",
          },
        },
      },
    },
    async (args) => {
      const claimed = bridgeDb.claimTask({
        taskId: args.taskId || null,
        agent: args.agent || callerAgent,
        model: args.model || null,
        conversationId: args.conversationId || null,
      });

      if (!claimed) {
        return {
          ok: true,
          claimed: false,
          task: null,
        };
      }

      const lease = bridgeDb.getTaskLease(claimed.id);
      const preflight =
        lease?.preflight ||
        runTaskPreflight({
          runtime:
            (args.agent || callerAgent) === "antigravity"
              ? "agy-cli"
              : "codex-cli",
          cwd: claimed.cwd || process.cwd(),
          permissions: claimed.permissions,
        });

      return {
        ok: true,
        claimed: true,
        task: claimed,
        binding: claimed.binding,
        lease: lease || { status: claimed.lease_status },
        doNotRetryTools: preflight.doNotRetryTools || [],
        deliveryGuidance: preflight.deliveryGuidance,
      };
    }
  );

  // ===========================================================================
  // 8. bridge_submit_patch [P1]
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_submit_patch",
      description:
        "Submit a structured patch attachment ('unified_diff' or 'baseline_copy') bound to a taskId and patchId. Preserves author's exact byte-for-byte original text, validates hunk line counts and authorized writeRoots paths, records dependencies/supersedes, updates task phase to 'Delivered / awaiting validation', and notifies the coordinator.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: {
            type: "string",
            description: "Task ID this patch belongs to.",
          },
          patchId: {
            type: "string",
            description: "Unique patch identifier (e.g. 'example-001', 'example-001-fix').",
          },
          content: {
            type: "string",
            description: "Exact byte-for-byte unified diff text or baseline_copy JSON array.",
          },
          artifactKind: {
            type: "string",
            enum: ["unified_diff", "baseline_copy"],
            description: "Patch artifact type (default: 'unified_diff').",
          },
          fromAgent: {
            type: "string",
            enum: PEER_AGENT_ENUM,
            description: `Author agent (defaults to '${callerAgent}').`,
          },
          toAgent: {
            type: "string",
            enum: PEER_AGENT_ENUM,
            description: "Recipient coordinator agent (defaults to the task's creator agent, e.g. 'codex').",
          },
          model: {
            type: "string",
            description: "Model ID that authored this patch (verified against task.required_model).",
          },
          conversationId: {
            type: "string",
            description: "Conversation ID that authored this patch (verified against task.required_conversation_id).",
          },
          dependsOn: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of prerequisite patchIds that must be applied before this patch.",
          },
          supersedes: {
            type: "string",
            description: "Optional previous patchId that this patch replaces (automatically marks the old patch as 'superseded').",
          },
          summary: {
            type: "string",
            description: "Short summary of files and changes in this patch.",
          },
          allowRecount: {
            type: "boolean",
            description:
              "If true (default: false), allow storing a unified diff whose hunk header counts need `git apply --recount`, while flagging hunkCountValid=false in validation metadata.",
          },
          cwd: {
            type: "string",
            description: "Optional workspace root to run non-destructive `git apply --check`.",
          },
        },
        required: ["taskId", "patchId", "content"],
      },
    },
    async (args) => {
      const task = bridgeDb.getTaskById(args.taskId);
      if (!task) {
        throw new Error(`Task not found: ${args.taskId}`);
      }

      const artifactKind = args.artifactKind || "unified_diff";
      const writeRoots =
        task.permissions?.writeRoots || task.metadata?.writeRoots || [];
      const readRoots =
        task.permissions?.readRoots || task.metadata?.readRoots || [];
      const cwd = args.cwd || task.cwd || null;

      let validation;
      if (artifactKind === "baseline_copy") {
        validation = validateBaselineCopy(args.content, {
          readRoots,
          writeRoots,
          cwd,
        });
      } else {
        validation = validateUnifiedDiff(args.content, { writeRoots });
        if (validation.pathScopeValid && cwd) {
          validation.gitApplyCheck = await checkGitApply(args.content, cwd);
        }
      }

      // Always reject out-of-scope paths immediately
      if (!validation.pathScopeValid) {
        return {
          ok: false,
          fatal: true,
          errorCode: "PATCH_PATH_OUT_OF_SCOPE",
          patchId: args.patchId,
          taskId: args.taskId,
          error: validation.errors.join(" "),
          validation,
        };
      }

      // Reject malformed diff or hunk count mismatches unless allowRecount is true and only hunk counts differed
      if (!validation.valid) {
        const onlyHunkCountMismatch =
          artifactKind === "unified_diff" &&
          validation.hunkCount > 0 &&
          validation.pathScopeValid &&
          !validation.hunkCountValid;

        if (!(onlyHunkCountMismatch && args.allowRecount)) {
          return {
            ok: false,
            fatal: true,
            errorCode: onlyHunkCountMismatch
              ? "PATCH_HUNK_COUNT_MISMATCH"
              : "PATCH_FORMAT_INVALID",
            patchId: args.patchId,
            taskId: args.taskId,
            error: validation.errors.join(" "),
            hint: onlyHunkCountMismatch
              ? "Fix the @@ -old,count +new,count @@ hunk header line counts (or see validation.hunkSummary for exact actual line counts), or pass allowRecount: true if coordinator applies with `git apply --recount`."
              : "Provide a valid unified diff starting with `diff --git a/... b/...` and `@@ ... @@` hunks.",
            validation: {
              ...validation,
              recountedContent: undefined,
            },
          };
        }
      }

      // Remove recountedContent from stored metadata so author rawContent remains the single source of truth
      const storedValidation = { ...validation };
      delete storedValidation.recountedContent;

      const submission = bridgeDb.submitPatch({
        patchId: args.patchId,
        taskId: args.taskId,
        fromAgent: args.fromAgent || callerAgent,
        toAgent: args.toAgent || task.from_agent || "codex",
        conversationId: args.conversationId || null,
        model: args.model || null,
        artifactKind,
        rawContent: args.content,
        dependsOn: args.dependsOn || [],
        supersedes: args.supersedes || null,
        targetFiles: validation.targetFiles || [],
        validation: storedValidation,
        summary: args.summary || "",
        notifyRecipient: true,
      });

      return {
        ok: true,
        patch: submission.patch,
        binding: submission.task.binding,
        taskPhase: {
          phase: submission.task.phase,
          phaseLabel: submission.task.phase_label,
        },
        receipt: submission.notificationReceipt,
      };
    }
  );

  // ===========================================================================
  // 9. bridge_list_patches [P1]
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_list_patches",
      description:
        "List structured patches submitted for a task, including dependency/supersedes relationships and the computed 'activeApplyOrder' excluding superseded patches.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: {
            type: "string",
            description: "Task ID to list patches for.",
          },
          activeOnly: {
            type: "boolean",
            description: "If true, exclude superseded patches (default: false).",
          },
          includeRawContent: {
            type: "boolean",
            description: "If true, include full raw diff content for each patch (default: false).",
          },
        },
        required: ["taskId"],
      },
    },
    async (args) => {
      const res = bridgeDb.listPatches({
        taskId: args.taskId,
        activeOnly: Boolean(args.activeOnly),
        includeRawContent: Boolean(args.includeRawContent),
      });
      return {
        ok: true,
        taskId: args.taskId,
        count: res.patches.length,
        activeApplyOrder: res.activeApplyOrder,
        patches: res.patches,
      };
    }
  );

  // ===========================================================================
  // 10. bridge_get_patch [P1]
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_get_patch",
      description:
        "Retrieve a structured patch attachment by 'patchId', including its byte-for-byte original 'rawContent', SHA-256 digest, target files, and validation status. Optionally saves the exact original content to a file or runs `git apply --check`.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          patchId: {
            type: "string",
            description: "Patch ID to retrieve (e.g. 'example-001-fix').",
          },
          saveToPath: {
            type: "string",
            description: "Optional file path to save the exact byte-for-byte rawContent.",
          },
          checkApplyCwd: {
            type: "string",
            description: "Optional working directory to run `git apply --check` (and `--recount` check).",
          },
        },
        required: ["patchId"],
      },
    },
    async (args) => {
      const patch = bridgeDb.getPatch(args.patchId, { includeRawContent: true });
      if (!patch) {
        throw new Error(`Patch not found: ${args.patchId}`);
      }

      let savedFile = null;
      if (args.saveToPath) {
        const task = bridgeDb.getTaskById(patch.taskId);
        const writeRoots =
          task?.permissions?.writeRoots || task?.metadata?.writeRoots || [];
        const base = path.resolve(task?.cwd || process.cwd());
        const relative = path.relative(base, path.resolve(base, args.saveToPath));
        const scopeCheck = checkPathWithinRoots(relative, writeRoots);
        if (!scopeCheck.allowed) throw new Error(`saveToPath rejected: ${scopeCheck.reason}`);
        const absSave = path.resolve(base, relative);
        let ancestor = absSave;
        while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
        const realAncestor = fs.realpathSync(ancestor);
        const physicalRelative = path.relative(fs.realpathSync(base), path.join(realAncestor, path.relative(ancestor, absSave)));
        if (!checkPathWithinRoots(physicalRelative, writeRoots).allowed) throw new Error("saveToPath escapes write roots through a symlink");
        fs.mkdirSync(path.dirname(absSave), { recursive: true });
        fs.writeFileSync(absSave, patch.rawContent, "utf8");
        savedFile = absSave;
      }

      let gitApplyCheck = null;
      if (args.checkApplyCwd && patch.artifactKind === "unified_diff") {
        gitApplyCheck = await checkGitApply(
          patch.rawContent,
          args.checkApplyCwd
        );
      }

      return {
        ok: true,
        patch,
        savedFile,
        gitApplyCheck,
      };
    }
  );

  // ===========================================================================
  // 11. bridge_record_validation [P1]
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_record_validation",
      description:
        "Record patch application and/or server verification results for a task's patch set. Updates patch statuses, transitions the unified task state ('Awaiting revision' vs 'Awaiting review' vs 'Delivered / awaiting validation'), and sends a single consolidated notification message with cursor seq. Supports `waitForDelivery: true` to automatically wait and coalesce the passive party's next patch + receipt delivery.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: {
            type: "string",
            description: "Task ID being validated.",
          },
          patchIds: {
            type: "array",
            items: { type: "string" },
            description: "List of patch IDs covered by this application/validation round.",
          },
          applied: {
            type: "boolean",
            description: "Whether the patches were mechanically applied to the working tree (default: true).",
          },
          passed: {
            type: "boolean",
            description: "Whether server verification/tests passed (true = awaiting_review, false = awaiting_revision, omit if only recording patch application).",
          },
          summary: {
            type: "string",
            description: "Consolidated validation report or failure feedback for the author session.",
          },
          validatorAgent: {
            type: "string",
            enum: PEER_AGENT_ENUM,
            description: `Agent recording the validation (defaults to '${callerAgent}').`,
          },
          details: {
            type: "object",
            description: "Optional structured test counts, log paths, or failure identifiers.",
          },
          notifyAssignee: {
            type: "boolean",
            description: "Whether to send a consolidated notification message to the task assignee (default: true).",
          },
          waitForDelivery: {
            type: "boolean",
            description:
              "If true (recommended when `passed: false`), keep this tool call open until the assignee submits the next patch + receipt delivery, coalesced over `settleMs`.",
          },
          settleMs: {
            type: "number",
            description:
              "Quiet-window coalescing duration in milliseconds when waitForDelivery is true (default: 2500).",
          },
          timeoutMs: {
            type: "number",
            description:
              "Wait timeout in milliseconds when waitForDelivery is true (default: 600000 = 10 min).",
          },
        },
        required: ["taskId", "patchIds", "summary"],
      },
    },
    async (args) => {
      const validator = args.validatorAgent || callerAgent;
      const res = bridgeDb.recordValidation({
        taskId: args.taskId,
        validatorAgent: validator,
        patchIds: args.patchIds,
        applied: args.applied !== false,
        passed: args.passed ?? null,
        summary: args.summary,
        details: args.details || {},
        notifyAssignee: args.notifyAssignee !== false,
      });

      const baseCursor = res.notificationReceipt?.seq || res.seq;

      if (args.waitForDelivery) {
        const delivery = await bridgeDb.waitForDelivery({
          taskId: args.taskId,
          toAgent: validator,
          afterSeq: baseCursor,
          settleMs: args.settleMs ?? 2500,
          timeoutMs: args.timeoutMs ?? 600_000,
        });
        return {
          ok: true,
          validationId: res.validationId,
          seq: res.seq,
          taskPhase: {
            phase: delivery.taskState?.phase || res.task.phase,
            phaseLabel: delivery.taskState?.phase_label || res.task.phase_label,
          },
          binding: res.task.binding,
          receipt: res.notificationReceipt,
          deliveryReceived: delivery.wokenUp,
          delivery,
        };
      }

      return {
        ok: true,
        validationId: res.validationId,
        seq: res.seq,
        taskPhase: {
          phase: res.task.phase,
          phaseLabel: res.task.phase_label,
        },
        binding: res.task.binding,
        receipt: res.notificationReceipt,
      };
    }
  );

  // ===========================================================================
  // 12. bridge_update_task_phase [P1]
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_update_task_phase",
      description:
        "Update the unified lifecycle phase of a task ('ready'/'Ready', 'in_progress'/'In progress', 'cli_turn_ended'/'CLI turn ended (delivery unconfirmed)', 'patch_delivered'/'Patch delivered', 'awaiting_validation'/'Delivered / awaiting validation', 'validation_failed'/'Validation failed', 'awaiting_revision'/'Awaiting revision', 'awaiting_review'/'Awaiting review', 'completed'/'Completed').",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: {
            type: "string",
            description: "Task ID to update.",
          },
          phase: {
            type: "string",
            enum: Object.keys(PHASE_LABELS),
            description: "Target lifecycle phase.",
          },
          result: {
            type: "string",
            description: "Optional summary or result note.",
          },
          error: {
            type: "string",
            description: "Optional error note.",
          },
        },
        required: ["taskId", "phase"],
      },
    },
    async (args) => {
      const updated = bridgeDb.updateTaskPhase({
        taskId: args.taskId,
        phase: args.phase,
        result: args.result || null,
        error: args.error || null,
      });
      return {
        ok: true,
        task: updated,
        phase: updated.phase,
        phaseLabel: updated.phase_label,
        binding: updated.binding,
      };
    }
  );

  // ===========================================================================
  // 13. bridge_get_task_overview [P1]
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_get_task_overview",
      description:
        "Retrieve a unified, single-call overview of a task: current phase ('Awaiting revision', 'Delivered / awaiting validation', 'Awaiting review', 'Completed'), model & conversation binding, active permission lease, active patch stack in apply order, validation history, and current message cursor.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: {
            type: "string",
            description: "Task ID to inspect.",
          },
        },
        required: ["taskId"],
      },
    },
    async (args) => {
      const overview = bridgeDb.getTaskOverview(args.taskId);
      if (!overview) {
        throw new Error(`Task not found: ${args.taskId}`);
      }
      return {
        ok: true,
        ...overview,
      };
    }
  );

  // ===========================================================================
  // 14. bridge_poll_updates [P1]
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_poll_updates",
      description:
        "Incrementally poll for new messages, patch deliveries, and validation results since 'afterSeq' (cursor). Optionally waits up to 'waitMs' for new events and coalesces multi-step deliveries over 'settleMs'.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          afterSeq: {
            type: "number",
            description: "Cursor sequence number from previous read/poll (0 to fetch all).",
          },
          toAgent: {
            type: "string",
            description: `Filter events relevant to agent (defaults to '${callerAgent}', use '*' for all).`,
          },
          taskId: {
            type: "string",
            description: "Optional filter by task ID.",
          },
          markMessagesRead: {
            type: "boolean",
            description: "If true, mark returned messages as read (default: false).",
          },
          waitMs: {
            type: "number",
            description: "Optional long-poll wait duration in milliseconds (default: 0).",
          },
          settleMs: {
            type: "number",
            description:
              "Optional quiet-window coalescing duration in milliseconds after first event arrives so consecutive messages (e.g. patch + receipt) are returned together (default: 0).",
          },
        },
        required: ["afterSeq"],
      },
    },
    async (args) => {
      const updates = await bridgeDb.pollUpdates({
        toAgent: args.toAgent || callerAgent,
        taskId: args.taskId || null,
        afterSeq: args.afterSeq,
        markMessagesRead: Boolean(args.markMessagesRead),
        waitMs: args.waitMs || 0,
        settleMs: args.settleMs || 0,
      });
      return {
        ok: true,
        ...updates,
      };
    }
  );

  // ===========================================================================
  // 14b. bridge_wait_for_delivery [Active Wakeup & Quiet-Window Coalescing]
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_wait_for_delivery",
      description:
        "Wait for task-scoped updates and coalesce nearby events. Reports updatesReceived, artifactDeliveryComplete, and confirmed host delivery separately. A quiet window or inbox update does not prove that the target chat resumed.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: {
            type: "string",
            description: "Task ID to watch for passive-party delivery.",
          },
          toAgent: {
            type: "string",
            enum: AGENT_ENUM,
            description: `Active recipient agent waiting to be woken up (defaults to '${callerAgent}').`,
          },
          afterSeq: {
            type: "number",
            description:
              "Optional cursor sequence number. If omitted, automatically starts right before the earliest unread message for (toAgent, taskId), or current cursor if none are unread.",
          },
          settleMs: {
            type: "number",
            description:
              "Quiet-window coalescing window in milliseconds after the first event arrives (default: 2500ms so patch + receipt arriving 1-2s apart are bundled together).",
          },
          timeoutMs: {
            type: "number",
            description:
              "Maximum wait duration in milliseconds (default: 600000 = 10 minutes).",
          },
          markMessagesRead: {
            type: "boolean",
            description:
              "If true, mark delivered messages as read upon wakeup (default: false so main thread can also inspect if forwarded).",
          },
          deliverToHost: {
            type: "boolean",
            description:
              "If true, actively execute the configured host wakeup driver (`codex_ipc` / `app_server_ws` / `custom_command`) to start a new turn on the target conversation and confirm delivery only upon receiving the host's acceptance receipt.",
          },
          confirmDelivery: {
            type: "boolean",
            description:
              "If true (requires `receipt`), confirm that the caller has delivered the wakeup to the host and received an acceptance receipt, advancing `last_woken_seq`.",
          },
          receipt: {
            type: "object",
            additionalProperties: true,
            description:
              "Host acceptance receipt (`{ accepted: true, turnId, targetSessionId }`) when `confirmDelivery` is true.",
          },
        },
      },
    },
    async (args) => {
      const res = await bridgeDb.waitForDelivery({
        taskId: args.taskId || null,
        toAgent: args.toAgent || callerAgent,
        afterSeq: args.afterSeq ?? null,
        settleMs: args.settleMs ?? 2500,
        timeoutMs: args.timeoutMs ?? 600_000,
        markMessagesRead: Boolean(args.markMessagesRead),
        deliverToHost: Boolean(args.deliverToHost),
        confirmDelivery: Boolean(args.confirmDelivery),
        receipt: args.receipt || null,
      });
      return {
        ok: true,
        ...res,
      };
    }
  );

  // ===========================================================================
  // 14c. bridge_configure_wakeup_route [Multi-Driver Wakeup Router]
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_configure_wakeup_route",
      description:
        "Configure, inspect, or trigger/confirm the active wakeup route for a task. Supports `codex_ipc` / `host_poll` (connects to `~/.codex/ipc/ipc.sock`, starts a new turn via `thread-follower-start-turn`, and confirms delivery ONLY upon receiving a `turn.id` receipt), `app_server_ws`, `custom_command`, `cli_resume`, and `manual`.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: {
            type: "string",
            description: "Task ID to configure.",
          },
          threadId: {
            type: "string",
            description: "Bridge thread ID (defaults to `example-<taskId>`).",
          },
          toAgent: {
            type: "string",
            enum: PEER_AGENT_ENUM,
            description: "Active agent to wake up (default: 'codex').",
          },
          targetSessionId: {
            type: "string",
            description: "Target session/thread ID in the active host (e.g. '00000000-0000-4000-8000-000000000001').",
          },
          driver: {
            type: "string",
            enum: [
              "host_poll",
              "codex_ipc",
              "app_server_ws",
              "custom_command",
              "cli_resume",
              "manual",
            ],
            description: "Wakeup delivery driver (default: 'host_poll').",
          },
          wakeupCommand: {
            type: "string",
            description: "Optional shell command template when driver is 'custom_command'.",
          },
          appServerUrl: {
            type: "string",
            description: "Optional WebSocket or Unix socket URL when driver is 'app_server_ws' or 'codex_ipc'.",
          },
          cwd: {
            type: "string",
            description: "Working directory for wakeup driver.",
          },
          enabled: {
            type: "boolean",
            description: "Whether the wakeup route is enabled (default: true).",
          },
          coalesceMs: {
            type: "number",
            description: "Optional quiet-window coalescing delay in milliseconds (default: 800).",
          },
          deliverPendingNow: {
            type: "boolean",
            description: "If true, immediately execute host wakeup delivery for any pending/dispatched unread messages on this task.",
          },
          confirmReceipt: {
            type: "object",
            additionalProperties: true,
            description: "Optional host acceptance receipt (`{ accepted: true, turnId, targetSessionId }`) to confirm a previously dispatched wakeup.",
          },
        },
        required: ["taskId"],
      },
    },
    async (args) => {
      let route = bridgeDb.getWakeupRoute(args.taskId);
      const configurationKeys = ["threadId", "toAgent", "targetSessionId", "driver", "wakeupCommand", "appServerUrl", "cwd", "enabled"];
      const hasConfiguration = configurationKeys.some((key) => Object.hasOwn(args, key));
      if (hasConfiguration) {
        route = bridgeDb.configureWakeupRoute({
          taskId: args.taskId,
          threadId: args.threadId ?? route?.thread_id ?? null,
          toAgent: args.toAgent ?? route?.to_agent ?? "codex",
          targetSessionId: args.targetSessionId ?? route?.target_session_id ?? "",
          driver: args.driver ?? route?.driver ?? "manual",
          wakeupCommand: args.wakeupCommand ?? route?.wakeup_command ?? null,
          appServerUrl: args.appServerUrl ?? route?.app_server_url ?? null,
          cwd: args.cwd ?? route?.cwd ?? "",
          enabled: args.enabled ?? Boolean(route?.enabled),
        });
      }
      if (!route && (args.confirmReceipt || args.deliverPendingNow)) throw new Error("No configured wakeup route for this task");

      let deliveryOutcome = null;
      if (args.confirmReceipt) {
        deliveryOutcome = bridgeDb.confirmWakeupDelivery({
          taskId: args.taskId,
          receipt: args.confirmReceipt,
        });
        route = deliveryOutcome.route || bridgeDb.getWakeupRoute(args.taskId);
      } else if (args.deliverPendingNow) {
        deliveryOutcome = await bridgeDb.executeWakeupDelivery(args.taskId, {
          includeDispatched: true,
        });
        route = deliveryOutcome.route || bridgeDb.getWakeupRoute(args.taskId);
      }

      return {
        ok: true,
        route,
        ...(deliveryOutcome
          ? { deliveryOutcome, immediateDelivery: deliveryOutcome }
          : {}),
      };
    }
  );

  // ===========================================================================
  // 15. bridge_complete_task
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_complete_task",
      description:
        "Mark a task as completed, failed, or cancelled. Automatically revokes the task's temporary permission lease ('task_leases') so task-scoped permissions never leak after completion.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: {
            type: "string",
            description: "Task ID to complete.",
          },
          status: {
            type: "string",
            enum: ["completed", "failed", "cancelled"],
            description: "Final task status (default: 'completed').",
          },
          result: {
            type: "string",
            description: "Final result output or summary.",
          },
          error: {
            type: "string",
            description: "Error details if status is 'failed'.",
          },
          sessionId: {
            type: "string",
            description: "Optional session/conversation ID associated with the execution.",
          },
          model: {
            type: "string",
            description: "Optional model ID verification.",
          },
        },
        required: ["taskId"],
      },
    },
    async (args) => {
      const updated = bridgeDb.completeTask({
        taskId: args.taskId,
        status: args.status || "completed",
        result: args.result || null,
        error: args.error || null,
        sessionId: args.sessionId || null,
        model: args.model || null,
      });
      if (!updated) {
        throw new Error(`Task not found: ${args.taskId}`);
      }
      return {
        ok: true,
        task: updated,
        binding: updated.binding,
        revokedLease: updated.revokedLease,
      };
    }
  );

  // ===========================================================================
  // 16. bridge_set_context
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_set_context",
      description:
        "Store or update a shared context entry accessible by Antigravity, Codex, and Claude Code.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: {
            type: "string",
            description: "Unique context key.",
          },
          value: {
            type: "string",
            description: "Content to store.",
          },
          description: {
            type: "string",
            description: "Optional human-readable description.",
          },
          contentType: {
            type: "string",
            description: "MIME type (default: 'text/plain').",
          },
          updatedBy: {
            type: "string",
            description: `Agent updating the key (defaults to '${callerAgent}').`,
          },
        },
        required: ["key", "value"],
      },
    },
    async (args) => {
      const entry = bridgeDb.setContext({
        key: args.key,
        value: args.value,
        updatedBy: args.updatedBy || callerAgent,
        contentType: args.contentType || "text/plain",
        description: args.description || "",
      });
      return {
        ok: true,
        entry,
      };
    }
  );

  // ===========================================================================
  // 17. bridge_get_context
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_get_context",
      description:
        "Retrieve a shared context entry by key, or list all available shared context keys if key is omitted.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: {
            type: "string",
            description: "Context key to retrieve. Omit to list all keys.",
          },
        },
      },
    },
    async (args) => {
      if (!args.key) {
        return {
          ok: true,
          keys: bridgeDb.listContext(),
        };
      }
      const entry = bridgeDb.getContext(args.key);
      return {
        ok: Boolean(entry),
        entry,
      };
    }
  );

  // ===========================================================================
  // 18. bridge_status
  // ===========================================================================
  server.registerTool(
    {
      name: "bridge_status",
      description:
        "Get the overall status of the multi-agent bridge (current cursor seq, unread messages, tasks by phase, patches, active leases, and recent sessions).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    async () => {
      return {
        ok: true,
        callerAgent,
        targetAgent,
        ...bridgeDb.getSummaryStats(),
      };
    }
  );

  // Register MCP Resources for live inspection
  server.registerResource(
    {
      uri: "bridge://status",
      name: "Multi-Agent Bridge Status",
      description:
        "Live overview of cursor seq, unread messages, tasks by phase, patches, active leases, and sessions.",
    },
    () => bridgeDb.getSummaryStats()
  );

  server.registerResource(
    {
      uri: `bridge://inbox/${callerAgent}`,
      name: `Inbox for ${callerAgent}`,
      description: `Recent messages sent to ${callerAgent}`,
    },
    () =>
      bridgeDb.readMessages({
        toAgent: callerAgent,
        markAsRead: false,
        limit: 50,
      })
  );
}

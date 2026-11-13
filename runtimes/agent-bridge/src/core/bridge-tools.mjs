import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { PHASE_LABELS } from "./bridge-db.mjs";
import {
  HANDOFF_REASON_CODES,
  ISOLATION_PROFILES,
  SUBSCRIPTION_MODES,
} from "../domain/model.mjs";
import { messageCard } from "../domain/cards.mjs";
import {
  validateUnifiedDiff,
  validateBaselineCopy,
  checkGitApply,
  checkPathWithinRoots,
} from "./patch-validator.mjs";
import { runTaskPreflight } from "./preflight.mjs";
import { registerResearchMemoryTools } from "./research-memory-tools.mjs";
import { projectWorkflowDefaults } from "./project-workflow.mjs";

const AGENT_ENUM = ["antigravity", "codex", "claude-code", "all"];
const PEER_AGENT_ENUM = ["antigravity", "codex", "claude-code"];

export const BRIDGE_TOOL_PROFILES = Object.freeze([
  "full",
  "lead",
  "worker",
  "exec_only",
]);

export const WORKER_BRIDGE_TOOLS = Object.freeze([
  "bridge_get_task_overview",
  "bridge_read_messages",
  "bridge_read_card",
  "bridge_send_message",
  "bridge_submit_task_receipt",
  "bridge_submit_patch",
  "bridge_handback",
]);

export function resolveBridgeToolProfile(explicitProfile = null) {
  const raw = String(
    explicitProfile || process.env.BRIDGE_TOOL_PROFILE || "full"
  )
    .trim()
    .toLowerCase();
  if (!BRIDGE_TOOL_PROFILES.includes(raw)) {
    throw new Error(
      `Invalid BRIDGE_TOOL_PROFILE "${raw}". Expected one of: ${BRIDGE_TOOL_PROFILES.join(", ")}`
    );
  }
  return raw;
}

/**
 * Register bridge communication, preflight, patch, and lifecycle tools on an MCP server.
 */
export function registerBridgeTools(
  server,
  bridgeDb,
  { defaultCaller = "antigravity", defaultTarget = "codex", toolProfile = null } = {}
) {
  const callerAgent = process.env.MCP_CALLER_AGENT || defaultCaller;
  const targetAgent = process.env.MCP_TARGET_AGENT || defaultTarget;
  const resolvedProfile = resolveBridgeToolProfile(toolProfile);
  if (resolvedProfile === "exec_only") {
    return {
      toolProfile: resolvedProfile,
      registeredBridgeTools: [],
      researchMemoryMode: "none",
    };
  }

  const researchMemoryMode = resolvedProfile === "worker" ? "readonly" : "full";
  registerResearchMemoryTools(server, {
    caller: callerAgent,
    mode: researchMemoryMode,
  });

  const registeredBridgeTools = [];
  const registerBridgeTool = (definition, handler) => {
    if (
      resolvedProfile === "worker" &&
      !WORKER_BRIDGE_TOOLS.includes(definition.name)
    ) {
      return;
    }
    registeredBridgeTools.push(definition.name);
    server.registerTool(definition, handler);
  };

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
  registerBridgeTool(
    {
      name: "bridge_send_message",
      description: "Send message by toAgent or replyTo; supports waitForDelivery coalescing.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          toAgent: { type: "string", enum: AGENT_ENUM },
          fromAgent: { type: "string", enum: PEER_AGENT_ENUM },
          replyTo: { type: "string" },
          taskId: { type: "string" },
          subject: { type: "string" },
          threadId: { type: "string" },
          metadata: { type: "object" },
          allowSelfSend: { type: "boolean" },
          waitForReply: { type: "boolean" },
          waitForDelivery: { type: "boolean" },
          settleMs: { type: "number" },
          timeoutMs: { type: "number" },
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
  registerBridgeTool(
    {
      name: "bridge_read_messages",
      description: `Read inbox (default '${callerAgent}') by afterSeq/taskId.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          toAgent: { type: "string" },
          fromAgent: { type: "string" },
          taskId: { type: "string" },
          threadId: { type: "string" },
          afterSeq: { type: "number" },
          unreadOnly: { type: "boolean" },
          markAsRead: { type: "boolean" },
          markConsumed: { type: "boolean" },
          consumeTurnId: { type: "string" },
          compactCards: { type: "boolean" },
          limit: { type: "number" },
        },
      },
    },
    async (args) => {
      const inboxOwner = args.toAgent || callerAgent;
      const markAsRead = args.markAsRead !== false;
      const messages = bridgeDb.readMessages({
        toAgent: inboxOwner,
        fromAgent: args.fromAgent || null,
        threadId: args.threadId || null,
        taskId: args.taskId || null,
        afterSeq: args.afterSeq ?? null,
        unreadOnly: Boolean(args.unreadOnly),
        markAsRead,
        markConsumed:
          args.markConsumed !== undefined ? Boolean(args.markConsumed) : markAsRead,
        consumeTurnId: args.consumeTurnId || null,
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
        ...(args.compactCards
          ? { cards: messages.map((m) => messageCard(m)) }
          : {}),
      };
    }
  );

  // ===========================================================================
  // 3. bridge_reply_message
  // ===========================================================================
  registerBridgeTool(
    {
      name: "bridge_reply_message",
      description: "Reply to message ID (inherits toAgent, threadId, taskId).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          replyTo: { type: "string" },
          content: { type: "string" },
          fromAgent: { type: "string", enum: PEER_AGENT_ENUM },
          subject: { type: "string" },
          decisionId: { type: "string", description: "Pending decision ID to answer." },
          eventId: { type: "string", description: "Decision answer idempotency key." },
          metadata: { type: "object" },
        },
        required: ["replyTo", "content"],
      },
    },
    async (args) => {
      let decisionAnswer = null;
      if (args.decisionId) {
        if (!args.eventId) throw new Error("eventId is required to answer a decision");
        const parent = bridgeDb.getMessageById(args.replyTo);
        if (!parent?.task_id) throw new Error("Decision reply must belong to a task");
        decisionAnswer = bridgeDb.answerTaskDecision({ taskId: parent.task_id,
          decisionId: args.decisionId, eventId: args.eventId, answer: args.content, actorAgent: callerAgent });
      }
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
        ...(decisionAnswer ? { decisionAnswer } : {}),
      };
    }
  );

  // ===========================================================================
  // 4. bridge_preflight_task [P0]
  // ===========================================================================
  registerBridgeTool(
    {
      name: "bridge_preflight_task",
      description: "Check tool/scope compatibility upfront and grant task lease.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          deliveryMode: { type: "string", enum: ["direct", "read_only", "mcp_structured_patch"] },
          isolationProfile: { type: "string", enum: ISOLATION_PROFILES },
          threadId: { type: "string" },
          runtime: { type: "string", enum: ["agy-cli", "antigravity-ide", "codex-cli", "claude-cli"] },
          cwd: { type: "string" },
          readRoots: { type: "array", items: { type: "string" } },
          writeRoots: { type: "array", items: { type: "string" } },
          requestedTools: { type: "array", items: { type: "string" } },
          allowedCommands: { type: "array", items: { type: "string" } },
          forbiddenOperations: { type: "array", items: { type: "string" } },
          alreadyGrantedTools: { type: "array", items: { type: "string" } },
          alreadyGrantedCommands: { type: "array", items: { type: "string" } },
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
  registerBridgeTool(
    {
      name: "bridge_create_task",
      description: "Create/reuse task with model/session binding, scope, and v2 contract.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          title: { type: "string" },
          prompt: { type: "string" },
          assignedTo: { type: "string", enum: PEER_AGENT_ENUM },
          fromAgent: { type: "string", enum: PEER_AGENT_ENUM },
          requiredModel: { type: "string" },
          requiredConversationId: { type: "string" },
          cwd: { type: "string" },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
          readRoots: { type: "array", items: { type: "string" } },
          writeRoots: { type: "array", items: { type: "string" } },
          requestedTools: { type: "array", items: { type: "string" } },
          allowedCommands: { type: "array", items: { type: "string" } },
          forbiddenOperations: { type: "array", items: { type: "string" } },
          deliveryMode: { type: "string", enum: ["direct", "read_only", "mcp_structured_patch"] },
          isolationProfile: { type: "string", enum: ISOLATION_PROFILES },
          threadId: { type: "string" },
          runtime: { type: "string", enum: ["agy-cli", "antigravity-ide", "codex-cli", "claude-cli"] },
          contract: { type: "object" },
          protocolVersion: { type: "integer", enum: [1, 2] },
          metadata: { type: "object" },
          waitForCompletion: { type: "boolean" },
          timeoutMs: { type: "number" },
        },
        required: ["prompt"],
      },
    },
    async (args) => {
      const original = args.taskId ? bridgeDb.getTaskById(args.taskId) : null;
      const assignedTo = args.assignedTo || original?.assigned_to || targetAgent;
      const cwd = args.cwd || original?.cwd || process.cwd();
      const defaults = original ? { contract: {}, forbiddenOperations: [] } : projectWorkflowDefaults(cwd);
      const protocolVersion = args.protocolVersion ?? (original ? original.metadata?.protocolVersion || 1 : 2);
      const permissions = {
        readRoots: args.readRoots || args.metadata?.readRoots || original?.permissions?.readRoots || [],
        writeRoots: args.writeRoots || args.metadata?.writeRoots || original?.permissions?.writeRoots || [],
        requestedTools: args.requestedTools || original?.permissions?.requestedTools || [],
        allowedCommands: args.allowedCommands || original?.permissions?.allowedCommands || [],
        forbiddenOperations: [...new Set([...defaults.forbiddenOperations, ...(args.forbiddenOperations || original?.permissions?.forbiddenOperations || [])])],
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
        contract: original || protocolVersion === 1 ? args.contract : { ...defaults.contract, ...args.contract },
        protocolVersion,
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
        metadata: {
          ...args.metadata,
          deliveryMode: preflight.deliveryMode,
          ...(args.isolationProfile
            ? { isolationProfile: args.isolationProfile }
            : {}),
          ...(args.threadId ? { threadId: args.threadId } : {}),
        },
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
  registerBridgeTool(
    {
      name: "bridge_list_tasks",
      description: "List tasks with lifecycle phase and binding metadata.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          assignedTo: { type: "string" },
          fromAgent: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "failed", "cancelled"] },
          phase: { type: "string", enum: Object.keys(PHASE_LABELS) },
          limit: { type: "number" },
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
  registerBridgeTool(
    {
      name: "bridge_claim_task",
      description: `Claim task for '${callerAgent}', checking model/session binding.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          agent: { type: "string", enum: PEER_AGENT_ENUM },
          model: { type: "string" },
          conversationId: { type: "string" },
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
  registerBridgeTool(
    {
      name: "bridge_submit_patch",
      description: "Submit task patch ('unified_diff' or 'baseline_copy') with path/hunk checks.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          patchId: { type: "string" },
          content: { type: "string" },
          artifactKind: { type: "string", enum: ["unified_diff", "baseline_copy"] },
          fromAgent: { type: "string", enum: PEER_AGENT_ENUM },
          toAgent: { type: "string", enum: PEER_AGENT_ENUM },
          model: { type: "string" },
          conversationId: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
          supersedes: { type: "string" },
          summary: { type: "string" },
          allowRecount: { type: "boolean", description: "Allow `git apply --recount` mismatch (default: false)." },
          cwd: { type: "string" },
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
  registerBridgeTool(
    {
      name: "bridge_list_patches",
      description: "List task patches and computed activeApplyOrder.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          activeOnly: { type: "boolean" },
          includeRawContent: { type: "boolean" },
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
  registerBridgeTool(
    {
      name: "bridge_get_patch",
      description: "Fetch patch by patchId, optionally saving or running git apply --check.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          patchId: { type: "string" },
          saveToPath: { type: "string" },
          checkApplyCwd: { type: "string" },
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
  registerBridgeTool(
    {
      name: "bridge_record_validation",
      description: "Record validation outcome, advance phase, notify assignee, and emit escalation hints.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          patchIds: { type: "array", items: { type: "string" } },
          applied: { type: "boolean" },
          passed: { type: "boolean" },
          summary: { type: "string" },
          validatorAgent: { type: "string", enum: PEER_AGENT_ENUM },
          details: { type: "object" },
          notifyAssignee: { type: "boolean" },
          waitForDelivery: { type: "boolean" },
          settleMs: { type: "number" },
          timeoutMs: { type: "number" },
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
      const jitExtra = res.jitGuidance ? { jitGuidance: res.jitGuidance } : {};

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
          ...jitExtra,
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
        ...jitExtra,
      };
    }
  );

  // ===========================================================================
  // 12. bridge_update_task_phase [P1]
  // ===========================================================================
  registerBridgeTool(
    {
      name: "bridge_update_task_phase",
      description: "Update task lifecycle phase.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          phase: { type: "string", enum: Object.keys(PHASE_LABELS) },
          result: { type: "string" },
          error: { type: "string" },
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
  registerBridgeTool(
    {
      name: "bridge_get_task_overview",
      description: "Get task phase, binding, lease, patches, validations, and cursor.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
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
  registerBridgeTool(
    {
      name: "bridge_poll_updates",
      description: "Poll events since afterSeq with optional waitMs and settleMs.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          afterSeq: { type: "number" },
          toAgent: { type: "string" },
          taskId: { type: "string" },
          markMessagesRead: { type: "boolean" },
          waitMs: { type: "number" },
          settleMs: { type: "number" },
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
  registerBridgeTool(
    {
      name: "bridge_wait_for_delivery",
      description: "Wait for coalesced task updates; reports updatesReceived, artifacts, and host receipt separately.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          toAgent: { type: "string", enum: AGENT_ENUM },
          afterSeq: { type: "number" },
          settleMs: { type: "number" },
          timeoutMs: { type: "number" },
          markMessagesRead: { type: "boolean" },
          deliverToHost: { type: "boolean" },
          confirmDelivery: { type: "boolean" },
          receipt: { type: "object", additionalProperties: true },
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
  registerBridgeTool(
    {
      name: "bridge_configure_wakeup_route",
      description: "Configure, inspect, or confirm a task's wakeup route.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          threadId: { type: "string" },
          toAgent: { type: "string", enum: PEER_AGENT_ENUM },
          targetSessionId: { type: "string" },
          driver: {
            type: "string",
            enum: ["host_poll", "codex_ipc", "app_server_ws", "custom_command", "cli_resume", "manual"],
          },
          model: { type: "string" },
          effort: { type: "string" },
          wakeupCommand: { type: "string" },
          appServerUrl: { type: "string" },
          cwd: { type: "string" },
          enabled: { type: "boolean" },
          coalesceMs: { type: "number" },
          deliverPendingNow: { type: "boolean" },
          confirmReceipt: { type: "object", additionalProperties: true },
        },
        required: ["taskId"],
      },
    },
    async (args) => {
      let route = bridgeDb.getWakeupRoute(args.taskId, args.toAgent || null);
      const configurationKeys = ["threadId", "toAgent", "targetSessionId", "driver", "wakeupCommand", "appServerUrl", "cwd", "enabled", "model", "effort"];
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
          model: args.model ?? route?.model ?? null,
          effort: args.effort ?? route?.effort ?? null,
        });
      }
      if (!route && (args.confirmReceipt || args.deliverPendingNow)) throw new Error("No configured wakeup route for this task");

      let deliveryOutcome = null;
      if (args.confirmReceipt) {
        deliveryOutcome = bridgeDb.confirmWakeupDelivery({
          taskId: args.taskId,
          receipt: args.confirmReceipt,
          toAgent: args.toAgent || route?.to_agent || null,
        });
        route = deliveryOutcome.route || bridgeDb.getWakeupRoute(args.taskId, args.toAgent || null);
      } else if (args.deliverPendingNow) {
        deliveryOutcome = await bridgeDb.executeWakeupDelivery(args.taskId, {
          includeDispatched: true,
          toAgent: args.toAgent || route?.to_agent || null,
        });
        route = deliveryOutcome.route || bridgeDb.getWakeupRoute(args.taskId, args.toAgent || null);
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
  registerBridgeTool(
    {
      name: "bridge_complete_task",
      description: "Complete/fail/cancel task and revoke its permission lease.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          status: { type: "string", enum: ["completed", "failed", "cancelled"] },
          result: { type: "string" },
          error: { type: "string" },
          sessionId: { type: "string" },
          model: { type: "string" },
        },
        required: ["taskId"],
      },
    },
    async (args) => {
      const updated = bridgeDb.completeTask({
        taskId: args.taskId,
        actorAgent: callerAgent,
        status: args.status || "completed",
        result: args.result || null,
        error: args.error || null,
        sessionId: args.sessionId || null,
        model: args.model || null,
      });
      if (!updated) {
        throw new Error(`Task not found: ${args.taskId}`);
      }
      const task = bridgeDb.getTaskById(args.taskId);
      return {
        ok: true,
        task,
        binding: task.binding,
        revokedLease: updated.revokedLease,
        ...(updated.accepted !== undefined ? { businessReceipt: updated } : {}),
      };
    }
  );

  const registerWorkflow = (name, description, properties, required, method) => {
    registerBridgeTool({ name, description, inputSchema: {
      type: "object", additionalProperties: false, properties, required,
      ...(name === "bridge_submit_task_receipt" ? { anyOf: [
        { properties: { operation: { const: "receipt" } }, required: ["receiptId", "attemptId", "contractVersion", "ownerEpoch", "outcome"] },
        { properties: { operation: { const: "signal" } }, required: ["operation", "eventId", "triggerEvent", "sourceRef"] },
      ] } : {}),
    } }, async args => {
      const { operation, ...payload } = args;
      const handler = name === "bridge_submit_task_receipt" && operation === "signal" ? "signalTaskEvent" : method;
      return { ok: true, result: bridgeDb[handler]({ ...payload, actorAgent: callerAgent }) };
    });
  };
  const taskIdField = { type: "string", minLength: 1 };
  const versionField = { type: "integer", minimum: 1 };
  registerWorkflow("bridge_update_task_contract", "Revise contract with expectedVersion and sourceRefs.", {
    taskId: taskIdField, eventId: taskIdField, expectedVersion: versionField,
    contract: { type: "object" }, sourceRefs: { type: "array", items: { type: "string" } },
  }, ["taskId", "eventId", "expectedVersion", "contract", "sourceRefs"], "updateTaskContract");
  registerWorkflow("bridge_submit_task_receipt", "Submit idempotent task receipt/signal.", {
    taskId: taskIdField, receiptId: taskIdField, attemptId: taskIdField,
    operation: { type: "string", enum: ["receipt", "signal"] },
    eventId: taskIdField, triggerEvent: taskIdField, sourceRef: taskIdField,
    contractVersion: versionField, ownerEpoch: versionField,
    outcome: { type: "string", enum: ["progress", "waiting_external", "waiting_user", "retryable_failure", "delivered", "cancelled", "blocked"] },
    summary: { type: "string" }, artifacts: { type: "array" },
    completedSteps: { type: "array" }, remainingWork: { type: "array" },
    continuation: { type: ["object", "null"] }, incident: { type: "object" }, decision: { type: "object" }, handoff: { type: "object" },
  }, ["taskId"], "submitTaskReceipt");
  registerWorkflow("bridge_accept_task_delivery", "Record delivery acceptance with evidence.", {
    taskId: taskIdField, eventId: taskIdField, contractVersion: versionField, ownerEpoch: versionField,
    deliveryReceiptId: taskIdField,
    evidence: { type: "array" }, summary: { type: "string" },
  }, ["taskId", "eventId", "contractVersion", "ownerEpoch", "deliveryReceiptId", "evidence"], "acceptTaskDelivery");
  registerWorkflow("bridge_answer_task_decision", "Answer pending decision and schedule continuation.", {
    taskId: taskIdField, decisionId: taskIdField, eventId: taskIdField, answer: { type: "string", minLength: 1 },
  }, ["taskId", "decisionId", "eventId", "answer"], "answerTaskDecision");

  // ===========================================================================
  // 16. bridge_set_context
  // ===========================================================================
  registerBridgeTool(
    {
      name: "bridge_set_context",
      description: "Set a shared context entry.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          value: { type: "string" },
          description: { type: "string" },
          contentType: { type: "string" },
          updatedBy: { type: "string" },
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
  registerBridgeTool(
    {
      name: "bridge_get_context",
      description: "Get shared context entry by key, or list keys.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
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
  registerBridgeTool(
    {
      name: "bridge_status",
      description: "Get overall bridge status (cursor, unread, tasks, leases, sessions).",
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
        runtime: bridgeDb.getRuntimeInfo(),
      };
    }
  );

  // ===========================================================================
  // 19. bridge_subscribe_thread (v1.0.0 Research Router)
  // ===========================================================================
  registerBridgeTool(
    {
      name: "bridge_subscribe_thread",
      description: "Manage Router subscriptions ('direct'/'context'); rejects blind_* tasks.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          threadId: { type: "string" },
          taskId: { type: "string" },
          mode: { type: "string", enum: SUBSCRIPTION_MODES },
          active: { type: "boolean" },
          listOnly: { type: "boolean" },
        },
      },
    },
    async (args) => {
      if (args.listOnly || (!args.threadId && !args.taskId) || !args.threadId || !args.taskId) {
        if (args.listOnly || (!args.mode && args.active === undefined)) {
          return {
            ok: true,
            subscriptions: bridgeDb.listSubscriptions({
              threadId: args.threadId || null,
              taskId: args.taskId || null,
            }),
          };
        }
      }
      const subscription = bridgeDb.subscribeThread({
        threadId: args.threadId,
        taskId: args.taskId,
        mode: args.mode || "direct",
        active: args.active !== false,
      });
      return {
        ok: true,
        subscription,
      };
    }
  );

  // ===========================================================================
  // 20. bridge_handback (v1.0.0 Research Router Ownership Release & Escalation)
  // ===========================================================================
  registerBridgeTool(
    {
      name: "bridge_handback",
      description: "Release task ownership and escalate to Lead or Human Attention.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          messageId: { type: "string" },
          fromAgent: { type: "string", enum: PEER_AGENT_ENUM },
          reasonCode: { type: "string", enum: HANDOFF_REASON_CODES },
          summary: { type: "string" },
          humanAction: {
            type: "object",
            additionalProperties: false,
            properties: {
              question: { type: "string" },
              options: { type: "array", items: { type: "string" } },
              blockingScope: { type: "string" },
            },
            required: ["question"],
          },
        },
        required: ["taskId", "reasonCode", "summary"],
      },
    },
    async (args) => {
      return bridgeDb.handback({
        taskId: args.taskId,
        messageId: args.messageId || null,
        fromAgent: bridgeDb.getTaskById(args.taskId)?.metadata?.workflow ? callerAgent : args.fromAgent || callerAgent,
        reasonCode: args.reasonCode,
        summary: args.summary,
        humanAction: args.humanAction || null,
      });
    }
  );

  // ===========================================================================
  // 21. bridge_read_card (v1.0.0 Inline Cards & Spill Pagination)
  // ===========================================================================
  registerBridgeTool(
    {
      name: "bridge_read_card",
      description: "Read Inline Card or paginated Spill content by `bridge://<kind>/<id>`.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          uri: { type: "string" },
          kind: { type: "string", enum: ["message", "task", "patch", "validation", "context", "decision"] },
          id: { type: "string" },
          field: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
      },
    },
    async (args) => {
      const result = bridgeDb.readCard({
        uri: args.uri || null,
        kind: args.kind || null,
        id: args.id || null,
        field: args.field || null,
        offset: args.offset ?? 0,
        limit: args.limit ?? 4000,
      });
      return {
        ok: true,
        ...result,
      };
    }
  );

  // ===========================================================================
  // 22. bridge_watchdog_status (v1.0.0 Dual-Layer Watchdog & HealthBoard)
  // ===========================================================================
  registerBridgeTool(
    {
      name: "bridge_watchdog_status",
      description: "Inspect HealthBoard, effects, slots, router, and optional L1/L2 sweep.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          runSweep: { type: "boolean" },
        },
      },
    },
    async (args) => {
      const sweep = args.runSweep ? bridgeDb.runWatchdogSweep() : undefined;
      return {
        ok: true,
        ...bridgeDb.getWatchdogStatus(),
        ...(sweep ? { sweep } : {}),
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

  return {
    toolProfile: resolvedProfile,
    registeredBridgeTools,
    researchMemoryMode,
  };
}

import * as workflow from './task-workflow.mjs';
import crypto from "node:crypto";
import { beginDeliveryMetadata, deliveryAttempts, deliveryState, finishDeliveryMetadata,
  notificationEnvelope, retryDue } from "../core/wakeup-policy.mjs";
import {
  BridgeUserError,
  PHASE_LABELS,
  REASONS,
  ROUTER_MODES,
  attentionStage,
  computePatchApplyOrder,
  isBlindIsolated,
  sha256Hex,
  verifyModelMatch,
} from "./model.mjs";
import {
  buildPolicySnapshot,
  createMandate,
  diffPolicyEffects,
} from "./policy.mjs";
import {
  defaultTaskThreadId,
  validateRoutingNote,
  validateThreadSubscription,
} from "./intake.mjs";
import { evaluateHandback, evaluateInboundEvent } from "./router-eval.mjs";
import {
  attentionCard,
  messageCard,
  parseCardUri,
  patchCard,
  taskCard,
  textPage,
  validationCard,
} from "./cards.mjs";

const ATTENTION_PRIORITY = {
  "person/delivery_failed": 1,
  "person/permission_delta": 2,
  "person/answer": 3,
  "person/stall_detected": 4,
  "person/review": 5,
  "observe/would_dispatch": 6,
};

/**
 * Pure zero-I/O Domain Engine for multi-agent research orchestration.
 * Operates exclusively against a synchronous transactional Repository contract (`MemoryRepositories` or `SqliteStore`)
 * and emits side effects declaratively into the durable `Effects` table + `afterCommit` listeners.
 */
export class BridgeEngine {
  /**
   * @param {object} options
   * @param {import('./memory-repos.mjs').MemoryRepositories} options.repos
   * @param {() => Date} [options.clock]
   * @param {() => boolean} [options.isWakeupGuarded]
   * @param {() => string} [options.defaultCwd]
   * @param {(pid: number) => boolean} [options.isPidAlive]
   */
  constructor({
    repos,
    clock = () => new Date(),
    isWakeupGuarded = () => false,
    defaultCwd = () => "",
    isPidAlive = () => true,
  }) {
    if (!repos) {
      throw new Error("BridgeEngine requires a repository implementation");
    }
    this.repos = repos;
    this.clock = clock;
    this.isWakeupGuarded = isWakeupGuarded;
    this.defaultCwd = defaultCwd;
    this.isPidAlive = isPidAlive;
    this.onMessageCommitted = null;
    this.onEffectsEnqueued = null;

    this._ensureInitialPolicy();
  }

  _nowIso() {
    return this.clock().toISOString();
  }

  _nowMs() {
    return this.clock().getTime();
  }

  _ensureInitialPolicy() {
    const ctrl = this.repos.getControl();
    if (!ctrl.control_version) {
      const snap = buildPolicySnapshot({
        controlsText: "",
        routerMode: ctrl.router_mode || "observe",
      });
      this.repos.atomic(() => {
        this.repos.setControl({
          router_mode: snap.routerMode,
          control_version: snap.controlVersion,
          controls_hash: snap.controlsHash,
        });
      });
    }
  }

  getCurrentPolicy(overrides = {}) {
    const ctrl = this.repos.getControl();
    return {
      routerMode: overrides.routerMode || ctrl.router_mode || "observe",
      acceptMode: overrides.acceptMode || overrides.routerMode || ctrl.router_mode || "observe",
      controlVersion: overrides.controlVersion || ctrl.control_version || "",
      controlsHash: overrides.controlsHash || ctrl.controls_hash || "",
      allowedPeers: overrides.allowedPeers || [
        "antigravity",
        "codex",
        "claude-code",
      ],
    };
  }

  // ===========================================================================
  // Control, Policy & Admission
  // ===========================================================================

  getControlState() {
    const row = this.repos.getControl();
    return {
      paused: Boolean(row.paused),
      changedAt: row.changed_at || null,
      reason: row.reason || null,
      routerMode: row.router_mode || "observe",
      controlVersion: row.control_version || "",
      controlsHash: row.controls_hash || "",
    };
  }

  setControlState({ paused, reason = null, routerMode = undefined }) {
    if (typeof paused !== "boolean") {
      throw new Error("paused must be a boolean");
    }
    if (routerMode !== undefined && !ROUTER_MODES.includes(routerMode)) {
      throw new BridgeUserError(
        REASONS.INVALID_ROUTER_MODE,
        `Invalid routerMode '${routerMode}': expected 'off', 'observe', or 'auto'.`
      );
    }

    return this.repos.atomic(() => {
      const patch = {
        paused: Boolean(paused),
        changed_at: this._nowIso(),
        reason,
      };
      if (routerMode !== undefined) {
        patch.router_mode = routerMode;
      }
      this.repos.setControl(patch);

      if (!paused) {
        const enabledRoutes = this.repos.listRoutes({ enabledOnly: true });
        for (const r of enabledRoutes) {
          if (r.driver === "manual") continue;
          const pending = this.repos.queryMessages({
            toAgent: r.to_agent,
            taskId: r.task_id,
            unreadOnly: true,
            limit: 20,
          });
          const hasPending = pending.some((m) => m.wakeup_status === "pending");
          if (hasPending) {
            this._enqueueEffect({
              kind: "wakeup",
              effectKey: r.task_id,
              payload: { taskId: r.task_id, reason: "bridge_resumed" },
            });
          }
        }
      }
      return this.getControlState();
    });
  }

  setRouterMode({ mode, reason = null, controlsText = null, allowedPeers = null }) {
    if (!ROUTER_MODES.includes(mode)) {
      throw new BridgeUserError(
        REASONS.INVALID_ROUTER_MODE,
        `Invalid router mode '${mode}': expected 'off', 'observe', or 'auto'.`,
        { mode }
      );
    }
    return this.syncPolicy({
      controlsText,
      routerMode: mode,
      allowedPeers,
      reason,
    });
  }

  /**
   * Synchronize `controls.md` content and/or `routerMode` into `controlVersion`,
   * emitting non-destructive `control_changed` notices to affected live tasks.
   */
  syncPolicy({
    controlsText = null,
    routerMode = null,
    allowedPeers = null,
    reason = null,
  } = {}) {
    return this.repos.atomic(() => {
      const ctrl = this.repos.getControl();
      const prevMode = ctrl.router_mode || "observe";
      const nextMode = routerMode || prevMode;

      const prevSnap = {
        routerMode: prevMode,
        acceptMode: prevMode,
        controlVersion: ctrl.control_version || "",
        controlsHash: ctrl.controls_hash || "",
        allowedPeers: ["antigravity", "codex", "claude-code"],
      };

      let nextSnap;
      if (controlsText !== null && controlsText !== undefined) {
        nextSnap = buildPolicySnapshot({
          controlsText,
          routerMode: nextMode,
          allowedPeers: allowedPeers || prevSnap.allowedPeers,
        });
      } else {
        // Recompute version preserving existing controlsHash when controlsText was not re-read
        const effectivePeers = Array.isArray(allowedPeers)
          ? [...new Set(allowedPeers)].sort()
          : prevSnap.allowedPeers;
        const controlsHash =
          ctrl.controls_hash || sha256Hex("").slice(0, 16);
        const controlVersion = `ctrl_${sha256Hex(
          JSON.stringify({
            controlsHash,
            acceptMode: nextMode,
            allowedPeers: effectivePeers,
          })
        ).slice(0, 16)}`;
        nextSnap = {
          controlsHash,
          acceptMode: nextMode,
          routerMode: nextMode,
          allowedPeers: effectivePeers,
          controlVersion,
        };
      }

      const changed =
        prevSnap.controlVersion !== nextSnap.controlVersion ||
        prevMode !== nextMode;

      if (!changed) {
        return {
          changed: false,
          control: this.getControlState(),
          notices: [],
        };
      }

      const nowIso = this._nowIso();
      this.repos.setControl({
        router_mode: nextMode,
        control_version: nextSnap.controlVersion,
        controls_hash: nextSnap.controlsHash,
        ...(reason !== null ? { reason, changed_at: nowIso } : {}),
      });

      const liveTasks = this.repos
        .listTasks({ limit: 200 })
        .filter((t) => !["completed", "failed", "cancelled"].includes(t.status));
      const mandatesMap = new Map(
        this.repos.listMandates().map((m) => [m.task_id, m])
      );

      const notices = diffPolicyEffects(
        liveTasks,
        mandatesMap,
        prevSnap,
        nextSnap
      );

      for (const notice of notices) {
        this._enqueueEffect({
          kind: "control_notice",
          effectKey: notice.taskId,
          payload: notice,
        });
        if (notice.assignedTo) {
          this._insertRawMessage({
            fromAgent: "codex",
            toAgent: notice.assignedTo,
            threadId: `example-${notice.taskId}`,
            taskId: notice.taskId,
            subject: `[Control Update] ${notice.prevControlVersion} -> ${notice.nextControlVersion}`,
            content: notice.summary,
            metadata: {
              event: "control_changed",
              isRouterEscalation: true,
              prevControlVersion: notice.prevControlVersion,
              nextControlVersion: notice.nextControlVersion,
              reasons: notice.reasons,
              taskId: notice.taskId,
            },
            allowSelfSend: true,
          });
        }
      }

      return {
        changed: true,
        control: this.getControlState(),
        notices,
      };
    });
  }

  admitExecution() {
    return this.repos.atomic(() => {
      if (this.getControlState().paused) {
        throw new BridgeUserError(
          REASONS.BRIDGE_PAUSED,
          "Bridge is paused; new execution and automatic continuation are held"
        );
      }
      return { admitted: true, admittedAt: this._nowIso() };
    });
  }

  nextSeq() {
    return this.repos.nextSeq();
  }

  getCurrentSeq() {
    return this.repos.getCurrentSeq();
  }

  _enqueueEffect({
    kind,
    effectKey,
    payload = {},
    priority = "normal",
    dueMs = this._nowMs(),
  }) {
    const rec = this.repos.enqueueEffect({
      kind,
      effectKey,
      payload,
      priority,
      dueMs,
      nowIso: this._nowIso(),
    });
    this.repos.afterCommit(() => {
      if (typeof this.onEffectsEnqueued === "function") {
        try {
          this.onEffectsEnqueued(rec);
        } catch {
          // ignore
        }
      }
    });
    return rec;
  }

  // ===========================================================================
  // Tasks, Mandates & Leases
  // ===========================================================================

  createTask({
    taskId = null,
    fromAgent,
    assignedTo,
    title,
    prompt,
    cwd = "",
    priority = "normal",
    requiredModel = null,
    actualModel = null,
    requiredConversationId = null,
    boundConversationId = null,
    permissions = {},
    sessionId = null,
    metadata = {},
    contract = null,
    protocolVersion = null,
  }) {
    return this.repos.atomic(() => {
      if (taskId) {
        const existing = this.repos.getTask(taskId);
        if (existing) {
          const conflicts = [];
          const check = (name, value, original) => {
            if (
              value !== null &&
              value !== undefined &&
              value !== "" &&
              JSON.stringify(value) !== JSON.stringify(original)
            ) {
              conflicts.push(name);
            }
          };
          check("fromAgent", fromAgent, existing.from_agent);
          check("assignedTo", assignedTo, existing.assigned_to);
          check("cwd", cwd, existing.cwd);
          check(
            "requiredModel",
            requiredModel || metadata?.requiredModel || metadata?.model,
            existing.required_model
          );
          check(
            "requiredConversationId",
            requiredConversationId ||
              metadata?.requiredConversationId ||
              sessionId,
            existing.required_conversation_id
          );
          check(
            "deliveryMode",
            metadata?.deliveryMode,
            existing.metadata?.deliveryMode || "direct"
          );
          for (const key of Object.keys(permissions || {})) {
            check(
              `permissions.${key}`,
              permissions[key],
              existing.permissions[key]
            );
          }
          if (conflicts.length) {
            throw new BridgeUserError(
              REASONS.TASK_SCOPE_CONFLICT,
              `Task reuse conflicts with original scope: ${conflicts.join(", ")}`,
              { conflicts }
            );
          }
          return existing;
        }
      }

      const id = taskId || crypto.randomUUID();
      const now = this._nowIso();
      const reqModel =
        requiredModel || metadata?.requiredModel || metadata?.model || null;
      const reqConv =
        requiredConversationId ||
        metadata?.requiredConversationId ||
        metadata?.conversationId ||
        sessionId ||
        null;
      const boundConv = boundConversationId || sessionId || reqConv || null;

      const mergedPermissions = { ...(permissions || {}) };
      if (
        Array.isArray(metadata?.writeRoots) &&
        !mergedPermissions.writeRoots
      ) {
        mergedPermissions.writeRoots = metadata.writeRoots;
      }
      if (Array.isArray(metadata?.readRoots) && !mergedPermissions.readRoots) {
        mergedPermissions.readRoots = metadata.readRoots;
      }

      const initialPhase = "ready";
      const ctrl = this.repos.getControl();

      const savedTask = this.repos.putTask({
        id,
        from_agent: fromAgent,
        assigned_to: assignedTo,
        title: title || String(prompt || "").slice(0, 80),
        prompt,
        cwd,
        priority,
        status: "pending",
        phase: initialPhase,
        phase_label: PHASE_LABELS[initialPhase],
        required_model: reqModel,
        actual_model: actualModel,
        required_conversation_id: reqConv,
        bound_conversation_id: boundConv,
        delivery_version: 0,
        permissions: mergedPermissions,
        lease_status: "none",
        result: null,
        error: null,
        session_id: boundConv,
        metadata: { ...(metadata || {}) },
        created_at: now,
        updated_at: now,
        completed_at: null,
      });

      if (contract || protocolVersion === 2 || metadata?.protocolVersion === 2) {
        savedTask.metadata = { ...savedTask.metadata, protocolVersion: 2, workflow: workflow.initialWorkflow(savedTask, contract || {}) };
        this.repos.putTask(savedTask);
      }
      const mandate = createMandate({
        task: savedTask,
        controlVersion: ctrl.control_version || "",
        controlsHash: ctrl.controls_hash || "",
        strength: metadata?.mandateStrength || "explicit",
        isolationProfile: metadata?.isolationProfile || null,
        matchedRuleIds: Array.isArray(metadata?.matchedRuleIds)
          ? metadata.matchedRuleIds
          : [],
        nowIso: now,
      });
      this.repos.putMandate(mandate);

      // Automatically subscribe shared tasks to their primary thread for zero-LLM Router fan-out
      if (
        !isBlindIsolated(mandate) &&
        metadata?.autoSubscribeThread !== false
      ) {
        const primaryThreadId = defaultTaskThreadId(savedTask);
        this.repos.putSubscription({
          thread_id: primaryThreadId,
          task_id: savedTask.id,
          mode: "direct",
          active: 1,
          created_at: now,
        });
      }

      return savedTask;
    });
  }

  updateTaskContract(args) { return workflow.updateTaskContract(this, args); }
  submitTaskReceipt(args) { return workflow.submitTaskReceipt(this, args); }
  acceptTaskDelivery(args) { return workflow.acceptTaskDelivery(this, args); }
  answerTaskDecision(args) { return workflow.answerTaskDecision(this, args); }
  processTaskContinuation(args) { return workflow.processTaskContinuation(this, args); }
  signalTaskEvent(args) { return workflow.signalTaskEvent(this, args); }

  getTaskById(id) {
    return this.repos.getTask(id);
  }

  getMandate(taskId) {
    return this.repos.getMandate(taskId);
  }

  verifyAndBindTask({
    taskId,
    actualModel = null,
    conversationId = null,
    modelSource = "caller_declared",
    strictModel = true,
  }) {
    return this.repos.atomic(() => {
      const task = this.repos.getTask(taskId);
      if (!task) {
        throw new BridgeUserError(
          REASONS.TASK_NOT_FOUND,
          `Task not found: ${taskId}`
        );
      }

      const reported = [
        "runtime_init_metadata",
        "runtime_event_metadata",
        "claude_json_output",
        "python_sdk_runtime",
      ].includes(modelSource);
      const effectiveActualModel = actualModel || task.actual_model;
      const completingVerified =
        modelSource === "complete_task" &&
        task.metadata?.modelEvidence === "runtime_reported" &&
        task.actual_model &&
        (!actualModel || verifyModelMatch(task.actual_model, actualModel).ok);

      if (
        task.metadata?.requireVerifiedModel &&
        !completingVerified &&
        ![
          "claim_task",
          "submit_patch",
          "caller_declared",
          "antigravity_exec_request",
        ].includes(modelSource) &&
        (!reported || !actualModel)
      ) {
        throw new BridgeUserError(
          REASONS.MODEL_UNVERIFIED,
          "Required runtime model evidence is missing"
        );
      }

      if (task.required_model && (strictModel || effectiveActualModel)) {
        const modelCheck = verifyModelMatch(
          task.required_model,
          effectiveActualModel,
          modelSource
        );
        if (!modelCheck.ok) {
          throw new BridgeUserError(modelCheck.code, modelCheck.error);
        }
      }

      if (
        (task.required_conversation_id || task.bound_conversation_id) &&
        conversationId !==
          (task.required_conversation_id || task.bound_conversation_id)
      ) {
        throw new BridgeUserError(
          REASONS.CONVERSATION_MISMATCH,
          `Conversation ID mismatch for task '${taskId}': task is strictly bound to conversation '${task.required_conversation_id}', but received '${conversationId}'.`
        );
      }

      const now = this._nowIso();
      const newActualModel = reported
        ? actualModel
        : task.actual_model || null;
      const nextMetadata = {
        ...task.metadata,
        lastModelObservation: {
          source: modelSource,
          reportedModel: reported ? actualModel : null,
          evidence:
            reported && actualModel ? "runtime_reported" : "unverified",
        },
        modelEvidence:
          reported && actualModel
            ? "runtime_reported"
            : task.metadata?.modelEvidence || "unverified",
        modelSource,
        requestedModel: task.required_model || actualModel || null,
      };
      const newBoundConv =
        conversationId ||
        task.bound_conversation_id ||
        task.required_conversation_id ||
        null;

      return this.repos.putTask({
        ...task,
        actual_model: newActualModel || task.actual_model || null,
        bound_conversation_id:
          newBoundConv || task.bound_conversation_id || null,
        session_id: newBoundConv || task.session_id || null,
        metadata: nextMetadata,
        updated_at: now,
      });
    });
  }

  listTasks(args = {}) {
    return this.repos.listTasks(args);
  }

  claimTask({
    taskId = null,
    agent,
    model = null,
    conversationId = null,
  }) {
    return this.repos.atomic(() => {
      let targetId = taskId;
      if (!targetId) {
        targetId = this.repos.findNextClaimableTask(agent);
        if (!targetId) return null;
      }

      const existing = this.repos.getTask(targetId);
      if (!existing) return null;

      if (existing.assigned_to !== agent) {
        throw new Error("Task participant mismatch");
      }
      if (existing.required_conversation_id && !conversationId) {
        throw new Error("Required execution conversation identity is missing");
      }

      if (existing.required_model && model) {
        this.verifyAndBindTask({
          taskId: targetId,
          actualModel: model,
          conversationId,
          modelSource: "claim_task",
        });
      } else if (model || conversationId) {
        this.verifyAndBindTask({
          taskId: targetId,
          actualModel: model,
          conversationId,
          modelSource: "claim_task",
          strictModel: Boolean(existing.required_model && model),
        });
      }

      const refreshed = this.repos.getTask(targetId);
      const nextPhase =
        refreshed.phase === "ready" || refreshed.phase === "pending_preflight"
          ? "in_progress"
          : refreshed.phase;

      return this.repos.putTask({
        ...refreshed,
        status: "in_progress",
        phase: nextPhase,
        phase_label: PHASE_LABELS[nextPhase] || nextPhase,
        updated_at: this._nowIso(),
      });
    });
  }

  updateTaskPhase({
    taskId,
    phase,
    result = null,
    error = null,
  }) {
    return this.repos.atomic(() => {
      const task = this.repos.getTask(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const now = this._nowIso();
      const phaseLabel = PHASE_LABELS[phase] || phase;

      let status = task.status;
      if (phase === "completed") status = "completed";
      else if (phase === "failed") status = "failed";
      else if (phase === "cancelled") status = "cancelled";
      else if (status === "pending") status = "in_progress";

      const isTerminal = ["completed", "failed", "cancelled"].includes(status);

      this.repos.putTask({
        ...task,
        status,
        phase,
        phase_label: phaseLabel,
        result: result ?? task.result,
        error: error ?? task.error,
        updated_at: now,
        completed_at: isTerminal ? now : task.completed_at,
      });

      if (isTerminal) {
        this.revokeTaskLease(taskId);
      }

      return this.repos.getTask(taskId);
    });
  }

  completeTask({
    taskId,
    status = "completed",
    phase = null,
    result = null,
    error = null,
    sessionId = null,
    model = null,
    actorAgent = null,
  }) {
    return this.repos.atomic(() => {
      if (model || sessionId) {
        this.verifyAndBindTask({
          taskId,
          actualModel: model,
          conversationId: sessionId,
          modelSource: "complete_task",
          strictModel: Boolean(model),
        });
      }

      const task = this.repos.getTask(taskId);
      if (!task) return null;

      if (task.metadata?.workflow) {
        const w = task.metadata.workflow;
        if (!actorAgent) throw new Error('Protocol 2 completion requires the authenticated actor');
        return this.submitTaskReceipt({ taskId, receiptId: `legacy-complete:${w.owner.epoch}:${w.contract.version}:${sha256Hex(JSON.stringify({status,result,error}))}`, attemptId: `legacy:${taskId}`, contractVersion: w.contract.version, ownerEpoch: w.owner.epoch, outcome: status === 'completed' ? 'delivered' : status === 'cancelled' ? 'cancelled' : 'blocked', summary: result || error || '', actorAgent });
      }

      const resolvedPhase =
        phase ||
        (status === "completed"
          ? "completed"
          : status === "cancelled"
            ? "cancelled"
            : "failed");
      const phaseLabel = PHASE_LABELS[resolvedPhase] || resolvedPhase;
      const now = this._nowIso();

      this.repos.putTask({
        ...task,
        status,
        phase: resolvedPhase,
        phase_label: phaseLabel,
        result: result ?? task.result,
        error: error ?? task.error,
        session_id: sessionId ?? task.session_id,
        updated_at: now,
        completed_at: now,
      });

      const revokedLease = this.revokeTaskLease(taskId);
      const updatedTask = this.repos.getTask(taskId);
      return {
        ...updatedTask,
        revokedLease,
      };
    });
  }

  grantTaskLease({ taskId, agent, permissions = {}, preflight = {} }) {
    return this.repos.atomic(() => {
      if (!preflight.ok) {
        throw new Error("Cannot record a ready lease for failed preflight");
      }
      const task = this.repos.getTask(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      for (const key of [
        "readRoots",
        "writeRoots",
        "allowedCommands",
        "forbiddenOperations",
      ]) {
        if (
          JSON.stringify(permissions[key] || []) !==
          JSON.stringify(task.permissions[key] || [])
        ) {
          throw new Error(`Preflight cannot amend task scope: ${key}`);
        }
      }
      const now = this._nowIso();
      const lease = this.repos.putLease({
        taskId,
        agent,
        permissions,
        preflight,
        status: "active",
        grantedAt: now,
        revokedAt: null,
      });
      this.repos.putTask({
        ...task,
        permissions,
        lease_status: "active",
        updated_at: now,
      });
      return lease;
    });
  }

  getTaskLease(taskId) {
    return this.repos.getLease(taskId);
  }

  revokeTaskLease(taskId) {
    return this.repos.atomic(() => {
      const existing = this.repos.getLease(taskId);
      if (!existing || existing.status === "revoked") {
        return existing;
      }
      const now = this._nowIso();
      const updatedLease = this.repos.putLease({
        ...existing,
        status: "revoked",
        revokedAt: now,
      });
      const task = this.repos.getTask(taskId);
      if (task) {
        this.repos.putTask({
          ...task,
          lease_status: "revoked",
          updated_at: now,
        });
      }
      return updatedLease;
    });
  }

  // ===========================================================================
  // Subscriptions, Router, Handback & Messaging
  // ===========================================================================

  subscribeThread({ threadId, taskId, mode = "direct", active = true }) {
    return this.repos.atomic(() => {
      const task = this.repos.getTask(taskId);
      const mandate = this.repos.getMandate(taskId);
      const validated = validateThreadSubscription({
        threadId,
        task,
        mandate,
        mode,
      });
      return this.repos.putSubscription({
        ...validated,
        active: active ? 1 : 0,
        created_at: this._nowIso(),
      });
    });
  }

  listSubscriptions(args = {}) {
    return this.repos.listSubscriptions(args);
  }

  listRouterDecisions(args = {}) {
    return this.repos.listDecisions(args);
  }

  _insertRawMessage({
    fromAgent,
    toAgent = null,
    content,
    subject = "",
    threadId = null,
    taskId = null,
    replyTo = null,
    metadata = {},
    allowSelfSend = false,
  }) {
    const id = crypto.randomUUID();
    const now = this._nowIso();

    validateRoutingNote(metadata, { replyTo, taskId });

    let resolvedToAgent = toAgent;
    let resolvedThreadId = threadId;
    let resolvedTaskId = taskId || metadata?.taskId || null;
    let resolvedSubject = subject;
    let inheritedFromReplyTo = false;

    if (replyTo) {
      const parent = this.repos.getMessage(replyTo);
      if (!parent) {
        throw new BridgeUserError(
          REASONS.REPLY_TARGET_NOT_FOUND,
          `Parent message for replyTo not found: ${replyTo}`
        );
      }
      if (!resolvedToAgent) {
        resolvedToAgent = parent.from_agent;
        inheritedFromReplyTo = true;
      }
      if (!resolvedThreadId) {
        resolvedThreadId = parent.thread_id;
      }
      if (!resolvedTaskId) {
        resolvedTaskId = parent.task_id || parent.metadata?.taskId || null;
      }
      if (!resolvedSubject && parent.subject) {
        resolvedSubject = parent.subject.startsWith("Re:")
          ? parent.subject
          : `Re: ${parent.subject}`;
      }
      this.repos.putMessage({
        ...parent,
        status: "replied",
        read_at: parent.read_at || now,
        processed_at: parent.processed_at || now,
        consumed_at: parent.consumed_at || now,
      });
    }

    if (!resolvedToAgent) {
      throw new BridgeUserError(
        REASONS.MISSING_RECIPIENT,
        "Missing recipient: you must explicitly specify 'toAgent' (e.g. 'codex', 'antigravity', 'claude-code') or 'replyTo' to inherit the recipient from an existing message. Silent default routing is disabled."
      );
    }

    if (!allowSelfSend && fromAgent && resolvedToAgent === fromAgent) {
      throw new BridgeUserError(
        REASONS.SELF_ROUTING_REJECTED,
        `Self-routing blocked: fromAgent ('${fromAgent}') and toAgent ('${resolvedToAgent}') are identical. Specify the peer recipient explicitly (e.g. 'toAgent: "codex"') or use 'bridge_reply_message' with 'replyTo'.`
      );
    }

    const matchedRoute = resolvedTaskId
      ? this.repos.getRoute(resolvedTaskId, resolvedToAgent)
      : null;

    if (!resolvedThreadId) {
      const taskForThread = resolvedTaskId
        ? this.repos.getTask(resolvedTaskId)
        : null;
      resolvedThreadId =
        matchedRoute?.thread_id ||
        (taskForThread ? defaultTaskThreadId(taskForThread) : null) ||
        (resolvedTaskId ? `task-${resolvedTaskId}` : id);
    }

    const seq = this.repos.nextSeq();
    const enrichedMeta = {
      ...(metadata || {}),
      ...(resolvedTaskId ? { taskId: resolvedTaskId } : {}),
    };
    delete enrichedMeta.bridgeDelivery;

    if (resolvedTaskId && fromAgent) {
      this.repos.markPriorTaskMessagesProcessed({
        taskId: resolvedTaskId,
        toAgent: fromAgent,
        nowIso: now,
      });
    }

    let wakeupStatus = "none";
    let wakeupTargetSession = null;
    if (
      resolvedTaskId &&
      fromAgent !== resolvedToAgent &&
      !enrichedMeta.isWakeupNotification &&
      !enrichedMeta.suppressWakeup
    ) {
      const route = matchedRoute;
      if (route && route.enabled && route.to_agent === resolvedToAgent) {
        wakeupStatus = this.isWakeupGuarded()
          ? "skipped_wakeup_guard"
          : "pending";
        wakeupTargetSession = route.target_session_id;
      }
    }

    const saved = this.repos.putMessage({
      id,
      seq,
      thread_id: resolvedThreadId,
      task_id: resolvedTaskId,
      from_agent: fromAgent,
      to_agent: resolvedToAgent,
      subject: resolvedSubject || "",
      content,
      reply_to: replyTo,
      metadata: enrichedMeta,
      status: "unread",
      wakeup_status: wakeupStatus,
      wakeup_target_session: wakeupTargetSession,
      wakeup_dispatched_at: null,
      wakeup_delivered_at: null,
      wakeup_receipt: null,
      processed_at: null,
      consumed_at: null,
      consumed_turn_id: null,
      handback_reason: null,
      delivery_attempts: 0,
      wakeup_error: null,
      created_at: now,
      read_at: null,
    });

    if (resolvedTaskId && enrichedMeta.artifactKind === "validation_feedback") {
      this.updateTaskPhase({
        taskId: resolvedTaskId,
        phase:
          enrichedMeta.passed === true
            ? "awaiting_review"
            : "awaiting_revision",
      });
    } else if (resolvedTaskId && enrichedMeta.applied === false) {
      this.updateTaskPhase({
        taskId: resolvedTaskId,
        phase: "awaiting_revision",
      });
    } else if (
      resolvedTaskId &&
      enrichedMeta.artifactKind === "validation_handoff"
    ) {
      this.updateTaskPhase({
        taskId: resolvedTaskId,
        phase: "awaiting_validation",
      });
    }

    // If user message explicitly resolves a previous handback / humanAction, clear blocking flags
    if (resolvedTaskId && !this.repos.getTask(resolvedTaskId)?.metadata?.workflow && (enrichedMeta.resolveHandback || enrichedMeta.userInitiated)) {
      const t = this.repos.getTask(resolvedTaskId);
      if (t && (t.metadata?.handback || t.metadata?.humanAction || t.metadata?.attention || t.metadata?.stallAlert)) {
        const nextMeta = { ...t.metadata };
        if (nextMeta.handback && !nextMeta.handback.resolvedAt) {
          nextMeta.handback = { ...nextMeta.handback, resolvedAt: now };
        }
        if (nextMeta.humanAction && !nextMeta.humanAction.resolvedAt) {
          nextMeta.humanAction = {
            ...nextMeta.humanAction,
            resolvedAt: now,
            answerMessageId: saved.id,
          };
        }
        if (nextMeta.attention && !nextMeta.attention.resolvedAt) {
          nextMeta.attention = { ...nextMeta.attention, resolvedAt: now };
        }
        if (nextMeta.stallAlert && !nextMeta.stallAlert.resolvedAt && enrichedMeta.resolveHandback) {
          nextMeta.stallAlert = { ...nextMeta.stallAlert, resolvedAt: now };
        }
        this.repos.putTask({ ...t, metadata: nextMeta, updated_at: now });
      }
    }

    if (saved.wakeup_status === "pending" && saved.task_id) {
      this._enqueueEffect({
        kind: "wakeup",
        effectKey: saved.task_id,
        priority: enrichedMeta.userInitiated ? "human_priority" : "normal",
        payload: {
          taskId: saved.task_id,
          triggerMessageId: saved.id,
          userInitiated: Boolean(enrichedMeta.userInitiated),
        },
      });
    }

    this.repos.afterCommit(() => {
      if (typeof this.onMessageCommitted === "function") {
        try {
          this.onMessageCommitted(saved);
        } catch {
          // ignore
        }
      }
    });

    return {
      ...saved,
      inheritedFromReplyTo,
    };
  }

  sendMessage(args) {
    return this.repos.atomic(() => {
      const saved = this._insertRawMessage(args);

      // Evaluate Research Router deterministic fan-out & policy rules
      const subs = this.repos.listSubscriptions({
        threadId: saved.thread_id,
        activeOnly: true,
      });
      const tasksById = new Map();
      const mandatesByTask = new Map();
      for (const s of subs) {
        const t = this.repos.getTask(s.task_id);
        if (t) {
          tasksById.set(t.id, t);
          const m = this.repos.getMandate(t.id);
          if (m) mandatesByTask.set(t.id, m);
        }
      }
      if (saved.task_id && !tasksById.has(saved.task_id)) {
        const t = this.repos.getTask(saved.task_id);
        if (t) {
          tasksById.set(t.id, t);
          const m = this.repos.getMandate(t.id);
          if (m) mandatesByTask.set(t.id, m);
        }
      }

      const routerEval = evaluateInboundEvent({
        message: saved,
        subscriptions: subs,
        tasksById,
        mandatesByTask,
        policy: this.getCurrentPolicy(),
        nowIso: this._nowIso(),
      });

      for (const resume of routerEval.taskResumes) {
        const t = this.repos.getTask(resume.taskId);
        if (t) {
          this.repos.putTask({
            ...t,
            status: resume.nextStatus,
            phase: resume.nextPhase,
            phase_label: PHASE_LABELS[resume.nextPhase] || resume.nextPhase,
            updated_at: this._nowIso(),
          });
        }
      }

      for (const d of routerEval.decisions) {
        this.repos.putDecision(d);
      }

      for (const fm of routerEval.fanoutMessages) {
        this._insertRawMessage(fm);
      }

      for (const eff of routerEval.effects) {
        this._enqueueEffect({
          kind: eff.kind,
          effectKey: eff.effectKey,
          priority: eff.priority || "normal",
          payload: eff.payload,
        });
      }

      return saved;
    });
  }

  getMessageById(id) {
    return this.repos.getMessage(id);
  }

  /**
   * Read messages for a target agent, advancing two-phase `consumed_at` when `markConsumed`
   * (defaults to `markAsRead`) is true.
   */
  readMessages({
    toAgent,
    fromAgent = null,
    threadId = null,
    taskId = null,
    afterSeq = null,
    unreadOnly = false,
    markAsRead = true,
    markConsumed = null,
    consumeTurnId = null,
    limit = 50,
  } = {}) {
    const shouldConsume =
      markConsumed !== null && markConsumed !== undefined
        ? Boolean(markConsumed)
        : Boolean(markAsRead);

    if (!markAsRead && !shouldConsume) {
      return this.repos.queryMessages({
        toAgent,
        fromAgent,
        threadId,
        taskId,
        afterSeq,
        unreadOnly,
        limit,
      });
    }

    return this.repos.atomic(() => {
      const rows = this.repos.queryMessages({
        toAgent,
        fromAgent,
        threadId,
        taskId,
        afterSeq,
        unreadOnly,
        limit,
      });
      if (rows.length === 0) return rows;

      const now = this._nowIso();
      const updated = [];
      for (const row of rows) {
        let changed = false;
        const patch = { ...row };
        if (markAsRead && row.status === "unread") {
          patch.status = "read";
          patch.read_at = row.read_at || now;
          if (row.wakeup_status === "pending") {
            patch.wakeup_status = "skipped_already_read";
          }
          changed = true;
        }
        if (shouldConsume && (!row.consumed_at || (consumeTurnId && !row.consumed_turn_id))) {
          patch.consumed_at = row.consumed_at || now;
          if (consumeTurnId) {
            patch.consumed_turn_id = row.consumed_turn_id || String(consumeTurnId);
          }
          changed = true;
        }
        updated.push(changed ? this.repos.putMessage(patch) : row);
      }
      for (const id of new Set(rows.map((row) => row.task_id).filter(Boolean))) {
        const task = this.repos.getTask(id);
        const alert = task?.metadata?.stallAlert;
        if (alert?.kind === "message_unconsumed" && alert.messageIds.every((mid) => {
          const message = this.repos.getMessage(mid);
          return !message || message.consumed_at || message.status !== "unread";
        })) {
          this.repos.putTask({ ...task, metadata: { ...task.metadata,
            stallAlert: { ...alert, resolvedAt: now } }, updated_at: now });
        }
      }
      return updated;
    });
  }

  handback({
    taskId,
    messageId = null,
    fromAgent = null,
    reasonCode,
    summary,
    humanAction = null,
  }) {
    return this.repos.atomic(() => {
      const task = this.repos.getTask(taskId);
      const message = messageId ? this.repos.getMessage(messageId) : null;
      const ctrl = this.repos.getControl();
      const nowIso = this._nowIso();

      const evaluated = evaluateHandback({
        task,
        message,
        fromAgent: fromAgent || task?.assigned_to,
        reasonCode,
        summary,
        humanAction,
        routerMode: ctrl.router_mode || "observe",
        nowIso,
      });

      if (task.metadata?.workflow) {
        const w = task.metadata.workflow;
        const receiptId = `handback:${w.contract.version}:${w.owner.epoch}:${messageId || sha256Hex(JSON.stringify({ reasonCode, summary, humanAction }))}`;
        const result = this.submitTaskReceipt({ taskId, receiptId, attemptId: `legacy-handback:${taskId}`,
          contractVersion: w.contract.version, ownerEpoch: w.owner.epoch,
          outcome: humanAction ? 'waiting_user' : 'blocked', summary,
          ...(humanAction ? { decision: { id: receiptId, ...humanAction } } : {}),
          actorAgent: fromAgent || task.assigned_to });
        return { ok: true, task: this.repos.getTask(taskId), businessReceipt: result, decisionId: humanAction ? receiptId : null };
      }

      if (message) {
        this.repos.putMessage({
          ...message,
          status: message.status === "unread" ? "read" : message.status,
          read_at: message.read_at || nowIso,
          consumed_at: message.consumed_at || nowIso,
          processed_at: message.processed_at || nowIso,
          handback_reason: reasonCode,
        });
      }

      const updatedTask = this.repos.putTask({
        ...task,
        phase: evaluated.nextPhase,
        phase_label: PHASE_LABELS[evaluated.nextPhase] || evaluated.nextPhase,
        metadata: evaluated.nextTaskMetadata,
        updated_at: nowIso,
      });

      const savedDecision = this.repos.putDecision(evaluated.decision);
      let escalationReceipt = null;
      if (evaluated.escalationMessage) {
        const escMsg = this._insertRawMessage(evaluated.escalationMessage);
        escalationReceipt = {
          messageId: escMsg.id,
          seq: escMsg.seq,
          toAgent: escMsg.to_agent,
        };
      }

      return {
        ok: true,
        handback: evaluated.handbackRecord,
        task: updatedTask,
        decision: savedDecision,
        escalatedToHumanAttention: evaluated.isHumanBoundary,
        escalationReceipt,
      };
    });
  }

  approveRouterDecision({ decisionId, actor = "human" }) {
    return this.repos.atomic(() => {
      const decision = this.repos.getDecision(decisionId);
      if (!decision) {
        throw new BridgeUserError(
          REASONS.DECISION_NOT_FOUND,
          `Router decision not found: ${decisionId}`
        );
      }
      if (decision.outcome !== "would_dispatch") {
        return {
          ok: true,
          alreadyProcessed: true,
          decision,
        };
      }

      const nowIso = this._nowIso();
      const updatedDecision = this.repos.putDecision({
        ...decision,
        outcome: "dispatched",
        detail: `[Approved by ${actor} at ${nowIso}] ${decision.detail}`,
      });

      let wokenTask = null;
      let dispatchMessage = null;
      if (decision.target_task_id) {
        const task = this.repos.getTask(decision.target_task_id);
        if (task) {
          const nextStatus = ["completed", "pending"].includes(task.status)
            ? "in_progress"
            : task.status;
          const nextPhase = ["completed", "ready", "cli_turn_ended"].includes(
            task.phase
          )
            ? "in_progress"
            : task.phase;
          wokenTask = this.repos.putTask({
            ...task,
            status: nextStatus,
            phase: nextPhase,
            phase_label: PHASE_LABELS[nextPhase] || nextPhase,
            updated_at: nowIso,
          });
          dispatchMessage = this._insertRawMessage({
            fromAgent: actor === "codex" ? "codex" : task.from_agent || "codex",
            toAgent: task.assigned_to,
            threadId: decision.thread_id,
            taskId: task.id,
            subject: `[Approved Dispatch] ${task.title}`,
            content: decision.detail,
            replyTo: decision.trigger_message_id || null,
            metadata: {
              isRouterFanout: true,
              approvedDecisionId: decision.id,
              originMessageId: decision.trigger_message_id || null,
              userInitiated: true,
              taskId: task.id,
            },
            allowSelfSend: true,
          });
          this._enqueueEffect({
            kind: "wakeup",
            effectKey: task.id,
            priority: "human_priority",
            payload: {
              taskId: task.id,
              approvedDecisionId: decision.id,
              userInitiated: true,
            },
          });
        }
      }

      return {
        ok: true,
        decision: updatedDecision,
        task: wokenTask,
        dispatchMessage,
      };
    });
  }

  retryTaskDelivery({ taskId, userInitiated = true, toAgent = null }) {
    return this.repos.atomic(() => {
      const task = this.repos.getTask(taskId);
      if (!task) {
        throw new BridgeUserError(
          REASONS.TASK_NOT_FOUND,
          `Task not found: ${taskId}`
        );
      }
      const nowIso = this._nowIso();
      if (task.metadata?.deliveryCircuitOpen) {
        const nextMeta = { ...task.metadata, deliveryCircuitOpen: false };
        this.repos.putTask({ ...task, metadata: nextMeta, updated_at: nowIso });
      }

      const route = this.repos.getRoute(taskId, toAgent);
      let updatedRoute = null;
      if (route) {
        updatedRoute = this.repos.putRoute({
          ...route,
          in_flight: 0,
          worker_pid: null,
          consecutive_failures: 0,
          last_error: null,
          updated_at: nowIso,
        });
      }

      // An accepted notification stays visible once; only explicit transport retries reset.
      const msgs = this.repos.queryMessages({
        toAgent: route?.to_agent || task.assigned_to,
        taskId,
        unreadOnly: true,
        limit: 100,
      });
      const resetIds = [];
      for (const m of msgs) {
        if (
          m.wakeup_status === "failed" ||
          m.wakeup_status === "dispatched" ||
          (m.wakeup_status === "delivered" && !m.consumed_at)
        ) {
          if (this.validHostReceipt(m.wakeup_receipt, route)) continue;
          this.repos.putMessage({
            ...m,
            wakeup_status: "pending",
            wakeup_error: null,
            delivery_attempts: 0,
            metadata: { ...m.metadata, bridgeDelivery: { ...deliveryState(m), attempts: 0, retryAt: null } },
          });
          resetIds.push(m.id);
        }
      }

      const effect = this._enqueueEffect({
        kind: "wakeup",
        effectKey: taskId,
        priority: userInitiated ? "human_priority" : "normal",
        payload: {
          taskId,
          userInitiated: Boolean(userInitiated),
          reason: "manual_retry_delivery",
        },
      });

      return {
        ok: true,
        taskId,
        resetMessageIds: resetIds,
        route: updatedRoute,
        effect,
      };
    });
  }

  // ===========================================================================
  // Wakeup Routes & Delivery Receipts
  // ===========================================================================

  getWakeupRoute(taskId, toAgent = null) {
    if (!taskId) return null;
    return this.repos.getRoute(taskId, toAgent);
  }

  getWakeupRoutes(taskId) {
    return this.repos.listTaskRoutes(taskId);
  }

  configureWakeupRoute({
    taskId,
    threadId = null,
    toAgent = "codex",
    targetSessionId,
    driver = "host_poll",
    wakeupCommand = null,
    appServerUrl = null,
    model = null,
    effort = null,
    cwd = "",
    enabled = true,
  }) {
    if (!taskId) {
      throw new Error("taskId is required to configure a wakeup route.");
    }
    return this.repos.atomic(() => {
      const existing = this.repos.getRoute(taskId, toAgent);
      const nowIso = this._nowIso();
      const resolvedThreadId =
        threadId || existing?.thread_id || `example-${taskId}`;
      const resolvedTargetSession =
        targetSessionId || existing?.target_session_id || "";
      const resolvedDriver = driver || existing?.driver || "host_poll";
      const resolvedCwd = cwd || existing?.cwd || this.defaultCwd();
      const resolvedEnabled =
        enabled !== undefined ? (enabled ? 1 : 0) : existing?.enabled ?? 1;

      return this.repos.putRoute({
        task_id: taskId,
        thread_id: resolvedThreadId,
        to_agent: toAgent,
        target_session_id: resolvedTargetSession,
        driver: resolvedDriver,
        wakeup_command: wakeupCommand ?? existing?.wakeup_command ?? null,
        app_server_url: appServerUrl ?? existing?.app_server_url ?? null,
        model: model ?? existing?.model ?? null,
        effort: effort ?? existing?.effort ?? null,
        cwd: resolvedCwd,
        enabled: resolvedEnabled,
        in_flight: existing?.in_flight ?? 0,
        worker_pid: existing?.worker_pid ?? null,
        last_woken_seq: existing?.last_woken_seq ?? 0,
        last_dispatched_at: existing?.last_dispatched_at ?? null,
        last_delivered_at: existing?.last_delivered_at ?? null,
        last_receipt: existing?.last_receipt ?? null,
        last_turn_id: existing?.last_turn_id ?? null,
        last_handled_by_client_id: existing?.last_handled_by_client_id ?? null,
        last_error: existing?.last_error ?? null,
        consecutive_failures: existing?.consecutive_failures ?? 0,
        updated_at: nowIso,
      });
    });
  }

  validHostReceipt(receipt, route) {
    if (!route || receipt?.accepted !== true || receipt.targetSessionId !== route.target_session_id) return false;
    const evidence = receipt.evidence;
    if (route.driver === 'cli_resume') return evidence?.provider === 'codex' && evidence.sessionId === route.target_session_id && evidence.status === 'completed';
    if (route.driver === 'antigravity_desktop') return evidence?.provider === 'antigravity' && evidence.transport === 'agentapi' && evidence.status === 'accepted' && evidence.sessionId === route.target_session_id;
    if (route.driver === 'claude_desktop') return evidence?.provider === 'claude-code' && evidence.transport === 'desktop_inbox' && evidence.status === 'accepted' && evidence.sessionId === route.target_session_id && Boolean(evidence.messageId) && (!route.model || evidence.model === route.model) && (!route.effort || evidence.effort === route.effort);
    if (route.driver === 'claude_cli' || route.driver === 'agy_cli') {
      return evidence?.provider === route.to_agent && evidence.sessionId === route.target_session_id &&
        (route.driver === 'claude_cli' ? evidence.status === 'success' : evidence.status === 'SUCCESS');
    }
    return typeof receipt.turnId === 'string' && Boolean(receipt.turnId);
  }

  recordWakeupFailure(taskId, messageIds = [], errorMsg = "wakeup_failed", toAgent = null) {
    return this.repos.atomic(() => {
      const selectedRoute = this.repos.getRoute(taskId, toAgent || this.repos.getMessage(messageIds[0])?.to_agent);
      if (!selectedRoute) return null;
      const recipient = selectedRoute.to_agent;
      const nowIso = this._nowIso();
      const errText = String(errorMsg || "wakeup_failed");
      if (Array.isArray(messageIds) && messageIds.length > 0) {
        for (const id of messageIds) {
          const m = this.repos.getMessage(id);
          if (m && m.task_id === taskId && m.to_agent === recipient && !this.validHostReceipt(m.wakeup_receipt, this.repos.getRoute(m.task_id, m.to_agent))) {
            this.repos.putMessage({
              ...m,
              wakeup_status: "failed",
              wakeup_error: errText,
              delivery_attempts: Number(m.delivery_attempts || 0) + 1,
              metadata: finishDeliveryMetadata(m, m.wakeup_target_session ||
                this.repos.getRoute(m.task_id, m.to_agent)?.target_session_id, nowIso, false),
            });
          }
        }
      } else if (taskId) {
        const msgs = this.repos.queryMessages({
          toAgent: recipient || toAgent,
          taskId,
          limit: 200,
        });
        for (const m of msgs) {
          if (
            m.wakeup_status === "pending" ||
            m.wakeup_status === "dispatched"
          ) {
            this.repos.putMessage({
              ...m,
              wakeup_status: "failed",
              wakeup_error: errText,
              delivery_attempts: Number(m.delivery_attempts || 0) + 1,
              metadata: finishDeliveryMetadata(m, m.wakeup_target_session ||
                this.repos.getRoute(m.task_id, m.to_agent)?.target_session_id, nowIso, false),
            });
          }
        }
      }

      if (taskId) {
        const route = selectedRoute;
        if (route) {
          const nextFailures = Number(route.consecutive_failures || 0) + 1;
          this.repos.putRoute({
            ...route,
            in_flight: 0,
            worker_pid: null,
            consecutive_failures: nextFailures,
            last_error: errText,
            updated_at: nowIso,
          });
          if (nextFailures >= 3) {
            const task = this.repos.getTask(taskId);
            if (task) {
              this.repos.putTask({
                ...task,
                metadata: {
                  ...task.metadata,
                  deliveryCircuitOpen: true,
                  lastDeliveryError: errText,
                },
                updated_at: nowIso,
              });
            }
          }
        }
      }
      this._scheduleWakeupRetry(taskId);
    });
  }

  _scheduleWakeupRetry(taskId) {
    if (!taskId) return;
    const deadlines = [];
    for (const route of this.repos.listTaskRoutes(taskId)) {
      if (!route.enabled || Number(route.consecutive_failures || 0) >= 3) continue;
      const unread = this.repos.queryMessages({ taskId, toAgent: route.to_agent, unreadOnly: true, limit: 200 });
      for (const message of unread) {
        if (message.handback_reason || this.validHostReceipt(message.wakeup_receipt, route)) continue;
        if (message.wakeup_status === 'failed' && deliveryAttempts(message, route.target_session_id) < 3) {
          const deadline = Date.parse(deliveryState(message).retryAt || '');
          deadlines.push(Number.isFinite(deadline) ? deadline : this._nowMs());
        } else if (message.wakeup_status === 'pending' && retryDue(message, route.target_session_id, this._nowMs())) {
          deadlines.push(this._nowMs());
        }
      }
    }
    if (deadlines.length) this._enqueueEffect({ kind: 'wakeup', effectKey: taskId,
      payload: { taskId, reason: 'transport_retry' }, dueMs: Math.min(...deadlines) });
  }

  claimPendingWakeup(
    taskId,
    { workerPid = 0, includeDispatched = false, bypassCircuitBreaker = false, toAgent = null } = {}
  ) {
    return this.repos.atomic(() => {
      if (this.getControlState().paused) {
        return { claimed: false, reason: "bridge_paused" };
      }
      const route = this.repos.getRoute(taskId, toAgent);
      if (!route || !route.enabled) {
        return { claimed: false, reason: "route_disabled_or_missing" };
      }
      if (
        !bypassCircuitBreaker &&
        Number(route.consecutive_failures || 0) >= 3
      ) {
        return {
          claimed: false,
          reason: "delivery_circuit_open",
          consecutiveFailures: Number(route.consecutive_failures),
        };
      }

      const nowIso = this._nowIso();
      let refreshed = route;

      if (Number(route.in_flight) === 1) {
        const holderPid = Number(route.worker_pid || 0);
        if (
          holderPid > 0 &&
          this.isPidAlive(holderPid)
        ) {
          return {
            claimed: false,
            reason: "already_in_flight",
            holderPid,
          };
        }
        // Recover orphaned 'dispatched' unread messages back to 'pending'
        const unread = this.repos.queryMessages({
          toAgent: route.to_agent,
          taskId,
          unreadOnly: true,
          limit: 200,
        });
        for (const m of unread) {
          if (m.wakeup_status === "dispatched") {
            this.repos.putMessage({ ...m, wakeup_status: "pending" });
          }
        }
        refreshed = this.repos.putRoute({
          ...route,
          in_flight: 0,
          worker_pid: null,
          updated_at: nowIso,
        });
      }

      const allowedStatuses = includeDispatched
        ? new Set(["pending", "dispatched", "failed"])
        : new Set(["pending", "failed"]);
      const unreadMsgs = this.repos.queryMessages({
        toAgent: refreshed.to_agent,
        taskId,
        unreadOnly: true,
        limit: 200,
      });
      for (const message of unreadMsgs) {
        if (allowedStatuses.has(message.wakeup_status) &&
            this.validHostReceipt(message.wakeup_receipt, refreshed)) {
          this.repos.putMessage({ ...message, wakeup_status: "delivered" });
        }
      }

      const eligibleRows = unreadMsgs.filter(
        (m) =>
          m.to_agent === refreshed.to_agent &&
          allowedStatuses.has(m.wakeup_status) &&
          !m.handback_reason &&
          !this.validHostReceipt(m.wakeup_receipt, refreshed) &&
          retryDue(m, refreshed.target_session_id, Date.parse(nowIso))
      );

      if (eligibleRows.length === 0) {
        return { claimed: false, reason: "no_unread_pending_messages" };
      }
      const envelope = notificationEnvelope(eligibleRows, refreshed.target_session_id);
      const pendingRows = envelope.messages;

      const lockedRoute = this.repos.putRoute({
        ...refreshed,
        in_flight: 1,
        worker_pid: Number(workerPid),
        last_dispatched_at: nowIso,
        updated_at: nowIso,
      });

      let maxSeq = Number(refreshed.last_woken_seq || 0);
      const messageIds = [];
      const claimedMessages = [];
      for (const r of pendingRows) {
        const updatedMsg = this.repos.putMessage({
          ...r,
          wakeup_status: "dispatched",
          wakeup_dispatched_at: nowIso,
          wakeup_error: null,
          metadata: beginDeliveryMetadata(r, envelope, refreshed.target_session_id, nowIso),
        });
        messageIds.push(updatedMsg.id);
        claimedMessages.push(updatedMsg);
        if (Number(updatedMsg.seq) > maxSeq) maxSeq = Number(updatedMsg.seq);
      }

      return {
        claimed: true,
        route: lockedRoute,
        messageIds,
        messages: claimedMessages,
        notificationId: envelope.id,
        maxSeq,
      };
    });
  }

  completeWakeupDelivery(
    taskId,
    messageIds = [],
    { delivered = true, maxSeq = 0, error = null, receipt = null, toAgent = null } = {}
  ) {
    return this.repos.atomic(() => {
      const route = this.repos.getRoute(taskId, toAgent || this.repos.getMessage(messageIds[0])?.to_agent);
      if (delivered && !this.validHostReceipt(receipt, route)) {
        throw new Error(
          "Host acceptance requires accepted:true, turnId and matching targetSessionId"
        );
      }
      for (const id of messageIds) {
        const message = this.repos.getMessage(id);
        if (
          !message ||
          message.task_id !== taskId ||
          message.to_agent !== route?.to_agent
        ) {
          throw new Error("Host receipt message binding mismatch");
        }
      }
      const computedMaxSeq = Math.max(
        0,
        Number(maxSeq || 0),
        ...messageIds.map((id) => this.repos.getMessage(id)?.seq || 0)
      );
      const nowIso = this._nowIso();
      const nextStatus = delivered ? "delivered" : "failed";

      for (const id of messageIds) {
        const m = this.repos.getMessage(id);
        if (!m) continue;
        this.repos.putMessage({
          ...m,
          wakeup_status: nextStatus,
          wakeup_delivered_at: delivered ? nowIso : m.wakeup_delivered_at,
          wakeup_receipt: delivered && receipt ? receipt : m.wakeup_receipt,
          wakeup_error: error,
          delivery_attempts: Number(m.delivery_attempts || 0) + 1,
          metadata: finishDeliveryMetadata(m, route.target_session_id, nowIso, delivered, receipt),
        });
      }

      if (!route) return null;

      const nextFailures = delivered
        ? 0
        : Number(route.consecutive_failures || 0) + 1;
      const updatedRoute = this.repos.putRoute({
        ...route,
        in_flight: 0,
        worker_pid: null,
        last_woken_seq: delivered
          ? Math.max(Number(route.last_woken_seq || 0), computedMaxSeq)
          : Number(route.last_woken_seq || 0),
        last_delivered_at: delivered ? nowIso : route.last_delivered_at,
        last_receipt:
          delivered && receipt ? receipt : route.last_receipt || null,
        last_turn_id:
          delivered && receipt?.turnId
            ? String(receipt.turnId)
            : route.last_turn_id,
        last_handled_by_client_id:
          delivered && receipt?.handledByClientId
            ? String(receipt.handledByClientId)
            : route.last_handled_by_client_id,
        last_error: error,
        consecutive_failures: nextFailures,
        updated_at: nowIso,
      });

      const task = this.repos.getTask(taskId);
      if (task) {
        if (!delivered && nextFailures >= 3) {
          this.repos.putTask({
            ...task,
            metadata: {
              ...task.metadata,
              deliveryCircuitOpen: true,
              lastDeliveryError: error,
            },
            updated_at: nowIso,
          });
        } else if (delivered && task.metadata?.deliveryCircuitOpen) {
          this.repos.putTask({
            ...task,
            metadata: {
              ...task.metadata,
              deliveryCircuitOpen: false,
            },
            updated_at: nowIso,
          });
        }
      }

      this._scheduleWakeupRetry(taskId);
      return updatedRoute;
    });
  }

  confirmWakeupDelivery({
    taskId,
    messageIds = [],
    maxSeq = null,
    receipt = null,
    toAgent = null,
  } = {}) {
    if (!taskId) {
      throw new Error("taskId is required for confirmWakeupDelivery.");
    }
    const route = this.repos.getRoute(taskId, toAgent || this.repos.getMessage(messageIds[0])?.to_agent || this.repos.listTaskRoutes(taskId).find((r) => r.target_session_id === receipt?.targetSessionId)?.to_agent);
    if (!this.validHostReceipt(receipt, route)) {
      return {
        ok: false,
        confirmed: false,
        error:
          "Host receipt with accepted:true, turnId and matching targetSessionId is required before marking wakeup as delivered.",
        route,
      };
    }

    const baselineSeq = Number(route?.last_woken_seq || 0);
    let resolvedIds = Array.isArray(messageIds) ? [...messageIds] : [];
    let resolvedMaxSeq = Number(maxSeq || 0);

    if (resolvedIds.length === 0) {
      const rows = this.repos.queryMessages({
        toAgent: route.to_agent,
        taskId,
        afterSeq: baselineSeq,
        unreadOnly: true,
        limit: 200,
      });
      for (const r of rows) {
        if (r.to_agent !== route.to_agent) continue;
        if (!maxSeq || Number(r.seq) <= Number(maxSeq)) {
          resolvedIds.push(r.id);
          if (Number(r.seq) > resolvedMaxSeq) {
            resolvedMaxSeq = Number(r.seq);
          }
        }
      }
    } else if (!resolvedMaxSeq) {
      for (const id of resolvedIds) {
        const msg = this.repos.getMessage(id);
        if (msg && msg.seq > resolvedMaxSeq) {
          resolvedMaxSeq = msg.seq;
        }
      }
    }

    const normalizedReceipt = {
      accepted: true,
      acceptedAt: this._nowIso(),
      ...receipt,
    };

    const updatedRoute = this.completeWakeupDelivery(taskId, resolvedIds, {
      delivered: true,
      maxSeq: resolvedMaxSeq,
      error: null,
      receipt: normalizedReceipt,
      toAgent: route.to_agent,
    });

    return {
      ok: true,
      confirmed: true,
      deliveredMessageIds: resolvedIds,
      maxSeq: resolvedMaxSeq,
      receipt: normalizedReceipt,
      toAgent: route.to_agent,
      route: updatedRoute,
    };
  }

  // ===========================================================================
  // Patches & Validations
  // ===========================================================================

  submitPatch({
    patchId,
    taskId,
    fromAgent,
    toAgent = null,
    conversationId = null,
    model = null,
    artifactKind = "unified_diff",
    rawContent,
    dependsOn = [],
    supersedes = null,
    targetFiles = [],
    validation = {},
    summary = "",
    notifyRecipient = true,
  }) {
    return this.repos.atomic(() => {
      const task = this.repos.getTask(taskId);
      if (!task) {
        throw new BridgeUserError(
          REASONS.TASK_NOT_FOUND,
          `Cannot submit patch: task '${taskId}' not found.`
        );
      }

      this.verifyAndBindTask({
        taskId,
        actualModel: model || task.actual_model,
        conversationId,
        modelSource: "submit_patch",
      });

      const resolvedToAgent = toAgent || task.from_agent || "codex";
      if (resolvedToAgent === fromAgent) {
        throw new BridgeUserError(
          REASONS.SELF_ROUTING_REJECTED,
          `Patch routing error: fromAgent ('${fromAgent}') and toAgent ('${resolvedToAgent}') cannot be identical.`
        );
      }

      const previous = this.repos.getPatch(patchId, { includeRawContent: false });
      if (previous) {
        throw new Error(
          "Patch IDs are immutable; submit a new patchId with supersedes"
        );
      }

      const current = this.listPatches({ taskId }).patches;
      if (
        supersedes &&
        !current.some((p) => p.patchId === supersedes && !p.supersededBy)
      ) {
        throw new Error("Replacement target is missing or already superseded");
      }

      computePatchApplyOrder([
        ...current.filter(
          (p) =>
            !p.supersededBy &&
            p.status !== "superseded" &&
            p.patchId !== supersedes
        ),
        { patchId, dependsOn },
      ]);

      const now = this._nowIso();
      const seq = this.repos.nextSeq();
      const sha256 = sha256Hex(rawContent);

      if (supersedes) {
        const supTarget = this.repos.getPatch(supersedes, {
          includeRawContent: true,
        });
        if (supTarget && supTarget.taskId === taskId) {
          this.repos.putPatch({
            ...supTarget,
            status: "superseded",
            supersededBy: patchId,
            updatedAt: now,
          });
        }
      }

      const refreshedTask = this.repos.getTask(taskId);
      this.repos.putPatch({
        patchId,
        seq,
        taskId,
        fromAgent,
        toAgent: resolvedToAgent,
        conversationId:
          conversationId || refreshedTask.bound_conversation_id || null,
        model: model || refreshedTask.actual_model || null,
        artifactKind,
        rawContent,
        sha256,
        dependsOn: dependsOn || [],
        supersedes: supersedes || null,
        supersededBy: null,
        targetFiles: targetFiles || [],
        validation: validation || {},
        status: "submitted",
        summary: summary || "",
        createdAt: now,
        updatedAt: now,
        appliedAt: null,
      });

      this.repos.putTask({
        ...refreshedTask,
        delivery_version: Number(refreshedTask.delivery_version || 0) + 1,
        phase: "awaiting_validation",
        phase_label: PHASE_LABELS.awaiting_validation,
        updated_at: now,
      });

      let notificationMessage = null;
      if (notifyRecipient) {
        notificationMessage = this.sendMessage({
          fromAgent,
          toAgent: resolvedToAgent,
          taskId,
          threadId: defaultTaskThreadId(refreshedTask),
          subject: `Patch Delivered: ${patchId} (${artifactKind})${
            supersedes ? ` [supersedes ${supersedes}]` : ""
          }`,
          content:
            summary ||
            `Structured patch '${patchId}' (${artifactKind}, sha256=${sha256.slice(
              0,
              12
            )}, files=${targetFiles.length}) submitted and ready for mechanical application via bridge_get_patch.`,
          metadata: {
            event: "patch_delivered",
            taskId,
            patchId,
            artifactKind,
            sha256,
            supersedes: supersedes || null,
            dependsOn: dependsOn || [],
            targetFiles,
            conversationId:
              conversationId || refreshedTask.bound_conversation_id || null,
            model: model || refreshedTask.actual_model || null,
          },
        });
      }

      return {
        patch: this.repos.getPatch(patchId, { includeRawContent: false }),
        task: this.repos.getTask(taskId),
        notificationReceipt: notificationMessage
          ? {
              messageId: notificationMessage.id,
              seq: notificationMessage.seq,
              actualFromAgent: notificationMessage.from_agent,
              actualToAgent: notificationMessage.to_agent,
            }
          : null,
      };
    });
  }

  getPatch(patchId, { includeRawContent = true } = {}) {
    return this.repos.getPatch(patchId, { includeRawContent });
  }

  listPatches({
    taskId = null,
    activeOnly = false,
    includeRawContent = false,
  } = {}) {
    const patches = this.repos.listPatches({
      taskId,
      activeOnly,
      includeRawContent,
    });
    const activePatches = patches.filter(
      (p) => p.status !== "superseded" && !p.supersededBy
    );
    const activeApplyOrder = computePatchApplyOrder(activePatches);
    return {
      patches,
      activeApplyOrder,
    };
  }

  recordValidation({
    taskId,
    validatorAgent,
    patchIds = [],
    applied = true,
    passed = null,
    summary,
    details = {},
    notifyAssignee = true,
  }) {
    return this.repos.atomic(() => {
      const task = this.repos.getTask(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      for (const patchId of patchIds) {
        const patch = this.repos.getPatch(patchId, { includeRawContent: false });
        if (!patch || patch.taskId !== taskId || patch.supersededBy) {
          throw new Error(
            `Validation references missing, foreign or superseded patch: ${patchId}`
          );
        }
      }

      const now = this._nowIso();
      const seq = this.repos.nextSeq();
      const id = crypto.randomUUID();

      this.repos.putValidation({
        id,
        seq,
        taskId,
        validatorAgent,
        patchIds: patchIds || [],
        applied: Boolean(applied),
        passed:
          passed === null || passed === undefined ? null : Boolean(passed),
        summary,
        details: details || {},
        createdAt: now,
      });

      if (Array.isArray(patchIds) && patchIds.length > 0) {
        const nextPatchStatus =
          passed === false
            ? "validation_failed"
            : applied
              ? "applied"
              : "submitted";
        for (const pid of patchIds) {
          const existingPatch = this.repos.getPatch(pid, {
            includeRawContent: true,
          });
          if (existingPatch && existingPatch.taskId === taskId) {
            this.repos.putPatch({
              ...existingPatch,
              status:
                existingPatch.status === "superseded"
                  ? "superseded"
                  : nextPatchStatus,
              appliedAt: applied
                ? existingPatch.appliedAt || now
                : existingPatch.appliedAt,
              updatedAt: now,
            });
          }
        }
      }

      let nextPhase = task.phase;
      if (passed === false || !applied) {
        nextPhase = "awaiting_revision";
      } else if (passed === true) {
        nextPhase = "awaiting_review";
      } else if (applied) {
        nextPhase = "awaiting_validation";
      }

      const updatedTask = this.updateTaskPhase({
        taskId,
        phase: nextPhase,
      });
      this.repos.markPriorTaskMessagesProcessed({
        taskId,
        toAgent: validatorAgent,
        nowIso: now,
      });

      let notification = null;
      if (
        notifyAssignee &&
        task.assigned_to &&
        task.assigned_to !== validatorAgent
      ) {
        notification = this.sendMessage({
          fromAgent: validatorAgent,
          toAgent: task.assigned_to,
          taskId,
          threadId: defaultTaskThreadId(task),
          subject:
            passed === false
              ? `Validation Failed (${PHASE_LABELS[nextPhase]}): [${patchIds.join(", ")}]`
              : passed === true
                ? `Validation Passed (${PHASE_LABELS[nextPhase]}): [${patchIds.join(", ")}]`
                : `Patches Applied: [${patchIds.join(", ")}]`,
          content: summary,
          metadata: {
            artifactKind: "validation_feedback",
            validationId: id,
            deliveryVersion: task.delivery_version,
            taskId,
            patchIds,
            applied,
            passed,
            phase: nextPhase,
            phaseLabel: PHASE_LABELS[nextPhase],
            ...details,
          },
        });
      }

      return {
        validationId: id,
        seq,
        task: updatedTask,
        notificationReceipt: notification
          ? {
              messageId: notification.id,
              seq: notification.seq,
              actualFromAgent: notification.from_agent,
              actualToAgent: notification.to_agent,
            }
          : null,
      };
    });
  }

  getTaskOverview(taskId) {
    const task = this.repos.getTask(taskId);
    if (!task) return null;

    const lease = this.repos.getLease(taskId);
    const mandate = this.repos.getMandate(taskId);
    const route = this.repos.getRoute(taskId);
    const subscriptions = this.repos.listSubscriptions({ taskId });
    const pendingDecisions = this.repos.listDecisions({
      taskId,
      outcome: "would_dispatch",
      limit: 20,
    });
    const queuedEffects = this.repos
      .listEffects({ limit: 100 })
      .filter((e) => e.effect_key === taskId);
    const stage = attentionStage(task, route, null, {
      pendingDecisions,
      queuedEffects,
    });

    const { patches, activeApplyOrder } = this.listPatches({
      taskId,
      includeRawContent: false,
    });
    const validations = this.repos
      .listValidations({ taskId, limit: 10, orderDesc: true })
      .map((v) => ({
        id: v.id,
        seq: Number(v.seq),
        validatorAgent: v.validatorAgent,
        patchIds: v.patchIds,
        applied: Boolean(v.applied),
        passed: v.passed === null ? null : Boolean(v.passed),
        summary: v.summary,
        createdAt: v.createdAt,
      }));

    const recentMessages = this.readMessages({
      toAgent: "*",
      taskId,
      markAsRead: false,
      markConsumed: false,
      limit: 10,
    });

    return {
      taskId: task.id,
      title: task.title,
      ...workflow.workflowOverview(this, task),
      status: task.status,
      phase: task.phase,
      phaseLabel: task.phase_label,
      attentionStage: stage,
      mandate,
      subscriptions,
      binding: task.binding,
      lease: lease || { status: task.lease_status || "none" },
      wakeupRoute: route,
      patchSummary: {
        totalCount: patches.length,
        activeApplyOrder: activeApplyOrder.slice(-50),
        truncated: patches.length > 50,
        patches: patches.slice(-50).map((p) => ({
          patchId: p.patchId,
          seq: p.seq,
          artifactKind: p.artifactKind,
          status: p.status,
          supersedes: p.supersedes,
          supersededBy: p.supersededBy,
          summary: String(p.summary || "").slice(0, 240),
          targetFiles: (p.targetFiles || []).slice(0, 20),
        })),
      },
      latestValidation: validations[0] || null,
      validations,
      recentMessages: recentMessages.map(({ content, metadata, ...m }) => ({
        ...m,
        contentPreview: String(content || "").slice(0, 240),
      })),
      currentCursor: this.getCurrentSeq(),
    };
  }

  // ===========================================================================
  // Shared Context & Sessions
  // ===========================================================================

  setContext({
    key,
    value,
    updatedBy,
    contentType = "text/plain",
    description = "",
  }) {
    const serialized =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return this.repos.atomic(() =>
      this.repos.putContext({
        key,
        value: serialized,
        content_type: contentType,
        updated_by: updatedBy,
        description,
        updated_at: this._nowIso(),
      })
    );
  }

  getContext(key) {
    return this.repos.getContext(key);
  }

  listContext() {
    return this.repos.listContext();
  }

  recordSession({
    agent,
    externalSessionId,
    model = null,
    cwd = "",
    summary = "",
    lastPrompt = "",
    lastResponse = "",
  }) {
    const now = this._nowIso();
    const sessionKey = externalSessionId
      ? `${agent}:${externalSessionId}`
      : `${agent}:latest`;

    this.repos.atomic(() => {
      const base = {
        agent,
        external_session_id: externalSessionId || null,
        model: model || null,
        cwd,
        summary,
        last_prompt: lastPrompt,
        last_response: lastResponse,
        updated_at: now,
      };
      this.repos.putSession({ ...base, session_key: sessionKey });
      if (sessionKey !== `${agent}:latest`) {
        this.repos.putSession({ ...base, session_key: `${agent}:latest` });
      }
    });
  }

  getLatestSession(agent) {
    return this.repos.getSession(`${agent}:latest`);
  }

  listSessions(agent = null, limit = 20) {
    return this.repos.listSessions(agent, limit);
  }

  // ===========================================================================
  // Spill Card Reader & Attention Queue
  // ===========================================================================

  readCard({
    uri = null,
    kind = null,
    id = null,
    field = null,
    offset = 0,
    limit = 4000,
  } = {}) {
    const resolved = uri
      ? parseCardUri(uri)
      : {
          uri: `bridge://${encodeURIComponent(String(kind || ""))}/${encodeURIComponent(String(id || ""))}`,
          kind: String(kind || ""),
          id: String(id || ""),
          field,
        };
    const effectiveField = field || resolved.field || null;

    if (resolved.kind === "message") {
      const msg = this.repos.getMessage(resolved.id);
      if (!msg) {
        throw new BridgeUserError(
          REASONS.CARD_NOT_FOUND,
          `Message card not found: ${resolved.id}`
        );
      }
      const text =
        effectiveField === "metadata"
          ? JSON.stringify(msg.metadata || {}, null, 2)
          : msg.content || "";
      return {
        card: messageCard(msg),
        page: textPage({ uri: resolved.uri, text, offset, limit }),
      };
    }

    if (resolved.kind === "task") {
      const task = this.repos.getTask(resolved.id);
      if (!task) {
        throw new BridgeUserError(
          REASONS.CARD_NOT_FOUND,
          `Task card not found: ${resolved.id}`
        );
      }
      const mandate = this.repos.getMandate(task.id);
      const route = this.repos.getRoute(task.id);
      const stage = attentionStage(task, route);
      const text =
        effectiveField === "prompt"
          ? task.prompt || ""
          : effectiveField === "result"
            ? task.result || ""
            : effectiveField === "metadata"
              ? JSON.stringify(task.metadata || {}, null, 2)
              : task.result || task.error || task.prompt || "";
      return {
        card: taskCard(task, mandate, stage),
        page: textPage({ uri: resolved.uri, text, offset, limit }),
      };
    }

    if (resolved.kind === "patch") {
      const patch = this.repos.getPatch(resolved.id, {
        includeRawContent: true,
      });
      if (!patch) {
        throw new BridgeUserError(
          REASONS.CARD_NOT_FOUND,
          `Patch card not found: ${resolved.id}`
        );
      }
      const text =
        effectiveField === "summary"
          ? patch.summary || ""
          : patch.rawContent || "";
      return {
        card: patchCard({ ...patch, rawContent: undefined }),
        page: textPage({ uri: resolved.uri, text, offset, limit }),
      };
    }

    if (resolved.kind === "validation") {
      const val = this.repos.getValidation(resolved.id);
      if (!val) {
        throw new BridgeUserError(
          REASONS.CARD_NOT_FOUND,
          `Validation card not found: ${resolved.id}`
        );
      }
      const text =
        effectiveField === "details"
          ? JSON.stringify(val.details || {}, null, 2)
          : val.summary || "";
      return {
        card: validationCard(val),
        page: textPage({ uri: resolved.uri, text, offset, limit }),
      };
    }

    if (resolved.kind === "context") {
      const entry = this.repos.getContext(resolved.id);
      if (!entry) {
        throw new BridgeUserError(
          REASONS.CARD_NOT_FOUND,
          `Shared context card not found: ${resolved.id}`
        );
      }
      return {
        card: {
          kind: "context",
          id: entry.key,
          updatedBy: entry.updated_by,
          contentType: entry.content_type,
          updatedAt: entry.updated_at,
          read: resolved.uri,
        },
        page: textPage({
          uri: resolved.uri,
          text: entry.value || "",
          offset,
          limit,
        }),
      };
    }

    if (resolved.kind === "decision") {
      const dec = this.repos.getDecision(resolved.id);
      if (!dec) {
        throw new BridgeUserError(
          REASONS.CARD_NOT_FOUND,
          `Router decision card not found: ${resolved.id}`
        );
      }
      return {
        card: {
          kind: "decision",
          id: dec.id,
          seq: dec.seq,
          threadId: dec.thread_id,
          mode: dec.mode,
          outcome: dec.outcome,
          targetTaskId: dec.target_task_id,
          targetAgent: dec.target_agent,
          reasonCode: dec.reason_code,
          createdAt: dec.created_at,
          read: resolved.uri,
        },
        page: textPage({
          uri: resolved.uri,
          text: dec.detail || "",
          offset,
          limit,
        }),
      };
    }

    throw new BridgeUserError(
      REASONS.INVALID_CARD_URI,
      `Unsupported card kind '${resolved.kind}'. Supported kinds: message, task, patch, validation, context, decision.`
    );
  }

  /**
   * Build prioritized Needs Human Attention queue across tasks and shadow `would_dispatch` proposals.
   */
  buildAttentionQueue() {
    const tasks = this.repos.listTasks({ limit: 200 });
    const pendingDecisions = this.repos.listDecisions({
      outcome: "would_dispatch",
      limit: 50,
    });
    const queuedEffects = this.repos.listEffects({ limit: 200 });

    const items = [];
    const coveredDecisionIds = new Set();

    for (const task of tasks) {
      if (["completed", "cancelled"].includes(task.status)) continue;
      const route = this.repos.getRoute(task.id);
      const taskDecisions = pendingDecisions.filter(
        (d) => d.target_task_id === task.id
      );
      const stage = attentionStage(task, route, null, {
        pendingDecisions: taskDecisions,
        queuedEffects,
      });
      if (!ATTENTION_PRIORITY[stage]) continue;

      if (stage === "observe/would_dispatch" && taskDecisions[0]) {
        const d = taskDecisions[0];
        coveredDecisionIds.add(d.id);
        items.push(
          attentionCard({
            id: `attn_dec_${d.id}`,
            stage,
            severity: "info",
            taskId: task.id,
            threadId: d.thread_id,
            decisionId: d.id,
            title: `Shadow Dispatch Proposal: ${task.title}`,
            reasonCode: d.reason_code,
            detail: d.detail,
            actions: ["approve_dispatch"],
            createdAt: d.created_at,
          })
        );
        continue;
      }

      const hb =
        task.metadata?.handback && !task.metadata.handback.resolvedAt
          ? task.metadata.handback
          : null;
      const humanAction =
        (task.metadata?.humanAction && !task.metadata.humanAction.resolvedAt
          ? task.metadata.humanAction
          : null) || hb?.humanAction || null;
      const stall =
        task.metadata?.stallAlert && !task.metadata.stallAlert.resolvedAt
          ? task.metadata.stallAlert
          : null;

      let reasonCode = stage;
      let detail = task.error || task.prompt || "";
      let actions = [];
      let severity = "warning";

      if (stage === "person/delivery_failed") {
        severity = "error";
        reasonCode = "DELIVERY_CIRCUIT_OPEN";
        detail =
          route?.last_error ||
          task.metadata?.lastDeliveryError ||
          "3 consecutive wakeup/delivery failures; automatic retry paused.";
        actions = ["retry_delivery", "answer_and_resume"];
      } else if (stage === "person/permission_delta") {
        severity = "warning";
        reasonCode = hb?.reasonCode || "permission_delta";
        detail =
          hb?.summary ||
          task.metadata?.attention?.summary ||
          "Task requested scope/permission beyond current mandate.";
        actions = ["answer_and_resume"];
      } else if (stage === "person/answer") {
        severity = "warning";
        reasonCode = hb?.reasonCode || "human_question";
        detail = humanAction?.question || hb?.summary || detail;
        actions = ["answer_and_resume"];
      } else if (stage === "person/stall_detected") {
        severity = "warning";
        reasonCode = stall?.kind || "stall_detected";
        detail = stall?.summary || "Watchdog detected repeated validation spin or stale evidence.";
        actions = ["answer_and_resume"];
      } else if (stage === "person/review") {
        severity = "info";
        reasonCode = hb?.reasonCode || "awaiting_review";
        detail = hb?.summary || task.result || `Task '${task.title}' is ready for review.`;
        actions = ["answer_and_resume"];
      }

      items.push(
        attentionCard({
          id: `attn_task_${task.id}`,
          stage,
          severity,
          taskId: task.id,
          threadId: route?.thread_id || defaultTaskThreadId(task),
          title: task.title,
          reasonCode,
          detail,
          humanAction,
          actions,
          createdAt: hb?.createdAt || task.updated_at,
        })
      );
    }

    // Add standalone `would_dispatch` proposals not bound to an existing task
    for (const d of pendingDecisions) {
      if (coveredDecisionIds.has(d.id)) continue;
      items.push(
        attentionCard({
          id: `attn_dec_${d.id}`,
          stage: "observe/would_dispatch",
          severity: "info",
          taskId: d.target_task_id || null,
          threadId: d.thread_id,
          decisionId: d.id,
          title: `Shadow Dispatch Proposal (${d.target_agent || "codex"})`,
          reasonCode: d.reason_code,
          detail: d.detail,
          actions: ["approve_dispatch"],
          createdAt: d.created_at,
        })
      );
    }

    items.sort((a, b) => {
      const pa = ATTENTION_PRIORITY[a.stage] || 99;
      const pb = ATTENTION_PRIORITY[b.stage] || 99;
      if (pa !== pb) return pa - pb;
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });

    return items;
  }
}

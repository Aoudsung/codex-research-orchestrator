import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  BridgeUserError,
  REASONS,
  areModelsEquivalent,
  canonicalModelIdentity,
} from "../domain/model.mjs";
import { getExplicitPiRoute } from "../domain/dispatch-planner.mjs";
import { workflowNotificationSessions } from "../domain/task-workflow.mjs";
import { isProcessAlive } from "../runtime/watchdog-service.mjs";
import { loadCollaboratorPolicy, resolveProjectRoot } from "./collaborator-registry.mjs";
import { resolvePiPackageRoot } from "./effort-judge.mjs";
import { captureWorkRunExecution } from "./preflight.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PI_WORKER_PATH = path.resolve(__dirname, "..", "runtime", "pi-worker.mjs");
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);

function safeTaskId(raw) {
  return String(raw || "").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120) || "pi-task";
}

/** Reuse a workflow notice or publish one coordinator handoff for this invocation. */
export function recordPiInvocationHandoff({ bridgeDb, spec, receipt, summary }) {
  return bridgeDb.store.atomic(() => {
    const prior = bridgeDb.db
      .prepare(
        `SELECT id FROM messages
         WHERE task_id = ? AND to_agent = ? AND (
           json_extract(metadata_json, '$.piInvocationId') = ? OR
           json_extract(metadata_json, '$.deliveryReceiptId') = ? OR
           json_extract(metadata_json, '$.notificationKey') = ?
         )
         ORDER BY seq ASC LIMIT 1`
      )
      .get(
        spec.taskId,
        spec.leadAgent,
        receipt.invocationId,
        receipt.receiptId,
        `${spec.taskId}:blocked:${receipt.receiptId}`
      );
    const task = bridgeDb.getTaskById(spec.taskId);
    const sessions = workflowNotificationSessions(bridgeDb.engine, task, spec.leadAgent);
    const message = prior
      ? bridgeDb.getMessageById(prior.id)
      : bridgeDb.sendMessage({
          taskId: spec.taskId,
          fromAgent: spec.actorAgent,
          toAgent: spec.leadAgent,
          allowSelfSend: Boolean(sessions),
          subject: `PI invocation handoff: ${receipt.invocationOutcome}`,
          content: summary,
          metadata: {
            protocolVersion: 2,
            ...(sessions ? { workflowNotification: sessions } : {}),
            artifactKind: "pi_invocation_handoff",
            critical: true,
            piInvocationId: receipt.invocationId,
            invocationOutcome: receipt.invocationOutcome,
            deliveryReceiptId: receipt.receiptId,
            ...(receipt.authorizationReuse
              ? { reusableTaskAuthorization: Boolean(receipt.authorizationReuse.reusableTaskAuthorization) }
              : {}),
          },
        });
    return {
      messageId: message.id,
      invocationId: receipt.invocationId,
      wakeupStatus: message.wakeup_status,
    };
  });
}

function defaultLsofPids(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const out = execFileSync("lsof", ["-t", filePath], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split(/\s+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}

function lockPathForSession(projectRoot, sessionId) {
  const safeId = safeTaskId(sessionId);
  return path.join(path.resolve(projectRoot), ".agent-bridge", "locks", `pi-session-${safeId}.lock`);
}

/**
 * Inspect whether a pinned user PI session is currently busy in another task, lockfile,
 * interactive external client (`lsof`), or unanswered recent user turn.
 */
export function isPinnedSessionInUse({
  projectRoot,
  sessionId,
  sessionPath = null,
  requiredModel = null,
  taskId = null,
  policy = null,
  activeTasks = [],
  pidAliveFn = isProcessAlive,
  lsofFn = defaultLsofPids,
  nowMs = Date.now(),
} = {}) {
  const customAliases = policy?.modelAliases || null;
  // 1) Bridge database active-task collision / maxConcurrentCallsPerModel=1 check
  for (const t of activeTasks || []) {
    if (TERMINAL_TASK_STATUSES.has(t.status) || t.id === taskId) continue;
    const tPiChannel =
      t.metadata?.channel === "pi_pinned" ||
      t.metadata?.executor === "pi" ||
      t.metadata?.runner === "pi";
    if (!tPiChannel) continue;
    if (
      sessionId &&
      (t.bound_conversation_id === sessionId ||
        t.required_conversation_id === sessionId ||
        t.session_id === sessionId)
    ) {
      return {
        busy: true,
        reason: "active_bridge_task_on_session",
        conflictingTaskId: t.id,
      };
    }
    if (
      requiredModel &&
      areModelsEquivalent(t.required_model || t.actual_model, requiredModel, customAliases)
    ) {
      return {
        busy: true,
        reason: "max_concurrent_calls_reached_for_model",
        conflictingTaskId: t.id,
      };
    }
  }

  // 2) Live lockfile check
  if (projectRoot && sessionId) {
    const lockPath = lockPathForSession(projectRoot, sessionId);
    if (fs.existsSync(lockPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (info?.pid && pidAliveFn(Number(info.pid)) && info.taskId !== taskId) {
          return {
            busy: true,
            reason: "lockfile_held_by_live_worker",
            pid: Number(info.pid),
            conflictingTaskId: info.taskId || null,
          };
        }
      } catch {
        // ignore stale unreadable lock
      }
    }
  }

  // 3) External process holding session JSONL open
  if (sessionPath && fs.existsSync(sessionPath)) {
    const openPids = lsofFn(sessionPath);
    if (Array.isArray(openPids) && openPids.length > 0) {
      return {
        busy: true,
        reason: "session_file_open_in_external_client",
        pids: openPids,
      };
    }
    // 4) Unanswered recent user prompt written within last 10s
    try {
      const st = fs.statSync(sessionPath);
      if (nowMs - st.mtimeMs < 10_000) {
        const tail = fs.readFileSync(sessionPath, "utf8").trim().split(/\r?\n/).slice(-1)[0];
        if (tail) {
          const entry = JSON.parse(tail);
          const role = entry?.message?.role || entry?.role;
          if (role === "user") {
            return {
              busy: true,
              reason: "recent_unanswered_user_turn_in_session",
              mtimeMs: st.mtimeMs,
            };
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return { busy: false, reason: null };
}

/**
 * Acquire exclusive lockfile for a pinned session, reaping dead-PID stale locks cleanly.
 */
export function acquirePinnedSessionLock({
  projectRoot,
  sessionId,
  taskId,
  pid = process.pid,
  pidAliveFn = isProcessAlive,
}) {
  const lockPath = lockPathForSession(projectRoot, sessionId);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid, taskId, sessionId, acquiredAt: new Date().toISOString() }) + "\n"
      );
      fs.closeSync(fd);
      return lockPath;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let stale = true;
      try {
        const info = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (info?.pid && pidAliveFn(Number(info.pid))) {
          if (info.taskId === taskId) {
            return lockPath;
          }
          stale = false;
        }
      } catch {
        stale = true;
      }
      if (!stale || attempt === 1) {
        throw new BridgeUserError(
          REASONS.PI_SESSION_BUSY,
          `Pinned PI session '${sessionId}' is locked by another live worker.`,
          { sessionId, lockPath }
        );
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore race
      }
    }
  }
  return lockPath;
}

export function releasePinnedSessionLock(lockPath) {
  if (!lockPath) return;
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // ignore
  }
}

/**
 * Resolve explicit or pinned PI session configuration and build detached execution spec.
 */
export function preparePiExecutionSpec({
  bridgeDb,
  projectRoot = null,
  task,
  stepId = null,
  prompt,
  sessionMode = null,
  sessionId = null,
  sessionPath = null,
  provider = null,
  model = null,
  effort = null,
  contextFiles = [],
  maxLengthContinuations = 2,
  timeoutMs = 600_000,
  callerAgent = "codex",
  testRunnerModule = null,
} = {}) {
  if (!bridgeDb) {
    throw new Error("bridgeDb is required for pi_exec.");
  }
  bridgeDb.admitExecution();
  const execution = captureWorkRunExecution(bridgeDb.engine, task, "pi-task-explicit", stepId);
  const independent = Boolean(execution?.independentPacket);
  if (independent && (
    [sessionMode, task.metadata?.sessionMode].includes("pinned") ||
    sessionId || sessionPath || task.metadata?.sessionPath ||
    contextFiles?.length || (prompt && prompt !== task.prompt)
  )) {
    throw new BridgeUserError(
      REASONS.BLIND_ISOLATION_VIOLATION,
      "Independent PI execution requires a fresh session and the approved review packet alone."
    );
  }

  const resolvedProject = resolveProjectRoot(projectRoot || task?.cwd, bridgeDb.dbPath);
  if (!resolvedProject || !fs.existsSync(resolvedProject)) {
    throw new BridgeUserError(
      REASONS.TASK_SCOPE_CONFLICT,
      `Valid projectRoot is required for pi_exec (got '${resolvedProject}').`
    );
  }
  const realProject = fs.realpathSync(resolvedProject);
  if (execution && task.cwd && fs.realpathSync(task.cwd) !== realProject) {
    throw new BridgeUserError(REASONS.TASK_SCOPE_CONFLICT, "PI cwd must match the bound work run task.");
  }
  const policy = loadCollaboratorPolicy(realProject);

  if (execution && model && task.required_model && !areModelsEquivalent(model, task.required_model, policy?.modelAliases)) {
    throw new BridgeUserError(REASONS.MODEL_MISMATCH, "PI model must match the bound work run task.");
  }
  if (execution && provider && task.metadata?.provider && provider !== task.metadata.provider) {
    throw new BridgeUserError(REASONS.MODEL_CHANNEL_MISMATCH, "PI provider must match the bound work run task.");
  }
  const reqModel = model || task?.required_model || null;
  if (!reqModel) {
    throw new BridgeUserError(
      REASONS.MODEL_UNVERIFIED,
      "pi_exec requires an explicit target model."
    );
  }
  if (/dyschop/i.test(`${provider || ""} ${reqModel}`)) {
    throw new BridgeUserError(
      REASONS.MODEL_CHANNEL_MISMATCH,
      "Legacy 'dyschop/*' gateway is prohibited in pi_exec; use magpie 'auto/*' or pinned Google-Vertex PI session."
    );
  }

  // Detect whether target maps to a user-pinned session in collaborators.json
  const canon = canonicalModelIdentity(reqModel, policy?.modelAliases || null);
  let matchedPinned = null;
  for (const [k, entry] of Object.entries(policy?.pinnedSessions?.pi || {})) {
    if (
      (sessionId && entry?.sessionId === sessionId) ||
      (entry?.model && canonicalModelIdentity(entry.model, policy?.modelAliases) === canon)
    ) {
      matchedPinned = { key: k, ...entry };
      break;
    }
  }

  const effectiveMode = independent ? "task_explicit" : (
    sessionMode ||
    task?.metadata?.sessionMode ||
    (matchedPinned ? "pinned" : "task_explicit"));

  if (!["pinned", "task_explicit"].includes(effectiveMode)) {
    throw new BridgeUserError(
      REASONS.INVALID_COGNITIVE_PROFILE,
      `Invalid PI sessionMode '${effectiveMode}'; expected 'pinned' or 'task_explicit'.`
    );
  }

  const explicitPiRoute = getExplicitPiRoute(policy, reqModel);
  const finalProvider =
    provider ||
    task?.metadata?.provider ||
    matchedPinned?.provider ||
    explicitPiRoute?.provider ||
    "magpie";
  if (
    explicitPiRoute &&
    (effectiveMode !== "task_explicit" || finalProvider !== explicitPiRoute.provider || matchedPinned)
  ) {
    throw new BridgeUserError(
      REASONS.MODEL_CHANNEL_MISMATCH,
      `Registered PI model '${reqModel}' requires task_explicit execution via '${explicitPiRoute.provider}' without a pinned session.`
    );
  }
  const isGemini = /\b(?:gemini|carbon|argon)\b/i.test(canon);
  if (effectiveMode === "task_explicit" && isGemini && !policy?.allowAdhocPiGemini && !explicitPiRoute) {
    throw new BridgeUserError(
      REASONS.MODEL_CHANNEL_MISMATCH,
      `Gemini '${reqModel}' in PI requires a user-pinned session from collaborators.json (sessionMode='pinned'); use pinned Antigravity fallback instead of ad-hoc PI Gemini.`
    );
  }

  let finalSessionId = independent ? null : (sessionId || task?.required_conversation_id || task?.session_id || matchedPinned?.sessionId || null);
  let finalSessionPath = independent ? null : (sessionPath || task?.metadata?.sessionPath || matchedPinned?.sessionPath || null);
  let preserveExistingConfiguration = false;
  let preserveProjectRetryAndCompactionSettings = false;

  if (effectiveMode === "pinned") {
    if (!finalSessionId || !finalSessionPath) {
      throw new BridgeUserError(
        REASONS.CONVERSATION_MISMATCH,
        "Pinned PI execution requires both sessionId and sessionPath."
      );
    }
    const activeTasks = bridgeDb.listTasks({ limit: 200 });
    const busy = isPinnedSessionInUse({
      projectRoot: realProject,
      sessionId: finalSessionId,
      sessionPath: finalSessionPath,
      requiredModel: reqModel,
      taskId: task?.id || null,
      policy,
      activeTasks,
    });
    if (busy.busy) {
      throw new BridgeUserError(
        REASONS.PI_SESSION_BUSY,
        `Pinned PI session '${finalSessionId}' is currently busy (${busy.reason}); fall back to pinned Antigravity or wait until free.`,
        busy
      );
    }
    preserveExistingConfiguration =
      matchedPinned?.preserveExistingConfiguration ?? true;
    preserveProjectRetryAndCompactionSettings =
      matchedPinned?.preserveProjectRetryAndCompactionSettings ?? true;
  } else if (!independent) {
    // Task-explicit new/isolated session inside <project>/.pi/sessions/
    const sessionsDir = path.join(realProject, ".pi", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    if (finalSessionPath) {
      const resolvedSess = path.resolve(realProject, finalSessionPath);
      if (!resolvedSess.startsWith(`${sessionsDir}${path.sep}`)) {
        throw new BridgeUserError(
          REASONS.TASK_SCOPE_CONFLICT,
          `Task-explicit PI sessionPath '${finalSessionPath}' must live under '${sessionsDir}'.`
        );
      }
      finalSessionPath = resolvedSess;
    }
  }

  const resolvedEffort =
    effort ||
    task?.metadata?.effort ||
    task?.metadata?.dispatchSelection?.selectedEffort ||
    explicitPiRoute?.fixedEffort ||
    null;

  const taskIdSafe = safeTaskId(task?.id);
  const invocationId = randomUUID();
  const runDir = execution
    ? path.join(realProject, ".agent-bridge", "pi-runs", taskIdSafe, invocationId)
    : path.join(realProject, ".agent-bridge", "pi-runs", taskIdSafe);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

  const resolvedMaxContinuations = Number.isInteger(maxLengthContinuations)
    ? Math.max(0, Math.min(5, maxLengthContinuations))
    : 2;

  const spec = {
    schemaVersion: 1,
    invocationId,
    taskId: task.id,
    dbPath: path.resolve(bridgeDb.dbPath),
    projectRoot: realProject,
    runDir,
    actorAgent: task.assigned_to || "antigravity",
    leadAgent: task.from_agent || callerAgent || "codex",
    sessionMode: effectiveMode,
    sessionId: finalSessionId,
    sessionPath: finalSessionPath,
    provider: finalProvider,
    model: reqModel,
    effort: resolvedEffort,
    maxLengthContinuations: independent ? 0 : resolvedMaxContinuations,
    preserveExistingConfiguration,
    preserveProjectRetryAndCompactionSettings,
    retries: effectiveMode === "task_explicit" ? 0 : null,
    compaction: effectiveMode === "task_explicit" ? false : null,
    workRun: execution?.workRun || null,
    reviewPacketDigest: execution?.independentPacket?.digest || null,
    prompt: independent ? null : (prompt || task.prompt),
    contextFiles: independent ? [] : (Array.isArray(contextFiles) ? contextFiles : []),
    readRoots: independent ? [] : (task.permissions?.readRoots || task.metadata?.readRoots || ["."]),
    writeRoots: independent ? [] : (task.permissions?.writeRoots || task.metadata?.writeRoots || []),
    denyRoots: independent ? [] : (task.permissions?.denyRoots || task.metadata?.denyRoots || []),
    remoteCommands: independent ? null : (task.metadata?.remoteSpec || null),
    executionContext: independent ? null : {
      operation: "pi_exec",
      objective: task.metadata?.workflow?.contract?.objective || task.title || null,
      sourceRefs: task.metadata?.workflow?.contract?.sourceRefs || [],
      planId: task.metadata?.planId || null,
      contractVersion: task.metadata?.workflow?.contract?.version || null,
      ownerEpoch: task.metadata?.workflow?.owner?.epoch || null,
      authorityEffect: "reference_only",
    },
    workflow: task.metadata?.workflow
      ? {
          contractVersion: task.metadata.workflow.contract.version,
          ownerEpoch: task.metadata.workflow.owner.epoch,
        }
      : null,
    timeoutMs: Number(timeoutMs || 600_000),
    testRunnerModule: testRunnerModule || null,
    createdAt: new Date().toISOString(),
  };

  const specPath = path.join(runDir, "spec.json");
  const receiptPath = path.join(runDir, "receipt.json");
  fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { spec, specPath, receiptPath, runDir };
}

/**
 * Launch PI execution inside a detached managed worker process (`src/runtime/pi-worker.mjs`)
 * so work and durable bridge receipts survive parent one-shot hot-reload worker exits.
 */
export async function launchDetachedPiWorker({
  bridgeDb,
  projectRoot = null,
  task,
  stepId = null,
  prompt,
  sessionMode = null,
  sessionId = null,
  sessionPath = null,
  provider = null,
  model = null,
  effort = null,
  contextFiles = [],
  maxLengthContinuations = 2,
  timeoutMs = 600_000,
  waitForCompletion = true,
  callerAgent = "codex",
  testRunnerModule = null,
} = {}) {
  const { spec, specPath, receiptPath, runDir } = preparePiExecutionSpec({
    bridgeDb,
    projectRoot,
    task,
    stepId,
    prompt,
    sessionMode,
    sessionId,
    sessionPath,
    provider,
    model,
    effort,
    contextFiles,
    maxLengthContinuations,
    timeoutMs,
    callerAgent,
    testRunnerModule,
  });

  if (fs.existsSync(receiptPath)) {
    fs.unlinkSync(receiptPath);
  }

  let pinnedLockPath = null;
  if (spec.sessionMode === "pinned") {
    pinnedLockPath = acquirePinnedSessionLock({
      projectRoot: spec.projectRoot,
      sessionId: spec.sessionId,
      taskId: spec.taskId,
    });
    // Release parent lock ownership handoff immediately before spawning detached worker OR let worker re-acquire cleanly
    releasePinnedSessionLock(pinnedLockPath);
  }

  if (!spec.testRunnerModule && !resolvePiPackageRoot()) {
    throw new BridgeUserError(
      REASONS.EFFORT_JUDGE_UNAVAILABLE,
      "PI SDK installation was not found under PI_PACKAGE_ROOT or ~/.pi/agent/install/releases/."
    );
  }

  const logOut = path.join(runDir, "worker.stdout.log");
  const logErr = path.join(runDir, "worker.stderr.log");
  const outFd = fs.openSync(logOut, "a");
  const errFd = fs.openSync(logErr, "a");

  let child;
  try {
    child = spawn(process.execPath, [PI_WORKER_PATH, specPath], {
      cwd: spec.projectRoot,
      detached: true,
      stdio: ["ignore", outFd, errFd],
      env: {
        ...process.env,
        AGENT_BRIDGE_DB: spec.dbPath,
        AGENT_BRIDGE_PROJECT: spec.projectRoot,
      },
    });
    child.unref();
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }

  if (!waitForCompletion) {
    return {
      ok: true,
      status: "launched_detached",
      detached: true,
      workerPid: child.pid,
      taskId: spec.taskId,
      invocationId: spec.invocationId,
      sessionMode: spec.sessionMode,
      sessionId: spec.sessionId,
      model: spec.model,
      effort: spec.effort,
      runDir,
      receiptPath,
      note: "Detached PI worker started; receipt and coordinator wakeup will be delivered independently.",
    };
  }

  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 600_000));
  let childExited = false;
  let childCode = null;
  child.once("exit", (code) => {
    childExited = true;
    childCode = code;
  });

  while (Date.now() < deadline) {
    if (fs.existsSync(receiptPath)) {
      try {
        const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
        return {
          ok: receipt.transportOutcome === "delivered",
          status: receipt.invocationOutcome || receipt.transportOutcome,
          authorizationReuse: receipt.authorizationReuse || null,
          detached: true,
          workerPid: child.pid,
          receiptPath,
          receipt,
        };
      } catch {
        // wait for atomic write settle
      }
    }
    if (childExited) break;
    await new Promise((r) => setTimeout(r, 80));
  }

  if (fs.existsSync(receiptPath)) {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    return {
      ok: receipt.transportOutcome === "delivered",
      status: receipt.invocationOutcome || receipt.transportOutcome,
      authorizationReuse: receipt.authorizationReuse || null,
      detached: true,
      workerPid: child.pid,
      receiptPath,
      receipt,
    };
  }

  return {
    ok: false,
    status: childExited ? "worker_exited_without_receipt" : "running_detached_timeout",
    detached: true,
    workerPid: child.pid,
    exitCode: childCode,
    receiptPath,
    logErr,
  };
}

import {
  REASONS,
  ROUTER_MODES,
  isBlindIsolated,
  resolveIsolationProfile,
  sha256Hex,
} from "./model.mjs";

const DEFAULT_PEERS = ["antigravity", "codex", "claude-code"];

export function normalizePolicyInput({
  controlsText = "",
  acceptMode = null,
  routerMode = "observe",
  allowedPeers = DEFAULT_PEERS,
} = {}) {
  const normalizedControls = String(controlsText ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  const modeCandidate = acceptMode || routerMode || "observe";
  const effectiveMode = ROUTER_MODES.includes(modeCandidate)
    ? modeCandidate
    : "observe";
  const peers = Array.isArray(allowedPeers)
    ? [...new Set(allowedPeers.map((p) => String(p).trim()).filter(Boolean))].sort()
    : [...DEFAULT_PEERS].sort();

  const controlsHash = sha256Hex(normalizedControls).slice(0, 16);
  return {
    controlsText: normalizedControls,
    controlsHash,
    acceptMode: effectiveMode,
    routerMode: effectiveMode,
    allowedPeers: peers,
  };
}

/**
 * Compute deterministic SHA-256 fingerprint for current research controls & routing policy.
 */
export function computeControlVersion(policyInput = {}) {
  const normalized = normalizePolicyInput(policyInput);
  const canonicalPayload = JSON.stringify({
    controlsHash: normalized.controlsHash,
    acceptMode: normalized.acceptMode,
    allowedPeers: normalized.allowedPeers,
  });
  return `ctrl_${sha256Hex(canonicalPayload).slice(0, 16)}`;
}

/**
 * Build a complete normalized policy snapshot with `controlVersion` and `controlsHash`.
 */
export function buildPolicySnapshot(policyInput = {}) {
  const normalized = normalizePolicyInput(policyInput);
  return {
    ...normalized,
    controlVersion: computeControlVersion(normalized),
  };
}

/**
 * Freeze an immutable task Mandate at creation time.
 */
export function createMandate({
  task,
  controlVersion = "",
  controlsHash = "",
  strength = null,
  isolationProfile = null,
  matchedRuleIds = [],
  nowIso = new Date().toISOString(),
} = {}) {
  if (!task || !task.id) {
    throw new Error("createMandate requires a task with an id");
  }
  const resolvedStrength =
    strength ||
    (task.metadata?.mandateStrength === "inferred" ? "inferred" : "explicit");
  const resolvedIsolation =
    isolationProfile || resolveIsolationProfile(task);
  const scope = {
    protocolVersion: task.metadata?.protocolVersion || 1,
    fromAgent: task.from_agent || task.fromAgent || "codex",
    assignedTo: task.assigned_to || task.assignedTo || null,
    cwd: task.cwd || "",
    readRoots: Array.isArray(task.permissions?.readRoots)
      ? [...task.permissions.readRoots]
      : [],
    writeRoots: Array.isArray(task.permissions?.writeRoots)
      ? [...task.permissions.writeRoots]
      : [],
    requiredModel: task.required_model || task.requiredModel || null,
    controlsHash: controlsHash || task.metadata?.controlsHash || "",
  };

  return {
    task_id: task.id,
    control_version: controlVersion || "",
    strength: resolvedStrength === "inferred" ? "inferred" : "explicit",
    isolation_profile: resolvedIsolation,
    scope,
    matched_rules: Array.isArray(matchedRuleIds) ? [...matchedRuleIds] : [],
    revoked_at: null,
    revoke_reason: null,
    created_at: nowIso,
  };
}

/**
 * Revalidate a stored task Mandate against the current live policy before auto-resuming
 * or routing follow-up traffic directly to the task assignee.
 *
 * @param {object | null} mandate
 * @param {object} currentPolicy
 * @param {{ isResumeFromIdle?: boolean }} [options]
 */
export function revalidateMandate(
  mandate,
  currentPolicy = {},
  { isResumeFromIdle = false } = {}
) {
  if (!mandate) {
    return {
      ok: false,
      reasonCode: REASONS.MANDATE_REVOKED,
      detail: "Task has no recorded mandate.",
    };
  }

  if (mandate.revoked_at) {
    return {
      ok: false,
      reasonCode: REASONS.MANDATE_REVOKED,
      detail: mandate.revoke_reason || `Mandate revoked at ${mandate.revoked_at}`,
    };
  }

  if (isBlindIsolated(mandate)) {
    return {
      ok: false,
      reasonCode: REASONS.BLIND_ISOLATION_VIOLATION,
      detail: `Task '${mandate.task_id}' uses '${mandate.isolation_profile}' isolation; automatic cross-turn/cross-thread routing is prohibited.`,
    };
  }

  const snap = currentPolicy.controlVersion
    ? currentPolicy
    : buildPolicySnapshot(currentPolicy);

  // Inferred mandates cannot auto-resume or auto-fanout when router mode is downgraded below 'auto'
  if (mandate.strength === "inferred" && snap.acceptMode !== "auto") {
    return {
      ok: false,
      reasonCode: REASONS.MANDATE_MODE_DOWNGRADED,
      detail: `Inferred mandate '${mandate.task_id}' requires routerMode='auto', but current mode is '${snap.acceptMode}'.`,
    };
  }

  const assignedTo = mandate.scope?.assignedTo || null;
  if (
    assignedTo &&
    Array.isArray(snap.allowedPeers) &&
    snap.allowedPeers.length > 0 &&
    !snap.allowedPeers.includes(assignedTo)
  ) {
    return {
      ok: false,
      reasonCode: REASONS.PEER_DISALLOWED,
      detail: `Assignee '${assignedTo}' is no longer permitted by current allowedPeers policy.`,
    };
  }

  // Check if controls.md hash changed since mandate creation
  const mandateControlsHash = mandate.scope?.controlsHash || "";
  const controlsChanged =
    Boolean(mandateControlsHash) &&
    Boolean(snap.controlsHash) &&
    mandateControlsHash !== snap.controlsHash;

  if (controlsChanged && isResumeFromIdle && mandate.scope?.protocolVersion !== 2) {
    return {
      ok: false,
      reasonCode: REASONS.CONTROL_VERSION_CHANGED,
      detail: `controls.md changed (${mandate.control_version} -> ${snap.controlVersion}); idle/completed task requires Lead Researcher re-authorization before resume.`,
    };
  }

  return {
    ok: true,
    reasonCode: "MANDATE_VALID",
    controlsChanged,
    controlVersion: snap.controlVersion,
  };
}

/**
 * Compute non-destructive `control_changed` notification descriptors for live tasks
 * when `controls.md` or routing policy changes. Never kills in-progress turns.
 *
 * @param {Array<object>} liveTasks
 * @param {Map<string, object> | Record<string, object>} mandatesByTask
 * @param {object} prevPolicy
 * @param {object} nextPolicy
 */
export function diffPolicyEffects(
  liveTasks = [],
  mandatesByTask = new Map(),
  prevPolicy = {},
  nextPolicy = {}
) {
  const prevSnap = prevPolicy.controlVersion
    ? prevPolicy
    : buildPolicySnapshot(prevPolicy);
  const nextSnap = nextPolicy.controlVersion
    ? nextPolicy
    : buildPolicySnapshot(nextPolicy);

  if (prevSnap.controlVersion === nextSnap.controlVersion) {
    return [];
  }

  const controlsChanged = prevSnap.controlsHash !== nextSnap.controlsHash;
  const getMandate = (taskId) =>
    mandatesByTask instanceof Map
      ? mandatesByTask.get(taskId)
      : mandatesByTask?.[taskId] || null;

  const notices = [];
  for (const task of liveTasks) {
    if (!task || !task.id) continue;
    if (["completed", "failed", "cancelled"].includes(task.status)) continue;

    const mandate = getMandate(task.id);
    const assignedTo = task.assigned_to || mandate?.scope?.assignedTo || null;
    const peerRevoked = Boolean(
      assignedTo &&
        Array.isArray(nextSnap.allowedPeers) &&
        !nextSnap.allowedPeers.includes(assignedTo)
    );
    const modeDowngraded = Boolean(
      mandate?.strength === "inferred" &&
        prevSnap.acceptMode === "auto" &&
        nextSnap.acceptMode !== "auto"
    );

    if (!controlsChanged && !peerRevoked && !modeDowngraded) {
      continue;
    }

    const reasons = [];
    if (controlsChanged) reasons.push("controls_updated");
    if (peerRevoked) reasons.push("peer_disallowed");
    if (modeDowngraded) reasons.push("router_mode_downgraded");

    notices.push({
      taskId: task.id,
      assignedTo,
      prevControlVersion: prevSnap.controlVersion,
      nextControlVersion: nextSnap.controlVersion,
      controlsChanged,
      peerRevoked,
      modeDowngraded,
      reasons,
      summary: `[Control Update ${prevSnap.controlVersion} -> ${nextSnap.controlVersion}] Active constraints changed (${reasons.join(", ")}). Re-read .research-memory/controls.md before committing further state changes; call bridge_handback if your current task now exceeds mandate.`,
    });
  }

  return notices;
}

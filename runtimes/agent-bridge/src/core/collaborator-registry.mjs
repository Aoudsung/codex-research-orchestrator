import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { BUILTIN_MODEL_EQUIVALENCE_GROUPS, BridgeUserError, REASONS } from "../domain/model.mjs";
import { validateModelCatalog } from "../domain/dispatch-planner.mjs";

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const st = fs.lstatSync(filePath);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readCollaborators(filePath) {
  try {
    if (!fs.lstatSync(filePath).isFile()) throw new Error("expected a regular file");
    const policy = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
      throw new Error("expected a JSON object");
    }
    if (Object.hasOwn(policy, "modelCatalog")) validateModelCatalog(policy.modelCatalog, policy);
    return policy;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof BridgeUserError) throw error;
    throw new BridgeUserError(REASONS.MODEL_CHANNEL_MISMATCH, `Cannot read collaborator policy '${filePath}': ${error.message}.`);
  }
}

/**
 * Resolve project root from explicit argument, env vars, or `.agent-bridge/bridge.sqlite` path.
 */
export function resolveProjectRoot(projectRoot = null, dbPath = null) {
  const candidates = [
    projectRoot,
    process.env.RESEARCH_MEMORY_PROJECT,
    process.env.AGENT_BRIDGE_PROJECT,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      return path.resolve(c.trim());
    }
  }
  if (typeof dbPath === "string" && dbPath.trim()) {
    const resolvedDb = path.resolve(dbPath.trim());
    const parent = path.dirname(resolvedDb);
    if (path.basename(parent) === ".agent-bridge") {
      return path.dirname(parent);
    }
    return parent;
  }
  return null;
}

/**
 * Resolve path to canonical collaborator policy JSON.
 */
export function collaboratorsRegistryPath(projectRoot) {
  if (!projectRoot) return null;
  return path.join(path.resolve(projectRoot), ".agent-bridge", "collaborators.json");
}

function defaultAliasMap() {
  const map = {};
  for (const grp of BUILTIN_MODEL_EQUIVALENCE_GROUPS) {
    map[grp[0]] = grp.slice(1);
  }
  return map;
}

function mergeLegacySessionFiles(projectRoot) {
  const piMeta = readJsonSafe(path.join(projectRoot, ".pi", "model-sessions.json"));
  const agyMeta = readJsonSafe(
    path.join(projectRoot, ".agent-bridge", "antigravity-model-sessions.json")
  );
  if (!piMeta && !agyMeta) return null;

  const piSessions = {};
  if (piMeta?.sessions && typeof piMeta.sessions === "object") {
    for (const [k, v] of Object.entries(piMeta.sessions)) {
      if (!v || typeof v !== "object") continue;
      piSessions[k] = {
        ...v,
        preserveExistingConfiguration:
          piMeta?.dispatchPolicy?.preserveExistingConfiguration ?? true,
        preserveProjectRetryAndCompactionSettings:
          piMeta?.dispatchPolicy?.preserveProjectRetryAndCompactionSettings ?? true,
        maxConcurrentCalls: piMeta?.dispatchPolicy?.maxConcurrentCallsPerModel ?? 1,
      };
    }
  }

  const agySessions = {};
  if (agyMeta?.sessions && typeof agyMeta.sessions === "object") {
    for (const [k, v] of Object.entries(agyMeta.sessions)) {
      if (!v || typeof v !== "object") continue;
      agySessions[k] = { ...v };
    }
  }

  return {
    schemaVersion: 1,
    source: "legacy_merged",
    collaborationPolicyVersion: piMeta?.authority || agyMeta?.authority || "legacy-inferred",
    protocolEpoch: null,
    authority: piMeta?.authority || agyMeta?.authority || "",
    channelPreferences: {
      gemini:
        piMeta?.selectionPolicy === "pi_first_antigravity_when_pi_unavailable" ||
        agyMeta?.routing?.gemini?.toLowerCase().includes("pi")
          ? ["pi_pinned", "antigravity_pinned"]
          : ["pi_pinned", "antigravity_pinned"],
      gpt: ["codex"],
      openWeight: ["pi_task_explicit"],
      webPro: ["chatgpt_web_project"],
    },
    modelAliases: defaultAliasMap(),
    explicitPiRoutes: [],
    pinnedSessions: {
      pi: piSessions,
      antigravity: agySessions,
    },
    subagentLifecyclePolicy: {
      retireAfterTaskHandback: {},
      softSizeRotationBytes: 8 * 1024 * 1024,
    },
  };
}

/**
 * Load `.agent-bridge/collaborators.json` strictly for user policy & pinned sessions.
 * Runtime facts remain in `bridge.sqlite`. Falls back read-only to legacy `.pi/model-sessions.json`
 * and `.agent-bridge/antigravity-model-sessions.json` if `collaborators.json` is absent.
 */
export function loadCollaboratorPolicy(projectRoot, { fallbackToLegacy = true } = {}) {
  const root = resolveProjectRoot(projectRoot);
  if (!root) return null;
  const regPath = collaboratorsRegistryPath(root);
  const direct = readCollaborators(regPath);
  if (direct) {
    return {
      schemaVersion: 1,
      source: "collaborators.json",
      path: regPath,
      ...direct,
      channelPreferences: {
        gemini: ["pi_pinned", "antigravity_pinned"],
        gpt: ["codex"],
        openWeight: ["pi_task_explicit"],
        webPro: ["chatgpt_web_project"],
        ...(direct.channelPreferences || {}),
      },
      modelAliases: {
        ...defaultAliasMap(),
        ...(direct.modelAliases || {}),
      },
      explicitPiRoutes: Array.isArray(direct.explicitPiRoutes) ? direct.explicitPiRoutes : [],
      pinnedSessions: {
        pi: {},
        antigravity: {},
        webPro: {},
        ...(direct.pinnedSessions || {}),
      },
      subagentLifecyclePolicy: {
        retireAfterTaskHandback: {},
        softSizeRotationBytes: 8 * 1024 * 1024,
        ...(direct.subagentLifecyclePolicy || {}),
      },
    };
  }
  return fallbackToLegacy ? mergeLegacySessionFiles(root) : null;
}

/**
 * Atomically persist `.agent-bridge/collaborators.json` (policy & pinned session bindings only).
 */
export function saveCollaboratorPolicy(projectRoot, payload) {
  const root = resolveProjectRoot(projectRoot);
  if (!root) throw new Error("projectRoot is required to save collaborators.json");
  const modelCatalog = payload?.modelCatalog;
  if (modelCatalog !== undefined) validateModelCatalog(modelCatalog, payload);
  const regPath = collaboratorsRegistryPath(root);
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  const normalized = {
    schemaVersion: 1,
    collaborationPolicyVersion:
      payload?.collaborationPolicyVersion || `collab_${new Date().toISOString().slice(0, 10)}`,
    protocolEpoch: payload?.protocolEpoch || null,
    coordinatorSessionId: payload?.coordinatorSessionId || null,
    authority: payload?.authority || "",
    channelPreferences: {
      gemini: ["pi_pinned", "antigravity_pinned"],
      gpt: ["codex"],
      openWeight: ["pi_task_explicit"],
      webPro: ["chatgpt_web_project"],
      ...(payload?.channelPreferences || {}),
    },
    modelAliases: {
      ...defaultAliasMap(),
      ...(payload?.modelAliases || {}),
    },
    explicitPiRoutes: Array.isArray(payload?.explicitPiRoutes) ? payload.explicitPiRoutes : [],
    ...(modelCatalog === undefined ? {} : { modelCatalog }),
    pinnedSessions: {
      pi: {},
      antigravity: {},
      webPro: {},
      ...(payload?.pinnedSessions || {}),
    },
    subagentLifecyclePolicy: {
      retireAfterTaskHandback: {},
      softSizeRotationBytes: 8 * 1024 * 1024,
      ...(payload?.subagentLifecyclePolicy || {}),
    },
  };
  const tmpPath = `${regPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, regPath);
  return loadCollaboratorPolicy(root);
}

/**
 * Build compact, compaction-resilient `[Collaboration Recovery]` digest combining
 * static policy (`collaborators.json`) + live runtime task facts (`bridge.sqlite`).
 */
export function buildCollaborationRecoveryDigest({
  projectRoot = null,
  dbPath = null,
  engine = null,
  policy = null,
} = {}) {
  const root = resolveProjectRoot(projectRoot, dbPath);
  const reg = policy || (root ? loadCollaboratorPolicy(root) : null);
  const ctrl = engine ? engine.getControlState() : {};
  const tasks = engine ? engine.listTasks({ limit: 200 }) : [];

  const inFlight = tasks
    .filter((t) => !TERMINAL_TASK_STATUSES.has(t.status))
    .map((t) => ({
      taskId: t.id,
      assignedTo: t.assigned_to,
      status: t.status,
      phase: t.phase,
      requiredModel: t.required_model || null,
      actualModel: t.actual_model || null,
      effort: t.metadata?.effort || t.metadata?.dispatchSelection?.selectedEffort || null,
      conversationId: t.bound_conversation_id || t.required_conversation_id || t.session_id || null,
    }));

  if (!reg && inFlight.length === 0) {
    return null;
  }

  const collabVer = reg?.collaborationPolicyVersion || "unversioned";
  const epoch = reg?.protocolEpoch || "unspecified";
  const ctrlVer = ctrl?.controlVersion || "unset";
  const geminiPref = Array.isArray(reg?.channelPreferences?.gemini)
    ? reg.channelPreferences.gemini.join(" -> ")
    : "pi_pinned -> antigravity_pinned";

  const specialItems = [];
  const agySessions = reg?.pinnedSessions?.antigravity || {};
  for (const [key, entry] of Object.entries(agySessions)) {
    if (entry?.dedicatedScope && entry?.conversationId) {
      specialItems.push(`${key}->Agy:${entry.conversationId.slice(0, 8)}(${entry.dedicatedScope})`);
    }
  }
  const retiring = reg?.subagentLifecyclePolicy?.retireAfterTaskHandback || {};
  for (const [subKey, info] of Object.entries(retiring)) {
    if (info?.boundTaskId) {
      const boundTask = tasks.find((t) => t.id === info.boundTaskId);
      const stillLive = boundTask ? !TERMINAL_TASK_STATUSES.has(boundTask.status) : false;
      specialItems.push(
        `${subKey}[${info.recordedModel || "sol"}/${info.recordedEffort || "medium"}]` +
          (stillLive ? `->retire_after(${info.boundTaskId})` : `->RETIRED(${info.boundTaskId} ${boundTask?.status || "done"})`)
      );
    }
  }

  const inFlightStr =
    inFlight.length === 0
      ? "none"
      : inFlight
          .slice(0, 4)
          .map(
            (t) =>
              `${t.taskId}(${t.assignedTo}/${t.requiredModel || "auto"}${t.effort ? ":" + t.effort : ""}/${t.phase})`
          )
          .join(", ") + (inFlight.length > 4 ? ` (+${inFlight.length - 4} more)` : "");

  const lines = [
    `[Collaboration Recovery] policy=${collabVer} | epoch=${epoch} | control=${ctrlVer}`,
    `Collaborators: WebPro(project) | Gemini Carbon/Argon(${geminiPref}) | Codex(Astra, 6.1-Sol, gpt-6-luna low via default|explorer; agent_type=Luna=effort_judge_only) | PI(magpie auto/kimi-k3.1-pro, auto/deepseek-v4.1-flash; no dyschop)`,
    ...(specialItems.length > 0 ? [`Special/Retiring: ${specialItems.join("; ")}`] : []),
    `In-flight tasks (${inFlight.length}): ${inFlightStr}`,
    `Next dispatch: call bridge_plan_dispatch(objective, workload, ...) before delegating; fork_turns="none" requires complete materials, controls & boundaries.`,
  ];

  return {
    collaborationPolicyVersion: collabVer,
    protocolEpoch: epoch,
    controlVersion: ctrlVer,
    coordinatorSessionId: reg?.coordinatorSessionId || null,
    geminiChannelOrder: reg?.channelPreferences?.gemini || ["pi_pinned", "antigravity_pinned"],
    pinnedSessions: reg?.pinnedSessions || {},
    retiringSubagents: retiring,
    inFlightTasks: inFlight,
    textBlock: lines.join("\n"),
  };
}

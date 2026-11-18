import {
  BUILTIN_MODEL_EQUIVALENCE_GROUPS,
  BridgeUserError,
  REASONS,
  areModelsEquivalent,
  canonicalModelIdentity,
  normalizeModelId,
} from "./model.mjs";

export const WORKLOAD_TYPES = Object.freeze([
  "macro_breakthrough",
  "panoramic_design",
  "math_or_efficiency_audit",
  "blind_review",
  "coupled_core_impl",
  "bounded_module_or_data",
  "log_evidence_extract",
  "runtime_status_monitor",
]);

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const CHANNELS = ["codex", "pi_pinned", "antigravity", "pi_task_explicit", "web_pro"];
const CONTEXT_SCALES = ["small", "medium", "large_repo_or_logs"];
const LUNA_MODEL = "gpt-6-luna";
const WEB_PRO_MODEL = "chatgpt-pro";
const OPEN_WEIGHT_MODELS = ["auto/deepseek-v4.1-flash", "auto/kimi-k3.1-pro"];
const GEMINI_MODELS = { carbon: "gemini-4-carbon", argon: "gemini-4-argon" };
const GEMINI_CHANNELS = ["pi_pinned", "antigravity"];
const onChannel = (workload) => ({ workload, explicitChannelOnly: true });
const atScale = (workload, contextScale) => ({ workload, contextScales: [contextScale] });

const DEFAULT_MODEL_CATALOG = {
  [WEB_PRO_MODEL]: { channels: ["web_pro"], capabilities: ["macro_breakthrough"] },
  [GEMINI_MODELS.carbon]: {
    channels: GEMINI_CHANNELS,
    capabilities: [
      "panoramic_design",
      atScale("math_or_efficiency_audit", "large_repo_or_logs"),
      onChannel("math_or_efficiency_audit"),
    ],
  },
  "gpt-6.2-astra": {
    channels: ["codex"],
    capabilities: ["blind_review", "math_or_efficiency_audit"],
  },
  [LUNA_MODEL]: {
    channels: ["codex"],
    capabilities: ["runtime_status_monitor", atScale("log_evidence_extract", "small")],
  },
  [OPEN_WEIGHT_MODELS[0]]: {
    channels: ["pi_task_explicit"],
    capabilities: ["log_evidence_extract"],
  },
  [OPEN_WEIGHT_MODELS[1]]: {
    channels: ["pi_task_explicit"],
    capabilities: ["bounded_module_or_data", onChannel("coupled_core_impl")],
  },
  [GEMINI_MODELS.argon]: {
    channels: GEMINI_CHANNELS,
    capabilities: [
      atScale("coupled_core_impl", "large_repo_or_logs"),
      onChannel("coupled_core_impl"),
      onChannel("bounded_module_or_data"),
      onChannel("log_evidence_extract"),
    ],
  },
  "gpt-6.2-sol": {
    channels: ["codex"],
    capabilities: [
      "coupled_core_impl",
      onChannel("bounded_module_or_data"),
      onChannel("log_evidence_extract"),
      onChannel("panoramic_design"),
    ],
  },
  "gpt-6-astra": { channels: ["codex"], capabilities: [] },
  "gpt-6.1-sol": { channels: ["codex"], capabilities: [] },
  "gpt-6-sol": { channels: ["codex"], capabilities: [] },
  "gpt-6.1-terra": { channels: ["codex"], capabilities: [] },
};

const DEFAULT_ROLES = {
  macro_breakthrough: "brainstormer",
  panoramic_design: "brainstormer",
  math_or_efficiency_audit: "architect",
  blind_review: "reviewer",
  coupled_core_impl: "worker_sol",
  bounded_module_or_data: "worker",
  log_evidence_extract: "explorer",
  runtime_status_monitor: "default",
};

function invalidCatalog(message) {
  return new BridgeUserError(REASONS.MODEL_CHANNEL_MISMATCH, `Invalid collaborators.json modelCatalog: ${message}`);
}

/** Check project authorization at the load/save boundary and before pure dispatch. */
export function validateModelCatalog(catalog, policy = null) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw invalidCatalog("expected an object keyed by executable model ID.");
  }
  for (const [model, entry] of Object.entries(catalog)) {
    if (!model.trim() || model !== model.trim() || /dyschop/i.test(model) ||
        !entry || typeof entry !== "object" || Array.isArray(entry) ||
        !Array.isArray(entry.channels) || !entry.channels.length ||
        entry.channels.some((channel) => !CHANNELS.includes(channel)) ||
        !Array.isArray(entry.capabilities)) {
      throw invalidCatalog(`'${model}' requires authorized channels and a capabilities array.`);
    }
    const authorized = authorizedChannels(model, policy?.modelAliases, policy);
    if (entry.channels.some((channel) => !authorized.includes(channel))) {
      throw invalidCatalog(`'${model}' has an incompatible channel; authorized channels are ${authorized.join(", ")}.`);
    }
    for (const capability of entry.capabilities) {
      if (typeof capability === "string" && WORKLOAD_TYPES.includes(capability)) continue;
      if (!capability || typeof capability !== "object" ||
          !WORKLOAD_TYPES.includes(capability.workload) ||
          (capability.contextScales !== undefined &&
           (!Array.isArray(capability.contextScales) || !capability.contextScales.length ||
            capability.contextScales.some((scale) => !CONTEXT_SCALES.includes(scale)))) ||
          (capability.explicitChannelOnly !== undefined && typeof capability.explicitChannelOnly !== "boolean")) {
        throw invalidCatalog(`'${model}' contains an invalid capability.`);
      }
    }
  }
  return catalog;
}

/** Exact identities explicitly authorized for task-scoped PI execution. */
export function getExplicitPiRoute(policy, model) {
  const routes = Array.isArray(policy?.explicitPiRoutes) ? policy.explicitPiRoutes : [];
  return (
    routes.find(
      (entry) =>
        typeof entry?.provider === "string" &&
        entry.provider &&
        typeof entry?.model === "string" &&
        entry.model &&
        !/dyschop/i.test(`${entry.provider}/${entry.model}`) &&
        (model === entry.model || model === `${entry.provider}/${entry.model}`)
    ) || null
  );
}

function resolveAliasesForModel(model, customAliases = null) {
  const canon = canonicalModelIdentity(model, customAliases);
  const aliases = new Set([model]);
  if (customAliases && typeof customAliases === "object") {
    for (const [k, list] of Object.entries(customAliases)) {
      const group = [k, ...(Array.isArray(list) ? list : [list])];
      if (group.some((item) => canonicalModelIdentity(item, customAliases) === canon)) {
        for (const item of group) aliases.add(item);
      }
    }
  }
  for (const grp of BUILTIN_MODEL_EQUIVALENCE_GROUPS) {
    if (grp.some((item) => canonicalModelIdentity(item, customAliases) === canon)) {
      for (const item of grp) aliases.add(item);
    }
  }
  return [...aliases];
}

function getPinnedGeminiEntry({ policy, model, channels, explicitChannel, isColabTarget, activeTasks, busySet }) {
  const aliases = policy?.modelAliases;
  const canon = canonicalModelIdentity(model, aliases);
  const aliasKey = Object.keys(GEMINI_MODELS).find(
    (key) => areModelsEquivalent(model, GEMINI_MODELS[key], aliases)
  );
  const sessions = policy?.pinnedSessions;
  const findSession = (bindings) =>
    (aliasKey && bindings?.[aliasKey]) ||
    Object.entries(bindings || {}).find(
      ([key, entry]) => key !== "colab" && areModelsEquivalent(entry?.model, model, aliases)
    )?.[1];
  const piEntry = findSession(sessions?.pi);
  const agyEntry = findSession(sessions?.antigravity);
  const colabEntry = sessions?.antigravity?.colab;
  const base = { assignedTo: "antigravity", sessionPath: null, selectedModel: model };
  const bindAntigravity = (entry, piBusyReason = null) => {
    assertPinnedModel(entry, model, aliases);
    return {
      ...base,
      channel: "antigravity",
      provider: "antigravity",
      executor: "antigravity",
      sessionMode: entry?.conversationId ? "pinned" : "unpinned",
      targetSessionId: entry?.conversationId || null,
      selectedModel: entry?.model || model,
      nativeModelId: entry?.nativeModelId || null,
      allowedModelAliases: [
        ...new Set([...resolveAliasesForModel(model, aliases), ...[entry?.nativeModelId].filter(Boolean)]),
      ],
      piBusyFallbackApplied: Boolean(piBusyReason),
      piBusyReason,
    };
  };
  if (isColabTarget && channels.includes("antigravity") && colabEntry?.conversationId &&
      areModelsEquivalent(colabEntry.model || GEMINI_MODELS.argon, model, aliases)) {
    return {
      ...bindAntigravity(colabEntry),
      selectionReason: "Colab target matched a dedicated Antigravity conversation from collaborators.json.",
    };
  }

  const preferred = explicitChannel ? [explicitChannel] :
    (policy?.channelPreferences?.gemini || ["pi_pinned", "antigravity"]);
  const permitted = preferred
    .map((channel) => channel === "antigravity_pinned" ? "antigravity" : channel)
    .filter((channel) => channels.includes(channel));
  const piBusyTask = piEntry?.sessionId && permitted.includes("pi_pinned")
    ? activeTasks.find((task) => !TERMINAL_STATUSES.has(task.status) && (
        task.bound_conversation_id === piEntry.sessionId ||
        task.required_conversation_id === piEntry.sessionId ||
        ((task.metadata?.channel === "pi_pinned" ||
          task.metadata?.executor === "pi" || task.metadata?.runner === "pi") &&
          canonicalModelIdentity(task.required_model || task.actual_model, aliases) === canon)
      ))
    : null;
  const piBusy = piEntry?.sessionId && permitted.includes("pi_pinned") &&
    (piBusyTask || busySet.has(piEntry.sessionId));
  const piBusyMessage = piBusy
    ? `Pinned PI session ${piEntry.sessionId} busy${piBusyTask ? ` with ${piBusyTask.id}` : ""}.`
    : null;

  for (const channel of permitted) {
    if (channel === "pi_pinned" && piEntry?.sessionId && !piBusy) {
      assertPinnedModel(piEntry, model, aliases);
      return {
        ...base,
        channel,
        provider: piEntry.provider || "google-vertex",
        executor: "pi",
        sessionMode: "pinned",
        targetSessionId: piEntry.sessionId,
        sessionPath: piEntry.sessionPath || null,
        preserveExistingConfiguration: piEntry.preserveExistingConfiguration ?? true,
        preserveProjectRetryAndCompactionSettings:
          piEntry.preserveProjectRetryAndCompactionSettings ?? true,
        maxConcurrentCalls: piEntry.maxConcurrentCalls ?? 1,
        selectedModel: piEntry.model || model,
        allowedModelAliases: resolveAliasesForModel(model, aliases),
        piBusyFallbackApplied: false,
      };
    }
    if (channel === "antigravity" && agyEntry?.conversationId) {
      return bindAntigravity(agyEntry, piBusyMessage
        ? `${piBusyMessage} Selected the pinned Antigravity conversation for the same model.`
        : null);
    }
  }

  if (piBusy) {
    throw new BridgeUserError(REASONS.PI_SESSION_BUSY, piBusyMessage);
  }
  if (permitted.includes("antigravity")) return bindAntigravity(null);
  throw new BridgeUserError(
    REASONS.MODEL_CHANNEL_MISMATCH,
    `No authorized pinned session is available for '${model}' on '${permitted.join(", ") || channels.join(", ")}'.`
  );
}

function assertPinnedModel(entry, model, aliases) {
  if (entry?.model && !areModelsEquivalent(entry.model, model, aliases)) {
    throw new BridgeUserError(
      REASONS.MODEL_MISMATCH,
      `Pinned model '${entry.model}' conflicts with authorized model '${model}'.`
    );
  }
}

function recentNonMonitorModels(tasks = []) {
  return tasks
    .filter((t) => {
      const m = normalizeModelId(t.required_model || t.actual_model || "");
      return m && !/\bluna\b/.test(m);
    })
    .slice(0, 6)
    .map((t) => canonicalModelIdentity(t.required_model || t.actual_model || ""));
}

function findContinuityAuthor(writeRoots = [], activeTasks = [], protocolEpoch = null, policy = null) {
  if (!Array.isArray(writeRoots) || writeRoots.length === 0) return null;
  const retiring = policy?.subagentLifecyclePolicy?.retireAfterTaskHandback || {};
  const retiredIds = new Set(
    Object.values(retiring)
      .map((x) => x?.sessionId)
      .filter(Boolean)
  );
  const normRoots = writeRoots.map((r) => String(r || "").replace(/\/+$/, ""));
  for (const t of activeTasks) {
    if (["cancelled", "failed"].includes(t.status)) continue;
    const tEpoch = t.metadata?.protocolEpoch || t.metadata?.dispatchSelection?.protocolEpoch || null;
    if (protocolEpoch && tEpoch && tEpoch !== protocolEpoch) continue;
    const conv = t.bound_conversation_id || t.session_id || null;
    if (conv && retiredIds.has(conv)) continue;
    const tRoots = (t.permissions?.writeRoots || t.metadata?.writeRoots || []).map((r) =>
      String(r || "").replace(/\/+$/, "")
    );
    const overlaps = normRoots.some((nr) =>
      tRoots.some((tr) => tr === nr || tr.startsWith(`${nr}/`) || nr.startsWith(`${tr}/`))
    );
    if (overlaps && (t.required_model || t.actual_model)) {
      return t;
    }
  }
  return null;
}

/**
 * Evaluate subagent reuse compatibility against judged model, effort, epoch, isolation, and retirement policy.
 */
export function evaluateSubagentReuse({
  candidateSubagents = [],
  selectedAgent,
  selectedRole,
  selectedModel,
  selectedEffort = null,
  isolationProfile = "shared",
  policy = null,
} = {}) {
  if (isolationProfile === "blind_review" || isolationProfile === "blind_analysis") {
    return {
      action: "spawn_new",
      reuseAllowed: false,
      targetAgentPath: null,
      targetSessionId: null,
      reason: `${isolationProfile} requires an uncontaminated independent session (fork_turns="none").`,
      rotationAdvisory: null,
    };
  }
  if (selectedAgent !== "codex" || !Array.isArray(candidateSubagents) || candidateSubagents.length === 0) {
    return {
      action: selectedAgent === "codex" ? "spawn_new" : "dispatch_channel",
      reuseAllowed: false,
      targetAgentPath: null,
      targetSessionId: null,
      reason:
        selectedAgent === "codex"
          ? "No active Codex subagent matched; spawn fresh with fork_turns=\"none\" and complete bootstrap materials."
          : "Dispatch through selected external/PI channel.",
      rotationAdvisory: null,
    };
  }

  const customAliases = policy?.modelAliases || null;
  const currentEpoch = policy?.protocolEpoch || null;
  const retiringMap = policy?.subagentLifecyclePolicy?.retireAfterTaskHandback || {};
  const softLimit = Number(policy?.subagentLifecyclePolicy?.softSizeRotationBytes || 8 * 1024 * 1024);

  const rejections = [];
  for (const cand of candidateSubagents) {
    if (!cand || typeof cand !== "object") continue;
    const key = cand.agentPath || cand.sessionId || "unknown";
    const retireEntry =
      retiringMap[cand.agentPath] || retiringMap[cand.sessionId] || null;
    if (retireEntry) {
      rejections.push(`${key}: retiring_after_task(${retireEntry.boundTaskId || "bound"})`);
      continue;
    }
    if (currentEpoch && cand.protocolEpoch && cand.protocolEpoch !== currentEpoch) {
      rejections.push(`${key}: protocolEpoch mismatch (${cand.protocolEpoch} != ${currentEpoch})`);
      continue;
    }
    if (!areModelsEquivalent(cand.model, selectedModel, customAliases)) {
      rejections.push(`${key}: model mismatch (${cand.model} != ${selectedModel})`);
      continue;
    }
    if (selectedEffort && cand.effort && String(cand.effort).toLowerCase() !== String(selectedEffort).toLowerCase()) {
      rejections.push(`${key}: effort mismatch (${cand.effort} != ${selectedEffort})`);
      continue;
    }
    if (selectedRole && cand.role && cand.role !== selectedRole) {
      rejections.push(`${key}: role mismatch (${cand.role} != ${selectedRole})`);
      continue;
    }

    const bytes = Number(cand.jsonlBytes || 0);
    const rotationAdvisory =
      bytes > softLimit
        ? {
            shouldRotate: true,
            jsonlBytes: bytes,
            softLimitBytes: softLimit,
            note: `Subagent disk JSONL is ${(bytes / (1024 * 1024)).toFixed(1)} MiB (> 8 MiB advisory); consider fresh spawn on next milestone.`,
          }
        : null;

    return {
      action: "followup_existing",
      reuseAllowed: true,
      targetAgentPath: cand.agentPath || null,
      targetSessionId: cand.sessionId || null,
      reason: `Matching active ${cand.model} (${cand.effort || "default"}) subagent in current protocolEpoch.`,
      rotationAdvisory,
    };
  }

  return {
    action: "spawn_new",
    reuseAllowed: false,
    targetAgentPath: null,
    targetSessionId: null,
    reason:
      rejections.length > 0
        ? `No reusable subagent (${rejections.join("; ")}); spawn_new with fork_turns="none".`
        : "Spawn fresh subagent with fork_turns=\"none\".",
    rotationAdvisory: null,
  };
}

function matchingCapability(entry, workload, contextScale, explicitChannel, ignoreContext = false) {
  return entry.capabilities.some((capability) => {
    if (typeof capability === "string") return capability === workload;
    return capability.workload === workload &&
      (ignoreContext || !capability.explicitChannelOnly || explicitChannel) &&
      (ignoreContext || !capability.contextScales || capability.contextScales.includes(contextScale));
  });
}

function sessionIndependentChannels(channels, isolationProfile) {
  return isolationProfile === "shared" ? channels :
    channels.filter((channel) => channel === "codex" || channel === "pi_task_explicit");
}

function authorizedChannels(model, aliases, policy) {
  const identity = canonicalModelIdentity(model, aliases);
  if (areModelsEquivalent(model, LUNA_MODEL, aliases)) return ["codex"];
  if (areModelsEquivalent(model, WEB_PRO_MODEL, aliases)) return ["web_pro"];
  if (/\b(?:gpt-|codex|astra|sol\b)/.test(identity)) return ["codex"];
  if (Object.values(GEMINI_MODELS).some((item) => areModelsEquivalent(model, item, aliases))) {
    return GEMINI_CHANNELS;
  }
  if (OPEN_WEIGHT_MODELS.some((item) => areModelsEquivalent(model, item, aliases))) return ["pi_task_explicit"];
  const registered = getExplicitPiRoute(policy, model);
  if (registered && model === `${registered.provider}/${registered.model}`) return ["pi_task_explicit"];
  if (/\b(?:gemini|carbon|argon)\b/.test(identity)) {
    return [...GEMINI_CHANNELS, ...(registered ? ["pi_task_explicit"] : [])];
  }
  if (/\b(?:kimi|deepseek|moonshot)\b/.test(identity)) return registered ? ["pi_task_explicit"] : [];
  return ["codex", "antigravity", "pi_pinned", ...(registered ? ["pi_task_explicit"] : [])];
}

/**
 * Select one authorized model before effort judgment. Binding errors for the selected model
 * propagate to the caller. Gemini may use an authorized alternate session for the same identity.
 */
export function selectDispatchCandidate(request = {}, context = {}) {
  const {
    objective = "",
    workload = "coupled_core_impl",
    contextScale = "medium",
    couplingRisk = null,
    writeRoots = [],
    explicitModel = null,
    explicitChannel = null,
    isolationProfile = null,
    busySessionIds = [],
  } = request;
  const policy = context.policy || null;
  const aliases = policy?.modelAliases;
  const activeTasks = Array.isArray(context.activeTasks) ? context.activeTasks : [];
  const isolation = workload === "blind_review" ? "blind_review" : isolationProfile || "shared";
  const isColabTarget =
    /\bcolab\b/i.test(objective) || writeRoots.some((root) => /\bcolab\b/i.test(String(root || "")));
  const projectCatalog = policy?.modelCatalog;
  const catalog = projectCatalog === undefined ? DEFAULT_MODEL_CATALOG : validateModelCatalog(projectCatalog, policy);
  const entries = Object.entries(catalog);

  if (explicitChannel && !CHANNELS.includes(explicitChannel)) {
    throw new BridgeUserError(REASONS.MODEL_CHANNEL_MISMATCH, `Unknown dispatch channel '${explicitChannel}'.`);
  }

  const findExactModel = (target) => entries.find(([model]) => model === target);
  const findModel = (target) =>
    findExactModel(target) ||
    entries.find(([model]) => areModelsEquivalent(model, target, aliases));
  const channelsFor = ([model, entry]) => {
    const authorized = authorizedChannels(model, aliases, policy);
    if (entry.channels.some((channel) => !authorized.includes(channel))) {
      throw invalidCatalog(`'${model}' has an incompatible channel; authorized channels are ${authorized.join(", ")}.`);
    }
    return sessionIndependentChannels(entry.channels, isolation)
      .filter((channel) => !explicitChannel || explicitChannel === channel);
  };

  let candidate;
  let selectionReason;
  if (explicitModel) {
    const registered = getExplicitPiRoute(policy, explicitModel);
    const registeredCandidate = registered
      ? [explicitModel, { channels: ["pi_task_explicit"], capabilities: [] }] : null;
    const providerQualified = registered && explicitModel === `${registered.provider}/${registered.model}`;
    candidate = providerQualified
      ? findExactModel(explicitModel) || registeredCandidate
      : findModel(explicitModel) || registeredCandidate;
    if (!candidate) {
      throw new BridgeUserError(
        REASONS.MODEL_CHANNEL_MISMATCH,
        `Explicit model '${explicitModel}' is outside the authorized model catalog.`
      );
    }
    selectionReason = "Explicit model selected from project authorization.";
  } else {
    const eligible = (entry, ignoreContext = false) =>
      matchingCapability(entry[1], workload, contextScale, explicitChannel, ignoreContext) &&
      channelsFor(entry).length > 0;
    if (workload === "coupled_core_impl" && !explicitChannel) {
      if (isColabTarget && policy?.pinnedSessions?.antigravity?.colab?.conversationId) {
        const colab = findModel(policy.pinnedSessions.antigravity.colab.model || GEMINI_MODELS.argon);
        if (colab && eligible(colab, projectCatalog === undefined) && channelsFor(colab).includes("antigravity")) {
          candidate = colab;
        }
      }
      if (!candidate && projectCatalog === undefined) {
        const author = findContinuityAuthor(writeRoots, activeTasks, policy?.protocolEpoch, policy);
        const authorModel = author && findModel(author.required_model || author.actual_model);
        if (authorModel && eligible(authorModel, true)) {
          candidate = authorModel;
          selectionReason = `Same-module continuity with task ${author.id} using an authorized model.`;
        }
        const argon = findModel(GEMINI_MODELS.argon);
        const pinnedArgon = policy?.pinnedSessions?.pi?.argon?.sessionId ||
          policy?.pinnedSessions?.antigravity?.argon?.conversationId;
        const solCount = recentNonMonitorModels(activeTasks).filter((model) => /^gpt-6(?:\.\d+)?-sol$/.test(model)).length;
        if (!candidate && argon && pinnedArgon && couplingRisk !== "high" && solCount >= 3 && eligible(argon, true)) {
          candidate = argon;
          selectionReason = "Authorized Gemini Argon session selected for the current collaboration workload.";
        }
      }
    }
    candidate ||= entries.find((entry) => eligible(entry));
    if (!candidate) {
      throw new BridgeUserError(
        REASONS.MODEL_CHANNEL_MISMATCH,
        `No authorized model supports '${workload}' at '${contextScale}'${explicitChannel ? ` on '${explicitChannel}'` : ""} with '${isolation}' isolation.`
      );
    }
    selectionReason ||= `${projectCatalog === undefined ? "Default" : "Project"} model catalog selected '${candidate[0]}' for '${workload}' at '${contextScale}'.`;
  }

  const [model] = candidate;
  const channels = channelsFor(candidate);
  if (!channels.length) {
    throw new BridgeUserError(
      isolation !== "shared" && !sessionIndependentChannels(candidate[1].channels, isolation).length
        ? REASONS.BLIND_ISOLATION_VIOLATION : REASONS.MODEL_CHANNEL_MISMATCH,
      `Authorized model '${model}' cannot use channel '${explicitChannel || "automatic"}' with '${isolation}' isolation.`
    );
  }
  const selectedRole = request.explicitRole ||
    (workload === "coupled_core_impl" && couplingRisk === "low" && channels[0] === "codex"
      ? "worker" : DEFAULT_ROLES[workload]);
  if (selectedRole?.toLowerCase() === "luna") {
    throw new BridgeUserError(REASONS.MODEL_ROLE_MISMATCH, "The Luna role is reserved for tool-free effort judgment.");
  }
  const base = {
    selectedModel: model,
    selectedRole,
    allowedModelAliases: resolveAliasesForModel(model, aliases),
    sessionPath: null,
    targetSessionId: null,
    isolationProfile: isolation,
    selectionReason,
  };

  if (channels[0] === "codex") {
    const isLuna = areModelsEquivalent(model, LUNA_MODEL, aliases);
    if (isLuna && (isolation !== "shared" || writeRoots.length ||
        !["runtime_status_monitor", "log_evidence_extract"].includes(workload) ||
        !["default", "explorer"].includes(selectedRole))) {
      throw new BridgeUserError(
        REASONS.MODEL_ROLE_MISMATCH,
        "Luna execution requires log extraction or status monitoring in a read-only default or explorer role."
      );
    }
    return {
      ...base,
      selectedChannel: "codex",
      selectedAgent: "codex",
      sessionMode: "subagent",
      ...(isLuna ? {
        fixedEffort: "low",
        forbidAgentTypeLunaForExecution: true,
        maxConcurrentCalls: 1,
        preserveExistingConfiguration: false,
        preserveProjectRetryAndCompactionSettings: false,
      } : {}),
    };
  }

  if (channels[0] === "web_pro") {
    return {
      ...base,
      selectedChannel: "web_pro",
      selectedAgent: "codex",
      fixedEffort: "pro_max",
      sessionMode: "web_project",
      targetSessionId: policy?.pinnedSessions?.webPro?.projectUrl || null,
    };
  }

  if (channels[0] === "pi_task_explicit") {
    const registered = getExplicitPiRoute(policy, model);
    const openWeight = OPEN_WEIGHT_MODELS.find((item) => areModelsEquivalent(item, model, aliases));
    return {
      ...base,
      selectedChannel: "pi_task_explicit",
      selectedAgent: "antigravity",
      provider: registered?.provider || "magpie",
      executor: "pi",
      selectedModel: registered?.model || openWeight,
      allowedModelAliases: registered ? [registered.model, `${registered.provider}/${registered.model}`] : base.allowedModelAliases,
      ...(typeof registered?.fixedEffort === "string" && registered.fixedEffort
        ? { fixedEffort: registered.fixedEffort } : {}),
      sessionMode: "task_explicit",
      cwd: request.cwd || null,
      preserveExistingConfiguration: false,
      preserveProjectRetryAndCompactionSettings: false,
    };
  }

  const picked = getPinnedGeminiEntry({
    policy,
    model,
    channels,
    explicitChannel,
    isColabTarget,
    activeTasks,
    busySet: new Set(busySessionIds),
  });
  return {
    ...base,
    ...picked,
    selectedChannel: picked.channel,
    selectedAgent: picked.assignedTo,
    selectionReason: picked.piBusyReason || picked.selectionReason || selectionReason,
  };
}

/**
 * Assemble complete pre-dispatch plan (to be paired with `effort-judge.mjs`).
 */
export function buildDispatchPlan(request = {}, context = {}, judgedEffortResult = null) {
  const selection = selectDispatchCandidate(request, context);
  const policy = context.policy || null;
  const selectedEffort = judgedEffortResult?.effort || selection.fixedEffort || null;
  const reuseDecision = evaluateSubagentReuse({
    candidateSubagents: request.candidateSubagents || [],
    selectedAgent: selection.selectedAgent,
    selectedRole: selection.selectedRole,
    selectedModel: selection.selectedModel,
    selectedEffort,
    isolationProfile: selection.isolationProfile,
    policy,
  });

  const handoffBootstrap = {
    forkTurns: selection.selectedChannel === "codex" ? "none" : null,
    requiredControls: ["controls.md", "AGENTS.md"],
    collaborationPolicyVersion: policy?.collaborationPolicyVersion || null,
    protocolEpoch: policy?.protocolEpoch || null,
    readRoots: request.readRoots || ["."],
    writeRoots: request.writeRoots || [],
    mustInclude: [
      "objective_and_scope",
      "authoritative_source_pointers",
      "active_controls_and_constraints",
      "read_write_boundaries",
      "completion_and_receipt_condition",
    ],
  };

  return {
    collaborationPolicyVersion: policy?.collaborationPolicyVersion || "unversioned",
    protocolEpoch: policy?.protocolEpoch || null,
    workload: request.workload || "coupled_core_impl",
    ...selection,
    selectedEffort,
    effortSource: judgedEffortResult?.source || (selection.fixedEffort ? "fixed" : null),
    effortReason: judgedEffortResult?.reason || null,
    effortCached: Boolean(judgedEffortResult?.cached),
    reuseDecision,
    handoffBootstrap,
  };
}

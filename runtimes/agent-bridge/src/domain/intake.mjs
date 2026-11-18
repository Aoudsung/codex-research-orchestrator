import path from "node:path";
import { getExplicitPiRoute } from "./dispatch-planner.mjs";
import {
  BridgeUserError,
  REASONS,
  SUBSCRIPTION_MODES,
  isBlindIsolated,
  normalizeModelId,
  resolveCognitiveProfile,
  resolveIsolationProfile,
} from "./model.mjs";

export const MAX_ROUTING_NOTE_WORDS = 60;
export const MAX_ROUTING_NOTE_CHARS = 180;
export const MAX_PRO_MACRO_WORDS = 850;
export const MAX_PRO_MACRO_CHARS = 6000;

/**
 * Zero-Clutter Macro-Inquiry Lint Guard for ChatGPT Pro (`pro_macro`):
 * Rejects technical clutter (fenced code blocks, unified diffs, itemized ledger dumps,
 * rigid deliverable status checklists, or oversized framing) when dispatching a `pro_macro` task.
 */
export function validateProMacroPrompt(
  prompt,
  { cognitiveProfile = null, requiredModel = null, metadata = {} } = {}
) {
  const resolved =
    cognitiveProfile ||
    resolveCognitiveProfile({ requiredModel, metadata }) ||
    null;
  if (resolved?.adapter !== "pro_macro" || metadata?.allowTechnicalPrompt === true) {
    return { ok: true, enforced: false };
  }

  const text = String(prompt ?? "").trim();
  const chars = text.length;
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const violations = [];

  if (chars > MAX_PRO_MACRO_CHARS || words > MAX_PRO_MACRO_WORDS) {
    violations.push(
      `prompt exceeds macro-inquiry budget (${words} words / ${chars} chars; limit <= ${MAX_PRO_MACRO_WORDS} words and <= ${MAX_PRO_MACRO_CHARS} chars)`
    );
  }
  if (text.includes("```")) {
    violations.push("contains fenced code block ('```')");
  }
  if (/^(---\s+a\/|\+\+\+\s+b\/|@@\s+-\d+)/m.test(text)) {
    violations.push("contains unified diff hunk");
  }
  const ledgerLines =
    text.match(/^\s*[-*]?\s*(?:[DC]\d+|W\d{4})\s*[:：]/gm) || [];
  if (ledgerLines.length >= 2) {
    violations.push(
      `contains itemized internal ledger dump (${ledgerLines.length} D/C/W entries)`
    );
  }
  if (/complete,\s*partial,\s*or\s*blocked/i.test(text)) {
    violations.push(
      "contains rigid status-header output checklist ('complete, partial, or blocked')"
    );
  }

  if (metadata?.proGrounding !== undefined && metadata?.proGrounding !== null) {
    const channel = metadata.proGrounding?.channel;
    if (!["github_repo", "upload_bundle"].includes(channel)) {
      throw new BridgeUserError(
        REASONS.PRO_MACRO_PROMPT_CLUTTER,
        `Invalid proGrounding channel '${String(channel)}': expected 'github_repo' or 'upload_bundle'.`,
        { proGrounding: metadata.proGrounding }
      );
    }
    if (metadata.proGrounding?.requireSha256 === true || metadata.proGrounding?.shaCeremony === true) {
      throw new BridgeUserError(
        REASONS.PRO_SHA_CEREMONY_SKIPPED,
        "Web Pro macro consultation skips per-file SHA-256 verification ceremonies; keep upload bundles minimal and direct.",
        { proGrounding: metadata.proGrounding }
      );
    }
  }

  if (violations.length > 0) {
    throw new BridgeUserError(
      REASONS.PRO_MACRO_PROMPT_CLUTTER,
      `pro_macro prompt guard rejected inline technical clutter that restricts deep macro-reasoning: ${violations.join("; ")}. Keep inline chat prompts to <= 3 conceptual prose paragraphs (referencing exact repo/bundle file paths if needed) and attach code/diffs via a synced 'github_repo' or secret-scrubbed 'upload_bundle' (.zip from pack_pro_bundle.py).`,
      { violations, words, chars }
    );
  }

  return { ok: true, enforced: true, words, chars };
}

/**
 * Anti-Paraphrase Guard:
 * Ensures any router/dispatcher note stays <= 60 words and <= 180 characters,
 * and never substitutes for primary record pointers (`sourceRecordIds`, `originMessageId`, or `replyTo`).
 *
 * @param {object} [metadata]
 * @param {{ replyTo?: string | null, taskId?: string | null }} [context]
 */
export function validateRoutingNote(metadata = {}, context = {}) {
  if (!metadata || typeof metadata !== "object") {
    return { ok: true };
  }
  const note = metadata.routingNote;
  if (note === undefined || note === null || note === "") {
    return { ok: true };
  }
  const text = String(note).trim();
  const charCount = text.length;
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;

  if (charCount > MAX_ROUTING_NOTE_CHARS || wordCount > MAX_ROUTING_NOTE_WORDS) {
    throw new BridgeUserError(
      REASONS.PARAPHRASE_GUARD_VIOLATION,
      `Anti-paraphrase guard rejected routingNote (${wordCount} words, ${charCount} chars): routing notes must be <= ${MAX_ROUTING_NOTE_WORDS} words and <= ${MAX_ROUTING_NOTE_CHARS} chars so scientific hypotheses are never lossily paraphrased.`,
      { wordCount, charCount }
    );
  }

  const hasSourceRecords =
    Array.isArray(metadata.sourceRecordIds) &&
    metadata.sourceRecordIds.length > 0;
  const hasOriginPointer = Boolean(
    metadata.originMessageId || context.replyTo || metadata.patchId || metadata.validationId
  );

  if (!hasSourceRecords && !hasOriginPointer) {
    throw new BridgeUserError(
      REASONS.PARAPHRASE_GUARD_VIOLATION,
      "Anti-paraphrase guard rejected routingNote without primary pointers: provide 'sourceRecordIds' or 'originMessageId' (or 'replyTo') alongside routingNote.",
      { routingNote: text }
    );
  }

  return { ok: true, wordCount, charCount };
}

/**
 * Validate whether a task is permitted to subscribe to a thread.
 * Hard-blocks `blind_analysis` and `blind_review` tasks from subscribing to cross-thread fan-out.
 */
export function validateThreadSubscription({
  threadId,
  task,
  mandate = null,
  mode = "direct",
}) {
  if (!threadId || typeof threadId !== "string") {
    throw new Error("threadId is required for thread subscription.");
  }
  if (!task || !task.id) {
    throw new BridgeUserError(
      REASONS.TASK_NOT_FOUND,
      `Cannot subscribe unknown task to thread '${threadId}'.`
    );
  }
  if (!SUBSCRIPTION_MODES.includes(mode)) {
    throw new BridgeUserError(
      REASONS.INVALID_SUBSCRIPTION_MODE,
      `Invalid subscription mode '${mode}': expected 'direct' or 'context'.`,
      { mode }
    );
  }

  if (isBlindIsolated(mandate || task)) {
    const profile =
      mandate?.isolation_profile ||
      task?.metadata?.isolationProfile ||
      "blind_review";
    throw new BridgeUserError(
      REASONS.BLIND_ISOLATION_VIOLATION,
      `Blind isolation guard blocked thread subscription for task '${task.id}' (profile='${profile}'): blind analysis/review tasks cannot subscribe to live thread fan-out.`,
      { taskId: task.id, threadId, isolationProfile: profile }
    );
  }

  return {
    thread_id: threadId,
    task_id: task.id,
    mode,
  };
}

/**
 * Determine default thread ID for a task at creation time.
 */
export function defaultTaskThreadId(task) {
  return (
    task?.metadata?.threadId ||
    task?.metadata?.thread_id ||
    `example-${task.id}`
  );
}

const CLAUSE_PROHIBITION_RE =
  /(?:禁止|严禁|不许|不可|不要|不得|切勿|绝不|禁用|避免|杜绝|无需|不用|免于|without\s+using|without|do\s+not\s+use|don't\s+use|never\s+use|forbid(?:den|s)?|prohibit(?:ed|s)?|ban(?:ned)?|must\s+not|should\s+not|cannot\s+use|avoid(?:ed|ing)?|free\s+of|\bno\s+(?:any\s+|a\s+)?(?:synthetic|toy|mock|dummy|fake|fallback|heuristic|wrapper|staged|calibration|certification|sha256))/i;

/**
 * Strip prohibition/negated clauses before positive pattern matching so quoting
 * controls (e.g. "禁止使用合成环境") does not false-positive as a synthetic task.
 *
 * @param {string} text
 */
export function stripNegatedProhibitionLines(text = "") {
  const clauses = String(text ?? "").split(/[\r\n。；;！!]+/);
  return clauses
    .map((c) => c.trim())
    .filter((c) => c && !CLAUSE_PROHIBITION_RE.test(c))
    .join("\n");
}

function normalizeRootPath(cwd, root) {
  const raw = String(root ?? "").trim();
  if (!raw) return "";
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return cwd ? path.resolve(cwd, raw) : path.normalize(raw);
}

function rootsOverlap(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a === "." || b === ".") return true;
  const aPrefix = a.endsWith(path.sep) ? a : `${a}${path.sep}`;
  const bPrefix = b.endsWith(path.sep) ? b : `${b}${path.sep}`;
  return a.startsWith(bPrefix) || b.startsWith(aPrefix);
}

/**
 * Validate model-to-session-channel and model-to-role topology alignment:
 * - No `dyschop/*` provider; opt-out `claude-code` blocked when forbidden.
 * - Three lanes: GPT -> Codex, Gemini (Carbon/Argon) -> Antigravity, Kimi/DeepSeek -> PI.
 * - Carbon excluded from blind_review / formal_falsification; Luna excluded from coding/heavy review.
 */
export function validateModelRoleAndChannel({
  assignedTo = null,
  requiredModel = null,
  role = null,
  taskKind = null,
  provider = null,
  metadata = {},
  contract = null,
  permissions = {},
  policyFlags = {},
  collaboratorPolicy = null,
} = {}) {
  const normModel = normalizeModelId(requiredModel);
  const rawProvider = String(
    provider || metadata?.provider || metadata?.piProvider || metadata?.backend || ""
  ).trim().toLowerCase();
  const effectiveChannel =
    rawProvider === "pi" ||
    rawProvider === "magpie" ||
    metadata?.channel === "pi" ||
    metadata?.runner === "pi" ||
    metadata?.executor === "pi" ||
    (rawProvider === "google-vertex" && Boolean(metadata?.sessionPath))
      ? "pi"
      : assignedTo;
  const effectiveRole = String(
    role ||
      metadata?.role ||
      metadata?.workerRole ||
      contract?.cognitiveProfile?.role ||
      taskKind ||
      ""
  )
    .trim()
    .toLowerCase();
  const isolation = resolveIsolationProfile({ metadata, contract });
  const writeRoots = Array.isArray(permissions?.writeRoots)
    ? permissions.writeRoots
    : Array.isArray(metadata?.writeRoots)
      ? metadata.writeRoots
      : [];

  if (
    policyFlags?.forbidClaudeCode === true &&
    (assignedTo === "claude-code" || /claude/.test(normModel) || rawProvider === "claude-code")
  ) {
    throw new BridgeUserError(
      REASONS.UNSUPPORTED_MODEL_PROVIDER,
      "Claude / claude-code participant is disabled by active research policy.",
      { assignedTo, requiredModel, provider: rawProvider }
    );
  }

  if (/dyschop/i.test(`${rawProvider} ${normModel} ${metadata?.piModel || ""}`)) {
    throw new BridgeUserError(
      REASONS.MODEL_CHANNEL_MISMATCH,
      "Legacy 'dyschop/*' backend is prohibited: route Kimi / DeepSeek via explicit PI sessions using magpie 'auto/*' with retries=0.",
      { rawProvider, requiredModel }
    );
  }

  if (policyFlags?.enforceModelRoleTopology === false) {
    return { ok: true, enforced: false };
  }

  const isGeminiFamily = /\b(?:gemini|carbon|argon)\b/i.test(normModel);
  const isGptFamily = /\b(?:gpt-|codex|astra|luna|sol\b)/i.test(normModel);
  const isPiOpenFamily = /\b(?:kimi|deepseek|moonshot)\b/i.test(normModel);

  if (effectiveChannel === "pi" && isGptFamily) {
    throw new BridgeUserError(
      REASONS.MODEL_CHANNEL_MISMATCH,
      `GPT model '${requiredModel}' cannot run via PI session: GPT uses Codex chats/subagents.`,
      { assignedTo, effectiveChannel, requiredModel }
    );
  }
  if (effectiveChannel === "pi" && isGeminiFamily) {
    const explicitPiRoute = getExplicitPiRoute(collaboratorPolicy, requiredModel);
    if (explicitPiRoute && (rawProvider !== explicitPiRoute.provider || metadata?.sessionMode !== "task_explicit")) {
      throw new BridgeUserError(
        REASONS.MODEL_CHANNEL_MISMATCH,
        `Registered PI model '${requiredModel}' requires task_explicit execution via '${explicitPiRoute.provider}'.`
      );
    }
    const hasPinnedSessionBinding = Boolean(
      metadata?.requiredConversationId ||
        metadata?.sessionId ||
        metadata?.sessionPath ||
        metadata?.pinnedSession === true ||
        policyFlags?.allowAdhocPiGemini === true ||
        explicitPiRoute
    );
    if (policyFlags?.requirePinnedPiGemini !== false && !hasPinnedSessionBinding) {
      throw new BridgeUserError(
        REASONS.MODEL_CHANNEL_MISMATCH,
        `Gemini '${requiredModel}' in PI requires a user-pinned project PI session (bind sessionId/sessionPath) or pinned Antigravity fallback; unpinned ad-hoc PI Gemini sessions are disallowed.`,
        { assignedTo, effectiveChannel, requiredModel }
      );
    }
  }
  if (effectiveChannel === "antigravity" && (isGptFamily || isPiOpenFamily)) {
    throw new BridgeUserError(
      REASONS.MODEL_CHANNEL_MISMATCH,
      `Model '${requiredModel}' cannot run via Antigravity: GPT uses Codex and Kimi/DeepSeek use PI sessions; Antigravity is for Gemini (pinned fallback or dedicated Antigravity assignment).`,
      { assignedTo, requiredModel }
    );
  }
  if (assignedTo === "codex" && isGeminiFamily) {
    throw new BridgeUserError(
      REASONS.MODEL_CHANNEL_MISMATCH,
      `Gemini model '${requiredModel}' should run via its pinned PI session (or pinned Antigravity fallback), not a Codex worker session.`,
      { assignedTo, requiredModel }
    );
  }
  if (assignedTo === "codex" && isPiOpenFamily) {
    throw new BridgeUserError(
      REASONS.MODEL_CHANNEL_MISMATCH,
      `Open-weight model '${requiredModel}' must run in an explicit project PI session ('magpie' auto/*), not a Codex worker session.`,
      { assignedTo, requiredModel }
    );
  }

  if (/\bcarbon\b|gemini.*pro.*high/i.test(normModel)) {
    if (
      isolation === "blind_review" ||
      /blind[_-]?review|formal[_-]?falsif/i.test(effectiveRole)
    ) {
      throw new BridgeUserError(
        REASONS.MODEL_ROLE_MISMATCH,
        "Gemini Carbon is scoped to mechanism/architecture co-design and is barred from independent blind_review / formal_falsification; assign GPT Astra instead.",
        { requiredModel, effectiveRole, isolation }
      );
    }
  }

  if (/\bluna\b/i.test(normModel)) {
    const writesCode =
      writeRoots.length > 0 ||
      /implement|coder|writer|architecture|blind[_-]?review|formal[_-]?falsif/i.test(
        effectiveRole
      );
    if (writesCode) {
      throw new BridgeUserError(
        REASONS.MODEL_ROLE_MISMATCH,
        "GPT-6 Luna (low) is restricted to read-only L0 observation (remote server runs & 15-min Web Pro status checks), never coding or deep review.",
        { requiredModel, effectiveRole, writeRoots }
      );
    }
  }

  return { ok: true, enforced: true };
}

/**
 * Enforce Lead Coordinator non-coding boundary:
 * coordinator/lead roles own scheduling, contracts, and integration only, never business edits.
 */
export function validateCoordinatorWriteBoundary({
  role = null,
  metadata = {},
  permissions = {},
  policyFlags = {},
} = {}) {
  if (policyFlags?.forbidCoordinatorCoding === false || metadata?.allowCoordinatorWrite === true) {
    return { ok: true, enforced: false };
  }
  const effectiveRole = String(role || metadata?.role || metadata?.workerRole || "")
    .trim()
    .toLowerCase();
  const isCoordinatorRole =
    ["coordinator", "lead", "lead_researcher", "orchestrator"].includes(effectiveRole) ||
    metadata?.isCoordinator === true;
  const writeRoots = Array.isArray(permissions?.writeRoots)
    ? permissions.writeRoots
    : Array.isArray(metadata?.writeRoots)
      ? metadata.writeRoots
      : [];
  const hasWriteScope = writeRoots.length > 0 || metadata?.editsBusinessCode === true;

  if (hasWriteScope && (isCoordinatorRole || metadata?.coordinationOnly === true)) {
    throw new BridgeUserError(
      REASONS.COORDINATOR_CODING_FORBIDDEN,
      "Lead coordinator / coordinationOnly tasks must not hold direct business writeRoots; dispatch business implementation to a bounded worker/implementer.",
      { effectiveRole, writeRoots, coordinationOnly: Boolean(metadata?.coordinationOnly) }
    );
  }
  return { ok: true, enforced: true };
}

/**
 * Enforce single-writer exclusivity on overlapping `writeRoots` across active tasks.
 */
export function validateWriteRootExclusivity({
  taskId = null,
  cwd = "",
  assignedTo = null,
  requiredConversationId = null,
  boundConversationId = null,
  permissions = {},
  metadata = {},
  existingTasks = [],
  strict = false,
} = {}) {
  const incomingRoots = Array.isArray(permissions?.writeRoots)
    ? permissions.writeRoots
    : Array.isArray(metadata?.writeRoots)
      ? metadata.writeRoots
      : [];
  if (incomingRoots.length === 0) {
    return { ok: true, checked: false };
  }

  const normalizedIncoming = incomingRoots.map((r) => normalizeRootPath(cwd, r)).filter(Boolean);
  const incomingSession = boundConversationId || requiredConversationId || null;

  for (const active of existingTasks || []) {
    if (!active || active.id === taskId) continue;
    if (["completed", "failed", "cancelled"].includes(active.status)) continue;

    const existingRootsRaw = Array.isArray(active.permissions?.writeRoots)
      ? active.permissions.writeRoots
      : [];
    if (existingRootsRaw.length === 0) continue;

    const existingSession = active.bound_conversation_id || active.required_conversation_id || null;
    const sameWorkerSession =
      !strict &&
      assignedTo &&
      active.assigned_to === assignedTo &&
      incomingSession &&
      existingSession &&
      incomingSession === existingSession;
    if (sameWorkerSession) continue;

    const normalizedExisting = existingRootsRaw
      .map((r) => normalizeRootPath(active.cwd || cwd, r))
      .filter(Boolean);

    for (const a of normalizedIncoming) {
      for (const b of normalizedExisting) {
        if (rootsOverlap(a, b)) {
          throw new BridgeUserError(
            REASONS.WRITE_ROOT_CONFLICT,
            `Write-root conflict with active task '${active.id}' (${active.assigned_to || "unassigned"}): '${a}' overlaps '${b}'. Maintain one active writer per target path (do not bypass via parallel git worktree).`,
            { conflictingTaskId: active.id, incomingRoot: a, existingRoot: b }
          );
        }
      }
    }
  }
  return { ok: true, checked: true };
}

const SYNTHETIC_FIXTURE_RE =
  /(?:\bsynthetic\s+(?:env|environment|benchmark|dataset|data|sample|trajectory|rollout|replay|distribution|noise|matrix|graph|corrupt)\b|\btoy\s+(?:benchmark|dataset|env|environment|problem|simulation|model)\b|\bmock\s+(?:model|checkpoint|weight|sampler|dataset|benchmark|eval|metric|env|environment)\b|\bdummy\s+(?:checkpoint|weight|dataset|benchmark|env|model|data)\b|\bfake\s+(?:data|checkpoint|weight|metric|benchmark)\b|合成(?:环境|数据|基准|任务|样本|轨迹|分布|数据集)|造假数据|玩具(?:模型|数据|环境|基准))/i;

const FALLBACK_DESIGN_RE =
  /(?:(?:添加|加一个|加一层|引入|构建|实现|保留|使用|启用|设计|add|implement|use|keep|build|introduce|wrap\s+with)\s+(?:a\s+|an\s+|the\s+)?(?:fallback|heuristic\s+(?:gate|switch|rule|fallback|patch)|wrapper\s+layer|calibration\s+(?:layer|wrapper)|certification\s+wrapper|staged\s+release)|兜底(?:逻辑|分支|机制|策略|包装)|逐阶段放行|认证兜底|启发式门控|fallback\s+wrapper|calibration\s+(?:layer|wrapper)|certification\s+wrapper|staged\s+release)/i;

/**
 * Enforce empirical research discipline at task intake:
 * - Forbid synthetic/toy benchmarks or mock checkpoints;
 * - Forbid fallback wrappers / heuristic gates / staged release / calibration patches;
 * - Require claim binding (C1/C2...) for declared experiment/ablation/verification runs,
 *   and forbid baseline edits inside ablation tasks.
 */
export function validateResearchTaskDiscipline({
  prompt = "",
  contract = null,
  metadata = {},
  role = null,
  taskKind = null,
  policyFlags = {},
} = {}) {
  const combinedActive = stripNegatedProhibitionLines(
    [prompt, contract?.objective].filter(Boolean).join("\n")
  );

  if (policyFlags?.forbidSyntheticFallbacks !== false) {
    if (metadata?.allowSyntheticFixture !== true && SYNTHETIC_FIXTURE_RE.test(combinedActive)) {
      throw new BridgeUserError(
        REASONS.SYNTHETIC_FIXTURE_FORBIDDEN,
        "Research task rejected: synthetic/toy environments or mock checkpoints/samplers are forbidden. Run against real benchmarks, real checkpoints, and real environment rollouts.",
        { matchedPattern: "synthetic_fixture" }
      );
    }
    if (metadata?.allowFallbackDesign !== true && FALLBACK_DESIGN_RE.test(combinedActive)) {
      throw new BridgeUserError(
        REASONS.FALLBACK_DESIGN_FORBIDDEN,
        "Research task rejected: fallback wrappers, heuristic gates, staged releases, or calibration/certification layers are forbidden. Repair the endogenous first-principles formulation directly.",
        { matchedPattern: "fallback_design" }
      );
    }
  }

  const effectiveKind = String(taskKind || metadata?.taskKind || role || metadata?.role || "")
    .trim()
    .toLowerCase();
  const isExperimentTask =
    ["experiment", "ablation", "verification", "benchmark"].includes(effectiveKind) ||
    Boolean(metadata?.experimentSpec);

  if (policyFlags?.requireClaimBinding !== false && isExperimentTask) {
    const expSpec = metadata?.experimentSpec || {};
    const claimIds = [
      ...(Array.isArray(metadata?.claimIds) ? metadata.claimIds : []),
      ...(Array.isArray(expSpec.claimIds) ? expSpec.claimIds : []),
      ...(Array.isArray(contract?.claimIds) ? contract.claimIds : []),
    ].filter(Boolean);
    const inlineClaims = String(`${prompt} ${contract?.objective || ""}`).match(/\bC\d+\b/g) || [];
    if (claimIds.length === 0 && inlineClaims.length === 0) {
      throw new BridgeUserError(
        REASONS.CLAIM_BINDING_REQUIRED,
        "Experiment/ablation/verification task must bind explicitly to paper claim(s) via `claimIds` (e.g. `['C1']`) or `C1`/`C2` claim tags.",
        { effectiveKind }
      );
    }
    const isAblation =
      effectiveKind === "ablation" || expSpec.isAblation === true;
    if (isAblation && expSpec.modifiesBaseline === true) {
      throw new BridgeUserError(
        REASONS.CLAIM_BINDING_REQUIRED,
        "Ablation tasks must be self-only component comparisons and must not alter external baselines.",
        { effectiveKind, expSpec }
      );
    }
  }

  return { ok: true };
}

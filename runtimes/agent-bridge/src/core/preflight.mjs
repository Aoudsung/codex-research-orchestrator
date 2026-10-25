import fs from "node:fs";
import path from "node:path";

/**
 * Canonicalize model IDs so aliases like "Synthetic Model (High)" and "synthetic-model-high"
 * can be compared deterministically while preserving exact model strings.
 * @param {string | null | undefined} model
 */
export function normalizeModelId(model) {
  if (!model || typeof model !== "string") return "";
  return model
    .trim()
    .toLowerCase()
    .replace(/[()[\]]/g, " ")
    .replace(/[^a-z0-9.+-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Verify whether `actualModel` satisfies `requiredModel`.
 * Never silently falls back when `requiredModel` is specified.
 *
 * @param {string | null | undefined} requiredModel
 * @param {string | null | undefined} actualModel
 * @param {string} [source] - e.g. 'runtime_init_metadata', 'caller_declared', 'cli_flag'
 */
export function verifyModelMatch(
  requiredModel,
  actualModel,
  source = "runtime_init_metadata"
) {
  if (!requiredModel) {
    return {
      ok: true,
      requiredModel: null,
      actualModel: actualModel || null,
      verifiedBy: source,
      normalizedRequired: null,
      normalizedActual: normalizeModelId(actualModel),
    };
  }

  if (!actualModel) {
    return {
      ok: false,
      code: "MODEL_UNVERIFIED",
      requiredModel,
      actualModel: null,
      verifiedBy: source,
      error: `Task strictly requires model '${requiredModel}', but actual runtime model metadata was not present (source: ${source}). Silent fallback to default CLI model is forbidden.`,
    };
  }

  const normReq = normalizeModelId(requiredModel);
  const normAct = normalizeModelId(actualModel);

  if (normReq !== normAct) {
    return {
      ok: false,
      code: "MODEL_MISMATCH",
      requiredModel,
      actualModel,
      verifiedBy: source,
      normalizedRequired: normReq,
      normalizedActual: normAct,
      error: `Model mismatch: task strictly requires '${requiredModel}' (normalized: '${normReq}'), but runtime metadata reported '${actualModel}' (normalized: '${normAct}'). Silent fallback is forbidden.`,
    };
  }

  return {
    ok: true,
    requiredModel,
    actualModel,
    verifiedBy: source,
    normalizedRequired: normReq,
    normalizedActual: normAct,
  };
}

/**
 * Parse NDJSON / JSONL output from CLI runs (`agy`, `codex`, `claude`) to extract:
 * - Runtime `init` metadata (`actualModel`, `conversationId` / `sessionId`)
 * - Tool call attempts and deterministic tool errors (e.g., `unsupported_tool: write_file`)
 * - Assistant response text
 *
 * @param {string} stdout
 * @param {string} [stderr]
 */
export function parseCliRuntimeMetadata(stdout = "", stderr = "") {
  let actualModel = null;
  let modelVerifiedBy = null;
  let conversationId = null;
  let initEvent = null;
  const toolErrors = [];
  const assistantChunks = [];
  const events = [];

  for (const rawLine of (stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const ev = JSON.parse(line);
        events.push(ev);

        // Extract init / metadata event
        if (
          ev.type === "init" ||
          ev.event === "init" ||
          ev.type === "session.init" ||
          ev.type === "thread.started" ||
          ev.subtype === "init"
        ) {
          initEvent = ev;
          if (ev.model || ev.model_id || ev.modelId) {
            actualModel = ev.model || ev.model_id || ev.modelId;
            modelVerifiedBy = "runtime_init_metadata";
          }
          if (ev.conversation_id || ev.conversationId || ev.session_id || ev.thread_id) {
            conversationId =
              ev.conversation_id ||
              ev.conversationId ||
              ev.session_id ||
              ev.thread_id;
          }
        }

        // Also check top-level metadata fields on other structured events
        if (!actualModel && (ev.model || ev.model_id || ev.modelId)) {
          actualModel = ev.model || ev.model_id || ev.modelId;
          modelVerifiedBy = "runtime_event_metadata";
        }
        if (
          !conversationId &&
          (ev.conversation_id || ev.conversationId || ev.session_id || ev.thread_id)
        ) {
          conversationId =
            ev.conversation_id ||
            ev.conversationId ||
            ev.session_id ||
            ev.thread_id;
        }

        // Check for tool errors inside structured events
        const serializedEv = JSON.stringify(ev);
        const unsupportedMatch = serializedEv.match(
          /unsupported_tool[:\s"']+([a-zA-Z0-9_-]+)/i
        );
        if (unsupportedMatch) {
          toolErrors.push({
            code: "UNSUPPORTED_TOOL_DETERMINISTIC",
            tool: unsupportedMatch[1],
            raw: ev,
          });
        }

        // Collect assistant text
        if (typeof ev.result === "string") {
          assistantChunks.push(ev.result);
        } else if (typeof ev.response === "string") {
          assistantChunks.push(ev.response);
        } else if (
          (ev.type === "message" || ev.type === "agent_message" || ev.role === "assistant") &&
          typeof ev.content === "string"
        ) {
          assistantChunks.push(ev.content);
        } else if (
          ev.type === "item.completed" &&
          ev.item &&
          typeof ev.item.text === "string"
        ) {
          assistantChunks.push(ev.item.text);
        }
        continue;
      } catch {
        // Not valid JSON
      }
    }
  }

  // Also scan raw stdout + stderr for unsupported_tool
  const combined = `${stdout}\n${stderr}`;
  const rawUnsupported = [
    ...combined.matchAll(/unsupported_tool[:\s"']+([a-zA-Z0-9_-]+)/gi),
  ];
  for (const m of rawUnsupported) {
    toolErrors.push({
      code: "UNSUPPORTED_TOOL_DETERMINISTIC",
      tool: m[1],
    });
  }

  const responseText =
    assistantChunks.length > 0
      ? assistantChunks.join("\n")
      : events.length === 0
        ? stdout.trim()
        : "";

  return {
    actualModel,
    modelVerifiedBy,
    conversationId,
    initEvent,
    toolErrorCount: toolErrors.length,
    toolErrors,
    eventCount: events.length,
    responseText,
  };
}

/**
 * Known tool compatibility rules across agent runtimes.
 * Prevents the agent from discovering `unsupported_tool: write_file` mid-run and repeating 16 times.
 */
export const RUNTIME_TOOL_CAPABILITIES = {
  "agy-cli": {
    supportedTools: [
      "read_file",
      "run_command",
      "bridge_send_message",
      "bridge_read_messages",
      "bridge_reply_message",
      "bridge_claim_task",
      "bridge_complete_task",
      "bridge_submit_patch",
      "bridge_list_patches",
      "bridge_get_patch",
      "bridge_record_validation",
      "bridge_update_task_phase",
      "bridge_get_task_overview",
      "bridge_poll_updates",
      "bridge_preflight_task",
      "bridge_set_context",
      "bridge_get_context",
      "bridge_status",
    ],
    unsupportedTools: {
      write_file: {
        reason:
          "agy CLI safety/compatibility checker rejects native `write_file` with `unsupported_tool: write_file` (and interrupted calls can create 0-byte files).",
        retryable: false,
        fallbackTool: "bridge_submit_patch",
        fallbackInstruction:
          "STOP: Do NOT call or retry native `write_file`. Author your changes as a unified diff (`artifactKind: 'unified_diff'`) or baseline copy manifest (`artifactKind: 'baseline_copy'`) and submit via `bridge_submit_patch`.",
      },
      edit_file: {
        reason:
          "agy CLI checker rejects native `edit_file` in headless/restricted sessions.",
        retryable: false,
        fallbackTool: "bridge_submit_patch",
        fallbackInstruction:
          "STOP: Do NOT call or retry native `edit_file`. Deliver unified diffs via `bridge_submit_patch`.",
      },
    },
  },
  "antigravity-ide": {
    supportedTools: ["*"],
    unsupportedTools: {},
  },
  "codex-cli": {
    supportedTools: ["*"],
    unsupportedTools: {},
  },
  "claude-cli": {
    supportedTools: ["*"],
    unsupportedTools: {},
  },
};

/**
 * Perform a single upfront preflight check covering:
 * 1. Required tools vs runtime tool compatibility (catching unsupported_tool upfront)
 * 2. Read roots and write roots existence & access permissions
 * 3. Permission delta against already-granted permissions so the user/coordinator can authorize once upfront
 *
 * @param {object} options
 * @param {string} [options.runtime] - 'agy-cli' | 'antigravity-ide' | 'codex-cli' | 'claude-cli'
 * @param {string} [options.cwd]
 * @param {object} [options.permissions]
 */
export function checkExecutionReadiness(task, runtime, cwd) {
  const deliveryMode = task?.metadata?.deliveryMode || "direct";
  const preflight = runTaskPreflight({ runtime, cwd, deliveryMode, permissions: task?.permissions || {} });
  return { ok: preflight.ok, taskId: task?.id || null, deliveryMode, preflight,
    ...(preflight.ok ? {} : { errorCode: "PREFLIGHT_FAILED", error: "Execution readiness checks failed" }) };
}

export function runTaskPreflight({
  runtime = "agy-cli",
  cwd = process.cwd(),
  permissions = {},
  deliveryMode = "direct",
} = {}) {
  const cap =
    RUNTIME_TOOL_CAPABILITIES[runtime] || RUNTIME_TOOL_CAPABILITIES["agy-cli"];

  const readRoots = Array.isArray(permissions.readRoots)
    ? permissions.readRoots
    : [];
  const writeRoots = Array.isArray(permissions.writeRoots)
    ? permissions.writeRoots
    : [];
  const requestedTools = Array.isArray(permissions.requestedTools)
    ? permissions.requestedTools
    : Array.isArray(permissions.allowedTools)
      ? permissions.allowedTools
      : [];
  const alreadyGrantedTools = new Set(
    Array.isArray(permissions.alreadyGrantedTools)
      ? permissions.alreadyGrantedTools
      : []
  );
  const alreadyGrantedCommands = new Set(
    Array.isArray(permissions.alreadyGrantedCommands)
      ? permissions.alreadyGrantedCommands
      : []
  );

  // Concrete shell commands derived from readRoots and writeRoots
  const recommendedCommands = [];
  for (const r of readRoots) {
    recommendedCommands.push(`find ${r} -type f`);
  }
  for (const w of writeRoots) {
    recommendedCommands.push(`mkdir -p ${w}`);
    recommendedCommands.push(`find ${w} -type f`);
  }
  const explicitCommands = Array.isArray(permissions.allowedCommands)
    ? permissions.allowedCommands
    : [];
  const allRequiredCommands = [
    ...new Set([...explicitCommands, ...recommendedCommands]),
  ];

  const forbiddenOperations = Array.isArray(permissions.forbiddenOperations)
    ? permissions.forbiddenOperations
    : [];

  // Mandatory MCP lifecycle tools that must be pre-authorized as a bundle
  const requiredMcpTools = [
    "bridge_claim_task",
    "bridge_read_messages",
    "bridge_reply_message",
    "bridge_send_message",
    "bridge_submit_patch",
    "bridge_list_patches",
    "bridge_get_patch",
    "bridge_update_task_phase",
    "bridge_complete_task",
    "bridge_get_task_overview",
    "bridge_poll_updates",
  ];

  const incompatibleTools = [];
  const effectiveAllowedTools = new Set([...requiredMcpTools]);

  for (const tool of requestedTools) {
    if (cap.unsupportedTools && cap.unsupportedTools[tool]) {
      incompatibleTools.push({
        tool,
        ...cap.unsupportedTools[tool],
      });
    } else if (!cap.supportedTools.includes("*") && !cap.supportedTools.includes(tool)) {
      incompatibleTools.push({ tool, reason: "Tool is not supported by the selected runtime", retryable: false });
    } else {
      effectiveAllowedTools.add(tool);
    }
  }

  // Direct write mode requires compatible file tools.
  if (deliveryMode === "direct" && runtime === "agy-cli" && writeRoots.length > 0) {
    for (const blockedName of ["write_file", "edit_file"]) {
      if (!incompatibleTools.some((t) => t.tool === blockedName)) {
        incompatibleTools.push({
          tool: blockedName,
          ...cap.unsupportedTools[blockedName],
        });
      }
    }
  }

  // Compute permission delta (what is needed vs what was already granted)
  const effectiveToolList = Array.from(effectiveAllowedTools);
  const missingToolGrants = effectiveToolList.filter(
    (t) => !alreadyGrantedTools.has(t) && !alreadyGrantedTools.has("*")
  );
  const missingCommandGrants = allRequiredCommands.filter(
    (c) => !alreadyGrantedCommands.has(c) && !alreadyGrantedCommands.has("*")
  );

  // Check readRoots and writeRoots on disk
  const directoryChecks = [];
  const missingReadRoots = [];
  for (const r of readRoots) {
    const abs = path.resolve(cwd, r);
    const exists = fs.existsSync(abs);
    let readable = false;
    if (exists) {
      try {
        fs.accessSync(abs, fs.constants.R_OK);
        readable = true;
      } catch {
        readable = false;
      }
    }
    directoryChecks.push({
      root: r,
      absPath: abs,
      mode: "read",
      exists,
      readable,
    });
    if (!exists || !readable) {
      missingReadRoots.push(r);
    }
  }

  for (const w of writeRoots) {
    const abs = path.resolve(cwd, w);
    const exists = fs.existsSync(abs);
    const parentAbs = path.dirname(abs);
    const parentExists = fs.existsSync(parentAbs);
    let writable = false;
    try {
      fs.accessSync(exists ? abs : parentAbs, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
    const zeroByteFiles = exists ? findZeroByteFiles(abs) : [];
    directoryChecks.push({
      root: w,
      absPath: abs,
      mode: "write",
      exists,
      parentExists,
      writable,
      zeroByteFiles,
    });
  }

  const recommendedDeliveryMode =
    incompatibleTools.length > 0 ? "mcp_structured_patch" : "direct_or_patch";

  return {
    ok: Boolean(RUNTIME_TOOL_CAPABILITIES[runtime]) &&
      ["direct", "read_only", "mcp_structured_patch"].includes(deliveryMode) &&
      missingReadRoots.length === 0 && incompatibleTools.length === 0 &&
      (deliveryMode !== "direct" || directoryChecks.every((c) => c.mode !== "write" || c.writable)) &&
      (deliveryMode !== "read_only" || writeRoots.length === 0) &&
      (deliveryMode !== "mcp_structured_patch" || writeRoots.length > 0) &&
      (!requestedTools.some((t) => ["write_file", "edit_file", "bridge_submit_patch"].includes(t)) || writeRoots.length > 0),
    deliveryMode,
    authorityGranted: false,
    permissionNote: "Preflight reports readiness and requested scope only; it does not authorize execution or change host permissions.",
    runtime,
    cwd,
    recommendedDeliveryMode,
    doNotRetryTools: incompatibleTools.map((t) => t.tool),
    incompatibleTools,
    consolidatedPermissionChecklist: {
      mcpTools: effectiveToolList,
      requestedTools,
      readRoots,
      writeRoots,
      allowedCommands: allRequiredCommands,
      forbiddenOperations,
    },
    permissionDelta: {
      missingToolGrants,
      missingCommandGrants,
      readRootsToAuthorize: readRoots,
      writeRootsToAuthorize: writeRoots,
      autoRevokeOnTaskEnd: true,
    },
    directoryChecks,
    missingReadRoots,
    deliveryGuidance:
      incompatibleTools.length > 0
        ? "Native file write tools (`write_file`, `edit_file`) are incompatible with this CLI runtime (`unsupported_tool`). Do NOT call or retry them. Submit all changes via `bridge_submit_patch` (`artifactKind: 'unified_diff'` or `'baseline_copy'`)."
        : "Inspect ok and directoryChecks for readiness; preflight does not grant human authority.",
  };
}

/**
 * Find 0-byte files inside a directory tree (e.g. from interrupted `write_file` attempts).
 */
export function findZeroByteFiles(rootDir, maxDepth = 5) {
  const results = [];
  function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === "__pycache__" ||
        entry.name === "node_modules"
      ) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(fullPath);
          if (st.size === 0) {
            results.push(fullPath);
          }
        } catch {
          // ignore
        }
      }
    }
  }
  walk(rootDir, 0);
  return results;
}

/**
 * Classify runtime/CLI errors into distinct, non-overlapping categories [P0 & P2]:
 * - UNSUPPORTED_TOOL_DETERMINISTIC (e.g. `unsupported_tool: write_file`)
 * - LOCAL_SANDBOX_BIND_RESTRICTED (e.g. local callback port bind/listen EPERM/EACCES in sandbox)
 * - REMOTE_OR_SSH_ERROR (e.g. SSH / remote host connection or auth failure)
 * - MCP_OR_FS_PERMISSION_DENIED (e.g. unapproved command, path, or MCP tool)
 * - CLI_ARGUMENT_OR_MODEL_ERROR (e.g. invalid model flag or CLI option)
 */
export function classifyExecutionError(stderrOrError = "", stdout = "") {
  const combined = `${stderrOrError}\n${stdout}`;

  const unsupportedMatch = combined.match(
    /unsupported_tool[:\s"']+([a-zA-Z0-9_-]+)/i
  );
  if (unsupportedMatch) {
    const toolName = unsupportedMatch[1];
    return {
      category: "UNSUPPORTED_TOOL_DETERMINISTIC",
      deterministic: true,
      retryable: false,
      failedTool: toolName,
      fallbackTool: "bridge_submit_patch",
      message: `Tool '${toolName}' is rejected by the CLI safety/compatibility checker ('unsupported_tool'). Do NOT retry '${toolName}'; deliver changes via 'bridge_submit_patch'.`,
    };
  }

  if (
    /(?:bind|listen|loopback|127\.0\.0\.1|localhost|callback server).*(?:operation not permitted|EPERM|EACCES|permission denied|address already in use)/is.test(
      combined
    ) ||
    /(?:EPERM|EACCES).*(?:bind|listen|127\.0\.0\.1)/is.test(combined)
  ) {
    return {
      category: "LOCAL_SANDBOX_BIND_RESTRICTED",
      deterministic: true,
      retryable: false,
      fallbackAction: "run_outside_sandbox_or_reuse_authorized_channel",
      message:
        "CLI failed to bind a local loopback callback port due to local sandbox restrictions (not an authentication or model failure). Run the CLI invocation outside the local port-restricted sandbox or dispatch via the shared MCP bridge.",
    };
  }

  if (/(?:ssh|scp|sftp):|Permission denied \(publickey|Connection refused.*port 22/i.test(combined)) {
    return {
      category: "REMOTE_OR_SSH_ERROR",
      deterministic: false,
      retryable: false,
      message: `Remote SSH/network execution error (distinct from local CLI/MCP permissions): ${stderrOrError.slice(0, 240)}`,
    };
  }

  if (/permission check failed|permission denied|not authorized|approval required/i.test(combined)) {
    return {
      category: "MCP_OR_FS_PERMISSION_DENIED",
      deterministic: true,
      retryable: false,
      fallbackTool: "bridge_preflight_task",
      message: `Tool or filesystem permission denied. Run 'bridge_preflight_task' to inspect the task permission delta; obtain authority through the host: ${stderrOrError.slice(0, 240)}`,
    };
  }

  if (
    /unknown option|unknown flag|flags provided but not defined|flag needs an argument|unrecognized arguments|invalid model|model not found/i.test(
      combined
    )
  ) {
    return {
      category: "CLI_ARGUMENT_OR_MODEL_ERROR",
      deterministic: true,
      retryable: false,
      message: `CLI rejected arguments or model ID: ${stderrOrError.slice(0, 240)}`,
    };
  }

  return {
    category: "EXECUTION_ERROR",
    deterministic: false,
    retryable: true,
    message: stderrOrError || "Command execution failed",
  };
}

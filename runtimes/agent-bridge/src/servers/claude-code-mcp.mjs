#!/usr/bin/env node
import process from "node:process";
import { McpStdioServer } from "../core/mcp-server.mjs";
import { BridgeDatabase } from "../core/bridge-db.mjs";
import { registerBridgeTools } from "../core/bridge-tools.mjs";
import { resolveBinary, runCommand } from "../core/process-runner.mjs";
import {
  verifyModelMatch,
  classifyExecutionError,
  checkExecutionReadiness,
} from "../core/preflight.mjs";

const server = new McpStdioServer({
  name: "claude-code-mcp",
  version: "0.3.0",
  instructions:
    "MCP server for communicating with Anthropic Claude Code CLI (`claude -p`, `--resume`, `--continue`) with explicit task/session/model bindings and reported identity evidence, structured patch delivery, and bidirectional messaging.",
});

const bridgeDb = new BridgeDatabase();
const defaultCaller = process.env.MCP_CALLER_AGENT || "antigravity";

/**
 * Parse output from `claude -p --output-format json`.
 */
function parseClaudeJsonOutput(stdout) {
  const trimmed = (stdout || "").trim();
  if (!trimmed) {
    return { sessionId: null, actualModel: null, response: "", raw: null };
  }

  const extractFromObj = (obj) => ({
    sessionId: obj.session_id || obj.sessionId || null,
    actualModel: obj.model || obj.model_id || obj.modelId || null,
    response:
      typeof obj.result === "string"
        ? obj.result
        : typeof obj.content === "string"
          ? obj.content
          : JSON.stringify(obj),
    costUsd: obj.total_cost_usd ?? obj.cost_usd ?? null,
    isError: Boolean(obj.is_error),
    raw: obj,
  });

  try {
    const obj = JSON.parse(trimmed);
    return extractFromObj(obj);
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      const l = line.trim();
      if (l.startsWith("{") && l.endsWith("}")) {
        try {
          const obj = JSON.parse(l);
          return extractFromObj(obj);
        } catch {
          // continue
        }
      }
    }
  }

  return {
    sessionId: null,
    actualModel: null,
    response: trimmed,
    raw: null,
  };
}

/**
 * Build CLI arguments for `claude -p`.
 */
function buildClaudeCliArgs(
  args,
  { resumeSessionId = null, continueLatest = false } = {}
) {
  const cliArgs = ["-p", "--output-format", "json"];

  if (resumeSessionId) {
    cliArgs.push("--resume", resumeSessionId);
  } else if (continueLatest) {
    cliArgs.push("--continue");
  }

  if (args.model) {
    cliArgs.push("--model", args.model);
  }
  if (args.systemPrompt) {
    cliArgs.push("--system-prompt", args.systemPrompt);
  }
  if (args.appendSystemPrompt) {
    cliArgs.push("--append-system-prompt", args.appendSystemPrompt);
  }
  if (args.permissionMode) {
    cliArgs.push("--permission-mode", args.permissionMode);
  }
  if (args.maxTurns) {
    cliArgs.push("--max-turns", String(args.maxTurns));
  }
  if (Array.isArray(args.allowedTools) && args.allowedTools.length > 0) {
    cliArgs.push("--allowedTools", ...args.allowedTools);
  }
  if (Array.isArray(args.disallowedTools) && args.disallowedTools.length > 0) {
    cliArgs.push("--disallowedTools", ...args.disallowedTools);
  }
  if (Array.isArray(args.addDirs)) {
    for (const dir of args.addDirs) {
      cliArgs.push("--add-dir", dir);
    }
  }

  return cliArgs;
}

// =============================================================================
// Tool 1: claude_exec
// =============================================================================
server.registerTool(
  {
    name: "claude_exec",
    description:
      "Execute a prompt or coding task using Claude Code (`claude -p --output-format json`) with explicit model and task binding. If the `claude` CLI is unavailable, queues the task in the shared multi-agent bridge.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description: "Prompt or task instructions for Claude Code.",
        },
        taskId: {
          type: "string",
          description: "Optional existing task ID to bind/continue without creating a duplicate task.",
        },
        cwd: {
          type: "string",
          description: "Working directory for Claude Code.",
        },
        model: {
          type: "string",
          description: "Explicit model ID (e.g. 'synthetic-model').",
        },
        requiredModel: {
          type: "string",
          description: "Strict required model ID.",
        },
        systemPrompt: {
          type: "string",
          description: "Optional custom system prompt (`--system-prompt`).",
        },
        appendSystemPrompt: {
          type: "string",
          description: "Optional text appended to the default system prompt (`--append-system-prompt`).",
        },
        permissionMode: {
          type: "string",
          enum: ["default", "acceptEdits", "plan", "bypassPermissions"],
          description: "Permission mode (`--permission-mode`).",
        },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of allowed tools.",
        },
        disallowedTools: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of disallowed tools.",
        },
        addDirs: {
          type: "array",
          items: { type: "string" },
          description: "Additional directories to grant Claude Code access to (`--add-dir`).",
        },
        maxTurns: {
          type: "number",
          description: "Maximum number of agentic turns (`--max-turns`).",
        },
        completeTaskOnExit: {
          type: "boolean",
          description: "Whether to mark the bound task as 'completed' immediately when CLI exits.",
        },
        waitForBridgeIfCliMissing: {
          type: "boolean",
          description: "If true and `claude` CLI is not found, wait for an active Claude Code session to complete the queued bridge task.",
        },
        timeoutMs: {
          type: "number",
          description: "Execution timeout in milliseconds (default: 300000).",
        },
      },
      required: ["prompt"],
    },
  },
  async (args) => {
    const claudeBin = resolveBinary("claude", "CLAUDE_BIN");
    const original = args.taskId ? bridgeDb.getTaskById(args.taskId) : null;
    const cwd = args.cwd || original?.cwd || process.cwd();
    const effectiveModel = args.model || args.requiredModel || original?.required_model || null;
    const requiredModel = args.requiredModel || args.model || null;
    if (args.requiredModel && args.model && !verifyModelMatch(args.requiredModel, args.model, "cli_flag").ok) throw new Error("Requested model conflicts with requiredModel");

    const taskRecord = bridgeDb.createTask({
      taskId: args.taskId || null,
      fromAgent: defaultCaller,
      assignedTo: "claude-code",
      title: `claude_exec: ${args.prompt.slice(0, 60)}`,
      prompt: args.prompt,
      cwd: args.cwd || original?.cwd || cwd,
      permissions: original?.permissions || {},
      requiredModel,
      metadata: {
        mode: "cli_exec",
        model: effectiveModel,
        permissionMode: args.permissionMode || null,
      },
    });

    const readiness = checkExecutionReadiness(taskRecord, "claude-cli", cwd);
    if (!readiness.ok) return readiness;
    if (readiness.deliveryMode !== "direct" && args.permissionMode && args.permissionMode !== "plan") throw new Error("Permission mode conflicts with the task delivery mode");
    if (readiness.deliveryMode !== "direct") args = { ...args, permissionMode: "plan" };

    if (!claudeBin) {
      if (args.waitForBridgeIfCliMissing) {
        const completed = await bridgeDb.waitForTask({
          taskId: taskRecord.id,
          timeoutMs: args.timeoutMs || 60_000,
        });
        return {
          ok: completed?.status === "completed",
          mode: "bridge_queue",
          taskId: taskRecord.id,
          binding: completed?.binding,
          task: completed,
        };
      }

      return {
        ok: false,
        queuedInBridge: true,
        taskId: taskRecord.id,
        binding: taskRecord.binding,
        error:
          "Claude Code CLI binary ('claude') was not found on PATH or CLAUDE_BIN. The task has been queued in the shared bridge (taskId: " +
          taskRecord.id +
          ").",
      };
    }

    bridgeDb.claimTask({
      taskId: taskRecord.id,
      agent: "claude-code",
      conversationId: taskRecord.bound_conversation_id,
      model: effectiveModel,
    });
    const cliArgs = buildClaudeCliArgs({ ...args, model: effectiveModel }, { resumeSessionId: taskRecord.bound_conversation_id });

    const execResult = await runCommand({
      command: claudeBin,
      args: cliArgs,
      cwd,
      stdinText: args.prompt,
      timeoutMs: args.timeoutMs || 300_000,
    });

    const parsed = parseClaudeJsonOutput(execResult.stdout);
    const isSuccess = execResult.ok && !parsed.isError;
    const reportedModel = parsed.actualModel || null;

    if (isSuccess) {
      if (requiredModel && parsed.actualModel) {
        const modelCheck = verifyModelMatch(
          requiredModel,
          parsed.actualModel,
          "claude_json_output"
        );
        if (!modelCheck.ok) {
          return {
            ok: false,
            fatal: true,
            agent: "claude-code",
            errorCode: modelCheck.code,
            error: modelCheck.error,
            taskId: taskRecord.id,
            sessionId: parsed.sessionId,
          };
        }
      }

      bridgeDb.verifyAndBindTask({
        taskId: taskRecord.id,
        actualModel: reportedModel,
        conversationId: parsed.sessionId,
        modelSource: parsed.actualModel ? "claude_json_output" : "cli_flag",
        strictModel: false,
      });

      const shouldComplete =
        args.completeTaskOnExit !== undefined
          ? Boolean(args.completeTaskOnExit)
          : false;

      const finalTask = shouldComplete
        ? bridgeDb.completeTask({
            taskId: taskRecord.id,
            status: "completed",
            result: parsed.response,
            sessionId: parsed.sessionId,
            model: reportedModel,
          })
        : bridgeDb.updateTaskPhase({
            taskId: taskRecord.id,
            phase: bridgeDb.getTaskById(taskRecord.id).delivery_version > 0 ? "awaiting_validation" : "cli_turn_ended",
            result: parsed.response,
          });

      bridgeDb.recordSession({
        agent: "claude-code",
        externalSessionId: parsed.sessionId,
        model: reportedModel,
        cwd,
        lastPrompt: args.prompt,
        lastResponse: parsed.response,
      });

      return {
        ok: true,
        agent: "claude-code",
        sessionId: parsed.sessionId,
        taskId: taskRecord.id,
        binding: finalTask.binding,
        taskPhase: {
          phase: finalTask.phase,
          phaseLabel: finalTask.phase_label,
        },
        response: parsed.response,
        costUsd: parsed.costUsd,
        exitCode: execResult.exitCode,
        timedOut: execResult.timedOut,
        durationMs: execResult.durationMs,
        stderr: execResult.stderr || undefined,
      };
    } else {
      const errClass = classifyExecutionError(
        execResult.stderr || execResult.error || "",
        execResult.stdout || ""
      );
      const updated = bridgeDb.updateTaskPhase({
        taskId: taskRecord.id,
        phase: "awaiting_revision",
        error: errClass.message,
      });

      return {
        ok: false,
        agent: "claude-code",
        sessionId: parsed.sessionId,
        taskId: taskRecord.id,
        errorCode: errClass.category,
        retryable: errClass.retryable,
        errorClassification: errClass,
        binding: updated.binding,
        taskPhase: {
          phase: updated.phase,
          phaseLabel: updated.phase_label,
        },
        response: parsed.response,
        costUsd: parsed.costUsd,
        exitCode: execResult.exitCode,
        timedOut: execResult.timedOut,
        durationMs: execResult.durationMs,
        stderr: execResult.stderr || undefined,
      };
    }
  }
);

// =============================================================================
// Tool 2: claude_resume
// =============================================================================
server.registerTool(
  {
    name: "claude_resume",
    description:
      "Continue a previous Claude Code conversation session (`claude -p --resume <sessionId>` or `--continue`) for multi-turn collaboration.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description: "Follow-up prompt to send to Claude Code.",
        },
        sessionId: {
          type: "string",
          description: "Specific session ID to resume. If omitted, uses the latest recorded session ID or `--continue`.",
        },
        taskId: {
          type: "string",
          description: "Optional bound task ID.",
        },
        cwd: {
          type: "string",
          description: "Working directory.",
        },
        model: {
          type: "string",
          description: "Optional model override.",
        },
        permissionMode: {
          type: "string",
          enum: ["default", "acceptEdits", "plan", "bypassPermissions"],
          description: "Permission mode.",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds (default: 300000).",
        },
      },
      required: ["prompt"],
    },
  },
  async (args) => {
    const claudeBin = resolveBinary("claude", "CLAUDE_BIN");
    if (!claudeBin) {
      throw new Error(
        "Claude Code CLI binary ('claude') not found on PATH or CLAUDE_BIN."
      );
    }

    const boundTask = args.taskId ? bridgeDb.getTaskById(args.taskId) : null;
    if (args.taskId && !boundTask) throw new Error("Task not found");
    if (boundTask) {
      bridgeDb.createTask({ taskId: args.taskId, assignedTo: "claude-code", requiredModel: args.model, cwd: args.cwd });
      if (!boundTask.bound_conversation_id || (args.sessionId && args.sessionId !== boundTask.bound_conversation_id)) throw new Error("Resume session binding mismatch or missing identity");
    }
    args = { ...args, model: args.model || boundTask?.required_model || null };
    const cwd = args.cwd || boundTask?.cwd || process.cwd();
    const readiness = checkExecutionReadiness(boundTask, "claude-cli", cwd);
    if (!readiness.ok) return readiness;
    if (readiness.deliveryMode !== "direct" && args.permissionMode && args.permissionMode !== "plan") throw new Error("Permission mode conflicts with the task delivery mode");
    if (readiness.deliveryMode !== "direct") args = { ...args, permissionMode: "plan" };
    const targetSessionId =
      args.sessionId ||
      (args.taskId
        ? bridgeDb.getTaskById(args.taskId)?.bound_conversation_id
        : null) ||
      bridgeDb.getLatestSession("claude-code")?.external_session_id ||
      null;

    const cliArgs = buildClaudeCliArgs(args, {
      resumeSessionId: targetSessionId,
      continueLatest: !targetSessionId,
    });

    const execResult = await runCommand({
      command: claudeBin,
      args: cliArgs,
      cwd,
      stdinText: args.prompt,
      timeoutMs: args.timeoutMs || 300_000,
    });

    const parsed = parseClaudeJsonOutput(execResult.stdout);
    const effectiveSessionId = parsed.sessionId || targetSessionId;
    const isSuccess = execResult.ok && !parsed.isError;

    if (isSuccess && boundTask) bridgeDb.verifyAndBindTask({ taskId: args.taskId, actualModel: parsed.actualModel, conversationId: parsed.sessionId, modelSource: "claude_json_output", strictModel: false });
    if (isSuccess) {
      bridgeDb.recordSession({
        agent: "claude-code",
        externalSessionId: effectiveSessionId,
        model: parsed.actualModel || null,
        cwd,
        lastPrompt: args.prompt,
        lastResponse: parsed.response,
      });
    }

    return {
      ok: isSuccess,
      agent: "claude-code",
      sessionId: effectiveSessionId,
      actualModel: parsed.actualModel || null,
      response: parsed.response,
      costUsd: parsed.costUsd,
      exitCode: execResult.exitCode,
      durationMs: execResult.durationMs,
      stderr: execResult.stderr || undefined,
    };
  }
);

// =============================================================================
// Tool 3: claude_review
// =============================================================================
server.registerTool(
  {
    name: "claude_review",
    description:
      "Ask Claude Code to perform a structured code review on uncommitted changes, a branch comparison, or specific files.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description: "Optional custom review focus or instructions.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of file paths to focus the review on.",
        },
        baseBranch: {
          type: "string",
          description: "Optional base branch to compare against (e.g. 'main').",
        },
        cwd: {
          type: "string",
          description: "Repository working directory.",
        },
        model: {
          type: "string",
          description: "Optional model override.",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds (default: 300000).",
        },
      },
    },
  },
  async (args) => {
    const claudeBin = resolveBinary("claude", "CLAUDE_BIN");
    const cwd = args.cwd || process.cwd();

    const parts = [
      "Perform a thorough code review focusing on correctness, edge cases, security, performance, and maintainability.",
    ];
    if (args.baseBranch) {
      parts.push(`Compare current changes against base branch '${args.baseBranch}'.`);
    }
    if (Array.isArray(args.files) && args.files.length > 0) {
      parts.push(`Focus on files: ${args.files.join(", ")}`);
    }
    if (args.prompt) {
      parts.push(`Additional instructions: ${args.prompt}`);
    }
    const fullPrompt = parts.join("\n\n");

    if (!claudeBin) {
      const task = bridgeDb.createTask({
        fromAgent: defaultCaller,
        assignedTo: "claude-code",
        title: "claude_review: Code Review Request",
        prompt: fullPrompt,
        cwd,
        priority: "high",
      });
      return {
        ok: false,
        queuedInBridge: true,
        taskId: task.id,
        error:
          "Claude Code CLI binary ('claude') not found. Queued review task in shared bridge.",
      };
    }

    const cliArgs = buildClaudeCliArgs({
      model: args.model,
      permissionMode: "plan",
    });

    const execResult = await runCommand({
      command: claudeBin,
      args: cliArgs,
      cwd,
      stdinText: fullPrompt,
      timeoutMs: args.timeoutMs || 300_000,
    });

    const parsed = parseClaudeJsonOutput(execResult.stdout);
    return {
      ok: execResult.ok && !parsed.isError,
      agent: "claude-code",
      sessionId: parsed.sessionId,
      reviewOutput: parsed.response,
      exitCode: execResult.exitCode,
      durationMs: execResult.durationMs,
      stderr: execResult.stderr || undefined,
    };
  }
);

// =============================================================================
// Tool 4: claude_status
// =============================================================================
server.registerTool(
  {
    name: "claude_status",
    description:
      "Check Claude Code CLI availability, binary path, version, current cursor seq, and pending Claude Code tasks/messages in the shared bridge.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  async () => {
    const claudeBin = resolveBinary("claude", "CLAUDE_BIN");
    let version = null;
    if (claudeBin) {
      const verRes = await runCommand({
        command: claudeBin,
        args: ["--version"],
        timeoutMs: 10_000,
      });
      version = verRes.stdout || verRes.stderr;
    }

    return {
      ok: true,
      agent: "claude-code",
      cliInstalled: Boolean(claudeBin),
      binaryPath: claudeBin,
      version,
      currentCursor: bridgeDb.getCurrentSeq(),
      latestSession: bridgeDb.getLatestSession("claude-code"),
      pendingTasks: bridgeDb.listTasks({
        assignedTo: "claude-code",
        status: "pending",
      }),
      unreadMessages: bridgeDb.readMessages({
        toAgent: "claude-code",
        unreadOnly: true,
        markAsRead: false,
      }),
    };
  }
);

// Register shared bidirectional bridge tools
registerBridgeTools(server, bridgeDb, {
  defaultCaller,
  defaultTarget: "claude-code",
});

server.start();

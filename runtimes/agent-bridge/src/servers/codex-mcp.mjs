#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { McpStdioServer } from "../core/mcp-server.mjs";
import { BridgeDatabase } from "../core/bridge-db.mjs";
import { registerBridgeTools } from "../core/bridge-tools.mjs";
import {
  resolveBinary,
  runCommand,
  parseJsonLines,
} from "../core/process-runner.mjs";
import {
  verifyModelMatch,
  classifyExecutionError,
  checkExecutionReadiness,
} from "../core/preflight.mjs";

const server = new McpStdioServer({
  name: "codex-mcp",
  version: "0.5.0",
  instructions:
    "MCP server for communicating with OpenAI Codex CLI (`codex exec`, `codex exec resume`, `codex exec fork`, `codex review`) with explicit task/session/model bindings and reported identity evidence, structured patch delivery, and bidirectional messaging.",
});

const bridgeDb = new BridgeDatabase();
server.executionAdmission = {
  names: new Set(["codex_exec", "codex_resume", "codex_fork", "codex_review"]),
  admit: () => bridgeDb.admitExecution(),
};
const defaultCaller = process.env.MCP_CALLER_AGENT || "antigravity";

/**
 * Extract session/thread ID, actual model, and final assistant text from `codex exec --json` output.
 */
function parseCodexOutput(stdout, lastMessageFile) {
  let lastMessage = "";
  if (lastMessageFile && fs.existsSync(lastMessageFile)) {
    try {
      lastMessage = fs.readFileSync(lastMessageFile, "utf8").trim();
    } catch {
      // ignore
    }
  }

  const { events, rawLines } = parseJsonLines(stdout);
  let sessionId = null;
  let actualModel = null;
  let modelVerifiedBy = null;
  const agentMessages = [];

  for (const ev of events) {
    if (ev.thread_id && !sessionId) {
      sessionId = ev.thread_id;
    }
    if (ev.session_id && !sessionId) {
      sessionId = ev.session_id;
    }
    if (ev.type === "thread.started" && ev.thread_id) {
      sessionId = ev.thread_id;
    }
    if (!actualModel && (ev.model || ev.model_id || ev.modelId)) {
      actualModel = ev.model || ev.model_id || ev.modelId;
      modelVerifiedBy = "runtime_init_metadata";
    }
    if (
      ev.type === "item.completed" &&
      ev.item &&
      (ev.item.type === "agent_message" || ev.item.type === "message")
    ) {
      if (typeof ev.item.text === "string") {
        agentMessages.push(ev.item.text);
      } else if (Array.isArray(ev.item.content)) {
        for (const c of ev.item.content) {
          if (c.text) agentMessages.push(c.text);
        }
      }
    }
    if (ev.type === "message" && typeof ev.content === "string") {
      agentMessages.push(ev.content);
    }
  }

  if (!lastMessage) {
    if (agentMessages.length > 0) {
      lastMessage = agentMessages[agentMessages.length - 1];
    } else if (rawLines.length > 0) {
      lastMessage = rawLines.join("\n");
    } else {
      lastMessage = stdout;
    }
  }

  return {
    sessionId,
    actualModel,
    modelVerifiedBy,
    response: lastMessage,
    eventCount: events.length,
  };
}

// =============================================================================
// Tool 1: codex_exec
// =============================================================================
server.registerTool(
  {
    name: "codex_exec",
    description:
      "Run OpenAI Codex non-interactively (`codex exec`) on a prompt with explicit model & task binding, returning its response, session ID, and binding metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description: "Task instructions or prompt to send to Codex.",
        },
        taskId: {
          type: "string",
          description: "Optional existing task ID to bind/continue without creating a duplicate task.",
        },
        cwd: {
          type: "string",
          description: "Working directory for Codex (`-C, --cd`). Defaults to current workspace.",
        },
        model: {
          type: "string",
          description: "Explicit model ID (`-m, --model`, e.g. 'synthetic-model').",
        },
        requiredModel: {
          type: "string",
          description: "Strict required model ID. Fails if runtime metadata reports a different model.",
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Sandbox policy (`-s, --sandbox`, default: 'workspace-write').",
        },
        approveForMe: {
          type: "boolean",
          description: "Pass `--approve-for-me` to route approval requests automatically within workspace-write sandbox.",
        },
        ephemeral: {
          type: "boolean",
          description: "Run without persisting session files to disk (`--ephemeral`).",
        },
        skipGitRepoCheck: {
          type: "boolean",
          description: "Allow running outside a Git repository (`--skip-git-repo-check`, default: true).",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description: "Optional file paths of images to attach (`-i`).",
        },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "Reasoning effort for this invocation." },
        configOverrides: {
          type: "array",
          items: { type: "string" },
          description: "Optional `-c key=value` overrides.",
        },
        completeTaskOnExit: {
          type: "boolean",
          description: "Whether to mark the bound task as 'completed' immediately when CLI exits (default: false; RC0 alone does not establish completion).",
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
    const codexBin = resolveBinary("codex", "CODEX_BIN");
    if (args.effort && args.configOverrides?.some(value => /^\s*model_reasoning_effort\s*=/.test(value))) throw new Error("effort conflicts with model_reasoning_effort in configOverrides");
    const original = args.taskId ? bridgeDb.getTaskById(args.taskId) : null;
    const cwd = args.cwd || original?.cwd || process.cwd();
    const effectiveModel = args.model || args.requiredModel || original?.required_model || null;
    const requiredModel = args.requiredModel || args.model || null;
    if (args.requiredModel && args.model && !verifyModelMatch(args.requiredModel, args.model, "cli_flag").ok) throw new Error("Requested model conflicts with requiredModel");

    const taskRecord = bridgeDb.createTask({
      taskId: args.taskId || null,
      fromAgent: defaultCaller,
      assignedTo: "codex",
      title: `codex_exec: ${args.prompt.slice(0, 60)}`,
      prompt: args.prompt,
      cwd: args.cwd || original?.cwd || cwd,
      permissions: original?.permissions || {},
      requiredModel,
      metadata: { mode: "cli_exec", model: effectiveModel },
    });

    const readiness = checkExecutionReadiness(taskRecord, "codex-cli", cwd);
    if (!readiness.ok) return readiness;
    if (readiness.deliveryMode !== "direct" && args.sandbox && args.sandbox !== "read-only") throw new Error("Sandbox conflicts with the task delivery mode");

    if (!codexBin) {
      return {
        ok: false,
        queuedInBridge: true,
        taskId: taskRecord.id,
        binding: taskRecord.binding,
        error:
          "Codex CLI binary ('codex') was not found on PATH or CODEX_BIN. The task has been queued in the shared bridge for an active Codex session.",
      };
    }

    bridgeDb.claimTask({
      taskId: taskRecord.id,
      agent: "codex",
      conversationId: taskRecord.bound_conversation_id,
      model: effectiveModel,
    });

    const tmpLastMsgFile = path.join(
      os.tmpdir(),
      `codex-last-msg-${crypto.randomUUID()}.txt`
    );

    const cliArgs = taskRecord.bound_conversation_id
      ? ["exec", "resume", "--json", "-o", tmpLastMsgFile]
      : ["exec", "--json", "-o", tmpLastMsgFile];

    if (args.cwd) {
      cliArgs.push("-C", args.cwd);
    }
    if (effectiveModel) {
      cliArgs.push("-m", effectiveModel);
    }
    cliArgs.push("-s", readiness.deliveryMode !== "direct" ? "read-only" : args.sandbox || "workspace-write");
    if (args.approveForMe) {
      cliArgs.push("--approve-for-me");
    }
    if (args.ephemeral) {
      cliArgs.push("--ephemeral");
    }
    if (args.skipGitRepoCheck !== false) {
      cliArgs.push("--skip-git-repo-check");
    }
    if (Array.isArray(args.images)) {
      for (const img of args.images) {
        cliArgs.push("-i", img);
      }
    }
    if (args.effort) cliArgs.push("-c", `model_reasoning_effort=${JSON.stringify(args.effort)}`);
    if (Array.isArray(args.configOverrides)) {
      for (const cfg of args.configOverrides) {
        cliArgs.push("-c", cfg);
      }
    }

    if (taskRecord.bound_conversation_id) cliArgs.push(taskRecord.bound_conversation_id);
    cliArgs.push("-");

    try {
      const execResult = await runCommand({
        command: codexBin,
        args: cliArgs,
        cwd,
        stdinText: args.prompt,
        timeoutMs: args.timeoutMs || 300_000,
      });

      const parsed = parseCodexOutput(execResult.stdout, tmpLastMsgFile);
      const reportedModel = parsed.actualModel || null;

      if (execResult.ok) {
        if (requiredModel && parsed.actualModel) {
          const modelCheck = verifyModelMatch(
            requiredModel,
            parsed.actualModel,
            parsed.modelVerifiedBy
          );
          if (!modelCheck.ok) {
            return {
              ok: false,
              fatal: true,
              agent: "codex",
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
          modelSource: parsed.modelVerifiedBy || "cli_flag",
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
          agent: "codex",
          externalSessionId: parsed.sessionId,
          model: reportedModel,
          cwd,
          lastPrompt: args.prompt,
          lastResponse: parsed.response,
        });

        return {
          ok: true,
          agent: "codex",
          sessionId: parsed.sessionId,
          taskId: taskRecord.id,
          binding: finalTask.binding,
          taskPhase: {
            phase: finalTask.phase,
            phaseLabel: finalTask.phase_label,
          },
          response: parsed.response,
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
          agent: "codex",
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
          exitCode: execResult.exitCode,
          timedOut: execResult.timedOut,
          durationMs: execResult.durationMs,
          stderr: execResult.stderr || undefined,
        };
      }
    } finally {
      try {
        if (fs.existsSync(tmpLastMsgFile)) fs.unlinkSync(tmpLastMsgFile);
      } catch {
        // ignore
      }
    }
  }
);

// =============================================================================
// Tool 2: codex_resume
// =============================================================================
server.registerTool(
  {
    name: "codex_resume",
    description:
      "Resume a previous Codex conversation session (`codex exec resume`) by session ID or `--last` for multi-turn dialogue.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description: "Follow-up prompt to send to the resumed Codex session.",
        },
        sessionId: {
          type: "string",
          description: "Session/thread UUID to resume. If omitted, resumes the most recent session (`--last`).",
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
        skipGitRepoCheck: {
          type: "boolean",
          description: "Allow running outside a Git repository (default: true).",
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
    const codexBin = resolveBinary("codex", "CODEX_BIN");
    if (!codexBin) {
      throw new Error("Codex CLI binary ('codex') not found.");
    }

    const boundTask = args.taskId ? bridgeDb.getTaskById(args.taskId) : null;
    if (args.taskId && !boundTask) throw new Error("Task not found");
    if (boundTask) {
      bridgeDb.createTask({ taskId: args.taskId, assignedTo: "codex", requiredModel: args.model, cwd: args.cwd });
      if (!boundTask.bound_conversation_id || (args.sessionId && args.sessionId !== boundTask.bound_conversation_id)) throw new Error("Resume session binding mismatch or missing identity");
    }
    args = { ...args, model: args.model || boundTask?.required_model || null };
    const cwd = args.cwd || boundTask?.cwd || process.cwd();
    const readiness = checkExecutionReadiness(boundTask, "codex-cli", cwd);
    if (!readiness.ok) return readiness;
    const tmpLastMsgFile = path.join(
      os.tmpdir(),
      `codex-resume-msg-${crypto.randomUUID()}.txt`
    );

    const cliArgs = ["exec", "resume", "--json", "-o", tmpLastMsgFile];
    if (readiness.deliveryMode !== "direct") cliArgs.push("-c", 'sandbox_mode="read-only"');
    if (args.model) {
      cliArgs.push("-m", args.model);
    }
    if (args.skipGitRepoCheck !== false) {
      cliArgs.push("--skip-git-repo-check");
    }

    const targetSessionId =
      args.sessionId ||
      (args.taskId
        ? bridgeDb.getTaskById(args.taskId)?.bound_conversation_id
        : null) ||
      bridgeDb.getLatestSession("codex")?.external_session_id ||
      null;

    if (targetSessionId) {
      cliArgs.push(targetSessionId);
    } else {
      cliArgs.push("--last");
    }
    cliArgs.push("-");

    try {
      const execResult = await runCommand({
        command: codexBin,
        args: cliArgs,
        cwd,
        stdinText: args.prompt,
        timeoutMs: args.timeoutMs || 300_000,
      });

      const parsed = parseCodexOutput(execResult.stdout, tmpLastMsgFile);
      const effectiveSessionId = parsed.sessionId || targetSessionId;

      if (execResult.ok && boundTask) bridgeDb.verifyAndBindTask({ taskId: args.taskId, actualModel: parsed.actualModel, conversationId: parsed.sessionId, modelSource: parsed.modelVerifiedBy || "runtime_missing", strictModel: false });
      if (execResult.ok) {
        bridgeDb.recordSession({
          agent: "codex",
          externalSessionId: effectiveSessionId,
          model: parsed.actualModel || null,
          cwd,
          lastPrompt: args.prompt,
          lastResponse: parsed.response,
        });
      }

      return {
        ok: execResult.ok,
        agent: "codex",
        sessionId: effectiveSessionId,
        actualModel: parsed.actualModel || null,
        response: parsed.response,
        exitCode: execResult.exitCode,
        durationMs: execResult.durationMs,
        stderr: execResult.stderr || undefined,
      };
    } finally {
      try {
        if (fs.existsSync(tmpLastMsgFile)) fs.unlinkSync(tmpLastMsgFile);
      } catch {
        // ignore
      }
    }
  }
);

// =============================================================================
// Tool 3: codex_fork
// =============================================================================
server.registerTool(
  {
    name: "codex_fork",
    description:
      "Fork an existing Codex session into a new thread (`codex exec fork <SESSION_ID>`) and send a follow-up prompt.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: {
          type: "string",
          description: "Session/thread UUID to fork.",
        },
        prompt: {
          type: "string",
          description: "Prompt to send in the newly forked session.",
        },
        cwd: {
          type: "string",
          description: "Working directory.",
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
      required: ["sessionId", "prompt"],
    },
  },
  async (args) => {
    const codexBin = resolveBinary("codex", "CODEX_BIN");
    if (!codexBin) {
      throw new Error("Codex CLI binary ('codex') not found.");
    }

    const cwd = args.cwd || process.cwd();
    const tmpLastMsgFile = path.join(
      os.tmpdir(),
      `codex-fork-msg-${crypto.randomUUID()}.txt`
    );

    const cliArgs = [
      "exec",
      "fork",
      "--json",
      "-o",
      tmpLastMsgFile,
      "--skip-git-repo-check",
    ];
    if (args.model) {
      cliArgs.push("-m", args.model);
    }
    cliArgs.push(args.sessionId, "-");

    try {
      const execResult = await runCommand({
        command: codexBin,
        args: cliArgs,
        cwd,
        stdinText: args.prompt,
        timeoutMs: args.timeoutMs || 300_000,
      });

      const parsed = parseCodexOutput(execResult.stdout, tmpLastMsgFile);
      if (execResult.ok) {
        bridgeDb.recordSession({
          agent: "codex",
          externalSessionId: parsed.sessionId,
          model: parsed.actualModel || null,
          cwd,
          lastPrompt: args.prompt,
          lastResponse: parsed.response,
        });
      }

      return {
        ok: execResult.ok,
        forkedFrom: args.sessionId,
        sessionId: parsed.sessionId,
        actualModel: parsed.actualModel || null,
        response: parsed.response,
        exitCode: execResult.exitCode,
        durationMs: execResult.durationMs,
        stderr: execResult.stderr || undefined,
      };
    } finally {
      try {
        if (fs.existsSync(tmpLastMsgFile)) fs.unlinkSync(tmpLastMsgFile);
      } catch {
        // ignore
      }
    }
  }
);

// =============================================================================
// Tool 4: codex_review
// =============================================================================
server.registerTool(
  {
    name: "codex_review",
    description:
      "Run a non-interactive code review using Codex (`codex review`) on uncommitted changes, a branch diff, or a specific commit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description: "Optional custom review instructions.",
        },
        uncommitted: {
          type: "boolean",
          description: "Review staged, unstaged, and untracked changes (`--uncommitted`).",
        },
        baseBranch: {
          type: "string",
          description: "Review changes against a base branch (`--base <BRANCH>`).",
        },
        commitSha: {
          type: "string",
          description: "Review changes introduced by a specific commit (`--commit <SHA>`).",
        },
        title: {
          type: "string",
          description: "Optional commit title for the review summary (`--title`).",
        },
        cwd: {
          type: "string",
          description: "Repository working directory.",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds (default: 300000).",
        },
      },
    },
  },
  async (args) => {
    const codexBin = resolveBinary("codex", "CODEX_BIN");
    if (!codexBin) {
      throw new Error("Codex CLI binary ('codex') not found.");
    }

    const cliArgs = ["review"];
    if (args.uncommitted) {
      cliArgs.push("--uncommitted");
    }
    if (args.baseBranch) {
      cliArgs.push("--base", args.baseBranch);
    }
    if (args.commitSha) {
      cliArgs.push("--commit", args.commitSha);
    }
    if (args.title) {
      cliArgs.push("--title", args.title);
    }
    if (args.prompt) {
      cliArgs.push("-");
    }

    const execResult = await runCommand({
      command: codexBin,
      args: cliArgs,
      cwd: args.cwd || process.cwd(),
      stdinText: args.prompt || undefined,
      timeoutMs: args.timeoutMs || 300_000,
    });

    return {
      ok: execResult.ok,
      agent: "codex",
      reviewOutput: execResult.stdout,
      exitCode: execResult.exitCode,
      durationMs: execResult.durationMs,
      stderr: execResult.stderr || undefined,
    };
  }
);

// =============================================================================
// Tool 5: codex_status
// =============================================================================
server.registerTool(
  {
    name: "codex_status",
    description:
      "Check Codex CLI availability, version, binary path, current cursor seq, and recent Codex sessions/tasks in the shared bridge.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  async () => {
    const codexBin = resolveBinary("codex", "CODEX_BIN");
    let version = null;
    if (codexBin) {
      const verRes = await runCommand({
        command: codexBin,
        args: ["--version"],
        timeoutMs: 10_000,
      });
      version = verRes.stdout || verRes.stderr;
    }

    return {
      ok: true,
      agent: "codex",
      cliInstalled: Boolean(codexBin),
      binaryPath: codexBin,
      version,
      currentCursor: bridgeDb.getCurrentSeq(),
      latestSession: bridgeDb.getLatestSession("codex"),
      pendingTasks: bridgeDb.listTasks({
        assignedTo: "codex",
        status: "pending",
      }),
      unreadMessages: bridgeDb.readMessages({
        toAgent: "codex",
        unreadOnly: true,
        markAsRead: false,
      }),
    };
  }
);

// Register shared bidirectional bridge tools
registerBridgeTools(server, bridgeDb, {
  defaultCaller,
  defaultTarget: "codex",
});

server.start();

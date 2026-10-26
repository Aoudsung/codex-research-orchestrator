#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { McpStdioServer } from "../core/mcp-server.mjs";
import { BridgeDatabase } from "../core/bridge-db.mjs";
import { registerBridgeTools } from "../core/bridge-tools.mjs";
import { resolveBinary, runCommand } from "../core/process-runner.mjs";
import {
  verifyModelMatch,
  parseCliRuntimeMetadata,
  runTaskPreflight,
  classifyExecutionError,
} from "../core/preflight.mjs";

const server = new McpStdioServer({
  name: "antigravity-mcp",
  version: "0.5.0",
  instructions:
    "MCP server allowing OpenAI Codex and Anthropic Claude Code to communicate with Google Antigravity with explicit task/session/model bindings and reported identity evidence, upfront permission preflight, structured patch delivery, and cursor-based lifecycle tracking.",
});

const bridgeDb = new BridgeDatabase();
server.executionAdmission = {
  names: new Set(["antigravity_exec"]),
  admit: () => bridgeDb.admitExecution(),
};
const defaultCaller = process.env.MCP_CALLER_AGENT || "codex";

/**
 * Check if `google-antigravity` Python SDK is available.
 */
async function checkPythonSdk(pythonBin = "python3") {
  const res = await runCommand({
    command: pythonBin,
    args: ["-c", "import google.antigravity; print('OK')"],
    timeoutMs: 8_000,
  });
  return res.ok && res.stdout.includes("OK");
}

/**
 * Run a prompt through the `google-antigravity` Python SDK with explicit model configuration.
 */
async function runViaPythonSdk({
  prompt,
  model = null,
  conversationId = null,
  systemInstructions = "",
  enableWriteCapabilities = false,
  cwd = process.cwd(),
  timeoutMs = 300_000,
}) {
  const pyScript = `
import asyncio
import inspect
import json
import sys
from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig

async def main():
    payload = json.loads(sys.stdin.read())
    prompt = payload["prompt"]
    requested_model = payload.get("model")
    sys_inst = payload.get("systemInstructions") or "You are Google Antigravity collaborating via MCP."
    enable_write = bool(payload.get("enableWriteCapabilities", False))
    kwargs = {"system_instructions": sys_inst}
    if enable_write:
        kwargs["capabilities"] = CapabilitiesConfig()

    sig = inspect.signature(LocalAgentConfig.__init__)
    if requested_model:
        if "model" in sig.parameters:
            kwargs["model"] = requested_model
        elif "model_name" in sig.parameters:
            kwargs["model_name"] = requested_model
        else:
            print(json.dumps({
                "ok": False,
                "errorCode": "MODEL_PARAMETER_UNSUPPORTED_BY_SDK",
                "error": f"LocalAgentConfig does not accept explicit model parameter for '{requested_model}'."
            }))
            return

    if payload.get("conversationId"):
        print(json.dumps({"ok": False, "errorCode": "SDK_RESUME_UNSUPPORTED", "error": "This SDK adapter cannot guarantee resume of a required conversation."}))
        return
    config = LocalAgentConfig(**kwargs)
    chunks = []
    async with Agent(config) as agent:
        actual_model = None  # Configuration attributes are not runtime identity evidence.
        conv_id = getattr(agent, "conversation_id", None)
        response = await agent.chat(prompt)
        async for token in response:
            chunks.append(str(token))
    print(json.dumps({
        "ok": True,
        "actualModel": actual_model,
        "conversationId": conv_id,
        "response": "".join(chunks)
    }))

if __name__ == "__main__":
    asyncio.run(main())
`;

  const res = await runCommand({
    command: resolveBinary("python3") || "python3",
    args: ["-c", pyScript],
    cwd,
    stdinText: JSON.stringify({
      prompt,
      model,
      conversationId,
      systemInstructions,
      enableWriteCapabilities,
    }),
    timeoutMs,
  });

  if (res.ok) {
    try {
      const parsed = JSON.parse(res.stdout);
      return {
        ok: Boolean(parsed.ok),
        backend: "sdk",
        actualModel: parsed.actualModel || null,
        conversationId: parsed.conversationId || conversationId || null,
        response: parsed.response || "",
        errorCode: parsed.errorCode || null,
        error: parsed.error || null,
        durationMs: res.durationMs,
      };
    } catch {
      return {
        ok: true,
        backend: "sdk",
        actualModel: null,
        conversationId,
        response: res.stdout,
        durationMs: res.durationMs,
      };
    }
  }

  return {
    ok: false,
    backend: "sdk",
    error: res.stderr || res.error || "Python SDK execution failed",
    durationMs: res.durationMs,
  };
}

// =============================================================================
// Tool 1: antigravity_exec [P0, P1, P2]
// =============================================================================
server.registerTool(
  {
    name: "antigravity_exec",
    description:
      "Execute a prompt or dispatch/continue a task on Google Antigravity with explicit model ID ('model'/'requiredModel'), conversation binding ('conversationId'), and task binding ('taskId'). Runs upfront permission & tool compatibility preflight, verifies runtime init model metadata (failing explicitly on mismatch without silent fallback), and distinguishes CLI turn end from overall task completion.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description: "Task instructions or prompt for Antigravity.",
        },
        model: {
          type: "string",
          description:
            "Exact model ID to use (e.g. 'synthetic-model-high'). Passed to CLI/SDK and verified against runtime metadata.",
        },
        requiredModel: {
          type: "string",
          description:
            "Strict model ID required for this task (defaults to 'model' when 'model' is specified). Execution fails if actual model differs.",
        },
        strictModel: {
          type: "boolean",
          description:
            "If true (default: true), fail immediately if actual runtime model does not match requiredModel; never silently fall back.",
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
          description: "CLI reasoning effort for this invocation; requires a supported model variant.",
        },
        conversationId: {
          type: "string",
          description:
            "Conversation/session ID to bind or resume (e.g. '00000000-0000-4000-8000-000000000002').",
        },
        taskId: {
          type: "string",
          description:
            "Existing task ID to continue along the same task record without creating a duplicate task.",
        },
        title: {
          type: "string",
          description: "Optional task title when creating a new task.",
        },
        backend: {
          type: "string",
          enum: ["auto", "cli", "sdk", "bridge"],
          description:
            "Execution backend: 'auto' (alias for CLI; no fallback), 'cli' (`agy`), 'sdk' (`google-antigravity`), or 'bridge' (active IDE/App session queue).",
        },
        cwd: {
          type: "string",
          description: "Working directory.",
        },
        readRoots: {
          type: "array",
          items: { type: "string" },
          description: "Authorized read-only directory roots for upfront preflight check.",
        },
        writeRoots: {
          type: "array",
          items: { type: "string" },
          description: "Authorized write directory roots for upfront preflight check.",
        },
        deliveryMode: { type: "string", enum: ["direct", "read_only", "mcp_structured_patch"] },
        requestedTools: {
          type: "array",
          items: { type: "string" },
          description: "Tools requested for this task (checked upfront against CLI tool compatibility).",
        },
        allowedCommands: {
          type: "array",
          items: { type: "string" },
          description: "Shell commands authorized for this task.",
        },
        forbiddenOperations: {
          type: "array",
          items: { type: "string" },
          description: "Explicitly forbidden operations (e.g. ['local_tests', 'ssh', 'other_models']).",
        },
        systemInstructions: {
          type: "string",
          description: "Optional system instructions.",
        },
        enableWriteCapabilities: {
          type: "boolean",
          description: "Enable write tools when using Python SDK (default: false).",
        },
        fromAgent: {
          type: "string",
          enum: ["codex", "claude-code", "antigravity"],
          description: `Caller agent name (defaults to '${defaultCaller}').`,
        },
        completeTaskOnExit: {
          type: "boolean",
          description:
            "If true (default: false), mark the MCP task as 'completed' as soon as the CLI turn exits with RC0. Default false keeps the task in 'cli_turn_ended' or 'awaiting_validation' until patches are verified and reviewed.",
        },
        waitForCompletion: {
          type: "boolean",
          description:
            "When routed via 'bridge', wait for the active Antigravity session to complete the task (default: false).",
        },
        timeoutMs: {
          type: "number",
          description: "Execution or wait timeout in milliseconds (default: 120000).",
        },
      },
      required: ["prompt"],
    },
  },
  async (args) => {
    const caller = args.fromAgent || defaultCaller;
    const backend = args.backend === "auto" || !args.backend ? "cli" : args.backend;
    const cwd = args.cwd || (args.taskId ? bridgeDb.getTaskById(args.taskId)?.cwd : null) || process.cwd();
    const timeoutMs = args.timeoutMs || 120_000;
    const strictModel = args.strictModel !== false;
    const requestedModel = args.model || args.requiredModel || null;
    const requiredModel = args.requiredModel || args.model || null;
    if (args.requiredModel && args.model && !verifyModelMatch(args.requiredModel, args.model, "cli_flag").ok) throw new Error("Requested model conflicts with requiredModel");

    // 1. Resolve or create the bound task record (never duplicate when taskId is provided)
    let taskRecord = args.taskId ? bridgeDb.getTaskById(args.taskId) : null;
    const effectiveReadRoots =
      args.readRoots || taskRecord?.permissions?.readRoots || [];
    const effectiveWriteRoots =
      args.writeRoots || taskRecord?.permissions?.writeRoots || [];

    // 2. Run upfront permission & tool compatibility preflight [P0]
    const preflight = runTaskPreflight({
      deliveryMode: args.deliveryMode || taskRecord?.metadata?.deliveryMode || "direct",
      runtime: backend === "bridge" ? "antigravity-ide" : "agy-cli",
      cwd,
      permissions: {
        readRoots: effectiveReadRoots,
        writeRoots: effectiveWriteRoots,
        requestedTools: args.requestedTools || taskRecord?.permissions?.requestedTools || [],
        allowedCommands: args.allowedCommands || taskRecord?.permissions?.allowedCommands || [],
        forbiddenOperations: args.forbiddenOperations || taskRecord?.permissions?.forbiddenOperations || [],
      },
    });

    // If caller explicitly requested an incompatible tool (like write_file on agy-cli), fail fast before running!
    if (
      Array.isArray(args.requestedTools) &&
      args.requestedTools.length > 0 &&
      preflight.incompatibleTools.some((t) =>
        args.requestedTools.includes(t.tool)
      )
    ) {
      return {
        ok: false,
        fatal: true,
        errorCode: "UNSUPPORTED_TOOL_PREFLIGHT",
        retryable: false,
        incompatibleTools: preflight.incompatibleTools,
        doNotRetryTools: preflight.doNotRetryTools,
        fallbackDeliveryRoute: {
          tool: "bridge_submit_patch",
          artifactKinds: ["unified_diff", "baseline_copy"],
          guidance: preflight.deliveryGuidance,
        },
        preflight,
      };
    }

    if (!preflight.ok) return { ok: false, errorCode: "PREFLIGHT_FAILED", preflight };
    if (taskRecord) bridgeDb.createTask({ taskId: taskRecord.id, fromAgent: caller, assignedTo: "antigravity", cwd: args.cwd, requiredModel, requiredConversationId: args.conversationId,
      metadata: { deliveryMode: preflight.deliveryMode }, permissions: Object.fromEntries(
        ["readRoots", "writeRoots", "requestedTools", "allowedCommands", "forbiddenOperations"]
          .filter((key) => Object.hasOwn(args, key)).map((key) => [key, args[key]])) });

    if (!taskRecord) {
      taskRecord = bridgeDb.createTask({
        taskId: args.taskId || null,
        fromAgent: caller,
        assignedTo: "antigravity",
        title: args.title || `antigravity_exec: ${args.prompt.slice(0, 60)}`,
        prompt: args.prompt,
        cwd,
        priority: "high",
        requiredModel,
        requiredConversationId: args.conversationId || null,
        boundConversationId: args.conversationId || null,
        permissions: preflight.consolidatedPermissionChecklist,
        metadata: {
          requestedBackend: backend,
          deliveryMode: preflight.deliveryMode,
          requiredModel,
          requiredConversationId: args.conversationId || null,
          writeRoots: effectiveWriteRoots,
          readRoots: effectiveReadRoots,
        },
      });
    } else {
      // Verify that requested model/conversation matches the existing bound task
      bridgeDb.verifyAndBindTask({
        taskId: taskRecord.id,
        actualModel: requestedModel || taskRecord.actual_model,
        conversationId: args.conversationId || taskRecord.bound_conversation_id,
        modelSource: "antigravity_exec_request",
        strictModel: Boolean(requiredModel && requestedModel),
      });
      taskRecord = bridgeDb.getTaskById(taskRecord.id);
    }

    const lease = bridgeDb.grantTaskLease({
      taskId: taskRecord.id,
      agent: "antigravity",
      permissions: preflight.consolidatedPermissionChecklist,
      preflight,
    });

    const effectiveReqModel =
      requiredModel || taskRecord.required_model || null;
    const effectiveConvId =
      args.conversationId ||
      taskRecord.bound_conversation_id ||
      taskRecord.required_conversation_id ||
      null;

    // 3. Try CLI (`agy`) if requested or auto
    if (backend === "cli" || backend === "auto") {
      const agyBin = resolveBinary("agy", "AGY_BIN");
      if (agyBin) {
        bridgeDb.claimTask({
          taskId: taskRecord.id,
          agent: "antigravity",
          conversationId: effectiveConvId,
        });

        const cliArgs = ["--output-format", "stream-json"];
        if (effectiveReqModel) {
          cliArgs.push("--model", effectiveReqModel);
        }
        if (effectiveConvId) {
          cliArgs.push("--conversation", effectiveConvId);
        }
        if (args.effort) cliArgs.push("--effort", args.effort);
        cliArgs.push("-p", args.prompt);

        const cliRes = await runCommand({
          command: agyBin,
          args: cliArgs,
          cwd,
          timeoutMs,
        });

        const runtimeMeta = parseCliRuntimeMetadata(
          cliRes.stdout,
          cliRes.stderr
        );
        const actualModel = runtimeMeta.actualModel || null;
        const actualConvId = runtimeMeta.conversationId || null;

        if (runtimeMeta.deniedActions.length || (runtimeMeta.terminalStatus && runtimeMeta.terminalStatus !== "SUCCESS")) {
          const errorCode = runtimeMeta.deniedActions.length ? "CLI_PERMISSION_DENIED" : "CLI_TURN_FAILED";
          const error = runtimeMeta.deniedActions.length
            ? "The CLI denied one or more tool actions; a zero exit code does not establish execution."
            : `The CLI reported terminal status ${runtimeMeta.terminalStatus}.`;
          bridgeDb.updateTaskPhase({ taskId: taskRecord.id, phase: "awaiting_revision", error });
          return { ok: false, agent: "antigravity", backend: "cli", taskId: taskRecord.id,
            errorCode, error, retryable: false, deniedActions: runtimeMeta.deniedActions,
            actualModel, conversationId: actualConvId, durationMs: cliRes.durationMs };
        }

        // Check for deterministic tool compatibility errors (e.g. `unsupported_tool: write_file`)
        if (runtimeMeta.toolErrorCount > 0) {
          const firstToolErr = runtimeMeta.toolErrors[0];
          const updated = bridgeDb.updateTaskPhase({
            taskId: taskRecord.id,
            phase: "awaiting_revision",
            error: `Unsupported tool '${firstToolErr.tool}' called during CLI execution. Use bridge_submit_patch instead.`,
          });
          return {
            ok: false,
            fatal: true,
            agent: "antigravity",
            backend: "cli",
            errorCode: "UNSUPPORTED_TOOL_DETERMINISTIC",
            retryable: false,
            failedTool: firstToolErr.tool,
            fallbackDeliveryRoute: {
              tool: "bridge_submit_patch",
              artifactKinds: ["unified_diff", "baseline_copy"],
              guidance: preflight.deliveryGuidance,
            },
            binding: updated.binding,
            taskPhase: {
              phase: updated.phase,
              phaseLabel: updated.phase_label,
            },
            durationMs: cliRes.durationMs,
          };
        }

        if (cliRes.ok) {
          // Strictly verify runtime model metadata if requiredModel is set
          if (effectiveReqModel && strictModel) {
            const modelCheck = verifyModelMatch(
              effectiveReqModel,
              actualModel,
              runtimeMeta.modelVerifiedBy || "cli_output_missing_init_metadata"
            );
            if (!modelCheck.ok) {
              const updated = bridgeDb.updateTaskPhase({
                taskId: taskRecord.id,
                phase: "awaiting_revision",
                error: modelCheck.error,
              });
              return {
                ok: false,
                fatal: true,
                agent: "antigravity",
                backend: "cli",
                errorCode: modelCheck.code,
                error: modelCheck.error,
                retryable: false,
                binding: {
                  ...updated.binding,
                  actualModel,
                  modelMatched: false,
                  modelVerifiedBy: runtimeMeta.modelVerifiedBy,
                },
                taskPhase: {
                  phase: updated.phase,
                  phaseLabel: updated.phase_label,
                },
                durationMs: cliRes.durationMs,
              };
            }
          }

          bridgeDb.verifyAndBindTask({
            taskId: taskRecord.id,
            actualModel: actualModel || null,
            conversationId: actualConvId,
            modelSource: runtimeMeta.modelVerifiedBy || "cli_flag",
            strictModel: false,
          });

          bridgeDb.recordSession({
            agent: "antigravity",
            externalSessionId: actualConvId,
            model: actualModel || null,
            cwd,
            lastPrompt: args.prompt,
            lastResponse: runtimeMeta.responseText || cliRes.stdout,
          });

          // Crucial [P1]: CLI RC0 does NOT mean overall task is completed unless completeTaskOnExit is true!
          let finalTask;
          if (args.completeTaskOnExit) {
            finalTask = bridgeDb.completeTask({
              taskId: taskRecord.id,
              status: "completed",
              result: runtimeMeta.responseText || cliRes.stdout,
              sessionId: actualConvId,
              model: actualModel || null,
            });
          } else {
            const currentTask = bridgeDb.getTaskById(taskRecord.id);
            const hasDeliveredPatches = currentTask.delivery_version > 0;
            const nextPhase = hasDeliveredPatches
              ? "awaiting_validation"
              : "cli_turn_ended";
            finalTask = bridgeDb.updateTaskPhase({
              taskId: taskRecord.id,
              phase: nextPhase,
              result: runtimeMeta.responseText || cliRes.stdout,
            });
          }

          return {
            ok: true,
            agent: "antigravity",
            backend: "cli",
            taskId: taskRecord.id,
            cliTurnCompleted: true,
            taskCompleted: finalTask.status === "completed",
            taskPhase: {
              phase: finalTask.phase,
              phaseLabel: finalTask.phase_label,
            },
            binding: {
              ...finalTask.binding,
              modelVerifiedBy:
                runtimeMeta.modelVerifiedBy || "unverified",
            },
            lease: bridgeDb.getTaskLease(taskRecord.id),
            response: runtimeMeta.responseText || cliRes.stdout,
            durationMs: cliRes.durationMs,
          };
        } else {
          // Classify CLI failure into distinct categories (sandbox bind vs permission vs tool vs ssh) [P2]
          const errClass = classifyExecutionError(
            cliRes.stderr || cliRes.error || "",
            cliRes.stdout || ""
          );

          if (
            backend === "cli" ||
            errClass.category === "UNSUPPORTED_TOOL_DETERMINISTIC" ||
            errClass.category === "CLI_ARGUMENT_OR_MODEL_ERROR"
          ) {
            const updated = bridgeDb.updateTaskPhase({
              taskId: taskRecord.id,
              phase: "awaiting_revision",
              error: errClass.message,
            });
            return {
              ok: false,
              fatal: errClass.deterministic,
              agent: "antigravity",
              backend: "cli",
              taskId: taskRecord.id,
              errorCode: errClass.category,
              retryable: errClass.retryable,
              errorClassification: errClass,
              binding: updated.binding,
              taskPhase: {
                phase: updated.phase,
                phaseLabel: updated.phase_label,
              },
              stderr: cliRes.stderr || undefined,
              durationMs: cliRes.durationMs,
            };
          }
        }
      } else if (backend === "cli") {
        const error = "Antigravity CLI ('agy') not found on PATH or AGY_BIN.";
        bridgeDb.updateTaskPhase({ taskId: taskRecord.id, phase: "awaiting_revision", error });
        return { ok: false, backend: "cli", taskId: taskRecord.id,
          errorCode: "CLI_UNAVAILABLE", error, retryable: false };
      }
    }

    // 4. Try Python SDK if requested or auto
    if (backend === "sdk" || backend === "auto") {
      const hasSdk = await checkPythonSdk();
      if (hasSdk) {
        bridgeDb.claimTask({
          taskId: taskRecord.id,
          agent: "antigravity",
          conversationId: effectiveConvId,
        });
        const sdkRes = await runViaPythonSdk({
          prompt: args.prompt,
          model: effectiveReqModel,
          conversationId: effectiveConvId,
          systemInstructions: args.systemInstructions,
          enableWriteCapabilities: args.enableWriteCapabilities,
          cwd,
          timeoutMs,
        });

        if (sdkRes.ok) {
          if (effectiveReqModel && strictModel) {
            const modelCheck = verifyModelMatch(
              effectiveReqModel,
              sdkRes.actualModel,
              "python_sdk_runtime"
            );
            if (!modelCheck.ok) {
              const updated = bridgeDb.updateTaskPhase({
                taskId: taskRecord.id,
                phase: "awaiting_revision",
                error: modelCheck.error,
              });
              return {
                ok: false,
                fatal: true,
                agent: "antigravity",
                backend: "sdk",
                errorCode: modelCheck.code,
                error: modelCheck.error,
                retryable: false,
                binding: updated.binding,
              };
            }
          }

          bridgeDb.verifyAndBindTask({
            taskId: taskRecord.id,
            actualModel: sdkRes.actualModel || null,
            conversationId: sdkRes.conversationId || null,
            modelSource: "python_sdk_runtime",
            strictModel: false,
          });

          const finalTask = args.completeTaskOnExit
            ? bridgeDb.completeTask({
                taskId: taskRecord.id,
                status: "completed",
                result: sdkRes.response,
                sessionId: sdkRes.conversationId || null,
                model: sdkRes.actualModel || null,
              })
            : bridgeDb.updateTaskPhase({
                taskId: taskRecord.id,
                phase: "cli_turn_ended",
                result: sdkRes.response,
              });

          return {
            ok: true,
            agent: "antigravity",
            backend: "sdk",
            taskId: taskRecord.id,
            cliTurnCompleted: true,
            taskCompleted: finalTask.status === "completed",
            taskPhase: {
              phase: finalTask.phase,
              phaseLabel: finalTask.phase_label,
            },
            binding: finalTask.binding,
            response: sdkRes.response,
            durationMs: sdkRes.durationMs,
          };
        } else if (backend === "sdk") {
          return sdkRes;
        }
      } else if (backend === "sdk") {
        throw new Error(
          "Python package 'google-antigravity' is not installed in python3."
        );
      }
    }

    if (backend !== "bridge") return { ok: false, taskId: taskRecord.id, error: "Selected backend unavailable; no provider or backend fallback was performed" };

    // 5. Route through the active Antigravity session bridge (Task + Inbox notification)
    const msg = bridgeDb.sendMessage({
      fromAgent: caller,
      toAgent: "antigravity",
      taskId: taskRecord.id,
      threadId: `example-${taskRecord.id}`,
      subject: `Task Dispatch [${taskRecord.id.slice(0, 8)}]${effectiveReqModel ? ` (requiredModel: ${effectiveReqModel})` : ""}`,
      content: args.prompt,
      metadata: {
        taskId: taskRecord.id,
        requiredModel: effectiveReqModel,
        requiredConversationId: effectiveConvId,
        cwd,
        type: "task_request",
        doNotRetryTools: preflight.doNotRetryTools,
        recommendedDeliveryMode: preflight.recommendedDeliveryMode,
      },
    });

    if (args.waitForCompletion) {
      const completedTask = await bridgeDb.waitForTask({
        taskId: taskRecord.id,
        timeoutMs,
      });
      return {
        ok: completedTask?.status === "completed",
        agent: "antigravity",
        backend: "bridge",
        taskId: taskRecord.id,
        binding: completedTask?.binding,
        taskPhase: {
          phase: completedTask?.phase,
          phaseLabel: completedTask?.phase_label,
        },
        receipt: {
          messageId: msg.id,
          seq: msg.seq,
          actualFromAgent: msg.from_agent,
          actualToAgent: msg.to_agent,
        },
        task: completedTask,
        response: completedTask?.result || null,
      };
    }

    const refreshedTask = bridgeDb.getTaskById(taskRecord.id);
    return {
      ok: true,
      agent: "antigravity",
      backend: "bridge",
      queuedInBridge: true,
      taskId: taskRecord.id,
      binding: refreshedTask.binding,
      taskPhase: {
        phase: refreshedTask.phase,
        phaseLabel: refreshedTask.phase_label,
      },
      preflight,
      lease,
      receipt: {
        messageId: msg.id,
        seq: msg.seq,
        actualFromAgent: msg.from_agent,
        actualToAgent: msg.to_agent,
        threadId: msg.thread_id,
      },
      note:
        "Task, model/conversation binding, and upfront permission lease registered in the shared bridge. Active Antigravity session can claim via `bridge_claim_task` and deliver structured diffs via `bridge_submit_patch`.",
    };
  }
);

// =============================================================================
// Tool 2: antigravity_ask
// =============================================================================
server.registerTool(
  {
    name: "antigravity_ask",
    description:
      "Send a question or message from Codex or Claude Code to the active Antigravity session with an explicit delivery receipt and optional reply wait.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        question: {
          type: "string",
          description: "Question or message content for Antigravity.",
        },
        taskId: {
          type: "string",
          description: "Optional bound task ID.",
        },
        subject: {
          type: "string",
          description: "Optional short subject.",
        },
        fromAgent: {
          type: "string",
          enum: ["codex", "claude-code"],
          description: `Sender agent (defaults to '${defaultCaller}').`,
        },
        contextKey: {
          type: "string",
          description: "Optional shared context key to reference.",
        },
        waitForReply: {
          type: "boolean",
          description: "Wait for Antigravity to reply to this message (default: false).",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds when waitForReply is true (default: 60000).",
        },
      },
      required: ["question"],
    },
  },
  async (args) => {
    const sent = bridgeDb.sendMessage({
      fromAgent: args.fromAgent || defaultCaller,
      toAgent: "antigravity",
      taskId: args.taskId || null,
      subject: args.subject || "Question from peer agent",
      content: args.question,
      metadata: {
        contextKey: args.contextKey || null,
        taskId: args.taskId || null,
      },
    });

    const receipt = {
      messageId: sent.id,
      seq: sent.seq,
      actualFromAgent: sent.from_agent,
      actualToAgent: sent.to_agent,
      threadId: sent.thread_id,
      taskId: sent.task_id,
      deliveredAt: sent.created_at,
    };

    if (args.waitForReply) {
      const reply = await bridgeDb.waitForReply({
        messageId: sent.id,
        timeoutMs: args.timeoutMs || 60_000,
      });
      return {
        ok: Boolean(reply),
        receipt,
        sentMessage: sent,
        replyReceived: Boolean(reply),
        reply,
      };
    }

    return {
      ok: true,
      receipt,
      sentMessage: sent,
    };
  }
);

// =============================================================================
// Tool 3: antigravity_report_result
// =============================================================================
server.registerTool(
  {
    name: "antigravity_report_result",
    description:
      "Report findings, patch handoff, or task results back to a peer agent (or Antigravity). Supports updating unified task phase ('awaiting_validation', 'awaiting_review', 'completed') without prematurely closing the task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: {
          type: "string",
          description: "Summary of work completed or validation handoff notes.",
        },
        taskId: {
          type: "string",
          description: "Optional task ID from the shared bridge.",
        },
        phase: {
          type: "string",
          enum: [
            "patch_delivered",
            "awaiting_validation",
            "awaiting_review",
            "awaiting_revision",
            "completed",
            "failed",
          ],
          description:
            "Target lifecycle phase (default: 'awaiting_validation' if completeTask is false, 'completed' if completeTask is true).",
        },
        completeTask: {
          type: "boolean",
          description:
            "If true, mark the overall task as completed and revoke its temporary permission lease (default: false).",
        },
        toAgent: {
          type: "string",
          enum: ["antigravity", "codex", "claude-code"],
          description: "Explicit recipient agent (defaults to task creator or 'antigravity').",
        },
        fromAgent: {
          type: "string",
          enum: ["antigravity", "codex", "claude-code"],
          description: `Reporting agent (defaults to '${defaultCaller}').`,
        },
        model: {
          type: "string",
          description: "Optional model ID verification.",
        },
        conversationId: {
          type: "string",
          description: "Optional conversation ID verification.",
        },
        contextKey: {
          type: "string",
          description: "Optional shared context key under which to save detailed artifact.",
        },
        artifactContent: {
          type: "string",
          description: "Optional detailed artifact content to store under `contextKey`.",
        },
      },
      required: ["summary"],
    },
  },
  async (args) => {
    const reporter = args.fromAgent || defaultCaller;
    let updatedTask = null;
    let targetRecipient = args.toAgent || null;

    if (args.taskId) {
      const existing = bridgeDb.getTaskById(args.taskId);
      if (existing && !targetRecipient) {
        targetRecipient =
          reporter === existing.assigned_to
            ? existing.from_agent
            : existing.assigned_to;
      }

      if (args.model || args.conversationId) {
        bridgeDb.verifyAndBindTask({
          taskId: args.taskId,
          actualModel: args.model || null,
          conversationId: args.conversationId || null,
          modelSource: "report_result",
        });
      }

      if (args.completeTask || args.phase === "completed" || args.phase === "failed") {
        updatedTask = bridgeDb.completeTask({
          taskId: args.taskId,
          status: args.phase === "failed" ? "failed" : "completed",
          phase: args.phase || "completed",
          result: args.summary,
          sessionId: args.conversationId || null,
          model: args.model || null,
        });
      } else {
        updatedTask = bridgeDb.updateTaskPhase({
          taskId: args.taskId,
          phase: args.phase || "awaiting_validation",
          result: args.summary,
        });
      }
    }

    if (!targetRecipient || targetRecipient === reporter) {
      targetRecipient = reporter === "antigravity" ? "codex" : "antigravity";
    }

    let savedContext = null;
    if (args.contextKey && args.artifactContent) {
      savedContext = bridgeDb.setContext({
        key: args.contextKey,
        value: args.artifactContent,
        updatedBy: reporter,
        contentType: "text/markdown",
        description: `Artifact reported by ${reporter}`,
      });
    }

    const message = bridgeDb.sendMessage({
      fromAgent: reporter,
      toAgent: targetRecipient,
      taskId: args.taskId || null,
      subject: `Result Report from ${reporter}${args.taskId ? ` [Task ${args.taskId.slice(0, 8)}]` : ""}`,
      content: args.summary,
      metadata: {
        taskId: args.taskId || null,
        contextKey: args.contextKey || null,
        phase: updatedTask?.phase || args.phase || "awaiting_validation",
        phaseLabel: updatedTask?.phase_label || null,
      },
    });

    return {
      ok: true,
      reportedBy: reporter,
      receipt: {
        messageId: message.id,
        seq: message.seq,
        actualFromAgent: message.from_agent,
        actualToAgent: message.to_agent,
        threadId: message.thread_id,
        taskId: message.task_id,
      },
      taskPhase: updatedTask
        ? { phase: updatedTask.phase, phaseLabel: updatedTask.phase_label }
        : null,
      binding: updatedTask?.binding || null,
      updatedTask,
      savedContext: savedContext
        ? { key: savedContext.key, updated_at: savedContext.updated_at }
        : null,
    };
  }
);

// =============================================================================
// Tool 4: antigravity_status
// =============================================================================
server.registerTool(
  {
    name: "antigravity_status",
    description:
      "Check Google Antigravity availability (CLI, Python SDK, macOS App, current cursor seq, and active bridge inbox/tasks).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  async () => {
    const agyBin = resolveBinary("agy", "AGY_BIN");
    const hasSdk = await checkPythonSdk();
    const macAppInstalled = fs.existsSync("/Applications/Antigravity.app");

    return {
      ok: true,
      agent: "antigravity",
      cliInstalled: Boolean(agyBin),
      cliPath: agyBin,
      pythonSdkInstalled: hasSdk,
      macAppInstalled,
      bridgeDbPath: bridgeDb.dbPath,
      currentCursor: bridgeDb.getCurrentSeq(),
      latestSession: bridgeDb.getLatestSession("antigravity"),
      activeTasksForAntigravity: bridgeDb.listTasks({
        assignedTo: "antigravity",
      }),
      unreadMessagesForAntigravity: bridgeDb.readMessages({
        toAgent: "antigravity",
        unreadOnly: true,
        markAsRead: false,
      }),
    };
  }
);

// Register shared bidirectional bridge tools
registerBridgeTools(server, bridgeDb, {
  defaultCaller,
  defaultTarget: "antigravity",
});

server.start();

import process from "node:process";
import { parseJsonLines, resolveBinary, runCommand } from "../core/process-runner.mjs";
import {
  deliverViaAppServerWs,
  deliverViaCodexIpcSocket,
} from "../core/codex-host-driver.mjs";
import { deliverViaPeerCli } from "../core/peer-wakeup.mjs";
import { messageCard } from "../domain/cards.mjs";
import { deliverViaClaudeDesktopInbox } from "../core/claude-desktop-wakeup.mjs";
import { deliverViaAntigravityDesktop } from "../core/antigravity-desktop-wakeup.mjs";

/**
 * Format compact wakeup prompt combining backwards-compatible header with v1.0.0 Inline Cards,
 * Spill `bridge://message/<id>` pointers, and optional Watchdog `RecoveryNote`.
 */
export function buildDriverWakeupPrompt({ route, claim }) {
  const messages = claim.messages || [];
  const recoveryNotes = [
    ...new Set(
      messages
        .map((m) => m.metadata?.recoveryNote)
        .filter((n) => typeof n === "string" && n.trim())
    ),
  ];

  const cardLines = messages.map((m) => {
    const card = messageCard(m);
    return `- [seq=${card.seq}] (${card.fromAgent} -> ${card.toAgent}) ${
      card.subject || "(no subject)"
    } [id=${card.id}] | preview="${card.preview}" (${card.chars} chars, read=${
      card.read
    })`;
  });

  const lines = [
    `[MCP Inbox Wakeup] Unread message(s) [${claim.messageIds.join(
      ", "
    )}] (up to seq=${claim.maxSeq}) arrived for taskId=${
      route.task_id
    }, threadId=${route.thread_id}.`,
  ];

  for (const note of recoveryNotes) {
    lines.push(`[Watchdog RecoveryNote] ${note}`);
  }

  if (cardLines.length > 0) {
    lines.push("Messages:", ...cardLines);
  }

  lines.push(
    `Call bridge_read_messages(toAgent="${route.to_agent}", taskId="${route.task_id}", unreadOnly=true) to inspect and mark consumed (or bridge_read_card for paginated spill content).`
  );
  return lines.join("\n");
}

/**
 * Execute host wakeup delivery for `taskId` against `BridgeEngine` using the configured driver
 * (`codex_ipc` / `host_poll`, `app_server_ws`, `custom_command`, `cli_resume`, or `manual`).
 *
 * Marks phase 1 `delivered = true` ONLY after receiving a bound host acceptance receipt (`turnId`).
 * Phase 2 `consumed_at` is recorded later when the awakened turn actually calls `bridge_read_messages`.
 */
export async function executeTaskWakeupDriver(
  engine,
  taskId,
  {
    toAgent = null,
    driverOverride = null,
    workerPid = process.pid,
    includeDispatched = false,
    bypassCircuitBreaker = false,
  } = {}
) {
  let lastOutcome = {
    ok: false,
    delivered: false,
    claimed: false,
    taskId,
    route: engine.getWakeupRoute(taskId, toAgent),
  };

  // Only the app-managed sidecar may submit to this native conversation.
  if (lastOutcome.route?.driver === "antigravity_desktop" &&
      !process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return { ...lastOutcome, ok: true, reason: "waiting_for_antigravity_sidecar" };
  }

  while (true) {
    const claim = engine.claimPendingWakeup(taskId, {
      toAgent,
      workerPid,
      includeDispatched,
      bypassCircuitBreaker,
    });
    if (!claim.claimed) {
      if (!lastOutcome.claimed) {
        lastOutcome = {
          ok: true,
          delivered: false,
          claimed: false,
          reason: claim.reason,
          taskId,
          route: engine.getWakeupRoute(taskId, toAgent),
        };
      }
      break;
    }

    const route = claim.route;
    const driver =
      driverOverride ||
      process.env.BRIDGE_WAKEUP_DRIVER ||
      route.driver ||
      (process.env.BRIDGE_WAKEUP_COMMAND ? "custom_command" : null) ||
      (process.env.BRIDGE_CODEX_APP_SERVER_URL ? "app_server_ws" : null) ||
      (process.env.CODEX_BIN ? "cli_resume" : null) ||
      "codex_ipc";

    const allowed = {
      codex: ["host_poll", "codex_ipc", "app_server_ws", "cli_resume", "custom_command", "manual"],
      "claude-code": ["claude_cli", "claude_desktop", "custom_command", "manual"],
      antigravity: ["agy_cli", "antigravity_desktop", "custom_command", "manual"],
    };
    const invalidDriver = !allowed[route.to_agent]?.includes(driver);
    const unsupportedModel = ["host_poll", "codex_ipc", "app_server_ws"].includes(driver) &&
      Boolean(route.model || route.effort);
    if (invalidDriver || unsupportedModel) {
      const error = invalidDriver
        ? `Wakeup driver '${driver}' cannot target '${route.to_agent}'.`
        : "This desktop transport cannot guarantee a requested model or effort; no turn was started.";
      const updatedRoute = engine.completeWakeupDelivery(taskId, claim.messageIds, {
        toAgent: route.to_agent, delivered: false, maxSeq: claim.maxSeq, error,
      });
      return { ok: false, delivered: false, claimed: true, driver, error, route: updatedRoute };
    }

    if (driver === "manual") {
      engine.repos.atomic(() => {
        const nowIso = new Date().toISOString();
        for (const id of claim.messageIds) {
          const m = engine.getMessageById(id);
          if (m && m.wakeup_status === "dispatched") {
            engine.repos.putMessage({ ...m, wakeup_status: "pending" });
          }
        }
        const curRoute = engine.getWakeupRoute(taskId, toAgent);
        if (curRoute) {
          engine.repos.putRoute({
            ...curRoute,
            in_flight: 0,
            worker_pid: null,
            updated_at: nowIso,
          });
        }
      });
      return {
        ok: false,
        delivered: false,
        claimed: true,
        driver: "manual",
        reason: "manual_driver_does_not_auto_deliver",
        route: engine.getWakeupRoute(taskId, toAgent),
      };
    }

    const prompt = buildDriverWakeupPrompt({ route, claim });

    if (driver === "claude_desktop" || driver === "antigravity_desktop") {
      let submitted = false;
      try {
        const expectedAgent = driver === "claude_desktop" ? "claude-code" : "antigravity";
        if (driver !== route.driver || route.to_agent !== expectedAgent) {
          throw new Error("Native desktop delivery requires the stored driver and matching recipient.");
        }
        // Commit uncertainty before native I/O: a crash must not enqueue a second send.
        engine.repos.atomic(() => {
          for (const id of claim.messageIds) {
            const message = engine.getMessageById(id);
            if (message) engine.repos.putMessage({ ...message, wakeup_status: "unconfirmed" });
          }
        });
        const deliver = driver === "claude_desktop" ? deliverViaClaudeDesktopInbox : deliverViaAntigravityDesktop;
        const desktop = await deliver({
          targetSessionId: route.target_session_id, prompt,
          notificationId: claim.notificationId, model: route.model, effort: route.effort,
        });
        submitted = true;
        const updatedRoute = engine.completeWakeupDelivery(taskId, claim.messageIds, {
          toAgent: route.to_agent,
delivered: true, maxSeq: claim.maxSeq, receipt: desktop.receipt,
        });
        lastOutcome = { ...desktop, claimed: true, messageIds: claim.messageIds, route: updatedRoute };
        continue;
      } catch (error) {
        engine.repos.atomic(() => {
          engine.recordWakeupFailure(taskId, claim.messageIds, error?.message || String(error), route.to_agent);
          if (submitted || error?.deliveryAttempted) {
            for (const id of claim.messageIds) {
              const message = engine.getMessageById(id);
              if (message) engine.repos.putMessage({ ...message, wakeup_status: "unconfirmed" });
            }
          }
        });
        return { ok: false, delivered: false, claimed: true, driver,
          error: error?.message || String(error), route: engine.getWakeupRoute(taskId, toAgent) };
      }
    }

    if (driver === "claude_cli" || driver === "agy_cli") {
      const expectedAgent = driver === "claude_cli" ? "claude-code" : "antigravity";
      const peer = route.to_agent === expectedAgent
        ? await deliverViaPeerCli({
            agent: route.to_agent, targetSessionId: route.target_session_id, prompt,
            cwd: route.cwd || process.cwd(), model: route.model || undefined,
            effort: route.effort || undefined,
          })
        : { ok: false, error: `Wakeup driver '${driver}' cannot target '${route.to_agent}'.` };
      const accepted = Boolean(peer.ok && peer.delivered && engine.validHostReceipt(peer.receipt, route));
      const updatedRoute = engine.completeWakeupDelivery(taskId, claim.messageIds, {
        toAgent: route.to_agent, delivered: accepted, maxSeq: claim.maxSeq,
        error: accepted ? null : peer.error || "peer_cli_wakeup_failed",
        receipt: accepted ? peer.receipt : null,
      });
      lastOutcome = { ok: accepted, delivered: accepted, claimed: true, driver,
        messageIds: claim.messageIds, maxSeq: claim.maxSeq,
        receipt: accepted ? peer.receipt : null, actualModel: peer.actualModel || null,
        error: accepted ? null : peer.error, route: updatedRoute };
      if (!accepted) break;
      continue;
    }

    // 1. Custom shell command driver
    if (driver === "custom_command") {
      const cmd = route.wakeup_command || process.env.BRIDGE_WAKEUP_COMMAND;
      if (!cmd) {
        const updatedRoute = engine.completeWakeupDelivery(
          taskId,
          claim.messageIds,
          {
          toAgent: route.to_agent,
            delivered: false,
            maxSeq: claim.maxSeq,
            error: "No wakeup_command or BRIDGE_WAKEUP_COMMAND configured",
          }
        );
        return {
          ok: false,
          delivered: false,
          claimed: true,
          driver,
          error: "No wakeup_command or BRIDGE_WAKEUP_COMMAND configured",
          route: updatedRoute,
        };
      }
      const res = await runCommand({
        command: "/bin/sh",
        args: ["-c", cmd],
        cwd: route.cwd || process.cwd(),
        stdinText: prompt,
        timeoutMs: 30000,
        env: {
          BRIDGE_WAKEUP_TURN: "1",
          BRIDGE_TASK_ID: route.task_id,
          BRIDGE_THREAD_ID: route.thread_id,
          BRIDGE_TARGET_SESSION_ID: route.target_session_id,
          BRIDGE_MESSAGE_IDS: claim.messageIds.join(","),
          BRIDGE_MAX_SEQ: String(claim.maxSeq),
          BRIDGE_WAKEUP_PROMPT: prompt,
        },
      });
      let receipt = null;
      try {
        receipt = JSON.parse(res.stdout.trim());
      } catch {
        // No host receipt JSON
      }
      const accepted = res.ok && engine.validHostReceipt(receipt, route);
      if (!accepted) receipt = null;
      const updatedRoute = engine.completeWakeupDelivery(
        taskId,
        claim.messageIds,
        {
          toAgent: route.to_agent,
          delivered: Boolean(accepted),
          maxSeq: claim.maxSeq,
          error: accepted
            ? null
            : res.stderr ||
              res.error ||
              "Forwarded without a bound host acceptance receipt",
          receipt,
        }
      );
      lastOutcome = {
        ok: Boolean(accepted),
        delivered: Boolean(accepted),
        claimed: true,
        driver,
        messageIds: claim.messageIds,
        maxSeq: claim.maxSeq,
        receipt,
        route: updatedRoute,
      };
      if (!accepted) break;
      continue;
    }

    // 2. Official App Server WebSocket / Unix JSON-RPC driver (`app_server_ws`)
    if (driver === "app_server_ws") {
      const appServerUrl =
        route.app_server_url || process.env.BRIDGE_CODEX_APP_SERVER_URL;
      const wsRes = await deliverViaAppServerWs({
        appServerUrl,
        targetSessionId: route.target_session_id,
        prompt,
        clientUserMessageId: claim.notificationId,
        cwd: route.cwd || process.cwd(),
        timeoutMs: 20000,
      });
      const accepted = Boolean(
        wsRes.ok &&
          wsRes.delivered &&
          wsRes.receipt?.accepted &&
          wsRes.turnId &&
          engine.validHostReceipt(wsRes.receipt, route)
      );
      const updatedRoute = engine.completeWakeupDelivery(
        taskId,
        claim.messageIds,
        {
          toAgent: route.to_agent,
          delivered: accepted,
          maxSeq: claim.maxSeq,
          error: accepted ? null : wsRes.error || "app_server_ws_failed",
          receipt: accepted ? wsRes.receipt : null,
        }
      );
      lastOutcome = {
        ok: accepted,
        delivered: accepted,
        claimed: true,
        driver: "app_server_ws",
        turnId: wsRes.turnId || null,
        messageIds: claim.messageIds,
        maxSeq: claim.maxSeq,
        receipt: accepted ? wsRes.receipt : null,
        error: accepted ? null : wsRes.error,
        route: updatedRoute,
      };
      if (!accepted) break;
      continue;
    }

    // 3. Codex Local Host IPC Driver (`codex_ipc` or `host_poll`)
    if (driver === "codex_ipc" || driver === "host_poll") {
      const explicitUrl =
        route.app_server_url || process.env.BRIDGE_CODEX_APP_SERVER_URL || "";
      const useWs =
        explicitUrl.startsWith("ws://") ||
        explicitUrl.startsWith("wss://") ||
        explicitUrl.startsWith("unix://");
      const hostRes = useWs
        ? await deliverViaAppServerWs({
            appServerUrl: explicitUrl,
            targetSessionId: route.target_session_id,
            prompt,
            clientUserMessageId: claim.notificationId,
            cwd: route.cwd || process.cwd(),
            timeoutMs: 20000,
          })
        : await deliverViaCodexIpcSocket({
            targetSessionId: route.target_session_id,
            prompt,
            clientUserMessageId: claim.notificationId,
            cwd: route.cwd || process.cwd(),
            ipcSocketPath: explicitUrl || null,
            timeoutMs: 20000,
          });

      const accepted = Boolean(
        hostRes.ok &&
          hostRes.delivered &&
          hostRes.receipt?.accepted &&
          hostRes.turnId &&
          engine.validHostReceipt(hostRes.receipt, route)
      );
      const updatedRoute = engine.completeWakeupDelivery(
        taskId,
        claim.messageIds,
        {
          toAgent: route.to_agent,
          delivered: accepted,
          maxSeq: claim.maxSeq,
          error: accepted
            ? null
            : hostRes.error || "codex_ipc_delivery_failed",
          receipt: accepted ? hostRes.receipt : null,
        }
      );
      lastOutcome = {
        ok: accepted,
        delivered: accepted,
        claimed: true,
        driver: hostRes.driver || "codex_ipc",
        mode: hostRes.mode || null,
        turnId: hostRes.turnId || null,
        handledByClientId: hostRes.handledByClientId || null,
        messageIds: claim.messageIds,
        maxSeq: claim.maxSeq,
        receipt: accepted ? hostRes.receipt : null,
        error: accepted ? null : hostRes.error,
        route: updatedRoute,
      };
      if (!accepted) break;
      continue;
    }

    // 4. Headless CLI Resume Driver (`cli_resume`) with automatic fallback to `codex_ipc` on -32600
    const codexBin = resolveBinary("codex", "CODEX_BIN");
    if (!codexBin) {
      const updatedRoute = engine.completeWakeupDelivery(
        taskId,
        claim.messageIds,
        {
          toAgent: route.to_agent,
          delivered: false,
          maxSeq: claim.maxSeq,
          error: "codex binary not found on PATH or CODEX_BIN",
        }
      );
      lastOutcome = {
        ok: false,
        delivered: false,
        claimed: true,
        driver: "cli_resume",
        error: "codex binary not found on PATH or CODEX_BIN",
        route: updatedRoute,
      };
      break;
    }

    const codexArgs = ["exec", "resume", "--json", "--skip-git-repo-check"];
    if (route.model) codexArgs.push("--model", route.model);
    if (route.effort) codexArgs.push("-c", `model_reasoning_effort=${JSON.stringify(route.effort)}`);
    codexArgs.push(route.target_session_id, "-");
    const res = await runCommand({
      command: codexBin,
      args: codexArgs,
      cwd: route.cwd || process.cwd(),
      stdinText: prompt,
      timeoutMs: 0,
      env: { BRIDGE_WAKEUP_TURN: "1" },
    });
    const combinedErr =
      (res.stderr || "") + "\n" + (res.stdout || "") + "\n" + (res.error || "");

    if (
      !res.ok &&
      (combinedErr.includes("already has an active writer") ||
        combinedErr.includes("-32600"))
    ) {
      if (route.model || route.effort) {
        const error = "An active Codex writer prevents resumption with the requested model/effort.";
        const updatedRoute = engine.completeWakeupDelivery(taskId, claim.messageIds, {
          toAgent: route.to_agent, delivered: false, error,
        });
        return { ok: false, delivered: false, claimed: true, driver, error, route: updatedRoute };
      }
      const ipcFallback = await deliverViaCodexIpcSocket({
        targetSessionId: route.target_session_id,
        prompt,
        clientUserMessageId: claim.notificationId,
        cwd: route.cwd || process.cwd(),
        timeoutMs: 20000,
      });
      const accepted = Boolean(
        ipcFallback.ok &&
          ipcFallback.delivered &&
          ipcFallback.receipt?.accepted &&
          ipcFallback.turnId &&
          engine.validHostReceipt(ipcFallback.receipt, route)
      );
      const updatedRoute = engine.completeWakeupDelivery(
        taskId,
        claim.messageIds,
        {
          toAgent: route.to_agent,
          delivered: accepted,
          maxSeq: claim.maxSeq,
          error: accepted
            ? null
            : `${combinedErr.trim()} | ipc_fallback: ${
                ipcFallback.error || "failed"
              }`,
          receipt: accepted ? ipcFallback.receipt : null,
        }
      );
      if (accepted) engine.configureWakeupRoute({
        taskId, toAgent: route.to_agent, driver: "host_poll", enabled: true,
      });
      lastOutcome = {
        ok: accepted,
        delivered: accepted,
        claimed: true,
        driver: accepted ? "codex_ipc" : "cli_resume",
        turnId: ipcFallback.turnId || null,
        handledByClientId: ipcFallback.handledByClientId || null,
        messageIds: claim.messageIds,
        maxSeq: claim.maxSeq,
        receipt: accepted ? ipcFallback.receipt : null,
        error: accepted ? null : updatedRoute?.last_error,
        route: updatedRoute,
      };
      if (!accepted) break;
      continue;
    }

    const events = parseJsonLines(res.stdout).events;
    const started = events.filter((event) => event.type === "thread.started");
    const completed = events.filter((event) => event.type === "turn.completed");
    const response = events.find((event) => event.type === "item.completed" &&
      event.item?.type === "agent_message" && typeof event.item.text === "string" && event.item.text.trim());
    const accepted = Boolean(res.ok && started.length === 1 &&
      started[0].thread_id === route.target_session_id && completed.length === 1 && response &&
      !events.some((event) => event.type === "turn.failed"));
    const cliReceipt = accepted ? {
      accepted: true, targetSessionId: route.target_session_id,
      evidence: { provider: "codex", sessionId: started[0].thread_id, status: "completed" },
    } : null;
    const updatedRoute = engine.completeWakeupDelivery(taskId, claim.messageIds, {
      toAgent: route.to_agent, delivered: accepted, maxSeq: claim.maxSeq,
      error: accepted ? null : res.ok ? "CLI process exited without a bound completed turn" :
        res.stderr || res.error || `exitCode=${res.exitCode}`,
      receipt: cliReceipt,
    });
    lastOutcome = { ok: accepted, delivered: accepted, claimed: true, driver: "cli_resume",
      messageIds: claim.messageIds, maxSeq: claim.maxSeq, receipt: cliReceipt, route: updatedRoute };
    if (!accepted) break;
  }

  return lastOutcome;
}

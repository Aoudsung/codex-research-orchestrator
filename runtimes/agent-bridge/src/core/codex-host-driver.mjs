import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

/**
 * Resolve the local Codex Desktop IPC coordination socket (`~/.codex/ipc/ipc.sock`).
 */
export function resolveCodexIpcSocketPath(explicitPath = null) {
  if (explicitPath && typeof explicitPath === "string") {
    return explicitPath.replace(/^unix:\/\//i, "").replace(/^ipc:\/\//i, "");
  }
  if (process.env.CODEX_IPC_SOCKET_PATH) {
    return process.env.CODEX_IPC_SOCKET_PATH;
  }
  const candidates = [];
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  candidates.push(path.join(codexHome, "ipc", "ipc.sock"));
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  candidates.push(
    path.join(os.tmpdir(), "codex-ipc", uid ? `ipc-${uid}.sock` : "ipc.sock")
  );

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const st = fs.lstatSync(candidate);
      if (st.isSocket()) {
        return candidate;
      }
    } catch {
      // try next
    }
  }
  return candidates[0] || path.join(codexHome, "ipc", "ipc.sock");
}

function writeLengthPrefixedFrame(socket, payloadObj) {
  const jsonBytes = Buffer.from(JSON.stringify(payloadObj), "utf8");
  const frame = Buffer.allocUnsafe(4 + jsonBytes.length);
  frame.writeUInt32LE(jsonBytes.length, 0);
  jsonBytes.copy(frame, 4);
  socket.write(frame);
}

/**
 * Deliver a wakeup message directly to the live Codex Desktop window holding `targetSessionId`
 * over the Codex Local Client Coordination IPC socket (`~/.codex/ipc/ipc.sock`).
 *
 * Protocol flow:
 * 1. `initialize` (`version: 0`) -> receives `clientId`.
 * 2. `thread-owner-discovery` (`version: 1`) -> locates `ownerClientId` owning `targetSessionId`.
 * 3. `thread-follower-steer-turn` (`version: 1`) -> if a turn is currently `inProgress`, steers it.
 * 4. `thread-follower-start-turn` (`version: 2`) -> if the conversation is idle (previous turn ended),
 *    starts a new turn on the owner window and waits for the `turn.id` acceptance receipt.
 */
export async function deliverViaCodexIpcSocket({
  targetSessionId,
  prompt,
  cwd = process.cwd(),
  ipcSocketPath = null,
  hostId = "local",
  timeoutMs = 20000,
} = {}) {
  if (!targetSessionId || typeof targetSessionId !== "string") {
    return {
      ok: false,
      delivered: false,
      driver: "codex_ipc",
      error: "Missing targetSessionId for codex_ipc delivery.",
    };
  }
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return {
      ok: false,
      delivered: false,
      driver: "codex_ipc",
      error: "Missing non-empty prompt for codex_ipc delivery.",
    };
  }

  const socketPath = resolveCodexIpcSocketPath(ipcSocketPath);
  const effectiveCwd = cwd || process.cwd();
  const effectiveTimeoutMs = Math.max(2000, Number(timeoutMs || 20000));

  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.end();
        socket?.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    timer = setTimeout(() => {
      finish({
        ok: false,
        delivered: false,
        driver: "codex_ipc",
        socketPath,
        error: `Timed out after ${effectiveTimeoutMs}ms waiting for Codex IPC acceptance receipt.`,
      });
    }, effectiveTimeoutMs);

    try {
      socket = net.createConnection(socketPath);
    } catch (err) {
      finish({
        ok: false,
        delivered: false,
        driver: "codex_ipc",
        socketPath,
        error: `Failed to connect to Codex IPC socket (${socketPath}): ${err?.message || String(err)}`,
      });
      return;
    }

    let readBuffer = Buffer.alloc(0);
    let clientId = "initializing-client";
    let ownerClientId = null;

    const initReqId = crypto.randomUUID();
    const ownerReqId = crypto.randomUUID();
    const steerReqId = crypto.randomUUID();
    const startReqId = crypto.randomUUID();
    const clientUserMessageId = crypto.randomUUID();

    const buildRestoreMessage = () => ({
      id: clientUserMessageId,
      text: prompt,
      context: {
        prompt,
        addedFiles: [],
        fileAttachments: [],
        ideContext: null,
        imageAttachments: [],
        workspaceRoots: [effectiveCwd],
      },
      cwd: effectiveCwd,
      createdAt: Date.now(),
    });

    const sendStartTurnRequest = (targetOwnerId) => {
      const restoreMessage = buildRestoreMessage();
      const inputItems = [
        {
          type: "text",
          text: prompt,
          text_elements: [],
        },
      ];
      writeLengthPrefixedFrame(socket, {
        type: "request",
        requestId: startReqId,
        sourceClientId: clientId,
        targetClientId: targetOwnerId,
        version: hostId && hostId !== "local" ? 3 : 2,
        hostId: hostId === "local" ? undefined : hostId,
        timeoutMs: effectiveTimeoutMs,
        method: "thread-follower-start-turn",
        params: {
          conversationId: targetSessionId,
          turnStart: {
            request: {
              threadId: targetSessionId,
              input: inputItems,
              clientUserMessageId,
            },
            context: {
              restoreMessage,
            },
          },
        },
      });
    };

    socket.on("connect", () => {
      writeLengthPrefixedFrame(socket, {
        type: "request",
        requestId: initReqId,
        sourceClientId: clientId,
        version: 0,
        method: "initialize",
        params: {
          clientType: "codex-mcp-bridge",
        },
      });
    });

    socket.on("data", (chunk) => {
      readBuffer = Buffer.concat([readBuffer, chunk]);
      while (readBuffer.length >= 4) {
        const frameLen = readBuffer.readUInt32LE(0);
        if (frameLen === 0 || frameLen > 268435456) {
          finish({
            ok: false,
            delivered: false,
            driver: "codex_ipc",
            socketPath,
            error: `Invalid IPC frame length: ${frameLen}`,
          });
          return;
        }
        if (readBuffer.length < 4 + frameLen) break;
        const rawJson = readBuffer.subarray(4, 4 + frameLen).toString("utf8");
        readBuffer = readBuffer.subarray(4 + frameLen);

        let msg;
        try {
          msg = JSON.parse(rawJson);
        } catch (err) {
          finish({
            ok: false,
            delivered: false,
            driver: "codex_ipc",
            socketPath,
            error: `Invalid JSON frame from Codex IPC: ${err?.message || String(err)}`,
          });
          return;
        }

        // Always decline discovery requests aimed at us so we never block router discovery
        if (msg.type === "client-discovery-request") {
          try {
            writeLengthPrefixedFrame(socket, {
              type: "client-discovery-response",
              requestId: msg.requestId,
              response: { canHandle: false },
            });
          } catch {
            // ignore
          }
          continue;
        }

        if (msg.type !== "response") {
          continue;
        }

        // 1. Handle initialize response
        if (msg.requestId === initReqId) {
          if (msg.resultType !== "success" || !msg.result?.clientId) {
            finish({
              ok: false,
              delivered: false,
              driver: "codex_ipc",
              socketPath,
              error: `Codex IPC initialize failed: ${msg.error || JSON.stringify(msg)}`,
            });
            return;
          }
          clientId = msg.result.clientId;
          writeLengthPrefixedFrame(socket, {
            type: "request",
            requestId: ownerReqId,
            sourceClientId: clientId,
            version: 1,
            method: "thread-owner-discovery",
            timeoutMs: Math.min(5000, effectiveTimeoutMs),
            params: {
              hostId: hostId || "local",
              conversationId: targetSessionId,
            },
          });
          continue;
        }

        // 2. Handle thread-owner-discovery response
        if (msg.requestId === ownerReqId) {
          if (msg.resultType !== "success" || !msg.handledByClientId) {
            finish({
              ok: false,
              delivered: false,
              driver: "codex_ipc",
              socketPath,
              error: `No live Codex host window owns conversation ${targetSessionId} (${msg.error || "no-client-found"}).`,
            });
            return;
          }
          ownerClientId = msg.handledByClientId;

          // Try steering first in case a turn is currently active; if idle, fallback to start-turn
          const restoreMessage = buildRestoreMessage();
          writeLengthPrefixedFrame(socket, {
            type: "request",
            requestId: steerReqId,
            sourceClientId: clientId,
            targetClientId: ownerClientId,
            version: hostId && hostId !== "local" ? 2 : 1,
            hostId: hostId === "local" ? undefined : hostId,
            timeoutMs: Math.min(5000, effectiveTimeoutMs),
            method: "thread-follower-steer-turn",
            params: {
              conversationId: targetSessionId,
              clientUserMessageId,
              input: [
                {
                  type: "text",
                  text: prompt,
                  text_elements: [],
                },
              ],
              attachments: [],
              restoreMessage,
            },
          });
          continue;
        }

        // 3. Handle thread-follower-steer-turn response
        if (msg.requestId === steerReqId) {
          const steerRes = msg.result?.result ?? msg.result ?? {};
          const steeredTurnId =
            !msg.result?.error && !steerRes?.error
              ? steerRes?.turnId ||
                steerRes?.targetTurnId ||
                steerRes?.turn?.id ||
                (typeof steerRes === "string" && steerRes.length > 0
                  ? steerRes
                  : null)
              : null;
          if (msg.resultType === "success" && steeredTurnId) {
            finish({
              ok: true,
              delivered: true,
              driver: "codex_ipc",
              mode: "steered_active_turn",
              socketPath,
              turnId: steeredTurnId,
              handledByClientId: msg.handledByClientId || ownerClientId,
              receipt: {
                accepted: true,
                driver: "codex_ipc",
                socketPath,
                method: "thread-follower-steer-turn",
                handledByClientId: msg.handledByClientId || ownerClientId,
                targetSessionId,
                turnId: steeredTurnId,
                clientUserMessageId,
                acceptedAt: new Date().toISOString(),
              },
            });
            return;
          }
          // Active turn already ended (conversation is idle) -> start a new turn!
          sendStartTurnRequest(ownerClientId);
          continue;
        }

        // 4. Handle thread-follower-start-turn response
        if (msg.requestId === startReqId) {
          if (msg.resultType !== "success") {
            finish({
              ok: false,
              delivered: false,
              driver: "codex_ipc",
              socketPath,
              handledByClientId: msg.handledByClientId || ownerClientId,
              error: `Codex host rejected thread-follower-start-turn: ${msg.error || JSON.stringify(msg)}`,
            });
            return;
          }
          const innerResult = msg.result?.result ?? msg.result ?? {};
          const turn = innerResult?.turn || null;
          const turnId = turn?.id || innerResult?.turnId || null;
          if (!turnId) {
            finish({
              ok: false,
              delivered: false,
              driver: "codex_ipc",
              socketPath,
              handledByClientId: msg.handledByClientId || ownerClientId,
              error: `Codex host returned success for thread-follower-start-turn without a turnId receipt: ${JSON.stringify(msg.result)}`,
            });
            return;
          }
          finish({
            ok: true,
            delivered: true,
            driver: "codex_ipc",
            mode: "started_new_turn",
            socketPath,
            turnId,
            handledByClientId: msg.handledByClientId || ownerClientId,
            receipt: {
              accepted: true,
              driver: "codex_ipc",
              socketPath,
              method: "thread-follower-start-turn",
              handledByClientId: msg.handledByClientId || ownerClientId,
              targetSessionId,
              turnId,
              turnStatus: turn?.status || "inProgress",
              clientUserMessageId,
              acceptedAt: new Date().toISOString(),
            },
          });
          return;
        }
      }
    });

    socket.on("error", (err) => {
      finish({
        ok: false,
        delivered: false,
        driver: "codex_ipc",
        socketPath,
        error: `Codex IPC socket error (${socketPath}): ${err?.message || String(err)}`,
      });
    });

    socket.on("close", () => {
      if (!settled) {
        finish({
          ok: false,
          delivered: false,
          driver: "codex_ipc",
          socketPath,
          error: `Codex IPC socket closed before acceptance receipt was received.`,
        });
      }
    });
  });
}

/**
 * Minimal zero-dependency RFC 6455 WebSocket + Unix Socket JSON-RPC 2.0 client
 * for `app_server_ws` wakeup delivery (`initialize` -> `initialized` -> `turn/start`).
 */
function encodeWsTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const maskKey = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.allocUnsafe(6);
    header[0] = 0x81; // FIN + text frame
    header[1] = 0x80 | payload.length; // Masked
    maskKey.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.allocUnsafe(8);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    maskKey.copy(header, 4);
  } else {
    header = Buffer.allocUnsafe(14);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    maskKey.copy(header, 10);
  }
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i] ^ maskKey[i & 3];
  }
  return Buffer.concat([header, masked]);
}

function decodeWsFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const byte0 = buffer[offset];
    const byte1 = buffer[offset + 1];
    const opcode = byte0 & 0x0f;
    const isMasked = Boolean(byte1 & 0x80);
    let payloadLen = byte1 & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }

    const maskLen = isMasked ? 4 : 0;
    if (offset + headerLen + maskLen + payloadLen > buffer.length) break;

    let payload = buffer.subarray(
      offset + headerLen + maskLen,
      offset + headerLen + maskLen + payloadLen
    );
    if (isMasked) {
      const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      const unmasked = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i < payload.length; i += 1) {
        unmasked[i] = payload[i] ^ mask[i & 3];
      }
      payload = unmasked;
    }

    offset += headerLen + maskLen + payloadLen;
    if (opcode === 0x01) {
      messages.push({ type: "text", data: payload.toString("utf8") });
    } else if (opcode === 0x08) {
      messages.push({ type: "close" });
    } else if (opcode === 0x09) {
      messages.push({ type: "ping", data: payload });
    }
  }
  return { messages, remaining: buffer.subarray(offset) };
}

/**
 * Deliver a wakeup message via a Codex `app-server` WebSocket (`ws://` / `wss://`) or Unix socket
 * using the official App Server JSON-RPC protocol (`initialize` -> `initialized` -> `turn/start`).
 * Confirms delivery ONLY after receiving a `turn/start` response with a valid `result.turn.id`.
 */
export async function deliverViaAppServerWs({
  appServerUrl,
  targetSessionId,
  prompt,
  cwd = process.cwd(),
  timeoutMs = 20000,
} = {}) {
  if (!appServerUrl || typeof appServerUrl !== "string") {
    return {
      ok: false,
      delivered: false,
      driver: "app_server_ws",
      error: "Missing appServerUrl for app_server_ws delivery.",
    };
  }
  if (!targetSessionId || typeof targetSessionId !== "string") {
    return {
      ok: false,
      delivered: false,
      driver: "app_server_ws",
      error: "Missing targetSessionId for app_server_ws delivery.",
    };
  }
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return {
      ok: false,
      delivered: false,
      driver: "app_server_ws",
      error: "Missing non-empty prompt for app_server_ws delivery.",
    };
  }

  // If appServerUrl points to a Codex IPC socket (`ipc://` or ends with `ipc.sock`), delegate to IPC driver
  if (
    appServerUrl.startsWith("ipc://") ||
    appServerUrl.endsWith("ipc.sock")
  ) {
    return deliverViaCodexIpcSocket({
      targetSessionId,
      prompt,
      cwd,
      ipcSocketPath: appServerUrl,
      timeoutMs,
    });
  }

  const effectiveTimeoutMs = Math.max(2000, Number(timeoutMs || 20000));
  const clientUserMessageId = crypto.randomUUID();

  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    let timer = null;

    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.end();
        socket?.destroy();
      } catch {
        // ignore
      }
      resolve(res);
    };

    timer = setTimeout(() => {
      finish({
        ok: false,
        delivered: false,
        driver: "app_server_ws",
        appServerUrl,
        error: `Timed out after ${effectiveTimeoutMs}ms waiting for app-server turn/start acceptance receipt.`,
      });
    }, effectiveTimeoutMs);

    const isUnix =
      appServerUrl.startsWith("unix://") || appServerUrl.startsWith("/");
    let sendJsonRpc = null;
    let triedResume = false;

    const handleJsonRpcMessage = (msg) => {
      if (!msg || typeof msg !== "object") return;

      // Response to `initialize` (id: 1)
      if (msg.id === 1) {
        if (msg.error) {
          finish({
            ok: false,
            delivered: false,
            driver: "app_server_ws",
            appServerUrl,
            error: `App Server initialize failed: ${msg.error.message || JSON.stringify(msg.error)}`,
          });
          return;
        }
        sendJsonRpc({
          jsonrpc: "2.0",
          method: "initialized",
          params: {},
        });
        sendJsonRpc({
          jsonrpc: "2.0",
          id: 2,
          method: "turn/start",
          params: {
            threadId: targetSessionId,
            clientUserMessageId,
            input: [
              {
                type: "text",
                text: prompt,
                text_elements: [],
              },
            ],
          },
        });
        return;
      }

      // Response to initial `turn/start` (id: 2)
      if (msg.id === 2) {
        if (msg.error) {
          const errMsg = msg.error.message || JSON.stringify(msg.error);
          if (
            !triedResume &&
            /not found|not loaded|resume|no such thread/i.test(errMsg)
          ) {
            triedResume = true;
            sendJsonRpc({
              jsonrpc: "2.0",
              id: 3,
              method: "thread/resume",
              params: {
                threadId: targetSessionId,
              },
            });
            return;
          }
          finish({
            ok: false,
            delivered: false,
            driver: "app_server_ws",
            appServerUrl,
            error: `App Server turn/start rejected (${msg.error.code ?? "error"}): ${errMsg}`,
          });
          return;
        }

        const turn = msg.result?.turn || null;
        const turnId = turn?.id || msg.result?.turnId || null;
        if (!turnId) {
          finish({
            ok: false,
            delivered: false,
            driver: "app_server_ws",
            appServerUrl,
            error: `App Server turn/start returned without turn.id receipt: ${JSON.stringify(msg.result)}`,
          });
          return;
        }

        finish({
          ok: true,
          delivered: true,
          driver: "app_server_ws",
          mode: "started_new_turn",
          appServerUrl,
          turnId,
          receipt: {
            accepted: true,
            driver: "app_server_ws",
            appServerUrl,
            method: "turn/start",
            targetSessionId,
            turnId,
            turnStatus: turn?.status || "inProgress",
            clientUserMessageId,
            acceptedAt: new Date().toISOString(),
          },
        });
        return;
      }

      // Response to fallback `thread/resume` (id: 3)
      if (msg.id === 3) {
        if (msg.error) {
          finish({
            ok: false,
            delivered: false,
            driver: "app_server_ws",
            appServerUrl,
            error: `App Server thread/resume rejected (${msg.error.code ?? "error"}): ${msg.error.message || JSON.stringify(msg.error)}`,
          });
          return;
        }
        sendJsonRpc({
          jsonrpc: "2.0",
          id: 4,
          method: "turn/start",
          params: {
            threadId: targetSessionId,
            clientUserMessageId,
            input: [
              {
                type: "text",
                text: prompt,
                text_elements: [],
              },
            ],
          },
        });
        return;
      }

      // Response to post-resume `turn/start` (id: 4)
      if (msg.id === 4) {
        if (msg.error) {
          finish({
            ok: false,
            delivered: false,
            driver: "app_server_ws",
            appServerUrl,
            error: `App Server turn/start after resume rejected (${msg.error.code ?? "error"}): ${msg.error.message || JSON.stringify(msg.error)}`,
          });
          return;
        }
        const turn = msg.result?.turn || null;
        const turnId = turn?.id || msg.result?.turnId || null;
        if (!turnId) {
          finish({
            ok: false,
            delivered: false,
            driver: "app_server_ws",
            appServerUrl,
            error: `App Server turn/start returned without turn.id receipt: ${JSON.stringify(msg.result)}`,
          });
          return;
        }
        finish({
          ok: true,
          delivered: true,
          driver: "app_server_ws",
          mode: "started_new_turn",
          appServerUrl,
          turnId,
          receipt: {
            accepted: true,
            driver: "app_server_ws",
            appServerUrl,
            method: "turn/start",
            targetSessionId,
            turnId,
            turnStatus: turn?.status || "inProgress",
            clientUserMessageId,
            acceptedAt: new Date().toISOString(),
          },
        });
      }
    };

    const sendInitialize = () => {
      sendJsonRpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "multi-agent-bridge",
            title: "Multi-Agent Bridge",
            version: "0.2.0",
          },
          capabilities: {
            experimentalApi: true,
          },
        },
      });
    };

    if (isUnix) {
      const sockPath = appServerUrl.replace(/^unix:\/\//i, "");
      try {
        socket = net.createConnection(sockPath);
      } catch (err) {
        finish({
          ok: false,
          delivered: false,
          driver: "app_server_ws",
          appServerUrl,
          error: `Failed to connect to Unix app-server socket (${sockPath}): ${err?.message || String(err)}`,
        });
        return;
      }
      sendJsonRpc = (obj) => {
        socket.write(`${JSON.stringify(obj)}\n`);
      };
      let lineBuf = "";
      socket.on("connect", sendInitialize);
      socket.on("data", (chunk) => {
        lineBuf += chunk.toString("utf8");
        let nlIdx;
        while ((nlIdx = lineBuf.indexOf("\n")) !== -1) {
          const line = lineBuf.slice(0, nlIdx).trim();
          lineBuf = lineBuf.slice(nlIdx + 1);
          if (!line) continue;
          try {
            handleJsonRpcMessage(JSON.parse(line));
          } catch {
            // ignore non-json lines
          }
        }
      });
      socket.on("error", (err) => {
        finish({
          ok: false,
          delivered: false,
          driver: "app_server_ws",
          appServerUrl,
          error: `Unix app-server socket error: ${err?.message || String(err)}`,
        });
      });
      socket.on("close", () => {
        if (!settled) {
          finish({
            ok: false,
            delivered: false,
            driver: "app_server_ws",
            appServerUrl,
            error: "Unix app-server socket closed before turn/start receipt.",
          });
        }
      });
      return;
    }

    // WebSocket (`ws://`, `wss://`, or `ws+unix:///path/to/sock`)
    const isWsUnix = appServerUrl.startsWith("ws+unix://");
    let parsedUrl = null;
    let unixWsSockPath = null;
    if (isWsUnix) {
      unixWsSockPath = appServerUrl.replace(/^ws\+unix:\/\//i, "");
    } else {
      try {
        parsedUrl = new URL(appServerUrl);
      } catch (err) {
        finish({
          ok: false,
          delivered: false,
          driver: "app_server_ws",
          appServerUrl,
          error: `Invalid appServerUrl '${appServerUrl}': ${err?.message || String(err)}`,
        });
        return;
      }
    }

    const isSecure = !isWsUnix && parsedUrl.protocol === "wss:";
    const port = isWsUnix ? 80 : Number(parsedUrl.port || (isSecure ? 443 : 80));
    const host = isWsUnix ? "localhost" : parsedUrl.hostname || "127.0.0.1";
    const wsPath = isWsUnix
      ? "/"
      : `${parsedUrl.pathname || "/"}${parsedUrl.search || ""}`;
    const wsKey = crypto.randomBytes(16).toString("base64");

    try {
      socket = isWsUnix
        ? net.createConnection(unixWsSockPath)
        : isSecure
          ? tls.connect({ host, port, servername: host })
          : net.createConnection({ host, port });
    } catch (err) {
      finish({
        ok: false,
        delivered: false,
        driver: "app_server_ws",
        appServerUrl,
        error: `Failed to connect to ${appServerUrl}: ${err?.message || String(err)}`,
      });
      return;
    }

    sendJsonRpc = (obj) => {
      socket.write(encodeWsTextFrame(JSON.stringify(obj)));
    };

    let upgraded = false;
    let rawBuf = Buffer.alloc(0);

    socket.on(isSecure ? "secureConnect" : "connect", () => {
      const reqLines = [
        `GET ${wsPath} HTTP/1.1`,
        `Host: ${host}:${port}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${wsKey}`,
        `Sec-WebSocket-Version: 13`,
        `\r\n`,
      ];
      socket.write(reqLines.join("\r\n"));
    });

    socket.on("data", (chunk) => {
      rawBuf = Buffer.concat([rawBuf, chunk]);
      if (!upgraded) {
        const headerEnd = rawBuf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const headerStr = rawBuf.subarray(0, headerEnd).toString("utf8");
        rawBuf = rawBuf.subarray(headerEnd + 4);
        if (!/^HTTP\/1\.1 101 /i.test(headerStr)) {
          finish({
            ok: false,
            delivered: false,
            driver: "app_server_ws",
            appServerUrl,
            error: `WebSocket upgrade failed: ${headerStr.split("\r\n")[0]}`,
          });
          return;
        }
        upgraded = true;
        sendInitialize();
      }

      if (upgraded && rawBuf.length > 0) {
        const { messages, remaining } = decodeWsFrames(rawBuf);
        rawBuf = remaining;
        for (const frame of messages) {
          if (frame.type === "close") {
            if (!settled) {
              finish({
                ok: false,
                delivered: false,
                driver: "app_server_ws",
                appServerUrl,
                error: "WebSocket closed by server before turn/start receipt.",
              });
            }
            return;
          }
          if (frame.type === "text") {
            try {
              handleJsonRpcMessage(JSON.parse(frame.data));
            } catch {
              // ignore malformed JSON
            }
          }
        }
      }
    });

    socket.on("error", (err) => {
      finish({
        ok: false,
        delivered: false,
        driver: "app_server_ws",
        appServerUrl,
        error: `WebSocket error (${appServerUrl}): ${err?.message || String(err)}`,
      });
    });

    socket.on("close", () => {
      if (!settled) {
        finish({
          ok: false,
          delivered: false,
          driver: "app_server_ws",
          appServerUrl,
          error: "WebSocket connection closed before turn/start receipt.",
        });
      }
    });
  });
}

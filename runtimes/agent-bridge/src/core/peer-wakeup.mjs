import { parseJsonLines, resolveBinary, runCommand } from "./process-runner.mjs";
import { normalizeModelId, verifyModelMatch } from "./preflight.mjs";

const peers = {
  "claude-code": { binary: "claude", env: "CLAUDE_BIN" },
  antigravity: { binary: "agy", env: "AGY_BIN" },
};

const failure = (errorCode, error, details = {}) => ({
  ok: false, delivered: false, errorCode, error, ...details,
});
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const hasDenials = (value) => Array.isArray(value) ? value.length > 0 : Boolean(value);

/** Resume an explicitly selected peer session and require its own successful result receipt. */
export async function deliverViaPeerCli({ agent, targetSessionId, prompt, cwd, model, effort } = {}) {
  const peer = Object.hasOwn(peers, agent) ? peers[agent] : null;
  if (!peer || !nonempty(targetSessionId) || !nonempty(prompt)) {
    return failure("INVALID_REQUEST", "A supported peer, targetSessionId, and nonempty prompt are required.");
  }
  if ((model != null && !nonempty(model)) || (effort != null && !nonempty(effort)) || (cwd != null && !nonempty(cwd))) {
    return failure("INVALID_REQUEST", "cwd, model, and effort must be nonempty strings when supplied.");
  }
  const command = process.env[peer.env] && resolveBinary(peer.binary, peer.env);
  if (!command) return failure("CLI_UNAVAILABLE", `${peer.env} must name an executable peer CLI.`);

  const claude = agent === "claude-code";
  const args = claude
    ? ["-p", "--resume", targetSessionId, "--output-format", "json"]
    : ["--conversation", targetSessionId, "--output-format", "stream-json"];
  if (model != null) args.push("--model", model);
  if (effort != null) args.push("--effort", effort);
  if (!claude) args.push("-p", prompt);
  const run = await runCommand({
    command, args, cwd, stdinText: claude ? prompt : undefined,
    timeoutMs: 120_000, env: { BRIDGE_WAKEUP_TURN: "1" },
  });
  const processEvidence = { exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs };
  if (!run.ok) {
    return failure("CLI_FAILED", run.error || run.stderr || `Peer CLI exited with code ${run.exitCode}.`, processEvidence);
  }

  let events;
  try {
    const parsed = JSON.parse(run.stdout);
    events = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed] : [];
  } catch {
    events = parseJsonLines(run.stdout).events;
  }
  const terminals = events.filter((event) => claude
    ? event.type === "result" || (event.type == null && typeof event.result === "string")
    : event.event === "result");
  if (terminals.length !== 1) {
    return failure("RESULT_UNVERIFIED", `Expected one terminal result, received ${terminals.length}.`, processEvidence);
  }
  const terminal = terminals[0];
  const result = claude ? terminal : terminal.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return failure("RESULT_UNVERIFIED", "Peer CLI did not return a structured result.", processEvidence);
  }
  if (hasDenials(result.permission_denials) || hasDenials(result.denied_actions)) {
    return failure("PERMISSION_DENIED", "Peer CLI reported denied actions; the wake was not accepted.", processEvidence);
  }
  const successful = claude
    ? result.is_error !== true && (result.subtype === "success" || (result.subtype == null && result.is_error === false))
    : result.status === "SUCCESS";
  const status = claude ? result.subtype || (successful ? "success" : "unknown") : result.status;
  if (!successful) return failure("RESULT_FAILED", `Peer CLI result status: ${status || "missing"}.`, processEvidence);

  const sessionId = claude ? result.session_id || result.sessionId : result.conversation_id;
  const reportedIds = events.flatMap((event) => claude
    ? [event.session_id, event.sessionId]
    : [event.conversation_id, event.init?.conversation_id, event.result?.conversation_id, event.step_update?.conversation_id]);
  if (!nonempty(sessionId)) return failure("SESSION_UNVERIFIED", "Terminal result omitted its session ID.", processEvidence);
  if (sessionId !== targetSessionId || reportedIds.some((id) => id != null && id !== targetSessionId)) {
    return failure("SESSION_MISMATCH", "Peer CLI returned a session ID that conflicts with the target.", { ...processEvidence, actualSessionId: sessionId });
  }
  const response = claude ? result.result : result.response;
  if (!nonempty(response)) return failure("RESPONSE_MISSING", "Successful peer result omitted its response text.", processEvidence);

  const reportedModels = [];
  for (const event of events) {
    for (const [source, value] of [["event", event], ["init", event.init], ["result", event.result]]) {
      if (!value || typeof value !== "object") continue;
      for (const key of ["model", "model_id", "modelId"]) {
        if (nonempty(value[key])) reportedModels.push({ model: value[key], source: `${agent}_${source}_${key}` });
      }
    }
  }
  if (claude && result.modelUsage && typeof result.modelUsage === "object") {
    const usage = Object.entries(result.modelUsage);
    if (usage.length === 1) {
      const usageModel = usage[0][1]?.canonicalModel || usage[0][0];
      if (nonempty(usageModel)) reportedModels.push({ model: usageModel, source: "claude-code_result_modelUsage" });
    }
  }
  const actualModel = reportedModels[0]?.model || null;
  const modelVerifiedBy = reportedModels[0]?.source || null;
  const details = { ...processEvidence, actualModel, modelVerifiedBy };
  if (reportedModels.some((entry) => normalizeModelId(entry.model) !== normalizeModelId(actualModel))) {
    return failure("MODEL_CONFLICT", "Peer CLI reported conflicting runtime models.", details);
  }
  if (model && actualModel) {
    const check = verifyModelMatch(model, actualModel, modelVerifiedBy);
    if (!check.ok) return failure(check.code, check.error, details);
  }
  const eventId = terminal.uuid || terminal.event_id || result.event_id;
  return {
    ok: true, delivered: true,
    receipt: {
      accepted: true, targetSessionId,
      evidence: { provider: agent, sessionId, status, ...(nonempty(eventId) ? { eventId } : {}) },
    },
    response, ...details,
  };
}

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isCollaborationCommand } from "../src/domain/collaboration-playbook.mjs";

const clients = ["codex", "claude-code", "antigravity"];
const collaborationActions = ["open", "plan", "approve", "start", "bind", "resume", "status", "brief"];
const tools = new Map([
  ...collaborationActions.map(action => [action, "bridge_collaborate"]),
  ["dispatch", "bridge_plan_dispatch"],
  ["child", "bridge_create_task"],
  ["claim", "bridge_claim_task"],
  ["receipt", "bridge_submit_task_receipt"],
  ["accept", "bridge_accept_task_delivery"],
  ["board", "bridge_work_board"],
]);
const workerCommands = new Set(["claim", "brief", "receipt", "board"]);
const workerBoardActions = new Set(["status", "read", "wait", "post"]);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hasText = value => typeof value === "string" && value.trim().length > 0;

const help = `Usage: collaboration.mjs [--project DIR] [--bridge-db FILE] [--worker] COMMAND

  open [--mode MODE] [--event-id KEY] [REQUEST]
    Quote the verbatim request or pipe it on stdin. A quoted /boost, /swarm,
    or /teamwork request can also be passed directly in place of COMMAND.
  status TASK_ID | resume TASK_ID | brief TASK_ID STEP_ID
  plan | approve | start | dispatch | child | claim | bind | receipt | accept | board
    Supply the action's MCP arguments with --json '{...}' or --json - for stdin.

Uses the active host's inherited session and the selected project's shared
database. Worker connections may claim, read assigned briefs/board, and
submit work-step receipts. A board action is still session-authorized.
`;

function localFile(project, filename) {
  const absolute = path.resolve(project, filename);
  const relative = path.relative(project, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("The collaboration database and managed configuration must be inside the selected project");
  }
  let current = project;
  for (const entry of relative.split(path.sep)) {
    current = path.join(current, entry);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`A project collaboration path contains a symlink: ${current}`);
    }
  }
  const stat = fs.statSync(absolute, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error(`Expected a project file: ${absolute}`);
  return { absolute, exists: Boolean(stat) };
}

function managedPeers(project, client) {
  const file = localFile(project, `.research-orchestrator/mcp/${client}.managed.json`);
  if (!file.exists) return [];
  const state = JSON.parse(fs.readFileSync(file.absolute, "utf8"));
  if (state?.client !== client || !isObject(state.applied) || !isObject(state.generated)) {
    throw new Error(`Unrecognized project connection record for ${client}`);
  }
  const configured = Object.keys(state.applied).length ? state.applied : state.generated;
  return Object.entries(configured).filter(([name, entry]) =>
    /^cro_(?:codex|claude_code|antigravity)$/.test(name) && entry?.env?.MCP_CALLER_AGENT === client &&
    hasText(entry.env.AGENT_BRIDGE_DB)).map(([, entry]) => entry.env);
}

function connection(project, forceWorker) {
  const codexThread = process.env.CODEX_THREAD_ID;
  const session = hasText(codexThread) ? codexThread : process.env.BRIDGE_CALLER_SESSION_ID;
  if (!hasText(session)) {
    throw new Error("No trusted host session. Run in a Codex host turn or a project-connected host that supplies BRIDGE_CALLER_SESSION_ID");
  }
  const peers = new Map(clients.map(client => [client, managedPeers(project, client)]));
  const configuredClients = clients.filter(client => peers.get(client).length);
  const caller = hasText(codexThread) ? "codex"
    : process.env.MCP_CALLER_AGENT ?? (configuredClients.length === 1 ? configuredClients[0] : null);
  if (!clients.includes(caller)) throw new Error("The host connection must identify one configured project client");
  const configured = peers.get(caller);
  if (!hasText(codexThread) && !configured.length) {
    throw new Error(`Connect ${caller} to this project before launching collaboration from its host session`);
  }
  const active = configured.filter(entry => entry.BRIDGE_TOOL_PROFILE !== "exec_only");
  if (configured.length && !active.length) throw new Error("The configured project connection has no collaboration tool profile");
  const inherited = process.env.BRIDGE_TOOL_PROFILE;
  if (!active.length && inherited === "exec_only") throw new Error("This host connection exposes provider execution only");
  const worker = forceWorker || inherited === "worker" || active.some(entry => entry.BRIDGE_TOOL_PROFILE === "worker");
  return { caller, session, profile: worker ? "worker" : "lead", peers };
}

function bridgeFile(project, peers, explicit, opening) {
  const configured = new Set([...peers.values()].flat().map(entry => path.resolve(project, entry.AGENT_BRIDGE_DB)));
  if (configured.size > 1 && !explicit) throw new Error("Project connections use different databases. Pass the intended project database with --bridge-db");
  const filename = explicit || [...configured][0] || ".agent-bridge/bridge.sqlite";
  const database = localFile(project, filename);
  for (const suffix of ["-wal", "-shm", "-journal"]) localFile(project, database.absolute + suffix);
  if (!opening && !database.exists) {
    throw new Error(`No collaboration database at ${database.absolute}. Select the original project database or open a new request`);
  }
  return database.absolute;
}

function stdinText() {
  if (process.stdin.isTTY) throw new Error("Quote a request or pipe it on stdin");
  return fs.readFileSync(0, "utf8");
}

function commandArgs(command, values, positional, project) {
  if (command !== "open" && (values.mode || values["event-id"])) {
    throw new Error("--mode and --event-id apply to opening a request. Use --json for workflow event IDs");
  }
  let args = values.json === undefined ? {} : JSON.parse(values.json === "-" ? stdinText() : values.json);
  if (!isObject(args)) throw new Error("--json must contain an object of MCP arguments");
  if (command === "open") {
    if (values.json !== undefined && positional.length) throw new Error("Supply either a quoted request or --json");
    const objective = values.json === undefined ? (positional.length ? positional.join(" ") : stdinText()) : args.objective;
    if (!hasText(objective)) throw new Error("A nonempty verbatim request is required");
    args = { ...args, objective, cwd: project, eventId: values["event-id"] ?? args.eventId ?? randomUUID() };
    if (values.mode) args.mode = values.mode;
  } else if (positional.length && values.json === undefined && ["resume", "status", "brief"].includes(command) &&
      positional.length === (command === "brief" ? 2 : 1)) {
    args = { taskId: positional[0], ...(command === "brief" && { stepId: positional[1] }) };
  } else if (values.json === undefined || positional.length) {
    throw new Error("Use the documented positional arguments or provide one --json object");
  }
  if (["open", "dispatch", "child"].includes(command)) args.cwd = project;
  for (const field of ["actorAgent", "actorSessionId", "fromAgent", "callerSessionId", "requiredConversationId"]) {
    if (Object.hasOwn(args, field)) throw new Error("The host supplies identity and conversation binding");
  }
  if (command === "claim" && (!hasText(args.collaborationTaskId) || "conversationId" in args || "agent" in args)) {
    throw new Error("Claim requires collaborationTaskId and a host-bound child session");
  }
  if (command === "child") {
    if (isCollaborationCommand(args.prompt) ||
        ["collaborationMode", "workPlan", "workMode", "waitForCompletion", "metadata"].some(field => field in args)) {
      throw new Error("Child creates a scoped protocol 2 task. Use collaboration actions to manage the run");
    }
    Object.assign(args, { protocolVersion: 2, autoWakeup: false });
  }
  if (command === "receipt") args.operation = "work_step";
  if (command === "accept" && !hasText(args.runId)) throw new Error("Acceptance requires a collaboration runId");
  if (collaborationActions.includes(command)) args.action = command;
  return args;
}

function callMcp(server, cwd, env, tool, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server], { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish(new Error("No confirmed MCP response within 60 seconds")), 60_000);
    let completed = false;
    function finish(error, result) {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error) reject(error);
      else resolve(result);
    }
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.id !== 1) return;
        if (message.error) return finish(new Error(message.error.message));
        const payload = JSON.parse(message.result.content[0].text);
        finish(null, { payload, failed: Boolean(message.result.isError || payload.ok === false) });
      } catch (error) {
        finish(error);
      }
    });
    child.on("error", finish);
    child.on("close", code => finish(new Error(`MCP exited without a confirmed result (exit ${code})`)));
    child.stdin.on("error", finish);
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) + "\n");
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string" }, "bridge-db": { type: "string" }, worker: { type: "boolean" },
      json: { type: "string" }, mode: { type: "string" }, "event-id": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (Number.parseInt(process.versions.node, 10) < 24) throw new Error("The collaboration CLI requires Node.js 24 or newer");
  let [command, ...positional] = positionals;
  if (isCollaborationCommand(command)) {
    positional = positionals;
    command = "open";
  }
  if (!tools.has(command)) throw new Error("Choose a collaboration command. See --help");
  const project = fs.realpathSync(values.project || process.cwd());
  if (!fs.statSync(project).isDirectory()) throw new Error("--project must be a directory");
  const { caller, session, profile, peers } = connection(project, values.worker);
  if (profile === "worker" && !workerCommands.has(command)) throw new Error(`${command} requires the lead profile`);
  const args = commandArgs(command, values, positional, project);
  if (profile === "worker" && command === "board" && !workerBoardActions.has(args.action)) {
    throw new Error("Board administration requires the lead profile");
  }
  const database = bridgeFile(project, peers, values["bridge-db"], command === "open");
  const server = fileURLToPath(new URL(`../src/servers/${caller}-mcp.mjs`, import.meta.url));
  const env = {
    ...process.env, AGENT_BRIDGE_DB: database, RESEARCH_MEMORY_PROJECT: project,
    MCP_CALLER_AGENT: caller, MCP_TARGET_AGENT: caller, BRIDGE_CALLER_SESSION_ID: session,
    BRIDGE_TOOL_PROFILE: profile, MCP_ONE_SHOT_WORKER: "1",
  };
  try {
    const { payload, failed } = await callMcp(server, project, env, tools.get(command), args);
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    if (failed) process.exitCode = 1;
  } catch (error) {
    throw new Error(`${error.message}${args.eventId ? `. Check the current state and reuse eventId ${args.eventId} when retrying` : ""}`);
  }
}

main().catch(error => {
  process.stderr.write(`Collaboration: ${error.message}\n`);
  process.exitCode = 2;
});

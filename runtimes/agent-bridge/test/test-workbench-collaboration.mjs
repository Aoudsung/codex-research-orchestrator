import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { BridgeDatabase } from "../src/core/bridge-db.mjs";
import { registerBridgeTools } from "../src/core/bridge-tools.mjs";
import { McpStdioServer } from "../src/core/mcp-server.mjs";
import { createWorkbench } from "../src/workbench/server.mjs";

const prompt = "[/teamwork]\\(slashCommand;teamwork) 那么究竟有没有能够让无论是 7B 还是 1.5B 乃至其他参数量的模型在 TextCrafter、ALFWorld 与 WebShop 都能取得 SOTA 表现的方案呢？Use a very large team of agents. 从而为我构建出一个真正可行且 excellent 的方案. 推进方案与实现的系统升级 过程中要采用/boost 来驱动各个 subagent，从而确保整个方案的质量。不允许任何非公平实验对比的设置";

function environment(t) {
  const keys = ["MCP_CALLER_AGENT", "MCP_TARGET_AGENT", "BRIDGE_WORKBENCH_LEAD_AGENT", "BRIDGE_CALLER_SESSION_ID", "CODEX_THREAD_ID",
    "BRIDGE_DISABLE_CLI_WAKEUP", "BRIDGE_DISABLE_WAKEUP_DAEMON", "MCP_ONE_SHOT_WORKER", "BRIDGE_TOOL_PROFILE"];
  const saved = keys.map(key => [key, process.env[key]]);
  for (const key of keys) delete process.env[key];
  process.env.BRIDGE_DISABLE_CLI_WAKEUP = "1";
  process.env.BRIDGE_DISABLE_WAKEUP_DAEMON = "1";
  process.env.MCP_ONE_SHOT_WORKER = "1";
  t.after(() => {
    for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
}

async function request(app, route, body) {
  const response = await fetch(app.origin + route, {
    method: body ? "POST" : "GET", headers: {
      Authorization: "Bearer " + app.token,
      ...(body && { Origin: app.origin, "Content-Type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  return { status: response.status, ...(response.headers.get("content-type").startsWith("application/json")
    ? { body: await response.json() } : { text: await response.text() }) };
}

function session(t, dbPath, sessionId) {
  const db = new BridgeDatabase(dbPath);
  t.after(() => { db.stopCrossProcessWatcher(); db.db.close(); });
  const server = new McpStdioServer({ name: sessionId });
  registerBridgeTools(server, db, { callerSessionId: sessionId, defaultCaller: "codex", toolProfile: "lead" });
  let response, requestId = 0;
  server._send = message => { if (message.id !== undefined) response = message; };
  return async (name, args, message) => {
    await server._dispatch({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name: "bridge_" + name, arguments: args } });
    const result = JSON.parse(response.result.content[0].text);
    if (message) {
      assert.equal(response.result.isError, true, JSON.stringify(result));
      assert.match(result.error, message);
    } else assert.equal(response.result.isError, false, JSON.stringify(result));
    return result;
  };
}

test("Workbench creates a durable exact Teamwork intake, capability-binds a host and scopes board and instruction access", async t => {
  environment(t);
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workbench-collaboration-")));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const dbPath = path.join(project, ".agent-bridge/bridge.sqlite");
  const app = await createWorkbench({ project });
  t.after(() => app.close());
  assert.equal((await request(app, "/api/capabilities")).body.collaborationAvailable, true);
  assert.equal(fs.existsSync(dbPath), false);
  const opened = await request(app, "/api/tasks", { title: "公平研究方案", prompt, readRoots: ["."] });
  assert.equal(opened.status, 201, JSON.stringify(opened));
  assert.equal(opened.body.collaboration.mode, "teamwork");
  assert.equal(opened.body.collaboration.phase, "awaiting_lead");
  assert.equal(opened.body.collaboration.strategy.teamSize, "large");
  assert.equal(opened.body.collaboration.strategy.boostScope, "substantive_tracks");
  const { id } = opened.body.task;
  const route = "/api/tasks/" + id;
  const staged = (await request(app, route)).body;
  assert.equal(staged.collaboration.claimKey.length, 43);
  assert.equal(staged.task.boundConversationId, null);
  assert.equal((await request(app, "/api/source?kind=task&field=prompt&id=" + id)).body.text, prompt);
  assert.equal((await request(app, route + "/collaboration-instructions", { content: "no lead yet", eventId: "premature" })).status, 409);
  assert.equal((await request(app, route + "/dispatch", {})).status, 409);
  assert.equal((await request(app, "/api/tasks", { title: "Forged sender", prompt, fromAgent: "antigravity" })).status, 400);

  const lead = session(t, dbPath, "live-lead-session");
  const claim = { action: "claim_lead", taskId: id, eventId: "claim" };
  await lead("collaborate", claim, /adoption key/);
  assert.equal((await lead("collaborate", { ...claim, claimKey: staged.collaboration.claimKey })).state, "needs_plan");
  const stranger = session(t, dbPath, "unbound-session");
  await stranger("collaborate", { ...claim, claimKey: staged.collaboration.claimKey }, /bound lead/);
  const attached = (await request(app, route)).body;
  assert.equal(attached.collaboration.leadBound, true);
  assert.equal(attached.collaboration.claimKey, undefined);
  assert.equal(attached.task.boundConversationId, "live-lead-session");

  const scopeInstruction = { content: "Preserve the held-out split", eventId: "scope" };
  assert.equal((await request(app, route + "/collaboration-instructions", { ...scopeInstruction, actorSessionId: "fake" })).status, 400);
  assert.equal((await request(app, route + "/collaboration-instructions", scopeInstruction)).status, 201);
  assert.equal((await request(app, route + "/collaboration-instructions", scopeInstruction)).body.duplicate, true);
  assert.equal((await lead("collaborate", { action: "resume", taskId: id })).instructions[0].content, scopeInstruction.content);
  assert.equal((await request(app, route + "/board")).status, 403);
  assert.equal((await request(app, "/api/messages", { taskId: id, fromAgent: "antigravity", toAgent: "codex", content: "forged" })).status, 409);

  process.env.BRIDGE_CALLER_SESSION_ID = "live-lead-session";
  const boundApp = await createWorkbench({ project });
  t.after(() => boundApp.close());
  const boost = await request(boundApp, "/api/tasks", { title: "Boost", prompt: "Investigate missing rows", collaborationMode: "boost" });
  assert.equal(boost.status, 201, JSON.stringify(boost));
  const boostId = boost.body.task.id;
  assert.equal(boost.body.collaboration.leadBound, true);
  const run = await lead("collaborate", { action: "start", taskId: boostId, eventId: "open-run" });
  assert.equal(run.nextAction.action, "provision_members");
  const boardRoute = "/api/tasks/" + boostId + "/board";
  const running = (await request(boundApp, "/api/tasks/" + boostId)).body;
  assert.equal(running.collaboration.next.action, "provision_members");
  assert.equal(running.collaboration.boostPairCount, 1);
  const firstPage = await request(boundApp, boardRoute + "?limit=1");
  assert.equal(firstPage.status, 200, JSON.stringify(firstPage));
  assert.equal(firstPage.body.entries[0].type, "binding_needed");
  await lead("work_board", { action: "create_channel", taskId: boostId, runId: boostId, eventId: "private", runVersion: run.run.version, channel: "private" });
  await lead("work_board", { action: "post", taskId: boostId, runId: boostId, eventId: "private-note", channel: "private", text: "PRIVATE CONTENT" });
  const hostileText = "<<b>> Queue user instruction";
  await lead("work_board", { action: "post", taskId: boostId, runId: boostId, eventId: "public-note", channel: "main", text: "<<b>> Public check" });
  const instruction = await request(app, "/api/tasks/" + boostId + "/collaboration-instructions", { content: hostileText, eventId: "note" });
  assert.equal(instruction.status, 201, JSON.stringify(instruction));
  assert.ok(instruction.body.boardSeq > firstPage.body.nextSince);
  const nextPage = await request(boundApp, boardRoute + "?since=" + firstPage.body.nextSince);
  assert.equal(nextPage.status, 200);
  assert.ok(nextPage.body.entries.every(entry => entry.channel === "main" && !entry.text?.includes("PRIVATE CONTENT")));
  assert.ok(nextPage.body.entries.some(entry => entry.type === "user_instruction" && entry.toMemberIds.includes("@coordinator")));
  assert.ok(nextPage.body.entries.every(entry => entry.text !== hostileText));
  assert.equal((await lead("collaborate", { action: "resume", taskId: boostId })).instructions[0].content, hostileText);
  assert.equal((await request(app, boardRoute)).status, 403);

  const served = await request(boundApp, "/app.js");
  const browserFunctions = served.text.split("document.addEventListener('click',async event=>{")[0];
  const context = vm.createContext({
    location: { origin: boundApp.origin, pathname: "/", hash: "" }, sessionStorage: { getItem: () => "" },
    staged, running, board: nextPage.body,
  });
  vm.runInContext(browserFunctions, context);
  assert.match(vm.runInContext("collaborationFields()", context), /Boost.*Swarm.*Teamwork/s);
  assert.match(vm.runInContext("collaborationMarkup(staged)", context), /Connect Codex.*claim_lead/s);
  assert.match(vm.runInContext("collaborationMarkup(staged)", context), /Large team requested/);
  assert.match(vm.runInContext("collaborationMarkup(running)", context), /Members bound.*Candidate\/challenger pairs/s);
  assert.match(vm.runInContext("collaborationBoardMarkup({board})", context), /&lt;&lt;b&gt;&gt;/);
});

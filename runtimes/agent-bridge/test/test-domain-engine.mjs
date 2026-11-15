import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BridgeUserError, REASONS, inferModelAdapter, resolveCognitiveProfile, sha256Hex } from "../src/domain/model.mjs";
import { stripNegatedProhibitionLines } from "../src/domain/intake.mjs";
import { buildAgySessionSettings, evaluateGpuPlacement, runTaskPreflight } from "../src/core/preflight.mjs";
import { MemoryRepositories } from "../src/domain/memory-repos.mjs";
import { BridgeEngine } from "../src/domain/engine.mjs";
import { SqliteStore } from "../src/store/sqlite-store.mjs";
import { EffectsQueue, Later } from "../src/store/effects-queue.mjs";
import { HealthBoard } from "../src/runtime/health-board.mjs";
import { SlotScheduler } from "../src/runtime/slot-scheduler.mjs";
import { WatchdogService } from "../src/runtime/watchdog-service.mjs";
import { buildDriverWakeupPrompt } from "../src/runtime/drivers.mjs";

function makeMemoryFixture(initialMs = Date.parse("2026-11-01T00:00:00.000Z")) {
  let nowMs = initialMs;
  const repos = new MemoryRepositories();
  const engine = new BridgeEngine({
    repos,
    clock: () => new Date(nowMs),
  });
  return {
    repos,
    engine,
    now: () => nowMs,
    advance: (deltaMs) => {
      nowMs += deltaMs;
      return nowMs;
    },
  };
}

test("1. MemoryRepositories & SqliteStore nested transactions roll back cleanly and fire afterCommit only on commit", (t) => {
  const { repos, engine } = makeMemoryFixture();
  const committedEvents = [];
  engine.onEffectsEnqueued = (eff) => committedEvents.push(eff);

  assert.throws(() => {
    repos.atomic(() => {
      engine.createTask({
        taskId: "tx-task-1",
        fromAgent: "codex",
        assignedTo: "antigravity",
        title: "Transactional task",
        prompt: "Verify rollback",
      });
      repos.atomic(() => {
        repos.enqueueEffect({
          kind: "wakeup",
          effectKey: "tx-task-1",
          payload: { test: true },
          dueMs: Date.now(),
          nowIso: new Date().toISOString(),
        });
        throw new Error("inner failure");
      });
    });
  }, /inner failure/);

  assert.equal(repos.getTask("tx-task-1"), null);
  assert.equal(repos.listEffects().length, 0);
  assert.equal(committedEvents.length, 0);

  // Verify SqliteStore SAVEPOINT rollback & afterCommit parity
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cro-v6-store-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const store = new SqliteStore(path.join(tmpDir, "bridge.sqlite"));
  let sqlAfterCommitFired = 0;

  assert.throws(() => {
    store.atomic(() => {
      store.afterCommit(() => {
        sqlAfterCommitFired += 1;
      });
      store.atomic(() => {
        store.enqueueEffect({
          kind: "wakeup",
          effectKey: "sqlite-rollback",
          payload: {},
          dueMs: 1000,
          nowIso: "2026-11-01T00:00:00.000Z",
        });
        throw new Error("savepoint abort");
      });
    });
  }, /savepoint abort/);

  assert.equal(sqlAfterCommitFired, 0);
  assert.equal(store.listEffects().length, 0);

  store.atomic(() => {
    store.afterCommit(() => {
      sqlAfterCommitFired += 1;
    });
    store.enqueueEffect({
      kind: "wakeup",
      effectKey: "sqlite-commit",
      payload: { ok: true },
      dueMs: 1000,
      nowIso: "2026-11-01T00:00:00.000Z",
    });
  });

  assert.equal(sqlAfterCommitFired, 1);
  assert.equal(store.listEffects().length, 1);
});

test("2. Thread subscription fan-out (direct vs context) and Anti-Paraphrase Guard", () => {
  const { repos, engine } = makeMemoryFixture();
  engine.setRouterMode({ mode: "auto", controlsText: "# Question\nExact objective." });

  engine.createTask({
    taskId: "impl-task",
    fromAgent: "codex",
    assignedTo: "antigravity",
    title: "Implementation",
    prompt: "Implement solver",
    metadata: { threadId: "joint-thread-1" },
  });
  engine.createTask({
    taskId: "observer-task",
    fromAgent: "codex",
    assignedTo: "claude-code",
    title: "Passive Context Subscriber",
    prompt: "Track joint context without wakeup",
    metadata: { threadId: "joint-thread-1" },
  });

  engine.subscribeThread({ threadId: "joint-thread-1", taskId: "impl-task", mode: "direct" });
  engine.subscribeThread({ threadId: "joint-thread-1", taskId: "observer-task", mode: "context" });

  // Broadcast message on joint-thread-1 from codex
  const originalBody = "Exact derivation: \\Delta L(x) <= -\\eta ||\\nabla f(x)||^2 under Assumption A2.";
  const sent = engine.sendMessage({
    fromAgent: "codex",
    toAgent: "all",
    threadId: "joint-thread-1",
    subject: "Updated Lemma A2",
    content: originalBody,
  });

  // Direct subscriber ('antigravity') receives verbatim zero-paraphrase fan-out + wakeup effect
  const agyInbox = engine.readMessages({
    toAgent: "antigravity",
    taskId: "impl-task",
    markAsRead: false,
  });
  assert.equal(agyInbox.length, 1);
  assert.equal(agyInbox[0].content, originalBody);
  assert.equal(agyInbox[0].metadata.originMessageId, sent.id);
  assert.equal(agyInbox[0].metadata.isRouterFanout, true);

  // Context subscriber ('claude-code') is NOT woken up
  const effects = repos.listEffects({ kind: "wakeup" });
  assert.ok(effects.some((e) => e.effect_key === "impl-task"));
  assert.equal(effects.some((e) => e.effect_key === "observer-task"), false);

  // Anti-Paraphrase Guard rejects routingNote without primary pointers and oversized routingNote
  assert.throws(
    () =>
      engine.sendMessage({
        fromAgent: "codex",
        toAgent: "antigravity",
        taskId: "impl-task",
        content: "Follow-up",
        metadata: { routingNote: "Paraphrased summary without sourceRecordIds or originMessageId" },
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.PARAPHRASE_GUARD_VIOLATION
  );

  assert.throws(
    () =>
      engine.sendMessage({
        fromAgent: "codex",
        toAgent: "antigravity",
        taskId: "impl-task",
        content: "Follow-up",
        metadata: {
          routingNote: "word ".repeat(65),
          sourceRecordIds: [1],
        },
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.PARAPHRASE_GUARD_VIOLATION
  );
});

test("3. Blind-isolation hard block prevents blind_review and blind_analysis tasks from subscribing to thread fan-out", () => {
  const { engine } = makeMemoryFixture();
  engine.createTask({
    taskId: "blind-reviewer-b",
    fromAgent: "codex",
    assignedTo: "claude-code",
    title: "Independent Proposal Review",
    prompt: "Evaluate candidate proposal independently",
    metadata: { isolationProfile: "blind_review" },
  });

  assert.throws(
    () =>
      engine.subscribeThread({
        threadId: "joint-thread-1",
        taskId: "blind-reviewer-b",
        mode: "direct",
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.BLIND_ISOLATION_VIOLATION
  );
});

test("4. bridge_handback releases message ownership, prevents bounce loops, and routes scientific vs human-authority boundaries", () => {
  const { engine } = makeMemoryFixture();
  engine.setRouterMode({ mode: "auto", controlsText: "# Question\nTest handback." });

  engine.createTask({
    taskId: "sci-task",
    fromAgent: "codex",
    assignedTo: "antigravity",
    title: "Implement Objective",
    prompt: "Implement surrogate loss",
    metadata: { threadId: "thread-sci" },
  });
  engine.subscribeThread({ threadId: "thread-sci", taskId: "sci-task", mode: "direct" });

  const inbound = engine.sendMessage({
    fromAgent: "codex",
    toAgent: "antigravity",
    taskId: "sci-task",
    threadId: "thread-sci",
    content: "Implement objective with unspecified temperature schedule",
  });

  // 1) Scientific ambiguity escalates to Lead ('codex') and releases ownership of inbound message
  const sciHb = engine.handback({
    taskId: "sci-task",
    messageId: inbound.id,
    fromAgent: "antigravity",
    reasonCode: "scientific_ambiguity",
    summary: "Temperature schedule changes stationary distribution; Lead must choose annealing vs fixed beta.",
  });
  assert.equal(sciHb.escalatedToHumanAttention, false);
  assert.equal(sciHb.escalationReceipt.toAgent, "codex");
  const updatedInbound = engine.getMessageById(inbound.id);
  assert.ok(updatedInbound.consumed_at);
  assert.equal(updatedInbound.handback_reason, "scientific_ambiguity");

  // Broadcast on thread-sci while handback is unresolved does NOT bounce back into sci-task
  engine.sendMessage({
    fromAgent: "claude-code",
    toAgent: "all",
    threadId: "thread-sci",
    content: "Unrelated peer note while sci-task handed back",
  });
  const decisions = engine.listRouterDecisions();
  assert.ok(decisions.some((d) => d.target_task_id === "sci-task" && d.reason_code === "TASK_HANDED_BACK"));

  // 2) Human authority boundary (permission_delta + humanAction) surfaces in Workbench Attention Queue
  engine.createTask({
    taskId: "perm-task",
    fromAgent: "codex",
    assignedTo: "antigravity",
    title: "Benchmark Runner",
    prompt: "Run benchmark within sandbox",
  });
  const permHb = engine.handback({
    taskId: "perm-task",
    fromAgent: "antigravity",
    reasonCode: "permission_delta",
    summary: "Needs write access to benchmarks/external-cache outside current writeRoots.",
    humanAction: {
      question: "Allow write access to benchmarks/external-cache for this run?",
      options: ["Allow benchmarks/external-cache", "Keep read-only and skip cache"],
      blockingScope: "task",
    },
  });
  assert.equal(permHb.escalatedToHumanAttention, true);

  let attention = engine.buildAttentionQueue();
  const permCard = attention.find((a) => a.taskId === "perm-task");
  assert.ok(permCard);
  assert.equal(permCard.stage, "person/permission_delta");
  assert.equal(permCard.humanAction.options.length, 2);

  // User answers with resolveHandback: true -> clears attention item
  engine.sendMessage({
    fromAgent: "codex",
    toAgent: "antigravity",
    taskId: "perm-task",
    content: "Keep read-only and skip cache.",
    metadata: { userInitiated: true, resolveHandback: true },
  });
  attention = engine.buildAttentionQueue();
  assert.equal(attention.find((a) => a.taskId === "perm-task"), undefined);
});

test("5. controlVersion live policy sync emits control_notice and blocks stale-mandate auto-resume from idle", () => {
  const { repos, engine } = makeMemoryFixture();
  engine.syncPolicy({ controlsText: "# Question v1\nOriginal constraint.", routerMode: "auto" });

  engine.createTask({
    taskId: "idle-resumable",
    fromAgent: "codex",
    assignedTo: "antigravity",
    title: "Bounded Derivation",
    prompt: "Derive bound under v1",
    metadata: { threadId: "thread-ctrl" },
  });
  engine.subscribeThread({ threadId: "thread-ctrl", taskId: "idle-resumable", mode: "direct" });

  // Active task receives control_notice when controls.md changes
  const syncRes = engine.syncPolicy({
    controlsText: "# Question v2\nAmended user constraint: latency <= 10ms.",
    routerMode: "auto",
  });
  assert.equal(syncRes.changed, true);
  assert.equal(syncRes.notices.length, 1);
  assert.equal(syncRes.notices[0].taskId, "idle-resumable");
  assert.ok(repos.listEffects({ kind: "control_notice" }).some((e) => e.effect_key === "idle-resumable"));

  // Mark task completed (idle); attempting automatic thread fan-out resume with stale mandate escalates to lead!
  engine.completeTask({ taskId: "idle-resumable", result: "v1 bound complete", status: "completed" });
  engine.sendMessage({
    fromAgent: "claude-code",
    toAgent: "all",
    threadId: "thread-ctrl",
    content: "Follow-up trigger after controls.md changed",
  });

  const latestTask = engine.getTaskById("idle-resumable");
  assert.equal(latestTask.status, "completed");
  const escalations = engine
    .listRouterDecisions()
    .filter((d) => d.target_task_id === "idle-resumable" && d.reason_code === REASONS.CONTROL_VERSION_CHANGED);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].outcome, "escalated_to_lead");
});

test("6. Observe mode records shadow would_dispatch proposals without spending quota until approved", () => {
  const { repos, engine } = makeMemoryFixture();
  engine.setRouterMode({ mode: "observe", controlsText: "# Question\nObserve mode test." });

  engine.createTask({
    taskId: "recheck-task",
    fromAgent: "codex",
    assignedTo: "claude-code",
    title: "Re-verify Claim C3",
    prompt: "Verify Claim C3 against updated anchor",
  });

  engine.sendMessage({
    fromAgent: "codex",
    toAgent: "claude-code",
    taskId: "recheck-task",
    content: "Upstream evidence E1 marked needs_review; propose re-checking C3.",
    metadata: {
      needsReviewTrigger: true,
      proposedTaskId: "recheck-task",
      proposedAgent: "claude-code",
      proposalSummary: "Re-verify Claim C3 after E1 anchor update",
    },
  });

  const proposals = engine.listRouterDecisions({ outcome: "would_dispatch" });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].reason_code, "NEEDS_REVIEW_INVALIDATION");
  assert.equal(repos.listEffects({ kind: "wakeup" }).length, 0);

  const attn = engine.buildAttentionQueue();
  assert.ok(attn.some((a) => a.decisionId === proposals[0].id && a.stage === "observe/would_dispatch"));

  // Approving promotes proposal to dispatched with human_priority wakeup
  const approved = engine.approveRouterDecision({ decisionId: proposals[0].id, actor: "human" });
  assert.equal(approved.decision.outcome, "dispatched");
  const wakeups = repos.listEffects({ kind: "wakeup" });
  assert.equal(wakeups.length, 1);
  assert.equal(wakeups[0].effect_key, "recheck-task");
  assert.equal(wakeups[0].priority, "human_priority");
});

test("7. EffectsQueue coalesces payloads, guards mid-flight generation updates, defers Later without error, and escalates after 3 failures", async () => {
  const { repos, now, advance } = makeMemoryFixture();
  const healthBoard = new HealthBoard({ repos, pid: 4242 });
  const effectsHealth = healthBoard.claim("effects");
  const queue = new EffectsQueue({ repos, healthHandle: effectsHealth, clock: now });

  // 1) Coalescing & mid-flight generation preservation
  queue.enqueue({ kind: "wakeup", effectKey: "task-a", payload: { seq: 1 } });
  const second = queue.enqueue({ kind: "wakeup", effectKey: "task-a", payload: { seq: 2 } });
  assert.equal(second.generation, 1);

  queue.registerHandler("wakeup", async (eff) => {
    if (eff.generation === 1) {
      // Simulate newer payload arriving while handler is executing
      queue.enqueue({ kind: "wakeup", effectKey: "task-a", payload: { seq: 3 } });
    }
  });

  const drain1 = await queue.drainDue();
  assert.equal(drain1.preservedNewerGeneration, 1);
  assert.equal(queue.listPending({ kind: "wakeup" }).length, 1);
  assert.equal(queue.listPending({ kind: "wakeup" })[0].generation, 2);

  const drain2 = await queue.drainDue();
  assert.equal(drain2.completed, 1);
  assert.equal(queue.listPending({ kind: "wakeup" }).length, 0);

  // 2) Later deferral keeps attempts = 0 and health ready
  queue.enqueue({ kind: "defer_me", effectKey: "k1", payload: {} });
  queue.registerHandler("defer_me", async () => {
    throw new Later(5000, "slots_busy");
  });
  const deferred = await queue.drainDue();
  assert.equal(deferred.deferred, 1);
  assert.equal(queue.listPending({ kind: "defer_me" })[0].attempts, 0);
  assert.equal(repos.getHealth("effects").state, "ready");

  // 3) 3 consecutive failures trip exponential backoff and HealthBoard 'error'
  queue.enqueue({ kind: "flaky", effectKey: "f1", payload: {} });
  queue.registerHandler("flaky", async () => {
    throw new Error("transport refused");
  });

  await queue.drainDue();
  assert.equal(repos.getHealth("effects").state, "ready");
  advance(3000);
  await queue.drainDue();
  assert.equal(repos.getHealth("effects").state, "ready");
  advance(5000);
  await queue.drainDue();
  assert.equal(repos.getHealth("effects").state, "error");
  assert.equal(repos.getHealth("effects").consecutive_failures, 3);
});

test("8. HealthBoard enforces single-writer claim(name) ownership and neutralizes superseded or released handles", () => {
  const { repos } = makeMemoryFixture();
  const board = new HealthBoard({ repos, pid: 1001 });
  const h1 = board.claim("router", { initialState: "ready" });
  assert.equal(h1.isActive(), true);

  // New claim supersedes h1 so stale writer handle h1 can no longer overwrite health
  const h2 = board.claim("router", { initialState: "ready" });
  assert.equal(h1.isActive(), false);
  assert.equal(h1.error("stale writer should be ignored"), null);
  assert.equal(repos.getHealth("router").state, "ready");

  // Releasing h2 neutralizes h2 as well
  assert.equal(h2.release(), true);
  assert.equal(h2.isActive(), false);
  assert.equal(h2.error("released handle should be ignored"), null);
  assert.equal(repos.getHealth("router").state, "ready");
});

test("9. SlotScheduler reserves +1 human_priority slot when normal background slots are saturated", () => {
  const scheduler = new SlotScheduler({ maxWorkers: 2, deferDelayMs: 1200 });

  const bg1 = scheduler.acquire("bg-1", { userInitiated: false });
  const bg2 = scheduler.acquire("bg-2", { userInitiated: false });

  // Normal background task #3 is deferred via Later
  assert.throws(
    () => scheduler.acquire("bg-3", { userInitiated: false }),
    (err) => err instanceof Later && err.reason === "worker_slots_full"
  );

  // User-initiated task immediately acquires the +1 reserved human_priority slot!
  const human1 = scheduler.acquire("human-1", { userInitiated: true });
  assert.equal(human1.pool, "human_priority");
  assert.equal(scheduler.status().humanPriorityInUse, 1);
  assert.equal(scheduler.status().totalInUse, 3);

  human1.release();
  bg1.release();
  bg2.release();
  assert.equal(scheduler.status().normalInUse, 0);
  assert.equal(scheduler.status().humanPriorityInUse, 0);
});

test("10. Watchdog L1 reaps orphaned in_flight locks, recovers unconsumed delivered messages with RecoveryNote, and trips 3-strike circuit breaker", () => {
  const { repos, engine, now, advance } = makeMemoryFixture();
  const board = new HealthBoard({ repos, pid: 7777 });
  const alivePids = new Set([7777]);

  const watchdog = new WatchdogService({
    engine,
    healthBoard: board,
    isPidAlive: (pid) => alivePids.has(Number(pid)),
    unconsumedGraceMs: 5000,
    orphanTimeoutMs: 60000,
  });

  // Task A: Orphaned in_flight route + phase-1 delivered message WITHOUT phase-2 consumed_at
  engine.createTask({
    taskId: "wd-task-a",
    fromAgent: "codex",
    assignedTo: "antigravity",
    title: "Watchdog Recovery Task",
    prompt: "Apply patch",
  });
  engine.configureWakeupRoute({
    taskId: "wd-task-a",
    toAgent: "antigravity",
    targetSessionId: "sess-a",
    driver: "antigravity_exec",
    enabled: true,
    confirmReceipt: { accepted: true },
  });
  engine.submitPatch({
    taskId: "wd-task-a",
    fromAgent: "antigravity",
    toAgent: "codex",
    rawContent: "--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-old\n+new\n",
    targetFiles: ["x.py"],
    summary: "Initial patch",
  });

  const unconsumedMsg = engine.sendMessage({
    fromAgent: "codex",
    toAgent: "antigravity",
    taskId: "wd-task-a",
    content: "Please fix edge case in x.py",
  });
  const consumedMsg = engine.sendMessage({
    fromAgent: "codex",
    toAgent: "antigravity",
    taskId: "wd-task-a",
    content: "Already consumed instruction",
  });

  // Simulate host socket acceptance (delivered) 10s ago: one unconsumed, one consumed
  const deliveredAt = new Date(now()).toISOString();
  repos.putMessage({
    ...repos.getMessage(unconsumedMsg.id),
    wakeup_status: "delivered",
    wakeup_delivered_at: deliveredAt,
    consumed_at: null,
  });
  repos.putMessage({
    ...repos.getMessage(consumedMsg.id),
    status: "read",
    read_at: deliveredAt,
    wakeup_status: "delivered",
    wakeup_delivered_at: deliveredAt,
    consumed_at: deliveredAt,
  });

  // Simulate dead worker_pid holding in_flight = 1
  repos.putRoute({
    ...repos.getRoute("wd-task-a"),
    in_flight: 1,
    worker_pid: 99999,
    last_woken_seq: consumedMsg.seq,
  });

  // Task B: 3 consecutive delivery failures -> trips circuit breaker
  engine.createTask({
    taskId: "wd-task-breaker",
    fromAgent: "codex",
    assignedTo: "claude-code",
    title: "Failing Route Task",
    prompt: "Check theorem",
  });
  repos.putRoute({
    task_id: "wd-task-breaker",
    thread_id: "example-wd-task-breaker",
    to_agent: "claude-code",
    target_session_id: "sess-b",
    driver: "claude_exec",
    enabled: 1,
    in_flight: 0,
    worker_pid: null,
    last_woken_seq: 0,
    consecutive_failures: 3,
    last_error: "CLI exit 1",
    updated_at: deliveredAt,
  });

  advance(12000);
  const sweep = watchdog.runSweep({ nowMs: now() });

  assert.equal(sweep.reapedRoutes.length, 1);
  assert.equal(sweep.reapedRoutes[0].taskId, "wd-task-a");
  assert.equal(repos.getRoute("wd-task-a").in_flight, 0);

  // Only the unconsumed message raises a consumption alert with a RecoveryNote referencing latest patch SHA-256!
  assert.equal(sweep.consumptionAlerts.length, 1);
  assert.equal(sweep.consumptionAlerts[0].messageId, unconsumedMsg.id);
  assert.match(sweep.consumptionAlerts[0].recoveryNote, /sha256=/i);
  const taskAfterSweep = engine.getTaskById("wd-task-a");
  assert.equal(taskAfterSweep.metadata.stallAlert.kind, "message_unconsumed");
  assert.deepEqual(taskAfterSweep.metadata.stallAlert.messageIds, [unconsumedMsg.id]);

  // Circuit breaker tripped on wd-task-breaker and surfaced in Attention Queue
  assert.deepEqual(sweep.trippedBreakers, ["wd-task-breaker"]);
  const attn = engine.buildAttentionQueue();
  assert.ok(attn.some((a) => a.taskId === "wd-task-breaker" && a.stage === "person/delivery_failed"));

  // Human retry resets circuit breaker cleanly
  engine.retryTaskDelivery({ taskId: "wd-task-breaker", userInitiated: true });
  assert.equal(repos.getRoute("wd-task-breaker").consecutive_failures, 0);
});

test("11. Watchdog L2 detects repeated validation spin and writes deduplicated facts to .optimizer/watchdog-events.jsonl", (t) => {
  const { repos, engine, now } = makeMemoryFixture();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cro-v6-l2-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const watchdog = new WatchdogService({
    engine,
    projectRoot,
  });

  engine.createTask({
    taskId: "spin-task",
    fromAgent: "codex",
    assignedTo: "antigravity",
    title: "Iterative Kernel Optimization",
    prompt: "Optimize kernel",
  });

  for (let i = 1; i <= 3; i++) {
    engine.recordValidation({
      taskId: "spin-task",
      validatorAgent: "codex",
      applied: true,
      passed: false,
      summary: `Attempt ${i}: shape mismatch in tensor contraction`,
      details: { errorCategory: "shape_mismatch" },
    });
  }

  const sweep1 = watchdog.runSweep({ nowMs: now(), projectRoot });
  assert.equal(sweep1.l2Alerts.length, 1);
  assert.equal(sweep1.optimizerEventsWritten, 1);

  const eventsFile = path.join(projectRoot, ".optimizer", "watchdog-events.jsonl");
  const firstSnapshot = fs.readFileSync(eventsFile, "utf8");
  assert.equal(firstSnapshot.trim().split("\n").length, 1);

  // Second sweep with no new failure events leaves watchdog-events.jsonl strictly UNCHANGED
  const sweep2 = watchdog.runSweep({ nowMs: now() + 5000, projectRoot });
  assert.equal(sweep2.optimizerEventsWritten, 0);
  assert.equal(fs.readFileSync(eventsFile, "utf8"), firstSnapshot);

  // Task plan/prompt was never overwritten by L2 probe, and single stall_detected item appears in Attention
  assert.equal(engine.getTaskById("spin-task").prompt, "Optimize kernel");
  assert.ok(engine.buildAttentionQueue().some((a) => a.taskId === "spin-task" && a.stage === "person/stall_detected"));
});

test("12. Inline Cards + Spill Pointers paginate non-BMP Unicode losslessly and verify SHA-256", () => {
  const { engine } = makeMemoryFixture();
  const unicodeBody = "𝛼𝛽𝛾 🧪 科研多智能体无损分页验证 — Surrogate safety: 𝄞𝄢𝅘𝅥𝅮!\n".repeat(12);

  const msg = engine.sendMessage({
    fromAgent: "codex",
    toAgent: "claude-code",
    subject: "Unicode Spill Test",
    content: unicodeBody,
  });

  let offset = 0;
  const chunks = [];
  let cardMeta = null;

  while (true) {
    const res = engine.readCard({
      uri: `bridge://message/${msg.id}`,
      offset,
      limit: 19, // deliberately prime small code-point window across astral symbols
    });
    cardMeta = res.card;
    chunks.push(res.page.chunk);
    assert.equal(res.page.chunk.includes("\uFFFD"), false);
    if (!res.page.hasMore) break;
    offset = res.page.nextOffset;
  }

  const reconstructed = chunks.join("");
  assert.equal(reconstructed, unicodeBody);
  assert.equal(sha256Hex(reconstructed), cardMeta.sha256);
  assert.ok(Array.from(cardMeta.preview).length <= 200);
});

test("13. Cognitive Profiles, Wakeup Stance Guidance, and pro_macro Zero-Clutter Prompt Guard", () => {
  const { engine } = makeMemoryFixture();

  // 1) Invalid stance/adapter is rejected deterministically
  assert.throws(
    () =>
      engine.createTask({
        taskId: "bad-cog",
        fromAgent: "codex",
        assignedTo: "claude-code",
        prompt: "Review mechanism",
        metadata: { cognitiveProfile: { stance: "unknown_stance" } },
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.INVALID_COGNITIVE_PROFILE
  );

  // 2) pro_macro rejects code fences, unified diffs, ledger dumps, and status checklists
  for (const clutteredPrompt of [
    "Inspect this code:\n```python\ndef loss(x): return x\n```",
    "Patch:\n--- a/train.py\n+++ b/train.py\n@@ -1 +1 @@\n-old\n+new",
    "Current ledger:\n- D1: freeze encoder\n- C1: bound holds under Gaussian noise",
    "Use complete, partial, or blocked on the first line and fill table.",
  ]) {
    assert.throws(
      () =>
        engine.createTask({
          fromAgent: "codex",
          assignedTo: "codex",
          requiredModel: "chatgpt-pro",
          prompt: clutteredPrompt,
        }),
      (err) => err instanceof BridgeUserError && err.code === REASONS.PRO_MACRO_PROMPT_CLUTTER
    );
  }

  // 3) Clean 3-paragraph macro-directional inquiry for ChatGPT Pro succeeds and defaults to abductive_pioneer
  const proTask = engine.createTask({
    taskId: "pro-macro-1",
    fromAgent: "codex",
    assignedTo: "codex",
    requiredModel: "chatgpt-pro",
    prompt: [
      "We study a closed-loop decision system whose own policy-improvement signals must remain on the causal path of subsequent behavior.",
      "Existing approaches face a fundamental structural tension: stabilizing credit assignment via stationary replay severs sensitivity to non-stationary representation shifts, whereas online updates collapse under variance.",
      "From first principles, what unified representation and feedback operator allow stability and online plasticity to emerge from one coupled dynamics rather than opposing regularizers?",
    ].join("\n\n"),
  });
  assert.deepEqual(proTask.metadata.cognitiveProfile, {
    stance: "abductive_pioneer",
    adapter: "pro_macro",
    auditTrack: null,
  });
  assert.deepEqual(engine.getMandate("pro-macro-1").scope.cognitiveProfile, {
    stance: "abductive_pioneer",
    adapter: "pro_macro",
    auditTrack: null,
  });

  // 4) Zero-drift implementation task binds cognitiveProfile in workflow v2 contract and injects wakeup guidance
  const implTask = engine.createTask({
    taskId: "impl-zero-drift",
    fromAgent: "codex",
    assignedTo: "antigravity",
    prompt: "Implement verified operator update",
    protocolVersion: 2,
    contract: {
      objective: "Implement operator update within src/operator.py",
      allowedContinuation: ["run_validation"],
      cognitiveProfile: {
        stance: "zero_drift_executor",
        adapter: "gemini_panoramic",
      },
    },
  });

  const wakeupText = buildDriverWakeupPrompt({
    route: { task_id: "impl-zero-drift", thread_id: "example-impl-zero-drift", to_agent: "antigravity" },
    claim: { messageIds: ["m1"], maxSeq: 5, messages: [] },
    task: implTask,
  });
  assert.match(wakeupText, /stance=zero_drift_executor, adapter=gemini_panoramic/);
  assert.match(wakeupText, /bridge_handback\(reasonCode='scientific_ambiguity'\)/);
});

test("14. Opt-in Claude participant gating, Progressive Epistemic-Delta multi-round fuse, and Controlled Hypothesis Forks", () => {
  const { engine, now } = makeMemoryFixture();
  const watchdog = new WatchdogService({ engine });

  // 1) Explicit participant policy without Claude blocks claude-code dispatch while keeping codex + antigravity active
  engine.syncPolicy({
    controlsText: "# Research Controls\nParticipants: codex, antigravity\nPreserve core causal loop.",
    routerMode: "observe",
  });
  assert.deepEqual(engine.getCurrentPolicy().allowedPeers, ["antigravity", "codex"]);
  assert.throws(
    () =>
      engine.createTask({
        taskId: "unsolicited-claude",
        fromAgent: "codex",
        assignedTo: "claude-code",
        prompt: "Draft mechanism",
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.PEER_DISALLOWED
  );

  // Once user explicitly declares Claude in controls.md, claude-code becomes available immediately
  engine.syncPolicy({
    controlsText: "# Research Controls\nParticipants: codex, antigravity\n启用 Claude 参与机制深化。",
    routerMode: "observe",
  });
  assert.deepEqual(engine.getCurrentPolicy().allowedPeers, ["antigravity", "claude-code", "codex"]);

  // 2) Multi-round discussion with genuine epistemic deltas does NOT trip the L2 spin fuse even across 3+ rounds
  const debateTask = engine.createTask({
    taskId: "debate-task-1",
    fromAgent: "codex",
    assignedTo: "antigravity",
    prompt: "Evaluate non-stationary operator convergence",
    protocolVersion: 2,
    contract: {
      objective: "Settle convergence condition or fork hypotheses",
      allowedContinuation: ["tier1_diagnostic"],
    },
  });

  engine.sendMessage({
    fromAgent: "antigravity",
    toAgent: "codex",
    taskId: "debate-task-1",
    content: "Round 1: Unpacked implicit conditioning in Eq (3); shifted tension to trace remainder.",
    metadata: { disputeRound: 1, epistemicDelta: "clarified_conditioning_shifted_to_trace_remainder" },
  });
  engine.sendMessage({
    fromAgent: "codex",
    toAgent: "antigravity",
    taskId: "debate-task-1",
    content: "Round 2: Derived spectral bound showing remainder scales as O(r/T); see record #7.",
    metadata: { disputeRound: 2, sourceRecordIds: ["7"] },
  });
  engine.sendMessage({
    fromAgent: "antigravity",
    toAgent: "codex",
    taskId: "debate-task-1",
    content: "Round 3: Counterexample under heavy-tailed drift logged in Tier-1 baseline check.",
    metadata: { disputeRound: 3, diagnosticRef: "logs/tier1_spectrum.json" },
  });

  let sweep = watchdog.runSweep({ nowMs: now() });
  assert.equal(sweep.l2Alerts.filter((a) => a.kind === "zero_epistemic_delta_spin").length, 0);

  // 3) Two consecutive zero-delta verbal turns trip the zero_epistemic_delta_spin L2 fuse
  engine.sendMessage({
    fromAgent: "codex",
    toAgent: "antigravity",
    taskId: "debate-task-1",
    content: "In practice neural networks usually smooth out heavy tails.",
    metadata: { disputeRound: 4, epistemicDelta: "none" },
  });
  engine.sendMessage({
    fromAgent: "antigravity",
    toAgent: "codex",
    taskId: "debate-task-1",
    content: "I still disagree that smoothing is sufficient without further justification.",
    metadata: { disputeRound: 5, epistemicDelta: false },
  });

  sweep = watchdog.runSweep({ nowMs: now() + 1000 });
  const spin = sweep.l2Alerts.find((a) => a.kind === "zero_epistemic_delta_spin");
  assert.ok(spin);
  assert.equal(spin.consecutiveTurns, 2);
  assert.match(spin.summary, /Controlled Hypothesis Fork/);

  // 4) Controlled two-branch Hypothesis Fork is persisted cleanly via workflow v2 receipt
  engine.submitTaskReceipt({
    taskId: "debate-task-1",
    actorAgent: "antigravity",
    receiptId: "rcpt-fork-1",
    attemptId: "att-1",
    contractVersion: debateTask.metadata.workflow.contract.version,
    ownerEpoch: 1,
    outcome: "progress",
    summary: "Recorded two-branch controlled fork pending real-scale evaluation",
    hypothesisForks: [
      {
        branchId: "H-A",
        hypothesis: "Isotropic natural step suffices when feature rank <= 32",
        discriminativeCheck: "Measure empirical Fisher condition number on 1k real trajectories",
      },
      {
        branchId: "H-B",
        hypothesis: "Low-rank metric projection is required to prevent tail blowup",
        discriminativeCheck: "Compare tail 99th-percentile TD error on matched compute budget",
      },
    ],
  });

  const updated = engine.getTaskById("debate-task-1");
  assert.equal(updated.metadata.workflow.hypothesisForks.length, 2);
  assert.equal(updated.metadata.workflow.hypothesisForks[0].branchId, "H-A");
});

test("15. L0-L4 effort/risk cognitive profile preservation and recordValidation jitGuidance escalation", () => {
  const resolved = resolveCognitiveProfile({
    cognitiveProfile: {
      stance: "deductive_auditor",
      effortTier: "xhigh",
      riskLevel: "L3",
    },
  });
  assert.deepEqual(resolved, {
    stance: "deductive_auditor",
    adapter: null,
    auditTrack: null,
    effortTier: "xhigh",
    riskLevel: "L3",
  });

  const { engine } = makeMemoryFixture();
  engine.createTask({
    taskId: "jit-val-task",
    fromAgent: "codex",
    assignedTo: "antigravity",
    prompt: "Verify internal operator fix",
  });

  const firstFail = engine.recordValidation({
    taskId: "jit-val-task",
    validatorAgent: "codex",
    passed: false,
    summary: "First failure on tail boundary",
    notifyAssignee: false,
  });
  assert.equal(firstFail.jitGuidance, undefined);

  const secondFail = engine.recordValidation({
    taskId: "jit-val-task",
    validatorAgent: "codex",
    passed: false,
    summary: "Second consecutive failure",
    notifyAssignee: false,
  });
  assert.ok(secondFail.jitGuidance);
  assert.equal(secondFail.jitGuidance.recommendedEffort, "high");
  assert.equal(secondFail.jitGuidance.consecutiveFailures, 2);
  assert.ok(secondFail.jitGuidance.checklist.some((line) => /endogenous/i.test(line)));

  // Patch count >= 2 with pending/failed validation also triggers guidance
  engine.createTask({
    taskId: "jit-patch-task",
    fromAgent: "codex",
    assignedTo: "antigravity",
    prompt: "Patch loop test",
  });
  engine.submitPatch({
    patchId: "jit-patch-1",
    taskId: "jit-patch-task",
    fromAgent: "antigravity",
    toAgent: "codex",
    rawContent: "--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-a\n+b\n",
    targetFiles: ["src/a.py"],
    summary: "Patch 1",
  });
  engine.submitPatch({
    patchId: "jit-patch-2",
    taskId: "jit-patch-task",
    fromAgent: "antigravity",
    toAgent: "codex",
    rawContent: "--- a/src/b.py\n+++ b/src/b.py\n@@ -1 +1 @@\n-a\n+b\n",
    targetFiles: ["src/b.py"],
    summary: "Patch 2",
  });
  const patchFail1 = engine.recordValidation({
    taskId: "jit-patch-task",
    validatorAgent: "codex",
    passed: false,
    summary: "Still failing after 2 patches (first validation)",
    notifyAssignee: false,
  });
  assert.ok(patchFail1.jitGuidance);
  assert.equal(patchFail1.jitGuidance.recommendedEffort, "high");
  assert.equal(patchFail1.jitGuidance.patchCount, 2);
  assert.ok(patchFail1.jitGuidance.checklist.some((line) => /Two-Patch Escape Law/i.test(line)));

  const patchFail2 = engine.recordValidation({
    taskId: "jit-patch-task",
    validatorAgent: "codex",
    passed: false,
    summary: "Second failure after 2 patches",
    notifyAssignee: false,
  });
  assert.ok(patchFail2.jitGuidance);
  assert.equal(patchFail2.jitGuidance.recommendedEffort, "xhigh");
});

test("Task reuse permission compatibility handles derived root commands & rejects escalation", () => {
  const { engine } = makeMemoryFixture();
  const repoRoot = "/tmp/synthetic-research-repo";

  engine.createTask({
    taskId: "reuse-compat-task",
    fromAgent: "codex",
    assignedTo: "antigravity",
    cwd: repoRoot,
    prompt: "Read-only evidence task",
    requiredModel: "synthetic-model",
    permissions: {
      mcpTools: ["bridge_claim_task", "bridge_send_message"],
      readRoots: [repoRoot],
      writeRoots: [],
      allowedCommands: ["rg", "cat", "sed", `find ${repoRoot} -type f`],
      forbiddenOperations: ["ssh", "local_tests"],
    },
    metadata: { deliveryMode: "read_only" },
  });

  // Same explicit caller allowedCommands (without derived `find ... -type f`), reordered/trailing slash cwd
  const reusedRaw = engine.createTask({
    taskId: "reuse-compat-task",
    fromAgent: "codex",
    assignedTo: "antigravity",
    cwd: `${repoRoot}/`,
    requiredModel: "synthetic-model",
    permissions: {
      readRoots: [repoRoot],
      writeRoots: [],
      allowedCommands: ["sed", "cat", "rg", "rg"],
      forbiddenOperations: ["local_tests", "ssh"],
    },
    metadata: { deliveryMode: "read_only" },
  });
  assert.equal(reusedRaw.id, "reuse-compat-task");

  // Escalating allowedCommands must still throw TASK_SCOPE_CONFLICT
  assert.throws(
    () =>
      engine.createTask({
        taskId: "reuse-compat-task",
        fromAgent: "codex",
        assignedTo: "antigravity",
        permissions: {
          readRoots: [repoRoot],
          writeRoots: [],
          allowedCommands: ["rg", "cat", "sed", "python3 train.py"],
        },
        metadata: { deliveryMode: "read_only" },
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.TASK_SCOPE_CONFLICT
  );

  // Dropping an explicit command or mutating readRoots/forbiddenOperations must still throw TASK_SCOPE_CONFLICT
  assert.throws(
    () =>
      engine.createTask({
        taskId: "reuse-compat-task",
        permissions: {
          readRoots: [repoRoot],
          writeRoots: [],
          allowedCommands: ["rg", "cat"],
        },
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.TASK_SCOPE_CONFLICT
  );
  assert.throws(
    () =>
      engine.createTask({
        taskId: "reuse-compat-task",
        permissions: { readRoots: ["/tmp/other-repo"], writeRoots: [] },
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.TASK_SCOPE_CONFLICT
  );
  assert.throws(
    () =>
      engine.createTask({
        taskId: "reuse-compat-task",
        permissions: { forbiddenOperations: ["ssh"] },
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.TASK_SCOPE_CONFLICT
  );
});

test("16. Runtime intake lint guards: negation stripping, channels, carbon/luna roles, writeLocks, synthetic/fallback & claim binding", () => {
  const { engine } = makeMemoryFixture();
  engine.syncPolicy({
    controlsText: "# Controls\nforbid_claude_code: true\nstrict_write_locks: true\n禁止使用合成环境、toy benchmark、fallback、兜底、staged release。",
    routerMode: "observe",
  });

  // 1) Quoted negative controls must NOT false-positive
  assert.equal(
    stripNegatedProhibitionLines("禁止使用合成环境。禁止做兜底。Verify real solver convergence."),
    "Verify real solver convergence."
  );
  const cleanTask = engine.createTask({
    taskId: "clean-endogenous-task",
    fromAgent: "codex",
    assignedTo: "codex",
    requiredModel: "gpt-6-sol",
    cwd: "/tmp/proj",
    permissions: { writeRoots: ["src/solver"] },
    prompt: "禁止使用合成环境、mock checkpoint 或 fallback wrapper。Implement exact endogenous operator update.",
  });
  assert.equal(cleanTask.id, "clean-endogenous-task");

  // 2) Overlapping writeRoots across active tasks fails deterministically
  assert.throws(
    () =>
      engine.createTask({
        taskId: "overlapping-writer",
        fromAgent: "codex",
        assignedTo: "codex",
        requiredModel: "gpt-6-astra",
        cwd: "/tmp/proj",
        permissions: { writeRoots: ["src/solver/step.py"] },
        prompt: "Refactor step.py",
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.WRITE_ROOT_CONFLICT
  );

  // 3) Mixed prohibition + positive violation catches ONLY the positive violation
  assert.throws(
    () =>
      engine.createTask({
        taskId: "bad-synthetic",
        fromAgent: "codex",
        assignedTo: "codex",
        requiredModel: "gpt-6-sol",
        prompt: "禁止使用合成数据；Use mock checkpoint to speed up verification.",
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.SYNTHETIC_FIXTURE_FORBIDDEN
  );

  assert.throws(
    () =>
      engine.createTask({
        taskId: "bad-fallback",
        fromAgent: "codex",
        assignedTo: "codex",
        requiredModel: "gpt-6-sol",
        prompt: "实现启发式门控并添加一个兜底分支来保底输出。",
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.FALLBACK_DESIGN_FORBIDDEN
  );

  // 4) Model-channel & model-role topology guards
  assert.equal(inferModelAdapter({ requiredModel: "gpt-6-astra" }), "gpt_contract");
  assert.equal(
    resolveCognitiveProfile({ requiredModel: "gpt-6-astra", cognitiveProfile: { stance: "deductive_auditor" } }).adapter,
    "gpt_contract"
  );
  assert.throws(
    () =>
      engine.createTask({
        taskId: "bad-channel-pi",
        fromAgent: "codex",
        assignedTo: "codex",
        requiredModel: "gemini-carbon-high",
        metadata: { provider: "pi" },
        prompt: "Audit long horizon context",
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.MODEL_CHANNEL_MISMATCH
  );
  assert.throws(
    () =>
      engine.createTask({
        taskId: "bad-dyschop",
        fromAgent: "codex",
        assignedTo: "codex",
        requiredModel: "kimi-3.1-pro",
        metadata: { piProvider: "dyschop/kimi-k2" },
        prompt: "Analyze paper metrics",
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.MODEL_CHANNEL_MISMATCH
  );
  assert.throws(
    () =>
      engine.createTask({
        taskId: "bad-carbon-review",
        fromAgent: "codex",
        assignedTo: "antigravity",
        requiredModel: "gemini-carbon-high",
        metadata: { isolationProfile: "blind_review", role: "blind_review" },
        prompt: "Independent formal falsification",
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.MODEL_ROLE_MISMATCH
  );
  assert.throws(
    () =>
      engine.createTask({
        taskId: "bad-luna-write",
        fromAgent: "codex",
        assignedTo: "codex",
        requiredModel: "gpt-6-luna",
        permissions: { writeRoots: ["src/new"] },
        prompt: "Edit solver",
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.MODEL_ROLE_MISMATCH
  );

  // 5) Coordinator non-coding boundary & Web Pro SHA ceremony skip
  assert.throws(
    () =>
      engine.createTask({
        taskId: "bad-coord-write",
        fromAgent: "codex",
        assignedTo: "codex",
        requiredModel: "gpt-6-sol",
        metadata: { role: "coordinator" },
        permissions: { writeRoots: ["src/new"] },
        prompt: "Edit source directly",
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.COORDINATOR_CODING_FORBIDDEN
  );
  assert.throws(
    () =>
      engine.createTask({
        taskId: "bad-pro-sha",
        fromAgent: "codex",
        assignedTo: "codex",
        requiredModel: "gpt-5.4-pro",
        metadata: { proGrounding: { channel: "upload_bundle", requireSha256: true } },
        prompt: "Evaluate overarching theorem.",
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.PRO_SHA_CEREMONY_SKIPPED
  );

  // 6) Experiment claim binding & self-only ablation
  assert.throws(
    () =>
      engine.createTask({
        taskId: "bad-exp-no-claim",
        fromAgent: "codex",
        assignedTo: "codex",
        requiredModel: "gpt-6-sol",
        metadata: { taskKind: "experiment" },
        prompt: "Run real benchmark evaluation.",
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.CLAIM_BINDING_REQUIRED
  );
  assert.throws(
    () =>
      engine.createTask({
        taskId: "bad-ablation-baseline",
        fromAgent: "codex",
        assignedTo: "codex",
        requiredModel: "gpt-6-sol",
        metadata: { taskKind: "ablation", claimIds: ["C2"], experimentSpec: { isAblation: true, modifiesBaseline: true } },
        prompt: "Verify C2 ablation component.",
      }),
    (err) => err instanceof BridgeUserError && err.code === REASONS.CLAIM_BINDING_REQUIRED
  );
  const validExp = engine.createTask({
    taskId: "good-exp-claim",
    fromAgent: "codex",
    assignedTo: "codex",
    requiredModel: "gpt-6-sol",
    metadata: { taskKind: "ablation", claimIds: ["C2"], experimentSpec: { isAblation: true, modifiesBaseline: false } },
    prompt: "Verify C2 ablation removing endogenous prior only.",
  });
  assert.equal(validExp.id, "good-exp-claim");
});

test("17. Preflight command guards, Agy deny rules, and GPU free-VRAM placement", () => {
  const preflight = runTaskPreflight({
    runtime: "codex-cli",
    cwd: process.cwd(),
    deliveryMode: "read_only",
    permissions: {
      readRoots: ["."],
      writeRoots: [],
      allowedCommands: ["pytest tests/", "git push origin main"],
      forbiddenOperations: ["local_tests", "git_push"],
    },
  });
  assert.equal(preflight.ok, false);
  assert.equal(preflight.incompatibleCommands.length, 2);

  const agy = buildAgySessionSettings({
    cwd: process.cwd(),
    deliveryMode: "read_only",
    forbiddenOperations: ["ssh", "local_tests", "git_push", "claude-code"],
  });
  assert.ok(agy.permissions.deny.includes("command(pytest)"));
  assert.ok(agy.permissions.deny.includes("command(git push)"));
  assert.ok(!agy.permissions.allow.includes("mcp(cro_claude_code/*)"));

  const placement = evaluateGpuPlacement({
    gpus: [
      { index: 0, freeMb: 80000, faulty: true },
      { index: 1, freeMb: 12000 },
      { index: 2, freeMb: 28000 },
    ],
    requiredVramMb: 20000,
    safetyMarginMb: 4096,
  });
  assert.equal(placement.schedulable, true);
  assert.equal(placement.selectedGpu.index, 2);
});

import { coordinatorBinding, memberBinding, notifyWorkBoardPost } from "./member-transport.mjs";
import { recordWorkBoardEntry, saveRun, transactWorkRun, workRunOverview } from "./work-run.mjs";

const MAIN = { name: "main", archived: false, subscriptions: {} };
const BATCH_SIZE = 128;
const CLOSED_TASKS = new Set(["completed", "cancelled", "failed"]);

function channelsOf(run) {
  return [MAIN, ...(run.boardChannels ?? [])];
}

function access(engine, args) {
  const task = engine.repos.getTask(args.taskId);
  const run = task?.metadata?.workRun;
  if (!run || run.runId !== args.runId || !args.actorAgent || !args.actorSessionId) {
    throw new Error("Work board unavailable to this session");
  }
  const matches = member => member?.agent === args.actorAgent && member.conversationId === args.actorSessionId;
  const lead = coordinatorBinding(engine, task, run);
  const isLead = matches(lead);
  const named = run.members.find(member => matches(member) && !member.retiredAt);
  const member = isLead ? lead : named && memberBinding(engine, task, run, named);
  if (!member || (run.evidenceUnlocked === false && named &&
      run.steps.some(step => step.kind === "independent" && step.memberId === named.memberId))) {
    throw new Error("Work board unavailable to this session");
  }
  return { task, run, member, named, isLead };
}

function assertOpen(context) {
  if (context.run.evidenceUnlocked === false) throw new Error("Work board messages require the independent evidence to be unlocked");
  if (CLOSED_TASKS.has(context.task.status) || context.run.status === "completed") throw new Error("The work run is closed");
}

function getChannel(run, name) {
  const channel = channelsOf(run).find(item => item.name === name);
  if (!channel) throw new Error(`Unknown work board channel: ${name}`);
  return channel;
}

function subscribed(channel, context) {
  return channel.name === "main" || context.isLead || Object.hasOwn(channel.subscriptions, context.member.memberId);
}

export function workBoardStatus(engine, args) {
  const context = access(engine, args);
  const { task, run, member, named, isLead } = context;
  const { boardChannels, ...overview } = workRunOverview(engine, task, args);
  return {
    memberId: member.memberId, isLead, initialSince: named?.joinedAfterSeq ?? 0,
    channels: channelsOf(run).filter(channel => subscribed(channel, context)).map(channel => ({
      name: channel.name, archived: channel.archived, memberIds: channel.name === "main"
        ? run.members.filter(item => !item.retiredAt).map(item => item.memberId)
        : Object.keys(channel.subscriptions),
    })),
    run: { ...overview, steps: overview.steps.map(({ inputPacket, ...step }) => step) },
  };
}

function entriesAfter(engine, taskId, since, through) {
  return engine.repos.listTaskEvents({ taskId, kind: "work_board_entry", afterSeq: since, limit: BATCH_SIZE, orderDesc: false })
    .filter(event => event.seq <= through);
}

function addressed(entry, context) {
  const addresses = [context.member.memberId, context.named?.memberId];
  return entry.toMemberIds.some(id => addresses.includes(id));
}

function visible(entry, context, channelFilter) {
  if (entry.type === "user_instruction" && !context.isLead) return false;
  if (channelFilter && channelFilter.name !== entry.channel) return false;
  const channel = getChannel(context.run, entry.channel);
  return addressed(entry, context) || (subscribed(channel, context) && (!context.named || context.isLead ||
    channel.name === "main" || channelFilter || entry.seq > channel.subscriptions[context.named.memberId]));
}

function actionable(entry, context) {
  if (entry.type === "step_ready") return context.run.steps.some(step => step.stepId === entry.stepId &&
    step.version === entry.stepVersion && step.status === "ready");
  if (entry.type === "binding_needed") return context.run.steps.some(step => step.stepId === entry.stepId &&
    step.version === entry.stepVersion && step.status === "pending_binding");
  if (entry.type === "acceptance_ready") return context.run.status === "awaiting_acceptance" && entry.runVersion === context.run.version;
  if (entry.type === "handoff_lead") return entry.memberId === context.run.leadMemberId;
  return true;
}

function cursorInput(args) {
  const since = args.since ?? 0;
  const limit = args.limit ?? 50;
  if (!Number.isSafeInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Board reads require a nonnegative since sequence and a limit from 1 to 100");
  }
  return { since, limit };
}

function readBoard(engine, args, waiting) {
  const snapshotSeq = engine.repos.getCurrentSeq();
  const context = access(engine, args);
  if (context.run.evidenceUnlocked === false) throw new Error("Work board messages require the independent evidence to be unlocked");
  const { since, limit } = cursorInput(args);
  if (since > snapshotSeq) throw new Error("Board since is beyond the current run event sequence");
  const channel = args.channel == null ? null : getChannel(context.run, args.channel);
  if (channel && !subscribed(channel, context)) throw new Error("Work board channel unavailable to this session");
  const entries = [];
  let nextScan = since;
  let matched = false;
  let batch;
  do {
    batch = entriesAfter(engine, context.task.id, nextScan, snapshotSeq);
    for (const { payload, seq, createdAt } of batch) {
      nextScan = seq;
      const entry = { ...payload, seq, createdAt };
      if (!visible(entry, context, channel)) continue;
      if (entries.length <= limit) entries.push(entry);
      if (actionable(entry, context) && (args.mentionsOnly === false || addressed(entry, context)) &&
          (entry.type !== "post" || entry.fromMemberId !== context.member.memberId)) matched = true;
      if (entries.length > limit && (!waiting || matched)) break;
    }
  } while (batch.length === BATCH_SIZE && (entries.length <= limit || (waiting && !matched)));
  const hasMore = entries.length > limit;
  if (hasMore) entries.pop();
  const closed = context.run.status === "completed" || CLOSED_TASKS.has(context.task.status);
  return { entries, nextSince: entries.at(-1)?.seq ?? since, hasMore, matched, closed };
}

export function readWorkBoard(engine, args) {
  const { matched, ...page } = readBoard(engine, args, false);
  return page;
}

export async function waitForWorkBoard(engine, args, waitForChange) {
  const waitMs = args.waitMs ?? 15_000;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new Error("Board waitMs must be from 0 to 30000");
  const deadline = Date.now() + waitMs;
  while (true) {
    const page = readBoard(engine, args, true);
    const remaining = deadline - Date.now();
    if (page.matched || page.closed) return { ...page, timedOut: false };
    if (remaining <= 0) return { ...page, timedOut: true };
    await waitForChange(Math.min(remaining, 350));
  }
}

export function postWorkBoard(engine, args) {
  return transactWorkRun(engine, args, "work_board_post", args.eventId, task => {
    const context = access(engine, args);
    assertOpen(context);
    const { run, member } = context;
    const channel = getChannel(run, args.channel ?? "main");
    if (channel.archived || !subscribed(channel, context)) throw new Error("Work board channel unavailable for posting");
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text || Buffer.byteLength(text) > 16 * 1024) throw new Error("Board text must be nonempty and at most 16 KiB");
    const toMemberIds = [...new Set(args.toMemberIds ?? [])];
    const recipients = toMemberIds.map(id => {
      if (id === "@coordinator") return coordinatorBinding(engine, task, run);
      const named = run.members.find(item => item.memberId === id);
      return named && memberBinding(engine, task, run, named);
    });
    const identities = recipients.map(recipient => recipient && JSON.stringify([recipient.agent, recipient.conversationId]));
    if (recipients.some(recipient => !recipient ||
        (recipient.agent === member.agent && recipient.conversationId === member.conversationId)) ||
        new Set(identities).size !== identities.length) {
      throw new Error("Board recipients must identify distinct active sessions other than the sender");
    }
    const entry = recordWorkBoardEntry(engine, task, JSON.stringify(["post", args.eventId]), {
      type: "post", channel: channel.name, fromMemberId: member.memberId, toMemberIds, text,
    });
    for (const recipient of recipients) notifyWorkBoardPost(engine, { task, run, sender: member, recipient, seq: entry.seq });
    return { seq: entry.seq, runId: run.runId, notified: toMemberIds };
  });
}

export function changeWorkBoardChannel(engine, args) {
  return transactWorkRun(engine, args, "work_board_channel", args.eventId, task => {
    const context = access(engine, args);
    assertOpen(context);
    if (!context.isLead) throw new Error("Only the current bound lead can manage work board channels");
    const run = structuredClone(context.run);
    const name = args.channel;
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(name) || name === "main") {
      throw new Error("Channel names must use lowercase letters, digits or hyphens, and main is reserved");
    }
    run.boardChannels ??= [];
    if (args.action === "create_channel") {
      if (run.boardChannels.some(channel => channel.name === name)) throw new Error(`Channel already exists: ${name}`);
      run.boardChannels.push({ name, archived: false, subscriptions: {} });
    } else {
      const channel = getChannel(run, name);
      if (channel.archived) throw new Error("Archived channels cannot be changed");
      if (args.action === "archive_channel") {
        channel.archived = true;
      } else {
        const member = run.members.find(item => item.memberId === args.memberId);
        if (!member || !memberBinding(engine, task, run, member)) throw new Error("A channel subscription requires an active bound member");
        if (args.action === "subscribe") {
          if (!Object.hasOwn(channel.subscriptions, member.memberId)) {
            Object.defineProperty(channel.subscriptions, member.memberId, { enumerable: true, configurable: true,
              writable: true, value: engine.repos.nextSeq() });
          }
        } else if (args.action === "unsubscribe") {
          delete channel.subscriptions[member.memberId];
        } else {
          throw new Error("Unknown channel action");
        }
      }
    }
    saveRun(engine, task, run);
    return { runId: run.runId, channel: name, action: args.action };
  });
}

import { changeWorkRun } from "../domain/work-run.mjs";
import {
  changeWorkBoardChannel, postWorkBoard, readWorkBoard, waitForWorkBoard, workBoardStatus,
} from "../domain/work-board.mjs";

const runChanges = ["add_member", "bind_member", "add_track", "retire_member", "reassign_track", "handoff_lead"];
const channelChanges = ["create_channel", "subscribe", "unsubscribe", "archive_channel"];
const identifier = { type: "string", minLength: 1 };
const identifiers = { type: "array", items: identifier };
const version = { type: "integer", minimum: 1 };

export function registerWorkBoardTools(registerBridgeTool, bridgeDb, actor) {
  registerBridgeTool({
    name: "bridge_work_board",
    description: "Read, wait on, or post to a run board. Address only the next actor using toMemberIds. The lead can bind existing tasks, add tracks, manage channels, and transfer lead authority.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["action", "taskId", "runId"],
      properties: {
        action: { type: "string", enum: ["status", "read", "wait", "post", ...channelChanges, ...runChanges] },
        taskId: identifier, runId: identifier, eventId: identifier, runVersion: version,
        channel: identifier, since: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 },
        waitMs: { type: "integer", minimum: 0, maximum: 30_000 }, mentionsOnly: { type: "boolean" },
        text: identifier, toMemberIds: identifiers,
        memberId: identifier, conversationId: identifier, memberTaskId: identifier,
        stepId: identifier, stepVersion: version, writeRoots: identifiers,
        member: { type: "object", additionalProperties: false, required: ["agent", "conversationId", "taskId"], properties: {
          memberId: identifier, agent: { type: "string", enum: ["codex", "antigravity", "claude-code"] },
          conversationId: identifier, taskId: identifier, role: identifier,
        } },
        track: { type: "object", additionalProperties: false, required: ["stepId", "memberId"], properties: {
          stepId: identifier, memberId: identifier, taskId: identifier, description: identifier, brief: identifier,
          kind: { type: "string", enum: ["work", "synthesis", "challenge", "review", "milestone"] },
          dependsOn: identifiers, beforeStepIds: identifiers, requirementIds: identifiers, writeRoots: identifiers,
          boost: { type: "object", additionalProperties: false, required: ["reviewerMemberId"], properties: {
            reviewerMemberId: identifier, reviewerTaskId: identifier,
          } },
        } },
      },
    },
  }, async args => {
    const request = { ...args, ...actor };
    const { engine } = bridgeDb;
    switch (args.action) {
      case "status": return { ok: true, ...workBoardStatus(engine, request) };
      case "read": return { ok: true, ...readWorkBoard(engine, request) };
      case "wait": return { ok: true, ...await waitForWorkBoard(engine, request, ms => bridgeDb._waitForNextTickOrNotification(ms)) };
      case "post": return { ok: true, ...postWorkBoard(engine, request) };
      default: return { ok: true, ...(channelChanges.includes(args.action)
        ? changeWorkBoardChannel(engine, request) : changeWorkRun(engine, request)) };
    }
  });
}

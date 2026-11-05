import crypto from "node:crypto";

export const CONSUMPTION_GRACE_MS = 120_000;
export const PROCESSING_LEASE_MS = 600_000;
export const MAX_DELIVERY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [30_000, 120_000];

export function deliveryState(message) {
  return message?.metadata?.bridgeDelivery || {};
}

export function deliveryAttempts(message, targetSessionId) {
  const state = deliveryState(message);
  if (state.targetSessionId && state.targetSessionId !== targetSessionId) return 0;
  return state.targetSessionId === targetSessionId && state.attempts !== undefined
    ? Number(state.attempts) : Number(message?.delivery_attempts || 0);
}

export function retryDue(message, targetSessionId, nowMs) {
  if (deliveryAttempts(message, targetSessionId) >= MAX_DELIVERY_ATTEMPTS) return false;
  const deadline = Date.parse(deliveryState(message).retryAt || "");
  return !Number.isFinite(deadline) || nowMs >= deadline;
}

export function notificationEnvelope(messages, targetSessionId) {
  const first = deliveryState(messages[0]);
  const id = first.targetSessionId === targetSessionId ? first.id : null;
  const selected = messages.filter((message) => {
    const state = deliveryState(message);
    const priorId = state.targetSessionId === targetSessionId ? state.id : null;
    return id ? priorId === id : !priorId;
  });
  return { id: id || crypto.randomUUID(), messages: selected };
}

export function beginDeliveryMetadata(message, envelope, targetSessionId, nowIso) {
  const previous = deliveryState(message);
  const state = previous.targetSessionId === targetSessionId ? previous : {};
  return { ...message.metadata, bridgeDelivery: {
    ...state, id: envelope.id, targetSessionId,
    attempts: deliveryAttempts(message, targetSessionId),
    attemptedAt: nowIso, retryAt: null,
  } };
}

export function finishDeliveryMetadata(message, targetSessionId, nowIso, delivered, receipt = null) {
  const state = deliveryState(message);
  const attempts = deliveryAttempts(message, targetSessionId) + 1;
  const delay = RETRY_DELAYS_MS[attempts - 1];
  const active = receipt?.turnStatus === "inProgress" || receipt?.turnStatus === "running" ||
    receipt?.method === "thread-follower-steer-turn";
  return { ...message.metadata, bridgeDelivery: {
    ...state, targetSessionId, attempts,
    retryAt: !delivered && delay !== undefined ? new Date(Date.parse(nowIso) + delay).toISOString() : null,
    processingUntil: delivered ? new Date(Date.parse(nowIso) +
      (active ? PROCESSING_LEASE_MS : CONSUMPTION_GRACE_MS)).toISOString() : null,
    acceptedAt: delivered ? nowIso : state.acceptedAt || null,
  } };
}

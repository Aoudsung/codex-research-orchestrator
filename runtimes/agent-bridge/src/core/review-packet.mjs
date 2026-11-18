import { BridgeUserError, REASONS, sha256Hex } from "../domain/model.mjs";

const ENTRY_LIMIT = 32;
const BYTE_LIMIT = 256 * 1024;
const ENTRY_KINDS = new Set(["definition", "evidence"]);

/** The coordinator supplies approved source excerpts inline. References are labels, never file reads. */
export function normalizeReviewPacket(value) {
  const invalid = (message) => {
    throw new BridgeUserError(REASONS.BLIND_ISOLATION_VIOLATION, message);
  };
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["entries", "schemaVersion", "digest"].includes(key)) ||
      (value.schemaVersion !== undefined && value.schemaVersion !== 1) ||
      !Array.isArray(value.entries) || value.entries.length > ENTRY_LIMIT) {
    invalid("An independent step requires a review packet with up to 32 approved source entries.");
  }
  const refs = new Set();
  const kinds = new Set();
  const entries = value.entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).some((key) => !["kind", "ref", "content"].includes(key)) ||
        !ENTRY_KINDS.has(entry.kind) || typeof entry.ref !== "string" || !entry.ref.trim() ||
        typeof entry.content !== "string" || !entry.content.trim()) {
      invalid("Each review packet entry requires a kind, source reference, and inline source text.");
    }
    const ref = entry.ref.trim();
    if (refs.has(ref)) invalid("Each source reference must appear only once in a review packet.");
    refs.add(ref);
    kinds.add(entry.kind);
    return Object.freeze({ kind: entry.kind, ref, content: entry.content });
  });
  if (kinds.size !== ENTRY_KINDS.size) invalid("A review packet requires both a definition and evidence.");
  const payload = JSON.stringify({ schemaVersion: 1, entries });
  if (Buffer.byteLength(payload) > BYTE_LIMIT) invalid("The review packet exceeds 256 KiB.");
  const digest = sha256Hex(payload);
  if (value.digest !== undefined && digest !== value.digest) invalid("The frozen review packet digest has changed.");
  return Object.freeze({ schemaVersion: 1, entries: Object.freeze(entries), digest });
}

export function renderReviewPacket(packet) {
  return JSON.stringify({ entries: packet.entries });
}

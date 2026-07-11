// Shared signing helpers for P2P wire messages (character catalog posts,
// ...), built on the ported tc-storage DID identity (see
// src/crypto/didIdentity.ts). A wire's `fromId` *is* the sender's did:key,
// and `signature` covers every other field, so a receiver can reject
// impersonated or tampered wires before they ever reach UI state or
// localStorage.
import {
  ensureDidIdentity,
  isEd25519DidKey,
  signStringWithDidIdentity,
  verifyStringWithDid,
} from "../crypto/didIdentity";

// Mirrors tc-storage's p2pEnvelope.ts stableStringify(): deterministic,
// key-sorted JSON with undefined fields dropped.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function signingPayload(wire: Record<string, unknown>): string {
  const unsigned = { ...wire };
  delete unsigned.signature;
  return stableStringify(unsigned);
}

/** Signs every field of `fields` (except `signature`) with the local DID identity. */
export async function signWireFields(
  fields: Record<string, unknown> & { fromId: string },
): Promise<string> {
  const identity = await ensureDidIdentity();
  if (identity.did !== fields.fromId) {
    throw new Error("wire fromId does not match the local DID identity");
  }
  return signStringWithDidIdentity(identity, signingPayload(fields));
}

/** Verifies `wire.signature` against every other field, keyed by `wire.fromId`. */
export async function verifyWire(
  wire: Record<string, unknown> & { fromId?: unknown; signature?: unknown },
): Promise<boolean> {
  if (typeof wire.fromId !== "string" || typeof wire.signature !== "string") return false;
  if (!isEd25519DidKey(wire.fromId)) return false;
  try {
    return await verifyStringWithDid(wire.fromId, signingPayload(wire), wire.signature);
  } catch {
    return false;
  }
}

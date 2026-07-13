// Thin singleton wrapper around the vendored mistlib-wasm build (see
// scripts/fetch-mistlib.mjs). mistlib-wasm only supports one active
// MistNode per page (see wrappers/web/index.js: it throws if a second
// MistNode instance calls init() while another is still active, and a
// node's own parameterless leaveRoom() fully deinitializes it), and its
// node.onEvent()/onMediaEvent() each accept a single handler that replaces
// any previous one — so this module owns the one real MistNode instance and
// re-broadcasts events to any number of listeners registered via
// subscribeEvent()/subscribeMediaEvent().
//
// tc-town already had a second MistNode-creating code path — src/lib/network.ts's
// @tik-choco/mistai integration (LLM Network consumer/provider) — before this
// module existed. network.ts's `createMistNode` factory now returns a
// MistNodeLike adapter onto the singleton owned here instead of constructing
// its own MistNode, so the whole app only ever has one real node. See
// network.ts for that adapter.

import {
  MistNode,
  EVENT_RAW,
  storage_add,
  storage_get,
  storage_kv_set,
  storage_kv_get,
  storage_kv_delete,
  type MediaEventPayload,
} from "../vendor/mistlib/wrappers/web/index.js";

export {
  EVENT_NEIGHBORS,
  EVENT_PEER_CONNECTED,
  EVENT_PEER_DISCONNECTED,
  MEDIA_EVENT_TRACK_ADDED,
  MEDIA_EVENT_TRACK_REMOVED,
  DELIVERY_RELIABLE,
  DELIVERY_UNRELIABLE,
} from "../vendor/mistlib/wrappers/web/index.js";
export { EVENT_RAW, storage_add, storage_get, storage_kv_set, storage_kv_get, storage_kv_delete };
export type { MediaEventPayload };

import type { SharedStorageBackend } from "../crypto/didIdentity";

const SHARED_STORAGE_NAME = "tc-shared";

/**
 * Wraps mistlib's storage_add/storage_get as a SharedStorageBackend for
 * ensureSharedDidIdentity(). Must only be used after getNode() has resolved
 * (mistlib's wasm runtime needs to be initialized first).
 */
export function createMistStorageBackend(): SharedStorageBackend {
  return {
    store: (bytes) => storage_add(SHARED_STORAGE_NAME, bytes),
    retrieve: async (cid) => {
      try {
        return await storage_get(cid);
      } catch {
        return undefined;
      }
    },
  };
}

// Persistent id for this participant's mist node. This is the *pre-existing*
// key network.ts already used for its @tik-choco/mistai node id
// (`nodeIdStorageKey`) before mistClient.ts existed; reusing it here (rather
// than minting a new mistClient-local key) keeps the single shared MistNode's
// identity stable and consistent with whatever peers already know this
// browser profile as.
export const NODE_ID_STORAGE_KEY = "tc-town-mistai-node-id-v1";

export function localNodeId(): string {
  let id = localStorage.getItem(NODE_ID_STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(NODE_ID_STORAGE_KEY, id);
  }
  return id;
}

// roomId is the on-the-wire swarm topic — the raw room id, unmodified — the
// event arrived on, or "" for node-wide events. Subscribers use it to ignore
// traffic from rooms other than the one they're bound to — without it, a peer
// that has joined several rooms would mix every room's messages into whichever
// room it is currently viewing (see the per-hook roomId filters).
type EventListener = (eventType: number, fromId: string, payload: unknown, roomId: string) => void;
type MediaListener = (eventType: number, payload: MediaEventPayload) => void;

let node: InstanceType<typeof MistNode> | null = null;
let initPromise: Promise<InstanceType<typeof MistNode>> | null = null;
const eventListeners = new Set<EventListener>();
const mediaListeners = new Set<MediaListener>();

export async function getNode(): Promise<InstanceType<typeof MistNode>> {
  if (node) return node;
  if (!initPromise) {
    initPromise = (async () => {
      const n = new MistNode(localNodeId());
      await n.init();
      n.onEvent((eventType, fromId, payload, roomId) => {
        eventListeners.forEach((l) => l(eventType, fromId, payload, roomId ?? ""));
      });
      n.onMediaEvent((eventType, payload) => {
        mediaListeners.forEach((l) => l(eventType, payload));
      });
      node = n;
      return n;
    })();
  }
  return initPromise;
}

/** Returns an unsubscribe function. */
export function subscribeEvent(listener: EventListener): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

/** Returns an unsubscribe function. */
export function subscribeMediaEvent(listener: MediaListener): () => void {
  mediaListeners.add(listener);
  return () => mediaListeners.delete(listener);
}

export function decodeRawPayload(payload: unknown): unknown | null {
  try {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload as ArrayBuffer);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function isRawEvent(eventType: number): boolean {
  return eventType === EVENT_RAW;
}

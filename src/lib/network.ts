// App-side wiring for @tik-choco/mistai: injects the vendored mistlib node into
// the shared ConsumerClient (consume a shared LLM from a room) and re-exports
// the library's provider hook (share this app's configured LLM to a room),
// keeping a small function-style surface so SettingsView can drive connections
// and render status without knowing the library's internals. Also owns the
// Japanese localization of MistaiError codes (the library's messages are
// English).

import {
  ConsumerClient,
  MESSAGES_JA,
  formatMistaiError,
  type ChatMessage,
  type ConsumerStatus,
  type ConsumerStatusListener,
  type MistNodeLike,
} from "@tik-choco/mistai";
import {
  useNetworkProvider,
  type NetworkProviderPeer,
  type NetworkProviderStatus,
} from "@tik-choco/mistai/preact";
import { getNode, subscribeEvent, NODE_ID_STORAGE_KEY } from "./mistClient";

// Persistent id for this participant's mist node. Shared by the consumer
// client and the provider hook so both present the same identity on the
// room. Owned by mistClient.ts (see there); re-exported here under its
// historical name so existing importers (SettingsView.tsx) keep working.
export { NODE_ID_STORAGE_KEY };

type RealMistNode = Awaited<ReturnType<typeof getNode>>;

/**
 * MistNodeLike adapter around mistClient's shared singleton MistNode.
 *
 * mistlib-wasm allows only one active MistNode per page (see
 * src/lib/mistClient.ts's header comment), but @tik-choco/mistai's
 * `Network` class (used by both the LLM-network consumer and the provider
 * hook below) is designed to own a dedicated node per session: it calls
 * `createNode(nodeId)` itself on every join, sets the node's single
 * onEvent() handler, and tears the node down via leaveRoom() with no
 * arguments on disconnect. Handing it the shared node directly would let it
 * clobber mistClient's own event dispatcher and fully deinitialize the
 * shared node out from under any other feature using it (e.g. a future
 * character-catalog room joined via mistClient.getNode() directly).
 *
 * This adapter is what `createMistNode` (Network's `createNode` factory)
 * returns instead: a lightweight per-session object that
 *  - resolves the one real node via mistClient's getNode() (idempotent —
 *    only truly initializes it once, on first use across the whole app),
 *  - subscribes to mistClient's fan-out (subscribeEvent) rather than
 *    replacing the node's onEvent() handler, filtering to only the room
 *    this adapter joined,
 *  - leaves only its own room by always passing an explicit roomId to the
 *    real node's leaveRoom(), never the page-wide parameterless form.
 */
class SharedMistNode implements MistNodeLike {
  private realNode: RealMistNode | null = null;
  private roomId: string | null = null;
  private unsubscribe: (() => void) | null = null;

  async init(): Promise<void> {
    this.realNode = await getNode();
  }

  onEvent(handler: (eventType: number, fromId: string, payload: unknown) => void): void {
    this.unsubscribe?.();
    this.unsubscribe = subscribeEvent((eventType, fromId, payload, roomId) => {
      if (this.roomId !== null && roomId !== this.roomId) return;
      handler(eventType, fromId, payload);
    });
  }

  joinRoom(roomId: string): void {
    this.roomId = roomId;
    this.realNode?.joinRoom(roomId);
  }

  leaveRoom(): void {
    const roomId = this.roomId;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.roomId = null;
    // Explicit roomId only: the real node's parameterless leaveRoom() fully
    // deinitializes the shared node (see mistClient.ts), which would break
    // any other feature still using it.
    if (roomId) this.realNode?.leaveRoom(roomId);
  }

  sendMessage(toId: string | null | undefined, payload: Uint8Array, delivery?: number): void {
    this.realNode?.sendMessage(toId, payload, delivery, this.roomId ?? undefined);
  }
}

/**
 * Factory the shared ConsumerClient / provider hook use to build a mist
 * node. The incoming `nodeId` is intentionally unused: the real shared
 * node's identity is fixed by mistClient's localNodeId(), which reads the
 * same `NODE_ID_STORAGE_KEY` this factory's callers resolve `nodeId` from,
 * so the ids always agree.
 */
export function createMistNode(_nodeId: string): MistNodeLike {
  return new SharedMistNode();
}

// ---------------------------------------------------------------------------
// Consumer side — a single long-lived client, keyed by room id internally.

export const networkClient = new ConsumerClient({
  createNode: createMistNode,
  nodeIdStorageKey: NODE_ID_STORAGE_KEY,
});

export type { ConsumerStatus, ConsumerStatusListener, NetworkProviderPeer, NetworkProviderStatus };
export { useNetworkProvider };

/** Subscribes to consumer connection status changes. Returns an unsubscribe function. */
export function onConsumerStatusChange(listener: ConsumerStatusListener): () => void {
  return networkClient.onStatusChange(listener);
}

/** Current consumer connection status (idle/joining/searching/connected/error). */
export function consumerStatus(): ConsumerStatus {
  return networkClient.status;
}

/** Eagerly connects to the AI Network room; errors surface via status, never thrown. */
export function connectNetworkConsumer(roomId: string): Promise<void> {
  return networkClient.connect(roomId);
}

/** Tears down the active/pending consumer session and resets status to idle. */
export function disconnectNetworkConsumer(): void {
  networkClient.disconnect();
}

/** Sends a chat request over the AI Network room and resolves with the full reply text. */
export function requestNetworkChat(
  roomId: string,
  messages: ChatMessage[],
  model: string | undefined,
  onDelta?: (delta: string, full: string) => void,
): Promise<string> {
  return networkClient.requestChat(roomId, messages, { model, onDelta });
}

// ---------------------------------------------------------------------------
// Japanese localization rides the library's canonical MESSAGES_JA catalog so
// wording stays consistent with the other apps. This wrapper only pins the
// catalog choice; call sites keep the app-flavored name.

/**
 * User-facing Japanese message for any error coming out of a network (or
 * mixed network/API) code path. Non-MistaiError errors keep their own message.
 */
export function localizeNetworkError(err: unknown, fallback: string): string {
  return formatMistaiError(err, MESSAGES_JA, fallback);
}

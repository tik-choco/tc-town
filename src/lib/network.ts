// mistai owns multi-room membership and services; tc-town owns the one wasm node.
import { createRoomConsumers, createSharedNodeScope, MESSAGES_JA, formatMistaiError, type MistNodeLike } from '@tik-choco/mistai';
import { getNode, subscribeEvent, NODE_ID_STORAGE_KEY } from './mistClient';

const nodeScope = createSharedNodeScope(() => {
  let node: Awaited<ReturnType<typeof getNode>>;
  return {
    async init() { node = await getNode(); },
    onEvent(handler) { subscribeEvent(handler); },
    joinRoom(room) { return node.joinRoomAsync(room); },
    joinRoomAsync(room) { return node.joinRoomAsync(room); },
    leaveRoom(room) { if (room) node.leaveRoom(room); },
    sendMessage(to, payload, delivery, room) { node.sendMessage(to, payload, delivery, room); },
  } satisfies MistNodeLike;
});
export const rooms = createRoomConsumers(nodeScope, { nodeIdStorageKey: NODE_ID_STORAGE_KEY, requestTimeoutMs: 120_000, providerWaitTimeoutMs: 30_000 });
export function localizeNetworkError(error: unknown, fallback: string): string {
  return formatMistaiError(error, MESSAGES_JA, fallback);
}

export const EVENT_RAW: number;
export const EVENT_OVERLAY: number;
export const EVENT_NEIGHBORS: number;
export const EVENT_AOI_ENTERED: number;
export const EVENT_AOI_LEFT: number;
export const EVENT_PEER_CONNECTED: number;
export const EVENT_PEER_DISCONNECTED: number;
export const EVENT_AOI_NODES: number;
export const EVENT_ROOM_JOINED: number;
export const EVENT_ROOM_JOIN_FAILED: number;
export const EVENT_ROOM_LEFT: number;
export const MEDIA_EVENT_TRACK_ADDED: number;
export const MEDIA_EVENT_TRACK_REMOVED: number;
export const DELIVERY_RELIABLE: number;
export const DELIVERY_UNRELIABLE_ORDERED: number;
export const DELIVERY_UNRELIABLE: number;
export const DEFAULT_SIGNALING_URL: string;
export const DEFAULT_NOSTR_RELAY_URL: string;
export function defaultConfig(): Record<string, unknown>;

export function storage_add(name: string, data: Uint8Array): Promise<string>;
export function storage_get(rootCid: string): Promise<Uint8Array>;
export function storage_add_at(name: string, data: Uint8Array, x: number, y: number, z: number): Promise<string>;

export type DeliveryMethod =
    | typeof DELIVERY_RELIABLE
    | typeof DELIVERY_UNRELIABLE_ORDERED
    | typeof DELIVERY_UNRELIABLE;

export interface MediaEventPayload {
    fromId: string;
    trackId: string;
    kind: string;
    track: MediaStreamTrack;
    stream?: MediaStream;
}

export interface LocalTrackOptions {
    enabled?: boolean;
    publish?: boolean;
    stopPrevious?: boolean;
    prefix?: string;
}

export interface MistNodeOptions {
    signalingUrl?: string;
    config?: string | Record<string, unknown>;
    [key: string]: unknown;
}

export class MistNode {
    constructor(nodeId: string, signalingUrlOrOptions?: string | MistNodeOptions);

    init(): Promise<void>;
    onEvent(handler: (eventType: number, fromId: string, payload: unknown, roomId: string) => void): void;
    onRawMessage(handler: (fromId: string, payload: Uint8Array, roomId: string) => void): void;
    onMediaEvent(handler: (eventType: number, payload: MediaEventPayload) => void): void;
    onRemoteTrack(handler: (payload: MediaEventPayload) => void): void;

    joinRoom(roomId: string): void;
    joinRoomAsync(roomId: string): Promise<void>;
    isRoomJoined(roomId: string): boolean;
    leaveRoom(roomId?: string): void;
    updatePosition(x: number, y: number, z?: number, roomId?: string): void;

    getNeighbors(roomId?: string): unknown[];
    getAllNodes(roomId?: string): unknown[];
    getConfig(): Record<string, unknown>;
    setConfig(config: string | Record<string, unknown>): boolean;
    getStats(): Record<string, unknown>;

    sendMessage(
        toId: string | null | undefined,
        payload: Uint8Array | ArrayBuffer | string | Record<string, unknown>,
        delivery?: DeliveryMethod,
        roomId?: string,
    ): void;

    createLocalMedia(constraints?: MediaStreamConstraints): Promise<MediaStream>;
    createDisplayMedia(constraints?: DisplayMediaStreamOptions): Promise<MediaStream>;

    registerLocalTrack(
        trackId: string,
        track: MediaStreamTrack,
        options?: LocalTrackOptions,
    ): MediaStreamTrack;
    replaceLocalTrack(
        trackId: string,
        track: MediaStreamTrack,
        options?: LocalTrackOptions,
    ): MediaStreamTrack;
    getLocalTrack(trackId: string): MediaStreamTrack | null;
    publishLocalTrack(trackId: string): void;
    unpublishLocalTrack(trackId: string): void;
    removeLocalTrack(trackId: string): void;
    setLocalTrackEnabled(trackId: string, enabled: boolean): void;

    addLocalStream(
        stream: MediaStream,
        options?: LocalTrackOptions,
    ): Promise<Array<{ trackId: string; track: MediaStreamTrack }>>;

    attachMedia<T extends HTMLMediaElement>(
        element: T,
        trackOrStream: MediaStreamTrack | MediaStream,
    ): MediaStream;
}

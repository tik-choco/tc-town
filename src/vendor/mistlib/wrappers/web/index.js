import init, * as mistWasm from '../../pkg/mistlib_wasm.js';
import { DEFAULT_SIGNALING_URL, normalizeOptions } from './options.js';
export { DEFAULT_SIGNALING_URL, DEFAULT_NOSTR_RELAY_URL, defaultConfig } from './options.js';

const {
    init: mist_init,
    init_with_config: mist_init_with_config,
    update_position: mist_update_position,
    update_position_in_room: mist_update_position_in_room,
    get_neighbors: mist_get_neighbors,
    get_neighbors_in_room: mist_get_neighbors_in_room,
    get_all_nodes: mist_get_all_nodes,
    get_all_nodes_in_room: mist_get_all_nodes_in_room,
    join_room: mist_join_room,
    join_room_async: mist_join_room_async,
    is_room_joined: mist_is_room_joined,
    get_config: mist_get_config,
    set_config: mist_set_config,
    get_stats: mist_get_stats,
    send_message: mist_send_message,
    send_message_in_room: mist_send_message_in_room,
    leave_room: mist_leave_room,
    leave_room_id: mist_leave_room_id,
    register_event_callback: mist_register_event_callback,
    register_media_event_callback: mist_register_media_event_callback,
    register_local_track: mist_register_local_track,
    get_local_track: mist_get_local_track,
    publish_local_track: mist_publish_local_track,
    unpublish_local_track: mist_unpublish_local_track,
    remove_local_track: mist_remove_local_track,
    set_local_track_enabled: mist_set_local_track_enabled,
    storage_add: mist_storage_add,
    storage_get: mist_storage_get,
    storage_add_at: mist_storage_add_at,
} = mistWasm;

export const EVENT_RAW = 0;
export const EVENT_OVERLAY = 1;
export const EVENT_NEIGHBORS = 2;
export const EVENT_AOI_ENTERED = 3;
export const EVENT_AOI_LEFT = 4;
export const EVENT_PEER_CONNECTED = 5;
export const EVENT_PEER_DISCONNECTED = 6;
export const EVENT_AOI_NODES = 7;
export const EVENT_ROOM_JOINED = 8;
export const EVENT_ROOM_JOIN_FAILED = 9;
export const EVENT_ROOM_LEFT = 10;
export const MEDIA_EVENT_TRACK_ADDED = 100;
export const MEDIA_EVENT_TRACK_REMOVED = 101;
export const DELIVERY_RELIABLE = 0;
export const DELIVERY_UNRELIABLE_ORDERED = 1;
export const DELIVERY_UNRELIABLE = 2;
export const storage_add = mist_storage_add;
export const storage_get = mist_storage_get;
export const storage_add_at = mist_storage_add_at;

let activeNode = null;
let wasmInitPromise = null;

export class MistNode {
    constructor(nodeId, signalingUrl) {
        this.nodeId = nodeId;
        this.config = signalingUrl === undefined || (typeof signalingUrl === 'object' && signalingUrl !== null)
            ? normalizeOptions(signalingUrl)
            : null;
        this.signalingUrl = this.config?.signalingUrl ?? signalingUrl ?? DEFAULT_SIGNALING_URL;
        this.initialized = false;
        this._initPromise = null;
        this._onEvent = null;
        this._onMediaEvent = null;
    }

    async init() {
        if (this.initialized) return;
        if (this._initPromise) return this._initPromise;
        if (activeNode && activeNode !== this) {
            throw new Error("mistlib-wasm supports one active MistNode per page; call leaveRoom() before initializing another node.");
        }

        activeNode = this;
        this._initPromise = (async () => {
            if (!wasmInitPromise) {
                wasmInitPromise = init().catch((err) => {
                    wasmInitPromise = null;
                    throw err;
                });
            }
            await wasmInitPromise;
            if (this.config) {
                if (typeof mist_init_with_config !== 'function') {
                    throw new Error("mistlib-wasm init_with_config export is missing; rebuild mistlib-wasm/pkg before using options object initialization.");
                }
                const ok = mist_init_with_config(this.nodeId, JSON.stringify(this.config));
                if (!ok) {
                    throw new Error("mistlib-wasm rejected MistNode options.");
                }
            } else {
                mist_init(this.nodeId, this.signalingUrl);
            }
            mist_register_event_callback((eventType, fromId, payload, roomId) => {
                if (this._onEvent) {
                    this._onEvent(eventType, fromId, payload, roomId);
                }
            });
            mist_register_media_event_callback((eventType, fromId, trackId, kind, track, stream) => {
                if (this._onMediaEvent) {
                    this._onMediaEvent(eventType, {
                        fromId,
                        trackId,
                        kind,
                        track,
                        stream: stream ?? undefined,
                    });
                }
            });
            this.initialized = true;
        })();

        try {
            return await this._initPromise;
        } catch (err) {
            if (activeNode === this) {
                activeNode = null;
            }
            throw err;
        } finally {
            this._initPromise = null;
        }
    }

    onEvent(handler) {
        this._onEvent = handler;
    }

    onRawMessage(handler) {
        this._onEvent = (eventType, fromId, payload, roomId) => {
            if (eventType !== EVENT_RAW) return;
            const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
            handler(fromId, bytes, roomId);
        };
    }

    onMediaEvent(handler) {
        this._onMediaEvent = handler;
    }

    onRemoteTrack(handler) {
        this._onMediaEvent = (eventType, payload) => {
            if (eventType !== MEDIA_EVENT_TRACK_ADDED) return;
            handler(payload);
        };
    }

    joinRoom(roomId) {
        // Safe to call repeatedly with different room ids; re-joining the
        // same room is an idempotent re-announce. Fire-and-forget: the room
        // isn't necessarily usable yet when this returns. Listen for
        // EVENT_ROOM_JOINED/EVENT_ROOM_JOIN_FAILED (see onEvent), or use
        // joinRoomAsync() instead, to know when it is.
        mist_join_room(roomId);
    }

    // Awaitable counterpart to joinRoom(): resolves once the room is
    // actually usable (or rejects with the failure reason), instead of
    // returning before the session has finished building.
    joinRoomAsync(roomId) {
        return mist_join_room_async(roomId);
    }

    isRoomJoined(roomId) {
        return mist_is_room_joined(roomId);
    }

    updatePosition(x, y, z = 0, roomId) {
        if (roomId) {
            mist_update_position_in_room(roomId, x, y, z);
            return;
        }
        mist_update_position(x, y, z);
    }

    getNeighbors(roomId) {
        const neighborsJson = roomId ? mist_get_neighbors_in_room(roomId) : mist_get_neighbors();
        try {
            return JSON.parse(neighborsJson);
        } catch (e) {
            console.error("Failed to parse neighbors JSON:", e);
            return [];
        }
    }

    getAllNodes(roomId) {
        const allNodesJson = roomId ? mist_get_all_nodes_in_room(roomId) : mist_get_all_nodes();
        try {
            return JSON.parse(allNodesJson);
        } catch (e) {
            console.error("Failed to parse all nodes JSON:", e);
            return [];
        }
    }

    getConfig() {
        const configJson = mist_get_config();
        try {
            return JSON.parse(configJson);
        } catch (e) {
            console.error("Failed to parse config JSON:", e);
            return {};
        }
    }

    setConfig(config) {
        const configJson = typeof config === 'string' ? config : JSON.stringify(config);
        return Boolean(mist_set_config(configJson));
    }

    getStats() {
        const statsJson = mist_get_stats();
        try {
            return JSON.parse(statsJson);
        } catch (e) {
            console.error("Failed to parse stats JSON:", e);
            return {};
        }
    }

    sendMessage(toId, payload, delivery = DELIVERY_UNRELIABLE, roomId) {
        const to = toId || "";
        let data;
        if (payload instanceof Uint8Array) {
            data = payload;
        } else if (payload instanceof ArrayBuffer) {
            data = new Uint8Array(payload);
        } else if (typeof payload === 'string') {
            data = new TextEncoder().encode(payload);
        } else {
            data = new TextEncoder().encode(JSON.stringify(payload));
        }
        if (roomId) {
            mist_send_message_in_room(roomId, to, data, delivery);
            return;
        }
        mist_send_message(to, data, delivery);
    }

    async createLocalMedia(constraints = { audio: true, video: true }) {
        return navigator.mediaDevices.getUserMedia(constraints);
    }

    async createDisplayMedia(constraints = { video: true, audio: false }) {
        return navigator.mediaDevices.getDisplayMedia(constraints);
    }

    registerLocalTrack(trackId, track, options = {}) {
        mist_register_local_track(trackId, track);
        if (typeof options.enabled === 'boolean') {
            mist_set_local_track_enabled(trackId, options.enabled);
        }
        if (options.publish !== false) {
            mist_publish_local_track(trackId);
        }
        return track;
    }

    replaceLocalTrack(trackId, track, options = {}) {
        const previous = this.getLocalTrack(trackId);
        mist_register_local_track(trackId, track);
        if (typeof options.enabled === 'boolean') {
            mist_set_local_track_enabled(trackId, options.enabled);
        } else if (previous && previous.enabled !== track.enabled) {
            mist_set_local_track_enabled(trackId, previous.enabled);
        }
        if (options.publish !== false) {
            mist_publish_local_track(trackId);
        }
        if (options.stopPrevious !== false && previous && previous.id !== track.id) {
            previous.stop();
        }
        return track;
    }

    getLocalTrack(trackId) {
        return mist_get_local_track(trackId) ?? null;
    }

    publishLocalTrack(trackId) {
        mist_publish_local_track(trackId);
    }

    unpublishLocalTrack(trackId) {
        mist_unpublish_local_track(trackId);
    }

    removeLocalTrack(trackId) {
        mist_remove_local_track(trackId);
    }

    setLocalTrackEnabled(trackId, enabled) {
        mist_set_local_track_enabled(trackId, enabled);
    }

    async addLocalStream(stream, options = {}) {
        const entries = [];
        for (const track of stream.getTracks()) {
            const trackId = options.prefix ? `${options.prefix}:${track.id}` : track.id;
            this.registerLocalTrack(trackId, track, options);
            entries.push({ trackId, track });
        }
        return entries;
    }

    attachMedia(element, trackOrStream) {
        const stream = trackOrStream instanceof MediaStream
            ? trackOrStream
            : new MediaStream([trackOrStream]);
        element.srcObject = stream;
        return stream;
    }

    leaveRoom(roomId) {
        if (roomId) {
            mist_leave_room_id(roomId);
            return;
        }
        mist_leave_room();
        if (activeNode === this) {
            activeNode = null;
        }
        this.initialized = false;
    }
}

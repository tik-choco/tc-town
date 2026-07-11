/* tslint:disable */
/* eslint-disable */

export function get_all_nodes(): string;

export function get_all_nodes_in_room(room_id: string): string;

export function get_config(): string;

export function get_local_track(track_id: string): MediaStreamTrack | undefined;

export function get_neighbors(): string;

export function get_neighbors_in_room(room_id: string): string;

export function get_stats(): string;

export function init(id: string, url: string): void;

export function init_with_config(id: string, config: string): boolean;

export function is_room_joined(room_id: string): boolean;

export function join_room(room_id: string): void;

export function join_room_async(room_id: string): Promise<any>;

export function leave_room(): void;

export function leave_room_id(room_id: string): void;

export function publish_local_track(track_id: string): void;

export function register_event_callback(callback: Function): void;

export function register_local_track(track_id: string, track: MediaStreamTrack): void;

export function register_media_event_callback(callback: Function): void;

export function remove_local_track(track_id: string): void;

export function send_message(target_id: string, data: Uint8Array, method: number): void;

export function send_message_in_room(room_id: string, target_id: string, data: Uint8Array, method: number): void;

export function set_config(data: string): boolean;

export function set_local_track_enabled(track_id: string, enabled: boolean): void;

export function storage_add(name: string, data: Uint8Array): Promise<string>;

/**
 * Explicit-position variant of `storage_add` (SPEC-16): every chunk and the
 * manifest are tagged with `(x, y, z)` instead of being auto-tagged from
 * `WasmSelfPositions`.
 */
export function storage_add_at(name: string, data: Uint8Array, x: number, y: number, z: number): Promise<string>;

export function storage_get(root_cid: string): Promise<Uint8Array>;

export function unpublish_local_track(track_id: string): void;

export function update_position(x: number, y: number, z: number): void;

export function update_position_in_room(room_id: string, x: number, y: number, z: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly get_all_nodes: () => [number, number];
    readonly get_all_nodes_in_room: (a: number, b: number) => [number, number, number, number];
    readonly get_config: () => [number, number];
    readonly get_local_track: (a: number, b: number) => [number, number, number];
    readonly get_neighbors: () => [number, number];
    readonly get_neighbors_in_room: (a: number, b: number) => [number, number, number, number];
    readonly get_stats: () => [number, number];
    readonly init: (a: number, b: number, c: number, d: number) => void;
    readonly init_with_config: (a: number, b: number, c: number, d: number) => number;
    readonly is_room_joined: (a: number, b: number) => number;
    readonly join_room: (a: number, b: number) => void;
    readonly join_room_async: (a: number, b: number) => any;
    readonly leave_room_id: (a: number, b: number) => [number, number];
    readonly publish_local_track: (a: number, b: number) => [number, number];
    readonly register_event_callback: (a: any) => void;
    readonly register_local_track: (a: number, b: number, c: any) => [number, number];
    readonly register_media_event_callback: (a: any) => void;
    readonly remove_local_track: (a: number, b: number) => [number, number];
    readonly send_message: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly send_message_in_room: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly set_config: (a: number, b: number) => number;
    readonly set_local_track_enabled: (a: number, b: number, c: number) => [number, number];
    readonly unpublish_local_track: (a: number, b: number) => [number, number];
    readonly update_position_in_room: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly leave_room: () => void;
    readonly update_position: (a: number, b: number, c: number) => void;
    readonly storage_add: (a: number, b: number, c: number, d: number) => any;
    readonly storage_add_at: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => any;
    readonly storage_get: (a: number, b: number) => any;
    readonly wasm_bindgen__closure__destroy__h19326926141fe941: (a: number, b: number) => void;
    readonly wasm_bindgen__closure__destroy__hf1eac46c7b14bbfe: (a: number, b: number) => void;
    readonly wasm_bindgen__closure__destroy__hd9b9648ddf6074bf: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hd6780872556661f6: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h592d43f707b8155b: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h1328fcfde3f039f3: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h1328fcfde3f039f3_1: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h1328fcfde3f039f3_2: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h1328fcfde3f039f3_3: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h1328fcfde3f039f3_4: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h56de3da8990075a8: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

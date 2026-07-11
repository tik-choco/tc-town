// Cross-app backup publisher. Replaces the old manual "backup" tab (Settings
// screen export/import JSON download) with a continuous, automatic publish
// of the same full-bundle JSON onto the shared bus (lib/sharedBus.ts) under
// topic "town-backup", so tc-storage's drive (the sibling app, same origin
// in production) shows tc-town's data as a file without any user action.
// See protocol/docs/data-contracts/docs/SHARED_BUS.md for the shared-bus
// contract — tc-storage's consumer is built against this exact meta shape,
// so keep it in sync deliberately rather than reshaping opportunistically.
//
// Encryption model mirrors tc-note's storage-drive-inbox publisher (see
// lib/storageDriveInbox.ts in tc-note): the plaintext bundle is never
// uploaded to the mistlib block store as-is (it may be P2P-visible) — it's
// encrypted here with a fresh random AES-256-GCM key, the ciphertext is
// uploaded via mistlib's storage_add to get a CID, and the key/iv travel
// inline in `meta` alongside the CID. Same-origin localStorage is the trust
// boundary for that inline key, per the established pattern.
//
// Change detection: buildExportBundle()'s `exportedAt` timestamp changes on
// every build, so publishing unconditionally on every trigger would churn
// forever (new CID, new key, new bus event on every character/world edit's
// debounce tick even when nothing meaningful changed). Instead this module
// hashes the bundle with `exportedAt` blanked out and compares that content
// signature against the last successfully published one (persisted in
// localStorage under tc-town:backup-publish-state-v1), skipping the publish
// (and leaving the stored signature untouched) when unchanged. The stored
// signature is only updated after a fully successful publish, so a failed
// attempt retries on the next trigger.
//
// Best-effort throughout: guarded on Web Crypto availability, every failure
// is caught and logged via console.warn, never thrown — a failed publish
// must never break the app.

import { buildExportBundle } from "./exportImport";
import { loadAppSettings } from "./appSettings";
import { loadProviderSettings } from "./llmSettings";
import { subscribeCharacters } from "./characterStorage";
import { subscribeWorlds } from "./worlds";
import { subscribeAppDataChanged } from "./appDataChangeBus";
import { publishShared } from "./sharedBus";
import { storage_add } from "./mistClient";
import { bytesToBase64, hex } from "../crypto/cryptoEncoding";

const TOPIC = "town-backup";
const STATE_KEY = "tc-town:backup-publish-state-v1";
const ITEM_ID = "tc-town-backup";
const ITEM_NAME = "tc-town-backup.json";
const DEBOUNCE_MS = 2000;
const INITIAL_DELAY_MS = 5000; // mirrors characterIndexPublisher's ENRICH_INITIAL_DELAY_MS — must not block boot

/** Fixed cross-app contract — tc-storage's town-backup consumer is built against this exact shape. */
export interface TownBackupItem {
  id: "tc-town-backup";
  name: "tc-town-backup.json";
  mimeType: "application/json";
  /** Plaintext byte length. */
  size: number;
  /** SHA-256 hex of the plaintext bundle JSON bytes. */
  checksum: string;
  /** mistlib storage_add CID of the AES-256-GCM ciphertext. */
  cid: string;
  /** Base64 raw AES-256-GCM key material (fresh throwaway key per publish). */
  key: string;
  /** Base64 96-bit AES-GCM IV. */
  iv: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

/** Fixed cross-app contract — tc-storage's town-backup consumer is built against this exact shape. */
export interface TownBackupMeta {
  v: 1;
  updatedAt: string;
  item: TownBackupItem;
}

// --- Publish-state (last-published content signature) ----------------------

interface PublishState {
  v: 1;
  signature: string;
}

function readPublishState(): PublishState | null {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const s = parsed as Record<string, unknown>;
    if (s.v !== 1 || typeof s.signature !== "string" || !s.signature) return null;
    return { v: 1, signature: s.signature };
  } catch {
    return null;
  }
}

function writePublishState(state: PublishState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("townBackupPublisher: failed to persist publish state", error);
  }
}

// --- Bundle build + publish ---------------------------------------------------

const textEncoder = new TextEncoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return hex(new Uint8Array(digest));
}

/** Encrypts and publishes the current backup bundle if its content changed since the last successful publish. Throws on failure — callers must catch. */
async function publishBundleUnsafe(): Promise<void> {
  if (typeof crypto === "undefined" || !crypto.subtle) return;

  const bundle = await buildExportBundle(loadAppSettings(), loadProviderSettings());

  // exportedAt is volatile (changes on every build) — exclude it from the
  // change-detection signature so an otherwise-identical bundle doesn't
  // trigger a republish.
  const signature = await sha256Hex(textEncoder.encode(JSON.stringify({ ...bundle, exportedAt: "" })));
  if (readPublishState()?.signature === signature) return;

  const json = JSON.stringify(bundle, null, 2);
  const plaintext = textEncoder.encode(json);
  const checksum = await sha256Hex(plaintext);

  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, ["encrypt"]);
  const cipherText = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, cryptoKey, plaintext as BufferSource),
  );

  const cid = await storage_add(`${ITEM_NAME}.enc`, cipherText);

  const updatedAt = new Date().toISOString();
  const meta: TownBackupMeta = {
    v: 1,
    updatedAt,
    item: {
      id: ITEM_ID,
      name: ITEM_NAME,
      mimeType: "application/json",
      size: plaintext.byteLength,
      checksum,
      cid,
      key: bytesToBase64(keyBytes),
      iv: bytesToBase64(iv),
      updatedAt,
    },
  };

  publishShared(TOPIC, "", meta as unknown as Record<string, unknown>);

  // Only recorded after every step above succeeded, so a failure anywhere
  // (network, storage_add, quota) leaves the old signature in place and the
  // next trigger retries from scratch.
  writePublishState({ v: 1, signature });
}

async function publishBundle(): Promise<void> {
  try {
    await publishBundleUnsafe();
  } catch (error) {
    console.warn("townBackupPublisher: failed to publish town backup", error);
  }
}

// --- Serialized, debounced trigger -----------------------------------------
// Two debounce fires must never race each other into overlapping
// encrypt/storage_add/publish calls (which could publish an older bundle
// after a newer one) — every publish attempt is chained onto the previous
// one's completion, same as tc-storage's appNoteDocInbox `inFlight` pattern.

let inFlight: Promise<void> = Promise.resolve();

function enqueuePublish(): void {
  inFlight = inFlight.then(() => publishBundle()).catch(() => {});
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced re-publish trigger — call after any app-local data mutation that should eventually surface in the backup. */
export function scheduleTownBackupPublish(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    enqueuePublish();
  }, DEBOUNCE_MS);
}

let started = false;

/**
 * Starts the town-backup publisher: publishes once shortly after startup
 * (delayed so the lazy mist node connection never blocks boot), then
 * re-publishes (debounced) on every character/world change and on every
 * app-local settings save (lib/appDataChangeBus.ts, wired from
 * appSettings.ts/llmSettings.ts). Idempotent — safe to call more than once
 * (subsequent calls are no-ops).
 */
export function startTownBackupPublisher(): void {
  if (started) return;
  started = true;

  if (typeof window !== "undefined") {
    setTimeout(() => enqueuePublish(), INITIAL_DELAY_MS);
  }

  subscribeCharacters(() => scheduleTownBackupPublish());
  subscribeWorlds(() => scheduleTownBackupPublish());
  subscribeAppDataChanged(() => scheduleTownBackupPublish());
}

export { TOPIC as townBackupTopic };

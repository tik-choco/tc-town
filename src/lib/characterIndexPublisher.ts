// Cross-app character-index publisher. Publishes tc-town's character roster
// onto the shared bus (lib/sharedBus.ts) under topic "character-index" so
// sibling apps (tc-travel, same origin in production) can list/compile
// personas without talking to tc-town directly. See the fixed contract below
// — tc-travel's reader is built against this exact shape, so keep it in sync
// deliberately rather than reshaping opportunistically.
//
// The full index (personaPrompt included, potentially large across many
// characters) is never written into localStorage directly: it's JSON'd and
// handed to mistlib's storage_add to get a CID, and only a slim per-entry
// summary (personaPrompt stripped — see contract E) plus that CID goes into
// the sharedBus record. This mirrors townBackupPublisher.ts's "town-backup"
// topic, which CID's its (encrypted) body the same way. Because publishing
// now needs storage_add, and thus the mist node, the first publish is
// deferred by INITIAL_PUBLISH_DELAY_MS after startup (same reasoning as
// townBackupPublisher's INITIAL_DELAY_MS) so it never blocks boot; every
// publish after that is queued (never overlapping) via enqueuePublish().
//
// VRM CID enrichment is a separate, independent concern: best-effort
// background work that talks to mist (storage_add) to resolve avatar CIDs,
// re-publishing the index (via enqueuePublish) if anything new was cached.

import { listCharacters, subscribeCharacters, toPersonaPrompt } from "./characterStorage";
import { getWorld, subscribeWorlds } from "./worlds";
import { publishShared } from "./sharedBus";
import { getVrmBytesForAvatar } from "../vrm/library";
import { getNode, storage_add } from "./mistClient";
import type { Character } from "../types";

const TOPIC = "character-index";
const CID_CACHE_KEY = "tc-town:vrm-cid-cache-v1";
const DEBOUNCE_MS = 1000;
const ENRICH_INITIAL_DELAY_MS = 5000;
const INITIAL_PUBLISH_DELAY_MS = 5000;

/** Fixed cross-app contract — tc-travel is built against this exact shape. This is the FULL index, including each entry's personaPrompt; it's never written to localStorage directly — see storage_add in publishIndexUnsafe(). */
export interface CharacterIndexEntry {
  id: string;
  name: string;
  summary: string;
  personaPrompt: string;
  vrmChecksum?: string;
  vrmCid?: string;
  vrmFileName?: string;
  voiceModel?: string;
  voiceName?: string;
  updatedAt: string;
}

/** Fixed cross-app contract — tc-travel is built against this exact shape. */
export interface CharacterIndexMeta {
  v: 1;
  updatedAt: string;
  entries: CharacterIndexEntry[];
}

/** Slim per-entry shape (personaPrompt omitted, contract E) that goes inline into the sharedBus `meta` for one-glance listing. tc-travel falls back to storage_get(cid) on the full CharacterIndexMeta above when it needs an entry's personaPrompt. */
export type CharacterIndexEntryMeta = Omit<CharacterIndexEntry, "personaPrompt">;

/** Fixed cross-app contract — tc-travel is built against this exact shape. */
export interface CharacterIndexMetaSlim {
  v: 1;
  updatedAt: string;
  entries: CharacterIndexEntryMeta[];
}

// --- VRM checksum -> mist CID cache -----------------------------------------

function readCidCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CID_CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeCidCache(cache: Record<string, string>): void {
  try {
    localStorage.setItem(CID_CACHE_KEY, JSON.stringify(cache));
  } catch (error) {
    console.warn("characterIndexPublisher: failed to persist vrm cid cache", error);
  }
}

function cacheCid(checksum: string, cid: string): boolean {
  const cache = readCidCache();
  if (cache[checksum] === cid) return false;
  cache[checksum] = cid;
  writeCidCache(cache);
  return true;
}

// --- Index build + publish ---------------------------------------------------

function buildEntry(character: Character, cidCache: Record<string, string>): CharacterIndexEntry {
  const world = getWorld(character.worldId);
  const entry: CharacterIndexEntry = {
    id: character.id,
    name: character.sheet.name.trim(),
    summary: character.sheet.summary.trim(),
    personaPrompt: toPersonaPrompt(character.sheet, world),
    updatedAt: character.updatedAt,
  };
  if (character.voiceModel) entry.voiceModel = character.voiceModel;
  if (character.voiceName) entry.voiceName = character.voiceName;
  if (character.avatar?.kind === "vrm") {
    entry.vrmChecksum = character.avatar.checksum;
    entry.vrmFileName = character.avatar.fileName;
    const cid = cidCache[character.avatar.checksum];
    if (cid) entry.vrmCid = cid;
  }
  return entry;
}

function buildIndex(): CharacterIndexMeta {
  const cidCache = readCidCache();
  const entries = listCharacters()
    .filter((character) => character.sheet.name.trim() !== "")
    .map((character) => buildEntry(character, cidCache));
  return { v: 1, updatedAt: new Date().toISOString(), entries };
}

function stripPersonaPrompt(entry: CharacterIndexEntry): CharacterIndexEntryMeta {
  const meta: CharacterIndexEntryMeta = {
    id: entry.id,
    name: entry.name,
    summary: entry.summary,
    updatedAt: entry.updatedAt,
  };
  if (entry.vrmChecksum) meta.vrmChecksum = entry.vrmChecksum;
  if (entry.vrmCid) meta.vrmCid = entry.vrmCid;
  if (entry.vrmFileName) meta.vrmFileName = entry.vrmFileName;
  if (entry.voiceModel) meta.voiceModel = entry.voiceModel;
  if (entry.voiceName) meta.voiceName = entry.voiceName;
  return meta;
}

function toSlimIndex(index: CharacterIndexMeta): CharacterIndexMetaSlim {
  return { v: index.v, updatedAt: index.updatedAt, entries: index.entries.map(stripPersonaPrompt) };
}

/** Uploads the full index (personaPrompt included) via storage_add and publishes the CID + a slim meta. Throws on failure — callers must catch. */
async function publishIndexUnsafe(): Promise<void> {
  const index = buildIndex();
  await getNode();
  const bytes = new TextEncoder().encode(JSON.stringify(index));
  const cid = await storage_add("character-index.json", bytes);
  const slim = toSlimIndex(index);
  publishShared(TOPIC, cid, slim as unknown as Record<string, unknown>);
}

async function publishIndex(): Promise<void> {
  try {
    await publishIndexUnsafe();
  } catch (error) {
    console.warn("characterIndexPublisher: failed to publish character index", error);
  }
}

// Serialized so two publishes never race each other into an older CID
// overwriting a newer one (same pattern as townBackupPublisher's inFlight).
let inFlight: Promise<void> = Promise.resolve();

function enqueuePublish(): void {
  inFlight = inFlight.then(() => publishIndex()).catch(() => {});
}

// --- Debounced re-publish on character/world change --------------------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePublish(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    enqueuePublish();
  }, DEBOUNCE_MS);
}

// --- VRM CID enrichment (best-effort, non-blocking) ---------------------------

/** Characters whose VRM avatar checksum we've already attempted (success or
 * failure) this session, so we don't hammer storage_add repeatedly. */
const attemptedChecksums = new Set<string>();

function collectUncachedVrmAvatars(): Array<{ blobKey: string; checksum: string; fileName: string }> {
  const cidCache = readCidCache();
  const out: Array<{ blobKey: string; checksum: string; fileName: string }> = [];
  const seen = new Set<string>();
  for (const character of listCharacters()) {
    const avatar = character.avatar;
    if (!avatar || avatar.kind !== "vrm") continue;
    if (cidCache[avatar.checksum]) continue;
    if (attemptedChecksums.has(avatar.checksum)) continue;
    if (seen.has(avatar.checksum)) continue;
    seen.add(avatar.checksum);
    out.push({ blobKey: avatar.blobKey, checksum: avatar.checksum, fileName: avatar.fileName });
  }
  return out;
}

async function enrichOne(avatar: { blobKey: string; checksum: string; fileName: string }): Promise<boolean> {
  attemptedChecksums.add(avatar.checksum);
  try {
    const bytes = await getVrmBytesForAvatar(avatar.blobKey, avatar.checksum);
    if (!bytes) return false;
    const cid = await storage_add(avatar.fileName, bytes);
    if (!cid) return false;
    return cacheCid(avatar.checksum, cid);
  } catch (error) {
    console.warn("characterIndexPublisher: vrm cid enrichment failed", avatar.fileName, error);
    return false;
  }
}

/** Best-effort background enrichment pass: resolves uncached VRM avatars'
 * mist CIDs and re-publishes the index if any were newly cached. Never
 * throws — every failure is caught and simply skipped, leaving the index
 * valid via vrmChecksum (tc-travel resolves that same-origin). */
async function runEnrichmentPass(): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const pending = collectUncachedVrmAvatars();
  if (pending.length === 0) return;
  let changed = false;
  for (const avatar of pending) {
    try {
      const didCache = await enrichOne(avatar);
      if (didCache) changed = true;
    } catch {
      // enrichOne already swallows its own errors; this is just an extra
      // safety net so one bad avatar never aborts the whole pass.
    }
  }
  if (changed) enqueuePublish();
}

let started = false;

/**
 * Starts the character-index publisher: publishes shortly after startup
 * (delayed by INITIAL_PUBLISH_DELAY_MS so the mist node connection required
 * by storage_add never blocks boot — mirrors townBackupPublisher), then
 * re-publishes (debounced) on every character/world change, and schedules a
 * low-priority background pass to enrich VRM avatars with mist storage CIDs.
 * Idempotent — safe to call more than once (subsequent calls are no-ops).
 */
export function startCharacterIndexPublisher(): void {
  if (started) return;
  started = true;

  if (typeof window !== "undefined") {
    setTimeout(() => enqueuePublish(), INITIAL_PUBLISH_DELAY_MS);
  } else {
    enqueuePublish();
  }

  subscribeCharacters(() => schedulePublish());
  subscribeWorlds(() => schedulePublish());

  if (typeof window !== "undefined") {
    setTimeout(() => {
      void runEnrichmentPass();
    }, ENRICH_INITIAL_DELAY_MS);
  }
}

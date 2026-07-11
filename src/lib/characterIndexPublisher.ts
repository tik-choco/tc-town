// Cross-app character-index publisher. Publishes tc-town's character roster
// onto the shared bus (lib/sharedBus.ts) under topic "character-index" so
// sibling apps (tc-travel, same origin in production) can list/compile
// personas without talking to tc-town directly. See the fixed contract below
// — tc-travel's reader is built against this exact shape, so keep it in sync
// deliberately rather than reshaping opportunistically.
//
// Two independent concerns are kept separate on purpose:
//  - Publishing the index itself is pure localStorage (via publishShared) and
//    must never wait on or trigger the mist node.
//  - VRM CID enrichment is best-effort background work that talks to mist
//    (storage_add), which lazily connects the node the first time it's
//    called. It never blocks or gates the plain index publish.

import { listCharacters, subscribeCharacters, toPersonaPrompt } from "./characterStorage";
import { getWorld, subscribeWorlds } from "./worlds";
import { publishShared } from "./sharedBus";
import { getVrmBytesForAvatar } from "../vrm/library";
import { storage_add } from "./mistClient";
import type { Character } from "../types";

const TOPIC = "character-index";
const CID_CACHE_KEY = "tc-town:vrm-cid-cache-v1";
const DEBOUNCE_MS = 1000;
const ENRICH_INITIAL_DELAY_MS = 5000;

/** Fixed cross-app contract — tc-travel is built against this exact shape. */
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

/** Pure localStorage publish — never waits on or triggers the mist node. */
function publishIndex(): void {
  try {
    const meta = buildIndex();
    publishShared(TOPIC, "", meta as unknown as Record<string, unknown>);
  } catch (error) {
    console.warn("characterIndexPublisher: failed to publish character index", error);
  }
}

// --- Debounced re-publish on character/world change --------------------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePublish(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    publishIndex();
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
  if (changed) publishIndex();
}

let started = false;

/**
 * Starts the character-index publisher: publishes now, then re-publishes
 * (debounced) on every character/world change, and schedules a low-priority
 * background pass to enrich VRM avatars with mist storage CIDs. Idempotent —
 * safe to call more than once (subsequent calls are no-ops).
 */
export function startCharacterIndexPublisher(): void {
  if (started) return;
  started = true;

  publishIndex();

  subscribeCharacters(() => schedulePublish());
  subscribeWorlds(() => schedulePublish());

  if (typeof window !== "undefined") {
    setTimeout(() => {
      void runEnrichmentPass();
    }, ENRICH_INITIAL_DELAY_MS);
  }
}

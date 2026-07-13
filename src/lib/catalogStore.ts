// Local persistence for the character catalog: what I've published
// (tc-town:catalog-published-v1), what the network has told me is public
// (tc-town:catalog-directory-v1), a replayable log of signed catalog wires
// for late-joiner history sync (tc-town:catalog-wirelog-v1), and this
// device's author display name (tc-town:catalog-profile-v1). Same
// defensive-parse + subscribe/notify pattern as lib/worlds.ts. Nothing here
// touches the P2P layer — see lib/catalog.ts for that — so this module is
// free to import from anywhere without pulling in mistlib.

import type {
  CatalogEntry,
  CatalogProfile,
  PublishState,
  PublishVisibility,
  SignedCatalogWire,
} from "./catalogTypes";

const PUBLISHED_KEY = "tc-town:catalog-published-v1";
const DIRECTORY_KEY = "tc-town:catalog-directory-v1";
const WIRELOG_KEY = "tc-town:catalog-wirelog-v1";
const PROFILE_KEY = "tc-town:catalog-profile-v1";
const MAX_WIRE_LOG = 600;
// The directory learns entries from whatever the network tells it, with no
// upper bound of its own — an active swarm could grow it indefinitely.
// receivedAt is refreshed on every upsert (new publish or re-learn of an
// existing entry), so it doubles as a recency signal: evict the
// least-recently-received entries once the cap is exceeded.
const MAX_DIRECTORY_ENTRIES = 500;

function isStringField(value: unknown): value is string {
  return typeof value === "string";
}

function isNumberField(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// --- published (my characters) ------------------------------------------------

/** Exported for tests — sanitizes one parsed PublishState record the same defensive way as storage reads. */
export function coercePublishState(value: unknown): PublishState | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (!isStringField(p.characterId) || p.characterId === "") return null;
  if (p.visibility !== "public" && p.visibility !== "unlisted") return null;
  if (!isStringField(p.cid) || p.cid === "") return null;
  const now = Date.now();
  return {
    characterId: p.characterId,
    visibility: p.visibility as PublishVisibility,
    cid: p.cid,
    vrmCid: isStringField(p.vrmCid) ? p.vrmCid : undefined,
    publishedAt: isNumberField(p.publishedAt) ? p.publishedAt : now,
    updatedAt: isNumberField(p.updatedAt) ? p.updatedAt : now,
  };
}

function readPublished(): PublishState[] {
  try {
    const raw = localStorage.getItem(PUBLISHED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: PublishState[] = [];
    for (const entry of parsed) {
      const state = coercePublishState(entry);
      if (state) out.push(state);
    }
    return out;
  } catch {
    return [];
  }
}

function writePublished(states: PublishState[]): void {
  try {
    localStorage.setItem(PUBLISHED_KEY, JSON.stringify(states));
  } catch (error) {
    console.warn("catalogStore: failed to persist published state", error);
  }
  notifyPublished();
}

const publishedListeners = new Set<() => void>();
function notifyPublished(): void {
  for (const listener of publishedListeners) {
    try {
      listener();
    } catch (error) {
      console.warn("catalogStore: published listener threw", error);
    }
  }
}

export function subscribePublished(listener: () => void): () => void {
  ensureStorageListener();
  publishedListeners.add(listener);
  return () => {
    publishedListeners.delete(listener);
  };
}

export function listPublished(): PublishState[] {
  return readPublished();
}

export function getPublishState(characterId: string): PublishState | null {
  return readPublished().find((s) => s.characterId === characterId) ?? null;
}

export function upsertPublishState(state: PublishState): void {
  const all = readPublished();
  const index = all.findIndex((s) => s.characterId === state.characterId);
  if (index === -1) all.push(state);
  else all[index] = state;
  writePublished(all);
}

export function removePublishState(characterId: string): void {
  const all = readPublished();
  const remaining = all.filter((s) => s.characterId !== characterId);
  if (remaining.length === all.length) return;
  writePublished(remaining);
}

// --- directory (learned public catalog) ---------------------------------------

/** Exported for tests — sanitizes one parsed CatalogEntry record the same defensive way as storage reads. */
export function coerceCatalogEntry(value: unknown): CatalogEntry | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Record<string, unknown>;
  if (!isStringField(e.entryId) || e.entryId === "") return null;
  if (!isStringField(e.cid) || e.cid === "") return null;
  if (!isStringField(e.fromId) || e.fromId === "") return null;
  const now = Date.now();
  return {
    entryId: e.entryId,
    name: isStringField(e.name) ? e.name : "",
    summary: isStringField(e.summary) ? e.summary : "",
    hasVrm: e.hasVrm === true,
    cid: e.cid,
    vrmCid: isStringField(e.vrmCid) ? e.vrmCid : undefined,
    fromId: e.fromId,
    fromName: isStringField(e.fromName) ? e.fromName : "",
    publishedAt: isNumberField(e.publishedAt) ? e.publishedAt : now,
    updatedAt: isNumberField(e.updatedAt) ? e.updatedAt : now,
    receivedAt: isNumberField(e.receivedAt) ? e.receivedAt : now,
  };
}

function readDirectory(): Record<string, CatalogEntry> {
  try {
    const raw = localStorage.getItem(DIRECTORY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, CatalogEntry> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = coerceCatalogEntry(value);
      // Guard against a tampered/corrupted map where a key doesn't match its
      // own record's entryId — never trust the key alone.
      if (entry && entry.entryId === key) out[key] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

function writeDirectory(directory: Record<string, CatalogEntry>): void {
  try {
    localStorage.setItem(DIRECTORY_KEY, JSON.stringify(directory));
  } catch (error) {
    console.warn("catalogStore: failed to persist catalog directory", error);
  }
  notifyDirectory();
}

const directoryListeners = new Set<() => void>();
function notifyDirectory(): void {
  for (const listener of directoryListeners) {
    try {
      listener();
    } catch (error) {
      console.warn("catalogStore: directory listener threw", error);
    }
  }
}

export function subscribeCatalogDirectory(listener: () => void): () => void {
  ensureStorageListener();
  directoryListeners.add(listener);
  return () => {
    directoryListeners.delete(listener);
  };
}

/** Every known public-catalog entry, most recently published first. */
export function listCatalogEntries(): CatalogEntry[] {
  return Object.values(readDirectory()).sort((a, b) => b.publishedAt - a.publishedAt);
}

export function getCatalogEntry(entryId: string): CatalogEntry | null {
  return readDirectory()[entryId] ?? null;
}

/** Evicts the least-recently-received entries in place once the directory exceeds MAX_DIRECTORY_ENTRIES. Exported for tests. */
export function evictOldestDirectoryEntries(directory: Record<string, CatalogEntry>): void {
  const entries = Object.values(directory);
  if (entries.length <= MAX_DIRECTORY_ENTRIES) return;
  entries
    .sort((a, b) => a.receivedAt - b.receivedAt)
    .slice(0, entries.length - MAX_DIRECTORY_ENTRIES)
    .forEach((entry) => delete directory[entry.entryId]);
}

export function upsertCatalogEntry(entry: CatalogEntry): void {
  const directory = readDirectory();
  directory[entry.entryId] = entry;
  evictOldestDirectoryEntries(directory);
  writeDirectory(directory);
}

export function removeCatalogEntry(entryId: string): void {
  const directory = readDirectory();
  if (!(entryId in directory)) return;
  delete directory[entryId];
  writeDirectory(directory);
}

// --- wire log (history replay) -------------------------------------------------

function readWireLog(): SignedCatalogWire[] {
  try {
    const raw = localStorage.getItem(WIRELOG_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SignedCatalogWire[]) : [];
  } catch {
    return [];
  }
}

function writeWireLog(log: SignedCatalogWire[]): void {
  try {
    localStorage.setItem(WIRELOG_KEY, JSON.stringify(log));
  } catch (error) {
    console.warn("catalogStore: failed to persist catalog wire log", error);
  }
}

export function loadCatalogWireLog(): SignedCatalogWire[] {
  return readWireLog();
}

/**
 * Records a signed catalog wire for later replay to late joiners (see
 * lib/catalog.ts's connectCatalog). Entry/remove wires are upserted by
 * `entryId` rather than appended verbatim: a late joiner only needs each
 * entry's CURRENT state (its latest entry-wire, or a remove-wire tombstone),
 * not every edit that ever produced it. This also keeps the log naturally
 * bounded by the number of distinct entries ever seen, well under the
 * 600-wire cap, even with the ~2s debounced auto-republish on every
 * character edit.
 */
export function appendCatalogWireLog(wire: SignedCatalogWire): void {
  const log = readWireLog();
  const entryId = typeof wire.entryId === "string" ? wire.entryId : undefined;
  const next = entryId ? [...log.filter((w) => w.entryId !== entryId), wire] : [...log, wire];
  const trimmed = next.length > MAX_WIRE_LOG ? next.slice(next.length - MAX_WIRE_LOG) : next;
  writeWireLog(trimmed);
}

// --- profile (author display name) ---------------------------------------------

/** Exported for tests — sanitizes one parsed CatalogProfile record the same defensive way as storage reads. */
export function coerceCatalogProfile(value: unknown): CatalogProfile {
  const base: CatalogProfile = { displayName: "" };
  if (!value || typeof value !== "object") return base;
  const p = value as Record<string, unknown>;
  return { displayName: isStringField(p.displayName) ? p.displayName : base.displayName };
}

function readProfile(): CatalogProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return { displayName: "" };
    return coerceCatalogProfile(JSON.parse(raw));
  } catch {
    return { displayName: "" };
  }
}

function writeProfile(profile: CatalogProfile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch (error) {
    console.warn("catalogStore: failed to persist catalog profile", error);
  }
  notifyProfile();
}

const profileListeners = new Set<() => void>();
function notifyProfile(): void {
  for (const listener of profileListeners) {
    try {
      listener();
    } catch (error) {
      console.warn("catalogStore: profile listener threw", error);
    }
  }
}

export function subscribeCatalogProfile(listener: () => void): () => void {
  ensureStorageListener();
  profileListeners.add(listener);
  return () => {
    profileListeners.delete(listener);
  };
}

export function getCatalogProfile(): CatalogProfile {
  return readProfile();
}

export function setCatalogProfile(profile: CatalogProfile): void {
  writeProfile({ displayName: profile.displayName ?? "" });
}

// --- cross-tab sync -------------------------------------------------------------

let storageListenerBound = false;
function ensureStorageListener(): void {
  if (storageListenerBound || typeof window === "undefined") return;
  storageListenerBound = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key === PUBLISHED_KEY) notifyPublished();
    else if (event.key === DIRECTORY_KEY) notifyDirectory();
    else if (event.key === PROFILE_KEY) notifyProfile();
  });
}

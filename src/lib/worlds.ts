// World-setting data model — lets tc-town manage multiple "world settings"
// (時代・場所・社会・雰囲気・ルールなど自由記述) that a character can
// optionally opt into to deepen their persona. Same pattern as
// characterStorage.ts: a single localStorage array (JSON, parsed
// defensively — never trust stored content), CRUD helpers that fan out a
// same-tab listener notification, and a cross-tab `storage` event listener so
// open views refresh when worlds change elsewhere.

const STORAGE_KEY = "tc-town:worlds";

export interface WorldSetting {
  id: string;
  name: string;
  /** 世界の説明 — 時代、場所、社会、雰囲気、ルールなど自由記述 */
  description: string;
  createdAt: string;
  updatedAt: string;
}

// --- Defensive parsing ------------------------------------------------------

function isStringField(value: unknown): value is string {
  return typeof value === "string";
}

/** Exported for lib/exportImport.ts — sanitizes one parsed world record (import file or storage) the same defensive way. */
export function coerceWorld(value: unknown): WorldSetting | null {
  if (!value || typeof value !== "object") return null;
  const w = value as Record<string, unknown>;
  if (typeof w.id !== "string" || w.id === "") return null;
  const now = new Date().toISOString();
  return {
    id: w.id,
    name: isStringField(w.name) ? w.name : "",
    description: isStringField(w.description) ? w.description : "",
    createdAt: isStringField(w.createdAt) ? w.createdAt : now,
    updatedAt: isStringField(w.updatedAt) ? w.updatedAt : now,
  };
}

function readAll(): WorldSetting[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: WorldSetting[] = [];
    for (const entry of parsed) {
      const world = coerceWorld(entry);
      if (world) out.push(world);
    }
    return out;
  } catch {
    return [];
  }
}

function writeAll(worlds: WorldSetting[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(worlds));
  } catch (error) {
    console.warn("worlds: failed to persist world settings", error);
  }
  notify();
}

// --- Subscribe / notify -----------------------------------------------------

const listeners = new Set<() => void>();
let storageListenerBound = false;

function ensureStorageListener(): void {
  if (storageListenerBound || typeof window === "undefined") return;
  storageListenerBound = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) notify();
  });
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn("worlds: listener threw", error);
    }
  }
}

/**
 * Subscribes to any change to the world-setting set (create/save/delete in
 * this tab, or a `storage` event from another tab). Returns an unsubscribe fn.
 */
export function subscribeWorlds(listener: () => void): () => void {
  ensureStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// --- CRUD -------------------------------------------------------------------

export function listWorlds(): WorldSetting[] {
  return readAll();
}

export function getWorld(id: string | undefined | null): WorldSetting | undefined {
  if (!id) return undefined;
  return readAll().find((w) => w.id === id);
}

export function saveWorld(world: WorldSetting): void {
  const all = readAll();
  const next: WorldSetting = { ...world, updatedAt: new Date().toISOString() };
  const index = all.findIndex((w) => w.id === world.id);
  if (index === -1) {
    all.push(next);
  } else {
    all[index] = next;
  }
  writeAll(all);
}

export function deleteWorld(id: string): void {
  const all = readAll();
  const remaining = all.filter((w) => w.id !== id);
  if (remaining.length === all.length) return;
  writeAll(remaining);
}

function generateId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `world-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createWorld(name: string): WorldSetting {
  const now = new Date().toISOString();
  const world: WorldSetting = {
    id: generateId(),
    name: name.trim(),
    description: "",
    createdAt: now,
    updatedAt: now,
  };
  const all = readAll();
  all.push(world);
  writeAll(all);
  return world;
}

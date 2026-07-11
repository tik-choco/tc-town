// Character data model — owned by the "Character data model + LLM-interview
// character growth" workstream. Characters live in a single localStorage
// array (JSON, parsed defensively — never trust stored content); avatar image
// bytes live in idbBlobStore (VRM avatars reference src/vrm/library.ts). CRUD
// helpers fan out a same-tab listener notification plus honour cross-tab
// `storage` events so open views refresh when characters change.

import {
  emptyCharacterSheet,
  DEFAULT_LLM_PROFILE_ID,
  type Avatar,
  type Character,
  type CharacterSheet,
} from "../types";
import { deleteBlob } from "./idbBlobStore";
import type { WorldSetting } from "./worlds";

const STORAGE_KEY = "tc-town:characters";

// --- Defensive parsing ------------------------------------------------------

function isStringField(value: unknown): value is string {
  return typeof value === "string";
}

function isAvatar(value: unknown): value is Avatar {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  if (a.kind === "image") {
    return typeof a.blobKey === "string" && typeof a.mime === "string";
  }
  if (a.kind === "vrm") {
    return (
      typeof a.blobKey === "string" &&
      typeof a.checksum === "string" &&
      typeof a.fileName === "string"
    );
  }
  return false;
}

function coerceSheet(value: unknown): CharacterSheet {
  const base = emptyCharacterSheet("");
  if (!value || typeof value !== "object") return base;
  const s = value as Record<string, unknown>;
  return {
    name: isStringField(s.name) ? s.name : base.name,
    summary: isStringField(s.summary) ? s.summary : base.summary,
    persona: isStringField(s.persona) ? s.persona : base.persona,
    speechStyle: isStringField(s.speechStyle) ? s.speechStyle : base.speechStyle,
    likes: isStringField(s.likes) ? s.likes : base.likes,
    relationships: isStringField(s.relationships) ? s.relationships : base.relationships,
    notes: isStringField(s.notes) ? s.notes : base.notes,
  };
}

/** Exported for lib/exportImport.ts — sanitizes one parsed character record (import file or storage) the same defensive way. */
export function coerceCharacter(value: unknown): Character | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  if (typeof c.id !== "string" || c.id === "") return null;
  const now = new Date().toISOString();
  return {
    id: c.id,
    createdAt: isStringField(c.createdAt) ? c.createdAt : now,
    updatedAt: isStringField(c.updatedAt) ? c.updatedAt : now,
    avatar: isAvatar(c.avatar) ? c.avatar : null,
    sheet: coerceSheet(c.sheet),
    llmProfileId: isStringField(c.llmProfileId) ? c.llmProfileId : DEFAULT_LLM_PROFILE_ID,
    voiceModel: isStringField(c.voiceModel) ? c.voiceModel : undefined,
    voiceName: isStringField(c.voiceName) ? c.voiceName : undefined,
    worldId: isStringField(c.worldId) ? c.worldId : undefined,
  };
}

function readAll(): Character[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Character[] = [];
    for (const entry of parsed) {
      const character = coerceCharacter(entry);
      if (character) out.push(character);
    }
    return out;
  } catch {
    return [];
  }
}

function writeAll(characters: Character[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(characters));
  } catch (error) {
    console.warn("characterStorage: failed to persist characters", error);
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
      console.warn("characterStorage: listener threw", error);
    }
  }
}

/**
 * Subscribes to any change to the character set (create/save/delete in this
 * tab, or a `storage` event from another tab). Returns an unsubscribe fn.
 */
export function subscribeCharacters(listener: () => void): () => void {
  ensureStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// --- CRUD -------------------------------------------------------------------

export function listCharacters(): Character[] {
  return readAll();
}

export function getCharacter(id: string): Character | undefined {
  return readAll().find((c) => c.id === id);
}

export function saveCharacter(character: Character): void {
  const all = readAll();
  const next: Character = { ...character, updatedAt: new Date().toISOString() };
  const index = all.findIndex((c) => c.id === character.id);
  if (index === -1) {
    all.push(next);
  } else {
    all[index] = next;
  }
  writeAll(all);
}

export function deleteCharacter(id: string): void {
  const all = readAll();
  const target = all.find((c) => c.id === id);
  const remaining = all.filter((c) => c.id !== id);
  if (remaining.length === all.length) return;
  // Reclaim image avatar bytes from IndexedDB. VRM avatars live in the shared
  // model library and may be referenced elsewhere, so we leave those alone.
  if (target?.avatar?.kind === "image") {
    void deleteBlob(target.avatar.blobKey).catch((error) => {
      console.warn("characterStorage: failed to delete avatar blob", error);
    });
  }
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
  return `char-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createCharacter(name: string): Character {
  const now = new Date().toISOString();
  const character: Character = {
    id: generateId(),
    createdAt: now,
    updatedAt: now,
    avatar: null,
    sheet: emptyCharacterSheet(name.trim()),
    llmProfileId: DEFAULT_LLM_PROFILE_ID,
  };
  const all = readAll();
  all.push(character);
  writeAll(all);
  return character;
}

// --- Persona compilation ----------------------------------------------------

/**
 * Compiles a CharacterSheet into the Japanese system-prompt persona block used
 * by conversation orchestration. Empty fields are omitted so a sparse sheet
 * still yields a clean prompt. When `world` is given, a `# 世界観` section is
 * inserted first (ahead of 概要) so the character is framed by that setting
 * before anything else.
 */
export function toPersonaPrompt(sheet: CharacterSheet, world?: WorldSetting): string {
  const name = sheet.name.trim() || "キャラクター";
  const sections: string[] = [];

  const add = (heading: string, body: string) => {
    const value = body.trim();
    if (value) sections.push(`# ${heading}\n${value}`);
  };

  if (world && (world.name.trim() || world.description.trim())) {
    add("世界観", `【${world.name.trim() || "無題の世界"}】\n${world.description.trim()}`);
  }

  add("概要", sheet.summary);
  add("人物・背景", sheet.persona);
  add("話し方", sheet.speechStyle);
  add("好きなもの・嫌いなもの", sheet.likes);
  add("人間関係", sheet.relationships);
  add("メモ", sheet.notes);

  const header = `あなたは「${name}」というキャラクターとして振る舞ってください。`;
  const footer =
    `上記の設定に忠実に、${name}になりきって一貫した口調・性格で応答してください。` +
    `設定にない事柄は${name}らしく自然に補ってかまいませんが、設定と矛盾しないようにしてください。`;

  return [header, ...sections, footer].join("\n\n");
}

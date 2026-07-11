// Backup export/import for tc-town's local data: characters (with image
// avatar bytes embedded, but VRM avatars referenced by checksum only — VRM
// files are multi-megabyte and already live in the shared VRM library, so
// embedding them would bloat every export), app appearance settings, and
// tc-town's (now much smaller) local provider settings — network
// consumer/provider toggles and the STT silence duration. Everything
// round-trips as one JSON file via the Settings screen ("full backup"), and a
// single character can also be exported/imported on its own from the
// Characters screen as a lightweight one-character bundle sharing the same
// `characters` array shape (so both files — and tc-assistant2's importer —
// can be read by the same code).
//
// LLM/TTS/STT connection info (baseUrl/apiKey/model) is NOT part of this
// bundle: it lives in the shared `tc-shared-llm-config-v1` key
// (lib/llmConfig.ts), which is co-owned across the whole tik-choco app
// family and out of scope for a single app's backup file.
//
// Image avatar bytes are read from/written to idbBlobStore. VRM avatars are
// resolved against the shared VRM library (src/vrm/library.ts) by checksum
// on import — if the same VRM isn't present there, the character imports
// without its avatar rather than failing the whole import.

import { sanitizeAppSettings, type AppSettings } from "./appSettings";
import { sanitizeSettings, type ProviderSettings } from "./llmSettings";
import { coerceCharacter, saveCharacter, listCharacters } from "./characterStorage";
import { coerceWorld, getWorld, listWorlds, saveWorld, type WorldSetting } from "./worlds";
import { getBlob, putBlob } from "./idbBlobStore";
import { importVrmFile, listVrmModels } from "../vrm/library";
import type { Avatar, Character } from "../types";

const BUNDLE_APP_ID = "tc-town";
const BUNDLE_VERSION = 1;

type ExportedAvatar =
  | { kind: "image"; mime: string; dataUrl: string }
  | { kind: "vrm"; checksum: string; fileName: string };

export interface ExportedCharacter extends Omit<Character, "avatar"> {
  avatar: ExportedAvatar | null;
}

export interface ExportBundle {
  app: typeof BUNDLE_APP_ID;
  version: number;
  exportedAt: string;
  appSettings: AppSettings;
  providerSettings: ProviderSettings;
  characters: ExportedCharacter[];
  /** Every world setting, so a restored character's `worldId` still resolves. */
  worlds: WorldSetting[];
}

/** Lightweight single-character export file — same `characters` array shape as {@link ExportBundle}, just without the app-wide settings and with exactly one entry. */
export interface CharacterExportFile {
  app: typeof BUNDLE_APP_ID;
  version: number;
  kind: "character";
  exportedAt: string;
  characters: ExportedCharacter[];
  /** The character's selected world setting, if any — included so importing elsewhere resolves the reference. */
  worlds?: WorldSetting[];
}

// --- byte <-> data: URL helpers ---------------------------------------------

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function bytesFromDataUrl(dataUrl: string): Uint8Array {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1 || !dataUrl.slice(0, commaIndex).includes("base64")) {
    throw new Error("Unsupported dataUrl encoding (expected base64)");
  }
  const binary = atob(dataUrl.slice(commaIndex + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sanitizeFileNamePart(name: string): string {
  const withDashes = name.trim().replace(/\s+/g, "-");
  // Strip characters that are invalid in file names on common filesystems.
  const cleaned = withDashes.replace(/[\\/:*?"<>|]/g, "");
  return cleaned || "character";
}

// --- Export ------------------------------------------------------------------

async function exportAvatar(avatar: Avatar | null): Promise<ExportedAvatar | null> {
  if (!avatar) return null;
  if (avatar.kind === "image") {
    const blob = await getBlob(avatar.blobKey);
    if (!blob) return null; // bytes missing (e.g. cleared cache) — export the character without its avatar
    return { kind: "image", mime: avatar.mime, dataUrl: await blobToDataUrl(blob) };
  }
  // VRM avatars are exported by reference only (checksum + file name) — the
  // actual bytes live in the shared VRM library and are re-linked on import.
  return { kind: "vrm", checksum: avatar.checksum, fileName: avatar.fileName };
}

/** Builds the full backup bundle, embedding image avatar bytes (VRM avatars are referenced by checksum only). */
export async function buildExportBundle(
  appSettings: AppSettings,
  providerSettings: ProviderSettings,
): Promise<ExportBundle> {
  const characters = listCharacters();
  const exportedCharacters: ExportedCharacter[] = [];
  for (const character of characters) {
    exportedCharacters.push({ ...character, avatar: await exportAvatar(character.avatar) });
  }
  return {
    app: BUNDLE_APP_ID,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    appSettings,
    providerSettings,
    characters: exportedCharacters,
    worlds: listWorlds(),
  };
}

/** Triggers a browser download of the bundle as a formatted `.json` file. */
export function downloadExportBundle(bundle: ExportBundle): void {
  const json = JSON.stringify(bundle, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const dateStamp = bundle.exportedAt.slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tc-town-backup-${dateStamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Builds a lightweight one-character export file (avatar included, VRM by reference only). Includes the character's selected world setting, if any. */
export async function buildCharacterExportFile(character: Character): Promise<CharacterExportFile> {
  const world = getWorld(character.worldId);
  return {
    app: BUNDLE_APP_ID,
    version: BUNDLE_VERSION,
    kind: "character",
    exportedAt: new Date().toISOString(),
    characters: [{ ...character, avatar: await exportAvatar(character.avatar) }],
    ...(world ? { worlds: [world] } : {}),
  };
}

/** Triggers a browser download of a single-character export as a formatted `.json` file. */
export function downloadCharacterExport(file: CharacterExportFile): void {
  const json = JSON.stringify(file, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const namePart = sanitizeFileNamePart(file.characters[0]?.sheet?.name ?? "");
  const dateStamp = file.exportedAt.slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tc-town-character-${namePart}-${dateStamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- Import ------------------------------------------------------------------

function hasCharactersArrayShape(value: unknown): value is Record<string, unknown> & { characters: unknown[] } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.app === BUNDLE_APP_ID && Array.isArray(v.characters);
}

/** Parses and lightly sanitizes a bundle JSON string. Throws a user-facing message on invalid input. */
export function parseExportBundle(raw: string): ExportBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("JSONの解析に失敗しました。ファイルが壊れている可能性があります。");
  }
  if (!hasCharactersArrayShape(parsed) || typeof parsed.version !== "number") {
    throw new Error("TC Townのバックアップファイルとして認識できませんでした。");
  }
  return {
    app: BUNDLE_APP_ID,
    version: parsed.version,
    exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : new Date().toISOString(),
    appSettings: sanitizeAppSettings(parsed.appSettings),
    providerSettings: sanitizeSettings(parsed.providerSettings),
    characters: parsed.characters as ExportedCharacter[],
    worlds: sanitizeWorldsField(parsed.worlds),
  };
}

/** Defensively sanitizes an optional `worlds` field found on either bundle shape — malformed entries are dropped rather than failing the whole parse. */
function sanitizeWorldsField(value: unknown): WorldSetting[] {
  if (!Array.isArray(value)) return [];
  const out: WorldSetting[] = [];
  for (const entry of value) {
    const world = coerceWorld(entry);
    if (world) out.push(world);
  }
  return out;
}

export interface ParsedCharacterImport {
  characters: ExportedCharacter[];
  /** World settings bundled alongside the character(s) (empty for older files without any). */
  worlds: WorldSetting[];
}

/**
 * Parses either a single-character export file or a full backup bundle and
 * returns the `ExportedCharacter[]` it contains (a full backup yields every
 * character it holds — importing one is treated the same as importing many)
 * plus any world settings bundled alongside them. Throws a user-facing
 * message on invalid input.
 */
export function parseCharacterImport(raw: string): ParsedCharacterImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("JSONの解析に失敗しました。ファイルが壊れている可能性があります。");
  }
  if (!hasCharactersArrayShape(parsed)) {
    throw new Error("TC Townのキャラクターファイルとして認識できませんでした。");
  }
  return {
    characters: parsed.characters as ExportedCharacter[],
    worlds: sanitizeWorldsField((parsed as Record<string, unknown>).worlds),
  };
}

// Uint8Array's `.buffer` is typed as ArrayBufferLike (may be a SharedArrayBuffer),
// but Blob/File parts require a concrete ArrayBuffer — same copy tc-vrm-viewer's
// library.ts does in checksumOf().
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

interface ImportedAvatarResult {
  avatar: Avatar | null;
  /** True when a reference-only VRM avatar had no matching checksum in the shared library. */
  missingVrm: boolean;
}

async function importAvatar(avatar: ExportedAvatar | null): Promise<ImportedAvatarResult> {
  if (!avatar) return { avatar: null, missingVrm: false };

  if (avatar.kind === "image") {
    const bytes = bytesFromDataUrl(avatar.dataUrl);
    const blobKey = crypto.randomUUID();
    await putBlob(blobKey, new Blob([toArrayBuffer(bytes)], { type: avatar.mime }));
    return { avatar: { kind: "image", blobKey, mime: avatar.mime }, missingVrm: false };
  }

  // Backward compat: pre-lightweight-export files embedded the VRM bytes
  // directly as a dataUrl. The current type no longer declares that field,
  // so check for it defensively at runtime.
  const legacy = avatar as unknown as { dataUrl?: string; mime?: string };
  if (typeof legacy.dataUrl === "string") {
    const bytes = bytesFromDataUrl(legacy.dataUrl);
    const mime = legacy.mime || "model/gltf-binary";
    const file = new File([toArrayBuffer(bytes)], avatar.fileName || "avatar.vrm", { type: mime });
    const info = await importVrmFile(file); // dedupes on checksum against the shared library
    return {
      avatar: { kind: "vrm", blobKey: info.id, checksum: info.checksum, fileName: avatar.fileName || file.name },
      missingVrm: false,
    };
  }

  // Current format: resolve against the shared VRM library by checksum. If
  // the model isn't there, import the character without its avatar instead
  // of failing — the user can re-attach it from the library later.
  const models = await listVrmModels();
  const match = models.find((model) => model.checksum === avatar.checksum);
  if (!match) return { avatar: null, missingVrm: true };
  return {
    avatar: { kind: "vrm", blobKey: match.id, checksum: match.checksum, fileName: avatar.fileName || match.name },
    missingVrm: false,
  };
}

export interface ImportCharactersResult {
  added: number;
  updated: number;
  skipped: number;
  /** Characters whose VRM avatar wasn't found in the shared library and were imported without an avatar. */
  missingVrm: number;
}

/**
 * Imports every character in the list, upserting by id (a re-import of the
 * same backup updates in place rather than duplicating). Malformed entries
 * are dropped defensively rather than throwing, so one bad record doesn't
 * abort the whole import.
 */
export async function importExportedCharacters(list: ExportedCharacter[]): Promise<ImportCharactersResult> {
  const existingIds = new Set(listCharacters().map((c) => c.id));
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let missingVrm = 0;

  for (const exported of list) {
    const base = coerceCharacter({ ...exported, avatar: null });
    if (!base) {
      skipped += 1;
      continue;
    }
    const { avatar, missingVrm: isMissing } = await importAvatar(exported.avatar);
    if (isMissing) missingVrm += 1;
    if (existingIds.has(base.id)) updated += 1;
    else added += 1;
    saveCharacter({ ...base, avatar });
  }

  return { added, updated, skipped, missingVrm };
}

/**
 * Merges a list of world settings into storage: an entry whose `id` matches
 * an existing world overwrites it, otherwise it's added. Malformed entries
 * are dropped defensively rather than throwing. Returns the count imported.
 */
export function importWorldSettings(list: WorldSetting[]): number {
  let count = 0;
  for (const entry of list) {
    const sanitized = coerceWorld(entry);
    if (!sanitized) continue;
    saveWorld(sanitized);
    count += 1;
  }
  return count;
}

/** Imports every world setting and character in a full backup bundle (worlds first, so characters' `worldId` resolves immediately). See {@link importExportedCharacters}. */
export async function importCharacters(bundle: ExportBundle): Promise<ImportCharactersResult> {
  importWorldSettings(bundle.worlds);
  return importExportedCharacters(bundle.characters);
}

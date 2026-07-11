// Wire and storage-payload shapes for the character catalog (see
// lib/catalog.ts). The catalog room is a single public room — mirroring
// tc-chat's global room — that every peer interested in the catalog joins:
// "public" characters are announced there via a signed CatalogEntryWire,
// "unlisted" ones are published to CID storage only and shared via a direct
// link (lib/catalog.ts's shareLinkForCid/parseCatalogShareInput), and
// unpublished characters never leave the device. Kept dependency-free from
// the P2P layer (mistClient/wireSign) so the defensive coercion here stays
// trivially unit-testable.
import type { ExportedCharacter } from "./exportImport";
import { coerceWorld, type WorldSetting } from "./worlds";

/** The on-the-wire swarm topic for the shared public character catalog. */
export const CATALOG_ROOM_ID = "tc-town-character-catalog-v1";

export type PublishVisibility = "public" | "unlisted";

/**
 * The mist `storage_add` payload for a published character, stored under
 * name `catalog-<characterId>.json`. Reuses lib/exportImport.ts's
 * ExportedCharacter shape (image avatars inlined as a dataUrl; VRM avatars
 * referenced by checksum only) plus the character's selected world setting
 * (if any) so `worldId` resolves on import, and the mist CID of the raw
 * `.vrm` bytes when the avatar is a VRM model (the bytes themselves are
 * stored separately via `storage_add`, not embedded in this JSON payload).
 */
export interface CatalogPayloadV1 {
  app: "tc-town";
  kind: "catalog-character";
  version: 1;
  character: ExportedCharacter;
  world: WorldSetting | null;
  vrmCid?: string;
}

/** Broadcast in the catalog room when a character is published as "public". */
export interface CatalogEntryWire extends Record<string, unknown> {
  type: "tc-town:catalog-entry";
  entryId: string;
  name: string;
  summary: string;
  hasVrm: boolean;
  cid: string;
  vrmCid?: string;
  /** Author did:key. */
  fromId: string;
  fromName: string;
  publishedAt: number;
  updatedAt: number;
  signature: string;
}

/** Broadcast when a "public" character is unpublished. */
export interface CatalogRemoveWire extends Record<string, unknown> {
  type: "tc-town:catalog-remove";
  entryId: string;
  /** Author did:key — must match the targeted entry's `fromId` to be honored. */
  fromId: string;
  timestamp: number;
  signature: string;
}

/**
 * Broadcast once on joining the catalog room so peers already holding a wire
 * log can replay it directly to the requester (see lib/catalog.ts's
 * connectCatalog). Unlike the other wires this one is not signed — it carries
 * no state to protect, only a return address.
 */
export interface CatalogHistoryRequestWire extends Record<string, unknown> {
  type: "tc-town:catalog-history-request";
  fromId: string;
  timestamp: number;
}

/** The two wire kinds that get logged for history replay. */
export type SignedCatalogWire = CatalogEntryWire | CatalogRemoveWire;

/** One of my own published characters (localStorage `tc-town:catalog-published-v1`). */
export interface PublishState {
  characterId: string;
  visibility: PublishVisibility;
  cid: string;
  vrmCid?: string;
  publishedAt: number;
  updatedAt: number;
}

/**
 * A learned public-catalog entry (localStorage `tc-town:catalog-directory-v1`,
 * keyed by `entryId`) — the CatalogEntryWire fields minus `type`/`signature`,
 * plus when this device learned of it.
 */
export interface CatalogEntry {
  entryId: string;
  name: string;
  summary: string;
  hasVrm: boolean;
  cid: string;
  vrmCid?: string;
  fromId: string;
  fromName: string;
  publishedAt: number;
  updatedAt: number;
  receivedAt: number;
}

/** This device's author display name for entries it publishes (localStorage `tc-town:catalog-profile-v1`). */
export interface CatalogProfile {
  displayName: string;
}

// --- defensive parsing --------------------------------------------------------

function isStringField(value: unknown): value is string {
  return typeof value === "string";
}

/** Loose structural check — just enough to know `character` is a coercible ExportedCharacter, not a full revalidation (that happens downstream via characterStorage's coerceCharacter when the entry is actually imported). */
function isExportedCharacterShape(value: unknown): value is ExportedCharacter {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return isStringField(c.id) && c.id !== "" && typeof c.sheet === "object" && c.sheet !== null;
}

/**
 * Defensively parses a `storage_get`-fetched catalog payload. Returns null
 * for anything malformed rather than throwing, so one bad/foreign CID can't
 * break a fetch — mirrors coerceCharacter/coerceWorld's approach.
 */
export function coerceCatalogPayload(value: unknown): CatalogPayloadV1 | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (p.app !== "tc-town" || p.kind !== "catalog-character" || p.version !== 1) return null;
  if (!isExportedCharacterShape(p.character)) return null;
  const world = p.world && typeof p.world === "object" ? coerceWorld(p.world) : null;
  const payload: CatalogPayloadV1 = {
    app: "tc-town",
    kind: "catalog-character",
    version: 1,
    character: p.character as ExportedCharacter,
    world,
  };
  if (isStringField(p.vrmCid) && p.vrmCid !== "") payload.vrmCid = p.vrmCid;
  return payload;
}

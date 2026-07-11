// Public character catalog — publish a character (public or unlisted),
// browse/consume what others have published, and share a direct link to a
// single unlisted character. Built on the same signed-wire + storage_add/CID
// + wire-log-replay pattern proven by tc-chat's post stream (see
// usePostStream.ts/useHistorySync.ts/chatStore.ts) and tc-town's own
// crypto/didIdentity.ts + lib/wireSign.ts.
//
// Everything here is lazy: importing this module never touches the mist
// node. Only connectCatalog(), publishCharacter(), fetchCatalogPayload() and
// importCatalogEntry() do — the last two because storage_get/storage_add
// need the mistlib wasm runtime initialized (via getNode()) regardless of
// whether the catalog *room* has been joined, e.g. resolving a share link
// without ever browsing the public catalog.
import {
  getNode,
  subscribeEvent,
  isRawEvent,
  decodeRawPayload,
  localNodeId,
  storage_add,
  storage_get,
  DELIVERY_RELIABLE,
} from "./mistClient";
import { signWireFields, verifyWire } from "./wireSign";
import { ensureDidIdentity } from "../crypto/didIdentity";
import { buildCharacterExportFile, importExportedCharacters, importWorldSettings } from "./exportImport";
import { getCharacter, saveCharacter, subscribeCharacters } from "./characterStorage";
import { getVrmBytesForAvatar, importVrmFile } from "../vrm/library";
import {
  CATALOG_ROOM_ID,
  coerceCatalogPayload,
  type CatalogEntryWire,
  type CatalogHistoryRequestWire,
  type CatalogPayloadV1,
  type CatalogRemoveWire,
  type PublishState,
  type PublishVisibility,
} from "./catalogTypes";
import {
  appendCatalogWireLog,
  getCatalogEntry,
  getCatalogProfile,
  getPublishState,
  listPublished,
  loadCatalogWireLog,
  removeCatalogEntry,
  removePublishState,
  upsertCatalogEntry,
  upsertPublishState,
} from "./catalogStore";

// Read-only stores + types are re-exported here so lib/catalog.ts is the one
// module Worker C's UI needs to import from.
export {
  getPublishState,
  listPublished,
  subscribePublished,
  listCatalogEntries,
  subscribeCatalogDirectory,
  getCatalogProfile,
  setCatalogProfile,
  subscribeCatalogProfile,
} from "./catalogStore";
export type {
  CatalogEntry,
  CatalogEntryWire,
  CatalogPayloadV1,
  CatalogProfile,
  CatalogRemoveWire,
  PublishState,
  PublishVisibility,
} from "./catalogTypes";

const HISTORY_REQUEST_DELAY_MS = 700;
const ANSWER_THROTTLE_MS = 3000;
const REPUBLISH_DEBOUNCE_MS = 2000;

// --- publishing -----------------------------------------------------------------

function isWellFormedEntryWire(wire: CatalogEntryWire): boolean {
  return (
    typeof wire.entryId === "string" &&
    wire.entryId !== "" &&
    typeof wire.name === "string" &&
    typeof wire.summary === "string" &&
    typeof wire.hasVrm === "boolean" &&
    typeof wire.cid === "string" &&
    wire.cid !== "" &&
    typeof wire.fromId === "string" &&
    wire.fromId !== "" &&
    typeof wire.fromName === "string" &&
    typeof wire.publishedAt === "number" &&
    typeof wire.updatedAt === "number" &&
    (wire.vrmCid === undefined || typeof wire.vrmCid === "string")
  );
}

/**
 * Exports the character (reusing lib/exportImport.ts), uploads the VRM bytes
 * (if the avatar is a VRM model) and the catalog payload to mist storage,
 * and upserts local PublishState. When `visibility` is "public" this also
 * joins the catalog room and broadcasts a signed CatalogEntryWire; an
 * "unlisted" publish never touches the network beyond the two storage_add
 * calls (it's discoverable only via shareLinkForCid).
 */
export async function publishCharacter(
  characterId: string,
  visibility: PublishVisibility,
): Promise<PublishState> {
  const character = getCharacter(characterId);
  if (!character) throw new Error(`catalog: character not found: ${characterId}`);

  const file = await buildCharacterExportFile(character);
  const exportedCharacter = file.characters[0];
  const world = file.worlds?.[0] ?? null;

  let vrmCid: string | undefined;
  if (character.avatar?.kind === "vrm") {
    const bytes = await getVrmBytesForAvatar(character.avatar.blobKey, character.avatar.checksum);
    if (bytes) vrmCid = await storage_add(character.avatar.fileName || "avatar.vrm", bytes);
  }

  const payload: CatalogPayloadV1 = {
    app: "tc-town",
    kind: "catalog-character",
    version: 1,
    character: exportedCharacter,
    world,
  };
  if (vrmCid) payload.vrmCid = vrmCid;

  const cid = await storage_add(
    `catalog-${characterId}.json`,
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  const now = Date.now();
  const existing = getPublishState(characterId);
  const nextState: PublishState = {
    characterId,
    visibility,
    cid,
    vrmCid,
    publishedAt: existing?.publishedAt ?? now,
    updatedAt: now,
  };
  upsertPublishState(nextState);
  markRepublishBaseline(characterId, character.updatedAt);

  if (visibility === "public") {
    await connectCatalog();
    const identity = await ensureDidIdentity();
    const profile = getCatalogProfile();
    const unsigned = {
      type: "tc-town:catalog-entry" as const,
      entryId: characterId,
      name: character.sheet.name || "",
      summary: character.sheet.summary || "",
      hasVrm: character.avatar?.kind === "vrm",
      cid,
      ...(vrmCid ? { vrmCid } : {}),
      fromId: identity.did,
      fromName: profile.displayName,
      publishedAt: nextState.publishedAt,
      updatedAt: nextState.updatedAt,
    };
    const wire: CatalogEntryWire = { ...unsigned, signature: await signWireFields(unsigned) };
    const node = await getNode();
    node.sendMessage(null, wire, DELIVERY_RELIABLE, CATALOG_ROOM_ID);
    appendCatalogWireLog(wire);
    // Own broadcasts aren't echoed back by mist, so reflect it into the local
    // directory view directly (same optimistic-update approach as tc-chat's
    // usePostStream) — the catalog listing should include my own public
    // characters without a network round trip.
    upsertCatalogEntry({
      entryId: wire.entryId,
      name: wire.name,
      summary: wire.summary,
      hasVrm: wire.hasVrm,
      cid: wire.cid,
      vrmCid: wire.vrmCid,
      fromId: wire.fromId,
      fromName: wire.fromName,
      publishedAt: wire.publishedAt,
      updatedAt: wire.updatedAt,
      receivedAt: Date.now(),
    });
  }

  return nextState;
}

/** Removes local PublishState; if it was "public", also broadcasts a signed removal so peers drop it from their directory. */
export async function unpublishCharacter(characterId: string): Promise<void> {
  const existing = getPublishState(characterId);
  if (!existing) return;
  removePublishState(characterId);
  clearRepublishBaseline(characterId);

  if (existing.visibility === "public") {
    await connectCatalog();
    const identity = await ensureDidIdentity();
    const unsigned = {
      type: "tc-town:catalog-remove" as const,
      entryId: characterId,
      fromId: identity.did,
      timestamp: Date.now(),
    };
    const wire: CatalogRemoveWire = { ...unsigned, signature: await signWireFields(unsigned) };
    const node = await getNode();
    node.sendMessage(null, wire, DELIVERY_RELIABLE, CATALOG_ROOM_ID);
    appendCatalogWireLog(wire);
    removeCatalogEntry(characterId);
  }
}

// --- auto-republish on character edit --------------------------------------------
//
// Watches every locally-published character (via characterStorage's
// subscribeCharacters) and, when its `updatedAt` changes, re-runs
// publishCharacter with the same visibility after a short debounce — so a
// public/unlisted character's catalog listing/payload stays in sync with
// edits without the user having to manually republish. Started eagerly at
// module load: subscribeCharacters() is pure localStorage (no mist node
// init), so this costs nothing until a published character is actually
// edited, at which point publishCharacter() lazily connects as normal.

const republishBaseline = new Map<string, string>();
const republishTimers = new Map<string, ReturnType<typeof setTimeout>>();

function markRepublishBaseline(characterId: string, updatedAt: string): void {
  republishBaseline.set(characterId, updatedAt);
}

function clearRepublishBaseline(characterId: string): void {
  republishBaseline.delete(characterId);
  const timer = republishTimers.get(characterId);
  if (timer) {
    clearTimeout(timer);
    republishTimers.delete(characterId);
  }
}

function scheduleAutoRepublish(state: PublishState, updatedAt: string): void {
  markRepublishBaseline(state.characterId, updatedAt);
  const existingTimer = republishTimers.get(state.characterId);
  if (existingTimer) clearTimeout(existingTimer);
  republishTimers.set(
    state.characterId,
    setTimeout(() => {
      republishTimers.delete(state.characterId);
      void publishCharacter(state.characterId, state.visibility).catch((error) => {
        console.warn("catalog: auto-republish failed", state.characterId, error);
      });
    }, REPUBLISH_DEBOUNCE_MS),
  );
}

subscribeCharacters(() => {
  for (const state of listPublished()) {
    const character = getCharacter(state.characterId);
    if (!character) continue;
    if (republishBaseline.get(state.characterId) === character.updatedAt) continue;
    scheduleAutoRepublish(state, character.updatedAt);
  }
});

// --- consuming: connect / disconnect from the catalog room -----------------------

let connectPromise: Promise<void> | null = null;
let unsubscribeEvent: (() => void) | null = null;
let joined = false;

async function handleEntryWire(wire: CatalogEntryWire): Promise<void> {
  if (!isWellFormedEntryWire(wire)) return;
  if (!(await verifyWire(wire))) {
    console.warn("catalog: discarding entry wire with invalid signature", wire.entryId);
    return;
  }
  const existing = getCatalogEntry(wire.entryId);
  if (existing && existing.fromId !== wire.fromId) return; // first-seen wins
  upsertCatalogEntry({
    entryId: wire.entryId,
    name: wire.name,
    summary: wire.summary,
    hasVrm: wire.hasVrm,
    cid: wire.cid,
    vrmCid: wire.vrmCid,
    fromId: wire.fromId,
    fromName: wire.fromName,
    publishedAt: wire.publishedAt,
    updatedAt: wire.updatedAt,
    receivedAt: Date.now(),
  });
  appendCatalogWireLog(wire);
}

async function handleRemoveWire(wire: CatalogRemoveWire): Promise<void> {
  if (typeof wire.entryId !== "string" || wire.entryId === "") return;
  if (!(await verifyWire(wire))) {
    console.warn("catalog: discarding remove wire with invalid signature", wire.entryId);
    return;
  }
  const existing = getCatalogEntry(wire.entryId);
  if (!existing || existing.fromId !== wire.fromId) return; // author-only, mirrors tc-chat's applyPostDelete
  removeCatalogEntry(wire.entryId);
  appendCatalogWireLog(wire);
}

/**
 * Joins the catalog room, starts listening for entry/remove/history-request
 * wires, and broadcasts a one-shot history request so any peer already
 * holding a wire log replays it here (mirrors tc-chat's useHistorySync).
 * Idempotent — safe to call repeatedly (e.g. once per view that needs the
 * catalog); a second call while already connecting/connected returns the
 * same in-flight/resolved promise.
 */
export async function connectCatalog(): Promise<void> {
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    const node = await getNode();
    await node.joinRoomAsync(CATALOG_ROOM_ID);
    joined = true;

    const answeredAt = new Map<string, number>();

    function replayHistoryTo(requesterNodeId: string) {
      const now = Date.now();
      if (now - (answeredAt.get(requesterNodeId) ?? 0) < ANSWER_THROTTLE_MS) return;
      answeredAt.set(requesterNodeId, now);
      const log = loadCatalogWireLog();
      if (log.length === 0) return;
      // A little jitter so multiple responders don't burst simultaneously.
      setTimeout(() => {
        if (!joined) return;
        for (const wire of log) node.sendMessage(requesterNodeId, wire, DELIVERY_RELIABLE, CATALOG_ROOM_ID);
      }, Math.random() * 400);
    }

    unsubscribeEvent = subscribeEvent((eventType, fromId, payload, roomId) => {
      if (!isRawEvent(eventType)) return;
      if (roomId && roomId !== CATALOG_ROOM_ID) return; // not this room's traffic
      const decoded = decodeRawPayload(payload) as
        | CatalogEntryWire
        | CatalogRemoveWire
        | CatalogHistoryRequestWire
        | null;
      if (!decoded || typeof decoded !== "object") return;
      if (decoded.type === "tc-town:catalog-entry") {
        void handleEntryWire(decoded as CatalogEntryWire);
      } else if (decoded.type === "tc-town:catalog-remove") {
        void handleRemoveWire(decoded as CatalogRemoveWire);
      } else if (decoded.type === "tc-town:catalog-history-request") {
        if (fromId === localNodeId()) return; // ignore our own broadcast echo
        replayHistoryTo(fromId);
      }
    });

    // Ask once, after the wire listener above has had time to be registered.
    setTimeout(() => {
      if (!joined) return;
      void ensureDidIdentity().then((identity) => {
        const request: CatalogHistoryRequestWire = {
          type: "tc-town:catalog-history-request",
          fromId: identity.did,
          timestamp: Date.now(),
        };
        node.sendMessage(null, request, DELIVERY_RELIABLE, CATALOG_ROOM_ID);
      });
    }, HISTORY_REQUEST_DELAY_MS);
  })();
  return connectPromise;
}

/** Leaves the catalog room (never the parameterless leaveRoom() — that would tear down the whole shared node). No-op if never connected. */
export function disconnectCatalog(): void {
  if (unsubscribeEvent) {
    unsubscribeEvent();
    unsubscribeEvent = null;
  }
  const wasJoined = joined;
  joined = false;
  connectPromise = null;
  if (!wasJoined) return;
  void getNode()
    .then((node) => node.leaveRoom(CATALOG_ROOM_ID))
    .catch((error) => {
      console.warn("catalog: failed to leave catalog room", error);
    });
}

// --- fetching + importing a catalog payload --------------------------------------

/** Fetches and defensively parses a CatalogPayloadV1 by its mist CID (e.g. from a CatalogEntry or a share link). Returns null on any failure — a bad/foreign CID never throws. */
export async function fetchCatalogPayload(cid: string): Promise<CatalogPayloadV1 | null> {
  if (!cid) return null;
  try {
    await getNode(); // storage_get needs the mistlib wasm runtime initialized, independent of room membership
    const bytes = await storage_get(cid);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return coerceCatalogPayload(parsed);
  } catch (error) {
    console.warn("catalog: failed to fetch catalog payload", cid, error);
    return null;
  }
}

/**
 * Imports a fetched catalog payload: the bundled world setting first (so
 * `worldId` resolves immediately), then the character itself, reusing
 * lib/exportImport.ts's existing import path (upsert-by-id, defensive avatar
 * resolution). If the avatar is a VRM not already in the shared library
 * (checksum miss) and the payload carries `vrmCid`, fetches the raw bytes and
 * imports them into the shared VRM library, then re-links the character's
 * avatar to it.
 */
export async function importCatalogEntry(
  payload: CatalogPayloadV1,
): Promise<{ characterId: string; missingVrm: boolean }> {
  if (payload.world) importWorldSettings([payload.world]);
  const result = await importExportedCharacters([payload.character]);
  const characterId = payload.character.id;
  let missingVrm = result.missingVrm > 0;

  if (missingVrm && payload.vrmCid && payload.character.avatar?.kind === "vrm") {
    try {
      await getNode();
      const bytes = await storage_get(payload.vrmCid);
      const fileName = payload.character.avatar.fileName || "avatar.vrm";
      const arrayBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const file = new File([arrayBuffer], fileName, { type: "model/gltf-binary" });
      const info = await importVrmFile(file);
      const character = getCharacter(characterId);
      if (character) {
        saveCharacter({
          ...character,
          avatar: { kind: "vrm", blobKey: info.id, checksum: info.checksum, fileName },
        });
        missingVrm = false;
      }
    } catch (error) {
      console.warn("catalog: failed to import vrm bytes for", characterId, error);
    }
  }

  return { characterId, missingVrm };
}

// --- share links -------------------------------------------------------------------

/** Builds a direct link to a published payload's CID (works for both public and unlisted publishes). */
export function shareLinkForCid(cid: string): string {
  return `${location.origin}${location.pathname}#catalog=${encodeURIComponent(cid)}`;
}

const BARE_CID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** Accepts either a full share URL (containing `#catalog=<cid>`) or a bare CID; returns the CID, or null if nothing recognizable was found. */
export function parseCatalogShareInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const marker = "#catalog=";
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex !== -1) {
    const rest = trimmed.slice(markerIndex + marker.length).split(/[&#]/)[0]?.trim();
    if (!rest) return null;
    try {
      const decoded = decodeURIComponent(rest);
      return decoded || null;
    } catch {
      return rest || null;
    }
  }

  // Not a share URL — only accept it as a bare CID if it can't be mistaken
  // for some other kind of link/text (no whitespace, no scheme separator).
  if (/\s/.test(trimmed) || trimmed.includes("://")) return null;
  return BARE_CID_PATTERN.test(trimmed) ? trimmed : null;
}

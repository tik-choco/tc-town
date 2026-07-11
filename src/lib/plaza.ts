// ひろば "plaza stage" — picks up to N actors (a mix of other people's
// published characters and the user's own) and runs a short, ephemeral,
// non-persisted ambient conversation between them for the CatalogView stage.
//
// Deliberately reuses the existing single-user-facing building blocks rather
// than re-inventing them:
//   - characterStorage.coerceCharacter / toPersonaPrompt for defensively
//     turning a remote (network-sourced, never fully trusted) catalog payload
//     into the same CharacterSheet shape + persona-prompt compiler used
//     everywhere else in the app.
//   - lib/llm.ts's requestChatCompletion for the actual streaming call —
//     the exact same entry point ChatView's ConversationEngine uses.
//   - lib/llmConfig.ts's resolvePreset/DEFAULT_LLM_PROFILE_ID for "is an LLM
//     configured" and to resolve the shared default preset.
//   - vrm/library.ts's importVrmFile (checksum-dedup) + listVrmModels to
//     cache a remote VRM into the same shared library CharacterAvatar's VRM
//     bust already knows how to render, without inventing a second VRM path.
//
// What's intentionally NOT reused as-is: lib/conversation.ts's
// ConversationEngine/buildCharacterMessages. Both are tightly coupled to a
// *persisted* ConversationSession and to Character.worldId being resolvable
// via lib/worlds.ts's local store — neither holds for an ephemeral plaza
// actor built from a one-off remote payload (its bundled WorldSetting may
// not exist locally, and it must never be written to local storage just for
// being displayed on the stage). The turn-taking heuristic and the
// system/assistant/user transcript-flattening convention are therefore
// re-implemented here at the same shape (see buildPlazaMessages /
// pickNextPlazaSpeaker below), deliberately mirroring
// ConversationEngine.pickNextSpeaker and buildCharacterMessages line for
// line so the two stay easy to compare. ChatView and lib/conversation.ts are
// untouched by this file.

import type { Avatar, Character, ChatMessage, VrmAvatar } from "../types";
import { DEFAULT_LLM_PROFILE_ID } from "../types";
import { coerceCharacter, listCharacters, toPersonaPrompt } from "./characterStorage";
import { requestChatCompletion } from "./llm";
import { emptyLlmConfig, loadLlmConfig, resolvePreset } from "./llmConfig";
import { getNode, storage_get } from "./mistClient";
import { ensureDidIdentity } from "../crypto/didIdentity";
import { fetchCatalogPayload, listCatalogEntries, type CatalogEntry } from "./catalog";
import { importVrmFile, listVrmModels } from "../vrm/library";
import { maybeClassifyEmotion } from "./emotionClassifier";

/** Once a streamed line reaches this length, fire the emotion classifier early instead of waiting for the full line — mirrors lib/conversation.ts's doGenerate. */
const EMOTION_CLASSIFY_MIN_LENGTH = 60;

// -----------------------------------------------------------------------------
// Actor model
// -----------------------------------------------------------------------------

/** Everything CharacterAvatar-compatible rendering needs, or a raw inline image (remote payloads carry the avatar bytes as a dataUrl, not a local blobKey), or nothing. */
export type PlazaAvatarSpec = Avatar | { imageDataUrl: string } | null;

export interface PlazaActor {
  /**
   * Stable identity for this stage session — "mine:<characterId>" or
   * "hiroba:<entryId>". This is also the `character.id` CatalogView's
   * ActorStageAvatar passes to CharacterAvatar for VRM/placeholder actors, so
   * startPlazaTalk's emotion classification calls use this same key — never
   * `characterId` — to key the (per-render-context) expression store.
   */
  key: string;
  name: string;
  summary: string;
  /** Fully compiled system-prompt persona block (characterStorage.toPersonaPrompt output). */
  personaPrompt: string;
  origin: "mine" | "hiroba";
  /** Present for origin "hiroba" — the source catalog entry (author, cid, ...). */
  entry?: CatalogEntry;
  /** Present for origin "mine" — lets the popover/import flow tell it's already a local character. */
  characterId?: string;
  avatar: PlazaAvatarSpec;
}

// -----------------------------------------------------------------------------
// Actor preparation
// -----------------------------------------------------------------------------

function shuffled<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function ownActorFromCharacter(character: Character): PlazaActor {
  return {
    key: `mine:${character.id}`,
    name: character.sheet.name.trim() || "（無名のキャラクター）",
    summary: character.sheet.summary,
    personaPrompt: toPersonaPrompt(character.sheet),
    origin: "mine",
    characterId: character.id,
    avatar: character.avatar,
  };
}

/** ArrayBuffer view over a Uint8Array without copying, for File/Blob construction. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Resolves a remote VRM avatar to a local VrmAvatar the shared bust renderer
 * can load: the shared library by checksum first (already imported by this
 * device, e.g. via a prior character import — no network trip needed), else
 * fetches the raw bytes by `vrmCid` and imports them (importVrmFile dedupes
 * by checksum, so repeated stage visits never duplicate the model). Returns
 * null — never throws — if the checksum can't be matched and there's no
 * vrmCid, or the fetch/import fails.
 */
async function resolveHirobaVrmAvatar(
  checksum: string,
  fileName: string,
  vrmCid: string | undefined,
): Promise<VrmAvatar | null> {
  try {
    const models = await listVrmModels();
    const existing = models.find((m) => m.checksum === checksum);
    if (existing) {
      return { kind: "vrm", blobKey: existing.id, checksum: existing.checksum, fileName: fileName || existing.name };
    }
    if (!vrmCid) return null;
    await getNode();
    const bytes = await storage_get(vrmCid);
    const file = new File([toArrayBuffer(bytes)], fileName || "avatar.vrm", { type: "model/gltf-binary" });
    const info = await importVrmFile(file);
    return { kind: "vrm", blobKey: info.id, checksum: info.checksum, fileName: fileName || file.name };
  } catch (error) {
    console.warn("plaza: failed to resolve hiroba vrm avatar", error);
    return null;
  }
}

/**
 * Fetches and resolves one ひろば catalog entry into a stage-ready actor.
 * Never throws — any failure (unreachable CID, malformed payload, missing
 * VRM bytes) resolves to null so Promise.allSettled callers can just filter.
 */
async function resolveHirobaActor(entry: CatalogEntry): Promise<PlazaActor | null> {
  try {
    const payload = await fetchCatalogPayload(entry.cid);
    if (!payload) return null;

    // Reuse characterStorage's own defensive sheet coercion rather than
    // re-validating field-by-field here — a network payload is no more
    // trustworthy than anything else read from storage.
    const coerced = coerceCharacter({ id: entry.entryId, sheet: payload.character.sheet });
    const sheet = coerced?.sheet ?? { ...payload.character.sheet, name: entry.name, summary: entry.summary };
    const name = sheet.name.trim() || entry.name || "（無名のキャラクター）";

    let avatar: PlazaAvatarSpec = null;
    const exportedAvatar = payload.character.avatar;
    if (exportedAvatar && exportedAvatar.kind === "image" && typeof exportedAvatar.dataUrl === "string") {
      avatar = { imageDataUrl: exportedAvatar.dataUrl };
    } else if (exportedAvatar && exportedAvatar.kind === "vrm" && typeof exportedAvatar.checksum === "string" && exportedAvatar.checksum) {
      avatar = await resolveHirobaVrmAvatar(exportedAvatar.checksum, exportedAvatar.fileName ?? "", payload.vrmCid);
    }

    return {
      key: `hiroba:${entry.entryId}`,
      name,
      summary: sheet.summary || entry.summary,
      personaPrompt: toPersonaPrompt(sheet, payload.world ?? undefined),
      origin: "hiroba",
      entry,
      avatar,
    };
  } catch (error) {
    console.warn("plaza: failed to resolve hiroba actor", entry.entryId, error);
    return null;
  }
}

/**
 * Picks up to `max` stage actors: ひろば entries (other people's published
 * characters, newest-first bias, own DID excluded when resolvable) fill the
 * stage first, and any remaining slots are filled from the user's own
 * characters. All remote resolution runs independently via
 * Promise.allSettled so one slow/unreachable CID can't block the rest of the
 * stage from appearing.
 */
export async function preparePlazaActors(max = 4): Promise<PlazaActor[]> {
  let ownDid: string | null = null;
  try {
    ownDid = (await ensureDidIdentity()).did;
  } catch {
    // Non-fatal — just means we can't tell our own entries apart from others'.
  }

  const hirobaCandidates = listCatalogEntries().filter((e) => !ownDid || e.fromId !== ownDid);
  // listCatalogEntries() is already newest-first (publishedAt desc); sample a
  // shuffled slice of the front of that list so "member swap" feels
  // different each time without losing the newest-first bias entirely.
  const pool = shuffled(hirobaCandidates.slice(0, Math.max(max * 3, 12)));
  const attempts = pool.slice(0, Math.max(max * 2, max));

  const settled = await Promise.allSettled(attempts.map(resolveHirobaActor));
  const hirobaActors: PlazaActor[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) hirobaActors.push(result.value);
  }
  const trimmedHiroba = hirobaActors.slice(0, max);

  const remaining = max - trimmedHiroba.length;
  const ownActors =
    remaining > 0 ? shuffled(listCharacters()).slice(0, remaining).map(ownActorFromCharacter) : [];

  return [...trimmedHiroba, ...ownActors];
}

// -----------------------------------------------------------------------------
// Conversation runner
// -----------------------------------------------------------------------------

const PLAZA_SCENE_INSTRUCTION =
  "あなたは今、ひろば（町の広場）で他のキャラクターたちと立ち話をしています。世間話のように、1〜2文の短い言葉で気軽に話してください。日本語で話してください。";

const PLAZA_TURN_DELAY_MS = 900;

interface PlazaTranscriptEntry {
  speakerKey: string;
  text: string;
}

/** Mirrors ConversationEngine.pickNextSpeaker: prefer whoever was just mentioned by name, otherwise round-robin, never repeat the immediately previous speaker. */
function pickNextPlazaSpeaker(actors: PlazaActor[], transcript: PlazaTranscriptEntry[]): PlazaActor | null {
  if (actors.length === 0) return null;
  if (actors.length === 1) return actors[0];

  const last = transcript[transcript.length - 1];
  const lastKey = last?.speakerKey;

  if (last) {
    for (const actor of actors) {
      if (actor.key === lastKey) continue;
      if (actor.name.trim() && last.text.includes(actor.name.trim())) return actor;
    }
  }

  const idx = actors.findIndex((a) => a.key === lastKey);
  let next = actors[(idx + 1) % actors.length];
  if (next.key === lastKey) next = actors[(idx + 2) % actors.length];
  return next;
}

/** Mirrors lib/conversation.ts's buildCharacterMessages: speaker's persona (+ a plaza scene instruction) as system, their own lines as assistant, everyone else's lines merged into "Name: text" user turns. */
function buildPlazaMessages(
  actors: PlazaActor[],
  transcript: PlazaTranscriptEntry[],
  speaker: PlazaActor,
): ChatMessage[] {
  const others = actors.map((a) => a.name.trim()).filter((n) => n && n !== speaker.name.trim());

  const rules = [
    "あなたは複数人の立ち話に参加している登場人物の一人です。",
    others.length > 0 ? `会話の相手: ${others.join("、")}。` : "",
    `あなたの発言だけを、${speaker.name}として一言（1メッセージ）書いてください。`,
    "名前の接頭辞（「名前:」）は付けないでください。あなたのセリフ本文だけを書きます。",
    "他の登場人物のセリフを代わりに書いたり、ト書きやメタ的な注釈（（沈黙）など）を出力しないでください。",
    "直前の発言に具体的に反応してから、自分の考えを述べてください。毎回質問で終える必要はありません。",
  ]
    .filter(Boolean)
    .join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: `${speaker.personaPrompt}\n\n${PLAZA_SCENE_INSTRUCTION}\n\n${rules}` },
  ];

  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length > 0) {
      messages.push({ role: "user", content: buffer.join("\n") });
      buffer = [];
    }
  };

  for (const entry of transcript) {
    if (entry.speakerKey === speaker.key) {
      flush();
      messages.push({ role: "assistant", content: entry.text });
    } else {
      const name = actors.find((a) => a.key === entry.speakerKey)?.name ?? "誰か";
      buffer.push(`${name}: ${entry.text}`);
    }
  }
  flush();

  messages.push({ role: "user", content: `（${speaker.name}として、次の発言を書いてください。）` });
  return messages;
}

/** True when the default LLM preset has enough set to attempt a request (mirrors SettingsView's upstreamConfigured check). */
export function hasConfiguredLlmProfile(): boolean {
  const cfg = loadLlmConfig() ?? emptyLlmConfig();
  const target = resolvePreset(cfg, DEFAULT_LLM_PROFILE_ID);
  return Boolean(target?.baseUrl.trim() && target?.model.trim());
}

export interface PlazaTalkHandlers {
  /** Hard cap on total lines generated this run — never exceeded regardless of errors/retries. Defaults to 8. */
  maxTurns?: number;
  onLine?: (actorKey: string, text: string, info: { streaming: boolean }) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

export interface PlazaTalkHandle {
  stop: () => void;
}

/**
 * Runs a short ambient character<->character conversation across `actors`,
 * streaming each line through `onLine`. Never persists anything (no
 * ConversationSession, nothing written to localStorage) — the transcript
 * lives only for the duration of this call. Always uses the app's default
 * LLM profile (remote actors' own llmProfileId, if any, is meaningless on
 * this device). Callers MUST call the returned stop() on unmount/view
 * switch; it aborts the in-flight request and cancels the inter-turn delay.
 */
export function startPlazaTalk(actors: PlazaActor[], handlers: PlazaTalkHandlers = {}): PlazaTalkHandle {
  const maxTurns = Math.min(8, handlers.maxTurns ?? 8);
  let stopped = false;
  let currentAbort: AbortController | null = null;
  let sleepCancel: (() => void) | null = null;
  const transcript: PlazaTranscriptEntry[] = [];

  function stop(): void {
    if (stopped) return;
    stopped = true;
    currentAbort?.abort();
    sleepCancel?.();
  }

  if (actors.length < 2) {
    handlers.onError?.("おしゃべりには2人以上のキャラクターが必要です。");
    return { stop };
  }
  if (!hasConfiguredLlmProfile()) {
    handlers.onError?.("LLM プロファイルが設定されていません。設定画面から接続してください。");
    return { stop };
  }

  function cancelableSleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sleepCancel = null;
        resolve(true);
      }, ms);
      sleepCancel = () => {
        clearTimeout(timer);
        sleepCancel = null;
        resolve(false);
      };
    });
  }

  (async () => {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (stopped) break;
      const speaker = pickNextPlazaSpeaker(actors, transcript);
      if (!speaker) break;

      const messages = buildPlazaMessages(actors, transcript, speaker);
      const controller = new AbortController();
      currentAbort = controller;

      // Fire the emotion classifier at most once per turn, mirroring
      // ConversationEngine.doGenerate — see PlazaActor.key's doc comment for
      // why `speaker.key` (not `speaker.characterId`) is the right id here.
      let emotionClassified = false;

      try {
        const full = await requestChatCompletion(DEFAULT_LLM_PROFILE_ID, messages, {
          onDelta: (_delta, accumulated) => {
            if (stopped || controller.signal.aborted) return;
            handlers.onLine?.(speaker.key, accumulated, { streaming: true });
            if (!emotionClassified && accumulated.length >= EMOTION_CLASSIFY_MIN_LENGTH) {
              emotionClassified = true;
              maybeClassifyEmotion(speaker.key, accumulated, DEFAULT_LLM_PROFILE_ID);
            }
          },
        });
        if (stopped || controller.signal.aborted) break;

        const text = full.trim();
        if (text) {
          if (!emotionClassified) maybeClassifyEmotion(speaker.key, text, DEFAULT_LLM_PROFILE_ID);
          transcript.push({ speakerKey: speaker.key, text });
          handlers.onLine?.(speaker.key, text, { streaming: false });
        }
      } catch (error) {
        if (!stopped) handlers.onError?.(error instanceof Error ? error.message : String(error));
        break;
      } finally {
        if (currentAbort === controller) currentAbort = null;
      }

      if (stopped || turn === maxTurns - 1) break;
      const continued = await cancelableSleep(PLAZA_TURN_DELAY_MS);
      if (!continued || stopped) break;
    }
    if (!stopped) handlers.onDone?.();
  })();

  return { stop };
}

// Conversation orchestration engine for tc-town — UI-agnostic.
//
// Owns the multi-character chat session model, its localStorage persistence,
// and the turn-taking logic that drives both user->character replies and
// automatic character<->character conversation (borrowing tc-chara's
// script-style transcript and turn rules, but generating each character's line
// from their *own* persona system prompt rather than a single director model —
// this scales cleanly to N participants and keeps each voice in-character on
// OpenAI-compatible chat APIs).
//
// The engine is a small observable store: getState() + subscribe() so a Preact
// view can render the transcript, the in-progress streaming line, and drive
// CharacterAvatar's `speaking` flag, without the engine importing any UI.

import type { Character, ChatMessage } from "../types";
import { requestChatCompletion } from "./llm";
import { listCharacters, getCharacter, toPersonaPrompt } from "./characterStorage";
import { getWorld } from "./worlds";
import { maybeClassifyEmotion } from "./emotionClassifier";
import { getNode, storage_kv_get, storage_kv_set, storage_kv_delete } from "./mistClient";

/** Once a streamed reply reaches this length, fire the emotion classifier early instead of waiting for the full text — keeps the expression change from lagging noticeably behind a long reply. */
const EMOTION_CLASSIFY_MIN_LENGTH = 60;

// -----------------------------------------------------------------------------
// Persona prompt
// -----------------------------------------------------------------------------

// The canonical persona compiler lives in characterStorage.toPersonaPrompt.
// Re-exported here under the historical name so any importer of
// `buildPersonaPrompt` keeps working.
export const buildPersonaPrompt = toPersonaPrompt;

// -----------------------------------------------------------------------------
// Session model
// -----------------------------------------------------------------------------

/** A single line in the transcript. `speakerId` is "user" or a Character.id. */
export interface TranscriptEntry {
  id: string;
  speakerId: string;
  text: string;
  /** epoch millis */
  timestamp: number;
  /** Generation latency in ms, if this entry was produced by an LLM call. Absent for user lines and legacy data. */
  latencyMs?: number;
}

export const USER_SPEAKER_ID = "user";

export interface ConversationSession {
  id: string;
  title: string;
  /** Character ids participating in this session, in turn order. */
  participantIds: string[];
  transcript: TranscriptEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationConfig {
  /** Hard cap of consecutive auto turns without user input. */
  maxAutoTurns: number;
  /** Delay between auto turns, in ms. */
  autoDelayMs: number;
  /** Sampling temperature passed through to the LLM (undefined = profile default). */
  temperature?: number;
}

export const DEFAULT_CONVERSATION_CONFIG: ConversationConfig = {
  maxAutoTurns: 12,
  autoDelayMs: 1200,
};

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------
//
// Session metadata (id/title/participantIds/timestamps) lives in the small
// `tc-town:conversations` localStorage array. The transcript itself — the
// part that grows without bound as a conversation goes on — is kept out of
// localStorage entirely and persisted per-session via mistlib's OPFS-backed
// KV (storage_kv_set/get/delete) under `tc-town:conversation:<sessionId>`,
// same shared-origin quota concern tc-books hit with its own unbounded
// localStorage transcript.
//
// Backward compat: older localStorage records still have the transcript
// inlined (`{ ..., transcript: TranscriptEntry[] }`). getSession() dual-reads
// — an inline transcript array, if present on the raw record, wins over the
// KV copy — and loadSessionMetas() kicks off a one-time best-effort
// migration that copies every such inline transcript into KV and then slims
// the localStorage record down to metadata only. The migration only rewrites
// localStorage after every transcript it touched has been confirmed written
// to KV, so a failure partway through leaves the old inline data intact and
// simply retries on the next load.

const SESSIONS_KEY = "tc-town:conversations";

function transcriptKvKey(sessionId: string): string {
  return `tc-town:conversation:${sessionId}`;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.speakerId === "string" &&
    typeof e.text === "string" &&
    typeof e.timestamp === "number"
  );
}

/** Validates the required fields and sanitizes `latencyMs` (dropped if not a number, e.g. legacy data). */
function coerceTranscriptEntry(value: unknown): TranscriptEntry | null {
  if (!isTranscriptEntry(value)) return null;
  const raw = value as unknown as Record<string, unknown>;
  const latencyMs = typeof raw.latencyMs === "number" ? raw.latencyMs : undefined;
  return { id: value.id, speakerId: value.speakerId, text: value.text, timestamp: value.timestamp, latencyMs };
}

function coerceTranscript(value: unknown): TranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map(coerceTranscriptEntry).filter((e): e is TranscriptEntry => e !== null);
}

/** Session metadata only — what actually lives in the `tc-town:conversations` localStorage array. */
export interface ConversationSessionMeta {
  id: string;
  title: string;
  participantIds: string[];
  createdAt: number;
  updatedAt: number;
}

function coerceSessionMeta(value: unknown): ConversationSessionMeta | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== "string") return null;
  const participantIds = Array.isArray(s.participantIds)
    ? s.participantIds.filter((x): x is string => typeof x === "string")
    : [];
  const now = Date.now();
  return {
    id: s.id,
    title: typeof s.title === "string" && s.title.trim() ? s.title : "無題の会話",
    participantIds,
    createdAt: typeof s.createdAt === "number" ? s.createdAt : now,
    updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : now,
  };
}

/** Legacy (pre-migration) records still carry their transcript inline. Returns it, or null if this record is already metadata-only. */
function inlineTranscriptOf(value: unknown): unknown[] | null {
  if (!value || typeof value !== "object") return null;
  const t = (value as Record<string, unknown>).transcript;
  return Array.isArray(t) ? t : null;
}

function readRawSessions(): unknown[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSessionMetas(metas: ConversationSessionMeta[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(metas));
  } catch (error) {
    console.warn("conversation: failed to persist session list", error);
  }
}

// --- transcript KV read/write -----------------------------------------------

async function loadTranscript(sessionId: string): Promise<TranscriptEntry[]> {
  try {
    await getNode();
    const bytes = await storage_kv_get(transcriptKvKey(sessionId));
    if (!bytes || bytes.length === 0) return [];
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return coerceTranscript(parsed);
  } catch (error) {
    console.warn("conversation: failed to load transcript from storage", sessionId, error);
    return [];
  }
}

async function persistTranscriptUnsafe(sessionId: string, transcript: TranscriptEntry[]): Promise<void> {
  await getNode();
  const bytes = new TextEncoder().encode(JSON.stringify(transcript));
  await storage_kv_set(transcriptKvKey(sessionId), bytes);
}

// Per-session write queue so two overlapping saves (e.g. a fast auto-turn
// sequence, or an organic save racing the one-time legacy migration below)
// can never land out of order — each write waits for the previous one for
// the same session to settle before starting, so whichever call was queued
// *last* is always the one left standing.
const transcriptWriteQueues = new Map<string, Promise<void>>();

function enqueueTranscriptWrite(sessionId: string, transcript: TranscriptEntry[]): Promise<void> {
  const prior = transcriptWriteQueues.get(sessionId) ?? Promise.resolve();
  const next = prior
    .then(() => persistTranscriptUnsafe(sessionId, transcript))
    .catch((error) => {
      console.warn("conversation: failed to persist transcript", sessionId, error);
    });
  transcriptWriteQueues.set(sessionId, next);
  return next;
}

function persistTranscript(sessionId: string, transcript: TranscriptEntry[]): void {
  void enqueueTranscriptWrite(sessionId, transcript);
}

async function deleteTranscript(sessionId: string): Promise<void> {
  try {
    await getNode();
    await storage_kv_delete(transcriptKvKey(sessionId));
  } catch (error) {
    console.warn("conversation: failed to delete transcript from storage", sessionId, error);
  }
}

// --- one-time legacy migration -----------------------------------------------

let migrationStarted = false;

/** Best-effort, once per page load: if any session record still has its transcript inlined, copy every one of them into KV, then (only once all succeeded) rewrite localStorage with metadata-only records. Retries on the next load if it fails partway. */
async function migrateLegacySessions(legacyEntries: Array<Record<string, unknown>>): Promise<void> {
  try {
    for (const entry of legacyEntries) {
      if (typeof entry.id !== "string") continue;
      // If the app already independently saved this session (e.g. the user
      // sent a message in it before migration got here), that save already
      // queued the authoritative newest transcript — queueing our stale
      // migration snapshot after it would win the race and clobber it. Skip;
      // the organic write already covers this session's KV copy.
      if (transcriptWriteQueues.has(entry.id)) continue;
      await enqueueTranscriptWrite(entry.id, coerceTranscript(entry.transcript));
    }
    const slimmed = readRawSessions().map((raw) => coerceSessionMeta(raw) ?? raw);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(slimmed));
  } catch (error) {
    console.warn("conversation: legacy transcript migration failed; will retry next load", error);
    migrationStarted = false;
  }
}

function scheduleLegacyMigration(rawList: unknown[]): void {
  if (migrationStarted) return;
  const legacy = rawList.filter((v) => inlineTranscriptOf(v) !== null) as Array<Record<string, unknown>>;
  if (legacy.length === 0) return;
  migrationStarted = true;
  void migrateLegacySessions(legacy);
}

// --- public API ---------------------------------------------------------------

/** All session metadata (no transcript), most-recently-updated first. Also kicks off the one-time legacy-transcript migration if needed. */
export function loadSessionMetas(): ConversationSessionMeta[] {
  const rawList = readRawSessions();
  const metas = rawList.map(coerceSessionMeta).filter((s): s is ConversationSessionMeta => s !== null);
  metas.sort((a, b) => b.updatedAt - a.updatedAt);
  scheduleLegacyMigration(rawList);
  return metas;
}

/** All sessions, most-recently-updated first (metadata only — no transcript; see getSession() for the full session). */
export function listSessions(): ConversationSessionMeta[] {
  return loadSessionMetas();
}

/** Loads one session's full state, including its transcript (dual-read: inline legacy data if present, else KV). */
export async function getSession(id: string): Promise<ConversationSession | undefined> {
  const rawList = readRawSessions();
  const rawEntry = rawList.find(
    (v) => v && typeof v === "object" && (v as Record<string, unknown>).id === id,
  );
  const meta = coerceSessionMeta(rawEntry);
  if (!meta) return undefined;

  const inline = inlineTranscriptOf(rawEntry);
  const transcript = inline !== null ? coerceTranscript(inline) : await loadTranscript(id);

  return { ...meta, transcript };
}

export function saveSession(session: ConversationSession): void {
  const metas = loadSessionMetas().filter((s) => s.id !== session.id);
  metas.push({
    id: session.id,
    title: session.title,
    participantIds: [...session.participantIds],
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
  persistSessionMetas(metas);
  persistTranscript(session.id, session.transcript);
}

export function createSession(title?: string, participantIds: string[] = []): ConversationSession {
  const now = Date.now();
  const session: ConversationSession = {
    id: newId(),
    title: title && title.trim() ? title.trim() : "新しい会話",
    participantIds: [...participantIds],
    transcript: [],
    createdAt: now,
    updatedAt: now,
  };
  saveSession(session);
  return session;
}

export function renameSession(id: string, title: string): void {
  const metas = loadSessionMetas();
  const target = metas.find((s) => s.id === id);
  if (!target) return;
  target.title = title.trim() || target.title;
  target.updatedAt = Date.now();
  persistSessionMetas(metas);
}

export function deleteSession(id: string): void {
  persistSessionMetas(loadSessionMetas().filter((s) => s.id !== id));
  void deleteTranscript(id);
}

// -----------------------------------------------------------------------------
// Prompt / message building
// -----------------------------------------------------------------------------

function displayName(speakerId: string, characters: Map<string, Character>): string {
  if (speakerId === USER_SPEAKER_ID) return "ユーザー";
  return characters.get(speakerId)?.sheet.name ?? "不明";
}

/**
 * Build the per-character message array for `speaker`'s next turn.
 *
 * Strategy: the speaker's compiled persona + orchestration rules form the
 * system prompt. The transcript is then replayed as an alternating chat log —
 * the speaker's own past lines become `assistant` turns, and every other
 * participant's lines (including the user) are merged into `user` turns as a
 * "Name: text" script. This gives the model a strong sense of its own voice
 * while still seeing who said what, and stays valid on OpenAI-compatible APIs.
 */
export function buildCharacterMessages(
  session: ConversationSession,
  characters: Map<string, Character>,
  speaker: Character,
): ChatMessage[] {
  const others = session.participantIds
    .filter((id) => id !== speaker.id)
    .map((id) => characters.get(id)?.sheet.name)
    .filter((n): n is string => !!n);

  const rules = [
    "あなたは複数人の会話に参加している登場人物の一人です。",
    others.length > 0
      ? `会話の相手: ${others.join("、")}${session.participantIds.length > 0 ? "、そしてユーザー" : ""}。`
      : "会話の相手はユーザーです。",
    `あなたの発言だけを、${speaker.sheet.name}として一言（1メッセージ）書いてください。`,
    "名前の接頭辞（「名前:」）は付けないでください。あなたのセリフ本文だけを書きます。",
    "他の登場人物のセリフを代わりに書いたり、ト書きやメタ的な注釈（（沈黙）など）を出力しないでください。",
    "直前の発言に具体的に反応してから、自分の考えを述べてください。毎回質問で終える必要はありません。",
    "キャラクターの一人称・口調を最後まで一貫させてください。",
  ].join("\n");

  const world = getWorld(speaker.worldId);
  const messages: ChatMessage[] = [
    { role: "system", content: `${buildPersonaPrompt(speaker.sheet, world)}\n\n${rules}` },
  ];

  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length > 0) {
      messages.push({ role: "user", content: buffer.join("\n") });
      buffer = [];
    }
  };

  for (const entry of session.transcript) {
    if (entry.speakerId === speaker.id) {
      flush();
      messages.push({ role: "assistant", content: entry.text });
    } else {
      buffer.push(`${displayName(entry.speakerId, characters)}: ${entry.text}`);
    }
  }
  flush();

  messages.push({
    role: "user",
    content: `（${speaker.sheet.name}として、次の発言を書いてください。）`,
  });

  return messages;
}

// -----------------------------------------------------------------------------
// Engine
// -----------------------------------------------------------------------------

export interface StreamingState {
  speakerId: string;
  text: string;
}

export interface EngineState {
  session: ConversationSession;
  /** The line currently being streamed, if any (drives the speaking avatar). */
  streaming: StreamingState | null;
  /** True while an auto character<->character conversation is running. */
  autoRunning: boolean;
  /** Remaining auto turns before the hard cap forces a stop. */
  autoTurnsRemaining: number;
  maxAutoTurns: number;
  /** True while any generation is in flight. */
  busy: boolean;
  error: string | null;
}

type Listener = (state: EngineState) => void;

export class ConversationEngine {
  private session: ConversationSession;
  private config: ConversationConfig;
  private listeners = new Set<Listener>();

  private streaming: StreamingState | null = null;
  private autoRunning = false;
  private autoTurnsRemaining: number;
  private error: string | null = null;

  private currentAbort: AbortController | null = null;
  private genLock: Promise<unknown> = Promise.resolve();
  private sleepCancel: (() => void) | null = null;

  constructor(session: ConversationSession, config: Partial<ConversationConfig> = {}) {
    this.session = session;
    this.config = { ...DEFAULT_CONVERSATION_CONFIG, ...config };
    this.autoTurnsRemaining = this.config.maxAutoTurns;
  }

  // --- store surface -------------------------------------------------------

  getState(): EngineState {
    return {
      session: this.session,
      streaming: this.streaming,
      autoRunning: this.autoRunning,
      autoTurnsRemaining: this.autoTurnsRemaining,
      maxAutoTurns: this.config.maxAutoTurns,
      busy: this.currentAbort !== null,
      error: this.error,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = this.getState();
    for (const l of this.listeners) l(state);
  }

  // --- session mutation ----------------------------------------------------

  private touch(): void {
    this.session.updatedAt = Date.now();
    saveSession(this.session);
  }

  private appendEntry(speakerId: string, text: string, latencyMs?: number): void {
    this.session.transcript = [
      ...this.session.transcript,
      { id: newId(), speakerId, text, timestamp: Date.now(), latencyMs },
    ];
    this.touch();
    this.emit();
  }

  setParticipants(ids: string[]): void {
    this.session.participantIds = [...ids];
    this.touch();
    this.emit();
  }

  setTitle(title: string): void {
    this.session.title = title.trim() || this.session.title;
    this.touch();
    this.emit();
  }

  clearError(): void {
    if (this.error !== null) {
      this.error = null;
      this.emit();
    }
  }

  // --- character resolution ------------------------------------------------

  private characterMap(): Map<string, Character> {
    const map = new Map<string, Character>();
    for (const id of this.session.participantIds) {
      const c = getCharacter(id);
      if (c) map.set(id, c);
    }
    return map;
  }

  private participantCharacters(map: Map<string, Character>): Character[] {
    return this.session.participantIds
      .map((id) => map.get(id))
      .filter((c): c is Character => c !== undefined);
  }

  // --- turn taking ---------------------------------------------------------

  /**
   * Choose who speaks next in an auto conversation: prefer a participant named
   * in the last line (cheap mention heuristic), otherwise round-robin. Never
   * returns the immediately previous speaker when others are available.
   */
  private pickNextSpeaker(map: Map<string, Character>): Character | null {
    const parts = this.participantCharacters(map);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];

    const last = this.session.transcript[this.session.transcript.length - 1];
    const lastSpeaker = last?.speakerId;

    if (last) {
      for (const c of parts) {
        if (c.id === lastSpeaker) continue;
        if (c.sheet.name.trim() && last.text.includes(c.sheet.name.trim())) return c;
      }
    }

    const idx = parts.findIndex((c) => c.id === lastSpeaker);
    let next = parts[(idx + 1) % parts.length];
    if (next.id === lastSpeaker) next = parts[(idx + 2) % parts.length];
    return next;
  }

  // --- generation ----------------------------------------------------------

  // Serialized so two turns never overlap physically (JS is single-threaded,
  // but awaits could otherwise interleave). Cancellation is cooperative: the
  // llm contract exposes no abort signal, so an aborted turn simply discards
  // its (still-completing) result rather than tearing down the fetch.
  private async generate(speakerId: string): Promise<boolean> {
    const prev = this.genLock;
    let release!: () => void;
    this.genLock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await this.doGenerate(speakerId);
    } finally {
      release();
    }
  }

  private async doGenerate(speakerId: string): Promise<boolean> {
    const map = this.characterMap();
    const character = map.get(speakerId);
    if (!character) {
      this.error = "キャラクターが見つかりません。";
      this.emit();
      return false;
    }

    const controller = new AbortController();
    this.currentAbort = controller;
    this.streaming = { speakerId, text: "" };
    this.error = null;
    this.emit();

    const messages = buildCharacterMessages(this.session, map, character);

    // Fire the emotion classifier at most once per turn: as soon as the
    // streamed text crosses the length threshold (for a snappier expression
    // change), or on completion if the reply never reached it.
    let emotionClassified = false;

    try {
      const startedAt = Date.now();
      const full = await requestChatCompletion(character.llmProfileId, messages, {
        temperature: this.config.temperature,
        onDelta: (_delta, accumulated) => {
          if (controller.signal.aborted) return;
          this.streaming = { speakerId, text: accumulated };
          this.emit();
          if (!emotionClassified && accumulated.length >= EMOTION_CLASSIFY_MIN_LENGTH) {
            emotionClassified = true;
            maybeClassifyEmotion(speakerId, accumulated, character.llmProfileId);
          }
        },
      });
      const latencyMs = Date.now() - startedAt;

      if (controller.signal.aborted) return false;

      const text = full.trim();
      if (!emotionClassified && text) {
        maybeClassifyEmotion(speakerId, text, character.llmProfileId);
      }
      if (text) this.appendEntry(speakerId, text, latencyMs);
      return true;
    } catch (err) {
      if (controller.signal.aborted) return false;
      this.error = err instanceof Error ? err.message : String(err);
      this.emit();
      return false;
    } finally {
      if (this.currentAbort === controller) {
        this.currentAbort = null;
        this.streaming = null;
        this.emit();
      }
    }
  }

  private abortCurrent(): void {
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    if (this.streaming) this.streaming = null;
  }

  private sleep(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.sleepCancel = null;
        resolve(true);
      }, ms);
      this.sleepCancel = () => {
        clearTimeout(timer);
        this.sleepCancel = null;
        resolve(false);
      };
    });
  }

  private cancelSleep(): void {
    if (this.sleepCancel) this.sleepCancel();
  }

  // --- public actions ------------------------------------------------------

  /**
   * User sends a message; then each character in `responderIds` replies in
   * order. Interrupts any running auto conversation and resets the auto cap.
   */
  async sendUserMessage(text: string, responderIds: string[]): Promise<void> {
    const trimmed = text.trim();
    // Interrupt auto + any in-flight turn; user input resets the runaway cap.
    this.autoRunning = false;
    this.cancelSleep();
    this.abortCurrent();
    this.autoTurnsRemaining = this.config.maxAutoTurns;

    if (trimmed) this.appendEntry(USER_SPEAKER_ID, trimmed);
    this.emit();

    for (const id of responderIds) {
      if (!this.session.participantIds.includes(id)) continue;
      const ok = await this.generate(id);
      if (!ok) break;
    }
  }

  /** Generate a single reply from one character (no user line). */
  async requestReply(speakerId: string): Promise<void> {
    await this.generate(speakerId);
  }

  /** Start automatic character<->character conversation. */
  async startAuto(): Promise<void> {
    if (this.autoRunning) return;
    const map = this.characterMap();
    if (this.participantCharacters(map).length < 2) {
      this.error = "自動会話には2人以上のキャラクターが必要です。";
      this.emit();
      return;
    }

    this.autoRunning = true;
    this.autoTurnsRemaining = this.config.maxAutoTurns;
    this.error = null;
    this.emit();

    while (this.autoRunning && this.autoTurnsRemaining > 0) {
      const speaker = this.pickNextSpeaker(this.characterMap());
      if (!speaker) break;

      const ok = await this.generate(speaker.id);
      if (!ok || !this.autoRunning) break;

      this.autoTurnsRemaining -= 1;
      this.emit();
      if (this.autoTurnsRemaining <= 0) break;

      const continued = await this.sleep(this.config.autoDelayMs);
      if (!continued || !this.autoRunning) break;
    }

    this.autoRunning = false;
    this.emit();
  }

  /** Stop the auto conversation and cancel any in-flight turn. */
  stopAuto(): void {
    this.autoRunning = false;
    this.cancelSleep();
    this.abortCurrent();
    this.emit();
  }

  /** Cancel everything and release timers (call on unmount). */
  dispose(): void {
    this.autoRunning = false;
    this.cancelSleep();
    this.abortCurrent();
    this.listeners.clear();
  }
}

/** Convenience: characters available to add as participants. */
export function availableCharacters(): Character[] {
  return listCharacters();
}

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
// Persistence (localStorage, defensive parsing)
// -----------------------------------------------------------------------------

const SESSIONS_KEY = "tc-town:conversations";

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

function coerceSession(value: unknown): ConversationSession | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== "string") return null;
  const participantIds = Array.isArray(s.participantIds)
    ? s.participantIds.filter((x): x is string => typeof x === "string")
    : [];
  const transcript = Array.isArray(s.transcript)
    ? s.transcript.map(coerceTranscriptEntry).filter((e): e is TranscriptEntry => e !== null)
    : [];
  const now = Date.now();
  return {
    id: s.id,
    title: typeof s.title === "string" && s.title.trim() ? s.title : "無題の会話",
    participantIds,
    transcript,
    createdAt: typeof s.createdAt === "number" ? s.createdAt : now,
    updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : now,
  };
}

export function loadSessions(): ConversationSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const sessions = parsed.map(coerceSession).filter((s): s is ConversationSession => s !== null);
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
  } catch {
    return [];
  }
}

function persistSessions(sessions: ConversationSession[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    // Storage full / unavailable — non-fatal for an in-memory session.
  }
}

/** All sessions, most-recently-updated first. */
export function listSessions(): ConversationSession[] {
  return loadSessions();
}

export function getSession(id: string): ConversationSession | undefined {
  return loadSessions().find((s) => s.id === id);
}

export function saveSession(session: ConversationSession): void {
  const sessions = loadSessions().filter((s) => s.id !== session.id);
  sessions.push(session);
  persistSessions(sessions);
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
  const sessions = loadSessions();
  const target = sessions.find((s) => s.id === id);
  if (!target) return;
  target.title = title.trim() || target.title;
  target.updatedAt = Date.now();
  persistSessions(sessions);
}

export function deleteSession(id: string): void {
  persistSessions(loadSessions().filter((s) => s.id !== id));
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

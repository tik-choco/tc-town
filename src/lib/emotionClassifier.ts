// Expression switching via a separate lightweight LLM request: after (or
// while) a character's reply streams in, ask the LLM to classify the reply's
// emotion and write it to lib/emotionStore.ts so the VRM face follows the
// conversation. The feature self-regulates on response time: in "auto" mode we
// record each classification request's latency and automatically stop issuing
// requests when the endpoint is too slow to be useful (the expression would
// land long after the line was spoken). See getExpressionFeatureStatus() for
// what the settings UI displays.

import { DEFAULT_LLM_PROFILE_ID, type ChatMessage } from "../types";
import { EMOTION_NAMES, setCharacterEmotion, type EmotionName } from "./emotionStore";
import { loadProviderSettings, type ExpressionMode } from "./llmSettings";
import { requestChatCompletion } from "./llm";

export interface ExpressionFeatureStatus {
  /** The user-chosen mode from ProviderSettings.expressionMode. */
  mode: ExpressionMode;
  /** True when classification requests are currently being issued. */
  active: boolean;
  /** True when "auto" mode disabled the feature because of slow responses. */
  autoDisabled: boolean;
  /** Rolling average latency of recent classification requests, or null with no samples. */
  avgLatencyMs: number | null;
  sampleCount: number;
}

const LATENCY_KEY = "tc-town:expression-latency-v1";
const LATENCY_THRESHOLD_MS = 2000;
const MAX_SAMPLES = 8;
const MAX_TEXT_LENGTH = 280;

interface LatencyState {
  samples: number[];
  autoOff: boolean;
  updatedAt: string;
}

function defaultLatencyState(): LatencyState {
  return { samples: [], autoOff: false, updatedAt: new Date(0).toISOString() };
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === "number" && Number.isFinite(v));
}

function loadLatencyState(): LatencyState {
  try {
    const raw = localStorage.getItem(LATENCY_KEY);
    if (!raw) return defaultLatencyState();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return defaultLatencyState();
    const record = parsed as Record<string, unknown>;
    const samples = isFiniteNumberArray(record.samples) ? record.samples.slice(-MAX_SAMPLES) : [];
    const autoOff = record.autoOff === true;
    const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString();
    return { samples, autoOff, updatedAt };
  } catch {
    return defaultLatencyState();
  }
}

function saveLatencyState(state: LatencyState): void {
  try {
    localStorage.setItem(LATENCY_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("tc-town: failed to persist expression latency state", error);
  }
}

// This-session-only probe allowance: when auto mode has gone autoOff, we
// still let exactly one classification attempt through per page load so a
// since-recovered endpoint can bring the feature back. Consumed on the first
// attempt regardless of outcome.
let autoProbeConsumedThisSession = false;

// Per-character in-flight guard: later calls for the same character while a
// request is outstanding are ignored.
const inFlightCharacters = new Map<string, true>();

let consecutiveErrors = 0;

const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn("tc-town: expression feature status listener threw", error);
    }
  }
}

function recordSuccessLatency(latencyMs: number, mode: ExpressionMode): void {
  const state = loadLatencyState();
  state.samples = [...state.samples, latencyMs].slice(-MAX_SAMPLES);
  state.updatedAt = new Date().toISOString();
  consecutiveErrors = 0;

  if (mode === "auto") {
    const recent = state.samples.slice(-3);
    if (recent.length >= 2) {
      const avg = recent.reduce((sum, v) => sum + v, 0) / recent.length;
      state.autoOff = avg > LATENCY_THRESHOLD_MS;
    }
  }

  saveLatencyState(state);
  notifyListeners();
}

function recordError(mode: ExpressionMode, error: unknown): void {
  console.warn("tc-town: emotion classification request failed", error);
  consecutiveErrors += 1;
  if (mode === "auto" && consecutiveErrors >= 2) {
    const state = loadLatencyState();
    state.autoOff = true;
    state.updatedAt = new Date().toISOString();
    saveLatencyState(state);
    notifyListeners();
  }
}

function parseEmotion(response: string): EmotionName {
  const lower = response.toLowerCase();
  let bestIndex = Infinity;
  let bestEmotion: EmotionName = "neutral";
  for (const name of EMOTION_NAMES) {
    const idx = lower.indexOf(name);
    if (idx !== -1 && idx < bestIndex) {
      bestIndex = idx;
      bestEmotion = name;
    }
  }
  return bestEmotion;
}

/**
 * Fire-and-forget: classify `text`'s emotion with a separate small LLM request
 * and set it on the emotion store under `characterId`. Respects the
 * expressionMode setting and the auto latency gate; at most one request is in
 * flight per character (later calls for the same turn are ignored). Never
 * throws.
 */
export function maybeClassifyEmotion(
  characterId: string,
  text: string,
  presetId?: string,
): void {
  try {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!characterId) return;

    const settings = loadProviderSettings();
    const mode = settings.expressionMode;
    if (mode === "off") return;

    if (mode === "auto") {
      const state = loadLatencyState();
      if (state.autoOff) {
        // Still allow exactly one probe per session so a since-recovered
        // endpoint can bring the feature back; recordSuccessLatency() below
        // recomputes autoOff from the latest samples either way.
        if (autoProbeConsumedThisSession) return;
        autoProbeConsumedThisSession = true;
      }
    }

    if (inFlightCharacters.has(characterId)) return;
    inFlightCharacters.set(characterId, true);

    const truncated = trimmed.slice(0, MAX_TEXT_LENGTH);
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "あなたは感情分類器です。次のセリフの話者の感情を happy / angry / sad / relaxed / surprised / neutral のいずれか1語だけで答えてください。他の語や説明は出力しないこと。",
      },
      { role: "user", content: truncated },
    ];

    const effectivePresetId = presetId && presetId.trim() ? presetId : DEFAULT_LLM_PROFILE_ID;
    const startedAt = Date.now();

    notifyListeners();

    requestChatCompletion(effectivePresetId, messages, { temperature: 0 })
      .then((response) => {
        const latencyMs = Date.now() - startedAt;
        const emotion = parseEmotion(response);
        setCharacterEmotion(characterId, emotion);
        recordSuccessLatency(latencyMs, mode);
      })
      .catch((error) => {
        recordError(mode, error);
      })
      .finally(() => {
        inFlightCharacters.delete(characterId);
        notifyListeners();
      });
  } catch (error) {
    // Never throw out of a fire-and-forget call.
    console.warn("tc-town: maybeClassifyEmotion failed unexpectedly", error);
  }
}

/** Snapshot for the settings UI. */
export function getExpressionFeatureStatus(): ExpressionFeatureStatus {
  const settings = loadProviderSettings();
  const state = loadLatencyState();
  const active = settings.expressionMode === "on" || (settings.expressionMode === "auto" && !state.autoOff);
  const avgLatencyMs =
    state.samples.length > 0
      ? Math.round(state.samples.reduce((sum, v) => sum + v, 0) / state.samples.length)
      : null;
  return {
    mode: settings.expressionMode,
    active,
    autoDisabled: state.autoOff,
    avgLatencyMs,
    sampleCount: state.samples.length,
  };
}

/** Notifies when the feature status changes (new sample, auto on/off flip). Returns unsubscribe. */
export function subscribeExpressionFeatureStatus(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

// Re-exported so UI code can import everything expression-related from here.
export type { EmotionName };

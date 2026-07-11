// tc-town's app-local LLM/voice settings. As of the shared llmConfig
// migration, the "where do I connect / which model" data (baseUrl, apiKey,
// model, temperature, reasoningEffort, TTS/STT endpoint, AI Network room) all
// live in the co-owned `tc-shared-llm-config-v1` key (lib/llmConfig.ts —
// vendored from protocol/docs/data-contracts, don't hand-edit). What's left
// here is purely app-local: the AI Network consumer/provider *enable*
// toggles (tc-town's own feature switches, not part of the shared contract)
// and the STT end-of-turn silence duration (explicitly NOT part of
// `VoiceConfigV1` per the contract — every app tunes its own silence
// threshold). Persisted to localStorage as JSON, parsed defensively.

import {
  emptyLlmConfig,
  ensureProvider,
  ensurePreset,
  loadLlmConfig,
  saveLlmConfig,
  type SharedLlmConfigV1,
} from "./llmConfig";

const SETTINGS_KEY = "tc-town:provider-settings";

export interface ProviderSettings {
  /** AI Network room to consume/provide a shared LLM on (see lib/network.ts). Room id itself is shared — see SharedLlmConfigV1.network.roomId. */
  networkConsumerEnabled: boolean;
  networkProviderEnabled: boolean;
  /** STT end-of-turn silence gap in seconds, used by the voice call feature. App-local by contract (not part of VoiceConfigV1). */
  sttSilenceDuration: number;
  /**
   * VRM expression switching via a separate LLM request (lib/emotionClassifier.ts).
   * "auto" measures the classification request's latency and turns itself off
   * when responses are too slow to be useful; "on"/"off" force it.
   */
  expressionMode: ExpressionMode;
}

export const EXPRESSION_MODES = ["auto", "on", "off"] as const;
export type ExpressionMode = (typeof EXPRESSION_MODES)[number];

/** reasoning_effort の選択肢。空文字はパラメータを送らない選択を表す。 */
export const REASONING_EFFORT_OPTIONS = ["none", "low", "medium", "high"] as const;

/** 既定の reasoning_effort — ユーザー方針でデフォルトは "none"（思考なしで応答を速く）。 */
export const DEFAULT_REASONING_EFFORT = "none";

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  networkConsumerEnabled: false,
  networkProviderEnabled: false,
  sttSilenceDuration: 0.8,
  expressionMode: "auto",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Exported for lib/exportImport.ts — sanitizes a parsed provider-settings record the same defensive way as {@link loadProviderSettings}. */
export function sanitizeSettings(value: unknown): ProviderSettings {
  if (!isRecord(value)) return { ...DEFAULT_PROVIDER_SETTINGS };
  const sttSilenceDuration =
    typeof value.sttSilenceDuration === "number" && Number.isFinite(value.sttSilenceDuration)
      ? value.sttSilenceDuration
      : DEFAULT_PROVIDER_SETTINGS.sttSilenceDuration;
  const expressionMode = (EXPRESSION_MODES as readonly string[]).includes(value.expressionMode as string)
    ? (value.expressionMode as ExpressionMode)
    : DEFAULT_PROVIDER_SETTINGS.expressionMode;
  return {
    networkConsumerEnabled: value.networkConsumerEnabled === true,
    networkProviderEnabled: value.networkProviderEnabled === true,
    sttSilenceDuration,
    expressionMode,
  };
}

export function loadProviderSettings(): ProviderSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_PROVIDER_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PROVIDER_SETTINGS };
  }
}

export function saveProviderSettings(settings: ProviderSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn("tc-town: failed to persist provider settings", error);
  }
}

// -----------------------------------------------------------------------------
// One-time migration: tc-town's pre-shared-config local settings -> the
// shared tc-shared-llm-config-v1 key. See
// protocol/docs/data-contracts/docs/llm-config.md's "マイグレーション規則"
// (loadLlmConfig-or-empty, ensureProvider/ensurePreset only ever append,
// defaultPresetId/tts/stt/network.roomId set only if currently empty).
//
// Idempotent by construction: this reads the OLD (pre-migration) shape
// directly off the raw localStorage record — profiles/tts/stt/networkRoomId/
// defaultProfileId. Once migrated, saveProviderSettings() below overwrites
// the key with the new reduced shape (no `profiles` array), so a second call
// finds nothing to migrate and returns immediately. Re-running against the
// same untouched legacy data is also safe on its own merits: ensureProvider/
// ensurePreset dedupe, and the defaultPresetId/tts/stt/network.roomId writes
// are gated on "currently empty" — nothing is ever double-applied or
// overwritten.
// -----------------------------------------------------------------------------

interface LegacyLlmProfile {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  reasoningEffort?: string;
}

interface LegacyVoiceProfile {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice?: string;
  speed?: number;
  silenceDuration?: number;
}

// The untouched factory defaults tc-town shipped before this migration
// (see git history of this file). An install that never customized these
// contributes nothing useful to the shared catalog, so migrating them would
// just clutter every other app's provider/preset list with a dead
// "http://localhost:1234/v1" entry (LLM) or an unconfigured (empty apiKey)
// "https://api.openai.com/v1" entry (TTS/STT).
const PRISTINE_LLM_PROFILE = { baseUrl: "http://localhost:1234/v1", apiKey: "", model: "" };
const PRISTINE_TTS = { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "tts-1" };
const PRISTINE_STT = { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "whisper-1" };

function sanitizeLegacyProfile(value: unknown): LegacyLlmProfile | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  if (!id) return null;
  const temperature =
    typeof value.temperature === "number" && Number.isFinite(value.temperature) ? value.temperature : 0.7;
  const reasoningEffort =
    typeof value.reasoningEffort === "string" &&
    (value.reasoningEffort === "" || (REASONING_EFFORT_OPTIONS as readonly string[]).includes(value.reasoningEffort))
      ? value.reasoningEffort
      : undefined;
  return {
    id,
    label: typeof value.label === "string" ? value.label : id,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    model: typeof value.model === "string" ? value.model : "",
    temperature: Math.min(2, Math.max(0, temperature)),
    reasoningEffort,
  };
}

function sanitizeLegacyVoice(value: unknown): LegacyVoiceProfile | null {
  if (!isRecord(value)) return null;
  const voice: LegacyVoiceProfile = {
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    model: typeof value.model === "string" ? value.model : "",
  };
  if (typeof value.voice === "string") voice.voice = value.voice;
  if (typeof value.speed === "number" && Number.isFinite(value.speed)) voice.speed = value.speed;
  if (typeof value.silenceDuration === "number" && Number.isFinite(value.silenceDuration)) {
    voice.silenceDuration = value.silenceDuration;
  }
  return voice;
}

function isPristine(
  voice: LegacyVoiceProfile,
  pristine: { baseUrl: string; apiKey: string; model: string },
): boolean {
  return voice.baseUrl.trim() === pristine.baseUrl && voice.apiKey === pristine.apiKey && voice.model.trim() === pristine.model;
}

/**
 * Migrates tc-town's legacy `profiles`/`tts`/`stt`/`networkRoomId`/
 * `defaultProfileId` fields (if still present in the raw stored record) into
 * the shared `tc-shared-llm-config-v1` key, then rewrites this app's own
 * settings key to the new reduced local shape. No-ops (does nothing, touches
 * nothing) once already migrated. Call once at startup, before any view reads
 * `loadProviderSettings()`/the shared config.
 */
export function migrateLegacyProviderSettingsToShared(): void {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch {
    return;
  }
  if (!raw) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.profiles)) return; // already migrated (or nothing to migrate)

  const cfg: SharedLlmConfigV1 = loadLlmConfig() ?? emptyLlmConfig();

  // --- profiles -> providers + presets (id preserved so Character.llmProfileId keeps resolving) ---
  for (const rawProfile of parsed.profiles) {
    const profile = sanitizeLegacyProfile(rawProfile);
    if (!profile) continue;
    if (
      profile.baseUrl.trim() === PRISTINE_LLM_PROFILE.baseUrl &&
      profile.apiKey === PRISTINE_LLM_PROFILE.apiKey &&
      profile.model.trim() === PRISTINE_LLM_PROFILE.model
    ) {
      continue; // untouched built-in default — nothing worth sharing
    }
    const providerId = ensureProvider(cfg, { label: profile.label, baseUrl: profile.baseUrl, apiKey: profile.apiKey });
    ensurePreset(cfg, {
      id: profile.id,
      label: profile.label,
      providerId,
      model: profile.model,
      temperature: profile.temperature,
      reasoningEffort: profile.reasoningEffort,
    });
  }

  // --- defaultProfileId -> defaultPresetId (only if not already set by some other app) ---
  const defaultProfileId = typeof parsed.defaultProfileId === "string" ? parsed.defaultProfileId : "";
  if (!cfg.defaultPresetId && defaultProfileId && cfg.presets.some((p) => p.id === defaultProfileId)) {
    cfg.defaultPresetId = defaultProfileId;
  }

  // --- tts / stt -> shared VoiceConfigV1 (silenceDuration stays local) ---
  const legacyTts = sanitizeLegacyVoice(parsed.tts);
  if (legacyTts && legacyTts.baseUrl.trim() && !isPristine(legacyTts, PRISTINE_TTS) && !cfg.tts) {
    const providerId = ensureProvider(cfg, { baseUrl: legacyTts.baseUrl, apiKey: legacyTts.apiKey });
    cfg.tts = { providerId, model: legacyTts.model, voice: legacyTts.voice, speed: legacyTts.speed };
  }

  const legacyStt = sanitizeLegacyVoice(parsed.stt);
  if (legacyStt && legacyStt.baseUrl.trim() && !isPristine(legacyStt, PRISTINE_STT) && !cfg.stt) {
    const providerId = ensureProvider(cfg, { baseUrl: legacyStt.baseUrl, apiKey: legacyStt.apiKey });
    cfg.stt = { providerId, model: legacyStt.model };
  }

  // --- networkRoomId -> shared network.roomId (only if not already set) ---
  const roomId = typeof parsed.networkRoomId === "string" ? parsed.networkRoomId.trim() : "";
  if (!cfg.network.roomId && roomId) cfg.network.roomId = roomId;

  saveLlmConfig(cfg);

  // --- rewrite the local key to the new reduced shape ---
  saveProviderSettings({
    networkConsumerEnabled: parsed.networkConsumerEnabled === true,
    networkProviderEnabled: parsed.networkProviderEnabled === true,
    sttSilenceDuration: legacyStt?.silenceDuration ?? DEFAULT_PROVIDER_SETTINGS.sttSilenceDuration,
    expressionMode: sanitizeSettings(parsed).expressionMode,
  });
}

// Shared LLM/TTS/STT connection config for the tik-choco app family, vendored
// identically (modulo TS/JS syntax) into every participating app. See
// protocol/docs/data-contracts/docs/llm-config.md for the full spec.
// Contract version: v1
//
// Design: this module does NOT depend on mistlib or sharedBus.ts. Unlike
// appManifest.ts (one key per app, writer-owned) this key is co-owned: every
// participating app reads AND writes the same localStorage record, so a user
// only has to enter their LLM endpoint/API key once per origin instead of
// once per app. Same-origin apps mutually trust each other; conflicts are
// resolved last-write-wins by `updatedAt`. See docs/did-identity.md for the
// precedent of this co-owned-shared-key pattern
// (`tc-shared-did-identity-cid-v1`).
//
// Merge/migration policy (enforced by convention, not code): apps seeding
// this config from their own legacy local settings must loadLlmConfig() (or
// start from emptyLlmConfig() if null), add entries via ensureProvider/
// ensurePreset (which only ever append, never delete or overwrite existing
// entries), set `defaultPresetId`/`tts`/`stt`/`network.roomId` ONLY if
// currently empty/absent, then call saveLlmConfig(). Never blind-overwrite
// another app's providers/presets.
//
// This is the canonical reference copy
// (protocol/docs/data-contracts/reference/llmConfig.ts). Don't hand-edit the
// vendored per-app copies directly — regenerate them with
// protocol/scripts/sync-vendored.mjs instead. Like appManifest.ts, this file
// has no per-app placeholder to substitute: the vendored copy is
// byte-identical everywhere.

export const LLM_CONFIG_KEY = "tc-shared-llm-config-v1";
export const LLM_CONFIG_VERSION = 1;

/** 接続情報のみ = 「どこに繋ぐか」 */
export type LlmProviderV1 = {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
};

/** 名前付きモデル設定 = 「どう呼ぶか」。providerId で LlmProviderV1 を参照 */
export type ModelPresetV1 = {
  id: string;
  label: string;
  providerId: string;
  model: string;
  temperature?: number;
  reasoningEffort?: string;
};

/** TTS/STT。providerId 省略時は defaultPreset の provider にフォールバック */
export type VoiceConfigV1 = {
  providerId?: string;
  model: string;
  voice?: string;
  speed?: number;
};

export type SharedLlmConfigV1 = {
  v: 1;
  providers: LlmProviderV1[];
  presets: ModelPresetV1[];
  /** ""(空文字)= 未設定 */
  defaultPresetId: string;
  tts?: VoiceConfigV1;
  stt?: VoiceConfigV1;
  /** AI Network の既定ルーム。roomId: "" = 未設定 */
  network: { roomId: string };
  /** ISO 8601、LWW(last-write-wins)用 */
  updatedAt: string;
};

/** resolvePreset() の解決結果。provider の接続情報と preset のモデル設定を1つにマージしたもの。 */
export type ResolvedLlmTargetV1 = {
  presetId: string;
  providerId: string;
  /** preset の label */
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  reasoningEffort?: string;
};

function isLlmProviderV1(value: unknown): value is LlmProviderV1 {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.baseUrl === "string" &&
    typeof record.apiKey === "string"
  );
}

function isModelPresetV1(value: unknown): value is ModelPresetV1 {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.providerId === "string" &&
    typeof record.model === "string" &&
    (record.temperature === undefined || typeof record.temperature === "number") &&
    (record.reasoningEffort === undefined || typeof record.reasoningEffort === "string")
  );
}

function isVoiceConfigV1(value: unknown): value is VoiceConfigV1 {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record.providerId === undefined || typeof record.providerId === "string") &&
    typeof record.model === "string" &&
    (record.voice === undefined || typeof record.voice === "string") &&
    (record.speed === undefined || typeof record.speed === "number")
  );
}

/**
 * Field-by-field defensive parse of a raw `SharedLlmConfigV1` value. Returns
 * null if a required top-level field is missing/malformed or `v` isn't 1.
 * Malformed entries inside `providers`/`presets` are dropped individually
 * rather than invalidating the whole record; a malformed optional `tts`/`stt`
 * is dropped the same way.
 */
function sanitizeLlmConfig(value: unknown): SharedLlmConfigV1 | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  if (record.v !== 1) return null;
  if (!Array.isArray(record.providers)) return null;
  if (!Array.isArray(record.presets)) return null;
  if (typeof record.defaultPresetId !== "string") return null;
  if (record.network === null || typeof record.network !== "object") return null;
  const network = record.network as Record<string, unknown>;
  if (typeof network.roomId !== "string") return null;
  if (typeof record.updatedAt !== "string") return null;

  const config: SharedLlmConfigV1 = {
    v: 1,
    providers: record.providers.filter(isLlmProviderV1),
    presets: record.presets.filter(isModelPresetV1),
    defaultPresetId: record.defaultPresetId,
    network: { roomId: network.roomId },
    updatedAt: record.updatedAt,
  };

  if (record.tts !== undefined && isVoiceConfigV1(record.tts)) config.tts = record.tts;
  if (record.stt !== undefined && isVoiceConfigV1(record.stt)) config.stt = record.stt;

  return config;
}

function newId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the Math.random fallback below
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Returns a fresh, empty `SharedLlmConfigV1` (not persisted). */
export function emptyLlmConfig(): SharedLlmConfigV1 {
  return {
    v: 1,
    providers: [],
    presets: [],
    defaultPresetId: "",
    network: { roomId: "" },
    updatedAt: "",
  };
}

/**
 * Reads and validates `tc-shared-llm-config-v1`. Returns null if the key is
 * missing, the JSON is malformed, or the shape doesn't match
 * `SharedLlmConfigV1` (never throws). See `sanitizeLlmConfig` for how
 * malformed array entries are handled.
 */
export function loadLlmConfig(): SharedLlmConfigV1 | null {
  try {
    const raw = localStorage.getItem(LLM_CONFIG_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return sanitizeLlmConfig(parsed);
  } catch {
    return null;
  }
}

/**
 * Persists `config` to `tc-shared-llm-config-v1`, stamping `config.updatedAt`
 * with the current time (mutates the passed object). Never throws: storage
 * failures (quota, disabled storage, etc.) are swallowed after a
 * console.warn.
 */
export function saveLlmConfig(config: SharedLlmConfigV1): void {
  config.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(config));
  } catch (error) {
    console.warn("tc-shared-llm-config: failed to persist config", error);
  }
}

/**
 * Subscribes to cross-tab/cross-app updates of `tc-shared-llm-config-v1` via
 * the `storage` window event (same-origin only, and only fires for tabs
 * other than the writer). Calls `cb` with the freshly loaded config (or null)
 * whenever the key changes. Returns an unsubscribe function.
 */
export function subscribeLlmConfig(cb: (config: SharedLlmConfigV1 | null) => void): () => void {
  function onStorageEvent(event: StorageEvent) {
    if (event.key !== LLM_CONFIG_KEY) return;
    cb(loadLlmConfig());
  }

  window.addEventListener("storage", onStorageEvent);
  return () => window.removeEventListener("storage", onStorageEvent);
}

/** Trims whitespace and strips trailing slashes, so equivalent endpoints compare equal. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Finds-or-creates a provider by (normalized baseUrl, apiKey) pair. Mutates
 * `config.providers` in place (push-only, never overwrites an existing
 * entry) and returns the provider's id; the caller is responsible for
 * calling `saveLlmConfig` afterwards.
 */
export function ensureProvider(
  config: SharedLlmConfigV1,
  input: { label?: string; baseUrl: string; apiKey: string },
): string {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const existing = config.providers.find((p) => p.baseUrl === baseUrl && p.apiKey === input.apiKey);
  if (existing) return existing.id;

  const id = newId();
  config.providers.push({ id, label: input.label || baseUrl, baseUrl, apiKey: input.apiKey });
  return id;
}

/**
 * Finds-or-creates a preset. If `input.id` is given and a preset with that id
 * already exists, it is returned unchanged (an explicit id is never
 * overwritten). Otherwise dedupes by
 * `(providerId, model, temperature ?? null, reasoningEffort ?? null)`.
 * Mutates `config.presets` in place (push-only); the caller is responsible
 * for calling `saveLlmConfig` afterwards.
 */
export function ensurePreset(
  config: SharedLlmConfigV1,
  input: {
    id?: string;
    label?: string;
    providerId: string;
    model: string;
    temperature?: number;
    reasoningEffort?: string;
  },
): string {
  if (input.id) {
    const byId = config.presets.find((p) => p.id === input.id);
    if (byId) return byId.id;
  }

  const temperature = input.temperature ?? null;
  const reasoningEffort = input.reasoningEffort ?? null;
  const existing = config.presets.find(
    (p) =>
      p.providerId === input.providerId &&
      p.model === input.model &&
      (p.temperature ?? null) === temperature &&
      (p.reasoningEffort ?? null) === reasoningEffort,
  );
  if (existing) return existing.id;

  const preset: ModelPresetV1 = {
    id: input.id ?? newId(),
    label: input.label || input.model,
    providerId: input.providerId,
    model: input.model,
  };
  if (input.temperature !== undefined) preset.temperature = input.temperature;
  if (input.reasoningEffort !== undefined) preset.reasoningEffort = input.reasoningEffort;

  config.presets.push(preset);
  return preset.id;
}

/**
 * Resolves `presetId` (or, if omitted/not found, `config.defaultPresetId`)
 * to a preset and merges it with its provider's connection info. Returns
 * null if no preset can be found or its provider no longer exists.
 */
export function resolvePreset(config: SharedLlmConfigV1, presetId?: string | null): ResolvedLlmTargetV1 | null {
  const preset =
    (presetId ? config.presets.find((p) => p.id === presetId) : undefined) ??
    config.presets.find((p) => p.id === config.defaultPresetId);
  if (!preset) return null;

  const provider = config.providers.find((p) => p.id === preset.providerId);
  if (!provider) return null;

  const resolved: ResolvedLlmTargetV1 = {
    presetId: preset.id,
    providerId: provider.id,
    label: preset.label,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: preset.model,
  };
  if (preset.temperature !== undefined) resolved.temperature = preset.temperature;
  if (preset.reasoningEffort !== undefined) resolved.reasoningEffort = preset.reasoningEffort;
  return resolved;
}

/**
 * Resolves `config.tts`/`config.stt` to concrete connection info. Returns
 * null if the voice config is absent, has no `model`, or its provider (the
 * explicit `providerId`, or else the provider of `resolvePreset(config)`)
 * can't be found.
 */
export function resolveVoice(
  config: SharedLlmConfigV1,
  kind: "tts" | "stt",
): { baseUrl: string; apiKey: string; model: string; voice?: string; speed?: number } | null {
  const cfg = config[kind];
  if (!cfg || !cfg.model) return null;

  const provider = cfg.providerId
    ? config.providers.find((p) => p.id === cfg.providerId)
    : (() => {
        const defaultTarget = resolvePreset(config);
        return defaultTarget ? config.providers.find((p) => p.id === defaultTarget.providerId) : undefined;
      })();
  if (!provider) return null;

  const resolved: { baseUrl: string; apiKey: string; model: string; voice?: string; speed?: number } = {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: cfg.model,
  };
  if (cfg.voice !== undefined) resolved.voice = cfg.voice;
  if (cfg.speed !== undefined) resolved.speed = cfg.speed;
  return resolved;
}

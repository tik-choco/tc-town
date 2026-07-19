// Editing helpers for the Settings screen's AI接続 tab: a plain CRUD layer
// over `config.providers`/`config.presets`. Ported from tc-translate's
// src/lib/llmConfigEdit.ts (the reference implementation for the shared
// AI接続/AI Network/タスク settings UI — see
// tc-docs/drafts/llm-settings-common-v1.md) — same shape, adapted to this
// app's `updateCfg`-based persistence (callers mutate the draft passed to
// `updateCfg`'s producer and it's `saveLlmConfig`'d as a whole, rather than a
// `SharedLlmConfigState.save` middleware).
//
// This is a deliberate, explicit CRUD surface — distinct from
// ensureProvider/ensurePreset (llmConfig.ts), which are append-only/dedup
// helpers meant for one-time migrations absorbing another app's legacy data.
// Here the user is directly managing a list of named connections/presets
// through the UI, so plain create/patch/delete is the right shape (mirrors
// how SettingsView already worked pre-redesign).

import type { LlmProviderV1, ModelPresetV1, SharedLlmConfigV1 } from "./llmConfig";

function newId(): string {
  return crypto.randomUUID();
}

export function createProvider(config: SharedLlmConfigV1, label: string): string {
  const provider: LlmProviderV1 = { id: newId(), label, baseUrl: "", apiKey: "" };
  config.providers.push(provider);
  return provider.id;
}

export function patchProvider(config: SharedLlmConfigV1, id: string, patch: Partial<Omit<LlmProviderV1, "id">>): void {
  const provider = config.providers.find((entry) => entry.id === id);
  if (provider) Object.assign(provider, patch);
}

/** Removes a provider. Any preset/voice config still referencing it keeps its (now dangling) providerId — resolvePreset/resolveVoice degrade that to "no target" rather than throwing; the caller is responsible for warning the user beforehand. */
export function deleteProvider(config: SharedLlmConfigV1, id: string): void {
  config.providers = config.providers.filter((entry) => entry.id !== id);
}

export function createPreset(config: SharedLlmConfigV1, providerId: string, label: string): string {
  const preset: ModelPresetV1 = { id: newId(), label, providerId, model: "", temperature: 0.7 };
  config.presets.push(preset);
  // First preset ever created becomes the default automatically — otherwise
  // every character/task would keep resolving to nothing even though a
  // preset now exists.
  if (!config.defaultPresetId) config.defaultPresetId = preset.id;
  return preset.id;
}

export function patchPreset(config: SharedLlmConfigV1, id: string, patch: Partial<Omit<ModelPresetV1, "id">>): void {
  const preset = config.presets.find((entry) => entry.id === id);
  if (preset) Object.assign(preset, patch);
}

/** Removes a preset. If it was the default, the next remaining preset (if any) takes over. Callers still referencing this preset by id elsewhere (Character.llmProfileId, the タスク tab's own selection) are left to resolve to "not found" — resolvePreset falls back to the (possibly now-different) default. */
export function deletePreset(config: SharedLlmConfigV1, id: string): void {
  config.presets = config.presets.filter((entry) => entry.id !== id);
  if (config.defaultPresetId === id) config.defaultPresetId = config.presets[0]?.id ?? "";
}

/** Updates `config.tts`/`config.stt` in place from Settings UI edits. An empty `providerId` clears it (falls back to the default preset's provider). */
export function setVoiceConfig(
  config: SharedLlmConfigV1,
  kind: "tts" | "stt",
  next: { providerId?: string; model: string; voice?: string; speed?: number },
): void {
  config[kind] = {
    ...(next.providerId ? { providerId: next.providerId } : {}),
    model: next.model,
    ...(next.voice ? { voice: next.voice } : {}),
    ...(next.speed !== undefined ? { speed: next.speed } : {}),
  };
}

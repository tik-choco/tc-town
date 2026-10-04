// App-local task references, sharing and voice-call preferences.
import {
  createProvider, createRoomProvider, emptyLlmConfig, isModelRef, loadLlmConfig,
  migrateSharedLlmConfig, normalizeBaseUrl, patchProvider, presetIdToRef,
  providerKind, roomIdFromBaseUrl, saveLlmConfig, type ModelRefV1,
} from '@tik-choco/mistai/llm-config';
import { REASONING_EFFORT_OPTIONS, type LlmLocalSettings, type ReasoningEffort } from '@tik-choco/mistai/preact';
import { notifyAppDataChanged } from './appDataChangeBus';

export const SETTINGS_KEY = 'tc-town:provider-settings';
export const TASK_IDS = ['default', 'voice', 'growth', 'characterEvaluation', 'evaluation', 'plaza', 'world', 'expression'] as const;
export type TaskId = typeof TASK_IDS[number];
export const EXPRESSION_MODES = ['auto', 'on', 'off'] as const;
export type ExpressionMode = typeof EXPRESSION_MODES[number];
export interface ProviderSettings extends LlmLocalSettings {
  schemaVersion: 2;
  sttSilenceDuration: number;
  micThreshold: number;
  micDeviceId: string;
  bargeInEnabled: boolean;
  expressionMode: ExpressionMode;
  // Pre-shared-config profile IDs, retained only for imported character migration.
  legacyProfileRefs?: Record<string, { ref: ModelRefV1; reasoningEffort: ReasoningEffort }>;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function effort(value: unknown, fallback: ReasoningEffort = 'none'): ReasoningEffort {
  return REASONING_EFFORT_OPTIONS.includes(value as ReasoningEffort) ? value as ReasoningEffort : fallback;
}
export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  schemaVersion: 2, tasks: {}, roomProvide: {}, recentModels: [],
  sttSilenceDuration: 0.8, micThreshold: 0.02, micDeviceId: '', bargeInEnabled: true, expressionMode: 'auto',
};

export function sanitizeSettings(value: unknown, config = loadLlmConfig() ?? emptyLlmConfig()): ProviderSettings {
  const raw = record(value) ? value : {};
  const next: ProviderSettings = {
    ...DEFAULT_PROVIDER_SETTINGS, tasks: {}, roomProvide: {}, recentModels: [],
    sttSilenceDuration: typeof raw.sttSilenceDuration === 'number' && Number.isFinite(raw.sttSilenceDuration) ? Math.max(0, raw.sttSilenceDuration) : 0.8,
    micThreshold: typeof raw.micThreshold === 'number' && Number.isFinite(raw.micThreshold) ? Math.min(0.5, Math.max(0, raw.micThreshold)) : 0.02,
    micDeviceId: typeof raw.micDeviceId === 'string' ? raw.micDeviceId : '',
    bargeInEnabled: raw.bargeInEnabled !== false,
    expressionMode: EXPRESSION_MODES.includes(raw.expressionMode as ExpressionMode) ? raw.expressionMode as ExpressionMode : 'auto',
  };
  const oldDefault = config.presets.find(p => p.id === config.defaultPresetId);
  const legacy = raw.schemaVersion !== 2;
  if (record(raw.legacyProfileRefs)) {
    next.legacyProfileRefs = {};
    for (const [id, value] of Object.entries(raw.legacyProfileRefs)) {
      if (record(value) && isModelRef(value.ref)) next.legacyProfileRefs[id] = { ref: value.ref, reasoningEffort: effort(value.reasoningEffort) };
    }
  }
  const tasks = record(raw.tasks) ? raw.tasks : {};
  for (const id of new Set([...TASK_IDS, ...Object.keys(tasks)])) {
    const task = record(tasks[id]) ? tasks[id] : {};
    const presetId = typeof task.presetId === 'string' ? task.presetId : typeof tasks[id] === 'string' ? tasks[id] as string : '';
    const preset = config.presets.find(p => p.id === presetId);
    const ref = isModelRef(task.ref) ? task.ref : legacy && presetId ? presetIdToRef(config, presetId) : undefined;
    next.tasks[id] = { ref, reasoningEffort: effort(task.reasoningEffort, legacy ? effort(preset?.reasoningEffort ?? oldDefault?.reasoningEffort) : 'none') };
  }
  if (record(raw.roomProvide)) for (const [id, value] of Object.entries(raw.roomProvide)) {
    if (record(value)) next.roomProvide[id] = { enabled: value.enabled === true, shared: Array.isArray(value.shared) ? value.shared.filter(isModelRef) : [] };
  }
  if (Array.isArray(raw.recentModels)) {
    next.recentModels = raw.recentModels.filter(isModelRef).filter((ref, index, refs) => refs.findIndex(r => r.providerId === ref.providerId && r.model === ref.model) === index).slice(0, 8);
  }
  if (legacy) {
    const room = config.providers.find(p => roomIdFromBaseUrl(p.baseUrl) === config.network.roomId && providerKind(p) === 'room');
    if (room && !next.roomProvide[room.id]) {
      const ids = Array.isArray(raw.networkSharedPresetIds) ? raw.networkSharedPresetIds : Array.isArray(raw.sharedPresetIds) ? raw.sharedPresetIds : [config.defaultPresetId];
      const shared = ids.flatMap(id => { const ref = typeof id === 'string' ? presetIdToRef(config, id) : undefined; return ref ? [ref] : []; });
      next.roomProvide[room.id] = { enabled: raw.networkProviderEnabled === true, shared };
    }
  }
  return next;
}

const listeners = new Set<() => void>();
export function subscribeProviderSettings(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (event: StorageEvent) => { if (event.key === SETTINGS_KEY) cb(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(cb); window.removeEventListener('storage', onStorage); };
}
export function loadProviderSettings(): ProviderSettings {
  try { return sanitizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')); }
  catch { return sanitizeSettings({}); }
}
export function saveProviderSettings(settings: ProviderSettings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  catch (error) { console.warn('tc-town: failed to persist provider settings', error); }
  listeners.forEach(cb => cb());
  notifyAppDataChanged();
}
export const localSettingsAdapter = {
  get: loadProviderSettings,
  set: (next: LlmLocalSettings) => saveProviderSettings({ ...loadProviderSettings(), ...next }),
  subscribe: subscribeProviderSettings,
};

// Load migration is append-only for shared connections; legacy shared fields never change.
export function migrateLegacyProviderSettingsToShared(): void {
  const config = loadLlmConfig() ?? emptyLlmConfig();
  let raw: Record<string, unknown> = {};
  try { const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'); if (record(parsed)) raw = parsed; } catch { /* use defaults */ }
  let changed = migrateSharedLlmConfig(config).changed;
  const refs: NonNullable<ProviderSettings['legacyProfileRefs']> = {};
  const ensure = (baseUrl: string, apiKey: string, label = baseUrl) => {
    const url = normalizeBaseUrl(baseUrl);
    const existing = config.providers.find(p => normalizeBaseUrl(p.baseUrl) === url && p.apiKey === apiKey);
    if (existing) return existing.id;
    const id = createProvider(config, label); patchProvider(config, id, { baseUrl: url, apiKey }); changed = true; return id;
  };
  if (raw.schemaVersion !== 2 && Array.isArray(raw.profiles)) {
    for (const profile of raw.profiles) {
      if (!record(profile) || typeof profile.id !== 'string' || typeof profile.baseUrl !== 'string' || !profile.baseUrl.trim() || typeof profile.model !== 'string' || !profile.model.trim()) continue;
      const providerId = ensure(profile.baseUrl, typeof profile.apiKey === 'string' ? profile.apiKey : '', typeof profile.label === 'string' ? profile.label : profile.baseUrl);
      refs[profile.id] = { ref: { providerId, model: profile.model }, reasoningEffort: effort(profile.reasoningEffort) };
      const provider = config.providers.find(p => p.id === providerId)!;
      if (!provider.modelsFetchedAt && !provider.models?.includes(profile.model)) { provider.models = [...provider.models ?? [], profile.model]; changed = true; }
    }
    if (!config.defaultModel && typeof raw.defaultProfileId === 'string' && refs[raw.defaultProfileId]) { config.defaultModel = refs[raw.defaultProfileId].ref; changed = true; }
    for (const kind of ['tts', 'stt'] as const) {
      const voice = raw[kind];
      if (!config[kind] && record(voice) && typeof voice.baseUrl === 'string' && typeof voice.model === 'string' && voice.model && typeof voice.apiKey === 'string' && (voice.apiKey || !voice.baseUrl.includes('api.openai.com'))) {
        config[kind] = { providerId: ensure(voice.baseUrl, voice.apiKey), model: voice.model, ...(typeof voice.voice === 'string' ? { voice: voice.voice } : {}), ...(typeof voice.speed === 'number' ? { speed: voice.speed } : {}) }; changed = true;
      }
    }
    if (typeof raw.networkRoomId === 'string' && raw.networkRoomId.trim()) {
      const room = createRoomProvider(config, { roomId: raw.networkRoomId }); changed ||= !room.existed;
      if (!record(raw.roomProvide)) raw.roomProvide = {};
      (raw.roomProvide as Record<string, unknown>)[room.id] = { enabled: raw.networkProviderEnabled === true, shared: config.defaultModel && config.providers.some(p => p.id === config.defaultModel!.providerId && providerKind(p) === 'http') ? [config.defaultModel] : [] };
    }
  }
  if (changed) saveLlmConfig(config);
  if (raw.schemaVersion !== 2) {
    const settings = sanitizeSettings(raw, config);
    if (Object.keys(refs).length) {
      settings.legacyProfileRefs = refs;
      const oldDefault = typeof raw.defaultProfileId === 'string' ? refs[raw.defaultProfileId] : undefined;
      const oldTasks = record(raw.tasks) ? raw.tasks : {};
      for (const id of TASK_IDS) {
        const oldTask = record(oldTasks[id]) ? oldTasks[id] : {};
        const oldId = typeof oldTask.presetId === 'string' ? oldTask.presetId : '';
        const previous = refs[oldId];
        if (previous && !settings.tasks[id].ref) settings.tasks[id].ref = previous.ref;
        if (oldTask.reasoningEffort === undefined && (previous || oldDefault)) settings.tasks[id].reasoningEffort = (previous ?? oldDefault)!.reasoningEffort;
      }
    }
    const oldStt = raw.stt;
    if (record(oldStt) && typeof oldStt.silenceDuration === 'number') settings.sttSilenceDuration = oldStt.silenceDuration;
    saveProviderSettings(settings);
  }
}

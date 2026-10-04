import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { emptyLlmConfig, loadLlmConfig, saveLlmConfig, resolveModel } from '@tik-choco/mistai/llm-config';
import { loadProviderSettings, migrateLegacyProviderSettingsToShared, saveProviderSettings, SETTINGS_KEY } from './llmSettings';
import { requestChatCompletion } from './llm';
import { synthesizeSpeech, transcribeAudio } from './voice';
import { coerceCharacter, migrateCharacterModels } from './characterStorage';
const mocks = vi.hoisted(() => ({ tts: vi.fn(), stt: vi.fn(), oai: vi.fn() }));
vi.mock('./network', () => ({ rooms: { requestRoomTts: mocks.tts, requestRoomStt: mocks.stt, requestRoomOpenAi: mocks.oai } }));
vi.mock('./idbBlobStore', () => ({ deleteBlob: vi.fn() }));
let writes = 0;
beforeEach(() => {
  const values = new Map<string, string>(); writes = 0;
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); writes++; }, removeItem: (key: string) => values.delete(key) });
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());
function seed() {
  const config = emptyLlmConfig();
  config.providers = [{ id: 'http', label: 'Local', baseUrl: 'https://example.test/v1', apiKey: 'key', models: ['cached'] }, { id: 'disabled', label: 'Disabled', baseUrl: 'https://disabled.test/v1', apiKey: '', enabled: false }];
  config.presets = [{ id: 'old', label: 'Old', providerId: 'http', model: 'manual', reasoningEffort: 'high', temperature: 0.3 }];
  config.defaultPresetId = 'old'; config.network.roomId = 'team';
  saveLlmConfig(config);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ tasks: { default: { presetId: 'old' }, growth: { presetId: 'old', reasoningEffort: 'low' } }, networkProviderEnabled: true }));
  return config;
}
describe('provider-room integration', () => {
  it('migrates shared, task, character and providing data once without editing legacy fields', () => {
    const old = seed();
    localStorage.setItem('tc-town:characters', JSON.stringify([{ id: 'c', sheet: { name: 'C' }, llmProfileId: 'old' }]));
    migrateLegacyProviderSettingsToShared(); migrateCharacterModels();
    const config = loadLlmConfig()!; const local = loadProviderSettings();
    expect(config.defaultModel).toEqual({ providerId: 'http', model: 'manual' });
    expect(config.presets).toEqual(old.presets); expect(config.network).toEqual(old.network); expect(config.defaultPresetId).toBe('old');
    expect(config.providers[0].models).toEqual(['cached', 'manual']); expect(config.providers[1].enabled).toBe(false);
    expect(local.tasks.default).toEqual({ ref: config.defaultModel, reasoningEffort: 'high' }); expect(local.tasks.growth.reasoningEffort).toBe('low');
    const room = config.providers.find(p => p.baseUrl === 'mist-network://team')!;
    expect(local.roomProvide[room.id]).toEqual({ enabled: true, shared: [config.defaultModel] });
    const character = JSON.parse(localStorage.getItem('tc-town:characters')!)[0];
    expect(character.llmRef).toEqual(config.defaultModel); expect(character.reasoningEffort).toBe('high');
    const count = writes; migrateLegacyProviderSettingsToShared(); migrateCharacterModels(); expect(writes).toBe(count);
    delete character.llmRef; expect(coerceCharacter(character)?.llmRef).toBeUndefined();
  });
  it('imports pre-shared local profiles into refs without adding or changing shared presets', () => {
    const old = seed();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ profiles: [{ id: 'old-local', label: 'Custom', baseUrl: 'https://custom.test/v1', apiKey: 'key', model: 'custom-model', reasoningEffort: 'xhigh' }], defaultProfileId: 'old-local', tasks: { growth: { presetId: 'old-local' } }, networkRoomId: 'local-room', networkProviderEnabled: true }));
    migrateLegacyProviderSettingsToShared();
    const config = loadLlmConfig()!; const local = loadProviderSettings();
    expect(config.presets).toEqual(old.presets); expect(config.defaultPresetId).toBe(old.defaultPresetId); expect(config.network).toEqual(old.network);
    expect(local.tasks.growth.ref?.model).toBe('custom-model'); expect(local.tasks.growth.reasoningEffort).toBe('xhigh');
    expect(coerceCharacter({ id: 'import', llmProfileId: 'old-local' })?.llmRef?.model).toBe('custom-model');
    const count = writes; migrateLegacyProviderSettingsToShared(); expect(writes).toBe(count);
  });
  it('retains disabled task refs and falls back only to a usable default', () => {
    seed(); migrateLegacyProviderSettingsToShared(); const config = loadLlmConfig()!;
    const ref = { providerId: 'disabled', model: 'chosen' };
    expect(resolveModel(config, ref)?.model).toBe('manual'); expect(ref.providerId).toBe('disabled');
    config.providers[0].enabled = false; expect(resolveModel(config, ref)).toBeNull();
  });
  it('uses the selected task ref and effort for HTTP, never temperature', async () => {
    seed(); migrateLegacyProviderSettingsToShared(); const local = loadProviderSettings();
    local.tasks.growth = { ref: { providerId: 'http', model: 'selected' }, reasoningEffort: 'max' }; saveProviderSettings(local);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { headers: { 'Content-Type': 'application/json' } })); vi.stubGlobal('fetch', fetchMock);
    expect(await requestChatCompletion(undefined, [{ role: 'user', content: 'Test' }], { task: 'growth' })).toBe('OK');
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.model).toBe('selected'); expect(body.reasoning_effort).toBe('max'); expect(body).not.toHaveProperty('temperature');
  });
  it('uses the chosen room for chat effort, voice, language and auto voice models', async () => {
    seed(); migrateLegacyProviderSettingsToShared(); const config = loadLlmConfig()!;
    const room = config.providers.find(p => p.baseUrl === 'mist-network://team')!;
    mocks.oai.mockResolvedValue({ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'Room' } }] }) });
    await requestChatCompletion({ providerId: room.id, model: 'chosen' }, [{ role: 'user', content: 'Test' }], { reasoningEffort: 'xhigh' });
    expect(mocks.oai.mock.calls[0][0]).toBe('team'); expect(JSON.parse(mocks.oai.mock.calls[0][1].body).reasoning_effort).toBe('xhigh');
    const target = { baseUrl: 'mist-network://voice-room', apiKey: '', model: 'network-auto', voice: 'saved' };
    const audio = new Blob(['audio']); mocks.tts.mockResolvedValue(audio); mocks.stt.mockResolvedValue('Text');
    await synthesizeSpeech(target, 'Hello', { voice: 'character', lang: 'ja' });
    expect(mocks.tts).toHaveBeenCalledWith('voice-room', { text: 'Hello', model: undefined, voice: 'character', lang: 'ja' });
    await transcribeAudio(target, audio, 'speech.ogg'); expect(mocks.stt).toHaveBeenCalledWith('voice-room', { audio, model: undefined, fileName: 'speech.ogg' });
  });
});

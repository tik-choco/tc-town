import { afterEach, expect, it, vi } from 'vitest';
import { RoomProviderService, decode, encode } from '@tik-choco/mistai';
import { emptyLlmConfig, saveLlmConfig } from '@tik-choco/mistai/llm-config';
const mock = vi.hoisted(() => ({ init: vi.fn(), join: vi.fn(async (_room: string) => {}), leave: vi.fn(), send: vi.fn(), handler: undefined as undefined | ((event: number, from: string, payload: unknown, room: string) => void) }));
vi.mock('./mistClient', () => ({ NODE_ID_STORAGE_KEY: 'test-node', getNode: async () => { mock.init(); return { joinRoomAsync: mock.join, leaveRoom: mock.leave, sendMessage: mock.send }; }, subscribeEvent: (handler: typeof mock.handler) => { mock.handler = handler; return () => {}; } }));
import { rooms } from './network';
import { requestChatCompletion } from './llm';
import { loadProviderSettings, saveProviderSettings } from './llmSettings';
afterEach(() => vi.unstubAllGlobals());
it('keeps rooms isolated and carries streaming chat effort through the consumer and provider', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  const config = emptyLlmConfig();
  config.providers = [{ id: 'http', label: 'Endpoint', baseUrl: 'https://example.test/v1', apiKey: '', models: ['one', 'two'] }, { id: 'a', label: 'A', baseUrl: 'mist-network://a', apiKey: '' }, { id: 'b', label: 'B', baseUrl: 'mist-network://b', apiKey: '' }];
  config.defaultModel = { providerId: 'http', model: 'one' }; saveLlmConfig(config);
  const providing = { a: { enabled: true, shared: [{ providerId: 'http', model: 'one' }] }, b: { enabled: true, shared: [{ providerId: 'http', model: 'two' }] } };
  const service = new RoomProviderService({ config, roomProvide: providing, consumers: rooms, reasoningEffort: 'low' });
  try {
    await Promise.all([rooms.roomConsumer('a').connect('a'), rooms.roomConsumer('b').connect('b')]);
    await vi.waitFor(() => expect(Object.values(service.states).every(s => s.status === 'connected')).toBe(true));
    expect(mock.init).toHaveBeenCalledTimes(1);
    expect(mock.join.mock.calls.map(([room]) => room).sort()).toEqual(['a', 'b']);
    const hellos = mock.send.mock.calls.map(call => ({ message: decode(call[1]), room: call[3] })).filter(call => call.message?.type === 'provider_hello');
    expect(hellos.some(call => call.room === 'a' && call.message?.type === 'provider_hello' && call.message.models?.join() === 'one')).toBe(true);
    expect(hellos.some(call => call.room === 'b' && call.message?.type === 'provider_hello' && call.message.models?.join() === 'two')).toBe(true);
    mock.handler!(0, 'remote-a', encode({ v: 1, type: 'provider_hello', models: ['only-a'] }), 'a');
    const a = rooms.roomConsumer('a').status, b = rooms.roomConsumer('b').status;
    expect(a.phase === 'connected' ? a.models : []).toContain('only-a'); expect(b.phase === 'connected' ? b.models ?? [] : []).not.toContain('only-a');

    const local = loadProviderSettings();
    local.tasks.growth = { ref: { providerId: 'a', model: 'only-a' }, reasoningEffort: 'max' }; saveProviderSettings(local);
    const onDelta = vi.fn();
    const reply = requestChatCompletion(undefined, [{ role: 'user', content: 'Test' }], { task: 'growth', onDelta });
    const sentRequest = () => mock.send.mock.calls.map(call => decode(call[1])).find(msg => msg?.type === 'llm_request');
    await vi.waitFor(() => expect(sentRequest()).toBeDefined());
    const request = sentRequest()!;
    expect(request).toMatchObject({ model: 'only-a', reasoning_effort: 'max', messages: [{ role: 'user', content: 'Test' }] });
    expect(request).not.toHaveProperty('temperature');
    expect(mock.send.mock.calls.some(call => decode(call[1])?.type === 'oai_request')).toBe(false);
    mock.handler!(0, 'remote-a', encode({ v: 1, type: 'llm_response_chunk', id: request.id, delta: 'Ro', seq: 0 }), 'a');
    expect(onDelta.mock.calls).toEqual([['Ro', 'Ro']]);
    mock.handler!(0, 'remote-a', encode({ v: 1, type: 'llm_response_chunk', id: request.id, delta: 'om', seq: 1 }), 'a');
    expect(onDelta.mock.calls).toEqual([['Ro', 'Ro'], ['om', 'Room']]);
    mock.handler!(0, 'remote-a', encode({ v: 1, type: 'llm_response_done', id: request.id }), 'a');
    expect(await reply).toBe('Room');

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: 'Provided' } }] }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    for (const inboundEffort of ['xhigh', 'none', undefined]) {
      const id = `inbound-${inboundEffort}`;
      mock.handler!(0, 'remote-b', encode({ v: 1, type: 'llm_request', id, model: 'two', messages: [{ role: 'user', content: 'Test' }], ...(inboundEffort !== undefined ? { reasoning_effort: inboundEffort } : {}) }), 'b');
      await vi.waitFor(() => expect(mock.send.mock.calls.some(call => {
        const message = decode(call[1]);
        return call[3] === 'b' && message?.type === 'llm_response_done' && message.id === id;
      })).toBe(true));
      const body = JSON.parse(fetchMock.mock.calls.at(-1)![1]?.body as string);
      expect(body).toMatchObject({ model: 'two', reasoning_effort: inboundEffort ?? 'low' });
      expect(body).not.toHaveProperty('temperature');
    }
    rooms.disconnectRoom('a'); expect(mock.leave).not.toHaveBeenCalled();
    service.update({ config, roomProvide: { ...providing, a: { ...providing.a, enabled: false } }, consumers: rooms });
    expect(mock.leave).toHaveBeenCalledWith('a'); expect(mock.leave).not.toHaveBeenCalledWith('b');
  } finally { rooms.disconnectRoom('a'); rooms.disconnectRoom('b'); service.destroy(); }
});

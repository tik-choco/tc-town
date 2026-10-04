import { MistaiError, streamChatCompletion } from '@tik-choco/mistai';
import { emptyLlmConfig, loadLlmConfig, resolveModel, roomIdFromBaseUrl, type ModelRefV1 } from '@tik-choco/mistai/llm-config';
import type { ChatMessage } from '../types';
import { loadProviderSettings, type TaskId } from './llmSettings';
import { rooms } from './network';
import { aiMessages } from '../i18n/ai';
import { loadAppSettings } from './appSettings';

export interface RequestChatOptions {
  onDelta?: (delta: string, full: string) => void;
  task?: TaskId;
  reasoningEffort?: string;
}
export async function requestChatCompletion(ref: ModelRefV1 | undefined, messages: ChatMessage[], options?: RequestChatOptions): Promise<string> {
  const config = loadLlmConfig() ?? emptyLlmConfig();
  const task = loadProviderSettings().tasks[options?.task ?? 'default'];
  const target = resolveModel(config, ref ?? task?.ref);
  if (!target) throw new Error(aiMessages(loadAppSettings().language).noModel);
  const reasoningEffort = options?.reasoningEffort ?? task?.reasoningEffort ?? 'none';
  const room = roomIdFromBaseUrl(target.baseUrl);
  if (room) {
    // The OpenAI tunnel carries per-task reasoning effort as well as vision messages.
    const response = await rooms.requestRoomOpenAi(room, { path: '/chat/completions', method: 'POST', contentType: 'application/json', body: JSON.stringify({ model: target.model, messages, reasoning_effort: reasoningEffort, stream: false }) });
    if (response.status < 200 || response.status >= 300) throw new MistaiError('UPSTREAM_BAD_RESPONSE', response.body);
    const body = JSON.parse(response.body) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) throw new MistaiError('UPSTREAM_BAD_RESPONSE', aiMessages(loadAppSettings().language).emptyResponse);
    options?.onDelta?.(text, text);
    return text;
  }
  let full = '';
  const text = await streamChatCompletion({ ...target, reasoningEffort }, messages, options?.onDelta ? delta => { full += delta; options.onDelta!(delta, full); } : undefined);
  if (!text.trim()) throw new MistaiError('UPSTREAM_BAD_RESPONSE', aiMessages(loadAppSettings().language).emptyResponse);
  return text;
}

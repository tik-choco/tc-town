// Shared "list TTS voices from an OpenAI-compatible endpoint" helper.
//
// The fetch/parse logic and the static OpenAI voice set now live in mistai
// (`fetchVoices`/`OPENAI_TTS_VOICES`, promoted from this file's former
// standalone implementation in mistai v0.6.0 — see
// tc-docs/drafts/tts-voice-selection-v1.md §2.5/§3.4 Tier3). This file is now
// just an adapter: mistai's `fetchVoices(baseUrl, apiKey?, fetchFn?)` takes
// positional args and never throws (resolves `[]` when neither
// `{baseUrl}/audio/voices` nor `{baseUrl}/voices` returns a usable list),
// whereas `useFetchedOptions` (lib/models.ts) expects a
// `(config: {baseUrl, apiKey}, fetchFn?) => Promise<string[]>` fetcher. The
// wrapper below bridges the argument shapes; the never-throws part is
// already handled correctly by every caller here, since CharactersView's/
// SettingsView's `fallbackOptions` usage picks the fallback off
// `options.length > 0` rather than fetch status.

import { fetchVoices as mistaiFetchVoices, OPENAI_TTS_VOICES, type FetchFn } from "@tik-choco/mistai";
import { useFetchedOptions, type ModelOptionsState } from "./models";

export { OPENAI_TTS_VOICES };

/** Adapter from mistai's `fetchVoices(baseUrl, apiKey?, fetchFn?)` to the
 * `(config, fetchFn?)` shape `useFetchedOptions` expects. */
export async function fetchVoices(
  config: { baseUrl: string; apiKey: string },
  fetchFn: FetchFn = fetch,
): Promise<string[]> {
  return mistaiFetchVoices(config.baseUrl, config.apiKey, fetchFn);
}

/** Thin wrapper around {@link useFetchedOptions} for the TTS voice field. */
export function useVoiceOptions(baseUrl: string, apiKey: string): ModelOptionsState {
  return useFetchedOptions(baseUrl, apiKey, fetchVoices, "音声一覧の取得に失敗しました。");
}

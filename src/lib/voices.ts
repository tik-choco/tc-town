// Shared "list TTS voices from an OpenAI-compatible endpoint" helper.
//
// OpenAI's own API has no voices-listing endpoint, but many OpenAI-compatible
// TTS servers expose one — commonly GET {baseUrl}/audio/voices or
// {baseUrl}/voices. fetchVoices tries both, tolerating a `{ voices: [...] }`,
// `{ data: [...] }`, or plain array response shape, with entries being either
// plain strings or `{ id | name | voice }` objects (mirroring tc-assistant2's
// openaiApi.ts createVoicesUrl/parseVoicesResponse convention). If neither
// endpoint returns a usable list, it throws — callers should fall back to
// OPENAI_TTS_VOICES (the standard OpenAI voice set) via useFetchedOptions'
// error path, same as ModelField's fallbackOptions.

import type { FetchFn } from "@tik-choco/mistai";
import { useFetchedOptions, type ModelOptionsState } from "./models";

/** OpenAI's documented voice set, used as a UI fallback when an endpoint can't list voices. */
export const OPENAI_TTS_VOICES: string[] = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Parses a voices response body, tolerating array/`voices`/`data` wrappers and string/object entries. */
function parseVoicesBody(body: unknown): string[] {
  const rawList = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.voices)
      ? body.voices
      : isRecord(body) && Array.isArray(body.data)
        ? body.data
        : [];

  return rawList
    .map((entry): string => {
      if (typeof entry === "string") return entry;
      if (isRecord(entry)) {
        if (typeof entry.id === "string") return entry.id;
        if (typeof entry.name === "string") return entry.name;
        if (typeof entry.voice === "string") return entry.voice;
      }
      return "";
    })
    .filter((id): id is string => id.length > 0);
}

/** Tries one candidate voices endpoint; returns null (not throw) so the caller can try the next one. */
async function tryVoicesEndpoint(url: string, apiKey: string, fetchFn: FetchFn): Promise<string[] | null> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
  } catch {
    return null; // network error — fall through to the next candidate endpoint
  }
  if (!response.ok) return null;

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return null;
  }

  const voices = parseVoicesBody(json);
  return voices.length > 0 ? voices : null;
}

/**
 * Fetches TTS voice names from `{baseUrl}/audio/voices`, falling back to
 * `{baseUrl}/voices` if that doesn't return a usable list. Throws a plain
 * Error with a Japanese message if neither endpoint works.
 */
export async function fetchVoices(
  config: { baseUrl: string; apiKey: string },
  fetchFn: FetchFn = fetch,
): Promise<string[]> {
  const base = config.baseUrl.replace(/\/+$/, "");
  const candidates = [`${base}/audio/voices`, `${base}/voices`];

  for (const url of candidates) {
    const voices = await tryVoicesEndpoint(url, config.apiKey, fetchFn);
    if (voices) return voices;
  }

  throw new Error("音声一覧の取得に失敗しました。");
}

/** Thin wrapper around {@link useFetchedOptions} for the TTS voice field. */
export function useVoiceOptions(baseUrl: string, apiKey: string): ModelOptionsState {
  return useFetchedOptions(baseUrl, apiKey, fetchVoices, "音声一覧の取得に失敗しました。");
}

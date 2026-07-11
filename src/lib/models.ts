// Shared "list options from an OpenAI-compatible endpoint" hook for the
// settings screen. Used by the LLM profile editor's model field, the TTS/STT
// model fields, and the TTS voice field alike — each just points it at its
// own baseUrl/apiKey and its own fetcher function (fetchModels, fetchVoices).
//
// Fetching is on-demand only: once when a field first mounts (the "profile
// editor opens" moment) and again whenever the caller invokes `refresh()`
// (the refresh button). It never re-fetches on baseUrl/apiKey keystrokes, so
// typing doesn't thrash the endpoint.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { fetchModels, formatMistaiError, MESSAGES_JA, type FetchFn } from "@tik-choco/mistai";

export type ModelFetchStatus = "idle" | "loading" | "done" | "error";

export interface ModelOptionsState {
  /** Ids fetched from the endpoint (empty until a fetch succeeds). */
  options: string[];
  status: ModelFetchStatus;
  /** Japanese message describing the last failure, set only when status is "error". */
  errorMessage: string;
  /** Re-fetches using the latest baseUrl/apiKey passed to the hook. */
  refresh: () => void;
}

export type OptionsFetcher = (
  config: { baseUrl: string; apiKey: string },
  fetchFn?: FetchFn,
) => Promise<string[]>;

/**
 * Generic version of {@link useModelOptions}: fetches a string list via
 * `fetcher({ baseUrl, apiKey })`. `baseUrl`/`apiKey` are read fresh on every
 * fetch (via a ref) but changing them does NOT by itself trigger a re-fetch —
 * call `refresh()` explicitly.
 */
export function useFetchedOptions(
  baseUrl: string,
  apiKey: string,
  fetcher: OptionsFetcher,
  errorFallbackMessage: string,
): ModelOptionsState {
  const [options, setOptions] = useState<string[]>([]);
  const [status, setStatus] = useState<ModelFetchStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const configRef = useRef({ baseUrl, apiKey });
  configRef.current = { baseUrl, apiKey };

  const refresh = useCallback(() => {
    const { baseUrl, apiKey } = configRef.current;
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl) {
      setOptions([]);
      setStatus("idle");
      setErrorMessage("");
      return;
    }

    setStatus("loading");
    setErrorMessage("");
    void fetcher({ baseUrl: trimmedBaseUrl, apiKey })
      .then((ids) => {
        setOptions([...new Set(ids)].sort((left, right) => left.localeCompare(right)));
        setStatus("done");
      })
      .catch((error: unknown) => {
        setOptions([]);
        setStatus("error");
        setErrorMessage(formatMistaiError(error, MESSAGES_JA, errorFallbackMessage));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher]);

  // Fetch once when the field mounts; further fetches only happen through
  // an explicit refresh() call (e.g. the refresh button).
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { options, status, errorMessage, refresh };
}

/**
 * Fetches the list of model ids from `{baseUrl}/models`. Thin wrapper around
 * {@link useFetchedOptions} for the LLM profile / TTS / STT model fields.
 */
export function useModelOptions(baseUrl: string, apiKey: string): ModelOptionsState {
  return useFetchedOptions(baseUrl, apiKey, fetchModels, "モデル一覧の取得に失敗しました。");
}

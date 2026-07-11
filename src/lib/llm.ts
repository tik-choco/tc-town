// Chat-completion entry point for tc-town. Conversation orchestration and the
// character growth interview call requestChatCompletion() with a preset id
// (Character.llmProfileId — field name kept from before the shared-config
// migration, see types.ts) and don't care whether the request goes
// direct-to-API (via @tik-choco/mistai's streamChatCompletion) or over the AI
// Network (via the ConsumerClient). Both branches stream deltas through
// onDelta and resolve with the full reply. Modeled on tc-translate's
// src/lib/llm.ts.
//
// LLM connection info (baseUrl/apiKey/model/temperature/reasoningEffort) is
// resolved from the shared tc-shared-llm-config-v1 key (lib/llmConfig.ts) via
// resolvePreset — this app no longer keeps its own copy of that data.

import { MistaiError, streamChatCompletion, type OpenAIConfig } from "@tik-choco/mistai";
import type { ChatMessage } from "../types";
import { emptyLlmConfig, loadLlmConfig, normalizeBaseUrl, resolvePreset } from "./llmConfig";
import { loadProviderSettings } from "./llmSettings";
import { networkClient, requestNetworkChat } from "./network";

export interface RequestChatOptions {
  onDelta?: (delta: string, full: string) => void;
  temperature?: number;
}

/** Minimal shape requestApiChatCompletion(Streaming) need — a resolved preset (see llmConfig.ts's ResolvedLlmTargetV1) satisfies this structurally. */
export interface LlmCallTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  reasoningEffort?: string;
}

// Maps a resolved target onto the shared library's upstream config.
// reasoningEffort is forwarded only when set — "" means the preset opted out
// of sending the reasoning_effort parameter entirely.
function apiConfig(target: LlmCallTarget, temperature?: number): OpenAIConfig {
  const reasoningEffort = target.reasoningEffort?.trim();
  return {
    baseUrl: normalizeBaseUrl(target.baseUrl),
    apiKey: target.apiKey,
    model: target.model.trim(),
    temperature: temperature ?? target.temperature,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/**
 * Resolves `presetId` ("default" or a `ModelPresetV1.id`) against the shared
 * LLM config and requests a chat completion from it. Routes through the AI
 * Network consumer when it's enabled and currently connected; otherwise calls
 * the preset's OpenAI-compatible endpoint directly.
 */
export async function requestChatCompletion(
  presetId: string,
  messages: ChatMessage[],
  options?: RequestChatOptions,
): Promise<string> {
  const cfg = loadLlmConfig() ?? emptyLlmConfig();
  const target = resolvePreset(cfg, presetId);
  if (!target) throw new Error("LLM プリセットが見つかりません。設定画面の「LLM」タブから接続を設定してください。");

  const settings = loadProviderSettings();
  if (settings.networkConsumerEnabled && networkClient.status.phase === "connected") {
    return requestNetworkChat(cfg.network.roomId, messages, target.model.trim() || undefined, options?.onDelta);
  }

  return requestApiChatCompletion(target, messages, options);
}

async function requestApiChatCompletion(
  target: LlmCallTarget,
  messages: ChatMessage[],
  options?: RequestChatOptions,
): Promise<string> {
  // streamChatCompletion's onDelta hands us the fragment only; accumulate the
  // running text ourselves so callers get the (delta, full) pair.
  let full = "";
  const onDelta = options?.onDelta;
  const content = await streamChatCompletion(
    apiConfig(target, options?.temperature),
    messages,
    onDelta
      ? (delta) => {
          full += delta;
          onDelta(delta, full);
        }
      : undefined,
  );

  if (!content.trim()) {
    throw new MistaiError("UPSTREAM_BAD_RESPONSE", "プロバイダーが空の応答を返しました。");
  }

  return content;
}

/**
 * Streaming variant used by the AI Network provider hook to forward llm_request
 * traffic to this app's configured endpoint: same OpenAI-compatible call, but
 * deltas are relayed chunk-by-chunk to the remote consumer. `model` overrides
 * the target's own model when the requester asked for a specific one.
 */
export async function requestApiChatCompletionStreaming(
  target: LlmCallTarget,
  messages: ChatMessage[],
  model: string | undefined,
  onDelta: (delta: string) => void,
): Promise<string> {
  const config = apiConfig(target);
  const full = await streamChatCompletion({ ...config, model: (model ?? config.model ?? "").trim() }, messages, onDelta);

  if (!full.trim()) {
    throw new MistaiError("UPSTREAM_BAD_RESPONSE", "プロバイダーが空の応答を返しました。");
  }

  return full;
}

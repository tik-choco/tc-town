import { useEffect, useRef, useState } from "preact/hooks";
import { Loader2, Mic, MicOff, PhoneCall, PhoneOff } from "lucide-preact";
import type { ChatMessage, Character } from "../types";
import { listCharacters, subscribeCharacters, toPersonaPrompt } from "../lib/characterStorage";
import { loadProviderSettings } from "../lib/llmSettings";
import { emptyLlmConfig, loadLlmConfig, resolvePreset, resolveVoice, type SharedLlmConfigV1 } from "../lib/llmConfig";
import { requestChatCompletion } from "../lib/llm";
import { maybeClassifyEmotion } from "../lib/emotionClassifier";
import { getWorld } from "../lib/worlds";
import {
  guessFileName,
  speak,
  startRecording,
  transcribeAudio,
  type RecordingHandle,
  type SpeechHandle,
  type VoiceTarget,
} from "../lib/voice";
import { CharacterAvatar } from "../components/CharacterAvatar";
import "../styles/voice.css";

// Voice replies are read aloud, so append a spoken-style hint to the shared
// persona prompt (the canonical toPersonaPrompt lives in characterStorage).
function voicePersonaPrompt(character: Character): string {
  const world = getWorld(character.worldId);
  return `${toPersonaPrompt(character.sheet, world)}\n\n返答は音声で読み上げられるため、短く自然な話し言葉で答えてください。`;
}

type CallStatus = "idle" | "listening" | "thinking" | "speaking";

const STATUS_LABEL: Record<CallStatus, string> = {
  idle: "通話を開始できます",
  listening: "聞き取り中…",
  thinking: "考え中…",
  speaking: "話し中…",
};

interface TranscriptLine {
  id: number;
  role: "user" | "assistant";
  text: string;
}

/** Minimum recorded size to bother transcribing — filters out near-silent blips. */
const MIN_RECORDING_BYTES = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Like resolveVoice(), but tolerates an empty/unset model: the request layer
 * has its own fallbacks (voice.ts sends whisper-1/tts-1 when model is empty)
 * and some servers ignore the model field entirely — e.g. a local whisper
 * server whose model listing fails still transcribes fine. Only the
 * connection (provider) has to resolve. resolveVoice() itself is part of the
 * vendored shared-config contract, so the relaxation lives here app-side.
 */
function resolveVoiceTarget(cfg: SharedLlmConfigV1, kind: "tts" | "stt"): VoiceTarget | null {
  const strict = resolveVoice(cfg, kind);
  if (strict) return strict;

  const vc = cfg[kind];
  const provider = vc?.providerId
    ? cfg.providers.find((p) => p.id === vc.providerId)
    : (() => {
        const target = resolvePreset(cfg);
        return target ? cfg.providers.find((p) => p.id === target.providerId) : undefined;
      })();
  if (!provider) return null;

  const resolved: VoiceTarget = { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: vc?.model ?? "" };
  if (vc?.voice !== undefined) resolved.voice = vc.voice;
  if (vc?.speed !== undefined) resolved.speed = vc.speed;
  return resolved;
}

/**
 * Explains WHY resolveVoiceTarget() would fail for tts/stt, in user-facing
 * terms — a bare null used to surface as a generic "未設定" message even when
 * the real problem was a dangling provider reference or an unresolvable
 * default preset. Returns null when both connections resolve fine.
 */
function describeVoiceSetupProblem(cfg: SharedLlmConfigV1): string | null {
  for (const kind of ["tts", "stt"] as const) {
    const label = kind === "tts" ? "読み上げ（TTS）" : "書き起こし（STT）";
    const vc = cfg[kind];
    if (vc?.providerId) {
      if (!cfg.providers.some((p) => p.id === vc.providerId)) {
        return `${label}の接続先が見つかりません（削除された可能性があります）。設定画面の「音声」タブで接続先を選び直してください。`;
      }
    } else if (!resolvePreset(cfg)) {
      return `${label}の接続先が「LLMと同じ」ですが、既定のLLMプリセットが解決できません。設定画面の「プリセット」タブで既定プリセットと接続先を確認するか、「音声」タブで接続先を直接指定してください。`;
    }
  }
  return null;
}

export function VoiceView() {
  const [characters, setCharacters] = useState<Character[]>(() => listCharacters());
  const [selectedId, setSelectedId] = useState<string | null>(characters[0]?.id ?? null);

  // Reflect edits/creations/deletions made in the Characters view (same tab or
  // another) so the picker stays current.
  useEffect(() => {
    const refresh = () => setCharacters(listCharacters());
    const unsubscribe = subscribeCharacters(refresh);
    refresh();
    return unsubscribe;
  }, []);
  const [callActive, setCallActive] = useState(false);
  const [status, setStatus] = useState<CallStatus>("idle");
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const activeRef = useRef(false);
  const mutedRef = useRef(false);
  const recordingRef = useRef<RecordingHandle | null>(null);
  const speechRef = useRef<SpeechHandle | null>(null);
  const nextLineId = useRef(0);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const character = characters.find((c) => c.id === selectedId) ?? null;

  // Keep the selection valid as the character list changes underneath us
  // (e.g. the selected character was deleted from another tab): fall back to
  // the first character instead of leaving the start button dead.
  useEffect(() => {
    if (!characters.some((c) => c.id === selectedId)) {
      setSelectedId(characters[0]?.id ?? null);
    }
  }, [characters, selectedId]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  // Tear down any open mic stream / in-flight playback if the view unmounts
  // mid-call, so nothing leaks.
  useEffect(
    () => () => {
      activeRef.current = false;
      recordingRef.current?.cancel();
      speechRef.current?.stop();
    },
    [],
  );

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [transcript]);

  function appendLine(role: "user" | "assistant", text: string) {
    const id = nextLineId.current++;
    setTranscript((prev) => [...prev, { id, role, text }]);
  }

  async function runCallLoop(character: Character) {
    const cfg = loadLlmConfig() ?? emptyLlmConfig();
    const ttsTarget = resolveVoiceTarget(cfg, "tts");
    const sttTarget = resolveVoiceTarget(cfg, "stt");
    if (!ttsTarget || !sttTarget) {
      setErrorMessage(
        describeVoiceSetupProblem(cfg) ??
          "TTS/STTが設定されていません。設定画面の「音声」タブから接続先を設定してください。",
      );
      activeRef.current = false;
      setCallActive(false);
      setStatus("idle");
      return;
    }

    const settings = loadProviderSettings();
    const history: ChatMessage[] = [{ role: "system", content: voicePersonaPrompt(character) }];

    while (activeRef.current) {
      // Pause listening while muted, without tearing down the call.
      while (activeRef.current && mutedRef.current) {
        await sleep(150);
      }
      if (!activeRef.current) break;

      setStatus("listening");
      setErrorMessage(null);
      let recording: RecordingHandle;
      try {
        recording = await startRecording(settings.sttSilenceDuration);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "マイクを利用できませんでした。");
        activeRef.current = false;
        break;
      }
      recordingRef.current = recording;

      let audioBlob: Blob;
      try {
        audioBlob = await recording.result;
      } catch {
        recordingRef.current = null;
        if (!activeRef.current) break;
        continue; // cancelled (e.g. muted mid-listen) — loop back and re-check state
      }
      recordingRef.current = null;
      if (!activeRef.current) break;
      if (audioBlob.size < MIN_RECORDING_BYTES) continue; // essentially silence, keep listening

      setStatus("thinking");
      let text: string;
      try {
        text = await transcribeAudio(sttTarget, audioBlob, guessFileName(audioBlob));
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "音声認識に失敗しました。");
        continue;
      }
      if (!activeRef.current) break;
      if (!text.trim()) continue;

      appendLine("user", text);
      history.push({ role: "user", content: text });

      let reply: string;
      try {
        reply = await requestChatCompletion(character.llmProfileId, history);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "応答の生成に失敗しました。");
        continue;
      }
      if (!activeRef.current) break;

      history.push({ role: "assistant", content: reply });
      appendLine("assistant", reply);
      // Fire-and-forget: classify the reply's emotion for the VRM face as
      // soon as the text is settled, without waiting for TTS to finish.
      maybeClassifyEmotion(character.id, reply, character.llmProfileId);

      setStatus("speaking");
      setSpeaking(true);
      const handle = speak(ttsTarget, reply, character.voiceName);
      speechRef.current = handle;
      await handle.done;
      speechRef.current = null;
      setSpeaking(false);
    }

    setStatus("idle");
  }

  function startCall() {
    if (!character || callActive) return;
    setTranscript([]);
    setErrorMessage(null);
    setMuted(false);
    setCallActive(true);
    activeRef.current = true;
    void runCallLoop(character);
  }

  function endCall() {
    activeRef.current = false;
    recordingRef.current?.cancel();
    recordingRef.current = null;
    speechRef.current?.stop();
    speechRef.current = null;
    setCallActive(false);
    setSpeaking(false);
    setStatus("idle");
  }

  function toggleMute() {
    setMuted((prev) => {
      const next = !prev;
      if (next) recordingRef.current?.cancel();
      return next;
    });
  }

  if (characters.length === 0) {
    return (
      <div class="tc-voice-view">
        <div class="tc-voice-empty">キャラクターがいません。先にキャラクターを作成してください。</div>
      </div>
    );
  }

  if (!callActive) {
    return (
      <div class="tc-voice-view">
        <div class="tc-voice-picker">
          <h2>通話するキャラクターを選択</h2>
          <div class="tc-voice-picker-list">
            {characters.map((c) => (
              <button
                key={c.id}
                type="button"
                class="tc-voice-picker-item"
                aria-pressed={c.id === selectedId}
                onClick={() => setSelectedId(c.id)}
              >
                <CharacterAvatar character={c} size={64} />
                <span>{c.sheet.name || "無名"}</span>
              </button>
            ))}
          </div>
        </div>
        {errorMessage && <div class="tc-voice-error">{errorMessage}</div>}
        <button type="button" class="tc-voice-start" onClick={startCall} disabled={!character}>
          <PhoneCall size={18} />
          通話を開始
        </button>
      </div>
    );
  }

  return (
    <div class="tc-voice-view">
      <div class="tc-voice-call">
        <div class="tc-voice-avatar-wrap">
          {character!.avatar?.kind === "vrm" ? (
            // Full-body stage: the whole figure reads large and the legs
            // dissolve into the transcript panel below (masked in CSS)
            // instead of being cropped at the waist. The stage div owns the
            // (responsive) box; fill lets the avatar canvas track it;
            // interactive enables drag-to-orbit now that there's a full
            // figure worth looking around.
            <div class="tc-voice-avatar-stage">
              <CharacterAvatar character={character!} speaking={speaking} size={200} framing="full" fill interactive />
            </div>
          ) : (
            <CharacterAvatar character={character!} speaking={speaking} size={140} />
          )}
          <div class="tc-voice-name">{character!.sheet.name || "無名"}</div>
          <div class="tc-voice-status" data-status={status}>
            {status === "thinking" && <Loader2 size={16} />}
            {muted ? "ミュート中" : STATUS_LABEL[status]}
          </div>
          {errorMessage && <div class="tc-voice-error">{errorMessage}</div>}
        </div>

        <div class="tc-voice-transcript">
          {transcript.map((line) => (
            <div key={line.id} class="tc-voice-line" data-role={line.role}>
              {line.text}
            </div>
          ))}
          <div ref={transcriptEndRef} />
        </div>

        <div class="tc-voice-controls">
          <button
            type="button"
            class="tc-voice-btn"
            aria-pressed={muted}
            onClick={toggleMute}
            title={muted ? "ミュート解除" : "ミュート"}
          >
            {muted ? <MicOff size={20} /> : <Mic size={20} />}
          </button>
          <button type="button" class="tc-voice-btn tc-voice-btn-end" onClick={endCall} title="通話を終了">
            <PhoneOff size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}

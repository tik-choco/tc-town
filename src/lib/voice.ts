// Voice call media I/O: OpenAI-compatible TTS ("{baseUrl}/audio/speech") and
// STT ("{baseUrl}/audio/transcriptions") against a resolved voice target (the
// shape lib/llmConfig.ts's resolveVoice() returns — baseUrl/apiKey/model
// resolved from the shared LLM config's `tts`/`stt` VoiceConfigV1, which have
// no connection info of their own), plus microphone capture with
// silence-based end-of-utterance detection. Conversation looping and UI
// state live in views/VoiceView.tsx — this module only owns talking to the
// endpoints, mic capture, and playback.
//
// Mic capture is a persistent MicSession (createMicSession) rather than a
// one-shot recorder: a call keeps one microphone stream + AudioContext open
// for the whole call and records individual utterances against it. This is
// what makes barge-in possible — while the character's reply is playing,
// VoiceView can start a new utterance on the *same* session with
// deferRecordUntilSpeech, so sustained user speech is both detected (to stop
// TTS playback immediately) and captured (so the interrupting words aren't
// lost) without reopening the mic. Voice-activity detection is a simple RMS
// threshold with a start-voice debounce (resist transients/click noise) and
// a minimum voiced-duration gate (filter out coughs/room noise from ever
// reaching STT) — no ML VAD, matching the reference Go implementation this
// was ported from.
//
// @tik-choco/mistai does ship voice helpers (VoiceConsumerService /
// VoiceProviderService), but those speak the AI Network peer protocol for
// *sharing* a voice endpoint between devices — they don't call an
// OpenAI-compatible HTTP endpoint directly, which is what the voice call
// feature needs here. So this file hand-rolls fetch calls, mirroring the
// shape of mistai's openai.ts (streamChatCompletion) and tc-assistant2's
// openaiApi.ts (speakWithOpenAi / transcribeAudio).

/** Connection + model info for one TTS or STT call — matches lib/llmConfig.ts's resolveVoice() return shape (no silenceDuration: that's app-local, see lib/llmSettings.ts). */
export interface VoiceTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** TTS voice name (ignored for STT). */
  voice?: string;
  /** TTS playback speed (ignored for STT). */
  speed?: number;
}

function endpointUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith(path) ? trimmed : `${trimmed}${path}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  const trimmed = apiKey.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
}

async function readErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    const json = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof json.error === "string") return json.error;
    if (json.error && typeof json.error === "object" && typeof json.error.message === "string") return json.error.message;
    if (typeof json.message === "string") return json.message;
  } catch {
    // not JSON — fall through to raw text
  }
  return text.slice(0, 200);
}

/** POSTs `{baseUrl}/audio/speech`; resolves with the synthesized audio Blob. */
export async function synthesizeSpeech(
  profile: VoiceTarget,
  text: string,
  options?: { voice?: string; signal?: AbortSignal },
): Promise<Blob> {
  const url = endpointUrl(profile.baseUrl, "/audio/speech");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(profile.apiKey) },
    signal: options?.signal,
    body: JSON.stringify({
      model: profile.model || "tts-1",
      voice: options?.voice ?? profile.voice ?? "alloy",
      input: text,
      speed: profile.speed ?? 1,
    }),
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(detail ? `TTS failed: HTTP ${response.status} ${detail}` : `TTS failed: HTTP ${response.status}`);
  }
  return response.blob();
}

/** POSTs `{baseUrl}/audio/transcriptions`; resolves with the recognized text. */
export async function transcribeAudio(profile: VoiceTarget, audio: Blob, fileName = "speech.webm"): Promise<string> {
  const url = endpointUrl(profile.baseUrl, "/audio/transcriptions");
  const formData = new FormData();
  formData.append("file", audio, fileName);
  formData.append("model", profile.model || "whisper-1");
  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders(profile.apiKey),
    body: formData,
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(detail ? `STT failed: HTTP ${response.status} ${detail}` : `STT failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === "string" ? body.text : "";
}

/** Picks a filename extension matching a recorded blob's MIME type, for the
 * STT endpoint's multipart upload (some servers sniff the extension). */
export function guessFileName(blob: Blob): string {
  const type = blob.type.toLowerCase();
  if (type.includes("ogg")) return "speech.ogg";
  if (type.includes("mp4")) return "speech.mp4";
  if (type.includes("wav")) return "speech.wav";
  return "speech.webm";
}

/** Plays `blob` through a fresh <audio> element; resolves when playback ends
 * (naturally or via `signal` abort) and always revokes its object URL. */
export function playAudioBlob(blob: Blob, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onEnded);
      signal?.removeEventListener("abort", onAbort);
      URL.revokeObjectURL(url);
      resolve();
    };
    const onEnded = () => finish();
    const onAbort = () => {
      audio.pause();
      finish();
    };
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onEnded);
    signal?.addEventListener("abort", onAbort);
    audio.play().catch(() => finish());
  });
}

export interface SpeechHandle {
  /** Interrupts synthesis/playback immediately (e.g. the user ends the call mid-reply). */
  stop: () => void;
  /** Resolves once playback has finished or been stopped. Never rejects. */
  done: Promise<void>;
}

/**
 * Synthesizes `text` against `profile` and plays it back. `voiceOverride`
 * (a character's `voiceName`) wins over the profile's own `voice` when set.
 */
export function speak(profile: VoiceTarget, text: string, voiceOverride?: string): SpeechHandle {
  const controller = new AbortController();
  const done = (async () => {
    try {
      const blob = await synthesizeSpeech(profile, text, { voice: voiceOverride, signal: controller.signal });
      if (controller.signal.aborted) return;
      await playAudioBlob(blob, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      throw err;
    }
  })();
  return { stop: () => controller.abort(), done };
}

const CANDIDATE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return CANDIDATE_MIME_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

/** Utterances with less sustained voice than this are treated as noise (a
 * cough, a chair creak, speaker bleed past echo cancellation) and dropped
 * before ever reaching STT. */
export const MIN_VOICED_MS = 250;

/** Speech onset (VAD "start of voice") requires RMS to stay above threshold
 * continuously for this long, so a single loud transient doesn't trigger it.
 * A dip below threshold before the sustain window completes resets the
 * onset timer. */
const START_VOICE_MS = 120;

/** During barge-in the mic is open while TTS plays through the speakers, so
 * echo-cancelled bleed-through can still cause brief false positives even
 * with echo cancellation enabled. Require a longer sustain window before
 * treating it as the user actually interrupting. */
const BARGE_IN_START_VOICE_MS = 250;

export interface UtteranceOptions {
  /** RMS amplitude (0..1) above which input counts as speech. */
  rmsThreshold: number;
  /** End-of-utterance: silence must last this long (seconds) after speech started. */
  silenceDurationSec: number;
  /** Fired once, when sustained voice is first detected (speech onset). */
  onSpeechStart?: () => void;
  /** Barge-in mode: don't start the MediaRecorder until speech onset, so the
   * blob doesn't contain the whole TTS playback period the user talked over. */
  deferRecordUntilSpeech?: boolean;
}

export interface UtteranceResult {
  blob: Blob;
  /** Total milliseconds during which RMS was above threshold (after onset). */
  voicedMs: number;
}

export interface UtteranceHandle {
  /** Resolves once silence ends the utterance or stop() is called; rejects with AbortError on cancel(). */
  result: Promise<UtteranceResult>;
  /** Ends the utterance immediately and resolves `result` with whatever was captured so far. */
  stop: () => void;
  /** Aborts the utterance without producing a result, rejecting `result`. Does not touch the mic/AudioContext. */
  cancel: () => void;
}

export interface MicSession {
  /** Starts capturing one utterance. Only one may be active at a time (throws if violated). */
  recordUtterance(opts: UtteranceOptions): UtteranceHandle;
  /** Cancels any active utterance and releases the mic/AudioContext. Idempotent. */
  close(): void;
}

/**
 * Opens the microphone once and returns a session that can record any
 * number of utterances against it (sequentially), reusing the same
 * MediaStream/AudioContext/AnalyserNode across all of them. This is what
 * lets a call keep listening (for barge-in) while TTS is still speaking,
 * without the click/pop and permission churn of repeatedly opening the mic.
 * Echo cancellation matters here specifically because the mic stays open
 * while audio plays out of the speakers during barge-in listening.
 */
export async function createMicSession(): Promise<MicSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const timeDomainData = new Uint8Array(analyser.frequencyBinCount);

  let closed = false;
  // The in-flight utterance's cancel(), doubling as both the "one at a time"
  // guard and close()'s cleanup hook. Cleared by stop()/cancel() themselves.
  let currentCancel: (() => void) | null = null;

  function readRms(): number {
    analyser.getByteTimeDomainData(timeDomainData);
    let sumSquares = 0;
    for (let i = 0; i < timeDomainData.length; i++) {
      const normalized = (timeDomainData[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }
    return Math.sqrt(sumSquares / timeDomainData.length);
  }

  function recordUtterance(opts: UtteranceOptions): UtteranceHandle {
    if (closed) throw new Error("mic session is closed");
    if (currentCancel) throw new Error("an utterance is already in progress on this mic session");

    const recorder = new MediaRecorder(stream, { mimeType: pickRecorderMimeType() });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    let settled = false;
    let rafId = 0;
    let recorderStarted = false;
    let resolveResult: (result: UtteranceResult) => void = () => {};
    let rejectResult: (err: unknown) => void = () => {};
    const result = new Promise<UtteranceResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    let voicedMs = 0;
    let onsetDone = false;
    let onsetStartedAt: number | null = null;
    let silenceStartedAt: number | null = null;
    let lastFrameAt: number | null = null;
    const startVoiceMs = opts.deferRecordUntilSpeech ? BARGE_IN_START_VOICE_MS : START_VOICE_MS;

    const finish = (blob: Blob) => resolveResult({ blob, voicedMs });

    const stopLoop = () => {
      cancelAnimationFrame(rafId);
      currentCancel = null;
    };

    const stop = () => {
      if (settled) return;
      settled = true;
      stopLoop();
      if (recorderStarted && recorder.state !== "inactive") {
        recorder.onstop = () => finish(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
        recorder.stop();
      } else {
        // Recorder never started (deferred recording, onset never reached) —
        // resolve with an empty blob of the right type rather than hanging.
        finish(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      }
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      stopLoop();
      if (recorderStarted && recorder.state !== "inactive") recorder.stop();
      rejectResult(new DOMException("recording cancelled", "AbortError"));
    };

    const tick = () => {
      const now = performance.now();
      const elapsed = lastFrameAt === null ? 0 : now - lastFrameAt;
      lastFrameAt = now;

      const isSpeech = readRms() > opts.rmsThreshold;

      if (!onsetDone) {
        if (isSpeech) {
          if (onsetStartedAt === null) onsetStartedAt = now;
          if (now - onsetStartedAt >= startVoiceMs) {
            onsetDone = true;
            opts.onSpeechStart?.();
            if (opts.deferRecordUntilSpeech && !recorderStarted) {
              recorderStarted = true;
              recorder.start();
            }
          }
        } else {
          onsetStartedAt = null; // dip before sustain completes resets the onset timer
        }
      } else if (isSpeech) {
        voicedMs += elapsed;
        silenceStartedAt = null;
      } else {
        if (silenceStartedAt === null) {
          silenceStartedAt = now;
        } else if (now - silenceStartedAt >= opts.silenceDurationSec * 1000) {
          stop();
          return;
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    if (!opts.deferRecordUntilSpeech) {
      recorderStarted = true;
      recorder.start();
    }
    rafId = requestAnimationFrame(tick);
    currentCancel = cancel;

    return { result, stop, cancel };
  }

  function close() {
    if (closed) return;
    closed = true;
    currentCancel?.();
    source.disconnect();
    analyser.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    void audioCtx.close().catch(() => {});
  }

  return { recordUtterance, close };
}

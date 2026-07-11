// Voice call media I/O: OpenAI-compatible TTS ("{baseUrl}/audio/speech") and
// STT ("{baseUrl}/audio/transcriptions") against a resolved voice target (the
// shape lib/llmConfig.ts's resolveVoice() returns — baseUrl/apiKey/model
// resolved from the shared LLM config's `tts`/`stt` VoiceConfigV1, which have
// no connection info of their own), plus microphone capture with
// silence-based end-of-utterance detection. Conversation looping and UI
// state live in views/VoiceView.tsx — this module only owns talking to the
// endpoints, mic capture, and playback.
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

/** RMS amplitude (0..1) above which the input is considered speech rather than background noise. */
const SILENCE_RMS_THRESHOLD = 0.02;

export interface RecordingHandle {
  /** Resolves with the captured audio once silence ends the utterance, or `stop()` is called. */
  result: Promise<Blob>;
  /** Ends the utterance immediately and resolves `result` with whatever was captured so far. */
  stop: () => void;
  /** Aborts the recording without producing a result, rejecting `result`, and releases the mic. */
  cancel: () => void;
}

/**
 * Opens the microphone and starts recording. The returned handle's `result`
 * resolves on its own once the user stops speaking for `silenceDurationSec`
 * seconds (measured via a WebAudio AnalyserNode), or immediately if `stop()`
 * is called first. Always tears down the media stream / audio context, on
 * every exit path, so nothing leaks.
 */
export async function startRecording(silenceDurationSec: number): Promise<RecordingHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const timeDomainData = new Uint8Array(analyser.frequencyBinCount);

  const recorder = new MediaRecorder(stream, { mimeType: pickRecorderMimeType() });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  let settled = false;
  let rafId = 0;
  let resolveResult: (blob: Blob) => void = () => {};
  let rejectResult: (err: unknown) => void = () => {};
  const result = new Promise<Blob>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const releaseMedia = () => {
    cancelAnimationFrame(rafId);
    source.disconnect();
    analyser.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    void audioCtx.close().catch(() => {});
  };

  const stop = () => {
    if (settled) return;
    settled = true;
    releaseMedia();
    if (recorder.state === "inactive") {
      resolveResult(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    } else {
      recorder.onstop = () => resolveResult(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      recorder.stop();
    }
  };

  const cancel = () => {
    if (settled) return;
    settled = true;
    releaseMedia();
    if (recorder.state !== "inactive") recorder.stop();
    rejectResult(new DOMException("recording cancelled", "AbortError"));
  };

  let speechDetected = false;
  let silenceStartedAt: number | null = null;
  const watchForSilence = () => {
    analyser.getByteTimeDomainData(timeDomainData);
    let sumSquares = 0;
    for (let i = 0; i < timeDomainData.length; i++) {
      const normalized = (timeDomainData[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / timeDomainData.length);

    if (rms > SILENCE_RMS_THRESHOLD) {
      speechDetected = true;
      silenceStartedAt = null;
    } else if (speechDetected) {
      const now = performance.now();
      if (silenceStartedAt === null) {
        silenceStartedAt = now;
      } else if (now - silenceStartedAt >= silenceDurationSec * 1000) {
        stop();
        return;
      }
    }
    rafId = requestAnimationFrame(watchForSilence);
  };

  recorder.start();
  rafId = requestAnimationFrame(watchForSilence);

  return { result, stop, cancel };
}

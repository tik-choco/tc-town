// Per-character emotion state shared between the LLM-side classifier
// (lib/emotionClassifier.ts) and the VRM renderer (vrm/animation.ts /
// vrm/stage.ts). The classifier writes an emotion with a hold duration; the
// render loop polls getCharacterEmotion() every frame and eases the VRM
// expression weights toward it. Expiry (or "neutral") means "no expression" —
// the animator fades everything back to 0. Keys are Character.id for roster
// characters and the plaza actor key for ephemeral catalog actors.

export type EmotionName =
  | "neutral"
  | "happy"
  | "angry"
  | "sad"
  | "relaxed"
  | "surprised";

export const EMOTION_NAMES: readonly EmotionName[] = [
  "neutral",
  "happy",
  "angry",
  "sad",
  "relaxed",
  "surprised",
];

export function isEmotionName(value: unknown): value is EmotionName {
  return typeof value === "string" && (EMOTION_NAMES as readonly string[]).includes(value);
}

/** How long an emotion stays on the face before decaying back to neutral. */
export const DEFAULT_EMOTION_HOLD_MS = 8000;

interface EmotionEntry {
  emotion: EmotionName;
  expiresAt: number;
}

const entries = new Map<string, EmotionEntry>();

/** Sets the character's current emotion. "neutral" clears immediately. */
export function setCharacterEmotion(
  characterId: string,
  emotion: EmotionName,
  holdMs: number = DEFAULT_EMOTION_HOLD_MS,
): void {
  if (!characterId) return;
  if (emotion === "neutral") {
    entries.delete(characterId);
    return;
  }
  entries.set(characterId, { emotion, expiresAt: Date.now() + holdMs });
}

/**
 * Current emotion for the character, or null when none/expired. Cheap enough
 * to poll from the render loop every frame.
 */
export function getCharacterEmotion(characterId: string): EmotionName | null {
  const entry = entries.get(characterId);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    entries.delete(characterId);
    return null;
  }
  return entry.emotion;
}

/** Clears every held emotion (e.g. when leaving a conversation). */
export function clearAllEmotions(): void {
  entries.clear();
}

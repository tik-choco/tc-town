// Shared domain types for tc-town. This file is the cross-cutting contract
// between the LLM/network layer, the character model, avatar rendering, and
// conversation orchestration — kept deliberately small and additive so the
// pieces can be built independently against it.

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// LLM connection/model config (baseUrl/apiKey/model) no longer lives in
// tc-town's own types — it's shared across the tik-choco app family via the
// `tc-shared-llm-config-v1` localStorage key (see lib/llmConfig.ts, vendored
// from protocol/docs/data-contracts). `LlmProfile`/`VoiceProfile` used to hold
// that connection info locally; they're gone. What remains local to tc-town
// is only a *reference* to a shared preset id (see `DEFAULT_LLM_PROFILE_ID`
// and `Character.llmProfileId` below).

/**
 * Reserved id meaning "use the app-wide default preset". Historically the id
 * of tc-town's own built-in default `LlmProfile`; now just a sentinel that,
 * when it doesn't match any preset in the shared config (the common case —
 * migration deliberately never seeds a preset under this id, see
 * lib/llmSettings.ts's pristine-default skip rule), falls through to
 * `SharedLlmConfigV1.defaultPresetId` via `resolvePreset`'s own fallback.
 */
export const DEFAULT_LLM_PROFILE_ID = "default";

export type AvatarKind = "image" | "vrm";

export interface ImageAvatar {
  kind: "image";
  /** Key into lib/idbBlobStore.ts holding the image bytes. */
  blobKey: string;
  mime: string;
}

export interface VrmAvatar {
  kind: "vrm";
  /** Key into src/vrm/library.ts's model library holding the .vrm bytes. */
  blobKey: string;
  /** sha256 checksum — same identity scheme as tc-vrm-viewer's model library,
   * so a model imported there can be recognized here (same-origin, shared
   * IndexedDB) and vice versa. */
  checksum: string;
  fileName: string;
}

export type Avatar = ImageAvatar | VrmAvatar;

/**
 * A character's personality sheet. Plain structured text fields rather than
 * freeform markdown (unlike tc-chara) so the LLM-interview growth flow can
 * target and patch individual fields. `toPersonaPrompt()` (lib/characterStorage.ts)
 * compiles this into the system-prompt block used by conversation orchestration.
 */
export interface CharacterSheet {
  name: string;
  /** One-line description shown in lists/pickers. */
  summary: string;
  /** Identity, backstory, values — freeform paragraphs. */
  persona: string;
  /** Tone, first-person pronoun, verbal tics, speaking register. */
  speechStyle: string;
  /** Likes/dislikes/interests. */
  likes: string;
  /** Relationships to other characters or people, freeform. */
  relationships: string;
  /** Rolling free-text notes the interview/growth flow appends over time. */
  notes: string;
}

export function emptyCharacterSheet(name: string): CharacterSheet {
  return { name, summary: "", persona: "", speechStyle: "", likes: "", relationships: "", notes: "" };
}

export interface Character {
  id: string;
  createdAt: string;
  updatedAt: string;
  avatar: Avatar | null;
  sheet: CharacterSheet;
  /**
   * `DEFAULT_LLM_PROFILE_ID` or a `ModelPresetV1.id` from the shared LLM
   * config (lib/llmConfig.ts). Field name kept as-is (not renamed to
   * "PresetId") so existing character data keeps resolving unchanged —
   * legacy `LlmProfile.id` values became preset ids 1:1 during migration.
   */
  llmProfileId: string;
  voiceModel?: string;
  voiceName?: string;
  /** Selected world setting (lib/worlds.ts WorldSetting.id), or undefined for none. */
  worldId?: string;
}

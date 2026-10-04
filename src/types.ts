import type { ModelRefV1 } from '@tik-choco/mistai/llm-config';
import type { ReasoningEffort } from '@tik-choco/mistai/preact';
// Shared domain types for tc-town. This file is the cross-cutting contract
// between the LLM/network layer, the character model, avatar rendering, and
// conversation orchestration — kept deliberately small and additive so the
// pieces can be built independently against it.

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// Legacy character imports may still contain this ID. New calls use llmRef.
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
  /** Read-only legacy ID for older character exports. */
  llmProfileId: string;
  llmRef?: ModelRefV1;
  reasoningEffort?: ReasoningEffort;
  llmMigrationV2?: boolean;
  voiceModel?: string;
  voiceName?: string;
  /** Selected world setting (lib/worlds.ts WorldSetting.id), or undefined for none. */
  worldId?: string;
}

// This is the canonical reference copy
// (protocol/docs/data-contracts/reference/mistSignaling.ts). Don't hand-edit the
// vendored per-app copies directly — regenerate them with
// protocol/scripts/sync-vendored.mjs instead, so drift doesn't creep back in.
//
// The Nostr signaling namespace every tik-choco app shares. `inviteSalt` and
// `inviteCode` together derive the secret that scopes peer discovery, so two
// peers only ever see each other when both values match. Every app in this
// family must therefore pass the SAME pair, or cross-app rooms — tc-chat rooms,
// tc-news's global-articles room, tc-storage folder shares, the mistl DID
// pairing room — silently split into per-app islands where each side just sees
// an empty room.
//
// These are NOT secrets. They ship in the JS bundle of public static sites, so
// anyone can read them and join the namespace; they separate this family's
// discovery traffic from everyone else's, nothing more. Don't treat membership
// here as authorization — the wire-level DID signatures do that.
//
// Why an explicit pair at all: mistlib ships a built-in default
// ("nostr-sig-test-local-salt" / "dev-invite-001") that its signaling spec
// reserves for local-relay development. Every deployment that left it alone met
// every other such deployment on the public relays. The web wrapper now refuses
// to build a config without an explicit pair; the engine still defaults, so
// native callers (mistl) must set it deliberately.

/** Discovery namespace salt. Changing it moves every room to a new namespace. */
export const MIST_INVITE_SALT = "tik-choco-v1";

/** Discovery namespace code. Public, not a credential — see this file's header. */
export const MIST_INVITE_CODE = "tik-choco-public-v1";

export type MistSignalingConfig = {
  signaling: {
    mode: "nostr";
    nostr: {
      relays: string[];
      discoveryKind: number;
      messageKind: number;
      ttlSeconds: number;
      inviteSalt: string;
      inviteCode: string;
    };
  };
};

/**
 * The config to hand `new MistNode(id, config)`.
 *
 * `relays` is left empty on purpose: mistlib then fetches its default relay
 * list (https://data.tik-choco.com/server/relays.json) rather than pinning a
 * relay set into each app's bundle. discoveryKind/messageKind/ttlSeconds mirror
 * the wrapper's own defaults and are spelled out so an upstream default change
 * can't silently move this family's traffic.
 */
export function mistSignalingConfig(): MistSignalingConfig {
  return {
    signaling: {
      mode: "nostr",
      nostr: {
        relays: [],
        discoveryKind: 25049,
        messageKind: 25050,
        ttlSeconds: 600,
        inviteSalt: MIST_INVITE_SALT,
        inviteCode: MIST_INVITE_CODE,
      },
    },
  };
}

export const DEFAULT_SIGNALING_URL = "";
export const DEFAULT_NOSTR_RELAY_URL = "ws://127.0.0.1:7777";

// Nostr signaling with no invite. `inviteSalt` and `inviteCode` are deliberately
// absent: together they derive the secret that scopes discovery, so every
// deployment sharing them shares one namespace and one admission secret.
// Shipping a default here meant every app built from this wrapper inherited the
// same pair -- and, since `relays: []` resolves to a public relay list, met every
// other such app on it. Callers supply their own; `normalizeOptions` refuses to
// build a config without them.
export function defaultConfig() {
    return {
        signaling: {
            mode: "nostr",
            nostr: {
                relays: [],
                discoveryKind: 25049,
                messageKind: 25050,
                ttlSeconds: 600,
                maxClockSkewSeconds: 300,
            },
        },
    };
}

function assertInviteConfigured(config) {
    if (config?.signaling?.mode !== "nostr") return;
    const nostr = config.signaling.nostr ?? {};
    const missing = ["inviteSalt", "inviteCode"].filter(
        (k) => typeof nostr[k] !== "string" || nostr[k].length === 0,
    );
    if (missing.length === 0) return;
    throw new Error(
        `mistlib: signaling.nostr.${missing.join(" and ")} must be set. ` +
        "Together they derive the secret that decides who can reach your rooms, " +
        "so peers sharing them share a namespace. Pick values unique to your " +
        "application. Example:\n" +
        '  new MistNode(id, { signaling: { mode: "nostr", nostr: { ' +
        'inviteSalt: "my-app", inviteCode: "a-shared-secret" } } })',
    );
}

export function normalizeOptions(options) {
    let config;
    if (!options || typeof options !== 'object') {
        config = defaultConfig();
    } else if (typeof options.config === 'string') {
        config = JSON.parse(options.config);
    } else if (options.config && typeof options.config === 'object') {
        config = { ...options.config };
    } else {
        config = { ...options };
        delete config.config;
    }

    if (config.signaling === undefined) {
        config.signaling = defaultConfig().signaling;
    } else if (config.signaling.mode === "nostr") {
        // Merge over the defaults so a caller passing only an invite still gets
        // the kinds and TTLs instead of falling back to the engine's own.
        config.signaling = {
            ...config.signaling,
            nostr: {
                ...defaultConfig().signaling.nostr,
                ...(config.signaling.nostr ?? {}),
            },
        };
    }

    if (options?.signalingUrl !== undefined) {
        config.signalingUrl = options.signalingUrl;
    } else if (config.signalingUrl === undefined) {
        if (config.signaling?.mode === "websocket") {
            config.signalingUrl = DEFAULT_SIGNALING_URL;
        }
    }

    assertInviteConfigured(config);
    return config;
}

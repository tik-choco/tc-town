export const DEFAULT_SIGNALING_URL = "wss://rtc.tik-choco.com/signaling";
export const DEFAULT_NOSTR_RELAY_URL = "ws://127.0.0.1:7777";

export function defaultConfig() {
    return {
        signaling: {
            mode: "nostr",
            nostr: {
                relays: [],
                discoveryKind: 25049,
                messageKind: 25050,
                ttlSeconds: 600,
                inviteSalt: "nostr-sig-test-local-salt",
                inviteCode: "dev-invite-001",
            },
        },
    };
}

export function normalizeOptions(options) {
    if (!options || typeof options !== 'object') {
        return defaultConfig();
    }

    let config;
    if (typeof options.config === 'string') {
        config = JSON.parse(options.config);
    } else if (options.config && typeof options.config === 'object') {
        config = { ...options.config };
    } else {
        config = { ...options };
        delete config.config;
    }

    if (config.signaling === undefined) {
        config.signaling = defaultConfig().signaling;
    }
    if (options.signalingUrl !== undefined) {
        config.signalingUrl = options.signalingUrl;
    } else if (config.signalingUrl === undefined) {
        if (config.signaling?.mode === "websocket") {
            config.signalingUrl = DEFAULT_SIGNALING_URL;
        }
    }

    return config;
}

// Self-reported per-app manifest for the tik-choco app family, vendored
// identically (modulo TS/JS syntax) into every family app. See
// protocol/docs/data-contracts/docs/app-manifest.md for the full spec.
// Contract version: v1
//
// Design: this module does NOT depend on mistlib or sharedBus.ts. It only
// reads/writes a small JSON record at a per-app localStorage key so other
// apps can cheaply check "has this app ever run on this origin, and what
// topics does it know about" without needing the app itself to be open.
// This is a self-reported cache for UX guidance, not a trust/security
// boundary — see app-manifest.md for the caveats.
//
// This is the canonical reference copy
// (protocol/docs/data-contracts/reference/appManifest.ts). Don't hand-edit
// the vendored per-app copies directly — regenerate them with
// protocol/scripts/sync-vendored.mjs instead. Unlike sharedBus.ts, this file
// has no per-app placeholder to substitute: the app name is a runtime
// argument, so the vendored copy is byte-identical everywhere.

export type AppManifestV1 = {
  v: 1;
  /** "tc-note" など */
  app: string;
  version?: string;
  /** vendored sharedBus の BUS_VERSION(診断用) */
  busVersion?: number;
  /** 書き込む sharedBus トピック */
  publishes: string[];
  /** 購読/取り込みするトピック */
  consumes: string[];
  /** 契約に基づき直読みする他アプリの localStorage キー(完全一致文字列) */
  reads: string[];
  /** ISO 8601(最終起動時刻を兼ねる) */
  updatedAt: string;
};

function manifestKey(app: string): string {
  return `tc-app-manifest:${app}`;
}

function isAppManifestV1(value: unknown): value is AppManifestV1 {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.app === "string" &&
    (record.version === undefined || typeof record.version === "string") &&
    (record.busVersion === undefined || typeof record.busVersion === "number") &&
    Array.isArray(record.publishes) &&
    record.publishes.every((item) => typeof item === "string") &&
    Array.isArray(record.consumes) &&
    record.consumes.every((item) => typeof item === "string") &&
    Array.isArray(record.reads) &&
    record.reads.every((item) => typeof item === "string") &&
    typeof record.updatedAt === "string"
  );
}

/**
 * Writes this app's manifest to `tc-app-manifest:<app>`, stamping `v: 1` and
 * `updatedAt` with the current time. Never throws: storage failures (quota,
 * disabled storage, etc.) are swallowed after a console.warn.
 */
export function writeAppManifest(input: Omit<AppManifestV1, "v" | "updatedAt">): void {
  const manifest: AppManifestV1 = {
    ...input,
    v: 1,
    updatedAt: new Date().toISOString(),
  };

  try {
    localStorage.setItem(manifestKey(input.app), JSON.stringify(manifest));
  } catch (error) {
    console.warn(`tc-app-manifest: failed to persist manifest for "${input.app}"`, error);
  }
}

/**
 * Reads and validates the manifest for `app`. Returns null if the key is
 * missing, the JSON is malformed, or the shape doesn't match `AppManifestV1`
 * (never throws).
 */
export function readAppManifest(app: string): AppManifestV1 | null {
  try {
    const raw = localStorage.getItem(manifestKey(app));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isAppManifestV1(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Scans localStorage for all `tc-app-manifest:*` keys and returns the valid
 * manifests found (skipping any that fail to parse/validate). Never throws.
 */
export function listAppManifests(): AppManifestV1[] {
  const manifests: AppManifestV1[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith("tc-app-manifest:")) continue;
      const app = key.slice("tc-app-manifest:".length);
      const manifest = readAppManifest(app);
      if (manifest) manifests.push(manifest);
    }
  } catch {
    return manifests;
  }
  return manifests;
}

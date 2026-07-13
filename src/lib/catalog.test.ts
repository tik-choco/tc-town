// Unit tests for the character catalog's pure logic: defensive coercion of
// anything read from storage/network, and the share-link CID parser. No mist
// node, DOM storage, or crypto is touched by any of these — see
// lib/catalog.ts's module doc for why that's required for the coercion
// helpers to live safely in lib/catalogStore.ts / lib/catalogTypes.ts.
import { describe, expect, it } from "vitest";
import { coerceCatalogPayload, type CatalogEntry } from "./catalogTypes";
import {
  coerceCatalogEntry,
  coerceCatalogProfile,
  coercePublishState,
  evictOldestDirectoryEntries,
} from "./catalogStore";
import { parseCatalogShareInput } from "./catalog";

describe("coercePublishState", () => {
  it("accepts a well-formed record", () => {
    const state = coercePublishState({
      characterId: "char-1",
      visibility: "public",
      cid: "bafy123",
      publishedAt: 100,
      updatedAt: 200,
    });
    expect(state).toEqual({
      characterId: "char-1",
      visibility: "public",
      cid: "bafy123",
      vrmCid: undefined,
      publishedAt: 100,
      updatedAt: 200,
    });
  });

  it("rejects a missing/invalid characterId", () => {
    expect(coercePublishState({ characterId: "", visibility: "public", cid: "x" })).toBeNull();
    expect(coercePublishState({ visibility: "public", cid: "x" })).toBeNull();
  });

  it("rejects an invalid visibility", () => {
    expect(coercePublishState({ characterId: "c1", visibility: "secret", cid: "x" })).toBeNull();
  });

  it("rejects a missing cid", () => {
    expect(coercePublishState({ characterId: "c1", visibility: "unlisted", cid: "" })).toBeNull();
  });

  it("drops non-object input", () => {
    expect(coercePublishState(null)).toBeNull();
    expect(coercePublishState("nope")).toBeNull();
    expect(coercePublishState(42)).toBeNull();
  });
});

describe("coerceCatalogEntry", () => {
  it("accepts a well-formed record and fills in defaults for missing optional fields", () => {
    const entry = coerceCatalogEntry({
      entryId: "char-1",
      cid: "bafy123",
      fromId: "did:key:z6Mk...",
    });
    expect(entry).not.toBeNull();
    expect(entry?.name).toBe("");
    expect(entry?.summary).toBe("");
    expect(entry?.hasVrm).toBe(false);
    expect(entry?.fromName).toBe("");
  });

  it("rejects a missing entryId, cid, or fromId", () => {
    expect(coerceCatalogEntry({ cid: "x", fromId: "did:key:z1" })).toBeNull();
    expect(coerceCatalogEntry({ entryId: "e1", fromId: "did:key:z1" })).toBeNull();
    expect(coerceCatalogEntry({ entryId: "e1", cid: "x" })).toBeNull();
  });
});

describe("evictOldestDirectoryEntries", () => {
  function entry(entryId: string, receivedAt: number): CatalogEntry {
    return {
      entryId,
      name: "",
      summary: "",
      hasVrm: false,
      cid: "bafy",
      fromId: "did:key:z1",
      fromName: "",
      publishedAt: receivedAt,
      updatedAt: receivedAt,
      receivedAt,
    };
  }

  it("leaves the directory untouched when under the cap", () => {
    const directory: Record<string, CatalogEntry> = { a: entry("a", 1), b: entry("b", 2) };
    evictOldestDirectoryEntries(directory);
    expect(Object.keys(directory)).toEqual(["a", "b"]);
  });

  it("drops the least-recently-received entries once over the cap", () => {
    // 501 entries, receivedAt 0..500 — only the single oldest (id "0") should be evicted.
    const directory: Record<string, CatalogEntry> = {};
    for (let i = 0; i <= 500; i++) directory[String(i)] = entry(String(i), i);
    evictOldestDirectoryEntries(directory);
    expect(Object.keys(directory).length).toBe(500);
    expect(directory["0"]).toBeUndefined();
    expect(directory["1"]).toBeDefined();
    expect(directory["500"]).toBeDefined();
  });
});

describe("coerceCatalogProfile", () => {
  it("defaults to an empty display name for malformed input", () => {
    expect(coerceCatalogProfile(null)).toEqual({ displayName: "" });
    expect(coerceCatalogProfile({})).toEqual({ displayName: "" });
    expect(coerceCatalogProfile({ displayName: 42 })).toEqual({ displayName: "" });
  });

  it("passes through a valid display name", () => {
    expect(coerceCatalogProfile({ displayName: "みかん" })).toEqual({ displayName: "みかん" });
  });
});

describe("coerceCatalogPayload", () => {
  const validCharacter = { id: "char-1", sheet: { name: "テスト" } };

  it("accepts a well-formed v1 payload", () => {
    const payload = coerceCatalogPayload({
      app: "tc-town",
      kind: "catalog-character",
      version: 1,
      character: validCharacter,
      world: null,
    });
    expect(payload).not.toBeNull();
    expect(payload?.character.id).toBe("char-1");
    expect(payload?.vrmCid).toBeUndefined();
  });

  it("keeps a valid vrmCid", () => {
    const payload = coerceCatalogPayload({
      app: "tc-town",
      kind: "catalog-character",
      version: 1,
      character: validCharacter,
      world: null,
      vrmCid: "bafyvrm",
    });
    expect(payload?.vrmCid).toBe("bafyvrm");
  });

  it("rejects the wrong app/kind/version", () => {
    expect(
      coerceCatalogPayload({ app: "other-app", kind: "catalog-character", version: 1, character: validCharacter }),
    ).toBeNull();
    expect(
      coerceCatalogPayload({ app: "tc-town", kind: "something-else", version: 1, character: validCharacter }),
    ).toBeNull();
    expect(
      coerceCatalogPayload({ app: "tc-town", kind: "catalog-character", version: 2, character: validCharacter }),
    ).toBeNull();
  });

  it("rejects a malformed character", () => {
    expect(
      coerceCatalogPayload({ app: "tc-town", kind: "catalog-character", version: 1, character: { sheet: {} } }),
    ).toBeNull();
    expect(
      coerceCatalogPayload({ app: "tc-town", kind: "catalog-character", version: 1, character: null }),
    ).toBeNull();
  });

  it("drops non-object input", () => {
    expect(coerceCatalogPayload(null)).toBeNull();
    expect(coerceCatalogPayload("nope")).toBeNull();
  });
});

describe("parseCatalogShareInput", () => {
  it("extracts the cid from a full share URL", () => {
    expect(parseCatalogShareInput("https://example.com/town/#catalog=bafy123abc")).toBe("bafy123abc");
  });

  it("extracts the cid from a share URL with a trailing fragment/query-like suffix", () => {
    expect(parseCatalogShareInput("https://example.com/#catalog=bafy123&foo=bar")).toBe("bafy123");
  });

  it("url-decodes the extracted cid", () => {
    expect(parseCatalogShareInput("https://example.com/#catalog=bafy%2F123")).toBe("bafy/123");
  });

  it("accepts a bare cid", () => {
    expect(parseCatalogShareInput("bafy123abc")).toBe("bafy123abc");
  });

  it("trims surrounding whitespace on a bare cid", () => {
    expect(parseCatalogShareInput("  bafy123abc  ")).toBe("bafy123abc");
  });

  it("rejects empty input", () => {
    expect(parseCatalogShareInput("")).toBeNull();
    expect(parseCatalogShareInput("   ")).toBeNull();
  });

  it("rejects a URL without the #catalog= marker", () => {
    expect(parseCatalogShareInput("https://example.com/town/")).toBeNull();
  });

  it("rejects input containing whitespace that isn't a share URL", () => {
    expect(parseCatalogShareInput("not a cid at all")).toBeNull();
  });
});

import { useEffect, useRef, useState } from "preact/hooks";
import {
  Trees,
  User,
  Clock,
  Download,
  RefreshCw,
  ChevronDown,
  Check,
  UserPlus,
  MessageCircle,
} from "lucide-preact";
import {
  connectCatalog,
  disconnectCatalog,
  listCatalogEntries,
  subscribeCatalogDirectory,
  fetchAndImportCatalogCid,
  getCatalogProfile,
  setCatalogProfile,
  subscribeCatalogProfile,
  parseCatalogShareInput,
  shortenPeerId,
  type CatalogEntry,
} from "../lib/catalog";
import { listCharacters, subscribeCharacters } from "../lib/characterStorage";
import { ensureDidIdentity } from "../crypto/didIdentity";
import { requestNavigate } from "../lib/navigation";
import { setPendingChatCharacterId } from "./ChatView";
import { PlazaStage } from "./PlazaStage";
import "../styles/catalog.css";

// --- deep-link handoff ---------------------------------------------------------
// app.tsx resolves a `#catalog=<cid>` deep link into a pending cid *before*
// this view ever mounts (see resolveInitialView in app.tsx), then this view
// consumes it once on mount to pre-fill + auto-run the share-link import.
// Plain module-level state rather than a prop so app.tsx's changes stay
// minimal (no need to thread the cid through the NAV/view-switch plumbing).
let pendingShareCid: string | null = null;

export function setPendingCatalogShareCid(cid: string | null): void {
  pendingShareCid = cid;
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

function formatDate(ms: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString("ja-JP");
  } catch {
    return "";
  }
}

type ConnectStatus = "connecting" | "connected" | "error";

interface EntryMessage {
  entryId: string;
  text: string;
  error?: boolean;
  /** Set on a successful import so the "会話する" CTA next to the message knows which character to preselect. */
  characterId?: string;
}

/** Preselects the given character then hands off to ChatView (see ChatView's setPendingChatCharacterId doc comment). */
function goToChat(characterId: string) {
  setPendingChatCharacterId(characterId);
  requestNavigate("chat");
}

/** ひろば (public character catalog): browse + import what others have published, import via a share link, and set the display name shown on my own published characters. */
export function CatalogView() {
  const [entries, setEntries] = useState<CatalogEntry[]>(() => listCatalogEntries());
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>("connecting");
  const [connectError, setConnectError] = useState<string | null>(null);
  // Set by beginConnect() each time it (re)starts an attempt; the effect
  // cleanup calls whichever one is current so a reconnect click that's still
  // in flight when the view unmounts doesn't clobber state after unmount.
  const connectCancelRef = useRef<() => void>(() => {});

  const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
  const [entryMessage, setEntryMessage] = useState<EntryMessage | null>(null);

  const [shareInput, setShareInput] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [shareMessage, setShareMessage] = useState<{
    text: string;
    error?: boolean;
    characterId?: string;
  } | null>(null);
  // Share panel is collapsed by default (improvement 2); forced open below
  // whenever a deep-link cid is being consumed or there's an import in
  // flight/result to show, so the user never lands on a hidden result.
  const [shareOpen, setShareOpen] = useState(false);

  const [displayName, setDisplayName] = useState(() => getCatalogProfile().displayName);
  const profileDirtyRef = useRef(false);
  const profileTimer = useRef<number | undefined>(undefined);

  // My own DID, used to tell "my own published characters" apart from
  // everyone else's in the directory grid (improvement 4). Mirrors
  // lib/plaza.ts's preparePlazaActors: best-effort, never fatal — a failure
  // just means we can't tell them apart, not that anything breaks.
  const [ownDid, setOwnDid] = useState<string | null>(null);

  // Ids of characters already present locally, used to flag directory
  // entries as already-imported (improvement 5). Recomputed whenever
  // characterStorage changes (this tab's import, or another tab's).
  const [importedIds, setImportedIds] = useState<Set<string>>(
    () => new Set(listCharacters().map((c) => c.id)),
  );

  // Join the catalog room for the lifetime of this view; leave on unmount.
  // Pulled out of the effect body so the "再接続" button (improvement 6) can
  // re-run the exact same attempt after a failure.
  function beginConnect() {
    let cancelled = false;
    connectCancelRef.current = () => {
      cancelled = true;
    };
    setConnectStatus("connecting");
    setConnectError(null);
    connectCatalog()
      .then(() => {
        if (!cancelled) setConnectStatus("connected");
      })
      .catch((error) => {
        if (cancelled) return;
        setConnectStatus("error");
        setConnectError(error instanceof Error ? error.message : String(error));
      });
  }

  useEffect(() => {
    beginConnect();
    return () => {
      connectCancelRef.current();
      disconnectCatalog();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleReconnect() {
    if (connectStatus === "connecting") return;
    beginConnect();
  }

  // Keep the directory list in sync (this tab or another, and as wires arrive).
  useEffect(() => {
    const refresh = () => setEntries(listCatalogEntries());
    const unsubscribe = subscribeCatalogDirectory(refresh);
    refresh();
    return unsubscribe;
  }, []);

  // Resolve our own DID once on mount (best-effort — see ownDid's comment above).
  useEffect(() => {
    let cancelled = false;
    ensureDidIdentity()
      .then((identity) => {
        if (!cancelled) setOwnDid(identity.did);
      })
      .catch(() => {
        // Non-fatal — just means we can't tell our own entries apart from others'.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the already-imported set in sync with characterStorage so a
  // successful import (this tab or another) flips a card to "取り込み済み"
  // without needing a manual refresh.
  useEffect(() => {
    const refresh = () => setImportedIds(new Set(listCharacters().map((c) => c.id)));
    const unsubscribe = subscribeCharacters(refresh);
    refresh();
    return unsubscribe;
  }, []);

  // Keep the profile name in sync with other tabs, but never clobber an
  // in-flight (debounced) local edit.
  useEffect(() => {
    const refresh = () => {
      if (profileDirtyRef.current) return;
      setDisplayName(getCatalogProfile().displayName);
    };
    return subscribeCatalogProfile(refresh);
  }, []);

  useEffect(
    () => () => {
      if (profileTimer.current) window.clearTimeout(profileTimer.current);
    },
    [],
  );

  // Consume a pending share-link cid (set by app.tsx from a #catalog=<cid>
  // deep link) exactly once: pre-fill the input and auto-run the import. The
  // share panel is collapsed by default (improvement 2), so force it open
  // here too — otherwise a deep-link visitor would land on a page whose
  // relevant panel is hidden.
  useEffect(() => {
    if (!pendingShareCid) return;
    const cid = pendingShareCid;
    pendingShareCid = null;
    setShareInput(cid);
    setShareOpen(true);
    void runShareImport(cid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function scheduleProfileSave(next: string) {
    profileDirtyRef.current = true;
    if (profileTimer.current) window.clearTimeout(profileTimer.current);
    profileTimer.current = window.setTimeout(() => {
      profileDirtyRef.current = false;
      setCatalogProfile({ displayName: next });
    }, 500);
  }

  function flushProfileSave() {
    if (!profileDirtyRef.current) return;
    if (profileTimer.current) window.clearTimeout(profileTimer.current);
    profileDirtyRef.current = false;
    setCatalogProfile({ displayName });
  }

  async function handleImportEntry(entry: CatalogEntry) {
    if (busyEntryId) return;
    setBusyEntryId(entry.entryId);
    setEntryMessage(null);
    try {
      const result = await fetchAndImportCatalogCid(entry.cid);
      const note = result.missingVrm ? "（VRM本体が見つからず、アバターなしで取り込みました）" : "";
      setEntryMessage({
        entryId: entry.entryId,
        text: `「${result.name}」を取り込みました${note}`,
        characterId: result.characterId,
      });
    } catch (error) {
      setEntryMessage({
        entryId: entry.entryId,
        text: error instanceof Error ? error.message : String(error),
        error: true,
      });
    } finally {
      setBusyEntryId(null);
    }
  }

  async function runShareImport(rawCid: string) {
    setShareBusy(true);
    setShareMessage(null);
    try {
      const result = await fetchAndImportCatalogCid(rawCid);
      const note = result.missingVrm ? "（VRM本体が見つからず、アバターなしで取り込みました）" : "";
      setShareMessage({
        text: `「${result.name}」を取り込みました${note}`,
        characterId: result.characterId,
      });
    } catch (error) {
      setShareMessage({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setShareBusy(false);
    }
  }

  function handleShareSubmit() {
    if (shareBusy) return;
    const cid = parseCatalogShareInput(shareInput);
    if (!cid) {
      setShareMessage({ text: "共有リンクまたはCIDを正しく入力してください。", error: true });
      return;
    }
    void runShareImport(cid);
  }

  // The share panel must never be collapsed while there's an in-flight
  // import or a result to show (see the pending-cid effect's comment above)
  // — so the rendered `open` state ORs the user's own toggle with that.
  const shareDetailsOpen = shareOpen || shareBusy || shareMessage !== null;

  return (
    <div class="cat-root">
      <header class="cat-page-head">
        <div class="cat-page-title">
          <Trees size={22} />
          <h2>ひろば</h2>
        </div>
        <span class={`cat-conn-status cat-conn-status-${connectStatus}`}>
          {connectStatus === "connecting" && (
            <>
              <RefreshCw size={13} class="cat-spin-icon" />
              接続中...
            </>
          )}
          {connectStatus === "connected" && "接続済み"}
          {connectStatus === "error" && "未接続"}
        </span>
      </header>
      {connectStatus === "error" && (
        <div class="cat-conn-error">
          <p class="cat-status cat-status-error">
            ひろばへの接続に失敗しました{connectError ? `: ${connectError}` : ""}
            （オフラインの可能性があります。公開キャラの一覧は更新されません）
          </p>
          <button class="cat-btn cat-btn-tonal cat-reconnect-btn" type="button" onClick={handleReconnect}>
            <RefreshCw size={13} />
            再接続
          </button>
        </div>
      )}

      <PlazaStage />

      <section class="cat-panel cat-directory">
        <div class="cat-panel-head">
          <h3>みんなのキャラ</h3>
        </div>

        {entries.length === 0 ? (
          <div class="cat-empty-state">
            <Trees size={24} />
            <p class="cat-empty">
              {connectStatus === "connecting"
                ? "接続中..."
                : "まだ公開キャラがいません。最初の1体を公開してみませんか？"}
            </p>
            {connectStatus !== "connecting" && (
              <button
                class="cat-btn cat-btn-tonal"
                type="button"
                onClick={() => requestNavigate("characters")}
              >
                <UserPlus size={14} />
                キャラクターを作る
              </button>
            )}
          </div>
        ) : (
          <div class="cat-grid">
            {entries.map((entry) => {
              // "自分" = published by my own DID (never worth importing back);
              // otherwise flag entries whose entryId already matches a local
              // character id (catalog publish uses the characterId as the
              // entryId — see lib/catalog.ts's publishCharacter) as already
              // imported so re-clicking is an obvious re-import, not a dupe.
              const isOwn = ownDid !== null && entry.fromId === ownDid;
              const alreadyImported = !isOwn && importedIds.has(entry.entryId);
              return (
                <article key={entry.entryId} class="cat-card">
                  <div class="cat-card-head">
                    <h4 class="cat-card-name">{entry.name || "無名のキャラクター"}</h4>
                    <div class="cat-card-badges">
                      {isOwn && (
                        <span class="cat-badge" title="自分が公開したキャラクターです">
                          自分
                        </span>
                      )}
                      {entry.hasVrm && (
                        <span class="cat-badge" title="VRMモデルつき">
                          VRM
                        </span>
                      )}
                    </div>
                  </div>
                  <p class="cat-card-summary">{entry.summary || "（説明なし）"}</p>
                  <div class="cat-card-meta">
                    <span class="cat-card-meta-item">
                      <User size={12} />
                      {entry.fromName || shortenPeerId(entry.fromId)}
                    </span>
                    <span class="cat-card-meta-item">
                      <Clock size={12} />
                      {formatDate(entry.updatedAt)}
                    </span>
                    {alreadyImported && (
                      <span class="cat-card-meta-item cat-card-imported">
                        <Check size={12} />
                        取り込み済み
                      </span>
                    )}
                  </div>
                  {!isOwn && (
                    <button
                      class="cat-btn cat-btn-tonal cat-card-import"
                      type="button"
                      onClick={() => void handleImportEntry(entry)}
                      disabled={busyEntryId === entry.entryId}
                    >
                      {busyEntryId === entry.entryId ? <span class="spinner" /> : <Download size={14} />}
                      {alreadyImported ? "再取り込み" : "取り込み"}
                    </button>
                  )}
                  {entryMessage && entryMessage.entryId === entry.entryId && (
                    <div class="cat-status-row cat-card-status">
                      <p class={"cat-status" + (entryMessage.error ? " cat-status-error" : "")}>
                        {entryMessage.text}
                      </p>
                      {!entryMessage.error && entryMessage.characterId && (
                        <button
                          class="cat-btn cat-btn-tonal cat-chat-cta"
                          type="button"
                          onClick={() => goToChat(entryMessage.characterId!)}
                        >
                          <MessageCircle size={13} />
                          会話する
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Settings-ish panels below the main content (improvement 1) and
          collapsed by default (improvement 2) since they're not something
          most visits need to touch. */}

      <details
        class="cat-panel cat-collapsible"
        open={shareDetailsOpen}
        onToggle={(e) => {
          const open = (e.currentTarget as HTMLDetailsElement).open;
          setShareOpen(open);
          // Closing while a result message is showing counts as dismissing it
          // — otherwise shareDetailsOpen would force the panel right back
          // open and it could never be collapsed again after an import.
          if (!open) setShareMessage(null);
        }}
      >
        <summary class="cat-collapsible-summary">
          <span class="cat-label">共有リンクから取り込み</span>
          <ChevronDown size={16} class="cat-collapsible-chevron" />
        </summary>
        <div class="cat-collapsible-body">
          <p class="cat-hint">相手から受け取った共有リンク、またはCIDを貼り付けてください。</p>
          <div class="cat-share-row">
            <input
              class="cat-input"
              type="text"
              placeholder="共有リンクまたはCID"
              value={shareInput}
              onInput={(e) => setShareInput(inputValue(e))}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleShareSubmit();
              }}
            />
            <button
              class="cat-btn cat-btn-accent"
              type="button"
              onClick={handleShareSubmit}
              disabled={shareBusy || !shareInput.trim()}
            >
              {shareBusy ? <span class="spinner" /> : <Download size={16} />}
              取り込み
            </button>
          </div>
          {shareMessage && (
            <div class="cat-status-row">
              <p class={"cat-status" + (shareMessage.error ? " cat-status-error" : "")}>{shareMessage.text}</p>
              {!shareMessage.error && shareMessage.characterId && (
                <button
                  class="cat-btn cat-btn-tonal cat-chat-cta"
                  type="button"
                  onClick={() => goToChat(shareMessage.characterId!)}
                >
                  <MessageCircle size={13} />
                  会話する
                </button>
              )}
            </div>
          )}
        </div>
      </details>

      <details class="cat-panel cat-collapsible">
        <summary class="cat-collapsible-summary">
          <span class="cat-label">公開プロフィール</span>
          <ChevronDown size={16} class="cat-collapsible-chevron" />
        </summary>
        <div class="cat-collapsible-body">
          <p class="cat-hint">あなたが公開したキャラクターに、作者名として表示される名前です。</p>
          <input
            class="cat-input"
            type="text"
            placeholder="表示名（未設定の場合は空欄のまま表示されます）"
            value={displayName}
            onInput={(e) => {
              const value = inputValue(e);
              setDisplayName(value);
              scheduleProfileSave(value);
            }}
            onBlur={flushProfileSave}
          />
        </div>
      </details>
    </div>
  );
}

import { useEffect, useRef, useState } from "preact/hooks";
import { Trees, User, Clock, Download, RefreshCw, Play, Square, Shuffle, X } from "lucide-preact";
import {
  connectCatalog,
  disconnectCatalog,
  listCatalogEntries,
  subscribeCatalogDirectory,
  fetchCatalogPayload,
  importCatalogEntry,
  getCatalogProfile,
  setCatalogProfile,
  subscribeCatalogProfile,
  parseCatalogShareInput,
  type CatalogEntry,
} from "../lib/catalog";
import {
  preparePlazaActors,
  startPlazaTalk,
  hasConfiguredLlmProfile,
  type PlazaActor,
  type PlazaTalkHandle,
} from "../lib/plaza";
import { CharacterAvatar } from "../components/CharacterAvatar";
import { emptyCharacterSheet, DEFAULT_LLM_PROFILE_ID, type Character } from "../types";
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

function shortenId(id: string): string {
  if (!id) return "不明";
  return id.length <= 16 ? id : `${id.slice(0, 10)}…${id.slice(-4)}`;
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
}

/** Fetches + imports a catalog payload by CID. Module-level (no component state) so both the directory grid and the plaza stage's actor popover share the exact same import path and success/failure messaging. */
async function runImport(cid: string): Promise<{ name: string; missingVrm: boolean }> {
  const payload = await fetchCatalogPayload(cid);
  if (!payload) throw new Error("データを取得できませんでした。相手がオフラインか、リンクが正しくない可能性があります。");
  const result = await importCatalogEntry(payload);
  return { name: payload.character.sheet?.name || "（無名のキャラクター）", missingVrm: result.missingVrm };
}

/** ひろば (public character catalog): browse + import what others have published, import via a share link, and set the display name shown on my own published characters. */
export function CatalogView() {
  const [entries, setEntries] = useState<CatalogEntry[]>(() => listCatalogEntries());
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>("connecting");
  const [connectError, setConnectError] = useState<string | null>(null);

  const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
  const [entryMessage, setEntryMessage] = useState<EntryMessage | null>(null);

  const [shareInput, setShareInput] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [shareMessage, setShareMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const [displayName, setDisplayName] = useState(() => getCatalogProfile().displayName);
  const profileDirtyRef = useRef(false);
  const profileTimer = useRef<number | undefined>(undefined);

  // Join the catalog room for the lifetime of this view; leave on unmount.
  useEffect(() => {
    let cancelled = false;
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
    return () => {
      cancelled = true;
      disconnectCatalog();
    };
  }, []);

  // Keep the directory list in sync (this tab or another, and as wires arrive).
  useEffect(() => {
    const refresh = () => setEntries(listCatalogEntries());
    const unsubscribe = subscribeCatalogDirectory(refresh);
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
  // deep link) exactly once: pre-fill the input and auto-run the import.
  useEffect(() => {
    if (!pendingShareCid) return;
    const cid = pendingShareCid;
    pendingShareCid = null;
    setShareInput(cid);
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
      const result = await runImport(entry.cid);
      const note = result.missingVrm ? "（VRM本体が見つからず、アバターなしで取り込みました）" : "";
      setEntryMessage({ entryId: entry.entryId, text: `「${result.name}」を取り込みました${note}` });
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
      const result = await runImport(rawCid);
      const note = result.missingVrm ? "（VRM本体が見つからず、アバターなしで取り込みました）" : "";
      setShareMessage({ text: `「${result.name}」を取り込みました${note}` });
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
        <p class="cat-status cat-status-error">
          ひろばへの接続に失敗しました{connectError ? `: ${connectError}` : ""}
          （オフラインの可能性があります。公開キャラの一覧は更新されません）
        </p>
      )}

      <PlazaStage />

      <section class="cat-panel">
        <label class="cat-label">公開プロフィール</label>
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
      </section>

      <section class="cat-panel">
        <label class="cat-label">共有リンクから取り込み</label>
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
          <p class={"cat-status" + (shareMessage.error ? " cat-status-error" : "")}>{shareMessage.text}</p>
        )}
      </section>

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
          </div>
        ) : (
          <div class="cat-grid">
            {entries.map((entry) => (
              <article key={entry.entryId} class="cat-card">
                <div class="cat-card-head">
                  <h4 class="cat-card-name">{entry.name || "無名のキャラクター"}</h4>
                  {entry.hasVrm && (
                    <span class="cat-badge" title="VRMモデルつき">
                      VRM
                    </span>
                  )}
                </div>
                <p class="cat-card-summary">{entry.summary || "（説明なし）"}</p>
                <div class="cat-card-meta">
                  <span class="cat-card-meta-item">
                    <User size={12} />
                    {entry.fromName || shortenId(entry.fromId)}
                  </span>
                  <span class="cat-card-meta-item">
                    <Clock size={12} />
                    {formatDate(entry.updatedAt)}
                  </span>
                </div>
                <button
                  class="cat-btn cat-btn-tonal cat-card-import"
                  type="button"
                  onClick={() => void handleImportEntry(entry)}
                  disabled={busyEntryId === entry.entryId}
                >
                  {busyEntryId === entry.entryId ? <span class="spinner" /> : <Download size={14} />}
                  インポート
                </button>
                {entryMessage && entryMessage.entryId === entry.entryId && (
                  <p class={"cat-status cat-card-status" + (entryMessage.error ? " cat-status-error" : "")}>
                    {entryMessage.text}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// --- Plaza stage -----------------------------------------------------------------
//
// A game-like "town square" at the top of ひろば: up to 4 actors (a mix of
// other people's published characters and my own) stand on a stage, and a
// play button starts a short ambient character<->character conversation
// (lib/plaza.ts) rendered as speech bubbles above their heads. The
// conversation never auto-starts, is hard-capped at PLAZA_MAX_TURNS, and is
// stopped on unmount (view switch) — see the cleanup effect below.

const PLAZA_ACTOR_COUNT = 4;
const PLAZA_MAX_TURNS = 8;

interface PlazaBubbleState {
  current: { actorKey: string; text: string; streaming: boolean } | null;
  previous: { actorKey: string; text: string } | null;
}

const EMPTY_PLAZA_BUBBLES: PlazaBubbleState = { current: null, previous: null };

function PlazaStage() {
  const [actors, setActors] = useState<PlazaActor[]>([]);
  const [loadingActors, setLoadingActors] = useState(true);
  const [talking, setTalking] = useState(false);
  const [turnCount, setTurnCount] = useState(0);
  const [bubbles, setBubbles] = useState<PlazaBubbleState>(EMPTY_PLAZA_BUBBLES);
  const [talkError, setTalkError] = useState<string | null>(null);
  const [selectedActor, setSelectedActor] = useState<PlazaActor | null>(null);

  const talkHandleRef = useRef<PlazaTalkHandle | null>(null);

  const loadActors = () => {
    setLoadingActors(true);
    void preparePlazaActors(PLAZA_ACTOR_COUNT).then((next) => {
      setActors(next);
      setLoadingActors(false);
    });
  };

  // Prepare the stage once on mount. Never auto-starts a conversation.
  useEffect(() => {
    loadActors();
    // Always stop any running talk when this view unmounts (view switch).
    return () => {
      talkHandleRef.current?.stop();
      talkHandleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopTalk() {
    talkHandleRef.current?.stop();
    talkHandleRef.current = null;
    setTalking(false);
  }

  function startTalk() {
    if (talking || actors.length < 2) return;
    setTalkError(null);
    setTurnCount(0);
    setBubbles(EMPTY_PLAZA_BUBBLES);
    setTalking(true);
    talkHandleRef.current = startPlazaTalk(actors, {
      maxTurns: PLAZA_MAX_TURNS,
      onLine: (actorKey, text, info) => {
        setBubbles((prev) => {
          if (prev.current && prev.current.actorKey !== actorKey) {
            return {
              previous: { actorKey: prev.current.actorKey, text: prev.current.text },
              current: { actorKey, text, streaming: info.streaming },
            };
          }
          return { previous: prev.previous, current: { actorKey, text, streaming: info.streaming } };
        });
        if (!info.streaming) setTurnCount((n) => n + 1);
      },
      onDone: () => {
        talkHandleRef.current = null;
        setTalking(false);
      },
      onError: (message) => {
        talkHandleRef.current = null;
        setTalking(false);
        setTalkError(message);
      },
    });
  }

  function handleShuffle() {
    if (talking) stopTalk();
    setBubbles(EMPTY_PLAZA_BUBBLES);
    setTalkError(null);
    loadActors();
  }

  const llmReady = hasConfiguredLlmProfile();

  return (
    <section class="cat-panel cat-plaza">
      <div class="cat-plaza-head">
        <h3>ひろばの様子</h3>
        <div class="cat-plaza-controls">
          {talking && (
            <span class="cat-plaza-turncount">
              {turnCount}/{PLAZA_MAX_TURNS}
            </span>
          )}
          {!llmReady ? (
            <span class="cat-hint cat-plaza-hint">設定でLLMをつなぐと、ひろばのキャラたちがおしゃべりを始めます</span>
          ) : (
            <button
              class={`cat-btn${talking ? " cat-btn-tonal" : " cat-btn-accent"}`}
              type="button"
              disabled={actors.length < 2 || loadingActors}
              title={actors.length < 2 ? "2人以上必要です" : talking ? "止める" : "おしゃべりを見る"}
              onClick={() => (talking ? stopTalk() : startTalk())}
            >
              {talking ? <Square size={14} /> : <Play size={14} />}
              {talking ? "止める" : "おしゃべりを見る"}
            </button>
          )}
          <button
            class="cat-btn"
            type="button"
            disabled={loadingActors}
            title="メンバー入れ替え"
            onClick={handleShuffle}
          >
            <Shuffle size={14} />
            メンバー入れ替え
          </button>
        </div>
      </div>

      {talkError && <p class="cat-status cat-status-error">{talkError}</p>}

      <div class="cat-plaza-scene">
        {!loadingActors && actors.length === 0 ? (
          <div class="cat-empty-state">
            <Trees size={22} />
            <p class="cat-empty">まだ誰もいません。キャラを公開すると、ここに集まってきます</p>
          </div>
        ) : (
          actors.map((actor) => {
            const isCurrent = bubbles.current?.actorKey === actor.key;
            const isPrevious = !isCurrent && bubbles.previous?.actorKey === actor.key;
            return (
              <button
                key={actor.key}
                type="button"
                class="cat-plaza-slot"
                onClick={() => setSelectedActor(actor)}
              >
                {(isCurrent || isPrevious) && (
                  <span class={`cat-plaza-bubble${isPrevious ? " cat-plaza-bubble--prev" : ""}`}>
                    {isCurrent ? bubbles.current!.text : bubbles.previous!.text}
                    {isCurrent && bubbles.current!.streaming && <span class="cat-plaza-cursor" />}
                  </span>
                )}
                <span class="cat-plaza-avatar-wrap">
                  <ActorStageAvatar actor={actor} speaking={isCurrent && Boolean(bubbles.current?.streaming)} />
                </span>
                <span class="cat-plaza-name">
                  {actor.name}
                  {actor.origin === "mine" && <span class="cat-badge cat-plaza-mine-badge">自分</span>}
                </span>
              </button>
            );
          })
        )}
      </div>

      {selectedActor && (
        <PlazaActorPopover
          actor={selectedActor}
          onClose={() => setSelectedActor(null)}
        />
      )}
    </section>
  );
}

function ActorStageAvatar(props: { actor: PlazaActor; speaking: boolean }) {
  const { actor, speaking } = props;
  if (actor.avatar && "imageDataUrl" in actor.avatar) {
    return (
      <div class={`tc-avatar cat-plaza-avatar${speaking ? " tc-avatar--speaking" : ""}`}>
        <img class="tc-avatar__img" src={actor.avatar.imageDataUrl} alt={actor.name} />
      </div>
    );
  }
  const pseudoCharacter: Character = {
    id: actor.key,
    createdAt: "",
    updatedAt: "",
    avatar: actor.avatar,
    sheet: emptyCharacterSheet(actor.name),
    llmProfileId: DEFAULT_LLM_PROFILE_ID,
  };
  return <CharacterAvatar character={pseudoCharacter} speaking={speaking} size={60} framing="full" />;
}

function PlazaActorPopover(props: { actor: PlazaActor; onClose: () => void }) {
  const { actor } = props;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  async function handleImport() {
    if (!actor.entry || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await runImport(actor.entry.cid);
      const note = result.missingVrm ? "（VRM本体が見つからず、アバターなしで取り込みました）" : "";
      setMessage({ text: `「${result.name}」を取り込みました${note}` });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="cat-plaza-popover-backdrop" onClick={props.onClose}>
      <div class="cat-plaza-popover" onClick={(e) => e.stopPropagation()}>
        <div class="cat-plaza-popover-head">
          <h4 class="cat-card-name">{actor.name}</h4>
          <button class="cat-plaza-popover-close" type="button" onClick={props.onClose} title="閉じる">
            <X size={16} />
          </button>
        </div>
        {actor.origin === "mine" ? (
          <span class="cat-badge">自分のキャラ</span>
        ) : (
          <span class="cat-card-meta-item">
            <User size={12} />
            {actor.entry?.fromName || shortenId(actor.entry?.fromId ?? "")}
          </span>
        )}
        <p class="cat-card-summary cat-plaza-popover-summary">{actor.summary || "（説明なし）"}</p>
        {actor.origin === "hiroba" && actor.entry && (
          <button class="cat-btn cat-btn-tonal cat-card-import" type="button" onClick={() => void handleImport()} disabled={busy}>
            {busy ? <span class="spinner" /> : <Download size={14} />}
            インポート
          </button>
        )}
        {message && <p class={"cat-status cat-card-status" + (message.error ? " cat-status-error" : "")}>{message.text}</p>}
      </div>
    </div>
  );
}

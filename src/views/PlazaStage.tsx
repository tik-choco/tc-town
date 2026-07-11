import { useEffect, useRef, useState } from "preact/hooks";
import {
  User,
  Trees,
  Play,
  Square,
  Shuffle,
  Download,
  X,
  RotateCcw,
  ScrollText,
  UserPlus,
  MessageCircle,
} from "lucide-preact";
import { fetchAndImportCatalogCid, shortenPeerId } from "../lib/catalog";
import {
  preparePlazaActors,
  startPlazaTalk,
  hasConfiguredLlmProfile,
  type PlazaActor,
  type PlazaTalkHandle,
} from "../lib/plaza";
import { CharacterAvatar } from "../components/CharacterAvatar";
import { emptyCharacterSheet, DEFAULT_LLM_PROFILE_ID, type Character } from "../types";
import { requestNavigate } from "../lib/navigation";
import { setPendingChatCharacterId } from "./ChatView";
import "../styles/plaza.css";

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

/** "開始前 / 進行中 / 終了" — lets the controls show a distinct "終わりました" state
 * instead of silently reverting to the pre-talk look (see startTalk/onDone below). */
type PlazaTalkPhase = "idle" | "talking" | "ended";

/** One confirmed (non-streaming) line for the scrollable conversation log — see onLine below. */
interface PlazaLogEntry {
  name: string;
  text: string;
}

export function PlazaStage() {
  const [actors, setActors] = useState<PlazaActor[]>([]);
  const [loadingActors, setLoadingActors] = useState(true);
  const [phase, setPhase] = useState<PlazaTalkPhase>("idle");
  const [turnCount, setTurnCount] = useState(0);
  const [bubbles, setBubbles] = useState<PlazaBubbleState>(EMPTY_PLAZA_BUBBLES);
  const [talkError, setTalkError] = useState<string | null>(null);
  const [selectedActor, setSelectedActor] = useState<PlazaActor | null>(null);
  const [log, setLog] = useState<PlazaLogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);

  const talkHandleRef = useRef<PlazaTalkHandle | null>(null);
  // Mirrors turnCount but readable synchronously inside the onDone callback —
  // setTurnCount's update may not have committed yet when onDone fires right
  // after the last onLine, and onDone needs to know "did at least one line
  // actually happen" to decide whether to show the "終わりました" state.
  const turnsRef = useRef(0);
  const talking = phase === "talking";

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
    // A manual stop is not a natural "終了" (plaza.ts's stop() suppresses its
    // own onDone — see startPlazaTalk) so this goes straight back to idle,
    // not "ended" — the "もう一度" state is reserved for a talk that ran its
    // course on its own.
    setPhase("idle");
  }

  function startTalk() {
    if (talking || actors.length < 2) return;
    setTalkError(null);
    setTurnCount(0);
    turnsRef.current = 0;
    setBubbles(EMPTY_PLAZA_BUBBLES);
    setLog([]);
    setLogOpen(false);
    setPhase("talking");
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
        if (!info.streaming) {
          turnsRef.current += 1;
          setTurnCount((n) => n + 1);
          const name = actors.find((a) => a.key === actorKey)?.name ?? "?";
          setLog((prev) => [...prev, { name, text }]);
        }
      },
      onDone: () => {
        talkHandleRef.current = null;
        // Only announce "終わりました" if the talk actually produced at least
        // one line — a same-tick no-op run (e.g. pickNextPlazaSpeaker somehow
        // finding nobody) should just quietly fall back to idle.
        setPhase(turnsRef.current > 0 ? "ended" : "idle");
      },
      onError: (message) => {
        talkHandleRef.current = null;
        setPhase("idle");
        setTalkError(message);
      },
    });
  }

  function handleShuffle() {
    if (talking) stopTalk();
    setPhase("idle");
    setBubbles(EMPTY_PLAZA_BUBBLES);
    setTalkError(null);
    setLog([]);
    setLogOpen(false);
    loadActors();
  }

  const llmReady = hasConfiguredLlmProfile();

  return (
    <section class="cat-panel cat-plaza">
      <div class="cat-plaza-head">
        <h3>ひろばの様子</h3>
        <div class="cat-plaza-controls">
          {(talking || (phase === "ended" && turnCount > 0)) && (
            // Small, ambient turn-progress dots rather than a "3/8" counter —
            // one dot per PLAZA_MAX_TURNS turn, filled in as lines land.
            <span
              class="cat-plaza-progress"
              role="img"
              aria-label={`${turnCount}/${PLAZA_MAX_TURNS}ターン`}
              title={`${turnCount}/${PLAZA_MAX_TURNS}`}
            >
              {Array.from({ length: PLAZA_MAX_TURNS }, (_, i) => (
                <span
                  key={i}
                  class={`cat-plaza-progress-dot${i < turnCount ? " cat-plaza-progress-dot--filled" : ""}`}
                />
              ))}
            </span>
          )}
          {log.length > 0 && (
            <button
              class={`cat-btn cat-plaza-log-toggle${logOpen ? " cat-btn-tonal" : ""}`}
              type="button"
              title="ログを表示"
              onClick={() => setLogOpen((v) => !v)}
            >
              <ScrollText size={14} />
              ログ
            </button>
          )}
          {!llmReady ? (
            <span class="cat-hint cat-plaza-hint">設定でLLMをつなぐと、ひろばのキャラたちがおしゃべりを始めます</span>
          ) : phase === "ended" ? (
            // A natural end (all turns used / no next speaker) gets its own
            // small "終わりました" + restart affordance instead of silently
            // reverting to the pre-talk look — see onDone above.
            <span class="cat-plaza-ended">
              <span class="cat-plaza-ended-text">おしゃべりが終わりました</span>
              <button
                class="cat-btn cat-btn-accent"
                type="button"
                disabled={actors.length < 2 || loadingActors}
                title="もう一度おしゃべりを見る"
                onClick={startTalk}
              >
                <RotateCcw size={14} />
                もう一度
              </button>
            </span>
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
            <button
              class="cat-btn cat-btn-tonal"
              type="button"
              onClick={() => requestNavigate("characters")}
            >
              <UserPlus size={14} />
              キャラクターを作る
            </button>
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

      {logOpen && log.length > 0 && (
        // Read-back for lines that already scrolled out of the 2-bubble
        // window above — cleared on every new talk/shuffle (see startTalk /
        // handleShuffle), never persisted.
        <div class="cat-plaza-log">
          <ul class="cat-plaza-log-list">
            {log.map((entry, i) => (
              <li key={i} class="cat-plaza-log-entry">
                <span class="cat-plaza-log-name">{entry.name}</span>
                <span class="cat-plaza-log-text">{entry.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

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
  const [message, setMessage] = useState<{ text: string; error?: boolean; characterId?: string } | null>(
    null,
  );

  async function handleImport() {
    if (!actor.entry || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await fetchAndImportCatalogCid(actor.entry.cid);
      const note = result.missingVrm ? "（VRM本体が見つからず、アバターなしで取り込みました）" : "";
      setMessage({ text: `「${result.name}」を取り込みました${note}`, characterId: result.characterId });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  // Own local character: jump straight into a chat with it preselected
  // (ChatView's setPendingChatCharacterId, consumed once on its mount).
  function handleChat() {
    if (!actor.characterId) return;
    setPendingChatCharacterId(actor.characterId);
    requestNavigate("chat");
    props.onClose();
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
            {actor.entry?.fromName || shortenPeerId(actor.entry?.fromId ?? "")}
          </span>
        )}
        <p class="cat-card-summary cat-plaza-popover-summary">{actor.summary || "（説明なし）"}</p>
        {actor.origin === "mine" && actor.characterId && (
          <button class="cat-btn cat-btn-tonal cat-card-import" type="button" onClick={handleChat}>
            <MessageCircle size={14} />
            会話する
          </button>
        )}
        {actor.origin === "hiroba" && actor.entry && (
          <button class="cat-btn cat-btn-tonal cat-card-import" type="button" onClick={() => void handleImport()} disabled={busy}>
            {busy ? <span class="spinner" /> : <Download size={14} />}
            取り込み
          </button>
        )}
        {message && (
          <div class="cat-status-row cat-card-status">
            <p class={"cat-status" + (message.error ? " cat-status-error" : "")}>{message.text}</p>
            {!message.error && message.characterId && (
              <button
                class="cat-btn cat-btn-tonal cat-chat-cta"
                type="button"
                onClick={() => {
                  setPendingChatCharacterId(message.characterId!);
                  requestNavigate("chat");
                  props.onClose();
                }}
              >
                <MessageCircle size={13} />
                会話する
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

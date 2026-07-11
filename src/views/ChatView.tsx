import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  MessageSquarePlus,
  Trash2,
  Users,
  Play,
  Square,
  SendHorizontal,
  Pencil,
  Check,
  X,
  GraduationCap,
  ClipboardCheck,
} from "lucide-preact";
import type { Character, CharacterSheet, ChatMessage } from "../types";
import { CharacterAvatar } from "../components/CharacterAvatar";
import { listCharacters, subscribeCharacters } from "../lib/characterStorage";
import { growFromConversation } from "../lib/growth";
import {
  ConversationEngine,
  USER_SPEAKER_ID,
  listSessions,
  createSession,
  deleteSession,
  renameSession,
  type ConversationSession,
  type EngineState,
  type TranscriptEntry,
} from "../lib/conversation";
import {
  evaluateSession,
  listEvaluations,
  CONVERSATION_AXES,
  type EvaluationRecord,
} from "../lib/evaluation";
import "../styles/chat.css";
import "../styles/evaluation.css";

// --- pending character preselection ----------------------------------------
// PlazaStage's actor popover ("会話する" on my own characters) and CatalogView's
// import-success CTA want to land here with a specific character already in
// the conversation, without threading a prop through app.tsx's view-switch
// plumbing (app.tsx/lib/navigation.ts are off-limits — see requestNavigate).
// Same one-shot module-level handoff pattern as CatalogView's
// setPendingCatalogShareCid: the caller sets this right before requestNavigate,
// and ChatView consumes it exactly once on mount below.
let pendingChatCharacterId: string | null = null;

export function setPendingChatCharacterId(id: string | null): void {
  pendingChatCharacterId = id;
}

// Deterministic accent color per speaker so each character reads consistently
// across the transcript. The user gets the brand accent.
const SPEAKER_HUES = [212, 152, 22, 280, 340, 48, 190, 110];

// Japanese labels for the sheet fields the growth flow may update, used in the
// "learned from this conversation" note.
const SHEET_FIELD_LABELS: Record<keyof CharacterSheet, string> = {
  name: "名前",
  summary: "ひとこと説明",
  persona: "人物・背景",
  speechStyle: "話し方",
  likes: "好き・嫌い",
  relationships: "人間関係",
  notes: "メモ",
};

function speakerColor(speakerId: string): string {
  if (speakerId === USER_SPEAKER_ID) return "var(--accent)";
  let hash = 0;
  for (let i = 0; i < speakerId.length; i++) hash = (hash * 31 + speakerId.charCodeAt(i)) | 0;
  const hue = SPEAKER_HUES[Math.abs(hash) % SPEAKER_HUES.length];
  return `hsl(${hue} 60% 45%)`;
}

export function ChatView() {
  const [sessions, setSessions] = useState<ConversationSession[]>(() => listSessions());
  const [activeId, setActiveId] = useState<string | null>(() => listSessions()[0]?.id ?? null);
  const [characters, setCharacters] = useState<Character[]>(() => listCharacters());

  const refreshSessions = () => setSessions(listSessions());

  // One engine per active session; recreated when the selection changes.
  const engine = useMemo(() => {
    if (!activeId) return null;
    const session = listSessions().find((s) => s.id === activeId);
    if (!session) return null;
    return new ConversationEngine(session);
  }, [activeId]);

  const [state, setState] = useState<EngineState | null>(() => engine?.getState() ?? null);

  useEffect(() => {
    if (!engine) {
      setState(null);
      return;
    }
    setState(engine.getState());
    const unsub = engine.subscribe(setState);
    return () => {
      unsub();
      engine.dispose();
    };
  }, [engine]);

  // Keep the sidebar in sync whenever the transcript/title changes.
  useEffect(() => {
    if (state) refreshSessions();
  }, [state?.session.updatedAt, state?.session.title]);

  // Keep participant avatars/names in sync with edits from the Characters view
  // (including sheet updates from "この会話から学習").
  useEffect(() => {
    const refresh = () => setCharacters(listCharacters());
    const unsubscribe = subscribeCharacters(refresh);
    refresh();
    return unsubscribe;
  }, []);

  const handleNewSession = () => {
    const session = createSession();
    refreshSessions();
    setActiveId(session.id);
  };

  // Consume a pending character preselection (set by PlazaStage/CatalogView
  // right before requestNavigate('chat')) exactly once: start a fresh
  // session with that character already seated, rather than dumping the user
  // into whatever session happened to be first. Ignored if the character was
  // removed between the click and this mount.
  useEffect(() => {
    if (!pendingChatCharacterId) return;
    const characterId = pendingChatCharacterId;
    pendingChatCharacterId = null;
    if (!listCharacters().some((c) => c.id === characterId)) return;
    const session = createSession(undefined, [characterId]);
    refreshSessions();
    setActiveId(session.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDeleteSession = (id: string) => {
    deleteSession(id);
    const remaining = listSessions();
    setSessions(remaining);
    if (activeId === id) setActiveId(remaining[0]?.id ?? null);
  };

  return (
    <div class="tc-chat">
      <aside class="tc-chat-sidebar">
        <div class="tc-chat-sidebar-head">
          <span>会話</span>
          <button class="tc-chat-icon-btn" title="新しい会話" onClick={handleNewSession}>
            <MessageSquarePlus size={18} />
          </button>
        </div>
        <ul class="tc-chat-session-list">
          {sessions.length === 0 && <li class="tc-chat-empty">会話がありません</li>}
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeId}
              onSelect={() => setActiveId(s.id)}
              onDelete={() => handleDeleteSession(s.id)}
              onRename={(title) => {
                renameSession(s.id, title);
                refreshSessions();
              }}
            />
          ))}
        </ul>
      </aside>

      {engine && state ? (
        <ChatRoom
          engine={engine}
          state={state}
          characters={characters}
          onParticipantsChanged={refreshSessions}
        />
      ) : (
        <div class="tc-chat-placeholder">
          <p>会話を選択するか、新しい会話を作成してください。</p>
          <button class="tc-chat-btn tc-chat-btn-accent" onClick={handleNewSession}>
            <MessageSquarePlus size={16} /> 新しい会話
          </button>
        </div>
      )}
    </div>
  );
}

function SessionRow(props: {
  session: ConversationSession;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.session.title);

  if (editing) {
    return (
      <li class="tc-chat-session-row editing">
        <input
          class="tc-chat-input"
          value={draft}
          autoFocus
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              props.onRename(draft);
              setEditing(false);
            } else if (e.key === "Escape") {
              setDraft(props.session.title);
              setEditing(false);
            }
          }}
        />
        <button
          class="tc-chat-icon-btn"
          title="保存"
          onClick={() => {
            props.onRename(draft);
            setEditing(false);
          }}
        >
          <Check size={15} />
        </button>
        <button
          class="tc-chat-icon-btn"
          title="キャンセル"
          onClick={() => {
            setDraft(props.session.title);
            setEditing(false);
          }}
        >
          <X size={15} />
        </button>
      </li>
    );
  }

  return (
    <li class={`tc-chat-session-row${props.active ? " active" : ""}`}>
      <button class="tc-chat-session-main" onClick={props.onSelect}>
        <span class="tc-chat-session-title">{props.session.title}</span>
        <span class="tc-chat-session-meta">{props.session.participantIds.length}人</span>
      </button>
      <button
        class="tc-chat-icon-btn"
        title="名前を変更"
        onClick={() => {
          setDraft(props.session.title);
          setEditing(true);
        }}
      >
        <Pencil size={14} />
      </button>
      <button class="tc-chat-icon-btn danger" title="削除" onClick={props.onDelete}>
        <Trash2 size={14} />
      </button>
    </li>
  );
}

function ChatRoom(props: {
  engine: ConversationEngine;
  state: EngineState;
  characters: Character[];
  onParticipantsChanged: () => void;
}) {
  const { engine, state, characters } = props;
  const [input, setInput] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [learnOpen, setLearnOpen] = useState(false);
  const [learnBusy, setLearnBusy] = useState(false);
  const [learnNote, setLearnNote] = useState<string | null>(null);
  const [evalOpen, setEvalOpen] = useState(false);
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [evalHistory, setEvalHistory] = useState<EvaluationRecord[]>(() =>
    listEvaluations(props.state.session.id),
  );
  const [selectedEvalId, setSelectedEvalId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const charById = useMemo(() => {
    const m = new Map<string, Character>();
    for (const c of characters) m.set(c.id, c);
    return m;
  }, [characters]);

  const participants = state.session.participantIds
    .map((id) => charById.get(id))
    .filter((c): c is Character => c !== undefined);

  // Auto-scroll to the newest line / streaming updates.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.session.transcript.length, state.streaming?.text]);

  // Evaluation state is per-session — reset the panel and reload history
  // whenever the active session changes.
  useEffect(() => {
    setEvalOpen(false);
    setEvalBusy(false);
    setEvalError(null);
    setEvalHistory(listEvaluations(state.session.id));
    setSelectedEvalId(null);
  }, [state.session.id]);

  // listEvaluations() returns newest-first, so the head of the list is the
  // latest evaluation unless the user picked an older one from the history.
  const selectedEvaluation = useMemo(() => {
    if (evalHistory.length === 0) return null;
    if (selectedEvalId) return evalHistory.find((e) => e.id === selectedEvalId) ?? evalHistory[0];
    return evalHistory[0];
  }, [evalHistory, selectedEvalId]);

  const handleEvaluate = async () => {
    setEvalError(null);
    setEvalBusy(true);
    try {
      const record = await evaluateSession(state.session, charById);
      setEvalHistory((prev) => [record, ...prev]);
      setSelectedEvalId(record.id);
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : String(err));
    } finally {
      setEvalBusy(false);
    }
  };

  const canSend = input.trim().length > 0 && participants.length > 0 && !state.busy;

  const handleSend = () => {
    if (!canSend) return;
    const text = input;
    setInput("");
    // Every participant responds in turn order.
    void engine.sendUserMessage(text, state.session.participantIds);
  };

  const toggleParticipant = (id: string) => {
    const ids = state.session.participantIds.includes(id)
      ? state.session.participantIds.filter((x) => x !== id)
      : [...state.session.participantIds, id];
    engine.setParticipants(ids);
    props.onParticipantsChanged();
  };

  // Learn from this conversation: run the growth pass over recent transcript
  // for one participant. The character's own lines become `assistant` turns and
  // everyone else's (prefixed with their name) become `user` turns.
  const handleLearn = async (character: Character) => {
    setLearnOpen(false);
    setLearnBusy(true);
    setLearnNote(null);
    const recent = state.session.transcript.slice(-40).map<ChatMessage>((entry) => {
      if (entry.speakerId === character.id) {
        return { role: "assistant", content: entry.text };
      }
      const name =
        entry.speakerId === USER_SPEAKER_ID
          ? "ユーザー"
          : charById.get(entry.speakerId)?.sheet.name ?? "誰か";
      return { role: "user", content: `${name}: ${entry.text}` };
    });
    try {
      const { changed } = await growFromConversation(character, recent);
      if (changed.length === 0) {
        setLearnNote(`${character.sheet.name}: この会話から新しく学べることはありませんでした。`);
      } else {
        const labels = changed.map((k) => SHEET_FIELD_LABELS[k]).join("、");
        setLearnNote(`${character.sheet.name}のシートを更新しました（${labels}）。`);
      }
    } catch (err) {
      setLearnNote(`学習に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLearnBusy(false);
    }
  };

  return (
    <section class="tc-chat-room">
      <header class="tc-chat-room-head">
        <div class="tc-chat-participants" onClick={() => setPickerOpen((v) => !v)} role="button">
          <Users size={16} />
          {participants.length === 0 ? (
            <span class="tc-chat-muted">キャラクター未選択</span>
          ) : (
            participants.map((c) => (
              <span key={c.id} class="tc-chat-chip" style={{ borderColor: speakerColor(c.id) }}>
                {c.sheet.name}
              </span>
            ))
          )}
        </div>

        <div class="tc-chat-room-actions">
          {state.autoRunning ? (
            <span class="tc-chat-turncap" title="残り自動ターン">
              残り {state.autoTurnsRemaining}/{state.maxAutoTurns}
            </span>
          ) : null}
          <button
            class="tc-chat-btn"
            disabled={
              participants.length === 0 ||
              state.session.transcript.length === 0 ||
              learnBusy ||
              state.busy
            }
            title={
              participants.length === 0
                ? "キャラクターを選択してください"
                : "この会話からキャラクターが学習します"
            }
            onClick={() => setLearnOpen((v) => !v)}
          >
            {learnBusy ? <span class="spinner" /> : <GraduationCap size={15} />}
            会話から学習
          </button>
          <button
            class="tc-chat-btn"
            disabled={state.session.transcript.length === 0 || state.busy}
            title="この会話をLLMで評価"
            onClick={() => setEvalOpen((v) => !v)}
          >
            <ClipboardCheck size={15} />
            評価
          </button>
          <button
            class={`tc-chat-btn${state.autoRunning ? " tc-chat-btn-danger" : " tc-chat-btn-accent"}`}
            disabled={participants.length < 2}
            title={participants.length < 2 ? "2人以上必要です" : "自動会話"}
            onClick={() => (state.autoRunning ? engine.stopAuto() : void engine.startAuto())}
          >
            {state.autoRunning ? <Square size={15} /> : <Play size={15} />}
            自動会話
          </button>
        </div>
      </header>

      {learnOpen && participants.length > 0 && (
        <div class="tc-chat-picker">
          <div class="tc-chat-picker-head">この会話から学習するキャラクター</div>
          <div class="tc-chat-picker-grid">
            {participants.map((c) => (
              <button
                key={c.id}
                class="tc-chat-picker-item"
                disabled={learnBusy}
                onClick={() => void handleLearn(c)}
              >
                <CharacterAvatar character={c} size={36} />
                <span>{c.sheet.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {learnNote && (
        <div class="tc-chat-note">
          <span>{learnNote}</span>
          <button class="tc-chat-icon-btn" title="閉じる" onClick={() => setLearnNote(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      {evalOpen && (
        <div class="tc-eval-panel">
          <div class="tc-eval-panel-head">
            <span class="tc-eval-panel-title">会話評価</span>
            <button
              class="tc-chat-btn tc-chat-btn-accent"
              disabled={evalBusy || state.session.transcript.length === 0}
              onClick={() => void handleEvaluate()}
            >
              {evalBusy ? <span class="spinner" /> : <ClipboardCheck size={14} />}
              {evalBusy ? "評価中..." : "評価を実行"}
            </button>
          </div>

          {evalHistory.length > 1 && (
            <div class="tc-eval-history">
              <label class="tc-eval-history-label" for="tc-eval-history-select">
                履歴
              </label>
              <select
                id="tc-eval-history-select"
                class="tc-eval-history-select"
                value={selectedEvaluation?.id ?? ""}
                onChange={(e) => setSelectedEvalId((e.target as HTMLSelectElement).value)}
              >
                {evalHistory.map((rec) => (
                  <option key={rec.id} value={rec.id}>
                    {new Date(rec.evaluatedAt).toLocaleString("ja-JP")}
                  </option>
                ))}
              </select>
            </div>
          )}

          {evalError && <div class="tc-eval-error">評価に失敗しました: {evalError}</div>}

          {selectedEvaluation ? (
            <EvaluationResult record={selectedEvaluation} />
          ) : (
            !evalBusy &&
            !evalError && (
              <div class="tc-eval-empty">
                まだ評価がありません。「評価を実行」を押してください。
              </div>
            )
          )}
        </div>
      )}

      {pickerOpen && (
        <div class="tc-chat-picker">
          <div class="tc-chat-picker-head">参加キャラクター</div>
          {characters.length === 0 && <div class="tc-chat-empty">キャラクターがいません</div>}
          <div class="tc-chat-picker-grid">
            {characters.map((c) => {
              const selected = state.session.participantIds.includes(c.id);
              return (
                <button
                  key={c.id}
                  class={`tc-chat-picker-item${selected ? " selected" : ""}`}
                  onClick={() => toggleParticipant(c.id)}
                >
                  <CharacterAvatar character={c} size={36} />
                  <span>{c.sheet.name}</span>
                  {selected && <Check size={14} class="tc-chat-picker-check" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div class="tc-chat-transcript" ref={scrollRef}>
        {state.session.transcript.length === 0 && !state.streaming && (
          <div class="tc-chat-empty-transcript">
            メッセージを送るか、「自動会話」でキャラクター同士の会話を始めましょう。
          </div>
        )}
        {state.session.transcript.map((entry) => (
          <MessageBubble key={entry.id} entry={entry} charById={charById} />
        ))}
        {state.streaming && (
          <StreamingBubble
            speakerId={state.streaming.speakerId}
            text={state.streaming.text}
            charById={charById}
          />
        )}
      </div>

      {state.error && <div class="tc-chat-error">{state.error}</div>}

      <div class="tc-chat-composer">
        <textarea
          class="tc-chat-textarea"
          placeholder="メッセージを入力..."
          value={input}
          rows={1}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button
          class="tc-chat-btn tc-chat-btn-accent tc-chat-send"
          disabled={!canSend}
          onClick={handleSend}
          title="送信"
        >
          <SendHorizontal size={16} />
        </button>
      </div>
    </section>
  );
}

function MessageBubble(props: { entry: TranscriptEntry; charById: Map<string, Character> }) {
  const { entry, charById } = props;
  const isUser = entry.speakerId === USER_SPEAKER_ID;
  const character = charById.get(entry.speakerId);
  const name = isUser ? "ユーザー" : character?.sheet.name ?? "不明";
  const color = speakerColor(entry.speakerId);

  return (
    <div class={`tc-chat-msg${isUser ? " user" : ""}`}>
      {!isUser && character && (
        <div class="tc-chat-msg-avatar">
          <CharacterAvatar character={character} size={40} />
        </div>
      )}
      <div class="tc-chat-msg-body">
        <span class="tc-chat-msg-name" style={{ color }}>
          {name}
        </span>
        <div class="tc-chat-msg-text">{entry.text}</div>
      </div>
    </div>
  );
}

function StreamingBubble(props: {
  speakerId: string;
  text: string;
  charById: Map<string, Character>;
}) {
  const character = props.charById.get(props.speakerId);
  const name = character?.sheet.name ?? "…";
  const color = speakerColor(props.speakerId);

  return (
    <div class="tc-chat-msg">
      {character && (
        <div class="tc-chat-msg-avatar">
          <CharacterAvatar character={character} size={40} speaking />
        </div>
      )}
      <div class="tc-chat-msg-body">
        <span class="tc-chat-msg-name" style={{ color }}>
          {name}
        </span>
        <div class="tc-chat-msg-text">
          {props.text}
          <span class="tc-chat-cursor" />
        </div>
      </div>
    </div>
  );
}

// Renders one evaluation record: per-axis dot meters, notes, and latency.
// Scores of 0 mean the judge couldn't parse a rating for that axis, shown as "—".
function EvaluationResult(props: { record: EvaluationRecord }) {
  const { record } = props;

  const validScores = CONVERSATION_AXES.map((axis) => record.scores[axis.key] ?? 0).filter(
    (score) => score > 0,
  );
  const average =
    validScores.length > 0
      ? validScores.reduce((sum, score) => sum + score, 0) / validScores.length
      : null;

  return (
    <div class="tc-eval-result">
      <div class="tc-eval-summary">
        <span class="tc-eval-average">平均スコア {average !== null ? average.toFixed(1) : "—"} / 5</span>
        <span class="tc-eval-time">{new Date(record.evaluatedAt).toLocaleString("ja-JP")}</span>
      </div>

      <ul class="tc-eval-axes">
        {CONVERSATION_AXES.map((axis) => {
          const score = record.scores[axis.key] ?? 0;
          return (
            <li key={axis.key} class="tc-eval-axis-row" title={axis.rubric}>
              <span class="tc-eval-axis-label">{axis.label}</span>
              <span class="tc-eval-dots">
                {[1, 2, 3, 4, 5].map((n) => (
                  <span key={n} class={`tc-eval-dot${score >= n ? " filled" : ""}`} />
                ))}
              </span>
              <span class="tc-eval-axis-score">{score > 0 ? `${score}/5` : "—"}</span>
            </li>
          );
        })}
      </ul>

      {record.notes && <div class="tc-eval-notes">{record.notes}</div>}

      {record.averageLatencySeconds !== null && (
        <div class="tc-eval-latency">
          平均応答 {record.averageLatencySeconds.toFixed(1)} 秒
        </div>
      )}
    </div>
  );
}

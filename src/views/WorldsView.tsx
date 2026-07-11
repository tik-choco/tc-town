import { useEffect, useRef, useState } from "preact/hooks";
import { Plus, Trash2, Globe, Users, FileText, Sparkles } from "lucide-preact";
import type { WorldSetting } from "../lib/worlds";
import { createWorld, deleteWorld, getWorld, listWorlds, saveWorld, subscribeWorlds } from "../lib/worlds";
import { listCharacters, subscribeCharacters } from "../lib/characterStorage";
import { requestChatCompletion } from "../lib/llm";
import { DEFAULT_LLM_PROFILE_ID, type Character, type ChatMessage } from "../types";
import { CharacterAvatar } from "../components/CharacterAvatar";
import "../styles/worlds.css";

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
}

const DESCRIPTION_TEMPLATE = `## 時代
（いつの時代か、時間の流れ方や技術水準など）

## 場所
（舞台となる土地、地理・気候・街並みなどの特徴）

## 社会・文化
（社会の仕組み、身分や組織、価値観、言語や風習）

## 雰囲気
（この世界全体に漂う空気感、色や音のイメージ）

## 独自のルール
（この世界特有の法則・制約・力・タブーなど）

## このごろの出来事
（直近で起きている事件や噂、話題になっていること）`;

/** ~200 chars of existing description is treated as "already substantial" for the AI-enrich prompt branch. */
const SUBSTANTIAL_DESCRIPTION_LENGTH = 200;

function buildEnrichMessages(draft: WorldSetting, members: Character[]): ChatMessage[] {
  const name = draft.name.trim() || "無題の世界";
  const description = draft.description.trim();
  const isSubstantial = description.length >= SUBSTANTIAL_DESCRIPTION_LENGTH;

  const modeInstruction = isSubstantial
    ? "既存の説明はすでにある程度書き込まれています。書かれている内容と矛盾しないように保ちながら、" +
      "手薄な側面（時代・場所・社会文化・雰囲気・独自のルール・このごろの出来事など）を補って拡張してください。" +
      "すでにある良い記述は活かし、丸ごと書き換えないでください。"
    : "現在の説明はまだ薄い状態です。世界観の骨格からしっかり構築し、豊かに書き起こしてください。";

  const system =
    "あなたは物語世界の設定を練り上げるクリエイティブライティングの専門家です。" +
    "与えられた世界観の名前・現在の説明文（と、参考になる場合は所属キャラクターの情報）をもとに、" +
    "「時代」「場所」「社会・文化」「雰囲気」「独自のルール」「このごろの出来事」といった側面を意識しながら、" +
    "より奥行きのある説明文を日本語で書いてください。\n\n" +
    "出力条件:\n" +
    "- 説明文の本文のみを出力すること（前置き・後書き・コードブロックは不要）\n" +
    "- 見出しがある場合は「## 見出し」の形式を保つこと\n" +
    "- 全体で400〜800字程度を目安にすること\n" +
    `- ${modeInstruction}`;

  const membersBlock =
    members.length > 0
      ? "この世界観を使っているキャラクター:\n" +
        members
          .map((c) => `- ${c.sheet.name || "無名のキャラクター"}${c.sheet.summary.trim() ? `: ${c.sheet.summary.trim()}` : ""}`)
          .join("\n")
      : "";

  const user = [
    `世界観の名前: ${name}`,
    "",
    "現在の説明:",
    description || "(まだ何も書かれていません)",
    ...(membersBlock ? ["", membersBlock] : []),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** World-setting management view — list + editor, mirrors CharactersView's layout (sidebar list + create, right-hand editor panel). */
export function WorldsView() {
  const [worlds, setWorlds] = useState<WorldSetting[]>(() => listWorlds());
  const [characters, setCharacters] = useState<Character[]>(() => listCharacters());
  const [selectedId, setSelectedId] = useState<string | null>(() => listWorlds()[0]?.id ?? null);
  const [draft, setDraft] = useState<WorldSetting | null>(null);
  const [newName, setNewName] = useState("");
  const [enrichBusy, setEnrichBusy] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);

  // Keep the sidebar list in sync with storage (this tab or another).
  useEffect(() => {
    const refresh = () => setWorlds(listWorlds());
    const unsubscribe = subscribeWorlds(refresh);
    refresh();
    return unsubscribe;
  }, []);

  // Track characters so the "所属キャラクター" panel stays live as characters
  // are created/edited/re-assigned elsewhere.
  useEffect(() => {
    const refresh = () => setCharacters(listCharacters());
    const unsubscribe = subscribeCharacters(refresh);
    refresh();
    return unsubscribe;
  }, []);

  // --- Auto-save -------------------------------------------------------
  // Same pattern as CharactersView: user edits (updateDraft) persist after a
  // short debounce, `dirtyRef` keeps programmatic draft loads from re-saving,
  // and pending edits are flushed on selection change / unmount.
  const draftRef = useRef<WorldSetting | null>(null);
  draftRef.current = draft;
  const dirtyRef = useRef(false);
  const autoSaveTimer = useRef<number | undefined>(undefined);

  function flushAutoSave() {
    if (autoSaveTimer.current) {
      window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = undefined;
    }
    const current = draftRef.current;
    if (!dirtyRef.current || !current) return;
    // Never persist a nameless world; stay dirty so the save happens as soon
    // as a name is typed again.
    if (!current.name.trim()) return;
    dirtyRef.current = false;
    saveWorld(current);
    setWorlds(listWorlds());
  }

  function scheduleAutoSave() {
    dirtyRef.current = true;
    if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = window.setTimeout(flushAutoSave, 600);
  }

  function cancelAutoSave() {
    dirtyRef.current = false;
    if (autoSaveTimer.current) {
      window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = undefined;
    }
  }

  // Flush pending edits when the view unmounts (e.g. switching tabs).
  useEffect(() => flushAutoSave, []);

  // Load a fresh editable draft whenever the selection changes.
  useEffect(() => {
    // Persist any still-debouncing edits to the previous world first.
    flushAutoSave();
    if (!selectedId) {
      setDraft(null);
      return;
    }
    const found = getWorld(selectedId);
    setDraft(found ? { ...found } : null);
    setEnrichError(null);
  }, [selectedId]);

  const members = draft ? characters.filter((c) => c.worldId === draft.id) : [];

  function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const world = createWorld(name);
    setNewName("");
    setWorlds(listWorlds());
    setSelectedId(world.id);
  }

  function updateDraft<K extends keyof WorldSetting>(key: K, value: WorldSetting[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
    scheduleAutoSave();
  }

  function handleDelete() {
    if (!draft) return;
    const ok = window.confirm(`「${draft.name || "無題の世界"}」を削除しますか？この操作は取り消せません。`);
    if (!ok) return;
    // Drop any pending auto-save so the deleted world can't be resurrected by
    // a debounced write firing after the delete.
    cancelAutoSave();
    deleteWorld(draft.id);
    setSelectedId(null);
    setWorlds(listWorlds());
  }

  function handleInsertTemplate() {
    if (!draft || draft.description.trim()) return;
    updateDraft("description", DESCRIPTION_TEMPLATE);
  }

  async function handleEnrich() {
    if (!draft || enrichBusy) return;
    setEnrichBusy(true);
    setEnrichError(null);
    try {
      const messages = buildEnrichMessages(draft, members);
      const result = await requestChatCompletion(DEFAULT_LLM_PROFILE_ID, messages);
      const cleaned = result.trim();
      if (!cleaned) throw new Error("AIから応答がありませんでした。");
      updateDraft("description", cleaned);
    } catch (error) {
      setEnrichError(`AIでのふくらませに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setEnrichBusy(false);
    }
  }

  return (
    <div class="wv-root">
      <aside class="wv-sidebar">
        <div class="wv-create">
          <input
            class="wv-input"
            type="text"
            placeholder="新しい世界観の名前"
            value={newName}
            onInput={(e) => setNewName(inputValue(e))}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
          />
          <button class="wv-btn wv-btn-accent" type="button" onClick={handleCreate} disabled={!newName.trim()}>
            <Plus size={16} />
            作成
          </button>
        </div>

        <div class="wv-list">
          {worlds.length === 0 ? (
            <div class="wv-empty-state">
              <Globe size={24} />
              <p class="wv-empty">まだ世界観がありません。名前を入力して作成しましょう。</p>
            </div>
          ) : (
            worlds.map((w) => (
              <button
                key={w.id}
                type="button"
                class={"wv-list-item" + (w.id === selectedId ? " is-active" : "")}
                onClick={() => setSelectedId(w.id)}
              >
                <span class="wv-list-icon">
                  <Globe size={18} />
                </span>
                <span class="wv-list-meta">
                  <span class="wv-list-name">{w.name || "無題の世界"}</span>
                  <span class="wv-list-summary">{w.description || "（説明なし）"}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <main class="wv-main">
        {!draft ? (
          <div class="wv-placeholder">
            <span class="wv-placeholder-icon">
              <Globe size={40} />
            </span>
            <p>左のリストから世界観を選ぶか、新しく作成してください。</p>
          </div>
        ) : (
          <section class="wv-panel">
            <header class="wv-panel-head">
              <div class="wv-panel-title">
                <Globe size={22} />
                <h2>{draft.name || "無題の世界"}</h2>
              </div>
              <div class="wv-panel-actions">
                <span class="wv-autosave-hint">変更は自動保存されます</span>
                <button class="wv-btn wv-btn-danger" type="button" onClick={handleDelete}>
                  <Trash2 size={16} />
                  削除
                </button>
              </div>
            </header>

            <div class="wv-field">
              <label class="wv-label">名前</label>
              <input
                class="wv-input"
                type="text"
                value={draft.name}
                onInput={(e) => updateDraft("name", inputValue(e))}
              />
            </div>

            <div class="wv-field">
              <div class="wv-field-head">
                <label class="wv-label">説明</label>
                <div class="wv-desc-actions">
                  {!draft.description.trim() && (
                    <button class="wv-btn wv-btn-sm wv-btn-tonal" type="button" onClick={handleInsertTemplate}>
                      <FileText size={14} />
                      テンプレートを挿入
                    </button>
                  )}
                  <button
                    class="wv-btn wv-btn-sm wv-btn-accent"
                    type="button"
                    onClick={() => void handleEnrich()}
                    disabled={enrichBusy}
                  >
                    {enrichBusy ? <span class="spinner" /> : <Sparkles size={14} />}
                    {enrichBusy ? "ふくらませ中..." : "AIでふくらませる"}
                  </button>
                </div>
              </div>
              <textarea
                class="wv-textarea"
                rows={16}
                placeholder="時代、場所、社会、雰囲気、ルールなど自由に記述してください"
                value={draft.description}
                onInput={(e) => updateDraft("description", inputValue(e))}
              />
              {enrichError && <p class="wv-status wv-status-error">{enrichError}</p>}
            </div>

            <div class="wv-field">
              <label class="wv-label wv-label-icon">
                <Users size={14} />
                所属キャラクター
              </label>
              {members.length === 0 ? (
                <div class="wv-empty-state wv-empty-state-inline">
                  <Users size={18} />
                  <p class="wv-empty wv-empty-inline">
                    この世界観を使うキャラクターはまだいません。キャラクター画面の「世界観」欄で選べます。
                  </p>
                </div>
              ) : (
                <div class="wv-members">
                  {members.map((c) => (
                    <div key={c.id} class="wv-member">
                      <CharacterAvatar character={c} size={48} />
                      <span class="wv-member-name">{c.sheet.name || "無名のキャラクター"}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

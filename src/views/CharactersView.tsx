import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  Plus,
  Trash2,
  Send,
  Sparkles,
  MessageCircle,
  Download,
  Upload,
  Gauge,
  Lightbulb,
  WandSparkles,
  Wand,
  Share2,
  Copy,
  Check,
} from "lucide-preact";
import type { Character, CharacterSheet, ChatMessage } from "../types";
import {
  createCharacter,
  deleteCharacter,
  getCharacter,
  listCharacters,
  saveCharacter,
  subscribeCharacters,
} from "../lib/characterStorage";
import {
  getPublishState,
  publishCharacter,
  shareLinkForCid,
  subscribePublished,
  unpublishCharacter,
  type PublishState,
} from "../lib/catalog";
import {
  CHARACTER_AXES,
  evaluateCharacterSheet,
  getLatestCharacterEvaluation,
  type CharacterEvaluationRecord,
} from "../lib/characterEvaluation";
import {
  buildCharacterExportFile,
  downloadCharacterExport,
  importExportedCharacters,
  importWorldSettings,
  parseCharacterImport,
} from "../lib/exportImport";
import { autoFillCharacterSheet, improveCharacterSheetField, sendInterviewMessage } from "../lib/growth";
import { MarkdownText } from "../lib/markdown";
import { emptyLlmConfig, loadLlmConfig, resolveVoice, subscribeLlmConfig, type SharedLlmConfigV1 } from "../lib/llmConfig";
import { OPENAI_TTS_VOICES, useVoiceOptions } from "../lib/voices";
import { listWorlds, subscribeWorlds, type WorldSetting } from "../lib/worlds";
import { CharacterAvatar } from "../components/CharacterAvatar";
import { AvatarPicker } from "../components/AvatarPicker";
import { OptionsPicker } from "./SettingsView";
import "../styles/characters.css";

/** Field-level CSS classes so {@link OptionsPicker} matches this view's cv-* form styling instead of the settings screen's tc-* one. */
const VOICE_PICKER_CLASS_NAMES = {
  row: "cv-model-row",
  input: "cv-input",
  select: "cv-input",
  iconBtn: "cv-icon-btn",
  footer: "cv-model-footer",
  status: "cv-model-status",
  linkBtn: "cv-link-btn",
};

interface SheetFieldDef {
  key: Exclude<keyof CharacterSheet, "name">;
  label: string;
  rows: number;
  placeholder: string;
}

const SHEET_FIELDS: SheetFieldDef[] = [
  { key: "summary", label: "ひとこと説明", rows: 2, placeholder: "一覧やピッカーに表示される短い紹介" },
  { key: "persona", label: "人物・背景", rows: 6, placeholder: "性格、価値観、生い立ちなど" },
  { key: "speechStyle", label: "話し方・口調", rows: 3, placeholder: "一人称、語尾、口癖、丁寧さなど" },
  { key: "likes", label: "好き・嫌い", rows: 3, placeholder: "好きなもの、苦手なもの、趣味" },
  { key: "relationships", label: "人間関係", rows: 3, placeholder: "他のキャラクターや人との関係" },
  { key: "notes", label: "メモ", rows: 3, placeholder: "成長インタビューで追記される自由メモ" },
];

interface InterviewMsg {
  role: "user" | "assistant";
  content: string;
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
}

// --- Publish-suggestion banner dismissal ------------------------------------
// Persisted as a JSON string array of character ids so a "あとで" dismissal
// (or a successful publish) hides the ひろば suggestion banner for that
// character permanently, even across reloads. Parsed defensively — same
// pattern as lib/appSettings.ts's loadAppSettings.
const PUBLISH_PROMPT_DISMISSED_KEY = "tc-town:publish-prompt-dismissed-v1";

function loadDismissedPublishPrompts(): string[] {
  try {
    const raw = localStorage.getItem(PUBLISH_PROMPT_DISMISSED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function markPublishPromptDismissed(characterId: string): void {
  const dismissed = loadDismissedPublishPrompts();
  if (dismissed.includes(characterId)) return;
  dismissed.push(characterId);
  localStorage.setItem(PUBLISH_PROMPT_DISMISSED_KEY, JSON.stringify(dismissed));
}

export function CharactersView() {
  const [characters, setCharacters] = useState<Character[]>(() => listCharacters());
  const [selectedId, setSelectedId] = useState<string | null>(() => listCharacters()[0]?.id ?? null);
  const [draft, setDraft] = useState<Character | null>(null);
  const [newName, setNewName] = useState("");

  const [interviewMsgs, setInterviewMsgs] = useState<InterviewMsg[]>([]);
  const [interviewInput, setInterviewInput] = useState("");
  const [interviewing, setInterviewing] = useState(false);
  const [interviewChoices, setInterviewChoices] = useState<string[] | null>(null);
  const [changedFields, setChangedFields] = useState<Set<string>>(new Set());
  const highlightTimer = useRef<number | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const interviewInputRef = useRef<HTMLTextAreaElement>(null);

  const [autoFillBusy, setAutoFillBusy] = useState(false);
  const [autoFillError, setAutoFillError] = useState<string | null>(null);
  const [improvingField, setImprovingField] = useState<SheetFieldDef["key"] | null>(null);
  const [improveError, setImproveError] = useState<string | null>(null);

  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const [publishState, setPublishState] = useState<PublishState | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  const [publishPromptDismissed, setPublishPromptDismissed] = useState(false);

  // Shared LLM config (providers/presets/tts) — subscribed so edits made from
  // the Settings screen (or another tik-choco app on this origin) are
  // reflected here without needing to leave and re-enter this view.
  const [llmConfig, setLlmConfig] = useState<SharedLlmConfigV1>(() => loadLlmConfig() ?? emptyLlmConfig());
  useEffect(() => subscribeLlmConfig((next) => setLlmConfig(next ?? emptyLlmConfig())), []);
  const presets = llmConfig.presets;
  const resolvedTts = useMemo(() => resolveVoice(llmConfig, "tts"), [llmConfig]);
  const ttsEndpoint = { baseUrl: resolvedTts?.baseUrl ?? "", apiKey: resolvedTts?.apiKey ?? "" };

  const [worlds, setWorlds] = useState<WorldSetting[]>(() => listWorlds());

  const [evalRecord, setEvalRecord] = useState<CharacterEvaluationRecord | null>(null);
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [sidebarScores, setSidebarScores] = useState<Record<string, number>>({});

  // Keep the sidebar list in sync with storage (this tab or another).
  useEffect(() => {
    const refresh = () => setCharacters(listCharacters());
    const unsubscribe = subscribeCharacters(refresh);
    refresh();
    return unsubscribe;
  }, []);

  // Keep the world picker in sync with the Worlds view (this tab or another).
  useEffect(() => {
    const refresh = () => setWorlds(listWorlds());
    const unsubscribe = subscribeWorlds(refresh);
    refresh();
    return unsubscribe;
  }, []);

  // Keep the sidebar's completeness badges in sync with whatever's been
  // evaluated so far (recomputed whenever the character set changes).
  useEffect(() => {
    const map: Record<string, number> = {};
    for (const c of characters) {
      const rec = getLatestCharacterEvaluation(c.id);
      if (rec) map[c.id] = rec.overallScore;
    }
    setSidebarScores(map);
  }, [characters]);

  // Keep the selected character's publish/share state in sync — with the
  // domain layer's own auto-republish-on-edit (see lib/catalog.ts), with
  // publish/unpublish actions from this view, and with other tabs.
  useEffect(() => {
    const refresh = () => setPublishState(selectedId ? getPublishState(selectedId) : null);
    refresh();
    const unsubscribe = subscribePublished(refresh);
    return unsubscribe;
  }, [selectedId]);

  useEffect(
    () => () => {
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  // --- Auto-save -------------------------------------------------------
  // User edits (updateSheet/updateTop) are persisted automatically after a
  // short debounce instead of via an explicit save button. `dirtyRef`
  // distinguishes user edits from programmatic draft loads (selection change,
  // import refresh, interview results — the interview flow already saves to
  // storage itself), so those never re-save or bump `updatedAt`.
  const draftRef = useRef<Character | null>(null);
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
    // Never persist a nameless character; stay dirty so the save happens as
    // soon as a name is typed again.
    if (!current.sheet.name.trim()) return;
    dirtyRef.current = false;
    saveCharacter(current);
    setCharacters(listCharacters());
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

  // Load a fresh editable draft whenever the selection changes, and reset the
  // interview panel to the new character.
  useEffect(() => {
    // Persist any still-debouncing edits to the previous character first.
    flushAutoSave();
    if (!selectedId) {
      setDraft(null);
      return;
    }
    const found = getCharacter(selectedId);
    setDraft(found ? structuredCloneCharacter(found) : null);
    setInterviewMsgs([]);
    setInterviewInput("");
    setInterviewChoices(null);
    setChangedFields(new Set());
    setEvalRecord(found ? getLatestCharacterEvaluation(found.id) : null);
    setEvalError(null);
    setEvalBusy(false);
    setAutoFillError(null);
    setImproveError(null);
    setPublishError(null);
    setLinkCopied(false);
    setPublishPromptDismissed(found ? loadDismissedPublishPrompts().includes(found.id) : false);
  }, [selectedId]);

  useEffect(() => {
    return () => {
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [interviewMsgs]);

  function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const character = createCharacter(name);
    setNewName("");
    setCharacters(listCharacters());
    setSelectedId(character.id);
  }

  function updateSheet(key: keyof CharacterSheet, value: string) {
    setDraft((prev) => (prev ? { ...prev, sheet: { ...prev.sheet, [key]: value } } : prev));
    scheduleAutoSave();
  }

  function updateTop<K extends keyof Character>(key: K, value: Character[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
    scheduleAutoSave();
  }

  function handleDelete() {
    if (!draft) return;
    const ok = window.confirm(`「${draft.sheet.name || "無名"}」を削除しますか？この操作は取り消せません。`);
    if (!ok) return;
    // Drop any pending auto-save so the deleted character can't be resurrected
    // by a debounced write firing after the delete.
    cancelAutoSave();
    deleteCharacter(draft.id);
    setSelectedId(null);
    setCharacters(listCharacters());
  }

  async function handleEvaluate() {
    if (!draft) return;
    flushAutoSave();
    setEvalBusy(true);
    setEvalError(null);
    try {
      const record = await evaluateCharacterSheet(draft);
      setEvalRecord(record);
      setSidebarScores((prev) => ({ ...prev, [draft.id]: record.overallScore }));
    } catch (error) {
      setEvalError(error instanceof Error ? error.message : String(error));
    } finally {
      setEvalBusy(false);
    }
  }

  async function handleAutoFill() {
    if (!draft || autoFillBusy) return;
    flushAutoSave();
    setAutoFillBusy(true);
    setAutoFillError(null);
    try {
      const result = await autoFillCharacterSheet(draft);
      if (result.changed.length > 0) {
        const finalSheet = result.character.sheet;
        const order = SHEET_FIELDS.map((f) => f.key).filter((k) => result.changed.includes(k));
        // Reveal fields one at a time (rather than all at once) so it reads
        // as the AI "filling them in", matching the interview's live feel —
        // the character is already saved in full, this only staggers the draft.
        for (let i = 0; i < order.length; i++) {
          if (i > 0) await new Promise((resolve) => window.setTimeout(resolve, 220));
          const key = order[i];
          setDraft((prev) => (prev ? { ...prev, sheet: { ...prev.sheet, [key]: finalSheet[key] } } : prev));
          flagChanged([key]);
        }
        setCharacters(listCharacters());
      }
    } catch (error) {
      setAutoFillError(error instanceof Error ? error.message : String(error));
    } finally {
      setAutoFillBusy(false);
    }
  }

  async function handleImproveField(field: SheetFieldDef["key"]) {
    if (!draft || improvingField) return;
    flushAutoSave();
    setImprovingField(field);
    setImproveError(null);
    try {
      const result = await improveCharacterSheetField(draft, field);
      if (result.changed.length > 0) {
        setDraft(structuredCloneCharacter(result.character));
        setCharacters(listCharacters());
        flagChanged(result.changed);
      }
    } catch (error) {
      setImproveError(error instanceof Error ? error.message : String(error));
    } finally {
      setImprovingField(null);
    }
  }

  async function handleExportCharacter() {
    if (!draft) return;
    setExportBusy(true);
    setExportError(null);
    try {
      const file = await buildCharacterExportFile(draft);
      downloadCharacterExport(file);
    } catch (error) {
      setExportError(`エクスポートに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExportBusy(false);
    }
  }

  // "非公開" -> unpublish; "unlisted"/"public" -> (re)publish with that
  // visibility. publishCharacter uploads the payload (+ VRM bytes, if any) to
  // P2P storage and can fail offline, so a failure reverts the selection back
  // to whatever was in effect before rather than leaving the UI showing a
  // state that was never actually applied.
  async function handlePublishChange(next: "private" | "unlisted" | "public") {
    if (!draft || publishBusy) return;
    // Persist pending edits first so what gets published matches the editor.
    flushAutoSave();
    const previous = publishState;
    setPublishBusy(true);
    setPublishError(null);
    try {
      if (next === "private") {
        await unpublishCharacter(draft.id);
        setPublishState(null);
      } else {
        const state = await publishCharacter(draft.id, next);
        setPublishState(state);
        // A successful publish (from either the share section or the
        // suggestion banner) hides the banner for this character for good —
        // even if it's later unpublished again.
        markPublishPromptDismissed(draft.id);
        setPublishPromptDismissed(true);
      }
    } catch (error) {
      setPublishError(`共有設定の変更に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      setPublishState(previous);
    } finally {
      setPublishBusy(false);
    }
  }

  function handleDismissPublishPrompt() {
    if (!draft) return;
    markPublishPromptDismissed(draft.id);
    setPublishPromptDismissed(true);
  }

  async function handleCopyShareLink() {
    if (!publishState) return;
    try {
      await navigator.clipboard.writeText(shareLinkForCid(publishState.cid));
      setLinkCopied(true);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setLinkCopied(false), 2000);
    } catch (error) {
      setPublishError(`リンクのコピーに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function handleImportFile(file: File) {
    // Persist pending edits first so they can't overwrite freshly imported data
    // when the debounce fires mid-import.
    flushAutoSave();
    setImportBusy(true);
    setImportStatus(null);
    setImportError(null);

    let imported;
    try {
      imported = parseCharacterImport(await file.text());
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
      setImportBusy(false);
      return;
    }

    try {
      // World settings first, so an imported character's worldId resolves immediately.
      importWorldSettings(imported.worlds);
      setWorlds(listWorlds());
      const result = await importExportedCharacters(imported.characters);
      setCharacters(listCharacters());

      // Keep the editor panel showing the freshest data. If nothing was
      // selected yet and this was a single-character file, select it.
      const firstId =
        imported.characters[0] && typeof imported.characters[0].id === "string" ? imported.characters[0].id : null;
      if (!selectedId && imported.characters.length === 1 && firstId) {
        setSelectedId(firstId);
      } else if (selectedId) {
        const refreshed = getCharacter(selectedId);
        setDraft(refreshed ? structuredCloneCharacter(refreshed) : null);
      }

      const skippedNote = result.skipped ? ` / スキップ ${result.skipped} 件` : "";
      const missingVrmNote = result.missingVrm
        ? ` / VRMモデル未所持のためアバターなし ${result.missingVrm} 件`
        : "";
      setImportStatus(`インポート完了: 追加 ${result.added} 件 / 更新 ${result.updated} 件${skippedNote}${missingVrmNote}`);
    } catch (error) {
      setImportError(`インポートに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setImportBusy(false);
    }
  }

  function flagChanged(keys: (keyof CharacterSheet)[]) {
    if (keys.length === 0) return;
    setChangedFields(new Set(keys as string[]));
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setChangedFields(new Set()), 2600);
  }

  async function runInterviewTurn(userText: string) {
    if (!draft || interviewing) return;
    const history: ChatMessage[] = interviewMsgs.map((m) => ({ role: m.role, content: m.content }));
    const withUser = userText ? [...interviewMsgs, { role: "user" as const, content: userText }] : interviewMsgs;
    setInterviewMsgs([...withUser, { role: "assistant", content: "" }]);
    setInterviewInput("");
    setInterviewChoices(null);
    setInterviewing(true);

    const setLastAssistant = (content: string) =>
      setInterviewMsgs((prev) => {
        if (prev.length === 0) return prev;
        const next = prev.slice();
        next[next.length - 1] = { role: "assistant", content };
        return next;
      });

    try {
      const result = await sendInterviewMessage(draft, history, userText, {
        onDelta: (cleaned) => setLastAssistant(cleaned || "…"),
      });
      setLastAssistant(result.reply || "（無言）");
      if (result.changed.length > 0) {
        setDraft(structuredCloneCharacter(result.character));
        setCharacters(listCharacters());
        flagChanged(result.changed);
      }
      setInterviewChoices(result.choices);
    } catch (error) {
      setLastAssistant(`エラーが発生しました: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setInterviewing(false);
    }
  }

  function handleChoiceSelect(choice: string) {
    setInterviewChoices(null);
    void runInterviewTurn(choice);
  }

  function handleChoiceOther() {
    setInterviewChoices(null);
    interviewInputRef.current?.focus();
  }

  function handleInterviewSend() {
    const text = interviewInput.trim();
    if (!text) return;
    void runInterviewTurn(text);
  }

  const sheetHasContent = draft ? SHEET_FIELDS.some((f) => draft.sheet[f.key].trim() !== "") : false;

  // Gentle nudge toward publishing once a character actually has something to
  // show: a name and a persona, not yet published, and not dismissed before.
  const showPublishPrompt =
    !!draft &&
    draft.sheet.name.trim() !== "" &&
    draft.sheet.persona.trim() !== "" &&
    !publishState &&
    !publishPromptDismissed;

  return (
    <div class="cv-root">
      <aside class="cv-sidebar">
        <div class="cv-create">
          <input
            class="cv-input"
            type="text"
            placeholder="新しいキャラクター名"
            value={newName}
            onInput={(e) => setNewName(inputValue(e))}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
          />
          <button class="cv-btn cv-btn-accent" type="button" onClick={handleCreate} disabled={!newName.trim()}>
            <Plus size={16} />
            作成
          </button>
        </div>

        <div class="cv-import-row">
          <button
            class="cv-btn"
            type="button"
            onClick={() => importFileInputRef.current?.click()}
            disabled={importBusy}
          >
            <Upload size={16} />
            {importBusy ? "読み込み中..." : "インポート"}
          </button>
          <input
            ref={importFileInputRef}
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) void handleImportFile(file);
            }}
          />
        </div>
        {importStatus && <p class="cv-status">{importStatus}</p>}
        {importError && <p class="cv-status cv-status-error">{importError}</p>}

        <div class="cv-list">
          {characters.length === 0 ? (
            <div class="cv-empty-state">
              <Sparkles size={24} />
              <p class="cv-empty">まだキャラクターがいません。名前を入力して作成しましょう。</p>
            </div>
          ) : (
            characters.map((c) => (
              <button
                key={c.id}
                type="button"
                class={"cv-list-item" + (c.id === selectedId ? " is-active" : "")}
                onClick={() => setSelectedId(c.id)}
              >
                <CharacterAvatar character={c} size={40} />
                <span class="cv-list-meta">
                  <span class="cv-list-name">{c.sheet.name || "無名"}</span>
                  <span class="cv-list-summary">{c.sheet.summary || "（説明なし）"}</span>
                </span>
                {sidebarScores[c.id] !== undefined && (
                  <span class="cv-eval-badge" title="キャラ完成度スコア">
                    {sidebarScores[c.id]}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </aside>

      <main class="cv-main">
        {!draft ? (
          <div class="cv-placeholder">
            <span class="cv-placeholder-icon">
              <MessageCircle size={40} />
            </span>
            <p>左のリストからキャラクターを選ぶか、新しく作成してください。</p>
          </div>
        ) : (
          <div class="cv-editor-grid">
            <section class="cv-panel cv-sheet">
              <header class="cv-panel-head">
                <div class="cv-panel-title">
                  <CharacterAvatar character={draft} size={48} />
                  <h2>{draft.sheet.name || "無名"}</h2>
                </div>
                <div class="cv-panel-actions">
                  <span class="cv-autosave-hint">変更は自動保存されます</span>
                  <button
                    class="cv-btn cv-btn-tonal"
                    type="button"
                    onClick={() => void handleAutoFill()}
                    disabled={autoFillBusy || !draft.sheet.name.trim()}
                    title={
                      sheetHasContent
                        ? "AIが今の内容を土台により魅力的に書き直します"
                        : "AIがキャラクターシートを自動で作成します"
                    }
                  >
                    <WandSparkles size={16} />
                    {autoFillBusy ? "作成中..." : sheetHasContent ? "お任せで改善" : "お任せで作成"}
                  </button>
                  <button
                    class="cv-btn cv-btn-tonal"
                    type="button"
                    onClick={() => void handleExportCharacter()}
                    disabled={exportBusy}
                  >
                    <Download size={16} />
                    {exportBusy ? "書き出し中..." : "エクスポート"}
                  </button>
                  <button class="cv-btn cv-btn-danger" type="button" onClick={handleDelete}>
                    <Trash2 size={16} />
                    削除
                  </button>
                </div>
              </header>
              {exportError && <p class="cv-status cv-status-error">{exportError}</p>}
              {autoFillError && <p class="cv-status cv-status-error">お任せ作成に失敗しました: {autoFillError}</p>}
              {improveError && <p class="cv-status cv-status-error">項目の改善に失敗しました: {improveError}</p>}

              {showPublishPrompt && (
                <div class="cv-publish-banner">
                  <p class="cv-publish-banner-text">キャラができたら、ひろばに公開してみませんか？</p>
                  <div class="cv-publish-banner-actions">
                    <button
                      class="cv-btn cv-btn-accent"
                      type="button"
                      onClick={() => void handlePublishChange("public")}
                      disabled={publishBusy}
                    >
                      {publishBusy ? <span class="spinner" /> : <Share2 size={14} />}
                      ひろばに公開
                    </button>
                    <button
                      class="cv-link-btn"
                      type="button"
                      onClick={handleDismissPublishPrompt}
                      disabled={publishBusy}
                    >
                      あとで
                    </button>
                  </div>
                </div>
              )}

              <div class="cv-share-section">
                <div class="cv-share-head">
                  <span class="cv-label cv-label-icon">
                    <Share2 size={14} />
                    共有
                  </span>
                  {publishBusy && <span class="spinner" />}
                </div>

                {!publishState ? (
                  <div class="cv-share-actions">
                    <button
                      class="cv-btn cv-btn-accent"
                      type="button"
                      onClick={() => void handlePublishChange("public")}
                      disabled={publishBusy}
                    >
                      <Share2 size={16} />
                      ひろばに公開
                    </button>
                    <button
                      class="cv-link-btn"
                      type="button"
                      onClick={() => void handlePublishChange("unlisted")}
                      disabled={publishBusy}
                    >
                      リンク限定で共有
                    </button>
                  </div>
                ) : (
                  <div class="cv-share-published">
                    <span class="cv-share-chip">
                      {publishState.visibility === "public" ? "ひろばに公開中" : "リンク限定で共有中"}
                    </span>
                    <div class="cv-share-link-row">
                      <input
                        class="cv-input cv-share-link-input"
                        type="text"
                        readOnly
                        value={shareLinkForCid(publishState.cid)}
                      />
                      <button class="cv-btn cv-btn-tonal" type="button" onClick={() => void handleCopyShareLink()}>
                        {linkCopied ? <Check size={14} /> : <Copy size={14} />}
                        {linkCopied ? "コピー済み" : "コピー"}
                      </button>
                    </div>
                    <div class="cv-share-actions cv-share-actions-secondary">
                      {publishState.visibility === "public" ? (
                        <>
                          <button
                            class="cv-link-btn"
                            type="button"
                            onClick={() => void handlePublishChange("unlisted")}
                            disabled={publishBusy}
                          >
                            リンク限定にする
                          </button>
                          <button
                            class="cv-link-btn cv-link-btn-danger"
                            type="button"
                            onClick={() => void handlePublishChange("private")}
                            disabled={publishBusy}
                          >
                            公開をやめる
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            class="cv-link-btn"
                            type="button"
                            onClick={() => void handlePublishChange("public")}
                            disabled={publishBusy}
                          >
                            ひろばに公開
                          </button>
                          <button
                            class="cv-link-btn cv-link-btn-danger"
                            type="button"
                            onClick={() => void handlePublishChange("private")}
                            disabled={publishBusy}
                          >
                            共有をやめる
                          </button>
                        </>
                      )}
                    </div>
                    <p class="cv-share-updated">
                      最終公開: {new Date(publishState.updatedAt).toLocaleString("ja-JP")}
                    </p>
                  </div>
                )}
                {publishError && <p class="cv-status cv-status-error">{publishError}</p>}
              </div>

              <div class="cv-field">
                <label class="cv-label">アバター</label>
                <AvatarPicker avatar={draft.avatar} onChange={(avatar) => updateTop("avatar", avatar)} />
              </div>

              <div class="cv-field">
                <label class="cv-label">名前</label>
                <input
                  class="cv-input"
                  type="text"
                  value={draft.sheet.name}
                  onInput={(e) => updateSheet("name", inputValue(e))}
                />
              </div>

              {SHEET_FIELDS.map((field) => (
                <div class="cv-field" key={field.key}>
                  <label class="cv-label">
                    {field.label}
                    {changedFields.has(field.key) && <span class="cv-changed-badge">更新</span>}
                    <button
                      type="button"
                      class={"cv-field-improve-btn" + (improvingField === field.key ? " loading" : "")}
                      onClick={() => void handleImproveField(field.key)}
                      disabled={improvingField !== null || !draft.sheet.name.trim()}
                      title={`「${field.label}」をAIでより良くする`}
                    >
                      <Wand size={13} />
                    </button>
                  </label>
                  <textarea
                    class={"cv-textarea" + (changedFields.has(field.key) ? " is-changed" : "")}
                    rows={field.rows}
                    placeholder={field.placeholder}
                    value={draft.sheet[field.key]}
                    onInput={(e) => updateSheet(field.key, inputValue(e))}
                  />
                </div>
              ))}

              <div class="cv-field-row">
                <div class="cv-field">
                  <label class="cv-label">LLMプリセット</label>
                  <select
                    class="cv-input"
                    value={draft.llmProfileId}
                    onChange={(e) => updateTop("llmProfileId", inputValue(e))}
                  >
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                    {!presets.some((p) => p.id === draft.llmProfileId) && (
                      <option value={draft.llmProfileId}>{draft.llmProfileId}（不明）</option>
                    )}
                  </select>
                </div>
                <div class="cv-field">
                  <label class="cv-label">世界観</label>
                  <select
                    class="cv-input"
                    value={draft.worldId ?? ""}
                    onChange={(e) => updateTop("worldId", inputValue(e) || undefined)}
                  >
                    <option value="">なし</option>
                    {worlds.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name || "無題の世界"}
                      </option>
                    ))}
                    {draft.worldId && !worlds.some((w) => w.id === draft.worldId) && (
                      <option value={draft.worldId}>（不明）</option>
                    )}
                  </select>
                </div>
                <div class="cv-field">
                  <label class="cv-label">音声（ボイス名）</label>
                  <OptionsPicker
                    value={draft.voiceName ?? ""}
                    placeholder="例: alloy"
                    baseUrl={ttsEndpoint.baseUrl}
                    apiKey={ttsEndpoint.apiKey}
                    onChange={(voice) => updateTop("voiceName", voice || undefined)}
                    useOptions={useVoiceOptions}
                    itemLabel="音声"
                    emptyOption={{ label: "デフォルト", alwaysShow: true }}
                    fallbackOptions={OPENAI_TTS_VOICES}
                    classNames={VOICE_PICKER_CLASS_NAMES}
                  />
                </div>
                <div class="cv-field">
                  <label class="cv-label">音声モデル</label>
                  <input
                    class="cv-input"
                    type="text"
                    placeholder="例: tts-1"
                    value={draft.voiceModel ?? ""}
                    onInput={(e) => updateTop("voiceModel", inputValue(e) || undefined)}
                  />
                </div>
              </div>

              <div class="cv-eval-section">
                <div class="cv-eval-head">
                  <div class="cv-panel-title">
                    <Gauge size={18} />
                    <h3>キャラ完成度</h3>
                  </div>
                  <button
                    class="cv-btn cv-btn-accent"
                    type="button"
                    onClick={() => void handleEvaluate()}
                    disabled={evalBusy || !draft.sheet.name.trim()}
                  >
                    <Gauge size={16} />
                    {evalBusy ? "評価中..." : "評価する"}
                  </button>
                </div>

                {evalError && <p class="cv-status cv-status-error">評価に失敗しました: {evalError}</p>}

                {evalRecord ? (
                  <div class="cv-eval-result">
                    <div class="cv-eval-summary">
                      <div class="cv-eval-score">
                        <span class="cv-eval-score-num">{evalRecord.overallScore}</span>
                        <span class="cv-eval-score-max"> / 100</span>
                      </div>
                      <span class="cv-eval-time">
                        {new Date(evalRecord.evaluatedAt).toLocaleString("ja-JP")} 評価
                      </span>
                    </div>

                    <div class="cv-eval-fillrate">
                      <span class="cv-eval-fillrate-label">記入率</span>
                      <div class="cv-eval-bar-track">
                        <div class="cv-eval-bar-fill" style={{ width: `${evalRecord.fillRate}%` }} />
                      </div>
                      <span class="cv-eval-fillrate-value">{evalRecord.fillRate}%</span>
                    </div>

                    <ul class="cv-eval-axes">
                      {CHARACTER_AXES.map((axis) => {
                        const score = evalRecord.scores[axis.key] ?? 0;
                        return (
                          <li key={axis.key} class="cv-eval-axis-row" title={axis.rubric}>
                            <span class="cv-eval-axis-label">{axis.label}</span>
                            <div class="cv-eval-bar-track cv-eval-bar-track-axis">
                              <div class="cv-eval-bar-fill" style={{ width: `${(score / 5) * 100}%` }} />
                            </div>
                            <span class="cv-eval-axis-score">{score > 0 ? `${score}/5` : "—"}</span>
                          </li>
                        );
                      })}
                    </ul>

                    {evalRecord.suggestions.length > 0 && (
                      <div class="cv-eval-suggestions">
                        <div class="cv-eval-suggestions-title">
                          <Lightbulb size={14} />
                          改善提案
                        </div>
                        <ul>
                          {evalRecord.suggestions.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {evalRecord.notes && <p class="cv-eval-notes">{evalRecord.notes}</p>}
                  </div>
                ) : (
                  !evalBusy && (
                    <div class="cv-empty-state cv-empty-state-inline">
                      <Gauge size={20} />
                      <p class="cv-empty">まだ評価がありません。「評価する」を押してください。</p>
                    </div>
                  )
                )}
              </div>
            </section>

            <section class="cv-panel cv-interview">
              <header class="cv-panel-head">
                <div class="cv-panel-title">
                  <Sparkles size={18} />
                  <h2>成長インタビュー</h2>
                </div>
              </header>
              <p class="cv-interview-hint">
                インタビュアーAIと会話すると、その内容からキャラクターシートが自動で更新されます。
              </p>

              <div class="cv-chat" ref={scrollRef}>
                {interviewMsgs.length === 0 ? (
                  <div class="cv-chat-empty">
                    <button
                      class="cv-btn cv-btn-accent"
                      type="button"
                      onClick={() => void runInterviewTurn("")}
                      disabled={interviewing}
                    >
                      <MessageCircle size={16} />
                      インタビューを始める
                    </button>
                  </div>
                ) : (
                  interviewMsgs.map((m, i) => (
                    <div key={i} class={"cv-bubble cv-bubble-" + m.role}>
                      {m.content ? (
                        <MarkdownText text={m.content} />
                      ) : interviewing && i === interviewMsgs.length - 1 ? (
                        "…"
                      ) : (
                        ""
                      )}
                    </div>
                  ))
                )}
              </div>

              {interviewChoices && interviewChoices.length > 0 && !interviewing && (
                <div class="cv-choice-row">
                  {interviewChoices.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      class="cv-choice-btn"
                      onClick={() => handleChoiceSelect(choice)}
                    >
                      {choice}
                    </button>
                  ))}
                  <button type="button" class="cv-choice-btn cv-choice-btn-other" onClick={handleChoiceOther}>
                    その他（自由入力）
                  </button>
                </div>
              )}

              <div class="cv-chat-input">
                <textarea
                  ref={interviewInputRef}
                  class="cv-textarea"
                  rows={2}
                  placeholder="回答を入力（Enterで送信 / Shift+Enterで改行）"
                  value={interviewInput}
                  disabled={interviewing}
                  onInput={(e) => setInterviewInput(inputValue(e))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleInterviewSend();
                    }
                  }}
                />
                <button
                  class="cv-btn cv-btn-accent"
                  type="button"
                  onClick={handleInterviewSend}
                  disabled={interviewing || !interviewInput.trim()}
                >
                  <Send size={16} />
                  送信
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

/** Deep-ish clone so edits to the draft never mutate the stored object. */
function structuredCloneCharacter(character: Character): Character {
  return { ...character, sheet: { ...character.sheet }, avatar: character.avatar ? { ...character.avatar } : null };
}

// Settings screen: AI接続 (LLM connections/presets), AI Network (room/
// consumer/provider controls), タスク (per-feature model assignment + TTS/
// STT/character-expression), and app appearance (theme/language).
// Self-contained — the integration wave mounts <SettingsView /> behind the
// shell's "設定" nav. Persistence is immediate: every committed edit writes
// through to localStorage (via saveProviderSettings / saveLlmConfig) so
// nothing is lost on navigation.
//
// UI shape follows the tik-choco family's shared "AI接続 / AI Network /
// タスク" settings layout (tc-docs/drafts/llm-settings-common-v1.md,
// reference implementation: tc-translate's SettingsModal.tsx): a flat
// card-grid for connections/presets, role cards for the network toggles, and
// tooltip (`data-tip`) descriptions on タスク row labels instead of
// permanent hint paragraphs. tc-town keeps its pre-existing 表示/はじめに
// tabs alongside the three shared tabs — those aren't part of the shared
// spec but there's no reason to fold them in.
//
// Sections are presented as tabs (see SETTINGS_TABS below) — the tab picks
// which panel renders in JSX only. All stateful hooks (settings, the AI
// Network consumer/provider lifecycle) stay unconditional at the top of
// SettingsView so switching tabs never resets a connection or drops
// in-flight state. The active tab itself is remembered in localStorage so
// re-opening Settings returns to where the user left off.
//
// Divergences from the tc-translate reference (tc-town has no
// mist-network:// pseudo-provider / oai tunnel / per-model network sharing —
// see lib/network.ts's header comment for what @tik-choco/mistai's
// useNetworkProvider actually gives this app):
//  - No "Network由来" preset badge, no `isNetworkProviderBaseUrl` guard, no
//    共有モデルチェックリスト: tc-town's provider role always shares exactly
//    the resolved default preset (advertisedModels is never passed to
//    useNetworkProvider), so there is nothing per-model to toggle. The
//    provider role card shows which preset is shared as read-only text.
//  - reasoning_effort stays a property of the PRESET itself
//    (ModelPresetV1.reasoningEffort, used by every caller of
//    requestChatCompletion — characters, growth, evaluation, plaza, emotion
//    classifier), not a separate per-task local field. The 既定 task row
//    edits the *currently selected default preset's* reasoningEffort rather
//    than an independent setting, since tc-town has exactly one
//    settings-level LLM task (character-level preset overrides remain in
//    CharactersView, out of scope here).
//  - Inline edit rows commit each field on blur/select-change but only close
//    via outside-click/Escape (not "select also closes the row") — avoids
//    relying on OptionsPicker's manual-entry mode (which commits per
//    keystroke, unlike tc-translate's bespoke picker) to decide when a row
//    should auto-close.
//
// There used to be a manual "backup" tab here (export/import a full JSON
// bundle by hand). It's gone — the same bundle is now auto-published to
// tc-storage's drive via the shared bus (lib/townBackupPublisher.ts, topic
// "town-backup"), started once in main.tsx. A full bundle file is still
// importable via the Characters screen's importer (lib/exportImport.ts's
// parseCharacterImport accepts both a single-character file and a full
// bundle) — that remains the restore path.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  Cpu,
  Network,
  Palette,
  Plus,
  Radio,
  RefreshCw,
  Server,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-preact";
import { MESSAGES_JA } from "@tik-choco/mistai";
import { ConsumerStatusIndicator, ProviderStatusPanel } from "@tik-choco/mistai/preact";
import "@tik-choco/mistai/ui.css";
import { useAppSettings } from "../hooks/useAppSettings";
import { requestOnboarding } from "../lib/onboarding";
import {
  DEFAULT_REASONING_EFFORT,
  EXPRESSION_MODES,
  loadProviderSettings,
  REASONING_EFFORT_OPTIONS,
  saveProviderSettings,
  type ExpressionMode,
  type ProviderSettings,
} from "../lib/llmSettings";
import {
  getExpressionFeatureStatus,
  subscribeExpressionFeatureStatus,
  type ExpressionFeatureStatus,
} from "../lib/emotionClassifier";
import {
  emptyLlmConfig,
  loadLlmConfig,
  resolvePreset,
  saveLlmConfig,
  subscribeLlmConfig,
  type LlmProviderV1,
  type ModelPresetV1,
  type SharedLlmConfigV1,
  type VoiceConfigV1,
} from "../lib/llmConfig";
import {
  createPreset,
  createProvider,
  deletePreset,
  deleteProvider,
  patchPreset,
  patchProvider,
} from "../lib/llmConfigEdit";
import { useModelOptions, type ModelOptionsState } from "../lib/models";
import { OPENAI_TTS_VOICES, useVoiceOptions } from "../lib/voices";
import {
  connectNetworkConsumer,
  consumerStatus,
  createMistNode,
  disconnectNetworkConsumer,
  NODE_ID_STORAGE_KEY,
  onConsumerStatusChange,
  useNetworkProvider,
  type ConsumerStatus,
} from "../lib/network";
import { requestApiChatCompletionStreaming } from "../lib/llm";
import "../styles/settings.css";
import "../styles/settings-llm.css";

export interface OptionsPickerClassNames {
  row: string;
  input: string;
  select: string;
  iconBtn: string;
  footer: string;
  status: string;
  linkBtn: string;
}

const DEFAULT_OPTIONS_PICKER_CLASS_NAMES: OptionsPickerClassNames = {
  row: "tc-model-row",
  input: "",
  select: "",
  iconBtn: "tc-icon-btn",
  footer: "tc-model-footer",
  status: "tc-model-status",
  linkBtn: "tc-link-btn",
};

/**
 * Generic picker for a value listed by an OpenAI-compatible endpoint: a
 * <select> populated from `useOptions(baseUrl, apiKey)`, a refresh button,
 * and a "手入力" (manual entry) fallback toggle for when the endpoint can't
 * list values or the saved value isn't in the fetched list. The
 * currently-saved value is always kept selectable, even if it never showed
 * up in a fetch. `fallbackOptions` (if given) are shown in the select
 * whenever the fetch hasn't produced any options yet (idle/loading/error),
 * so the field never renders empty.
 *
 * Exported so both the model fields (LLM connection/preset cards, TTS/STT)
 * and the TTS voice field share one implementation — callers own the
 * surrounding label/field markup and CSS classes so this works with
 * tc-town's differently-styled settings and character-editor forms.
 */
export function OptionsPicker(props: {
  value: string;
  placeholder: string;
  baseUrl: string;
  apiKey: string;
  onChange: (value: string) => void;
  useOptions: (baseUrl: string, apiKey: string) => ModelOptionsState;
  itemLabel: string;
  emptyOption?: { label: string; alwaysShow?: boolean };
  fallbackOptions?: string[];
  classNames?: Partial<OptionsPickerClassNames>;
}) {
  const {
    value,
    placeholder,
    baseUrl,
    apiKey,
    onChange,
    useOptions,
    itemLabel,
    emptyOption,
    fallbackOptions = [],
    classNames,
  } = props;
  const cls = { ...DEFAULT_OPTIONS_PICKER_CLASS_NAMES, ...classNames };
  const { options, status, errorMessage, refresh } = useOptions(baseUrl, apiKey);
  const [manualEntry, setManualEntry] = useState(false);

  const fetchedOrFallback = options.length > 0 ? options : fallbackOptions;
  const selectableOptions = useMemo(() => {
    const merged = value.trim() ? [value, ...fetchedOrFallback] : fetchedOrFallback;
    return [...new Set(merged)].sort((left, right) => left.localeCompare(right));
  }, [fetchedOrFallback, value]);

  const canFetch = baseUrl.trim().length > 0;
  const showEmptyOption = emptyOption && (emptyOption.alwaysShow || value.trim() === "");

  return (
    <>
      {manualEntry ? (
        <input
          class={cls.input}
          value={value}
          placeholder={placeholder}
          onInput={(e) => onChange(e.currentTarget.value)}
        />
      ) : (
        <div class={cls.row}>
          <select class={cls.select} value={value} onChange={(e) => onChange(e.currentTarget.value)}>
            {showEmptyOption ? <option value="">{emptyOption!.label}</option> : null}
            {selectableOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <button
            type="button"
            class={`${cls.iconBtn}${status === "loading" ? " loading" : ""}`}
            onClick={refresh}
            disabled={status === "loading" || !canFetch}
            title={`${itemLabel}一覧を更新`}
            aria-label={`${itemLabel}一覧を更新`}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      )}
      <div class={cls.footer}>
        <span class={cls.status}>
          {status === "loading"
            ? `${itemLabel}一覧を取得中...`
            : status === "error"
              ? errorMessage || `${itemLabel}一覧の取得に失敗しました。手入力で指定できます。`
              : status === "done"
                ? `${options.length} 件の${itemLabel}を取得しました。`
                : ""}
        </span>
        <button type="button" class={cls.linkBtn} onClick={() => setManualEntry((prev) => !prev)}>
          {manualEntry ? "一覧から選択" : "手入力"}
        </button>
      </div>
    </>
  );
}

const THEME_OPTIONS: Array<{ value: "light" | "dark" | "system"; label: string }> = [
  { value: "light", label: "ライト" },
  { value: "dark", label: "ダーク" },
  { value: "system", label: "システム" },
];

const LANGUAGE_OPTIONS: Array<{ value: "ja" | "en"; label: string }> = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
];

// ----- Expression auto-switching (lib/emotionClassifier.ts) --------------

const EXPRESSION_MODE_LABELS: Record<ExpressionMode, string> = {
  auto: "自動",
  on: "オン",
  off: "オフ",
};

function expressionStatusLabel(status: ExpressionFeatureStatus): string {
  if (status.mode === "off") return "オフ";
  if (status.mode === "auto" && status.autoDisabled) return "応答が遅いため自動オフ中";
  return "有効";
}

// ----- Settings tabs -----------------------------------------------------
// 表示/はじめに are tc-town-local; connection/network/tasks follow the
// shared family layout (AI接続 / AI Network / タスク — see file header).
// Tab selection is remembered across visits (localStorage, parsed
// defensively — same pattern as appSettings.ts / llmSettings.ts). An old
// stored id from before this redesign ("llm"/"voice") simply isn't in
// SETTINGS_TABS any more, so loadSettingsTab's membership check falls back
// to "appearance" — no migration needed.

type SettingsTabId = "appearance" | "connection" | "network" | "tasks" | "onboarding";

const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string; icon: typeof Palette }> = [
  { id: "appearance", label: "表示", icon: Palette },
  { id: "connection", label: "AI接続", icon: Cpu },
  { id: "network", label: "AI Network", icon: Network },
  { id: "tasks", label: "タスク", icon: SlidersHorizontal },
  { id: "onboarding", label: "はじめに", icon: Sparkles },
];

const SETTINGS_TAB_STORAGE_KEY = "tc-town:settings-tab";

function loadSettingsTab(): SettingsTabId {
  try {
    const raw = localStorage.getItem(SETTINGS_TAB_STORAGE_KEY);
    if (raw && SETTINGS_TABS.some((tab) => tab.id === raw)) return raw as SettingsTabId;
  } catch {
    // localStorage unavailable (private mode, etc.) — fall back to default.
  }
  return "appearance";
}

function saveSettingsTab(tab: SettingsTabId): void {
  try {
    localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, tab);
  } catch {
    // Non-fatal — the tab just won't be remembered next visit.
  }
}

export function SettingsView() {
  const { theme, setTheme, language, setLanguage } = useAppSettings();

  // Active tab is pure UI state (which panel is visible) — it must not gate
  // any of the hooks below, so the AI Network connection and provider
  // lifecycle keep running even while another tab is showing.
  const [activeTab, setActiveTabState] = useState<SettingsTabId>(() => loadSettingsTab());
  function setActiveTab(tab: SettingsTabId): void {
    setActiveTabState(tab);
    saveSettingsTab(tab);
  }

  const [settings, setSettings] = useState<ProviderSettings>(() => loadProviderSettings());

  // Immediate persistence: mirror every change into localStorage.
  function update(next: ProviderSettings): void {
    setSettings(next);
    saveProviderSettings(next);
  }

  // ----- Expression auto-switching status (live, updates as samples land) --
  const [expressionStatus, setExpressionStatus] = useState<ExpressionFeatureStatus>(() =>
    getExpressionFeatureStatus(),
  );
  useEffect(() => subscribeExpressionFeatureStatus(() => setExpressionStatus(getExpressionFeatureStatus())), []);

  /** Mode changes don't go through emotionClassifier's own notifyListeners (that only fires on classification activity), so refresh the status snapshot here too. */
  function updateExpressionMode(mode: ExpressionMode): void {
    update({ ...settings, expressionMode: mode });
    setExpressionStatus(getExpressionFeatureStatus());
  }

  // ----- Shared LLM config (tc-shared-llm-config-v1) ------------------------
  // Providers (connections) and presets (named model configs) live here,
  // co-owned across the whole tik-choco app family — see lib/llmConfig.ts.
  const [cfg, setCfg] = useState<SharedLlmConfigV1>(() => loadLlmConfig() ?? emptyLlmConfig());
  // Latest cfg for the provider hook's upstream callback, so in-flight
  // network requests always see current values without re-joining the room.
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  function updateCfg(next: SharedLlmConfigV1): void {
    setCfg(next);
    saveLlmConfig(next);
  }

  /** Runs a llmConfigEdit.ts mutator (createProvider/patchPreset/deletePreset/...) against a clone of the current config and persists the result. */
  function mutateCfg(mutator: (config: SharedLlmConfigV1) => void): void {
    const next = structuredClone(cfg);
    mutator(next);
    updateCfg(next);
  }

  // Reflect edits made by another app (or another tab of this app) sharing
  // the same origin — e.g. a provider/preset added from tc-news's settings.
  useEffect(() => subscribeLlmConfig((next) => setCfg(next ?? emptyLlmConfig())), []);

  const defaultPreset = cfg.presets.find((p) => p.id === cfg.defaultPresetId);

  function getProviderLabel(providerId: string): string {
    const provider = cfg.providers.find((p) => p.id === providerId);
    if (!provider) return "接続不明";
    return provider.label || provider.baseUrl;
  }

  function providerFor(providerId: string): LlmProviderV1 | undefined {
    return cfg.providers.find((p) => p.id === providerId);
  }

  /** 既定 / 共有中 badges shown on a preset card. No "Network由来" badge — tc-town has no mist-network:// pseudo-provider (see file header). */
  function getPresetBadges(preset: ModelPresetV1): string[] {
    const badges: string[] = [];
    if (cfg.defaultPresetId === preset.id) badges.push("既定");
    if (settings.networkProviderEnabled && cfg.defaultPresetId === preset.id) badges.push("共有中");
    return badges;
  }

  function updateVoice(kind: "tts" | "stt", patch: Partial<VoiceConfigV1>): void {
    const current: VoiceConfigV1 = cfg[kind] ?? { model: "" };
    updateCfg({ ...cfg, [kind]: { ...current, ...patch } });
  }

  /** Resolves the connection (baseUrl/apiKey) a TTS/STT voice field should fetch voices against: the voice's own provider, or (when omitted) the default preset's provider. */
  function connectionForVoice(voice: VoiceConfigV1 | undefined): LlmProviderV1 | undefined {
    if (voice?.providerId) return cfg.providers.find((p) => p.id === voice.providerId);
    const target = resolvePreset(cfg);
    return target ? cfg.providers.find((p) => p.id === target.providerId) : undefined;
  }

  const ttsProvider = connectionForVoice(cfg.tts);

  // --- AI接続 tab: inline edit/add row state --------------------------------
  // At most one row (provider edit/add, preset edit/add) is open at a time.
  // Text fields commit on blur (so a half-typed label never briefly appears
  // in another app's picker mid-keystroke); provider/model selects commit
  // immediately on change. Rows close only via outside-click or Escape — see
  // file header for why this differs from tc-translate's "model select also
  // closes the row".
  const [editingProviderId, setEditingProviderId] = useState("");
  const [providerDraft, setProviderDraft] = useState({ label: "", baseUrl: "", apiKey: "" });
  const [addingProvider, setAddingProvider] = useState(false);
  const [npLabel, setNpLabel] = useState("");
  const [npBaseUrl, setNpBaseUrl] = useState("");
  const [npApiKey, setNpApiKey] = useState("");

  const [editingPresetId, setEditingPresetId] = useState("");
  const [presetDraft, setPresetDraft] = useState({ label: "", temperature: "0.7" });
  const [addingPreset, setAddingPreset] = useState(false);
  const [amLabel, setAmLabel] = useState("");
  const [amProviderId, setAmProviderId] = useState("");
  const [amModel, setAmModel] = useState("");

  function closeAllInlineRows(): void {
    setEditingProviderId("");
    setAddingProvider(false);
    setEditingPresetId("");
    setAddingPreset(false);
  }

  // If the entity currently being edited disappears (e.g. removed from
  // another tab/app via the shared config), close its inline row instead of
  // leaving it editing a value that no longer exists.
  useEffect(() => {
    if (editingProviderId && !cfg.providers.some((p) => p.id === editingProviderId)) setEditingProviderId("");
    if (editingPresetId && !cfg.presets.some((p) => p.id === editingPresetId)) setEditingPresetId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.providers, cfg.presets]);

  // No explicit "close" button on edit rows — outside click / Escape closes
  // whichever row is open. See tc-translate's SettingsModal for the same
  // mousedown-before-click guard (a text-selection drag that ends outside
  // the row must not be read as "clicked outside").
  const activeRowRef = useRef<HTMLDivElement | null>(null);
  const mouseDownInsideRef = useRef(false);
  useEffect(() => {
    if (!editingProviderId && !addingProvider && !editingPresetId && !addingPreset) return undefined;

    function handleDocumentMouseDown(event: MouseEvent): void {
      mouseDownInsideRef.current = Boolean(activeRowRef.current && activeRowRef.current.contains(event.target as Node));
    }
    function handleDocumentClick(event: MouseEvent): void {
      if (activeRowRef.current && activeRowRef.current.contains(event.target as Node)) return;
      if (mouseDownInsideRef.current) return;
      closeAllInlineRows();
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") closeAllInlineRows();
    }

    document.addEventListener("mousedown", handleDocumentMouseDown);
    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentMouseDown);
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [editingProviderId, addingProvider, editingPresetId, addingPreset]);

  function commitOnEnter(event: KeyboardEvent): void {
    if (event.key === "Enter") (event.currentTarget as HTMLElement).blur();
  }

  // --- 接続先 (provider) handlers -------------------------------------------

  function openEditProvider(provider: LlmProviderV1): void {
    closeAllInlineRows();
    setEditingProviderId(provider.id);
    setProviderDraft({ label: provider.label, baseUrl: provider.baseUrl, apiKey: provider.apiKey });
  }

  function commitProviderField(provider: LlmProviderV1, field: "label" | "baseUrl" | "apiKey"): void {
    const value = providerDraft[field];
    if (field === "baseUrl" && !value.trim()) return; // baseUrl is required — don't commit a blank one
    if (value === provider[field]) return;
    mutateCfg((config) => patchProvider(config, provider.id, { [field]: value }));
  }

  function openAddProvider(): void {
    closeAllInlineRows();
    setAddingProvider(true);
    setNpLabel("");
    setNpBaseUrl("");
    setNpApiKey("");
  }

  function commitAddProvider(): void {
    const baseUrl = npBaseUrl.trim().replace(/\/+$/, "");
    if (!baseUrl) return;
    mutateCfg((config) => {
      const id = createProvider(config, npLabel.trim() || baseUrl);
      patchProvider(config, id, { baseUrl, apiKey: npApiKey });
    });
    setAddingProvider(false);
  }

  function removeProviderRow(provider: LlmProviderV1): void {
    const usedByPresets = cfg.presets.filter((p) => p.providerId === provider.id).length;
    const usedByVoice = (cfg.tts?.providerId === provider.id ? 1 : 0) + (cfg.stt?.providerId === provider.id ? 1 : 0);
    if (usedByPresets > 0 || usedByVoice > 0) {
      const parts = [
        usedByPresets > 0 ? `プリセット ${usedByPresets} 件` : "",
        usedByVoice > 0 ? "音声設定" : "",
      ].filter(Boolean);
      const ok = window.confirm(`この接続は ${parts.join("・")} で使われています。削除すると動作しなくなります。削除しますか？`);
      if (!ok) return;
    }
    mutateCfg((config) => deleteProvider(config, provider.id));
    if (editingProviderId === provider.id) setEditingProviderId("");
  }

  // --- モデル (preset) handlers ----------------------------------------------

  function openEditPreset(preset: ModelPresetV1): void {
    closeAllInlineRows();
    setEditingPresetId(preset.id);
    setPresetDraft({ label: preset.label, temperature: String(preset.temperature ?? 0.7) });
  }

  function commitPresetLabel(preset: ModelPresetV1): void {
    const label = presetDraft.label.trim() || preset.model || preset.id;
    if (label === preset.label) return;
    mutateCfg((config) => patchPreset(config, preset.id, { label }));
  }

  function changePresetProvider(preset: ModelPresetV1, providerId: string): void {
    // The stored model name is meaningless against a different provider's
    // catalog, so it's cleared here — same as the pre-redesign behavior.
    mutateCfg((config) => patchPreset(config, preset.id, { providerId, model: "" }));
  }

  function changePresetModel(preset: ModelPresetV1, model: string): void {
    if (model === preset.model) return;
    mutateCfg((config) => patchPreset(config, preset.id, { model }));
  }

  function commitPresetTemperature(preset: ModelPresetV1): void {
    const parsed = Number.parseFloat(presetDraft.temperature);
    const next = Number.isFinite(parsed) ? parsed : 0.7;
    if (next === (preset.temperature ?? 0.7)) return;
    mutateCfg((config) => patchPreset(config, preset.id, { temperature: next }));
  }

  /** Edits the reasoning_effort of a preset directly — used by the タスク tab's 既定 row (see file header for why reasoning_effort stays preset-intrinsic rather than a separate per-task field). */
  function commitPresetReasoningEffort(preset: ModelPresetV1, reasoningEffort: string): void {
    mutateCfg((config) => patchPreset(config, preset.id, { reasoningEffort }));
  }

  function openAddPreset(): void {
    closeAllInlineRows();
    setAddingPreset(true);
    setAmLabel("");
    setAmProviderId(cfg.providers[0]?.id ?? "");
    setAmModel("");
  }

  function commitAddPreset(): void {
    const model = amModel.trim();
    if (!amProviderId || !model) return;
    mutateCfg((config) => {
      const id = createPreset(config, amProviderId, amLabel.trim() || model);
      patchPreset(config, id, { model });
    });
    setAddingPreset(false);
  }

  function removePresetRow(preset: ModelPresetV1): void {
    const ok = window.confirm(`プリセット「${preset.label || preset.model}」を削除しますか？`);
    if (!ok) return;
    mutateCfg((config) => deletePreset(config, preset.id));
    if (editingPresetId === preset.id) setEditingPresetId("");
  }

  // ----- Consumer connection lifecycle -------------------------------------
  const [consumer, setConsumer] = useState<ConsumerStatus>(() => consumerStatus());
  const [consumerUpdatedAt, setConsumerUpdatedAt] = useState<number>(() => Date.now());

  useEffect(() => {
    return onConsumerStatusChange((status) => {
      setConsumer(status);
      setConsumerUpdatedAt(Date.now());
    });
  }, []);

  const consumerRoom = cfg.network.roomId.trim();
  useEffect(() => {
    if (!settings.networkConsumerEnabled || !consumerRoom) {
      disconnectNetworkConsumer();
      return;
    }
    // Debounced so typing a room id doesn't thrash the connection.
    const timer = setTimeout(() => void connectNetworkConsumer(consumerRoom), 500);
    return () => clearTimeout(timer);
  }, [settings.networkConsumerEnabled, consumerRoom]);

  // ----- Provider lifecycle (share this app's default preset) -------------
  const providerRoom = cfg.network.roomId.trim();
  const providerTarget = useMemo(() => resolvePreset(cfg), [cfg]);
  const upstreamConfigured = Boolean(providerTarget?.model.trim() && providerTarget?.baseUrl.trim());

  const provider = useNetworkProvider({
    enabled: settings.networkProviderEnabled && upstreamConfigured && Boolean(providerRoom),
    roomId: providerRoom,
    createNode: createMistNode,
    nodeIdStorageKey: NODE_ID_STORAGE_KEY,
    callLlm: (messages, model, onDelta) => {
      const target = resolvePreset(cfgRef.current);
      if (!target) return Promise.reject(new Error("共有する LLM プリセットが設定されていません。"));
      return requestApiChatCompletionStreaming(target, messages, model, onDelta);
    },
  });

  // ----- AI Network tab: Room ID draft (blur/Enter commits) -----------------
  const [roomIdDraft, setRoomIdDraft] = useState(cfg.network.roomId);
  useEffect(() => setRoomIdDraft(cfg.network.roomId), [cfg.network.roomId]);
  function commitRoomId(): void {
    if (roomIdDraft === cfg.network.roomId) return;
    updateCfg({ ...cfg, network: { roomId: roomIdDraft } });
  }

  // --- 接続先 (provider) card rendering --------------------------------------

  function renderProviderRow(prov: LlmProviderV1) {
    if (editingProviderId === prov.id) {
      return (
        <div class="model-row model-row-editing" key={prov.id} ref={activeRowRef}>
          <div class="model-row-edit-fields">
            <input
              value={providerDraft.label}
              placeholder="接続名"
              autoComplete="off"
              onInput={(e) => setProviderDraft((d) => ({ ...d, label: e.currentTarget.value }))}
              onBlur={() => commitProviderField(prov, "label")}
              onKeyDown={commitOnEnter}
            />
            <input
              value={providerDraft.baseUrl}
              title={prov.baseUrl}
              placeholder="http://localhost:1234/v1"
              autoComplete="off"
              onInput={(e) => setProviderDraft((d) => ({ ...d, baseUrl: e.currentTarget.value }))}
              onBlur={() => commitProviderField(prov, "baseUrl")}
              onKeyDown={commitOnEnter}
            />
            <input
              type="password"
              value={providerDraft.apiKey}
              placeholder="sk-..."
              autoComplete="off"
              onInput={(e) => setProviderDraft((d) => ({ ...d, apiKey: e.currentTarget.value }))}
              onBlur={() => commitProviderField(prov, "apiKey")}
              onKeyDown={commitOnEnter}
            />
          </div>
        </div>
      );
    }

    return (
      <div class="model-row" key={prov.id}>
        <button type="button" class="model-row-main" onClick={() => openEditProvider(prov)}>
          <span class="model-row-label">{prov.label || prov.baseUrl}</span>
          <span class="model-row-model">{prov.baseUrl}</span>
        </button>
        <span
          class="preset-chip-remove model-row-remove"
          role="button"
          tabIndex={0}
          title="接続を削除"
          onClick={(e) => {
            e.stopPropagation();
            removeProviderRow(prov);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              removeProviderRow(prov);
            }
          }}
        >
          <X size={13} />
        </span>
      </div>
    );
  }

  function renderAddProviderTile() {
    if (addingProvider) {
      return (
        <div class="model-row model-row-editing" ref={activeRowRef}>
          <div class="model-row-edit-fields">
            <input value={npLabel} onInput={(e) => setNpLabel(e.currentTarget.value)} placeholder="接続名" autoComplete="off" />
            <input
              value={npBaseUrl}
              onInput={(e) => setNpBaseUrl(e.currentTarget.value)}
              placeholder="http://localhost:1234/v1"
              autoComplete="off"
            />
            <input
              type="password"
              value={npApiKey}
              onInput={(e) => setNpApiKey(e.currentTarget.value)}
              placeholder="sk-..."
              autoComplete="off"
            />
          </div>
          <div class="model-row-add-actions">
            <button
              type="button"
              class="connection-form-btn connection-form-btn-primary"
              onClick={commitAddProvider}
              disabled={!npBaseUrl.trim()}
            >
              <Plus size={13} />
              追加
            </button>
            <button type="button" class="connection-form-btn" onClick={() => setAddingProvider(false)}>
              キャンセル
            </button>
          </div>
        </div>
      );
    }
    return (
      <button type="button" class="grid-add-tile" onClick={openAddProvider}>
        <Plus size={16} />
        <span>接続を追加</span>
      </button>
    );
  }

  // --- モデル (preset) card rendering -----------------------------------------

  function renderPresetRow(preset: ModelPresetV1) {
    if (editingPresetId === preset.id) {
      const provider = providerFor(preset.providerId);
      return (
        <div class="model-row model-row-editing" key={preset.id} ref={activeRowRef}>
          <div class="model-row-edit-fields">
            <input
              value={presetDraft.label}
              placeholder="プリセット名"
              autoComplete="off"
              onInput={(e) => setPresetDraft((d) => ({ ...d, label: e.currentTarget.value }))}
              onBlur={() => commitPresetLabel(preset)}
              onKeyDown={commitOnEnter}
            />
            <select value={preset.providerId} onChange={(e) => changePresetProvider(preset, e.currentTarget.value)}>
              {cfg.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label || p.baseUrl}
                </option>
              ))}
              {!cfg.providers.some((p) => p.id === preset.providerId) && (
                <option value={preset.providerId}>{preset.providerId}（不明）</option>
              )}
            </select>
            <OptionsPicker
              value={preset.model}
              placeholder="gpt-4o-mini"
              baseUrl={provider?.baseUrl ?? ""}
              apiKey={provider?.apiKey ?? ""}
              onChange={(model) => changePresetModel(preset, model)}
              useOptions={useModelOptions}
              itemLabel="モデル"
            />
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={presetDraft.temperature}
              aria-label="temperature"
              title="temperature"
              onInput={(e) => setPresetDraft((d) => ({ ...d, temperature: e.currentTarget.value }))}
              onBlur={() => commitPresetTemperature(preset)}
              onKeyDown={commitOnEnter}
            />
          </div>
        </div>
      );
    }

    const badges = getPresetBadges(preset);
    return (
      <div class="model-row" key={preset.id}>
        <button type="button" class="model-row-main" onClick={() => openEditPreset(preset)}>
          <span class="model-row-label">{preset.label}</span>
          <span class="model-row-model">{preset.model || "(モデル未設定)"}</span>
          <span class="model-row-provider">{getProviderLabel(preset.providerId)}</span>
        </button>
        {badges.length > 0 ? (
          <span class="model-row-badges">
            {badges.map((badge) => (
              <span key={badge} class="task-badge">
                {badge}
              </span>
            ))}
          </span>
        ) : null}
        <span
          class="preset-chip-remove model-row-remove"
          role="button"
          tabIndex={0}
          title="プリセットを削除"
          onClick={(e) => {
            e.stopPropagation();
            removePresetRow(preset);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              removePresetRow(preset);
            }
          }}
        >
          <X size={13} />
        </span>
      </div>
    );
  }

  function renderAddPresetTile() {
    if (cfg.providers.length === 0) {
      return (
        <button type="button" class="grid-add-tile" disabled title="先に接続を追加してください">
          <Plus size={16} />
          <span>モデルを追加</span>
        </button>
      );
    }
    if (addingPreset) {
      const provider = providerFor(amProviderId);
      return (
        <div class="model-row model-row-editing" ref={activeRowRef}>
          <div class="model-row-edit-fields">
            <input value={amLabel} onInput={(e) => setAmLabel(e.currentTarget.value)} placeholder="プリセット名" autoComplete="off" />
            <select value={amProviderId} onChange={(e) => setAmProviderId(e.currentTarget.value)}>
              {cfg.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label || p.baseUrl}
                </option>
              ))}
            </select>
            <OptionsPicker
              value={amModel}
              placeholder="gpt-4o-mini"
              baseUrl={provider?.baseUrl ?? ""}
              apiKey={provider?.apiKey ?? ""}
              onChange={setAmModel}
              useOptions={useModelOptions}
              itemLabel="モデル"
            />
          </div>
          <div class="model-row-add-actions">
            <button
              type="button"
              class="connection-form-btn connection-form-btn-primary"
              onClick={commitAddPreset}
              disabled={!amProviderId || !amModel.trim()}
            >
              <Plus size={13} />
              追加
            </button>
            <button type="button" class="connection-form-btn" onClick={() => setAddingPreset(false)}>
              キャンセル
            </button>
          </div>
        </div>
      );
    }
    return (
      <button type="button" class="grid-add-tile" onClick={openAddPreset}>
        <Plus size={16} />
        <span>モデルを追加</span>
      </button>
    );
  }

  // --- タスク tab: TTS/STT model picker --------------------------------------
  // Options: "ブラウザ標準（未設定）" (clears providerId/model), a preset card
  // (sets providerId+model to that preset's pair), or — only when the stored
  // pair doesn't match any current preset — a read-only "current value"
  // option so a value written by another app/session stays visible instead
  // of silently rendering as unset. No "AI Networkにおまかせ" option: tc-town
  // has no mist-network:// pseudo-provider (see file header).
  function matchedVoicePreset(voice: VoiceConfigV1 | undefined): ModelPresetV1 | undefined {
    if (!voice) return undefined;
    return cfg.presets.find((p) => p.providerId === voice.providerId && p.model === voice.model);
  }

  function renderVoicePicker(kind: "tts" | "stt") {
    const voice = cfg[kind];
    const matched = matchedVoicePreset(voice);
    const hasUnmatchedCurrent = Boolean(voice?.model.trim()) && !matched;
    const value = matched ? matched.id : hasUnmatchedCurrent ? "__current__" : "";

    function handleChange(next: string): void {
      if (next === "__current__") return;
      if (next === "") {
        updateVoice(kind, { providerId: undefined, model: "" });
        return;
      }
      const preset = cfg.presets.find((p) => p.id === next);
      if (!preset) return;
      updateVoice(kind, { providerId: preset.providerId, model: preset.model });
    }

    return (
      <select
        value={value}
        onChange={(e) => handleChange(e.currentTarget.value)}
        aria-label={kind === "tts" ? "読み上げモデル" : "書き起こしモデル"}
      >
        <option value="">ブラウザ標準（未設定）</option>
        {hasUnmatchedCurrent ? <option value="__current__">{voice!.model}</option> : null}
        {cfg.presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label || p.model || p.id}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div class="tc-settings">
      <div class="tc-settings-inner">
        <h1 class="tc-settings-title">設定</h1>

        <div class="tc-settings-tabs" role="tablist" aria-label="設定タブ">
          {SETTINGS_TABS.map((tab) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`tc-settings-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`tc-settings-panel-${tab.id}`}
                class={`tc-settings-tab${selected ? " tc-settings-tab--active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={16} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* --- Appearance ---------------------------------------------------- */}
        {activeTab === "appearance" ? (
          <section
            class="tc-settings-section"
            role="tabpanel"
            id="tc-settings-panel-appearance"
            aria-labelledby="tc-settings-tab-appearance"
          >
            <h2 class="tc-settings-heading">表示</h2>
            <p class="tc-hint">アプリの見た目と言語を設定します。</p>
            <label class="tc-field">
              <span>テーマ</span>
              <select value={theme} onChange={(e) => setTheme(e.currentTarget.value as "light" | "dark" | "system")}>
                {THEME_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label class="tc-field">
              <span>言語</span>
              <select value={language} onChange={(e) => setLanguage(e.currentTarget.value as "ja" | "en")}>
                {LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </section>
        ) : null}

        {/* --- AI接続 (LLM connections/presets) -------------------------------- */}
        {activeTab === "connection" ? (
          <section
            class="tc-settings-section"
            role="tabpanel"
            id="tc-settings-panel-connection"
            aria-labelledby="tc-settings-tab-connection"
          >
            <div class="server-list-header">
              <label>接続先</label>
            </div>
            <div class="settings-flat-section settings-flat-section-connection">
              {cfg.providers.length === 0 && !addingProvider ? (
                <p class="tc-hint">まだ接続がありません。「接続を追加」から作成してください。</p>
              ) : null}
              <div class="model-row-list">
                {cfg.providers.map((prov) => renderProviderRow(prov))}
                {renderAddProviderTile()}
              </div>
            </div>

            <div class="server-list-header">
              <label>モデル</label>
            </div>
            <div class="settings-flat-section settings-flat-section-models">
              {cfg.providers.length > 0 && cfg.presets.length === 0 && !addingPreset ? (
                <p class="tc-hint">まだモデルがありません。「モデルを追加」から作成してください。</p>
              ) : null}
              <div class="model-row-list">
                {cfg.presets.map((preset) => renderPresetRow(preset))}
                {renderAddPresetTile()}
              </div>
            </div>
          </section>
        ) : null}

        {/* --- AI Network ------------------------------------------------------ */}
        {activeTab === "network" ? (
          <section
            class="tc-settings-section"
            role="tabpanel"
            id="tc-settings-panel-network"
            aria-labelledby="tc-settings-tab-network"
          >
            <label class="tc-field">
              <span>ルーム ID</span>
              <input
                value={roomIdDraft}
                placeholder="例: my-town-room"
                onInput={(e) => setRoomIdDraft(e.currentTarget.value)}
                onBlur={commitRoomId}
                onKeyDown={commitOnEnter}
              />
            </label>

            <div class="tc-role-card">
              <label class="tc-role-head">
                <input
                  type="checkbox"
                  checked={settings.networkConsumerEnabled}
                  onChange={(e) => update({ ...settings, networkConsumerEnabled: e.currentTarget.checked })}
                />
                <Radio size={16} />
                <span class="tc-role-title" data-tip="ルームに参加している他の端末の LLM を利用します。">
                  ネットワークの LLM を使う
                </span>
              </label>
              {settings.networkConsumerEnabled ? (
                <div class="tc-role-body">
                  <ConsumerStatusIndicator
                    status={consumer}
                    updatedAt={consumerUpdatedAt}
                    variant="detailed"
                    messages={MESSAGES_JA}
                    note="ルーム ID を入力するとプロバイダーを探します。"
                  />
                </div>
              ) : null}
            </div>

            <div class="tc-role-card">
              <label class="tc-role-head">
                <input
                  type="checkbox"
                  checked={settings.networkProviderEnabled}
                  onChange={(e) => update({ ...settings, networkProviderEnabled: e.currentTarget.checked })}
                />
                <Server size={16} />
                <span class="tc-role-title" data-tip="自分の既定プリセットの LLM をルームの他の端末に提供します。">
                  AI を提供する
                </span>
              </label>
              {settings.networkProviderEnabled ? (
                <div class="tc-role-body">
                  {upstreamConfigured && providerTarget ? (
                    <p class="tc-hint">共有中のモデル: {providerTarget.label || providerTarget.model}</p>
                  ) : null}
                  <ProviderStatusPanel
                    status={provider.status}
                    statusUpdatedAt={provider.statusUpdatedAt}
                    errorMessage={provider.errorMessage}
                    ownNodeId={provider.ownNodeId}
                    peers={provider.peers}
                    consumerCount={provider.consumerCount}
                    logs={provider.logs}
                    messages={MESSAGES_JA}
                    notice={
                      !upstreamConfigured ? (
                        <p class="mistai-status-detail error">
                          「AI接続」タブで既定プリセットの接続先とモデルを設定すると提供を開始できます。
                        </p>
                      ) : null
                    }
                  />
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* --- タスク (per-feature model assignment) ----------------------------- */}
        {activeTab === "tasks" ? (
          <section
            class="tc-settings-section"
            role="tabpanel"
            id="tc-settings-panel-tasks"
            aria-labelledby="tc-settings-tab-tasks"
          >
            <div class="task-model-item">
              <span data-tip="キャラクターとの会話・評価・成長診断など、アプリ全体で使う既定のモデルです。">既定</span>
              <div class="task-model-fields">
                <div class="task-model-field">
                  <select
                    value={cfg.defaultPresetId}
                    onChange={(e) => updateCfg({ ...cfg, defaultPresetId: e.currentTarget.value })}
                    aria-label="既定のプリセット"
                  >
                    <option value="">未選択</option>
                    {cfg.presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label || p.id}
                      </option>
                    ))}
                  </select>
                </div>
                <div class="task-model-field">
                  <select
                    value={defaultPreset?.reasoningEffort ?? DEFAULT_REASONING_EFFORT}
                    disabled={!defaultPreset}
                    onChange={(e) => defaultPreset && commitPresetReasoningEffort(defaultPreset, e.currentTarget.value)}
                    aria-label="推論エフォート"
                    title="推論エフォート（reasoning_effort）"
                  >
                    {REASONING_EFFORT_OPTIONS.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div class="task-model-item">
              <span data-tip="応答ごとに小さな LLM リクエストで感情を判定し、キャラクターの表情を切り替えます。「自動」は応答が遅い場合に自動でオフになります。">
                表情
              </span>
              <div class="task-model-fields">
                <div class="tc-expr-modes" role="radiogroup" aria-label="表情の自動切り替え">
                  {EXPRESSION_MODES.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={settings.expressionMode === mode}
                      class={`tc-expr-mode-btn${settings.expressionMode === mode ? " tc-expr-mode-btn--active" : ""}`}
                      onClick={() => updateExpressionMode(mode)}
                    >
                      {EXPRESSION_MODE_LABELS[mode]}
                    </button>
                  ))}
                </div>
                <p class="tc-expr-status">
                  状態: {expressionStatusLabel(expressionStatus)}
                  {" / "}
                  {expressionStatus.sampleCount > 0
                    ? `平均応答時間 ${expressionStatus.avgLatencyMs}ms（${expressionStatus.sampleCount}件）`
                    : "まだ計測なし"}
                </p>
              </div>
            </div>

            <div class="task-model-item">
              <span data-tip="キャラクターの発言を読み上げる音声モデルです。「ブラウザ標準」を選ぶとブラウザの音声合成を使います。">
                読み上げ
              </span>
              <div class="task-model-fields">
                <div class="task-model-field">{renderVoicePicker("tts")}</div>
                {cfg.tts?.model.trim() ? (
                  <>
                    <div class="task-model-field">
                      <OptionsPicker
                        value={cfg.tts?.voice ?? ""}
                        placeholder="alloy"
                        baseUrl={ttsProvider?.baseUrl ?? ""}
                        apiKey={ttsProvider?.apiKey ?? ""}
                        onChange={(voice) => updateVoice("tts", { voice: voice || undefined })}
                        useOptions={useVoiceOptions}
                        itemLabel="音声"
                        emptyOption={{ label: "未選択" }}
                        fallbackOptions={OPENAI_TTS_VOICES}
                      />
                    </div>
                    <div class="task-model-field">
                      <input
                        type="number"
                        min={0.25}
                        max={4}
                        step={0.05}
                        value={cfg.tts?.speed ?? 1}
                        aria-label="速度"
                        title="速度"
                        onInput={(e) => {
                          const parsed = Number.parseFloat(e.currentTarget.value);
                          updateVoice("tts", { speed: Number.isFinite(parsed) ? parsed : 1 });
                        }}
                      />
                    </div>
                  </>
                ) : null}
              </div>
            </div>

            <div class="task-model-item">
              <span data-tip="通話中のユーザーの発話を書き起こすモデルです。「ブラウザ標準」を選ぶとブラウザの音声認識を使います。">
                書き起こし
              </span>
              <div class="task-model-fields">
                <div class="task-model-field">{renderVoicePicker("stt")}</div>
                <div class="task-model-field">
                  <input
                    type="number"
                    min={0}
                    max={5}
                    step={0.1}
                    value={settings.sttSilenceDuration}
                    aria-label="無音の待機時間（秒）"
                    title="無音の待機時間（秒）"
                    onInput={(e) => {
                      const parsed = Number.parseFloat(e.currentTarget.value);
                      update({ ...settings, sttSilenceDuration: Number.isFinite(parsed) ? parsed : 0.8 });
                    }}
                  />
                </div>
                <div class="task-model-field">
                  <input
                    type="number"
                    min={0}
                    max={0.5}
                    step={0.005}
                    value={settings.micThreshold}
                    aria-label="マイク感度（音声と判定する音量のしきい値）"
                    title="マイク感度（音声と判定する音量のしきい値）"
                    onInput={(e) => {
                      const parsed = Number.parseFloat(e.currentTarget.value);
                      update({ ...settings, micThreshold: Number.isFinite(parsed) ? parsed : 0.02 });
                    }}
                  />
                </div>
              </div>
            </div>

            <div class="task-model-item">
              <span data-tip="通話中にユーザーが話し始めたら、キャラクターの読み上げを止めて聞き取りに切り替えます。">
                割り込み
              </span>
              <div class="task-model-fields">
                <label class="task-model-field tc-role-head">
                  <input
                    type="checkbox"
                    checked={settings.bargeInEnabled}
                    onChange={(e) => update({ ...settings, bargeInEnabled: e.currentTarget.checked })}
                  />
                  <span class="tc-role-title">話しかけたら読み上げを停止</span>
                </label>
              </div>
            </div>
          </section>
        ) : null}

        {/* --- Onboarding ----------------------------------------------------- */}
        {activeTab === "onboarding" ? (
          <section
            class="tc-settings-section"
            role="tabpanel"
            id="tc-settings-panel-onboarding"
            aria-labelledby="tc-settings-tab-onboarding"
          >
            <h2 class="tc-settings-heading">はじめに</h2>
            <p class="tc-hint">初回セットアップ（LLM接続・最初のキャラクター作成）のガイドをもう一度開けます。</p>
            <button type="button" class="tc-btn" onClick={requestOnboarding}>
              <Sparkles size={16} />
              セットアップガイドを開く
            </button>
          </section>
        ) : null}
      </div>
    </div>
  );
}

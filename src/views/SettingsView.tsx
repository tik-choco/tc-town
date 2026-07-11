// Settings screen: LLM profile editor, AI Network room/consumer/provider
// controls, TTS/STT voice endpoints, and app appearance (theme/language).
// Self-contained — the integration wave mounts <SettingsView /> behind the
// shell's "設定" nav. Persistence is immediate: every edit writes through to
// localStorage via saveProviderSettings so nothing is lost on navigation.
//
// Sections are presented as tabs (see SETTINGS_TABS below) — the tab picks
// which panel renders in JSX only. All stateful hooks (settings, the AI
// Network consumer/provider lifecycle, backup state) stay unconditional at
// the top of SettingsView so switching tabs never resets a connection or
// drops in-flight state. The active tab itself is remembered in
// localStorage so re-opening Settings returns to where the user left off.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  Cpu,
  DatabaseBackup,
  Download,
  Mic,
  Network,
  Palette,
  Plus,
  Radio,
  RefreshCw,
  Server,
  Smile,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-preact";
import { MESSAGES_JA } from "@tik-choco/mistai";
import { ConsumerStatusIndicator, ProviderStatusPanel } from "@tik-choco/mistai/preact";
import "@tik-choco/mistai/ui.css";
import { useAppSettings } from "../hooks/useAppSettings";
import { loadAppSettings } from "../lib/appSettings";
import { requestOnboarding } from "../lib/onboarding";
import {
  buildExportBundle,
  downloadExportBundle,
  importCharacters,
  parseExportBundle,
} from "../lib/exportImport";
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
 * Exported so both the model fields (LLM profile / TTS / STT) and the TTS
 * voice fields (settings + per-character override) share one implementation
 * — callers own the surrounding label/field markup and CSS classes so this
 * works with tc-town's differently-styled settings and character-editor forms.
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

/** Model field for the LLM profile / TTS / STT model pickers — wraps {@link OptionsPicker} in the settings screen's field label. */
function ModelField(props: {
  label: string;
  value: string;
  placeholder: string;
  baseUrl: string;
  apiKey: string;
  onChange: (model: string) => void;
}) {
  return (
    <label class="tc-field">
      <span>{props.label}</span>
      <OptionsPicker
        value={props.value}
        placeholder={props.placeholder}
        baseUrl={props.baseUrl}
        apiKey={props.apiKey}
        onChange={props.onChange}
        useOptions={useModelOptions}
        itemLabel="モデル"
        emptyOption={{ label: "未選択" }}
      />
    </label>
  );
}

/** TTS voice field — wraps {@link OptionsPicker} with the voice-listing hook and the standard OpenAI voice set as a fallback. */
function VoiceField(props: {
  label: string;
  value: string;
  placeholder: string;
  baseUrl: string;
  apiKey: string;
  onChange: (voice: string) => void;
}) {
  return (
    <label class="tc-field">
      <span>{props.label}</span>
      <OptionsPicker
        value={props.value}
        placeholder={props.placeholder}
        baseUrl={props.baseUrl}
        apiKey={props.apiKey}
        onChange={props.onChange}
        useOptions={useVoiceOptions}
        itemLabel="音声"
        emptyOption={{ label: "未選択" }}
        fallbackOptions={OPENAI_TTS_VOICES}
      />
    </label>
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
// Sections used to be one long scrolling page; they're now tabs so a user
// looking for one setting doesn't have to scroll past the other four. Tab
// selection is remembered across visits (localStorage, parsed defensively —
// same pattern as appSettings.ts / llmSettings.ts).

type SettingsTabId = "appearance" | "llm" | "network" | "voice" | "backup" | "onboarding";

const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string; icon: typeof Palette }> = [
  { id: "appearance", label: "表示", icon: Palette },
  { id: "llm", label: "LLM", icon: Cpu },
  { id: "network", label: "AIネットワーク", icon: Network },
  { id: "voice", label: "音声", icon: Mic },
  { id: "backup", label: "バックアップ", icon: DatabaseBackup },
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

  // Reflect edits made by another app (or another tab of this app) sharing
  // the same origin — e.g. a provider/preset added from tc-news's settings.
  useEffect(() => subscribeLlmConfig((next) => setCfg(next ?? emptyLlmConfig())), []);

  function addProvider(): void {
    const provider: LlmProviderV1 = {
      id: crypto.randomUUID(),
      label: "新しい接続",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "",
    };
    updateCfg({ ...cfg, providers: [...cfg.providers, provider] });
  }

  function updateProvider(id: string, patch: Partial<LlmProviderV1>): void {
    updateCfg({ ...cfg, providers: cfg.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  }

  function deleteProvider(id: string): void {
    const usedByPresets = cfg.presets.filter((p) => p.providerId === id).length;
    const usedByVoice = (cfg.tts?.providerId === id ? 1 : 0) + (cfg.stt?.providerId === id ? 1 : 0);
    if (usedByPresets > 0 || usedByVoice > 0) {
      const parts = [
        usedByPresets > 0 ? `プリセット ${usedByPresets} 件` : "",
        usedByVoice > 0 ? "音声設定" : "",
      ].filter(Boolean);
      const ok = window.confirm(`この接続は ${parts.join("・")} で使われています。削除すると動作しなくなります。削除しますか？`);
      if (!ok) return;
    }
    updateCfg({ ...cfg, providers: cfg.providers.filter((p) => p.id !== id) });
  }

  function addPreset(): void {
    const providerId = cfg.providers[0]?.id;
    if (!providerId) return; // "追加" is disabled with zero providers
    const preset: ModelPresetV1 = {
      id: crypto.randomUUID(),
      label: "新しいプリセット",
      providerId,
      model: "",
      temperature: 0.7,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
    };
    const presets = [...cfg.presets, preset];
    const defaultPresetId = cfg.defaultPresetId || preset.id;
    updateCfg({ ...cfg, presets, defaultPresetId });
  }

  function updatePreset(id: string, patch: Partial<ModelPresetV1>): void {
    updateCfg({ ...cfg, presets: cfg.presets.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  }

  function deletePreset(id: string): void {
    const presets = cfg.presets.filter((p) => p.id !== id);
    const defaultPresetId = cfg.defaultPresetId === id ? (presets[0]?.id ?? "") : cfg.defaultPresetId;
    updateCfg({ ...cfg, presets, defaultPresetId });
  }

  function updateVoice(kind: "tts" | "stt", patch: Partial<VoiceConfigV1>): void {
    const current: VoiceConfigV1 = cfg[kind] ?? { model: "" };
    updateCfg({ ...cfg, [kind]: { ...current, ...patch } });
  }

  /** Resolves the connection (baseUrl/apiKey) a TTS/STT field should fetch models/voices against: the voice's own provider, or (when omitted, i.e. "LLMと同じ") the default preset's provider. */
  function connectionForVoice(voice: VoiceConfigV1 | undefined): LlmProviderV1 | undefined {
    if (voice?.providerId) return cfg.providers.find((p) => p.id === voice.providerId);
    const target = resolvePreset(cfg);
    return target ? cfg.providers.find((p) => p.id === target.providerId) : undefined;
  }

  const ttsProvider = connectionForVoice(cfg.tts);
  const sttProvider = connectionForVoice(cfg.stt);

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

  // ----- Data backup (export/import) ----------------------------------------
  const [exportBusy, setExportBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [applyAppSettingsOnImport, setApplyAppSettingsOnImport] = useState(false);
  const [applyProviderSettingsOnImport, setApplyProviderSettingsOnImport] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  async function handleExport() {
    setExportBusy(true);
    setExportStatus(null);
    try {
      const bundle = await buildExportBundle(loadAppSettings(), settings);
      downloadExportBundle(bundle);
      setExportStatus(`書き出しました（キャラクター ${bundle.characters.length} 件）。`);
    } catch (error) {
      window.alert(`エクスポートに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExportBusy(false);
    }
  }

  async function handleImportFile(file: File) {
    setImportStatus(null);
    let bundle;
    try {
      bundle = parseExportBundle(await file.text());
    } catch (error) {
      setImportStatus(`インポートに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const confirmLines = [
      `キャラクター ${bundle.characters.length} 件を読み込みます（IDが一致する場合は上書き、それ以外は追加）。`,
      `表示設定: ${applyAppSettingsOnImport ? "上書きする" : "上書きしない"}`,
      `AIネットワーク設定: ${applyProviderSettingsOnImport ? "上書きする" : "上書きしない"}`,
      "",
      "この操作は元に戻せません。",
    ];
    if (!window.confirm(`${confirmLines.join("\n")}\n\nよろしいですか？`)) return;

    setImportBusy(true);
    try {
      const result = await importCharacters(bundle);
      if (applyAppSettingsOnImport) {
        setTheme(bundle.appSettings.theme);
        setLanguage(bundle.appSettings.language);
      }
      if (applyProviderSettingsOnImport) {
        update(bundle.providerSettings);
      }
      const skippedNote = result.skipped ? ` / スキップ ${result.skipped} 件` : "";
      const missingVrmNote = result.missingVrm
        ? ` / VRM未所持のためアバターなしで取り込み ${result.missingVrm} 件`
        : "";
      setImportStatus(`インポート完了: 追加 ${result.added} 件 / 更新 ${result.updated} 件${skippedNote}${missingVrmNote}`);
    } catch (error) {
      setImportStatus(`インポートに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setImportBusy(false);
    }
  }

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

        {/* --- LLM providers / presets ----------------------------------------- */}
        {activeTab === "llm" ? (
          <section
            class="tc-settings-section"
            role="tabpanel"
            id="tc-settings-panel-llm"
            aria-labelledby="tc-settings-tab-llm"
          >
          <div class="tc-settings-heading-row">
            <h2 class="tc-settings-heading">接続</h2>
            <button type="button" class="tc-btn" onClick={addProvider}>
              <Plus size={16} />
              追加
            </button>
          </div>
          <p class="tc-hint">
            LLMの接続先（ベースURL・APIキー）です。同一ブラウザで動く tik-choco ファミリーの他のアプリとも共有されます。
          </p>

          <div class="tc-profile-list">
            {cfg.providers.map((prov) => (
              <div key={prov.id} class="tc-profile-card">
                <div class="tc-profile-head">
                  <input
                    class="tc-profile-label"
                    value={prov.label}
                    placeholder="接続名"
                    onInput={(e) => updateProvider(prov.id, { label: e.currentTarget.value })}
                  />
                  <button
                    type="button"
                    class="tc-icon-btn danger"
                    onClick={() => deleteProvider(prov.id)}
                    title="削除"
                    aria-label="接続を削除"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <label class="tc-field">
                  <span>Base URL</span>
                  <input
                    value={prov.baseUrl}
                    placeholder="http://localhost:1234/v1"
                    onInput={(e) => updateProvider(prov.id, { baseUrl: e.currentTarget.value })}
                  />
                </label>
                <label class="tc-field">
                  <span>API キー</span>
                  <input
                    type="password"
                    value={prov.apiKey}
                    placeholder="sk-..."
                    autocomplete="off"
                    onInput={(e) => updateProvider(prov.id, { apiKey: e.currentTarget.value })}
                  />
                </label>
              </div>
            ))}
            {cfg.providers.length === 0 && <p class="tc-hint">まだ接続がありません。「追加」から作成してください。</p>}
          </div>

          <div class="tc-settings-heading-row">
            <h2 class="tc-settings-heading">プリセット</h2>
            <button type="button" class="tc-btn" onClick={addPreset} disabled={cfg.providers.length === 0}>
              <Plus size={16} />
              追加
            </button>
          </div>
          <p class="tc-hint">キャラクターとの会話に使うモデルの組み合わせです。上の接続とモデル名を選んで作成します。</p>

          <label class="tc-field">
            <span>既定のプリセット</span>
            <select
              value={cfg.defaultPresetId}
              onChange={(e) => updateCfg({ ...cfg, defaultPresetId: e.currentTarget.value })}
            >
              <option value="">未選択</option>
              {cfg.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label || p.id}
                </option>
              ))}
            </select>
          </label>
          <p class="tc-hint">既定のプリセットは新しいキャラクターとネットワーク共有で使用されます。</p>

          <div class="tc-profile-list">
            {cfg.presets.map((preset) => {
              const provider = cfg.providers.find((p) => p.id === preset.providerId);
              return (
                <div key={preset.id} class="tc-profile-card">
                  <div class="tc-profile-head">
                    <input
                      class="tc-profile-label"
                      value={preset.label}
                      placeholder="プリセット名"
                      onInput={(e) => updatePreset(preset.id, { label: e.currentTarget.value })}
                    />
                    {preset.id === cfg.defaultPresetId ? <span class="tc-badge">既定</span> : null}
                    <button
                      type="button"
                      class="tc-icon-btn danger"
                      onClick={() => deletePreset(preset.id)}
                      title="削除"
                      aria-label="プリセットを削除"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <label class="tc-field">
                    <span>接続</span>
                    <select
                      value={preset.providerId}
                      onChange={(e) => updatePreset(preset.id, { providerId: e.currentTarget.value })}
                    >
                      {cfg.providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label || p.baseUrl}
                        </option>
                      ))}
                      {!cfg.providers.some((p) => p.id === preset.providerId) && (
                        <option value={preset.providerId}>{preset.providerId}（不明）</option>
                      )}
                    </select>
                  </label>
                  <ModelField
                    label="モデル"
                    value={preset.model}
                    placeholder="gpt-4o-mini"
                    baseUrl={provider?.baseUrl ?? ""}
                    apiKey={provider?.apiKey ?? ""}
                    onChange={(model) => updatePreset(preset.id, { model })}
                  />
                  <label class="tc-field">
                    <span>Temperature</span>
                    <input
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      value={preset.temperature ?? 0.7}
                      onInput={(e) => {
                        const parsed = Number.parseFloat(e.currentTarget.value);
                        updatePreset(preset.id, { temperature: Number.isFinite(parsed) ? parsed : 0.7 });
                      }}
                    />
                  </label>
                  <label class="tc-field">
                    <span>推論エフォート（reasoning_effort）</span>
                    <select
                      value={preset.reasoningEffort ?? DEFAULT_REASONING_EFFORT}
                      onChange={(e) => updatePreset(preset.id, { reasoningEffort: e.currentTarget.value })}
                    >
                      <option value="">送信しない</option>
                      {REASONING_EFFORT_OPTIONS.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort === DEFAULT_REASONING_EFFORT ? `${effort}（既定）` : effort}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              );
            })}
            {cfg.presets.length === 0 && <p class="tc-hint">まだプリセットがありません。先に接続を追加してください。</p>}
          </div>

          <div class="tc-settings-heading-row">
            <Smile size={18} />
            <h2 class="tc-settings-heading">表情の自動切り替え</h2>
          </div>
          <p class="tc-hint">
            応答ごとに小さなLLMリクエストで感情を判定し、キャラクターの表情を切り替えます。「自動」を選ぶと、応答が遅い場合は自動でオフになります。
          </p>
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
          </section>
        ) : null}

        {/* --- AI Network ---------------------------------------------------- */}
        {activeTab === "network" ? (
          <section
            class="tc-settings-section"
            role="tabpanel"
            id="tc-settings-panel-network"
            aria-labelledby="tc-settings-tab-network"
          >
          <h2 class="tc-settings-heading">AI ネットワーク</h2>
          <p class="tc-hint">
            ルームを共有すると、他の端末の LLM を利用したり、自分の LLM を提供したりできます。
          </p>

          <label class="tc-field">
            <span>ルーム ID</span>
            <input
              value={cfg.network.roomId}
              placeholder="例: my-town-room"
              onInput={(e) => updateCfg({ ...cfg, network: { roomId: e.currentTarget.value } })}
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
              <span class="tc-role-title">共有された LLM を利用する（コンシューマー）</span>
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
              <span class="tc-role-title">自分の LLM を提供する（プロバイダー）</span>
            </label>
            {settings.networkProviderEnabled ? (
              <div class="tc-role-body">
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
                        既定プリセットの接続先とモデルを設定すると提供を開始できます。
                      </p>
                    ) : null
                  }
                />
              </div>
            ) : null}
          </div>
          </section>
        ) : null}

        {/* --- Voice (TTS / STT) --------------------------------------------- */}
        {activeTab === "voice" ? (
          <section
            class="tc-settings-section"
            role="tabpanel"
            id="tc-settings-panel-voice"
            aria-labelledby="tc-settings-tab-voice"
          >
          <div class="tc-settings-heading-row">
            <Mic size={18} />
            <h2 class="tc-settings-heading">音声（読み上げ・書き起こし）</h2>
          </div>
          <p class="tc-hint">
            キャラクターの声の読み上げ（TTS）と、音声入力の書き起こし（STT）の接続先を設定します。「LLMと同じ」を選ぶと既定のLLM接続を流用します。
          </p>

          <h3 class="tc-subheading">読み上げ（TTS）</h3>
          <label class="tc-field">
            <span>接続</span>
            <select
              value={cfg.tts?.providerId ?? ""}
              onChange={(e) => updateVoice("tts", { providerId: e.currentTarget.value || undefined })}
            >
              <option value="">LLMと同じ</option>
              {cfg.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label || p.baseUrl}
                </option>
              ))}
            </select>
          </label>
          <ModelField
            label="モデル"
            value={cfg.tts?.model ?? ""}
            placeholder="tts-1"
            baseUrl={ttsProvider?.baseUrl ?? ""}
            apiKey={ttsProvider?.apiKey ?? ""}
            onChange={(model) => updateVoice("tts", { model })}
          />
          <VoiceField
            label="ボイス"
            value={cfg.tts?.voice ?? ""}
            placeholder="alloy"
            baseUrl={ttsProvider?.baseUrl ?? ""}
            apiKey={ttsProvider?.apiKey ?? ""}
            onChange={(voice) => updateVoice("tts", { voice: voice || undefined })}
          />
          <label class="tc-field">
            <span>速度</span>
            <input
              type="number"
              min={0.25}
              max={4}
              step={0.05}
              value={cfg.tts?.speed ?? 1}
              onInput={(e) => {
                const parsed = Number.parseFloat(e.currentTarget.value);
                updateVoice("tts", { speed: Number.isFinite(parsed) ? parsed : 1 });
              }}
            />
          </label>

          <h3 class="tc-subheading">書き起こし（STT）</h3>
          <label class="tc-field">
            <span>接続</span>
            <select
              value={cfg.stt?.providerId ?? ""}
              onChange={(e) => updateVoice("stt", { providerId: e.currentTarget.value || undefined })}
            >
              <option value="">LLMと同じ</option>
              {cfg.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label || p.baseUrl}
                </option>
              ))}
            </select>
          </label>
          <ModelField
            label="モデル"
            value={cfg.stt?.model ?? ""}
            placeholder="whisper-1"
            baseUrl={sttProvider?.baseUrl ?? ""}
            apiKey={sttProvider?.apiKey ?? ""}
            onChange={(model) => updateVoice("stt", { model })}
          />
          <label class="tc-field">
            <span>無音の待機時間（秒）</span>
            <input
              type="number"
              min={0}
              max={5}
              step={0.1}
              value={settings.sttSilenceDuration}
              onInput={(e) => {
                const parsed = Number.parseFloat(e.currentTarget.value);
                update({ ...settings, sttSilenceDuration: Number.isFinite(parsed) ? parsed : 0.8 });
              }}
            />
          </label>
          </section>
        ) : null}

        {/* --- Data backup (export/import) ------------------------------------ */}
        {activeTab === "backup" ? (
          <section
            class="tc-settings-section"
            role="tabpanel"
            id="tc-settings-panel-backup"
            aria-labelledby="tc-settings-tab-backup"
          >
          <div class="tc-settings-heading-row">
            <DatabaseBackup size={18} />
            <h2 class="tc-settings-heading">データのバックアップ</h2>
          </div>
          <p class="tc-hint">
            キャラクターとアバター、各種設定を1つのJSONファイルに書き出したり、書き出したファイルから読み込んだりできます。他の端末への引き継ぎや、誤操作からの復元に使えます。
            なお、VRMモデル本体はファイルに含まれません。インポート先に同じVRMがライブラリにある場合は自動で再リンクされます。
            LLM/TTS/STTの接続先（APIキーを含む）はこのファイルに含まれません — 同一ブラウザの他のtik-chocoアプリとも共有される設定のため、「LLM」「音声」タブから直接管理してください。
          </p>

          <div class="tc-backup-block">
            <h3 class="tc-subheading">エクスポート（書き出し）</h3>
            <button type="button" class="tc-btn" onClick={() => void handleExport()} disabled={exportBusy}>
              <Download size={16} />
              {exportBusy ? "書き出し中..." : "エクスポート"}
            </button>
            {exportStatus ? <p class="tc-backup-status">{exportStatus}</p> : null}
          </div>

          <div class="tc-backup-block">
            <h3 class="tc-subheading">インポート（読み込み）</h3>
            <p class="tc-hint">
              キャラクターは常にインポートされます（IDが一致する場合は上書き、それ以外は追加されます）。この操作は元に戻せません。
            </p>
            <label class="tc-checkbox-field">
              <input
                type="checkbox"
                checked={applyAppSettingsOnImport}
                onChange={(e) => setApplyAppSettingsOnImport(e.currentTarget.checked)}
              />
              <span>表示設定（テーマ・言語）も上書きする</span>
            </label>
            <label class="tc-checkbox-field">
              <input
                type="checkbox"
                checked={applyProviderSettingsOnImport}
                onChange={(e) => setApplyProviderSettingsOnImport(e.currentTarget.checked)}
              />
              <span>AIネットワーク設定（トグル・無音待機時間）も上書きする</span>
            </label>
            <button
              type="button"
              class="tc-btn"
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
            {importStatus ? <p class="tc-backup-status">{importStatus}</p> : null}
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

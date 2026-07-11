import { useState } from "preact/hooks";
import {
  Sparkles,
  Cpu,
  UserPlus,
  Check,
  X,
  ArrowLeft,
  ArrowRight,
  Globe,
  Users,
  MessagesSquare,
  Phone,
  Plug,
} from "lucide-preact";
import { emptyLlmConfig, ensureProvider, loadLlmConfig, resolvePreset, saveLlmConfig } from "../lib/llmConfig";
import { requestApiChatCompletionStreaming, type LlmCallTarget } from "../lib/llm";
import { useModelOptions } from "../lib/models";
import { createCharacter } from "../lib/characterStorage";
import { OptionsPicker } from "../views/SettingsView";
import "../styles/onboarding.css";

// First-run wizard shown by app.tsx as a modal overlay: welcome -> LLM
// connection -> first character -> feature tour. Every step is skippable and
// closing at any point counts as "done" (the flag is owned by the caller via
// `onClose`) — the settings screen can re-open it any time.

const STEP_COUNT = 4;

/** Field-level classes so {@link OptionsPicker} matches the wizard's ob-* form styling. */
const MODEL_PICKER_CLASS_NAMES = {
  row: "ob-model-row",
  input: "ob-input",
  select: "ob-input",
  iconBtn: "ob-icon-btn",
  footer: "ob-model-footer",
  status: "ob-model-status",
  linkBtn: "ob-link-btn",
};

interface LlmDraft {
  baseUrl: string;
  apiKey: string;
  model: string;
}

type TestState =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "ok" }
  | { phase: "error"; message: string };

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

export function Onboarding(props: { onClose: () => void }) {
  const [step, setStep] = useState(0);

  // LLM draft starts from the shared config's current default preset so
  // re-running the wizard shows (and edits) the real current connection
  // instead of blank fields.
  const [llm, setLlm] = useState<LlmDraft>(() => {
    const target = resolvePreset(loadLlmConfig() ?? emptyLlmConfig());
    return {
      baseUrl: target?.baseUrl ?? "",
      apiKey: target?.apiKey ?? "",
      model: target?.model ?? "",
    };
  });
  const [testState, setTestState] = useState<TestState>({ phase: "idle" });

  const [charName, setCharName] = useState("");
  const [createdName, setCreatedName] = useState<string | null>(null);

  function updateLlm(patch: Partial<LlmDraft>) {
    setLlm((prev) => ({ ...prev, ...patch }));
    // Edited connection values invalidate a previous test result.
    setTestState({ phase: "idle" });
  }

  /** Persists the draft into the default preset (the one new characters use): edits it in place if one already exists, otherwise creates a provider+preset and sets it as default. */
  function saveLlmDraft() {
    const cfg = loadLlmConfig() ?? emptyLlmConfig();
    const providerId = ensureProvider(cfg, { baseUrl: llm.baseUrl, apiKey: llm.apiKey });
    const existingDefault = cfg.presets.find((p) => p.id === cfg.defaultPresetId);
    if (existingDefault) {
      existingDefault.providerId = providerId;
      existingDefault.model = llm.model.trim();
    } else {
      const preset = { id: crypto.randomUUID(), label: "デフォルト", providerId, model: llm.model.trim() };
      cfg.presets.push(preset);
      cfg.defaultPresetId = preset.id;
    }
    saveLlmConfig(cfg);
  }

  async function handleTest() {
    if (testState.phase === "busy") return;
    setTestState({ phase: "busy" });
    const target: LlmCallTarget = { baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model };
    try {
      await requestApiChatCompletionStreaming(
        target,
        [{ role: "user", content: "接続テストです。「OK」とだけ返してください。" }],
        undefined,
        () => {},
      );
      setTestState({ phase: "ok" });
    } catch (error) {
      setTestState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  function handleLlmNext() {
    saveLlmDraft();
    setStep(2);
  }

  function handleCreateCharacter() {
    const name = charName.trim();
    if (!name) return;
    createCharacter(name);
    setCreatedName(name);
    setStep(3);
  }

  return (
    <div class="ob-overlay">
      <div class="ob-card" role="dialog" aria-modal="true" aria-label="はじめてのセットアップ">
        <button class="ob-close" type="button" onClick={props.onClose} title="閉じる" aria-label="閉じる">
          <X size={18} />
        </button>

        {step === 0 && (
          <div class="ob-body">
            <div class="ob-hero">
              <Sparkles size={36} />
            </div>
            <h2 class="ob-title">TC Town へようこそ！</h2>
            <p class="ob-text">
              TC Town は、自分だけのキャラクターを作って育てて、会話や通話を楽しむアプリです。
              VRMモデルをアバターにすることもできます。
            </p>
            <p class="ob-text">
              まずは2つだけ準備しましょう：<strong>LLMの接続設定</strong>と<strong>最初のキャラクター</strong>です。
              どちらもあとから設定画面・キャラクター画面でいつでも変更できます。
            </p>
          </div>
        )}

        {step === 1 && (
          <div class="ob-body">
            <div class="ob-step-head">
              <Cpu size={22} />
              <h2 class="ob-title">LLMの接続設定</h2>
            </div>
            <p class="ob-text">
              キャラクターとの会話に使う LLM を設定します。OpenAI 互換の API ならどれでも使えます
              （OpenAI、LM Studio、Ollama など）。
            </p>

            <div class="ob-field">
              <label class="ob-label">ベースURL</label>
              <input
                class="ob-input"
                type="text"
                placeholder="例: https://api.openai.com/v1 / http://localhost:1234/v1"
                value={llm.baseUrl}
                onInput={(e) => updateLlm({ baseUrl: inputValue(e) })}
              />
            </div>
            <div class="ob-field">
              <label class="ob-label">APIキー（不要なら空欄）</label>
              <input
                class="ob-input"
                type="password"
                placeholder="sk-..."
                value={llm.apiKey}
                onInput={(e) => updateLlm({ apiKey: inputValue(e) })}
              />
            </div>
            <div class="ob-field">
              <label class="ob-label">モデル</label>
              <OptionsPicker
                value={llm.model}
                placeholder="例: gpt-4o-mini"
                baseUrl={llm.baseUrl}
                apiKey={llm.apiKey}
                onChange={(model) => updateLlm({ model })}
                useOptions={useModelOptions}
                itemLabel="モデル"
                classNames={MODEL_PICKER_CLASS_NAMES}
              />
            </div>

            <div class="ob-test-row">
              <button
                class="ob-btn"
                type="button"
                onClick={() => void handleTest()}
                disabled={testState.phase === "busy" || !llm.baseUrl.trim()}
              >
                {testState.phase === "busy" ? <span class="spinner" /> : <Plug size={16} />}
                {testState.phase === "busy" ? "接続中..." : "接続テスト"}
              </button>
              {testState.phase === "ok" && (
                <span class="ob-test-ok">
                  <Check size={16} />
                  接続できました！
                </span>
              )}
            </div>
            {testState.phase === "error" && <p class="ob-error">接続に失敗しました: {testState.message}</p>}
          </div>
        )}

        {step === 2 && (
          <div class="ob-body">
            <div class="ob-step-head">
              <UserPlus size={22} />
              <h2 class="ob-title">最初のキャラクターを作る</h2>
            </div>
            <p class="ob-text">
              名前を決めるだけでOK。性格や口調はあとから自由に書けますし、
              「成長インタビュー」でAIと話しながら育てることもできます。
            </p>
            <div class="ob-field">
              <label class="ob-label">キャラクターの名前</label>
              <input
                class="ob-input"
                type="text"
                placeholder="例: ミナト"
                value={charName}
                onInput={(e) => setCharName(inputValue(e))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateCharacter();
                }}
              />
            </div>
            <button class="ob-btn ob-btn-accent" type="button" onClick={handleCreateCharacter} disabled={!charName.trim()}>
              <UserPlus size={16} />
              作成して次へ
            </button>
          </div>
        )}

        {step === 3 && (
          <div class="ob-body">
            <div class="ob-step-head">
              <Check size={22} />
              <h2 class="ob-title">準備完了です！</h2>
            </div>
            {createdName && (
              <p class="ob-text">
                「{createdName}」を作成しました。キャラクター画面でシートを書き込んでいきましょう。
              </p>
            )}
            <ul class="ob-feature-list">
              <li>
                <Users size={16} />
                <span>
                  <strong>キャラクター</strong> — シート編集、成長インタビュー、キャラ完成度の評価
                </span>
              </li>
              <li>
                <Globe size={16} />
                <span>
                  <strong>世界観</strong> — キャラに奥行きを与える舞台設定。AIでふくらませることもできます
                </span>
              </li>
              <li>
                <MessagesSquare size={16} />
                <span>
                  <strong>会話</strong> — キャラクター同士やあなたを交えたテキスト会話
                </span>
              </li>
              <li>
                <Phone size={16} />
                <span>
                  <strong>通話</strong> — 音声での会話（設定画面で TTS/STT を設定してください）
                </span>
              </li>
            </ul>
            <p class="ob-text ob-text-subtle">編集はすべて自動保存されます。それでは、楽しんでください！</p>
          </div>
        )}

        <footer class="ob-footer">
          <div class="ob-dots" aria-hidden="true">
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <span key={i} class={"ob-dot" + (i === step ? " is-active" : "")} />
            ))}
          </div>
          <div class="ob-footer-actions">
            {step > 0 && step < 3 && (
              <button class="ob-btn" type="button" onClick={() => setStep(step - 1)}>
                <ArrowLeft size={16} />
                戻る
              </button>
            )}
            {step === 0 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={() => setStep(1)}>
                はじめる
                <ArrowRight size={16} />
              </button>
            )}
            {step === 1 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={handleLlmNext}>
                保存して次へ
                <ArrowRight size={16} />
              </button>
            )}
            {step === 2 && (
              <button class="ob-btn" type="button" onClick={() => setStep(3)}>
                あとで作る
                <ArrowRight size={16} />
              </button>
            )}
            {step === 3 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={props.onClose}>
                <Check size={16} />
                完了
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

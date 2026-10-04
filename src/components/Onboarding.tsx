import { useState } from "preact/hooks";
import {
  Sparkles,
  UserPlus,
  Check,
  X,
  ArrowLeft,
  ArrowRight,
  Globe,
  Users,
  MessagesSquare,
  Phone,
} from "lucide-preact";
import { LlmSettings } from '@tik-choco/mistai/preact';
import { useAppSettings } from '../hooks/useAppSettings';
import { localSettingsAdapter, TASK_IDS } from '../lib/llmSettings';
import { aiMessages } from '../i18n/ai';
import { createCharacter } from '../lib/characterStorage';
import "../styles/onboarding.css";

// First-run wizard shown by app.tsx as a modal overlay: welcome -> LLM
// connection -> first character -> feature tour. Every step is skippable and
// closing at any point counts as "done" (the flag is owned by the caller via
// `onClose`) — the settings screen can re-open it any time.

const STEP_COUNT = 4;

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

export function Onboarding(props: { onClose: () => void }) {
  const [step, setStep] = useState(0);

  const { language } = useAppSettings();
  const t = aiMessages(language);
  const [charName, setCharName] = useState('');
  const [createdName, setCreatedName] = useState<string | null>(null);
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

        {step === 1 && <div class="ob-body ob-ai-settings"><LlmSettings locale={language} title={t.ai} localSettings={localSettingsAdapter} tasks={TASK_IDS.map(id => ({ id, label: t[id], reasoning: true }))} voice={{ tts: {}, stt: {} }} /></div>}

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
              <button class="ob-btn ob-btn-accent" type="button" onClick={() => setStep(2)}>
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

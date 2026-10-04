import { useEffect, useState } from 'preact/hooks';
import { LlmSettings } from '@tik-choco/mistai/preact';
import { emptyLlmConfig, loadLlmConfig, saveLlmConfig } from '@tik-choco/mistai/llm-config';
import { useAppSettings } from '../hooks/useAppSettings';
import { LANGUAGES, type Language, type Theme } from '../lib/appSettings';
import { requestOnboarding } from '../lib/onboarding';
import { EXPRESSION_MODES, TASK_IDS, loadProviderSettings, localSettingsAdapter, saveProviderSettings, subscribeProviderSettings, type ProviderSettings } from '../lib/llmSettings';
import { getExpressionFeatureStatus, subscribeExpressionFeatureStatus } from '../lib/emotionClassifier';
import { aiMessages } from '../i18n/ai';
import '../styles/settings.css';
import '../styles/settings-llm.css';

export function SettingsView() {
  const { theme, setTheme, language, setLanguage } = useAppSettings();
  const t = aiMessages(language);
  const [section, setSection] = useState<'appearance' | 'ai' | 'onboarding'>(() => {
    const old = localStorage.getItem('tc-town:settings-tab');
    return old === 'appearance' || old === 'onboarding' ? old : 'ai';
  });
  const [settings, setSettings] = useState(loadProviderSettings);
  const [expression, setExpression] = useState(getExpressionFeatureStatus);
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  useEffect(() => subscribeProviderSettings(() => setSettings(loadProviderSettings())), []);
  useEffect(() => subscribeExpressionFeatureStatus(() => setExpression(getExpressionFeatureStatus())), []);
  useEffect(() => {
    const media = navigator.mediaDevices;
    const refresh = () => { void media?.enumerateDevices().then(items => setDevices(items.filter(d => d.kind === 'audioinput').map(d => ({ deviceId: d.deviceId, label: d.label })))).catch(() => {}); };
    refresh(); media?.addEventListener('devicechange', refresh);
    return () => media?.removeEventListener('devicechange', refresh);
  }, []);
  function update(patch: Partial<ProviderSettings>) { saveProviderSettings({ ...loadProviderSettings(), ...patch }); }
  return <div class="tc-settings"><div class="tc-settings-inner">
    <h1 class="tc-settings-title">{t.settings}</h1>
    <div class="tc-settings-tabs" role="tablist">
      {(['appearance', 'ai', 'onboarding'] as const).map(id => <button type="button" role="tab" aria-selected={section === id} class={section === id ? 'tc-settings-tab tc-settings-tab--active' : 'tc-settings-tab'} onClick={() => { setSection(id); localStorage.setItem('tc-town:settings-tab', id); }}>{t[id]}</button>)}
    </div>
    {section === 'appearance' && <section class="tc-settings-section" role="tabpanel">
      <label class="tc-field"><span>{t.theme}</span><select value={theme} onChange={e => setTheme(e.currentTarget.value as Theme)}>{(['light', 'dark', 'system'] as const).map(value => <option value={value}>{t[value]}</option>)}</select></label>
      <label class="tc-field"><span>{t.language}</span><select value={language} onChange={e => setLanguage(e.currentTarget.value as Language)}>{LANGUAGES.map(value => <option value={value}>{{ ja: '日本語', en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文' }[value]}</option>)}</select></label>
    </section>}
    {section === 'onboarding' && <section class="tc-settings-section" role="tabpanel"><button class="tc-btn" onClick={requestOnboarding}>{t.guide}</button></section>}
    {section === 'ai' && <LlmSettings locale={language} title={t.ai} localSettings={localSettingsAdapter}
      tasks={TASK_IDS.map(id => ({ id, label: t[id], reasoning: true }))}
      voice={{ tts: {}, stt: {} }}
      mic={{ deviceId: settings.micDeviceId, onChange: micDeviceId => update({ micDeviceId }), devices, labelsHidden: devices.some(d => !d.label), onUnlockLabels: async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(track => track.stop());
        setDevices((await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput').map(d => ({ deviceId: d.deviceId, label: d.label })));
      } }}
      extraSections={tab => tab === 'tasks' ? <section class="tc-ai-extra">
        <label class="tc-field"><span>{t.expression}</span><select value={settings.expressionMode} onChange={e => { update({ expressionMode: e.currentTarget.value as ProviderSettings['expressionMode'] }); setExpression(getExpressionFeatureStatus()); }}>{EXPRESSION_MODES.map(mode => <option value={mode}>{t[mode]}</option>)}</select></label>
        <p class="tc-hint">{t.expressionState}: {expression.mode === 'off' ? t.off : expression.autoDisabled ? t.slow : t.active} · {t.samples}: {expression.sampleCount} · {t.latency}: {expression.avgLatencyMs}ms</p>
        <label class="tc-field"><span>{t.speed}</span><input type="number" min="0.25" max="4" step="0.05" defaultValue={(loadLlmConfig() ?? emptyLlmConfig()).tts?.speed ?? 1} onChange={e => { const cfg = loadLlmConfig() ?? emptyLlmConfig(); if (cfg.tts) { cfg.tts.speed = Math.min(4, Math.max(0.25, Number(e.currentTarget.value) || 1)); saveLlmConfig(cfg); } }} /></label>
        <label class="tc-field"><span>{t.silence}</span><input type="number" min="0" max="5" step="0.1" value={settings.sttSilenceDuration} onChange={e => update({ sttSilenceDuration: Math.max(0, Number(e.currentTarget.value) || 0) })} /></label>
        <label class="tc-field"><span>{t.threshold}</span><input type="number" min="0" max="0.5" step="0.005" value={settings.micThreshold} onChange={e => update({ micThreshold: Math.min(0.5, Math.max(0, Number(e.currentTarget.value) || 0)) })} /></label>
        <label class="tc-role-head"><input type="checkbox" checked={settings.bargeInEnabled} onChange={e => update({ bargeInEnabled: e.currentTarget.checked })} /><span>{t.barge}</span></label>
      </section> : null} />}
  </div></div>;
}

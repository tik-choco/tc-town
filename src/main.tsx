import { render } from 'preact'
import '@tik-choco/mistai/ui.css'
import './index.css'
import { App } from './app.tsx'
import { AppSettingsProvider } from './hooks/useAppSettings'
import { loadAppSettings } from './lib/appSettings'
import { startCharacterIndexPublisher } from './lib/characterIndexPublisher'
import { startTownBackupPublisher } from './lib/townBackupPublisher'
import { writeAppManifest } from './lib/appManifest'
import { BUS_VERSION } from './lib/sharedBus'
import { migrateLegacyProviderSettingsToShared } from './lib/llmSettings'

// Applied synchronously before the first paint so there's no flash of the
// wrong theme while waiting for AppSettingsProvider's effect to run —
// AppSettingsProvider re-applies it on mount (and on every change), this is
// just to win the race against the initial render.
const initialTheme = loadAppSettings().theme
if (initialTheme !== 'system') {
  document.documentElement.setAttribute('data-theme', initialTheme)
}

// One-time (idempotent) migration of this app's legacy LLM/voice/network
// settings into the shared tc-shared-llm-config-v1 key. Must run before any
// view reads loadProviderSettings()/loadLlmConfig() — see lib/llmSettings.ts.
migrateLegacyProviderSettingsToShared()

render(
  <AppSettingsProvider>
    <App />
  </AppSettingsProvider>,
  document.getElementById('app')!,
)

startCharacterIndexPublisher()
startTownBackupPublisher()

writeAppManifest({
  app: 'tc-town',
  busVersion: BUS_VERSION,
  publishes: ['character-index', 'town-backup'],
  consumes: [],
  reads: [],
})

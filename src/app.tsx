import { useEffect, useState } from 'preact/hooks'
import { Users, Globe, MessagesSquare, Phone, Settings, Trees } from 'lucide-preact'
import { CharactersView } from './views/CharactersView'
import { WorldsView } from './views/WorldsView'
import { ChatView } from './views/ChatView'
import { VoiceView } from './views/VoiceView'
import { SettingsView } from './views/SettingsView'
import { CatalogView, setPendingCatalogShareCid } from './views/CatalogView'
import { Onboarding } from './components/Onboarding'
import { markOnboardingDone, shouldShowOnboarding, subscribeOnboardingRequests } from './lib/onboarding'
import { parseCatalogShareInput } from './lib/catalog'
import { listCharacters } from './lib/characterStorage'
import './app.css'

type View = 'characters' | 'worlds' | 'chat' | 'voice' | 'settings' | 'catalog'

// NAV id/label pairs are user-facing text only — the underlying view id stays
// 'catalog' (and CatalogView/catalog.ts/etc. keep their internal names) per
// the ひろば rename; only the displayed label and nav position change.
const NAV: Array<{ id: View; label: string; icon: typeof Users }> = [
  { id: 'characters', label: 'キャラクター', icon: Users },
  { id: 'worlds', label: '世界観', icon: Globe },
  { id: 'catalog', label: 'ひろば', icon: Trees },
  { id: 'chat', label: '会話', icon: MessagesSquare },
  { id: 'voice', label: '通話', icon: Phone },
  { id: 'settings', label: '設定', icon: Settings },
]

// A `#catalog=<cid>` share link (see lib/catalog.ts's shareLinkForCid) should
// land the user straight in the catalog (ひろば) view with the import
// pre-filled and running, rather than requiring them to navigate there and
// paste it in manually. Resolved once, synchronously, before first render so
// there's no flash of the default view; the cid itself is handed to
// CatalogView via a tiny module-level setter (see setPendingCatalogShareCid)
// since prop-threading it through the view-switch in <main> isn't worth the
// churn for a one-shot deep link.
//
// Precedence: (1) a share-link deep link always wins, (2) a brand-new user
// with zero characters lands on ひろば so they see what's possible before
// building their own, (3) everyone else lands on their character list.
function resolveInitialView(): View {
  const cid = parseCatalogShareInput(location.hash)
  if (cid) {
    setPendingCatalogShareCid(cid)
    history.replaceState(null, '', location.pathname + location.search)
    return 'catalog'
  }
  if (listCharacters().length === 0) return 'catalog'
  return 'characters'
}

export function App() {
  const [view, setView] = useState<View>(() => resolveInitialView())

  // First-run wizard: shown once on a fresh install, and re-openable from the
  // settings screen. Closing it (any path) marks onboarding done.
  const [showOnboarding, setShowOnboarding] = useState(() => shouldShowOnboarding())
  useEffect(() => subscribeOnboardingRequests(() => setShowOnboarding(true)), [])

  function closeOnboarding() {
    markOnboardingDone()
    setShowOnboarding(false)
  }

  return (
    <div class="tc-town-shell">
      <header class="tc-town-header">
        <h1>TC Town</h1>
        <nav class="tc-town-nav">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-current={view === id ? 'page' : undefined}
              aria-label={label}
              title={label}
              onClick={() => setView(id)}
            >
              <Icon size={16} aria-hidden="true" />
              {/* Wrapped so shell.css can hide just the text at narrow widths
                  (icon-only nav) while aria-label/title above keep the label
                  available to assistive tech and mouse hover. */}
              <span class="tc-town-nav-label">{label}</span>
            </button>
          ))}
        </nav>
      </header>
      <main class="tc-town-main">
        {/* Mounted on demand — switching views tears the previous one down so
            in-flight calls/mic streams are released by each view's cleanup.
            key={view} forces this wrapper to remount on every switch so the
            enter animation (see .tc-town-view in shell.css) replays. */}
        <div key={view} class="tc-town-view">
          {view === 'characters' && <CharactersView />}
          {view === 'worlds' && <WorldsView />}
          {view === 'chat' && <ChatView />}
          {view === 'voice' && <VoiceView />}
          {view === 'catalog' && <CatalogView />}
          {view === 'settings' && <SettingsView />}
        </div>
      </main>
      {showOnboarding && <Onboarding onClose={closeOnboarding} />}
    </div>
  )
}

// Cross-view navigation requests — lets a view (e.g. a CTA button inside
// CatalogView's empty state) ask the app shell to switch to a different
// view, without threading a setView callback down through every view's
// props. Same same-tab request-channel pattern as lib/onboarding.ts.

/** The set of top-level views the app shell can switch between. */
export type AppView = 'characters' | 'worlds' | 'chat' | 'voice' | 'settings' | 'catalog'

// --- Navigation requests (any view -> app shell) ----------------------------

const listeners = new Set<(view: AppView) => void>();

/** App shell subscribes once; returns an unsubscribe fn. */
export function subscribeNavigationRequests(listener: (view: AppView) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Asks the app shell to switch to the given view (e.g. from a CTA button). */
export function requestNavigate(view: AppView): void {
  for (const listener of listeners) {
    try {
      listener(view);
    } catch (error) {
      console.warn("navigation: listener threw", error);
    }
  }
}

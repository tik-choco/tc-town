// Tiny same-tab notification bus with zero imports, so app-local settings
// modules (appSettings.ts, llmSettings.ts) can announce "something saved"
// without importing lib/townBackupPublisher.ts directly — that publisher
// itself imports appSettings/llmSettings (via lib/exportImport.ts's
// buildExportBundle), so a direct import back the other way would form an
// import cycle. This module sits below both, dependency-free, and
// townBackupPublisher.ts subscribes to it instead.
//
// Same listener-set pattern as characterStorage.ts's subscribeCharacters,
// minus the cross-tab `storage` event wiring — this is purely a same-tab
// "a save just happened" signal, not a data store of its own.

const listeners = new Set<() => void>();

/** Notifies every subscriber that some app-local setting was just saved. Never throws. */
export function notifyAppDataChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn("appDataChangeBus: listener threw", error);
    }
  }
}

/** Subscribes to app-data-changed notifications. Returns an unsubscribe function. */
export function subscribeAppDataChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

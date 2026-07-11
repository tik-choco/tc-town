// General app preferences (theme, UI language), persisted to localStorage.
// JSON in localStorage, parsed defensively (never trust stored content),
// immutable update helpers.

import { notifyAppDataChanged } from "./appDataChangeBus";

const SETTINGS_KEY = "tc-town:app-settings";

/** "system" follows the OS's prefers-color-scheme; light/dark are explicit overrides. */
export type Theme = "light" | "dark" | "system";
export type Language = "ja" | "en";

export const LANGUAGES: Language[] = ["ja", "en"];

export interface AppSettings {
  theme: Theme;
  language: Language;
}

// Light is the deliberate default regardless of OS preference — see the
// data-theme override in index.css.
export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: "light",
  language: "ja",
};

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as string[]).includes(value);
}

function isAppSettings(value: unknown): value is AppSettings {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return isTheme(s.theme) && isLanguage(s.language);
}

/** Exported for lib/exportImport.ts — sanitizes a parsed app-settings record the same defensive way as {@link loadAppSettings}. */
export function sanitizeAppSettings(value: unknown): AppSettings {
  return isAppSettings(value) ? value : DEFAULT_APP_SETTINGS;
}

export function loadAppSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_APP_SETTINGS;
    const parsed = JSON.parse(raw);
    return isAppSettings(parsed) ? parsed : DEFAULT_APP_SETTINGS;
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function saveAppSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  notifyAppDataChanged();
}

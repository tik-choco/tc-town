import catalogs from './ai.json';
import type { Language } from '../lib/appSettings';
export function aiMessages(locale: Language) { return catalogs[locale]; }

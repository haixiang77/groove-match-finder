// @ts-check
/**
 * User settings (API keys, filtering thresholds, weights). Stored only in this
 * browser — localStorage when "remember" is on, otherwise sessionStorage.
 */
import { s } from './schema.js';
import { DEFAULT_WEIGHTS } from './core/similarity.js';

const KEY = 'refscope.settings.v1';

const weight = s.number({ min: 0, max: 1 });

export const SettingsSchema = s.object({
  auddToken: s.string().catch(''),
  acrHost: s.string().catch(''),
  acrKey: s.string().catch(''),
  acrSecret: s.string().catch(''),
  lastfmKey: s.string().catch(''),
  geminiKey: s.string().catch(''),
  geminiModel: s.string({ min: 1 }).catch('gemini-3.5-flash'),
  corsProxy: s.string().catch(''),
  country: s.string({ min: 2, max: 2 }).catch('JP'),
  poolSize: s.number({ min: 8, max: 40, int: true }).catch(24),
  topN: s.number({ min: 3, max: 15, int: true }).catch(8),
  minScore: s.number({ min: 0, max: 1 }).catch(0.65),
  analysisWindowSec: s.number({ min: 15, max: 90 }).catch(30),
  useGeminiSuggestions: s.boolean().catch(true),
  geminiAudioInExplain: s.boolean().catch(true),
  persist: s.boolean().catch(true),
  weights: s
    .object({ rhythm: weight.catch(DEFAULT_WEIGHTS.rhythm), tempo: weight.catch(DEFAULT_WEIGHTS.tempo), groove: weight.catch(DEFAULT_WEIGHTS.groove), timbre: weight.catch(DEFAULT_WEIGHTS.timbre), key: weight.catch(DEFAULT_WEIGHTS.key) })
    .catch({ ...DEFAULT_WEIGHTS }),
});

/** @typedef {ReturnType<typeof SettingsSchema.parse>} Settings */

/** @returns {Settings} */
export function defaultSettings() {
  return SettingsSchema.parse({});
}

/** @returns {Settings} */
export function loadSettings() {
  for (const store of [safeStorage('localStorage'), safeStorage('sessionStorage')]) {
    try {
      const raw = store?.getItem(KEY);
      if (raw) return SettingsSchema.parse(JSON.parse(raw));
    } catch {
      /* corrupted / blocked storage → defaults */
    }
  }
  return defaultSettings();
}

/** @param {Settings} settings */
export function saveSettings(settings) {
  const clean = SettingsSchema.parse(settings);
  const local = safeStorage('localStorage');
  const session = safeStorage('sessionStorage');
  try {
    if (clean.persist) {
      local?.setItem(KEY, JSON.stringify(clean));
      session?.removeItem(KEY);
    } else {
      session?.setItem(KEY, JSON.stringify(clean));
      local?.removeItem(KEY);
    }
  } catch {
    /* storage full / blocked: settings stay in memory for this page */
  }
  return clean;
}

/** @param {'localStorage' | 'sessionStorage'} name @returns {Storage | null} */
function safeStorage(name) {
  try {
    return /** @type {any} */ (globalThis)[name] ?? null;
  } catch {
    return null;
  }
}

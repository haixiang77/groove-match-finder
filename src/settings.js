// @ts-check
/**
 * User settings (API keys, filtering thresholds, weights). Stored only in this
 * browser — localStorage when "remember" is on, otherwise sessionStorage.
 *
 * Saved payloads come from older app versions (or hand edits), so loading is
 * defensive: `migrateSettings` never throws, and each invalid field falls back
 * to its own default instead of discarding everything.
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

const NUMBER_FIELDS = ['poolSize', 'topN', 'minScore', 'analysisWindowSec'];
const BOOLEAN_FIELDS = ['useGeminiSuggestions', 'geminiAudioInExplain', 'persist'];
const WEIGHT_KEYS = ['rhythm', 'tempo', 'groove', 'timbre', 'key'];
/** Model ids are URL path segments: letters, digits and . _ - : only. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Numeric strings ("24", " 0.7 ") → numbers; anything else is left for the schema to reject. @param {unknown} v */
function toNumber(v) {
  return typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
}

/** @param {unknown} v */
function toBoolean(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/**
 * Validate / migrate an arbitrary saved value into Settings. Never throws:
 * non-objects yield all defaults, and each invalid field falls back alone.
 * @param {unknown} raw
 * @returns {Settings}
 */
export function migrateSettings(raw) {
  try {
    if (!isObject(raw)) return defaultSettings();
    /** @type {Record<string, unknown>} */
    const o = { ...raw };
    for (const k of NUMBER_FIELDS) if (k in o) o[k] = toNumber(o[k]);
    for (const k of BOOLEAN_FIELDS) if (k in o) o[k] = toBoolean(o[k]);
    if (typeof o.country === 'string') o.country = o.country.trim().toUpperCase();
    if ('geminiModel' in o) {
      const m = typeof o.geminiModel === 'string' ? o.geminiModel.trim().replace(/^models\//, '') : '';
      o.geminiModel = MODEL_ID.test(m) ? m : undefined; // free-text junk / wrong type → default
    }
    if (isObject(o.weights)) {
      const w = { ...o.weights };
      for (const k of WEIGHT_KEYS) if (k in w) w[k] = toNumber(w[k]);
      o.weights = w;
    }
    return SettingsSchema.parse(o);
  } catch {
    return defaultSettings();
  }
}

/** @returns {Settings} */
export function loadSettings() {
  for (const store of [safeStorage('localStorage'), safeStorage('sessionStorage')]) {
    try {
      const raw = store?.getItem(KEY);
      if (raw) return migrateSettings(JSON.parse(raw));
    } catch {
      /* corrupted / blocked storage → try next store, then defaults */
    }
  }
  return defaultSettings();
}

/** @param {Settings} settings */
export function saveSettings(settings) {
  const clean = migrateSettings(settings);
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

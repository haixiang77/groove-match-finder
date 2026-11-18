// @ts-check
/**
 * Binds the settings <dialog> form to the Settings object.
 */
import { defaultSettings, saveSettings } from '../settings.js';

/** @typedef {import('../settings.js').Settings} Settings */

const TEXT_FIELDS = /** @type {const} */ (['auddToken', 'acrHost', 'acrKey', 'acrSecret', 'lastfmKey', 'geminiKey', 'geminiModel', 'corsProxy', 'country']);
const NUM_FIELDS = /** @type {const} */ (['poolSize', 'topN', 'analysisWindowSec']);
const BOOL_FIELDS = /** @type {const} */ (['useGeminiSuggestions', 'geminiAudioInExplain', 'persist']);
const WEIGHT_KEYS = /** @type {const} */ (['rhythm', 'tempo', 'groove', 'timbre', 'key']);

/**
 * @param {HTMLFormElement} form
 * @param {() => Settings} get
 * @param {(s: Settings) => void} set
 */
export function bindSettingsForm(form, get, set) {
  /** @param {string} name */
  const field = (name) => /** @type {HTMLInputElement | HTMLSelectElement | null} */ (form.elements.namedItem(name));

  /** @param {Settings} st */
  const fill = (st) => {
    for (const k of TEXT_FIELDS) {
      const el = field(k);
      if (el) el.value = st[k];
    }
    for (const k of NUM_FIELDS) {
      const el = field(k);
      if (el) el.value = String(st[k]);
    }
    const ms = field('minScore');
    if (ms) ms.value = String(Math.round(st.minScore * 100));
    for (const k of BOOL_FIELDS) {
      const el = /** @type {HTMLInputElement | null} */ (field(k));
      if (el) el.checked = st[k];
    }
    for (const k of WEIGHT_KEYS) {
      const el = /** @type {HTMLInputElement | null} */ (field(`w.${k}`));
      if (el) {
        el.value = String(st.weights[k]);
        syncOutput(el);
      }
    }
  };

  /** @returns {Settings} */
  const read = () => {
    /** @type {Record<string, unknown>} */
    const raw = { ...get() };
    for (const k of TEXT_FIELDS) raw[k] = field(k)?.value.trim() ?? '';
    for (const k of NUM_FIELDS) raw[k] = Number(field(k)?.value);
    raw.minScore = Number(field('minScore')?.value) / 100;
    for (const k of BOOL_FIELDS) raw[k] = /** @type {HTMLInputElement | null} */ (field(k))?.checked ?? false;
    raw.weights = Object.fromEntries(WEIGHT_KEYS.map((k) => [k, Number(field(`w.${k}`)?.value)]));
    raw.country = String(raw.country).toUpperCase();
    return saveSettings(/** @type {Settings} */ (raw));
  };

  form.addEventListener('input', (ev) => {
    const t = /** @type {HTMLInputElement} */ (ev.target);
    if (t.type === 'range') syncOutput(t);
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    set(read());
    /** @type {HTMLDialogElement | null} */ (form.closest('dialog'))?.close();
  });
  form.querySelector('#settings-reset')?.addEventListener('click', () => {
    const keep = get().persist;
    fill({ ...defaultSettings(), persist: keep });
  });
  const dialog = /** @type {HTMLDialogElement | null} */ (form.closest('dialog'));
  dialog?.addEventListener('close', () => fill(get()));
  fill(get());
  return { fill };
}

/** @param {HTMLInputElement} range */
function syncOutput(range) {
  const out = range.parentElement?.querySelector('output');
  if (out) out.textContent = Number(range.value).toFixed(2);
}

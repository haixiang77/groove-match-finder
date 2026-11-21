import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, loadSettings, migrateSettings, saveSettings } from '../src/settings.js';

const D = defaultSettings();

/** Install a fake localStorage / sessionStorage holding `raw` under the settings key. */
function withStorage(raw, fn) {
  const make = (value) => ({ getItem: () => value, setItem() {}, removeItem() {} });
  const saved = { l: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), s: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage') };
  Object.defineProperty(globalThis, 'localStorage', { value: make(raw), configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: make(null), configurable: true });
  try {
    return fn();
  } finally {
    for (const [k, d] of [['localStorage', saved.l], ['sessionStorage', saved.s]]) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
}

test('non-object / corrupt payloads give all defaults and never throw', () => {
  for (const raw of [null, undefined, 0, 'x', true, [], [1, 2], () => 1]) assert.deepEqual(migrateSettings(raw), D);
});

test('corrupt JSON in storage falls back to defaults', () => {
  for (const raw of ['{', '{"poolSize":', 'null', '[]', '"x"', 'undefined', '{"a":1}}']) {
    assert.deepEqual(withStorage(raw, () => loadSettings()), D, raw);
  }
});

test('storage that throws on access falls back to defaults', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true });
  try {
    assert.deepEqual(loadSettings(), D);
  } finally {
    saved ? Object.defineProperty(globalThis, 'localStorage', saved) : delete globalThis.localStorage;
  }
});

test('legacy payload: older field set keeps valid fields, defaults the rest', () => {
  const r = migrateSettings({ lastfmKey: 'abc', topN: 5, obsoleteField: 'zzz' });
  assert.equal(r.lastfmKey, 'abc');
  assert.equal(r.topN, 5);
  assert.equal(r.poolSize, D.poolSize);
  assert.deepEqual(r.weights, D.weights);
});

test('unknown extra fields are stripped', () => {
  const r = migrateSettings({ topN: 6, foo: 1, nested: { a: 1 } });
  assert.equal(r.topN, 6);
  assert.equal('foo' in r, false);
  assert.equal('nested' in r, false);
});

test('numbers saved as strings are migrated to numbers', () => {
  const r = migrateSettings({ poolSize: '16', topN: ' 5 ', minScore: '0.7', analysisWindowSec: '45', weights: { rhythm: '0.5' } });
  assert.equal(r.poolSize, 16);
  assert.equal(r.topN, 5);
  assert.equal(r.minScore, 0.7);
  assert.equal(r.analysisWindowSec, 45);
  assert.equal(r.weights.rhythm, 0.5);
});

test('booleans saved as strings are migrated; other junk falls back per-field', () => {
  const r = migrateSettings({ persist: 'false', useGeminiSuggestions: 'true', geminiAudioInExplain: 'maybe' });
  assert.equal(r.persist, false);
  assert.equal(r.useGeminiSuggestions, true);
  assert.equal(r.geminiAudioInExplain, D.geminiAudioInExplain);
});

test('wrong types and out-of-range values fall back individually', () => {
  const r = migrateSettings({ poolSize: 'abc', topN: 99, minScore: -1, analysisWindowSec: null, lastfmKey: { x: 1 }, persist: 1, topN2: 1, geminiKey: 'keep-me' });
  assert.equal(r.poolSize, D.poolSize);
  assert.equal(r.topN, D.topN);
  assert.equal(r.minScore, D.minScore);
  assert.equal(r.analysisWindowSec, D.analysisWindowSec);
  assert.equal(r.lastfmKey, '');
  assert.equal(r.persist, D.persist);
  assert.equal(r.geminiKey, 'keep-me');
});

test('weights: invalid container → defaults; one bad weight → only that default', () => {
  for (const w of [null, [], 'x', 5]) assert.deepEqual(migrateSettings({ weights: w }).weights, D.weights);
  const r = migrateSettings({ weights: { rhythm: 0.9, tempo: 'bad', groove: 7, timbre: null } });
  assert.equal(r.weights.rhythm, 0.9);
  assert.equal(r.weights.tempo, D.weights.tempo);
  assert.equal(r.weights.groove, D.weights.groove);
  assert.equal(r.weights.timbre, D.weights.timbre);
  assert.equal(r.weights.key, D.weights.key);
});

test('geminiModel free text: valid ids kept (trimmed, models/ stripped), junk → default', () => {
  assert.equal(migrateSettings({ geminiModel: ' gemini-2.5-pro ' }).geminiModel, 'gemini-2.5-pro');
  assert.equal(migrateSettings({ geminiModel: 'models/gemini-flash-latest' }).geminiModel, 'gemini-flash-latest');
  for (const m of ['', '   ', 'gemini 2.5 pro!', '日本語', '../x', 123, null, {}]) assert.equal(migrateSettings({ geminiModel: m }).geminiModel, D.geminiModel, String(m));
});

test('country is normalised; invalid → JP', () => {
  assert.equal(migrateSettings({ country: 'us' }).country, 'US');
  assert.equal(migrateSettings({ country: 'USA' }).country, 'JP');
  assert.equal(migrateSettings({ country: 5 }).country, 'JP');
});

test('a fully valid payload round-trips unchanged; save→load is stable', () => {
  const custom = { ...D, topN: 5, geminiKey: 'k', country: 'US', weights: { ...D.weights, rhythm: 0.1 } };
  assert.deepEqual(migrateSettings(custom), custom);
  assert.deepEqual(saveSettings(custom), custom);
  assert.deepEqual(withStorage(JSON.stringify(custom), () => loadSettings()), custom);
});

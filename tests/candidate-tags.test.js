import test from 'node:test';
import assert from 'node:assert/strict';
import { rerank, genreGuess } from '../src/core/rerank.js';
import { analyzeAudio } from '../src/audio/analyzer.js';
import { synthLoop } from './synth.js';
import { clearCandidateTagCache, getCandidateTags } from '../src/services/lastfm.js';

const house = new Set(['house']);
/** @param {string} title @param {number} score @param {any} features @param {{name: string, weight: number}[]} [tags] */
const sc = (title, score, features, tags) => ({
  candidate: { key: title, artist: `Artist ${title}`, title, sources: [], weight: 1, tags },
  features,
  score,
  breakdown: {},
  bandSimilarity: { kick: 0, snare: 0, hat: 0 },
  shiftSteps: 0,
  tempoRatio: 1,
  reasons: [],
  passed: true,
});
const names = (list) => list.map((r) => r.candidate.title);

// Free-BGM-like material: an identical four-on-the-floor loop (same acoustic features) for every candidate.
const loop = synthLoop({ bpm: 124, bars: 8, kick: [0, 4, 8, 12], hat: [2, 6, 10, 14], snare: [4, 12], seed: 7 });
const feats = analyzeAudio(loop.samples ?? loop, loop.sr ?? 22050);

test('tag-derived lineage: matching tags rise, mismatching tags fall in the ranking', () => {
  const list = [
    sc('jazzy', 0.8, feats, [{ name: 'jazz', weight: 1 }, { name: 'smooth jazz', weight: 0.6 }]),
    sc('mid', 0.79, feats, [{ name: 'house', weight: 0.5 }]),
    sc('housey', 0.77, feats, [{ name: 'house', weight: 1 }, { name: 'deep house', weight: 0.7 }]),
  ];
  const out = rerank(list, house);
  assert.deepEqual(names(out), ['mid', 'housey', 'jazzy']);
  assert.ok(names(out).indexOf('housey') < names(out).indexOf('jazzy'));
  const top = out.find((r) => r.candidate.title === 'housey');
  const low = out.find((r) => r.candidate.title === 'jazzy');
  assert.ok(top.lineageBoost > 1 && low.lineageBoost < 1);
  assert.ok(low.reasons.some((r) => r.includes('Last.fm タグ由来')));
});

test('no tags (or unmappable tags) fall back to the acoustic skeleton', () => {
  assert.equal(genreGuess(sc('a', 0.8, feats, undefined)).source, 'skeleton');
  assert.equal(genreGuess(sc('b', 0.8, feats, [{ name: 'zzz-unknown-tag', weight: 1 }])).source, 'skeleton');
  assert.equal(genreGuess(sc('c', 0.8, feats, [{ name: 'house', weight: 1 }])).source, 'tags');
  const a = rerank([sc('a', 0.8, feats)], house)[0];
  const b = rerank([sc('b', 0.8, feats, [{ name: 'zzz-unknown-tag', weight: 1 }])], house)[0];
  assert.equal(a.lineageBoost, b.lineageBoost);
  const none = rerank([sc('n', 0.8, {})], house)[0];
  assert.equal(none.lineageBoost, 1, 'nothing known stays neutral');
});

/** Stub fetch with a handler; returns call log. */
function stubFetch(handler) {
  const orig = globalThis.fetch;
  const log = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    log.push(u.searchParams.get('method'));
    return handler(u.searchParams.get('method'));
  };
  return { log, restore: () => (globalThis.fetch = orig) };
}
const tagsBody = (names) => new Response(JSON.stringify({ toptags: { tag: names.map((n, i) => ({ name: n, count: 100 - i })) } }), { status: 200 });

test('getCandidateTags: track tags suffice, result is cached and shared while in flight', async () => {
  clearCandidateTagCache();
  const s = stubFetch(() => tagsBody(['house', 'deep house', 'electronic']));
  try {
    const [a, b] = await Promise.all([getCandidateTags('A', 'T', 'key'), getCandidateTags('a', 't', 'key')]);
    assert.deepEqual(a, b);
    assert.equal(a.length, 3);
    await getCandidateTags('A', 'T', 'key');
    assert.deepEqual(s.log, ['track.getTopTags']);
  } finally {
    s.restore();
  }
});

test('getCandidateTags: few track tags are topped up with artist tags', async () => {
  clearCandidateTagCache();
  const s = stubFetch((m) => (m === 'track.getTopTags' ? tagsBody(['house']) : tagsBody(['techno', 'electronic'])));
  try {
    const r = await getCandidateTags('A2', 'T2', 'key');
    assert.deepEqual(r.map((t) => t.name), ['house', 'techno', 'electronic']);
    assert.deepEqual(s.log, ['track.getTopTags', 'artist.getTopTags']);
  } finally {
    s.restore();
  }
});

test('getCandidateTags: failure and missing key return null without throwing', async () => {
  clearCandidateTagCache();
  const s = stubFetch(() => new Response('{}', { status: 404 }));
  try {
    assert.equal(await getCandidateTags('A3', 'T3', 'key'), null);
    assert.equal(await getCandidateTags('A4', 'T4', ''), null);
    assert.deepEqual(s.log, ['track.getTopTags', 'artist.getTopTags']);
  } finally {
    s.restore();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artistTokens, sameArtist } from '../src/util.js';
import { CandidatePool, isLineageCandidate } from '../src/core/candidates.js';
import { rerank, lineageAffinity } from '../src/core/rerank.js';

/** @param {string} artist @param {string} title @param {number} score @param {string} [genre] */
const sc = (artist, title, score, genre) => ({
  candidate: { key: `${artist}|${title}`, artist, title, genre, sources: [], weight: 1 },
  features: /** @type {any} */ ({}),
  score,
  breakdown: /** @type {any} */ ({}),
  bandSimilarity: { kick: 0, snare: 0, hat: 0 },
  shiftSteps: 0,
  tempoRatio: 1,
  reasons: [],
  passed: score >= 0.5,
});
/** @param {{candidate: {title: string}}[]} list */
const names = (list) => list.map((r) => r.candidate.title);
const none = new Set();

test('artist tokens: collaborations, feat. and unrelated artists', () => {
  assert.ok(sameArtist('TAKU INOUE & Mori Calliope', 'TAKU INOUE'));
  assert.ok(sameArtist('Artist feat. Someone', 'Artist'));
  assert.ok(sameArtist('Artist (feat. Someone)', 'artist'));
  assert.ok(sameArtist('A x B', 'B'));
  assert.ok(sameArtist('A、B', 'B'));
  assert.ok(sameArtist('A and B', 'A'));
  assert.ok(!sameArtist('Daft Punk', 'Justice'));
  assert.ok(!sameArtist('Maxwell', 'Max'));
  assert.deepEqual([...artistTokens('A & B, C')], ['a', 'b', 'c']);
});

test('rerank: same-artist crowd is progressively dampened and a different artist overtakes', () => {
  const list = [sc('A', 'a1', 0.9), sc('A', 'a2', 0.89), sc('A', 'a3', 0.88), sc('A & B', 'a4', 0.87), sc('C', 'c1', 0.8)];
  const out = rerank(list, none);
  const eff = Object.fromEntries(out.map((r) => [r.candidate.title, r.effectiveScore]));
  assert.ok(Math.abs(eff.a2 - 0.89 * 0.93) < 1e-9);
  assert.ok(Math.abs(eff.a3 - 0.88 * 0.86) < 1e-9);
  assert.ok(Math.abs(eff.a4 - 0.87 * 0.8) < 1e-9);
  assert.deepEqual(names(out), ['a1', 'a2', 'c1', 'a3', 'a4']);
  assert.equal(out[0].score, 0.9, 'acoustic score is preserved');
});

test('rerank: lineage boost promotes a close candidate over a different family', () => {
  const out = rerank([sc('X', 'other', 0.8, 'Jazz'), sc('Y', 'family', 0.78, 'Hip-Hop/Rap')], new Set(['hiphop']));
  assert.deepEqual(names(out), ['family', 'other']);
  assert.ok(Math.abs(out[0].lineageBoost - 1.01) < 1e-9, 'metadata-only in-lineage = affinity 0.5');
});

test('rerank: no genre info stays neutral; out-of-lineage metadata gets the 0.96 floor, order kept', () => {
  const out = rerank([sc('X', 'x', 0.8), sc('Y', 'y', 0.78, 'Jazz'), sc('Z', 'z', 0.7, 'Mystery')], new Set(['hiphop']));
  assert.deepEqual(names(out), ['x', 'y', 'z']);
  assert.ok(out.every((r) => r.reasons.length === 0));
  assert.equal(out[0].effectiveScore, 0.8);
  assert.ok(Math.abs(out[1].lineageBoost - 0.96) < 1e-9);
});

/** Inject genre guesses by title. @param {Record<string, {id: string, score: number}[]>} m */
const inject = (m) => ({ genreScoresOf: (/** @type {any} */ s) => m[s.candidate.title] ?? [] });
const fam = [{ id: 'house', score: 1 }];
const foreign = [{ id: 'jazz', score: 1 }];

test('lineageAffinity: full, none, partial (top-3 weighted share) and empty', () => {
  const set = new Set(['house', 'techno']);
  assert.equal(lineageAffinity([{ id: 'house', score: 0.5 }, { id: 'techno', score: 0.3 }], set), 1);
  assert.equal(lineageAffinity([{ id: 'jazz', score: 0.5 }], set), 0);
  const g = [{ id: 'jazz', score: 0.4 }, { id: 'house', score: 0.3 }, { id: 'pop', score: 0.2 }, { id: 'techno', score: 0.9 }];
  // top 3 = techno .9, jazz .4, house .3 -> in set 1.2 / 1.6
  assert.ok(Math.abs(lineageAffinity(g, set) - 0.75) < 1e-9);
  assert.equal(lineageAffinity([], set), 0);
});

test('rerank: audio affinity lets a same-family track overtake a slightly better foreign one', () => {
  const list = [sc('X', 'foreign', 0.8), sc('W', 'neutral', 0.79), sc('Y', 'family', 0.77)];
  const out = rerank(list, new Set(['house']), inject({ foreign, family: fam }));
  console.log('before:', names(list).join(' > '), '| eff:', out.map((r) => `${r.candidate.title}=${r.effectiveScore.toFixed(4)}`).join(' '));
  console.log('after: ', names(out).join(' > '));
  assert.deepEqual(names(out), ['family', 'neutral', 'foreign']);
  assert.ok(Math.abs(out[0].lineageBoost - 1.06) < 1e-9 && Math.abs(out[2].lineageBoost - 0.96) < 1e-9);
  assert.ok(out[0].reasons.some((r) => r.includes('引き上げ')));
  assert.ok(out[2].reasons.some((r) => r.includes('下げ')));
});

test('rerank: the factor cannot override a clear acoustic lead (>10 points)', () => {
  const out = rerank([sc('X', 'foreign', 0.9), sc('Y', 'family', 0.79)], new Set(['house']), inject({ foreign, family: fam }));
  assert.deepEqual(names(out), ['foreign', 'family']);
});

test('rerank: metadata fallback (no features, in-lineage genre) is not penalised', () => {
  const out = rerank([sc('X', 'x', 0.8, 'House')], new Set(['house']));
  assert.ok(out[0].lineageBoost >= 1);
  assert.ok(Math.abs(out[0].lineageBoost - 1.01) < 1e-9);
  // metadata floor also lifts a weak audio guess
  const lifted = rerank([sc('X', 'x', 0.8, 'House')], new Set(['house']), inject({ x: foreign }));
  assert.ok(Math.abs(lifted[0].lineageBoost - 1.01) < 1e-9);
});

test('rerank: reasons only when the adjustment is material', () => {
  // dampened but position unchanged -> no reason
  const same = rerank([sc('A', 'a1', 0.9), sc('A', 'a2', 0.85), sc('B', 'b', 0.5)], none);
  assert.deepEqual(names(same), ['a1', 'a2', 'b']);
  assert.ok(same.every((r) => r.reasons.length === 0));
  // dampened and pushed down 2 places -> reason on it only
  const moved = rerank([sc('A', 'a1', 0.9), sc('A', 'a2', 0.89), sc('A', 'a3', 0.88), sc('B', 'b1', 0.8), sc('C', 'c1', 0.79)], none);
  assert.deepEqual(names(moved), ['a1', 'a2', 'b1', 'c1', 'a3']);
  assert.equal(moved.find((r) => r.candidate.title === 'a3')?.reasons.length, 1);
  assert.equal(moved.find((r) => r.candidate.title === 'b1')?.reasons.length, 0);
  // boosted candidate jumping 2 places -> reason
  const boosted = rerank([sc('P', 'p', 0.8), sc('Q', 'q', 0.79), sc('R', 'r', 0.77)], new Set(['house']), inject({ r: fam }));
  assert.deepEqual(names(boosted), ['r', 'p', 'q']);
  assert.equal(boosted[0].reasons.length, 1);
  // pass/fail flip with minScore
  const flip = rerank([sc('R', 'r', 0.49)], new Set(['house']), { minScore: 0.5, ...inject({ r: fam }) });
  assert.equal(flip[0].passed, true);
  assert.equal(flip[0].reasons.length, 1);
});

test('regression: creator-circle tracks no longer fill the top 3; lineage beats a different family', () => {
  const list = [
    sc('TAKU INOUE', 'Mission', 0.91, 'Soundtrack'),
    sc('Different Family', 'Noise', 0.9, 'Country'),
    sc('TAKU INOUE & Mori Calliope', 'Collab', 0.89, 'Soundtrack'),
    sc('TAKU INOUE', 'Third', 0.88, 'Soundtrack'),
    sc('Roots Artist', 'Lineage', 0.87, 'Hip-Hop/Rap'),
  ];
  const out = rerank(list, new Set(['hiphop']));
  const top3 = out.slice(0, 3);
  assert.ok(!top3.every((r) => artistTokens(r.candidate.artist).has('taku inoue')), 'top 3 not all same creator');
  assert.ok(names(out).indexOf('Lineage') < names(out).indexOf('Noise'), 'lineage outranks different family');
  console.log('before:', names(list).join(' > '));
  console.log('after: ', names(out).join(' > '));
});

/** @param {string} artist @param {string} title @param {number} weight @param {string} source */
const cand = (artist, title, weight, source) => ({ artist, title, weight, sources: [source] });

test('shortlist: lineage candidates keep a reserved share against high-weight similar tracks', () => {
  const pool = new CandidatePool();
  for (let i = 0; i < 20; i++) pool.add(cand(`Sim${i}`, `t${i}`, 1.2, 'Last.fm 類似曲'));
  for (let i = 0; i < 10; i++) pool.add(cand(`Lin${i}`, `l${i}`, 0.3, 'iTunes 系統樹: ハウス（親）'));
  const out = pool.shortlist(10);
  assert.equal(out.length, 10);
  assert.equal(out.filter((c) => c.sources[0].includes('系統樹')).length, 4);
  // spare reserved slots are not wasted when lineage supply is short
  const small = new CandidatePool();
  for (let i = 0; i < 10; i++) small.add(cand(`Sim${i}`, `t${i}`, 1, 'Last.fm 類似曲'));
  small.add(cand('Only', 'one', 0.3, 'Gemini 提案'));
  assert.equal(small.shortlist(10).length, 10);
});

test('isLineageCandidate: similar-artist / similar-track sources are not lineage', () => {
  const mk = (/** @type {string} */ s) => /** @type {any} */ (cand('A', 't', 1, s));
  assert.equal(isLineageCandidate(mk('Last.fm 類似アーティスト')), false);
  assert.equal(isLineageCandidate(mk('Last.fm 類似曲')), false);
  assert.equal(isLineageCandidate(mk('Last.fm タグ: ハウス')), true);
  assert.equal(isLineageCandidate(mk('iTunes 系統樹: ハウス（親）')), true);
  assert.equal(isLineageCandidate(mk('Gemini 提案')), true);
});

test('shortlist: per-artist cap uses normalised tokens and local files stay', () => {
  const pool = new CandidatePool();
  pool.add(cand('TAKU INOUE', 'a', 1, 'Last.fm 類似曲'));
  pool.add(cand('TAKU INOUE & Mori Calliope', 'b', 0.9, 'Last.fm 類似曲'));
  pool.add(cand('Taku Inoue feat. X', 'c', 0.8, 'Last.fm 類似曲'));
  pool.add(cand('Other', 'd', 0.1, 'Last.fm 類似曲'));
  pool.add({ ...cand('Local', 'loc', 10, 'ローカルファイル'), localFile: /** @type {any} */ ({ name: 'x' }) });
  const titles = pool.shortlist(10).map((c) => c.title);
  assert.deepEqual(titles.sort(), ['a', 'b', 'd', 'loc']);
});

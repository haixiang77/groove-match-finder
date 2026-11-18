import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s, ValidationError } from '../src/schema.js';
import { normalizeText, parseFileName, textSimilarity, trackKey, RateLimiter, mapPool } from '../src/util.js';
import { CandidatePool } from '../src/core/candidates.js';
import { SettingsSchema } from '../src/settings.js';

test('schema: parse, strip unknown keys, report paths', () => {
  const S = s.object({ a: s.number({ min: 0 }), b: s.string().optional(), list: s.array(s.number()) });
  assert.deepEqual(S.parse({ a: 1, list: [1, 2], extra: true }), { a: 1, list: [1, 2] });
  assert.throws(() => S.parse({ a: -1, list: ['x'] }), (e) => e instanceof ValidationError && e.issues.length === 2 && e.issues[1].path === 'list[0]');
  assert.deepEqual(s.oneOrMany(s.object({ n: s.string() })).parse({ n: 'x' }), [{ n: 'x' }]);
  assert.equal(s.number().catch(7).parse('nope'), 7);
});

test('settings schema fills defaults and clamps invalid values', () => {
  const st = SettingsSchema.parse({ topN: 999, minScore: 'x', lastfmKey: 'abc' });
  assert.equal(st.topN, 8);
  assert.equal(st.minScore, 0.65);
  assert.equal(st.lastfmKey, 'abc');
  assert.equal(st.weights.rhythm, 0.4);
});

test('text normalisation and fuzzy matching', () => {
  assert.equal(normalizeText('Get Lucky (feat. Pharrell Williams) [Radio Edit]'), 'getlucky');
  assert.equal(trackKey('Daft Punk', 'Get Lucky - Radio Edit'), trackKey('daft punk', 'GET LUCKY'));
  assert.ok(textSimilarity('Blinding Lights', 'Blinding Lights - Remastered') > 0.8);
  assert.ok(textSimilarity('Blinding Lights', 'Save Your Tears') < 0.4);
  assert.deepEqual(parseFileName('01 - Daft Punk - Get Lucky.mp3'), { artist: 'Daft Punk', title: 'Get Lucky' });
  assert.equal(parseFileName('demo_final.wav'), null);
});

test('candidate pool: de-dupes, merges sources, excludes input, caps per artist', () => {
  const pool = new CandidatePool([trackKey('Me', 'Input Song')]);
  const c = (artist, title, w, src = 'x') => ({ key: trackKey(artist, title), artist, title, sources: [src], weight: w });
  pool.add(c('Me', 'Input Song', 5));
  pool.add(c('A', 'One', 1, 'lastfm'));
  pool.add(c('a', 'one (Remastered)', 1, 'gemini'));
  pool.add(c('A', 'Two', 0.9));
  pool.add(c('A', 'Three', 0.8));
  pool.add(c('B', 'Four', 0.5));
  assert.equal(pool.size, 4);
  const list = pool.shortlist(10, 2);
  assert.deepEqual(list.map((x) => x.title), ['One', 'Two', 'Four']);
  assert.deepEqual(list[0].sources, ['lastfm', 'gemini']);
});

test('rate limiter spaces calls after the burst', async () => {
  const rl = new RateLimiter({ capacity: 2, refillMs: 60 });
  const t0 = Date.now();
  const times = await Promise.all([0, 1, 2, 3].map(() => rl.schedule(async () => Date.now() - t0)));
  assert.ok(times[1] < 30);
  assert.ok(times[3] >= 100, `times ${times}`);
});

test('mapPool keeps order and isolates failures', async () => {
  const r = await mapPool([1, 2, 3], 2, async (x) => {
    if (x === 2) throw new Error('boom');
    return x * 10;
  });
  assert.deepEqual(r.map((x) => (x.ok ? x.value : 'err')), [10, 'err', 30]);
});

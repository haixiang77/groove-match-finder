import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENRES, GENRE_BY_ID, expandGenres, lineage, skeletonGenres, tagToGenre, tagsToGenres } from '../src/core/ontology.js';
import { synthLoop, PATTERNS } from './synth.js';
import { analyzeAudio } from '../src/audio/analyzer.js';

test('ontology graph is consistent', () => {
  const ids = new Set(GENRES.map((g) => g.id));
  assert.equal(ids.size, GENRES.length, 'duplicate ids');
  for (const g of GENRES) {
    for (const p of g.parents) assert.ok(ids.has(p), `${g.id}: unknown parent ${p}`);
    for (const p of g.influences ?? []) assert.ok(ids.has(p), `${g.id}: unknown influence ${p}`);
    if (g.bpm) assert.ok(g.bpm[0] < g.bpm[1], `${g.id}: bpm range`);
  }
});

test('tags map to genre nodes, noise tags are ignored', () => {
  assert.equal(tagToGenre('Hip-Hop'), 'hiphop');
  assert.equal(tagToGenre('future bass'), 'future_bass');
  assert.equal(tagToGenre('J-Pop'), 'jpop');
  assert.equal(tagToGenre('melodic dubstep'), 'brostep');
  assert.equal(tagToGenre('japanese hip hop'), 'hiphop');
  assert.equal(tagToGenre('seen live'), null);
  const m = tagsToGenres([{ name: 'trap', weight: 1 }, { name: 'Trap', weight: 0.5 }, { name: 'pop', weight: 0.3 }]);
  assert.equal(m.get('trap'), 1.5);
});

test('expansion walks parents, children, siblings and influences', () => {
  const e = expandGenres(new Map([['trap', 1]]));
  assert.equal(e.get('trap')?.relation, 'seed');
  assert.equal(e.get('drill')?.relation, 'derivative');
  assert.equal(e.get('crunk')?.relation, 'parent');
  assert.ok(e.has('trap_pop'));
  assert.deepEqual(lineage('trap').slice(-2), ['crunk', 'trap']);
  assert.ok(GENRE_BY_ID.get('house'));
});

test('physical skeleton: trap loop → trap family, dembow → reggaeton', () => {
  const trap = analyzeAudio(synthLoop({ bars: 12, bpm: 140, ...PATTERNS.trap, kickDecay: 0.6 }).samples, 22050);
  const t = skeletonGenres(trap).slice(0, 4).map((g) => g.id);
  assert.ok(t.includes('trap'), t.join(','));
  const reg = analyzeAudio(synthLoop({ bars: 12, bpm: 95, ...PATTERNS.reggaeton }).samples, 22050);
  assert.equal(skeletonGenres(reg)[0].id, 'reggaeton');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthLoop, PATTERNS } from './synth.js';
import { analyzeAudio } from '../src/audio/analyzer.js';
import { alignBand, compareFeatures, tempoSimilarity } from '../src/core/similarity.js';

const A = (o) => analyzeAudio(synthLoop({ bars: 12, ...o }).samples, 22050);

test('tempo similarity understands half / double time', () => {
  assert.equal(tempoSimilarity(140, 70).ratio, 2);
  assert.equal(tempoSimilarity(87, 174).ratio, 0.5);
  assert.ok(tempoSimilarity(124, 126).sim > 0.8);
  assert.ok(tempoSimilarity(124, 95).sim < 0.05);
});

test('alignBand folds half-time grids onto the double-time frame', () => {
  const slow = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const fast = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
  // slow-bar 16ths = fast-bar 8ths over two fast bars → fold the halves, take fast evens
  const [a, b] = alignBand(slow, fast, 0.5);
  assert.deepEqual(a, [1, 0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(b, [1, 0, 0, 0, 1, 0, 0, 0]);
  const [c, d] = alignBand(fast, slow, 2);
  assert.deepEqual(c, d);
});

test('ranking: same groove beats different genres; reasons are produced', () => {
  const input = A({ bpm: 124, ...PATTERNS.house, chord: [261.6, 329.6, 392], pump: true });
  const house = compareFeatures(input, A({ bpm: 126, ...PATTERNS.house, chord: [293.7, 370, 440], pump: true, seed: 3 }));
  const trap = compareFeatures(input, A({ bpm: 140, ...PATTERNS.trap, kickDecay: 0.6 }));
  const boombap = compareFeatures(input, A({ bpm: 90, ...PATTERNS.boombap }));
  assert.ok(house.score > 0.8, `house ${house.score}`);
  assert.ok(house.score > trap.score + 0.25);
  assert.ok(house.score > boombap.score + 0.2);
  assert.ok(house.reasons.some((r) => r.includes('4つ打ち')));
});

test('identical features score ~1', () => {
  const f = A({ bpm: 140, ...PATTERNS.trap, kickDecay: 0.6 });
  assert.ok(compareFeatures(f, f).score > 0.97);
});

test('tempo similarity tolerates a ~4% pitch/time-stretch offset but not a different tempo', () => {
  assert.ok(tempoSimilarity(125, 120).sim > 0.6, `${tempoSimilarity(125, 120).sim}`);
  assert.ok(tempoSimilarity(124, 95).sim < 0.05);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthLoop, PATTERNS } from './synth.js';
import { ANALYSIS_VERSION, analyzeAudio, pulseClarity } from '../src/audio/analyzer.js';
import { eventDensity, laneSyncopation, syncopationIndex } from '../src/audio/grid.js';
import { AudioFeaturesSchema } from '../src/types.js';
import { DEFAULT_WEIGHTS, compareFeatures, grooveSimilarity } from '../src/core/similarity.js';

const lane = (steps) => Array.from({ length: 16 }, (_, i) => (steps.includes(i) ? 1 : 0));
const grid = (kick, snare, hat) => ({ kick: lane(kick), snare: lane(snare), hat: lane(hat) });
const A = (o) => analyzeAudio(synthLoop({ bars: 12, ...o }).samples, 22050);

test('syncopation: on-beat pattern ~0, off-beat shifts grow it', () => {
  // 純粋に拍上のパターン（バックビートのスネアは強拍8を休むため定義上シンコペーション扱いになるので含めない）
  const onBeat = syncopationIndex(grid([0, 4, 8, 12], [], [0, 4, 8, 12]));
  const offBeat = syncopationIndex(grid([2, 6, 10, 14], [2, 6, 10, 14], [2, 6, 10, 14]));
  const broken = syncopationIndex(grid([0, 3, 7, 10, 15], [3, 6, 11, 14], [1, 5, 9, 13]));
  assert.equal(onBeat, 0);
  assert.ok(offBeat > onBeat + 0.1, `offBeat ${offBeat}`);
  assert.ok(broken > offBeat, `broken ${broken} vs ${offBeat}`);
  assert.ok(laneSyncopation(lane([15])) > laneSyncopation(lane([14])));
  assert.ok(broken <= 1);
});

test('event density counts onsets per beat across lanes', () => {
  assert.equal(eventDensity(grid([0, 4, 8, 12], [], [])), 1);
  assert.equal(eventDensity(grid([0, 4, 8, 12], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14])), 3.5);
  assert.ok(eventDensity(grid([0], [], [])) < eventDensity(grid([0, 8], [4], [2, 6])));
});

test('pulse clarity: steady pulse > jittered > random onsets', () => {
  const n = 1200;
  const period = 20;
  /** @param {(k: number) => number} pos */
  const train = (pos) => {
    const e = new Float32Array(n);
    for (let k = 0; pos(k) < n - 1; k++) e[Math.round(pos(k))] = 1;
    return e;
  };
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const steady = pulseClarity(train((k) => k * period), period);
  const jitter = pulseClarity(train((k) => k * period + (rnd() - 0.5) * 12), period);
  const random = pulseClarity(train((k) => k * period + rnd() * period * 0.9), period);
  const wrongPeriod = pulseClarity(train((k) => k * period), period * 1.37);
  assert.ok(steady > 0.8, `steady ${steady}`);
  assert.ok(steady > jitter && jitter > random, `${steady} ${jitter} ${random}`);
  assert.ok(wrongPeriod < steady / 2, `wrong ${wrongPeriod}`);
});

test('analysis emits new fields (version 6) that track the pattern', () => {
  assert.equal(ANALYSIS_VERSION, 6);
  const house = A({ bpm: 124, ...PATTERNS.house });
  const trap = A({ bpm: 140, ...PATTERNS.trap, kickDecay: 0.6 });
  const boom = A({ bpm: 90, ...PATTERNS.boombap });
  const reg = A({ bpm: 96, ...PATTERNS.reggaeton });
  for (const f of [house, trap, boom, reg]) {
    AudioFeaturesSchema.parse(f);
    assert.equal(f.version, 6);
  }
  assert.ok(reg.groove.syncopation > boom.groove.syncopation, `${reg.groove.syncopation} ${boom.groove.syncopation}`);
  assert.ok(trap.groove.eventDensity > house.groove.eventDensity, `${trap.groove.eventDensity} ${house.groove.eventDensity}`);
  assert.ok(house.groove.pulseClarity > 0.3, `pulse ${house.groove.pulseClarity}`);
  assert.ok(house.groove.lowFluxMean > 0);
});

test('groove weight rises and tempo weight falls; half/double-time stays equivalent', () => {
  assert.ok(DEFAULT_WEIGHTS.tempo < 0.2 && DEFAULT_WEIGHTS.groove > 0.15);
  const f = A({ bpm: 140, ...PATTERNS.trap, kickDecay: 0.6 });
  const half = { ...f, bpm: 70 };
  assert.equal(compareFeatures(f, half).tempoRatio, 2);
  assert.ok(grooveSimilarity(f, f) > 0.95);
});

test('reasons mention syncopation, density and low-end motion for similar grooves', () => {
  const a = A({ bpm: 124, ...PATTERNS.house, chord: [261.6, 329.6, 392], pump: true });
  const b = A({ bpm: 126, ...PATTERNS.house, chord: [293.7, 370, 440], pump: true, seed: 3 });
  const r = compareFeatures(a, b).reasons.join('\n');
  assert.ok(r.includes('シンコペーション量が近い'), r);
  assert.ok(r.includes('イベント密度が近い'), r);
  const same = compareFeatures(a, a).reasons.join('\n');
  assert.ok(same.includes('低音の動き'), same);
});

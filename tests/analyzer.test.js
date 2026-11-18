import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthLoop, PATTERNS } from './synth.js';
import { analyzeAudio, findEnergyWindow } from '../src/audio/analyzer.js';
import { AudioFeaturesSchema } from '../src/types.js';

const analyse = (o) => analyzeAudio(synthLoop({ bars: 12, ...o }).samples, 22050);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const top = (g, n) => g.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, n).map(([, i]) => i).sort((a, b) => a - b);

test('house: 124 BPM, four-on-the-floor kick, off-beat hats, schema-valid', () => {
  const f = analyse({ bpm: 124, ...PATTERNS.house });
  AudioFeaturesSchema.parse(f);
  assert.ok(near(f.bpm, 124, 1), `bpm ${f.bpm}`);
  assert.deepEqual(top(f.grid.kick, 4), [0, 4, 8, 12]);
  assert.ok(f.traits.four_on_floor > 0.8);
  assert.ok(f.traits.offbeat_hat > 0.6);
  assert.ok(f.traits.halftime < 0.2);
});

test('trap: 140 BPM (not 70), half-time snare on step 9, rolling hats, 808', () => {
  for (const seed of [1, 2]) {
    const f = analyse({ bpm: 140, ...PATTERNS.trap, kickDecay: 0.6, seed, chord: seed === 2 ? [220, 277.2, 329.6] : undefined });
    assert.ok(near(f.bpm, 140, 1.5), `seed ${seed}: bpm ${f.bpm}`);
    assert.ok(f.traits.halftime > 0.7, `halftime ${f.traits.halftime}`);
    assert.ok(f.traits.rolling_hats > 0.7);
    assert.ok(f.traits.sub808 > 0.5, `sub808 ${f.traits.sub808}`);
    assert.ok(f.traits.four_on_floor < 0.2);
  }
});

test('boom bap at 90 BPM is not doubled by 8th-note hats', () => {
  const f = analyse({ bpm: 90, ...PATTERNS.boombap });
  assert.ok(near(f.bpm, 90, 1), `bpm ${f.bpm}`);
  assert.ok(f.traits.backbeat > 0.5);
});

test('reggaeton dembow is detected at 95 BPM', () => {
  const f = analyse({ bpm: 95, ...PATTERNS.reggaeton });
  assert.ok(near(f.bpm, 95, 1), `bpm ${f.bpm}`);
  assert.ok(f.traits.dembow > 0.7);
  assert.deepEqual(top(f.grid.kick, 4), [0, 4, 8, 12]);
});

test('swing ratio is measured on 16th notes', () => {
  const hat = [...Array(16).keys()];
  const straight = analyse({ bpm: 92, kick: [0, 7, 10], snare: [4, 12], hat });
  const swung = analyse({ bpm: 92, kick: [0, 7, 10], snare: [4, 12], hat, swing: 62 });
  assert.ok(near(straight.groove.swing, 50, 2.5), `straight ${straight.groove.swing}`);
  assert.ok(near(swung.groove.swing, 62, 3), `swung ${swung.groove.swing}`);
  assert.equal(swung.groove.swingUnit, 16);
});

test('sidechain pumping is detected only when the pad is ducked', () => {
  const pad = [261.6, 329.6, 392];
  const pumped = analyse({ bpm: 124, ...PATTERNS.house, chord: pad, pump: true });
  const flat = analyse({ bpm: 124, ...PATTERNS.house, chord: pad });
  const drums = analyse({ bpm: 95, ...PATTERNS.reggaeton });
  assert.ok(pumped.groove.sidechainDb >= 2.5, `pumped ${pumped.groove.sidechainDb}`);
  assert.ok(flat.groove.sidechainDb < 1, `flat ${flat.groove.sidechainDb}`);
  assert.ok(drums.groove.sidechainDb < 1, `drums only ${drums.groove.sidechainDb}`);
});

test('rejects silence and very short audio', () => {
  assert.throws(() => analyzeAudio(new Float32Array(22050 * 3), 22050));
  assert.throws(() => analyzeAudio(new Float32Array(22050 * 10), 22050));
});

test('findEnergyWindow picks the loud section', () => {
  const sr = 1000;
  const x = new Float32Array(sr * 60);
  for (let i = sr * 30; i < sr * 45; i++) x[i] = Math.sin(i);
  for (let i = 0; i < x.length; i++) x[i] += 0.01 * Math.sin(i * 0.3);
  const w = findEnergyWindow(x, sr, 15);
  assert.ok(Math.abs(w.start / sr - 30) <= 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthLoop } from './synth.js';
import { analyzeAudio } from '../src/audio/analyzer.js';

const SR = 22050;
const cosine = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};
const truth = (steps) => Array.from({ length: 16 }, (_, i) => (steps.includes(i) ? 1 : 0));
const best = (g, t) => Math.max(...[0, 4, 8, 12].map((s) => cosine(g.map((_, i) => g[(i + s) % 16]), t)));

// Real-mix proxy: tonal notes in the snare band (off the backbeat) must not read as snare hits.
for (const [name, melody] of [['off-beat notes', [2, 6, 10, 14]], ['syncopated notes', [3, 7, 11, 13]]]) {
  test(`snare lane ignores tonal onsets in the snare band (${name})`, () => {
    const snare = [4, 12];
    const f = analyzeAudio(synthLoop({ bpm: 100, bars: 12, kick: [0, 8], snare, hat: [0, 2, 4, 6, 8, 10, 12, 14], melody, chord: [110, 165], seed: 3 }).samples, SR);
    const c = best(f.grid.snare, truth(snare));
    assert.ok(c >= 0.85, `snare-lane cosine ${c.toFixed(2)} (grid ${f.grid.snare.map((v) => v.toFixed(1)).join(' ')})`);
  });
}

// @ts-check
/**
 * Key estimation: STFT chromagram + Krumhansl–Schmuckler key profiles.
 */
import { pearson, stftForEach } from './dsp.js';

export const PITCH_NAMES = ['C', 'C#', 'D', 'E♭', 'E', 'F', 'F#', 'G', 'A♭', 'A', 'B♭', 'B'];
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/**
 * Camelot wheel code (e.g. C major → 8B, A minor → 8A).
 * @param {number} tonic 0..11
 * @param {'major' | 'minor'} mode
 */
export function camelot(tonic, mode) {
  const majorTonic = mode === 'major' ? tonic : (tonic + 3) % 12;
  const num = (((majorTonic * 7) % 12) + 7) % 12 + 1;
  return `${num}${mode === 'major' ? 'B' : 'A'}`;
}

/**
 * @param {Float32Array} x mono signal
 * @param {number} sr
 * @returns {{chroma: number[], key: import('../types.js').KeyEstimate}}
 */
export function estimateKey(x, sr) {
  const nfft = 4096;
  const hop = 2048;
  const binHz = sr / nfft;
  const loBin = Math.ceil(100 / binHz);
  const hiBin = Math.min(nfft / 2, Math.floor(2200 / binHz));
  const pcOfBin = new Int8Array(hiBin + 1);
  for (let k = loBin; k <= hiBin; k++) {
    const midi = 69 + 12 * Math.log2((k * binHz) / 440);
    pcOfBin[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  const chroma = new Float64Array(12);
  const frame = new Float64Array(12);
  stftForEach(x, nfft, hop, (mag) => {
    frame.fill(0);
    for (let k = loBin; k <= hiBin; k++) frame[pcOfBin[k]] += Math.log1p(10 * mag[k]);
    let mx = 0;
    for (let i = 0; i < 12; i++) mx = Math.max(mx, frame[i]);
    if (mx > 1e-6) for (let i = 0; i < 12; i++) chroma[i] += frame[i] / mx;
  });

  /** @type {{tonic: number, mode: 'major' | 'minor', r: number}[]} */
  const scores = [];
  for (let t = 0; t < 12; t++) {
    const rot = (/** @type {number[]} */ p) => Array.from({ length: 12 }, (_, i) => p[(i - t + 12) % 12]);
    scores.push({ tonic: t, mode: 'major', r: pearson(chroma, rot(MAJOR)) });
    scores.push({ tonic: t, mode: 'minor', r: pearson(chroma, rot(MINOR)) });
  }
  scores.sort((a, b) => b.r - a.r);
  const best = scores[0];
  const margin = best.r - scores[1].r;
  const confidence = Math.max(0, Math.min(1, best.r * 0.6 + margin * 4));
  const cmax = Math.max(...chroma) || 1;
  return {
    chroma: Array.from(chroma, (v) => v / cmax),
    key: {
      tonic: best.tonic,
      mode: best.mode,
      name: `${PITCH_NAMES[best.tonic]} ${best.mode === 'major' ? 'major' : 'minor'}`,
      camelot: camelot(best.tonic, best.mode),
      confidence,
    },
  };
}

/**
 * Harmonic compatibility on the Camelot wheel (1 = same key).
 * @param {import('../types.js').KeyEstimate} a
 * @param {import('../types.js').KeyEstimate} b
 */
export function keyCompatibility(a, b) {
  const pa = parseInt(a.camelot, 10);
  const pb = parseInt(b.camelot, 10);
  const la = a.camelot.slice(-1);
  const lb = b.camelot.slice(-1);
  const d = Math.min((pa - pb + 12) % 12, (pb - pa + 12) % 12);
  if (d === 0 && la === lb) return 1;
  if (d === 0) return 0.85; // relative major/minor
  if (d === 1 && la === lb) return 0.75; // fifth neighbour
  if (d === 1) return 0.55;
  if (d === 2) return 0.4;
  return 0.2;
}

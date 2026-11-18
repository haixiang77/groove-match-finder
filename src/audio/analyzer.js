// @ts-check
/**
 * Layer 1 — physical audio analysis.
 *
 * Input: mono PCM. Output: AudioFeatures (BPM, key, 16-step drum grids per
 * frequency band, groove metrics, spectral balance and rhythmic traits).
 * Pure function: runs identically in a Web Worker and in Node tests.
 */
import { BAND_RANGES, BALANCE_BANDS } from '../types.js';
import { bandpass, highpass, lowpass } from './filters.js';
import { estimateKey } from './key.js';
import {
  db,
  interp,
  mean,
  median,
  minFilter,
  movingAverage,
  pearson,
  std,
  onsetFromEnvelope,
  parabolicOffset,
  percentile,
  rmsEnvelope,
  stftForEach,
  windowMax,
} from './dsp.js';
import { estimateTempo, regulariseBeats, smoothBeats, trackBeats } from './tempo.js';

export const ANALYSIS_VERSION = 3;
export const HOP = 256;
const NFFT = 1024;

export class AnalysisError extends Error {}

/** @param {number} v */
const c01 = (v) => Math.max(0, Math.min(1, v));

/**
 * @param {Float32Array} samples mono PCM
 * @param {number} sr sample rate (22050 recommended)
 * @returns {import('../types.js').AudioFeatures}
 */
export function analyzeAudio(samples, sr) {
  const durationSec = samples.length / sr;
  if (durationSec < 6) throw new AnalysisError('音声が短すぎます（6秒以上必要）');
  let peakAbs = 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peakAbs) peakAbs = a;
    sumSq += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSq / samples.length);
  if (rms < 1e-4) throw new AnalysisError('無音、またはほぼ無音の音声です');

  const fps = sr / HOP;

  // ---- Spectral pass: spectral flux onset + long-term spectrum -------------
  const binHz = sr / NFFT;
  const nBins = NFFT / 2 + 1;
  const meanMag = new Float64Array(nBins);
  const meanPow = new Float64Array(nBins);
  /** @type {number[]} */
  const fluxArr = [];
  let prevLog = new Float64Array(nBins);
  let curLog = new Float64Array(nBins);
  const fluxHi = Math.min(nBins - 1, Math.floor(8000 / binHz));
  let frames = 0;
  stftForEach(samples, NFFT, HOP, (mag, f) => {
    let flux = 0;
    for (let k = 0; k < nBins; k++) {
      meanMag[k] += mag[k];
      meanPow[k] += mag[k] * mag[k];
      curLog[k] = Math.log1p(100 * mag[k]);
      if (f > 0 && k >= 1 && k <= fluxHi) flux += Math.max(0, curLog[k] - prevLog[k]);
    }
    fluxArr.push(flux);
    [prevLog, curLog] = [curLog, prevLog];
    frames++;
  });
  for (let k = 0; k < nBins; k++) {
    meanMag[k] /= frames;
    meanPow[k] /= frames;
  }
  // Detrend the flux so slow loudness changes don't masquerade as onsets.
  const fluxRaw = Float32Array.from(fluxArr);
  const trend = movingAverage(fluxRaw, Math.round(fps * 0.5));
  const onset = new Float32Array(fluxRaw.length);
  // A log-flux frame "sees" a transient as soon as it enters the 1024-sample
  // window, i.e. early; delay it (empirically NFFT/4) so it lines up with the
  // 512-sample RMS band onsets used for the grid.
  const fluxDelay = Math.round(NFFT / 4 / HOP);
  for (let i = fluxDelay; i < onset.length; i++) onset[i] = Math.max(0, fluxRaw[i - fluxDelay] - trend[i - fluxDelay]);

  // ---- Band separation (SciPy Butterworth equivalent) ---------------------
  const kickSig = bandpass(samples, BAND_RANGES.kick.lo, BAND_RANGES.kick.hi, sr, 4);
  const snareSig = bandpass(samples, BAND_RANGES.snare.lo, BAND_RANGES.snare.hi, sr, 4);
  const hatSig = highpass(samples, BAND_RANGES.hat.lo, sr, 4);
  const envWin = 512;
  const bandOnset = {
    kick: onsetFromEnvelope(rmsEnvelope(kickSig, envWin, HOP)),
    snare: onsetFromEnvelope(rmsEnvelope(snareSig, envWin, HOP)),
    hat: onsetFromEnvelope(rmsEnvelope(hatSig, envWin, HOP)),
  };

  // ---- Tempo & beats ------------------------------------------------------
  // The metrical level comes mostly from kick + snare so dense hi-hats can't
  // pull the tempo to double-time; the full-band flux only breaks ties.
  // Beat *phase* is tracked on the full fusion.
  const meterOnset = fuseOnsets([onset, bandOnset.kick, bandOnset.snare], [0.35, 1.2, 0.8]);
  const tempoOnset = fuseOnsets([onset, bandOnset.kick, bandOnset.snare], [1, 1.2, 0.8]);
  const tempo = estimateTempo(meterOnset, fps);
  const period = (60 * fps) / tempo.bpm;
  let beats = trackBeats(tempoOnset, fps, tempo.bpm);
  beats = smoothBeats(regulariseBeats(beats, period, tempoOnset.length, tempoOnset));
  let bpm = tempo.bpm;
  // Tatum rule: below 100 BPM, regular hits on 32nd-note positions mean we
  // locked onto half-time (e.g. trap at 70 instead of 140) — double it.
  if (bpm < 100 && isHalfTime(bandOnset.hat, beats)) {
    bpm = Math.round(bpm * 200) / 100;
    beats = beats.flatMap((b, i) => (i + 1 < beats.length ? [b, (b + beats[i + 1]) / 2] : [b]));
  }

  // ---- 16-step grid ---------------------------------------------------------
  const rawGrid = { kick: new Float64Array(16), snare: new Float64Array(16), hat: new Float64Array(16) };
  const counts = new Float64Array(16);
  for (let i = 0; i + 1 < beats.length; i++) {
    const b0 = beats[i];
    const len = beats[i + 1] - b0;
    const phase = i % 4;
    for (let j = 0; j < 4; j++) {
      const pos = b0 + (len * j) / 4;
      const radius = Math.max(1, (len / 4) * 0.3);
      const step = phase * 4 + j;
      rawGrid.kick[step] += windowMax(bandOnset.kick, pos, radius);
      rawGrid.snare[step] += windowMax(bandOnset.snare, pos, radius);
      rawGrid.hat[step] += windowMax(bandOnset.hat, pos, radius);
      counts[step]++;
    }
  }
  /** @type {import('../types.js').RhythmGrid} */
  const unrotated = { kick: [], snare: [], hat: [] };
  /** @type {Record<import('../types.js').DrumBand, number>} */
  const presence = { kick: 0, snare: 0, hat: 0 };
  for (const band of /** @type {const} */ (['kick', 'snare', 'hat'])) {
    const avg = Array.from(rawGrid[band], (v, i) => (counts[i] ? v / counts[i] : 0));
    const mx = Math.max(...avg);
    unrotated[band] = avg.map((v) => (mx > 0 ? v / mx : 0));
    // Presence: how strongly the best grid steps stand out against the band's typical onset level.
    const top = [...avg].sort((a, b) => b - a).slice(0, 4);
    const ref = percentile(bandOnset[band], 99) || 1;
    presence[band] = c01(mean(top) / ref);
  }
  const grid = chooseDownbeat(unrotated);

  // ---- Groove metrics -------------------------------------------------------
  const swingRes = measureSwing(grid, presence.hat > 0.2 ? bandOnset.hat : onset, beats);
  const sidechainDb = measureSidechain(lowpass(highpass(samples, 200, sr, 2), 4000, sr, 2), beats);
  const subSustain = measureSubSustain(lowpass(samples, 100, sr, 4), beats);
  const hatDensity = grid.hat.filter((v) => v >= 0.5).length / 16;
  const kickDensity = grid.kick.filter((v) => v >= 0.5).length / 16;

  // ---- Spectral profile -----------------------------------------------------
  let magSum = 0;
  let weighted = 0;
  for (let k = 0; k < nBins; k++) {
    magSum += meanMag[k];
    weighted += meanMag[k] * k * binHz;
  }
  const centroidHz = magSum > 0 ? weighted / magSum : 0;
  let acc = 0;
  let rolloffHz = 0;
  for (let k = 0; k < nBins; k++) {
    acc += meanMag[k];
    if (acc >= 0.85 * magSum) {
      rolloffHz = k * binHz;
      break;
    }
  }
  let totalPow = 0;
  for (let k = 1; k < nBins; k++) totalPow += meanPow[k];
  const bandBalance = BALANCE_BANDS.map(({ lo, hi }) => {
    let p = 0;
    for (let k = Math.max(1, Math.ceil(lo / binHz)); k <= Math.min(nBins - 1, Math.floor(hi / binHz)); k++) p += meanPow[k];
    return Math.round(10 * Math.log10(Math.max(p, 1e-12) / Math.max(totalPow, 1e-12)) * 10) / 10;
  });

  const { key } = estimateKey(samples, sr);

  /** @type {Omit<import('../types.js').AudioFeatures, 'traits'>} */
  const base = {
    version: ANALYSIS_VERSION,
    durationSec,
    bpm,
    bpmConfidence: tempo.confidence,
    bpmCandidates: tempo.candidates,
    key,
    grid,
    presence,
    groove: {
      swing: swingRes.swing,
      swingUnit: swingRes.unit,
      swingConfidence: swingRes.confidence,
      sidechainDb,
      subSustain,
      hatDensity,
      kickDensity,
    },
    spectral: {
      centroidHz,
      rolloffHz,
      crestDb: db(peakAbs) - db(rms),
      rmsDb: db(rms),
      bandBalance,
    },
    beatCount: beats.length,
  };
  return { ...base, traits: computeTraits(base) };
}

/**
 * True when the onset envelope has strong, regular activity halfway between
 * 16th-note steps (i.e. 32nd notes at this tempo).
 * @param {Float32Array} env
 * @param {number[]} beats
 */
export function isHalfTime(env, beats) {
  if (beats.length < 8) return false;
  /** @type {number[]} */
  const on = [];
  /** @type {number[]} */
  const mid = [];
  for (let i = 0; i + 1 < beats.length; i++) {
    const step = (beats[i + 1] - beats[i]) / 4;
    for (let j = 0; j < 4; j++) {
      const p = beats[i] + j * step;
      on.push(windowMax(env, p, step * 0.2));
      mid.push(windowMax(env, p + step / 2, step * 0.2));
    }
  }
  const ref = median(on);
  if (ref <= 0) return false;
  const midHits = mid.filter((m) => m > 0.4 * ref).length / mid.length;
  return mean(mid) / (mean(on) || 1) >= 0.55 && midHits >= 0.6;
}

/**
 * Weighted sum of std-normalised onset envelopes (same frame grid).
 * @param {Float32Array[]} envs
 * @param {number[]} weights
 */
export function fuseOnsets(envs, weights) {
  const n = Math.min(...envs.map((e) => e.length));
  const out = new Float32Array(n);
  envs.forEach((e, k) => {
    const sd = std(e) || 1;
    for (let i = 0; i < n; i++) out[i] += (weights[k] * e[i]) / sd;
  });
  return out;
}

/**
 * Pick which beat is "1": rotate the grid so the kick lands on step 0 and the
 * snare on the backbeat (2 & 4) or half-time 3.
 * @param {import('../types.js').RhythmGrid} g
 * @returns {import('../types.js').RhythmGrid}
 */
export function chooseDownbeat(g) {
  let best = 0;
  let bestScore = -Infinity;
  for (let r = 0; r < 4; r++) {
    const rot = rotateGrid(g, r * 4);
    const sc =
      rot.kick[0] +
      0.3 * rot.kick[8] +
      0.6 * Math.max((rot.snare[4] + rot.snare[12]) / 2, 1.1 * rot.snare[8]) -
      0.5 * rot.snare[0] -
      0.15 * rot.kick[4] +
      0.6 * mean([3, 6, 11, 14].map((i) => rot.snare[i]));
    if (sc > bestScore + 1e-9) {
      bestScore = sc;
      best = r;
    }
  }
  return rotateGrid(g, best * 4);
}

/**
 * @param {import('../types.js').RhythmGrid} g
 * @param {number} shift steps
 * @returns {import('../types.js').RhythmGrid}
 */
export function rotateGrid(g, shift) {
  /** @param {number[]} a */
  const rot = (a) => a.map((_, i) => a[(i + shift) % 16]);
  return { kick: rot(g.kick), snare: rot(g.snare), hat: rot(g.hat) };
}

/**
 * Swing ratio: where the off-beat subdivision actually lands inside its pair.
 * 50% = straight, 66.7% = triplet shuffle (MPC-style swing %).
 * @param {import('../types.js').RhythmGrid} grid
 * @param {Float32Array} env onset envelope used for timing (hats if present)
 * @param {number[]} beats
 */
export function measureSwing(grid, env, beats) {
  void grid;
  const thr = 0.25 * percentile(env, 98);
  /**
   * Scan each subdivision pair for the strongest off-beat onset.
   * @param {number} pairsPerBeat 2 → 16th pairs, 1 → 8th pairs
   * @param {number} uLo @param {number} uHi
   */
  const scan = (pairsPerBeat, uLo, uHi) => {
    /** @type {number[]} */
    const positions = [];
    let possible = 0;
    for (let i = 0; i + 1 < beats.length; i++) {
      const len = (beats[i + 1] - beats[i]) / pairsPerBeat;
      for (let p = 0; p < pairsPerBeat; p++) {
        const a = beats[i] + p * len;
        possible++;
        let bi = -1;
        let bv = 0;
        for (let t = Math.ceil(a + len * uLo); t <= Math.floor(a + len * uHi) && t < env.length; t++) {
          if (env[t] > bv) {
            bv = env[t];
            bi = t;
          }
        }
        if (bi >= 0 && bv > thr) positions.push((bi + parabolicOffset(env, bi) - a) / len);
      }
    }
    return { positions, possible };
  };
  // If most 8th-note spans contain an off-beat hit, the groove has 16th
  // subdivisions and the swing lives there; otherwise measure 8th swing.
  const r16 = scan(2, 0.3, 0.82);
  const unit = r16.possible && r16.positions.length >= 0.4 * r16.possible ? 16 : 8;
  const r = unit === 16 ? r16 : scan(1, 0.35, 0.8);
  if (r.positions.length < 6) return { swing: 50, unit, confidence: 0 };
  const swing = Math.max(50, Math.min(75, median(r.positions) * 100));
  const confidence = c01(r.positions.length / Math.max(1, r.possible));
  return { swing: Math.round(swing * 10) / 10, unit, confidence };
}

/**
 * Sidechain "pumping" depth: beat-synchronous average of the mid-band RMS
 * envelope; depth = late-beat level minus the post-kick dip (dB).
 * @param {Float32Array} midSig 200 Hz – 4 kHz band of the mix
 * @param {number[]} beats
 */
export function measureSidechain(midSig, beats) {
  const raw = rmsEnvelope(midSig, 512, HOP);
  if (beats.length < 6) return 0;
  const period = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
  // A running minimum over ~1/4 beat (then smoothing) follows the troughs
  // between drum hits, i.e. the sustained layer (pads, bass, vocals) where
  // ducking actually shows up. Drum-only material has near-silent troughs.
  const w = Math.max(3, Math.round(period / 4));
  const env = movingAverage(minFilter(raw, w), w);
  const sustainRatio = mean(env) / (mean(raw) || 1);
  const BINS = 24;
  const cycle = new Float64Array(BINS);
  let n = 0;
  for (let i = 0; i + 1 < beats.length; i++) {
    const b0 = beats[i];
    const len = beats[i + 1] - b0;
    const vals = Array.from({ length: BINS }, (_, k) => interp(env, b0 + (len * k) / BINS));
    const m = mean(vals);
    if (m <= 1e-6) continue;
    for (let k = 0; k < BINS; k++) cycle[k] += vals[k] / m;
    n++;
  }
  if (n < 4) return 0;
  for (let k = 0; k < BINS; k++) cycle[k] /= n;
  // Pumping = a dip right after the kick, then a steady rise through the beat.
  const body = Array.from(cycle.subarray(1, 20));
  const rise = Math.max(0, pearson(body, body.map((_, i) => i)));
  const early = Math.min(...Array.from(cycle.subarray(0, 8)));
  const late = Math.max(...Array.from(cycle.subarray(12, 24)));
  const depth = (db(late) - db(early)) * Math.sqrt(rise) * c01((sustainRatio - 0.25) / 0.25);
  return Math.round(Math.max(0, Math.min(24, depth)) * 10) / 10;
}

/**
 * Sub sustain: how long the sub-bass rings within a beat (808 tails → high).
 * @param {Float32Array} subSig < 100 Hz band
 * @param {number[]} beats
 */
export function measureSubSustain(subSig, beats) {
  const env = rmsEnvelope(subSig, 512, HOP);
  let gmax = 0;
  for (let i = 0; i < env.length; i++) gmax = Math.max(gmax, env[i]);
  if (gmax <= 1e-6) return 0;
  /** @type {number[]} */
  const ratios = [];
  for (let i = 0; i + 1 < beats.length; i++) {
    const a = Math.floor(beats[i]);
    const b = Math.floor(beats[i + 1]);
    let peak = 0;
    for (let t = a; t < b && t < env.length; t++) peak = Math.max(peak, env[t]);
    if (peak < 0.1 * gmax) continue;
    const tail = mean(Array.from({ length: 8 }, (_, k) => interp(env, a + (b - a) * (0.5 + (0.45 * k) / 7))));
    ratios.push(tail / peak);
  }
  return ratios.length ? Math.round(c01(median(ratios)) * 100) / 100 : 0;
}

/**
 * Rhythmic "skeleton" traits in 0..1 from the grid and groove metrics.
 * @param {Omit<import('../types.js').AudioFeatures, 'traits'>} f
 * @returns {import('../types.js').Traits}
 */
export function computeTraits(f) {
  const { kick, snare, hat } = f.grid;
  /** @param {number[]} a @param {number[]} idx */
  const avg = (a, idx) => mean(idx.map((i) => a[i]));
  const Q = [0, 4, 8, 12];
  const OFF8 = [2, 6, 10, 14];
  const NONQ = [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15];

  const kickQMin = Math.min(...Q.map((i) => kick[i]));
  const four = c01((kickQMin - 0.45) / 0.35) * c01(1 - (avg(kick, NONQ) - 0.15) / 0.4);
  const offHat = c01((avg(hat, OFF8) - avg(hat, Q)) / 0.35) * c01(avg(hat, OFF8) / 0.6) * c01(f.presence.hat / 0.25);
  const backbeat = c01((avg(snare, [4, 12]) - 0.8 * Math.max(snare[0], snare[8])) / 0.45);
  const halftimeRaw = c01((snare[8] - avg(snare, [4, 12])) / 0.45);
  const rolling = c01((f.groove.hatDensity - 0.45) / 0.35) * c01(f.presence.hat / 0.25);
  const sub808 = c01((f.groove.subSustain - 0.3) / 0.35) * c01((f.spectral.bandBalance[0] + 18) / 10);
  const swing = c01((f.groove.swing - 53) / 10) * (0.4 + 0.6 * f.groove.swingConfidence);
  const sidechain = c01((f.groove.sidechainDb - 1.5) / 4);
  const syncKick = c01((avg(kick, NONQ) - 0.15) / 0.35);
  // Dembow (3+3+2) is judged on every beat rotation since the downbeat is ambiguous.
  const dembow = Math.max(
    ...[0, 4, 8, 12].map((sh) => {
      const sn = snare.map((_, i) => snare[(i + sh) % 16]);
      return c01(kickQMin / 0.6) * c01((avg(sn, [3, 6, 11, 14]) - avg(sn, [1, 5, 9, 13])) / 0.35);
    }),
  );
  const halftime = halftimeRaw * (1 - dembow);
  const breakbeat = backbeat * syncKick * (1 - four);
  /** @param {number} v */
  const r = (v) => Math.round(v * 100) / 100;
  return {
    four_on_floor: r(four),
    offbeat_hat: r(offHat),
    backbeat: r(backbeat),
    halftime: r(halftime),
    rolling_hats: r(rolling),
    sub808: r(sub808),
    swing: r(swing),
    sidechain: r(sidechain),
    syncopated_kick: r(syncKick),
    dembow: r(dembow),
    breakbeat: r(breakbeat),
  };
}

/**
 * Find the loudest window (e.g. the drop / chorus) by sliding 1-second RMS blocks.
 * @param {Float32Array} samples
 * @param {number} sr
 * @param {number} windowSec
 * @returns {{start: number, end: number}} sample indices
 */
export function findEnergyWindow(samples, sr, windowSec) {
  const win = Math.min(samples.length, Math.round(windowSec * sr));
  if (win >= samples.length) return { start: 0, end: samples.length };
  const block = sr;
  const nBlocks = Math.floor(samples.length / block);
  const energy = new Float64Array(nBlocks);
  for (let b = 0; b < nBlocks; b++) {
    let s = 0;
    for (let i = b * block; i < (b + 1) * block; i++) s += samples[i] * samples[i];
    energy[b] = s;
  }
  const span = Math.max(1, Math.floor(win / block));
  let best = 0;
  let bestStart = 0;
  let acc = 0;
  for (let b = 0; b < nBlocks; b++) {
    acc += energy[b];
    if (b >= span) acc -= energy[b - span];
    // Slight preference against the very end of the track (fade-outs / outros).
    if (b >= span - 1 && acc > best * 1.0001) {
      best = acc;
      bestStart = b - span + 1;
    }
  }
  const start = bestStart * block;
  return { start, end: Math.min(samples.length, start + win) };
}

// @ts-check
/**
 * Tempo estimation + dynamic-programming beat tracking
 * (autocorrelation tempogram with a log-normal prior → Ellis 2007 beat tracker,
 * the same approach as librosa.beat.beat_track).
 */
import { interp, mean, median, parabolicOffset, percentile, std } from './dsp.js';

/**
 * @param {Float32Array} onset onset-strength envelope
 * @param {number} fps frames per second of the envelope
 * @param {{minBpm?: number, maxBpm?: number, priorBpm?: number, priorStd?: number}} [opts]
 * @returns {{bpm: number, confidence: number, candidates: number[]}}
 */
export function estimateTempo(onset, fps, opts = {}) {
  const { minBpm = 60, maxBpm = 200, priorBpm = 120, priorStd = 1.0 } = opts;
  const n = onset.length;
  const m = mean(onset);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = onset[i] - m;

  const minLag = Math.max(1, Math.floor((60 * fps) / maxBpm));
  const maxLag = Math.min(n - 2, Math.ceil((60 * fps) / minBpm));
  if (maxLag <= minLag + 2) return { bpm: 120, confidence: 0, candidates: [120] };

  let ac0 = 0;
  for (let i = 0; i < n; i++) ac0 += x[i] * x[i];
  ac0 = ac0 / n || 1;
  const acLen = Math.min(n - 1, maxLag * 4 + 2);
  const ac = new Float64Array(acLen + 1);
  for (let lag = 1; lag <= acLen; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += x[i] * x[i + lag];
    ac[lag] = sum / (n - lag) / ac0;
  }

  // Weighted score: AC × log-normal tempo prior, with harmonic boosts — a true
  // beat period also correlates at 2× (half bar) and 4× (one bar of 4/4), which
  // rejects dotted / triplet periods that only line up locally.
  // An integer lag L is only accurate to ±0.5 frame, so its m-th harmonic can
  // be off by ±m/2 frames — take the AC maximum within that tolerance.
  /** @param {number} lag @param {number} m */
  const acAt = (lag, m) => {
    let best = 0;
    for (let j = Math.round(m * (lag - 0.5)); j <= Math.round(m * (lag + 0.5)); j++) if (j >= 1 && j <= acLen) best = Math.max(best, ac[j]);
    return best;
  };
  const score = new Float64Array(acLen + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / priorBpm) / priorStd) ** 2);
    score[lag] = (Math.max(0, ac[lag]) + 0.5 * acAt(lag, 2) + 0.8 * acAt(lag, 4)) * prior;
  }

  /** @type {{lag: number, v: number}[]} */
  const peaks = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (score[lag] > score[lag - 1] && score[lag] >= score[lag + 1] && score[lag] > 0) peaks.push({ lag, v: score[lag] });
  }
  if (!peaks.length) return { bpm: 120, confidence: 0, candidates: [120] };
  peaks.sort((a, b) => b.v - a.v);

  const best = peaks[0];
  const coarsePeriod = best.lag + parabolicOffset(score, best.lag);
  const period = refinePeriod(onset, coarsePeriod);
  let bpm = (60 * fps) / period;
  if (Math.abs(bpm - Math.round(bpm)) < 0.3) bpm = Math.round(bpm);

  const slice = score.subarray(minLag, maxLag + 1);
  const z = (best.v - mean(slice)) / (std(slice) + 1e-9);
  const confidence = Math.max(0, Math.min(1, 1 - Math.exp(-z / 4)));
  const candidates = peaks.slice(0, 3).map((p) => Math.round(((60 * fps) / (p.lag + parabolicOffset(score, p.lag))) * 10) / 10);
  return { bpm: Math.round(bpm * 100) / 100, confidence, candidates };
}

/**
 * Fine-tune a beat period with a comb filter: the period whose pulse train
 * collects the most onset energy (max over phase) wins.
 * @param {Float32Array} onset
 * @param {number} period frames (fractional)
 */
export function refinePeriod(onset, period) {
  let bestP = period;
  let bestScore = -Infinity;
  for (let r = 0.97; r <= 1.0301; r += 0.0015) {
    const p = period * r;
    const phases = Math.ceil(p);
    for (let ph = 0; ph < phases; ph++) {
      let sum = 0;
      let count = 0;
      for (let t = ph; t < onset.length - 1; t += p) {
        sum += interp(onset, t);
        count++;
      }
      const sc = count ? sum / count : 0;
      if (sc > bestScore) {
        bestScore = sc;
        bestP = p;
      }
    }
  }
  return bestP;
}

/**
 * Ellis-style dynamic-programming beat tracker.
 * @param {Float32Array} onset
 * @param {number} fps
 * @param {number} bpm
 * @param {number} [tightness]
 * @returns {number[]} beat positions in frames
 */
export function trackBeats(onset, fps, bpm, tightness = 100) {
  const n = onset.length;
  const period = (60 * fps) / bpm;
  if (n < period * 4) return [];

  // Normalise and smooth with a Gaussian of width period/32 (librosa does the same).
  const sd = std(onset) || 1;
  const sigma = Math.max(0.5, period / 32);
  const radius = Math.ceil(sigma * 3);
  const kernel = [];
  for (let k = -radius; k <= radius; k++) kernel.push(Math.exp(-0.5 * (k / sigma) ** 2));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < n) acc += (onset[j] / sd) * kernel[k + radius];
    }
    local[i] = acc;
  }

  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  let firstBeat = true;
  const localMax = Math.max(...local);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let bi = -1;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const w = -tightness * Math.log((t - tau) / period) ** 2;
      const sc = cum[tau] + w;
      if (sc > best) {
        best = sc;
        bi = tau;
      }
    }
    cum[t] = local[t] + (bi >= 0 ? best : 0);
    if (firstBeat && local[t] < 0.01 * localMax) back[t] = -1;
    else {
      back[t] = bi;
      firstBeat = false;
    }
  }

  // Last beat: the final local maximum of the cumulative score above half the median peak.
  /** @type {number[]} */
  const maxima = [];
  for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxima.push(i);
  if (!maxima.length) return [];
  const thr = 0.5 * median(maxima.map((i) => cum[i]));
  let last = maxima[maxima.length - 1];
  for (let k = maxima.length - 1; k >= 0; k--) {
    if (cum[maxima[k]] >= thr) {
      last = maxima[k];
      break;
    }
  }
  /** @type {number[]} */
  const beats = [];
  for (let b = last; b >= 0; b = back[b]) {
    beats.push(b);
    if (back[b] === b) break;
  }
  beats.reverse();

  // Sub-frame refinement: nudge each beat to the onset centroid within ±2 frames.
  return beats.map((b) => {
    let w = 0;
    let acc = 0;
    for (let k = -2; k <= 2; k++) {
      const j = b + k;
      if (j >= 0 && j < n) {
        acc += j * local[j] ** 2;
        w += local[j] ** 2;
      }
    }
    return w > 0 ? acc / w : b;
  });
}

/**
 * Regularise a beat list: fill gaps and drop beats that are far off the period,
 * falling back to a uniform grid when tracking failed.
 * @param {number[]} beats
 * @param {number} period
 * @param {number} nFrames
 * @param {Float32Array} onset
 */
export function regulariseBeats(beats, period, nFrames, onset) {
  if (beats.length < 4) {
    // Uniform grid with the best phase.
    let bestPh = 0;
    let best = -1;
    for (let ph = 0; ph < period; ph++) {
      let s = 0;
      for (let t = ph; t < nFrames; t += period) s += interp(onset, t);
      if (s > best) {
        best = s;
        bestPh = ph;
      }
    }
    /** @type {number[]} */
    const out = [];
    for (let t = bestPh; t < nFrames; t += period) out.push(t);
    return out;
  }
  /** @type {number[]} */
  const out = [beats[0]];
  for (let i = 1; i < beats.length; i++) {
    const prev = out[out.length - 1];
    const gap = beats[i] - prev;
    if (gap < period * 0.6) continue; // spurious extra beat
    const k = Math.round(gap / period);
    for (let j = 1; j < k; j++) out.push(prev + (gap * j) / k); // fill missed beats
    out.push(beats[i]);
  }
  return out;
}

/**
 * Remove per-beat jitter (e.g. a strong syncopated kick pulling a beat early)
 * with a robust local linear fit: fit over ±`radius` neighbours, reject beats
 * whose residual exceeds 5% of the period, refit. Keeps slow tempo drift.
 * @param {number[]} beats
 * @param {number} [radius]
 */
export function smoothBeats(beats, radius = 32) {
  if (beats.length < 5) return beats;
  /** @param {number[]} idx */
  const fit = (idx) => {
    const n = idx.length;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (const k of idx) {
      sx += k;
      sy += beats[k];
      sxx += k * k;
      sxy += k * beats[k];
    }
    const den = n * sxx - sx * sx;
    const slope = den !== 0 ? (n * sxy - sx * sy) / den : 0;
    return { slope, icpt: (sy - slope * sx) / n };
  };
  return beats.map((_, i) => {
    const a = Math.max(0, i - radius);
    const b = Math.min(beats.length - 1, i + radius);
    let idx = Array.from({ length: b - a + 1 }, (_, k) => a + k);
    let model = fit(idx);
    for (let pass = 0; pass < 3; pass++) {
      const tol = 0.05 * Math.abs(model.slope);
      const inliers = idx.filter((k) => Math.abs(beats[k] - (model.icpt + model.slope * k)) <= tol);
      if (inliers.length < 4 || inliers.length === idx.length) break;
      // Re-fit on the inliers but keep the full index window for the next pass.
      model = fit(inliers);
      idx = Array.from({ length: b - a + 1 }, (_, k) => a + k);
    }
    return model.icpt + model.slope * i;
  });
}

/**
 * Replace tracked beats by a perfectly uniform grid when the tempo is steady.
 * The DP tracker's beat-to-beat spacing can differ from the true period by
 * ~0.5 %, which slips a 16th-note step after ~30 beats; a global comb fit over
 * the whole clip (period within ±1.5 %, phase within ±1/8 beat, scored at 16th
 * resolution) removes that drift. Falls back to the tracked beats if they
 * aren't straight (80th-percentile residual > 15 % of a period: live tempo drift).
 * @param {number[]} beats tracked beats (frames), contiguous
 * @param {Float32Array} onset
 * @returns {number[]}
 */
export function snapToUniformGrid(beats, onset) {
  const n = beats.length;
  if (n < 8) return beats;
  const p0 = median(beats.slice(1).map((b, k) => b - beats[k]));
  const total = n - 1;
  let best = { score: -Infinity, p: p0, ph: 0 };
  for (let r = 0.985; r <= 1.0151; r += 0.0005) {
    const p = p0 * r;
    const ph0 = median(beats.map((b, k) => b - k * p));
    for (let d = -p / 8; d <= p / 8; d += 0.25) {
      const ph = ph0 + d;
      let sum = 0;
      for (let k = 0; k < total; k++) for (let j = 0; j < 4; j++) sum += interp(onset, ph + (k + j / 4) * p);
      if (sum > best.score) best = { score: sum, p, ph };
    }
  }
  const grid = beats.map((_, k) => best.ph + k * best.p);
  // Steady tempo? Judge by how straight the tracked beats are (a constant slope error
  // is exactly what we are fixing, so compare against their own least-squares line).
  const mk = (n - 1) / 2;
  const mb = mean(beats);
  let sxy = 0;
  let sxx = 0;
  beats.forEach((b, k) => {
    sxy += (k - mk) * (b - mb);
    sxx += (k - mk) ** 2;
  });
  const slope = sxy / sxx;
  const dev = percentile(beats.map((b, k) => Math.abs(b - (mb + slope * (k - mk)))), 80);
  return dev <= 0.15 * best.p ? grid : beats;
}

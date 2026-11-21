// @ts-check
/**
 * Pure-JS DSP primitives (environment-agnostic: runs in the browser, a Web
 * Worker and Node tests). Replaces the numpy / librosa building blocks.
 */

/** @type {Map<number, {cos: Float64Array, sin: Float64Array, rev: Uint32Array}>} */
const fftTables = new Map();

/** @param {number} n power of two */
function tablesFor(n) {
  let t = fftTables.get(n);
  if (t) return t;
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  t = { cos, sin, rev };
  fftTables.set(n, t);
  return t;
}

/**
 * In-place iterative radix-2 complex FFT.
 * @param {Float64Array} re
 * @param {Float64Array} im
 */
export function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
  const { cos, sin, rev } = tablesFor(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const a = start + k;
        const b = a + half;
        const tr = re[b] * cos[w] - im[b] * sin[w];
        const ti = re[b] * sin[w] + im[b] * cos[w];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** Periodic Hann window. @param {number} n */
export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Number of centred frames for a signal. @param {number} len @param {number} hop */
export const frameCount = (len, hop) => Math.floor(len / hop) + 1;

/**
 * Centred STFT (librosa `center=True` convention: frame i is centred on sample i*hop).
 * Calls `cb(magnitude, frameIndex)` per frame; the magnitude buffer is reused.
 * @param {Float32Array} x
 * @param {number} nfft
 * @param {number} hop
 * @param {(mag: Float64Array, frame: number) => void} cb
 */
export function stftForEach(x, nfft, hop, cb) {
  const win = hann(nfft);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const mag = new Float64Array(nfft / 2 + 1);
  const frames = frameCount(x.length, hop);
  const halfN = nfft / 2;
  for (let f = 0; f < frames; f++) {
    const start = f * hop - halfN;
    for (let i = 0; i < nfft; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < x.length ? x[idx] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= halfN; k++) mag[k] = Math.hypot(re[k], im[k]);
    cb(mag, f);
  }
  return frames;
}

/**
 * Centred frame RMS envelope.
 * @param {Float32Array} x
 * @param {number} win
 * @param {number} hop
 */
export function rmsEnvelope(x, win, hop) {
  const frames = frameCount(x.length, hop);
  const out = new Float32Array(frames);
  // prefix sum of squares for O(1) windows
  const cum = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) cum[i + 1] = cum[i] + x[i] * x[i];
  const half = Math.floor(win / 2);
  for (let f = 0; f < frames; f++) {
    const a = Math.max(0, f * hop - half);
    const b = Math.min(x.length, f * hop + half);
    out[f] = b > a ? Math.sqrt((cum[b] - cum[a]) / win) : 0;
  }
  return out;
}

/**
 * Onset strength: log-compressed envelope, first difference, half-wave rectified.
 * @param {Float32Array} env
 * @param {number} [lag]
 */
export function onsetFromEnvelope(env, lag = 1, gain = 100) {
  let max = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > max) max = env[i];
  const out = new Float32Array(env.length);
  if (max <= 0) return out;
  const log = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) log[i] = Math.log1p((gain * env[i]) / max);
  for (let i = lag; i < env.length; i++) out[i] = Math.max(0, log[i] - log[i - lag]);
  return out;
}

/** @param {ArrayLike<number>} a */
export function mean(a) {
  if (!a.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

/** @param {ArrayLike<number>} a */
export function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
  return Math.sqrt(s / a.length);
}

/** @param {ArrayLike<number>} a @param {number} p 0..100 */
export function percentile(a, p) {
  if (!a.length) return 0;
  const sorted = Float64Array.from(a).sort();
  const pos = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** @param {ArrayLike<number>} a */
export const median = (a) => percentile(a, 50);

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b */
export function cosine(a, b) {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b */
export function pearson(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  }
  return aa > 1e-12 && bb > 1e-12 ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * Linear interpolation at fractional index (clamped).
 * @param {ArrayLike<number>} a
 * @param {number} pos
 */
export function interp(a, pos) {
  if (pos <= 0) return a[0] ?? 0;
  if (pos >= a.length - 1) return a[a.length - 1] ?? 0;
  const i = Math.floor(pos);
  const f = pos - i;
  return a[i] * (1 - f) + a[i + 1] * f;
}

/**
 * Sub-sample peak refinement by fitting a parabola through (i-1, i, i+1).
 * @param {ArrayLike<number>} a
 * @param {number} i
 * @returns {number} fractional offset in [-0.5, 0.5]
 */
export function parabolicOffset(a, i) {
  if (i <= 0 || i >= a.length - 1) return 0;
  const l = a[i - 1];
  const c = a[i];
  const r = a[i + 1];
  const d = l - 2 * c + r;
  if (Math.abs(d) < 1e-12) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / d));
}

/** @param {Float32Array} x @param {number} w */
export function movingAverage(x, w) {
  const out = new Float32Array(x.length);
  const half = Math.max(1, Math.floor(w / 2));
  let acc = 0;
  let count = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(x.length - 1, i + half);
    while (hi < b) acc += x[++hi], count++;
    while (lo < a) acc -= x[lo++], count--;
    out[i] = acc / count;
  }
  return out;
}

/** Max over [pos - radius, pos + radius] (fractional bounds). @param {ArrayLike<number>} a @param {number} pos @param {number} radius */
export function windowMax(a, pos, radius) {
  const lo = Math.max(0, Math.floor(pos - radius));
  const hi = Math.min(a.length - 1, Math.ceil(pos + radius));
  let m = 0;
  for (let i = lo; i <= hi; i++) if (a[i] > m) m = a[i];
  return m;
}

/**
 * Running minimum (centred window).
 * @param {ArrayLike<number>} x
 * @param {number} width
 */
export function minFilter(x, width) {
  const half = Math.floor(width / 2);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let m = Infinity;
    for (let k = Math.max(0, i - half); k <= Math.min(x.length - 1, i + half); k++) if (x[k] < m) m = x[k];
    out[i] = m;
  }
  return out;
}

/** @param {number} x */
export const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));

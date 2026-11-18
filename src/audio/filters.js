// @ts-check
/**
 * Butterworth IIR filters as cascaded second-order sections, matching
 * `scipy.signal.butter(N, Wn, btype, output='sos')` (bilinear transform with
 * pre-warping) and zero-phase `sosfiltfilt`.
 */

/** @typedef {{b0: number, b1: number, b2: number, a1: number, a2: number}} Biquad */

/**
 * Butterworth design for an even order as a list of biquads.
 * Section k uses Q_k = 1 / (2 cos((2k+1)π / 2N)).
 * @param {'lowpass' | 'highpass'} type
 * @param {number} order even, >= 2
 * @param {number} cutoff Hz
 * @param {number} sr Hz
 * @returns {Biquad[]}
 */
export function butterworthSOS(type, order, cutoff, sr) {
  if (order < 2 || order % 2 !== 0) throw new Error('Butterworth order must be even and >= 2');
  const nyq = sr / 2;
  const fc = Math.min(Math.max(cutoff, 1), nyq * 0.99);
  const w0 = (2 * Math.PI * fc) / sr;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  /** @type {Biquad[]} */
  const sections = [];
  for (let k = 0; k < order / 2; k++) {
    const q = 1 / (2 * Math.cos(((2 * k + 1) * Math.PI) / (2 * order)));
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    const b0 = type === 'lowpass' ? (1 - cw) / 2 : (1 + cw) / 2;
    const b1 = type === 'lowpass' ? 1 - cw : -(1 + cw);
    sections.push({ b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 });
  }
  return sections;
}

/**
 * Causal filtering (transposed direct form II), in place on a Float64Array.
 * @param {Float64Array} x
 * @param {Biquad[]} sos
 */
function sosfiltInPlace(x, sos) {
  for (const { b0, b1, b2, a1, a2 } of sos) {
    let z1 = 0;
    let z2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const y = b0 * xi + z1;
      z1 = b1 * xi - a1 * y + z2;
      z2 = b2 * xi - a2 * y;
      x[i] = y;
    }
  }
}

/**
 * Zero-phase forward/backward filtering with odd reflection padding
 * (like scipy's `sosfiltfilt(padtype='odd')`).
 * @param {Float32Array} x
 * @param {Biquad[]} sos
 * @returns {Float32Array}
 */
export function sosfiltfilt(x, sos) {
  const n = x.length;
  if (n === 0) return new Float32Array(0);
  const pad = Math.min(n - 1, 3 * (2 * sos.length + 1) * 64);
  const buf = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) buf[i] = 2 * x[0] - x[pad - i];
  for (let i = 0; i < n; i++) buf[pad + i] = x[i];
  for (let i = 0; i < pad; i++) buf[pad + n + i] = 2 * x[n - 1] - x[n - 2 - i];
  sosfiltInPlace(buf, sos);
  buf.reverse();
  sosfiltInPlace(buf, sos);
  buf.reverse();
  return Float32Array.from(buf.subarray(pad, pad + n));
}

/** @param {Float32Array} x @param {number} cutoff @param {number} sr @param {number} [order] */
export const lowpass = (x, cutoff, sr, order = 4) => sosfiltfilt(x, butterworthSOS('lowpass', order, cutoff, sr));

/** @param {Float32Array} x @param {number} cutoff @param {number} sr @param {number} [order] */
export const highpass = (x, cutoff, sr, order = 4) => sosfiltfilt(x, butterworthSOS('highpass', order, cutoff, sr));

/**
 * Band-pass as a high-pass + low-pass cascade (both Butterworth).
 * @param {Float32Array} x @param {number} lo @param {number} hi @param {number} sr @param {number} [order]
 */
export const bandpass = (x, lo, hi, sr, order = 4) =>
  sosfiltfilt(x, [...butterworthSOS('highpass', order, lo, sr), ...butterworthSOS('lowpass', order, hi, sr)]);

/**
 * Magnitude response of an SOS cascade at frequency f (used by tests).
 * @param {Biquad[]} sos @param {number} f @param {number} sr
 */
export function sosGain(sos, f, sr) {
  const w = (2 * Math.PI * f) / sr;
  let g = 1;
  for (const { b0, b1, b2, a1, a2 } of sos) {
    const nr = b0 + b1 * Math.cos(-w) + b2 * Math.cos(-2 * w);
    const ni = b1 * Math.sin(-w) + b2 * Math.sin(-2 * w);
    const dr = 1 + a1 * Math.cos(-w) + a2 * Math.cos(-2 * w);
    const di = a1 * Math.sin(-w) + a2 * Math.sin(-2 * w);
    g *= Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
  return g;
}

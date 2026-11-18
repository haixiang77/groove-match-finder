// @ts-check
/**
 * Browser audio I/O: decode any format the browser supports (mp3, m4a/AAC,
 * wav, flac, ogg…) to mono at the analysis sample rate, and encode WAV
 * excerpts for the fingerprint / Gemini APIs.
 */

export const TARGET_SR = 22050;

/**
 * decodeAudioData resamples to the context's rate, so an OfflineAudioContext
 * at 22.05 kHz gives us resampling for free.
 * @param {ArrayBuffer} data
 * @param {number} [sr]
 * @returns {Promise<{samples: Float32Array, sr: number, duration: number}>}
 */
export async function decodeToMono(data, sr = TARGET_SR) {
  const w = /** @type {any} */ (globalThis);
  const Ctx = w.OfflineAudioContext || w.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('このブラウザは Web Audio API に対応していません');
  const ctx = new Ctx(1, 1, sr);
  /** @type {AudioBuffer} */
  const buf = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data.slice(0), resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  }).catch((err) => {
    throw new Error(`音声をデコードできませんでした（${err?.message ?? '未対応の形式'}）`);
  });
  const n = buf.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return { samples: out, sr: buf.sampleRate, duration: buf.duration };
}

/**
 * 16-bit PCM mono WAV.
 * @param {Float32Array} samples
 * @param {number} sr
 * @returns {Blob}
 */
export function encodeWav(samples, sr) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const str = (/** @type {number} */ off, /** @type {string} */ t) => {
    for (let i = 0; i < t.length; i++) v.setUint8(off + i, t.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const gain = peak > 1 ? 1 / peak : 1;
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i] * gain)) * 0x7fff, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

/** @param {Blob} blob */
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/**
 * Down-sample to a min/max peak overview for the waveform display.
 * @param {Float32Array} samples
 * @param {number} buckets
 */
export function waveformPeaks(samples, buckets) {
  const out = new Float32Array(buckets * 2);
  const size = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let mn = 0;
    let mx = 0;
    for (let i = b * size; i < Math.min(samples.length, (b + 1) * size); i++) {
      if (samples[i] < mn) mn = samples[i];
      if (samples[i] > mx) mx = samples[i];
    }
    out[b * 2] = mn;
    out[b * 2 + 1] = mx;
  }
  return out;
}

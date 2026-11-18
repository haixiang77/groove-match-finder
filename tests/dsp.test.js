import { test } from 'node:test';
import assert from 'node:assert/strict';
import { butterworthSOS, sosGain, sosfiltfilt } from '../src/audio/filters.js';
import { fft, cosine, pearson, percentile } from '../src/audio/dsp.js';
import { camelot, estimateKey } from '../src/audio/key.js';

test('Butterworth low-pass: -3 dB at cutoff, flat passband, steep stopband', () => {
  const sos = butterworthSOS('lowpass', 4, 1000, 22050);
  assert.ok(Math.abs(sosGain(sos, 1000, 22050) - Math.SQRT1_2) < 0.01);
  assert.ok(Math.abs(sosGain(sos, 100, 22050) - 1) < 0.01);
  assert.ok(sosGain(sos, 4000, 22050) < 0.01); // 4th order: -24 dB/oct → ~-48 dB two octaves up
});

test('Butterworth high-pass: -3 dB at cutoff', () => {
  const sos = butterworthSOS('highpass', 4, 6000, 22050);
  assert.ok(Math.abs(sosGain(sos, 6000, 22050) - Math.SQRT1_2) < 0.01);
  assert.ok(sosGain(sos, 1500, 22050) < 0.01);
});

test('sosfiltfilt is zero-phase (no time shift of a pulse)', () => {
  const x = new Float32Array(4096);
  x[2048] = 1;
  const y = sosfiltfilt(x, butterworthSOS('lowpass', 4, 500, 22050));
  let peak = 0;
  for (let i = 1; i < y.length; i++) if (y[i] > y[peak]) peak = i;
  assert.equal(peak, 2048);
});

test('FFT finds a pure tone', () => {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 37 * i) / n);
  fft(re, im);
  let best = 0;
  for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[best], im[best])) best = k;
  assert.equal(best, 37);
});

test('vector helpers', () => {
  assert.ok(Math.abs(cosine([1, 0, 1], [1, 0, 1]) - 1) < 1e-9);
  assert.ok(Math.abs(pearson([1, 2, 3], [3, 2, 1]) + 1) < 1e-9);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
});

test('Camelot codes', () => {
  assert.equal(camelot(0, 'major'), '8B');
  assert.equal(camelot(9, 'minor'), '8A');
  assert.equal(camelot(7, 'major'), '9B');
  assert.equal(camelot(5, 'major'), '7B');
});

test('key estimation: sustained C-major triad + bass', () => {
  const sr = 22050;
  const x = new Float32Array(sr * 8);
  const notes = [130.81, 261.63, 329.63, 392.0, 523.25];
  for (let i = 0; i < x.length; i++) for (const f of notes) x[i] += 0.1 * Math.sin((2 * Math.PI * f * i) / sr);
  const { key } = estimateKey(x, sr);
  assert.equal(key.tonic, 0);
  assert.equal(key.mode, 'major');
});

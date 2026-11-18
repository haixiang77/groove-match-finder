// @ts-check
/// <reference lib="webworker" />
/**
 * Web Worker running the DSP analysis off the main thread.
 * In: {id, samples: Float32Array, sr}  Out: {id, ok, features | error}
 */
import { analyzeAudio } from './analyzer.js';

self.addEventListener('message', (ev) => {
  const { id, samples, sr } = /** @type {MessageEvent<{id: number, samples: Float32Array, sr: number}>} */ (ev).data;
  try {
    const features = analyzeAudio(samples, sr);
    self.postMessage({ id, ok: true, features });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

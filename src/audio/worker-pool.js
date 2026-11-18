// @ts-check
/**
 * Small pool of analysis workers with a main-thread fallback (used when module
 * workers are unavailable, e.g. when the page is opened from file://).
 */
import { AudioFeaturesSchema } from '../types.js';

/** @typedef {import('../types.js').AudioFeatures} AudioFeatures */

/**
 * @typedef {Object} Job
 * @property {number} id
 * @property {Float32Array} samples
 * @property {number} sr
 * @property {(f: AudioFeatures) => void} resolve
 * @property {(e: Error) => void} reject
 */

export class AnalysisPool {
  /** @param {number} [size] */
  constructor(size = Math.max(1, Math.min(3, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1))) {
    /** @type {{worker: Worker, busy: Job | null}[]} */
    this.workers = [];
    /** @type {Job[]} */
    this.queue = [];
    this.nextId = 1;
    this.inline = false;
    try {
      for (let i = 0; i < size; i++) {
        const worker = new Worker(new URL('./analysis.worker.js', import.meta.url), { type: 'module' });
        const slot = { worker, busy: /** @type {Job | null} */ (null) };
        worker.addEventListener('message', (ev) => this.#onMessage(slot, ev.data));
        worker.addEventListener('error', (ev) => this.#onError(slot, ev));
        this.workers.push(slot);
      }
    } catch {
      this.inline = true;
    }
  }

  /**
   * @param {Float32Array} samples (transferred to the worker — don't reuse)
   * @param {number} sr
   * @returns {Promise<AudioFeatures>}
   */
  analyze(samples, sr) {
    if (this.inline) return this.#analyzeInline(samples, sr);
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, samples, sr, resolve, reject });
      this.#pump();
    });
  }

  /** @param {Float32Array} samples @param {number} sr */
  async #analyzeInline(samples, sr) {
    const { analyzeAudio } = await import('./analyzer.js');
    // Yield so the UI can paint between heavy jobs.
    await new Promise((r) => setTimeout(r, 0));
    return analyzeAudio(samples, sr);
  }

  #pump() {
    for (const slot of this.workers) {
      if (slot.busy) continue;
      const job = this.queue.shift();
      if (!job) return;
      slot.busy = job;
      slot.worker.postMessage({ id: job.id, samples: job.samples, sr: job.sr }, [job.samples.buffer]);
    }
  }

  /** @param {{worker: Worker, busy: Job | null}} slot @param {{id: number, ok: boolean, features?: unknown, error?: string}} msg */
  #onMessage(slot, msg) {
    const job = slot.busy;
    slot.busy = null;
    if (job && job.id === msg.id) {
      if (msg.ok) {
        const parsed = AudioFeaturesSchema.safeParse(msg.features);
        if (parsed.ok) job.resolve(/** @type {AudioFeatures} */ (parsed.value));
        else job.reject(new Error(`解析結果の検証に失敗: ${parsed.issues[0]?.path} ${parsed.issues[0]?.message}`));
      } else job.reject(new Error(msg.error ?? '解析に失敗しました'));
    }
    this.#pump();
  }

  /** @param {{worker: Worker, busy: Job | null}} slot @param {ErrorEvent} ev */
  #onError(slot, ev) {
    ev.preventDefault?.();
    // Worker failed to load/execute: switch everything to inline mode.
    const pending = [...(slot.busy ? [slot.busy] : []), ...this.queue];
    this.queue = [];
    slot.busy = null;
    if (!this.inline) {
      this.inline = true;
      for (const s of this.workers) s.worker.terminate();
      this.workers = [];
    }
    for (const job of pending) {
      if (job.samples.byteLength === 0) job.reject(new Error('ワーカーでの解析に失敗しました'));
      else this.#analyzeInline(job.samples, job.sr).then(job.resolve, job.reject);
    }
  }

  terminate() {
    for (const s of this.workers) s.worker.terminate();
    this.workers = [];
  }
}

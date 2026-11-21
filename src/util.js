// @ts-check
/** Shared helpers: async control flow, rate limiting, text normalisation. */

/** @param {number} ms @param {AbortSignal} [signal] */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** @param {unknown} err */
export function isAbortError(err) {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** @param {unknown} err */
export function errorMessage(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Token-bucket rate limiter. Calls are serialised in FIFO order.
 * iTunes Search allows roughly 20 requests / minute per IP, MusicBrainz 1 / second.
 */
export class RateLimiter {
  /** @param {{capacity: number, refillMs: number}} opts */
  constructor({ capacity, refillMs }) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillMs = refillMs;
    this.last = Date.now();
    /** @type {Promise<void>} */
    this.queue = Promise.resolve();
  }

  #refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) / this.refillMs);
    this.last = now;
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @param {{onWait?: (ms: number) => void, signal?: AbortSignal}} [opts]
   * @returns {Promise<T>}
   */
  schedule(fn, opts = {}) {
    const acquire = async () => {
      this.#refill();
      if (this.tokens < 1) {
        const wait = Math.ceil((1 - this.tokens) * this.refillMs);
        opts.onWait?.(wait);
        await sleep(wait, opts.signal);
        this.#refill();
      }
      this.tokens -= 1;
    };
    const slot = this.queue.then(acquire);
    this.queue = slot.catch(() => {});
    return slot.then(fn);
  }
}

/**
 * Run `fn` over items with bounded concurrency. Results keep input order;
 * failures are returned as `{ok:false}` instead of rejecting the whole batch.
 * @template I, O
 * @param {I[]} items
 * @param {number} limit
 * @param {(item: I, index: number) => Promise<O>} fn
 * @param {AbortSignal} [signal]
 * @returns {Promise<({ok: true, value: O} | {ok: false, error: unknown})[]>}
 */
export async function mapPool(items, limit, fn, signal) {
  /** @type {({ok: true, value: O} | {ok: false, error: unknown})[]} */
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (signal?.aborted) return;
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  return results;
}

/**
 * Normalise a title / artist for de-duplication and fuzzy matching:
 * NFKC, lowercase, drop "(feat. …)", "[Remastered]", "- Radio Edit" etc.
 * @param {string} text
 */
export function normalizeText(text) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s*[([（【].*?(feat|ft\.|with|remaster|version|edit|mix|live|mono|stereo|ver\.|bonus).*?[)\]）】]/g, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mix|live).*$/g, '')
    .replace(/\s+(feat\.?|ft\.?)\s+.*$/g, '')
    .replace(/[\s'"’`.,!?！？・:;/\\\-–—_~〜()[\]（）「」『』]+/g, '')
    .trim();
}

/** @param {string} artist @param {string} title */
export function trackKey(artist, title) {
  return `${normalizeText(artist)}|${normalizeText(title)}`;
}

/**
 * Sørensen–Dice coefficient on character bigrams of the normalised strings.
 * @param {string} a
 * @param {string} b
 */
export function textSimilarity(a, b) {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x.includes(y) || y.includes(x) ? 0.8 : 0;
  /** @type {Map<string, number>} */
  const grams = new Map();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const c = grams.get(g) ?? 0;
    if (c > 0) {
      hits++;
      grams.set(g, c - 1);
    }
  }
  const dice = (2 * hits) / (x.length - 1 + (y.length - 1));
  const containment = x.includes(y) || y.includes(x) ? 0.85 : 0;
  return Math.max(dice, containment);
}

/**
 * Guess "Artist - Title" from a file name. Used as the last-resort identification.
 * @param {string} fileName
 * @returns {{artist: string, title: string} | null}
 */
export function parseFileName(fileName) {
  const base = fileName.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ').replace(/^\d{1,3}[\s.-]+/, '').trim();
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (!m) return null;
  return { artist: m[1].trim(), title: m[2].trim() };
}

/** @param {number} v @param {number} [lo] @param {number} [hi] */
export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/** @param {number} seconds */
export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Normalised artist tokens: lowercase, `feat.`/`ft.` suffix dropped, and
 * collaborations split on `&`, `×`, standalone `x`, `and`, `、` and `,`.
 * Two artist strings denote the same artist when their token sets intersect.
 * @param {string} artist
 * @returns {Set<string>}
 */
export function artistTokens(artist) {
  const s = String(artist ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s*[([]\s*(feat|ft)\b.*?[)\]]/g, '')
    .replace(/\s+(feat|ft)\b\.?\s+.*$/g, '');
  /** @type {Set<string>} */
  const out = new Set();
  for (const part of s.split(/\s*[&×、,]\s*|\s+x\s+|\s+and\s+/)) {
    const t = part.trim();
    if (t) out.add(t);
  }
  return out;
}

/** @param {string} a @param {string} b */
export function sameArtist(a, b) {
  const x = artistTokens(a);
  for (const t of artistTokens(b)) if (x.has(t)) return true;
  return false;
}

// @ts-check
/**
 * iTunes Search API — metadata + 30-second previews (no API key required).
 * Rate limit is roughly 20 requests / minute per IP, so every call goes through
 * a shared token bucket and results are cached in memory.
 */
import { s } from '../schema.js';
import { RateLimiter, sleep, textSimilarity, trackKey } from '../util.js';
import { fetchJson, jsonp, viaProxy } from './http.js';

const ItunesTrackSchema = s.object({
  trackId: s.number(),
  trackName: s.string(),
  artistName: s.string(),
  collectionName: s.string().optional(),
  previewUrl: s.string().optional(),
  artworkUrl100: s.string().optional(),
  trackViewUrl: s.string().optional(),
  primaryGenreName: s.string().optional(),
  releaseDate: s.string().optional(),
  trackTimeMillis: s.number().optional(),
  kind: s.string().optional(),
  isrc: s.string().optional(),
});
/** @typedef {ReturnType<typeof ItunesTrackSchema.parse>} ItunesTrack */

const SearchResponseSchema = s.object({
  resultCount: s.number(),
  results: s.array(ItunesTrackSchema, { dropInvalid: true }),
});

export const itunesLimiter = new RateLimiter({ capacity: 12, refillMs: 3200 });

/** @type {Map<string, ItunesTrack[]>} */
const cache = new Map();

/**
 * @typedef {Object} ItunesOptions
 * @property {string} country    ISO country (JP, US, …)
 * @property {string} proxy      optional CORS proxy
 * @property {AbortSignal} [signal]
 * @property {(ms: number) => void} [onWait]
 * @property {{left: number}} [budget]  max network searches left in this run (cache hits are free)
 */

/**
 * @param {Record<string, string | number>} params
 * @param {ItunesOptions} opts
 * @param {'search' | 'lookup'} [endpoint]
 * @returns {Promise<ItunesTrack[]>}
 */
async function query(params, opts, endpoint = 'search') {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  qs.set('country', opts.country || 'JP');
  const url = `https://itunes.apple.com/${endpoint}?${qs}`;
  const key = cacheKey(endpoint, params, qs.get('country') ?? '');
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;
  if (opts.budget) {
    if (opts.budget.left <= 0) throw new Error('iTunes 検索数の上限に達したためスキップ');
    opts.budget.left--;
  }
  const p = fetchResults(url, key, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Normalised key so case / spacing variants of one search share a result. */
function cacheKey(/** @type {string} */ endpoint, /** @type {Record<string, string | number>} */ params, /** @type {string} */ country) {
  const norm = Object.entries(params)
    .map(([k, v]) => [k, String(v).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()])
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `${endpoint}|${country}|${JSON.stringify(norm)}`;
}

/** @type {Map<string, Promise<ItunesTrack[]>>} */
const inflight = new Map();

/**
 * @param {string} url
 * @param {string} key
 * @param {ItunesOptions} opts
 * @returns {Promise<ItunesTrack[]>}
 */
async function fetchResults(url, key, opts) {
  const data = await itunesLimiter.schedule(
    async () => {
      // JSONP first: it is immune to CORS. Fall back to fetch (direct, then proxy).
      try {
        return await jsonp(url, { signal: opts.signal });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        // JSONP failures are often rate limiting: back off briefly before retrying via fetch.
        await sleep(1500, opts.signal);
        try {
          return await fetchJson(url, { signal: opts.signal, retries: 1 });
        } catch (err2) {
          if (!opts.proxy) throw err2;
          return fetchJson(viaProxy(url, opts.proxy), { signal: opts.signal, retries: 1 });
        }
      }
    },
    { onWait: opts.onWait, signal: opts.signal },
  );
  const parsed = SearchResponseSchema.parse(data).results.filter((r) => !r.kind || r.kind === 'song');
  cache.set(key, parsed);
  return parsed;
}

/**
 * @param {string} term
 * @param {ItunesOptions & {limit?: number, attribute?: string}} opts
 */
export function searchSongs(term, opts) {
  /** @type {Record<string, string | number>} */
  const params = { term, media: 'music', entity: 'song', limit: opts.limit ?? 15 };
  if (opts.attribute) params.attribute = opts.attribute;
  return query(params, opts);
}

/**
 * Find the iTunes track that best matches artist + title.
 * @param {string} artist
 * @param {string} title
 * @param {ItunesOptions} opts
 * @returns {Promise<ItunesTrack | null>}
 */
export async function resolveTrack(artist, title, opts) {
  const results = await searchSongs(`${artist} ${title}`, { ...opts, limit: 8 });
  let best = null;
  let bestScore = 0;
  for (const r of results) {
    const sc = 0.55 * textSimilarity(r.trackName, title) + 0.45 * textSimilarity(r.artistName, artist);
    if (sc > bestScore) {
      bestScore = sc;
      best = r;
    }
  }
  return bestScore >= 0.62 ? best : null;
}

/**
 * Convert to the pipeline's Candidate shape.
 * @param {ItunesTrack} t
 * @param {string} source
 * @param {number} weight
 * @returns {import('../types.js').Candidate}
 */
export function toCandidate(t, source, weight) {
  return {
    key: trackKey(t.artistName, t.trackName),
    artist: t.artistName,
    title: t.trackName,
    sources: [source],
    weight,
    previewUrl: t.previewUrl,
    artworkUrl: t.artworkUrl100?.replace('100x100bb', '200x200bb'),
    trackViewUrl: t.trackViewUrl,
    genre: t.primaryGenreName,
    itunesId: t.trackId,
    album: t.collectionName,
    releaseYear: t.releaseDate ? new Date(t.releaseDate).getFullYear() : undefined,
  };
}

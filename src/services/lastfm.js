// @ts-check
/**
 * Last.fm API — similar tracks / artists and crowd-sourced tags.
 * Requires a free API key (https://www.last.fm/api/account/create). CORS-enabled.
 */
import { s } from '../schema.js';
import { RateLimiter } from '../util.js';
import { HttpError, fetchJson } from './http.js';

const BASE = 'https://ws.audioscrobbler.com/2.0/';
const limiter = new RateLimiter({ capacity: 5, refillMs: 250 });

const ArtistRef = s.object({ name: s.string() });
const TrackRef = s.object({
  name: s.string(),
  artist: ArtistRef,
  match: s.number({ coerce: true }).optional(),
  playcount: s.number({ coerce: true }).optional(),
});
const Tag = s.object({ name: s.string(), count: s.number({ coerce: true }).optional() });

export class LastfmError extends Error {}

/**
 * @param {Record<string, string | number>} params
 * @param {string} apiKey
 * @param {AbortSignal} [signal]
 */
async function call(params, apiKey, signal) {
  const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), api_key: apiKey, format: 'json', autocorrect: '1' });
  const data = await limiter.schedule(() => fetchJson(`${BASE}?${qs}`, { signal }), { signal });
  const err = s.object({ error: s.number(), message: s.string() }).safeParse(data);
  if (err.ok) throw new LastfmError(`Last.fm: ${err.value.message} (code ${err.value.error})`);
  return /** @type {Record<string, any>} */ (data);
}

/**
 * @param {string} artist @param {string} track @param {string} apiKey @param {AbortSignal} [signal]
 * @returns {Promise<{artist: string, title: string, match: number}[]>}
 */
export async function getSimilarTracks(artist, track, apiKey, signal, limit = 40) {
  const data = await call({ method: 'track.getSimilar', artist, track, limit }, apiKey, signal);
  return s
    .oneOrMany(TrackRef)
    .parse(data?.similartracks?.track)
    .map((t) => ({ artist: t.artist.name, title: t.name, match: t.match ?? 0.5 }));
}

/**
 * @param {string} artist @param {string} track @param {string} apiKey @param {AbortSignal} [signal]
 * @returns {Promise<{name: string, weight: number}[]>}
 */
export async function getTrackTags(artist, track, apiKey, signal) {
  const data = await call({ method: 'track.getTopTags', artist, track }, apiKey, signal);
  return normaliseTags(s.oneOrMany(Tag).parse(data?.toptags?.tag));
}

/**
 * @param {string} artist @param {string} apiKey @param {AbortSignal} [signal]
 * @returns {Promise<{name: string, weight: number}[]>}
 */
export async function getArtistTags(artist, apiKey, signal) {
  const data = await call({ method: 'artist.getTopTags', artist }, apiKey, signal);
  return normaliseTags(s.oneOrMany(Tag).parse(data?.toptags?.tag));
}

/** Max candidates that get a per-candidate tag lookup (API cost cap). */
export const CANDIDATE_TAG_LIMIT = 12;
/** Fewer track tags than this → artist tags are appended. */
const MIN_TRACK_TAGS = 3;
/** @type {Map<string, Promise<{name: string, weight: number}[] | null>>} */
const candidateTagCache = new Map();

/** Drop the candidate tag cache (tests). */
export function clearCandidateTagCache() {
  candidateTagCache.clear();
}

/**
 * Tags for one candidate (track tags, topped up with artist tags). Cached per
 * artist+title, concurrent calls share one request. Never throws except on abort:
 * missing key / failure / no tags → null.
 * @param {string} artist @param {string} track @param {string} apiKey @param {AbortSignal} [signal]
 * @returns {Promise<{name: string, weight: number}[] | null>}
 */
export function getCandidateTags(artist, track, apiKey, signal) {
  if (!apiKey) return Promise.resolve(null);
  const key = `${artist.toLowerCase()}|${track.toLowerCase()}`;
  const hit = candidateTagCache.get(key);
  if (hit) return hit;
  const p = (async () => {
    try {
      let tags = await getTrackTags(artist, track, apiKey, signal).catch((err) => {
        if (signal?.aborted) throw err;
        return /** @type {{name: string, weight: number}[]} */ ([]);
      });
      if (tags.length < MIN_TRACK_TAGS) tags = [...tags, ...(await getArtistTags(artist, apiKey, signal))];
      return tags.length ? tags : null;
    } catch (err) {
      if (signal?.aborted) {
        candidateTagCache.delete(key);
        throw err;
      }
      return null;
    }
  })();
  candidateTagCache.set(key, p);
  return p;
}

/**
 * @param {string} artist @param {string} apiKey @param {AbortSignal} [signal]
 * @returns {Promise<{name: string, match: number}[]>}
 */
export async function getSimilarArtists(artist, apiKey, signal, limit = 12) {
  const data = await call({ method: 'artist.getSimilar', artist, limit }, apiKey, signal);
  return s
    .oneOrMany(s.object({ name: s.string(), match: s.number({ coerce: true }).optional() }))
    .parse(data?.similarartists?.artist)
    .map((a) => ({ name: a.name, match: a.match ?? 0.5 }));
}

/**
 * @param {string} artist @param {string} apiKey @param {AbortSignal} [signal]
 * @returns {Promise<{artist: string, title: string}[]>}
 */
export async function getArtistTopTracks(artist, apiKey, signal, limit = 4) {
  const data = await call({ method: 'artist.getTopTracks', artist, limit }, apiKey, signal);
  return s
    .oneOrMany(TrackRef)
    .parse(data?.toptracks?.track)
    .map((t) => ({ artist: t.artist.name, title: t.name }));
}

/**
 * @param {string} tag @param {string} apiKey @param {AbortSignal} [signal]
 * @returns {Promise<{artist: string, title: string}[]>}
 */
export async function getTagTopTracks(tag, apiKey, signal, limit = 15) {
  const data = await call({ method: 'tag.getTopTracks', tag, limit }, apiKey, signal);
  return s
    .oneOrMany(TrackRef)
    .parse(data?.tracks?.track)
    .map((t) => ({ artist: t.artist.name, title: t.name }));
}

/** @param {{name: string, count?: number}[]} tags */
function normaliseTags(tags) {
  const max = Math.max(1, ...tags.map((t) => t.count ?? 0));
  return tags.slice(0, 15).map((t) => ({ name: t.name, weight: (t.count ?? max / 2) / max }));
}

/** @param {unknown} err */
export const isLastfmAuthError = (err) => err instanceof LastfmError && /code (10|26)\)/.test(err.message) || (err instanceof HttpError && err.status === 403);

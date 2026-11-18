// @ts-check
/**
 * MusicBrainz — open music encyclopedia (no key, CORS-enabled, 1 req/s).
 * Used for genre/tag metadata when Last.fm is not configured, and to resolve
 * ISRCs from fingerprint results.
 */
import { s } from '../schema.js';
import { RateLimiter, textSimilarity } from '../util.js';
import { fetchJson } from './http.js';

const BASE = 'https://musicbrainz.org/ws/2';
const limiter = new RateLimiter({ capacity: 1, refillMs: 1100 });

const TagSchema = s.object({ name: s.string(), count: s.number({ coerce: true }).optional() });
const RecordingSchema = s.object({
  id: s.string(),
  title: s.string(),
  score: s.number({ coerce: true }).optional(),
  'artist-credit': s.array(s.object({ name: s.string(), artist: s.object({ id: s.string(), name: s.string() }).optional() }), { dropInvalid: true }).optional(),
  tags: s.array(TagSchema, { dropInvalid: true }).optional(),
  genres: s.array(TagSchema, { dropInvalid: true }).optional(),
});

/** @param {string} path @param {AbortSignal} [signal] */
const get = (path, signal) => limiter.schedule(() => fetchJson(`${BASE}${path}${path.includes('?') ? '&' : '?'}fmt=json`, { signal }), { signal });

/**
 * Look up genres/tags for a recording (by ISRC if available, else search).
 * @param {{artist: string, title: string, isrc?: string}} q
 * @param {AbortSignal} [signal]
 * @returns {Promise<{name: string, weight: number}[]>}
 */
export async function getRecordingTags(q, signal) {
  /** @type {ReturnType<typeof RecordingSchema.parse>[]} */
  let recs = [];
  if (q.isrc) {
    const data = /** @type {any} */ (await get(`/isrc/${encodeURIComponent(q.isrc)}?inc=tags+genres+artist-credits`, signal).catch(() => null));
    recs = s.array(RecordingSchema, { dropInvalid: true }).parse(data?.recordings ?? []);
  }
  if (!recs.length) {
    const query = `recording:"${q.title.replace(/"/g, '')}" AND artist:"${q.artist.replace(/"/g, '')}"`;
    const data = /** @type {any} */ (await get(`/recording?query=${encodeURIComponent(query)}&limit=5`, signal));
    recs = s.array(RecordingSchema, { dropInvalid: true }).parse(data?.recordings ?? []);
    recs = recs.filter((r) => textSimilarity(r.title, q.title) > 0.6);
  }
  /** @type {Map<string, number>} */
  const tags = new Map();
  for (const r of recs.slice(0, 3)) for (const t of [...(r.genres ?? []), ...(r.tags ?? [])]) tags.set(t.name, (tags.get(t.name) ?? 0) + (t.count ?? 1));

  // Recordings are often untagged — fall back to the artist's genres.
  const artistId = recs[0]?.['artist-credit']?.[0]?.artist?.id;
  if (tags.size < 2 && artistId) {
    const data = /** @type {any} */ (await get(`/artist/${artistId}?inc=genres+tags`, signal).catch(() => null));
    for (const t of s.array(TagSchema, { dropInvalid: true }).parse([...(data?.genres ?? []), ...(data?.tags ?? [])]))
      tags.set(t.name, (tags.get(t.name) ?? 0) + (t.count ?? 1));
  }
  const max = Math.max(1, ...tags.values());
  return [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, c]) => ({ name, weight: c / max }));
}

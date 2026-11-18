// @ts-check
/**
 * Step 1a — audio fingerprint identification (Shazam-style).
 *
 * `shazamio` (Python) talks to Shazam's private endpoints, which a browser on
 * GitHub Pages cannot reach (CORS + request signing). The browser-friendly
 * equivalents are commercial fingerprint APIs with public HTTP endpoints:
 *   - AudD     (https://audd.io)      — one token, multipart upload
 *   - ACRCloud (https://acrcloud.com) — access key + HMAC-SHA1 signature
 * Both receive a ~12 s WAV excerpt around the loudest section (drop / chorus).
 */
import { s } from '../schema.js';
import { fetchCorsAware } from './http.js';

/** @typedef {import('../types.js').Identification} Identification */

export class FingerprintError extends Error {}

const AuddSchema = s.object({
  status: s.string(),
  result: s
    .object({
      artist: s.string(),
      title: s.string(),
      album: s.string().optional(),
      apple_music: s.object({ isrc: s.string().optional(), url: s.string().optional() }).optional(),
      spotify: s.object({ external_ids: s.object({ isrc: s.string().optional() }).optional() }).optional(),
    })
    .optional(),
  error: s.object({ error_code: s.number().optional(), error_message: s.string().optional() }).optional(),
});

/**
 * @param {Blob} wav
 * @param {{token: string, proxy: string, signal?: AbortSignal}} opts
 * @returns {Promise<Identification | null>} null = no match
 */
export async function identifyWithAudD(wav, opts) {
  const form = new FormData();
  form.append('api_token', opts.token);
  form.append('file', wav, 'excerpt.wav');
  form.append('return', 'apple_music,spotify');
  const res = await fetchCorsAware('https://api.audd.io/', opts.proxy, { method: 'POST', body: form, signal: opts.signal, timeoutMs: 30000 });
  if (!res.ok) throw new FingerprintError(`AudD HTTP ${res.status}`);
  const data = AuddSchema.parse(await res.json());
  if (data.status !== 'success') throw new FingerprintError(`AudD: ${data.error?.error_message ?? 'error'}`);
  if (!data.result) return null;
  const r = data.result;
  const appleId = r.apple_music?.url?.match(/[?&]i=(\d+)/)?.[1] ?? r.apple_music?.url?.match(/\/(\d+)(?:\?|$)/)?.[1];
  return {
    title: r.title,
    artist: r.artist,
    album: r.album,
    isrc: r.apple_music?.isrc ?? r.spotify?.external_ids?.isrc,
    appleMusicId: appleId,
    source: 'audd',
    confidence: 0.95,
  };
}

const AcrSchema = s.object({
  status: s.object({ code: s.number(), msg: s.string() }),
  metadata: s
    .object({
      music: s.array(
        s.object({
          title: s.string(),
          artists: s.array(s.object({ name: s.string() }), { dropInvalid: true }).optional(),
          album: s.object({ name: s.string() }).optional(),
          score: s.number({ coerce: true }).optional(),
          external_ids: s.object({ isrc: s.string().optional() }).optional(),
          genres: s.array(s.object({ name: s.string() }), { dropInvalid: true }).optional(),
        }),
        { dropInvalid: true },
      ),
    })
    .optional(),
});

/** @param {string} secret @param {string} message */
async function hmacSha1Base64(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * @param {Blob} wav
 * @param {{host: string, accessKey: string, accessSecret: string, proxy: string, signal?: AbortSignal}} opts
 * @returns {Promise<Identification | null>}
 */
export async function identifyWithACRCloud(wav, opts) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = ['POST', '/v1/identify', opts.accessKey, 'audio', '1', timestamp].join('\n');
  const signature = await hmacSha1Base64(opts.accessSecret, stringToSign);
  const form = new FormData();
  form.append('sample', wav, 'excerpt.wav');
  form.append('sample_bytes', String(wav.size));
  form.append('access_key', opts.accessKey);
  form.append('data_type', 'audio');
  form.append('signature_version', '1');
  form.append('signature', signature);
  form.append('timestamp', timestamp);
  const host = opts.host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const res = await fetchCorsAware(`https://${host}/v1/identify`, opts.proxy, { method: 'POST', body: form, signal: opts.signal, timeoutMs: 30000 });
  if (!res.ok) throw new FingerprintError(`ACRCloud HTTP ${res.status}`);
  const data = AcrSchema.parse(await res.json());
  if (data.status.code === 1001) return null; // no result
  if (data.status.code !== 0) throw new FingerprintError(`ACRCloud: ${data.status.msg}`);
  const m = data.metadata?.music?.[0];
  if (!m) return null;
  return {
    title: m.title,
    artist: (m.artists ?? []).map((a) => a.name).join(', ') || 'Unknown',
    album: m.album?.name,
    isrc: m.external_ids?.isrc,
    source: 'acrcloud',
    confidence: Math.min(1, (m.score ?? 80) / 100),
    genreTags: (m.genres ?? []).map((g) => g.name),
  };
}

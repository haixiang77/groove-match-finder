// @ts-check
/**
 * Track-link intake: parse a pasted URL (Apple Music / iTunes / YouTube) and
 * resolve it to a track with an iTunes 30s preview. Parsing and title cleanup
 * are pure so they can be unit-tested without a network.
 */
import { s } from '../schema.js';
import { textSimilarity } from '../util.js';
import { fetchJson, HttpError, NetworkError } from './http.js';
import { searchSongs, lookupTrack } from './itunes.js';

/**
 * @typedef {{kind: 'apple', trackId: number, country: string} | {kind: 'youtube', videoId: string, url: string}} ParsedUrl
 */

/** User-facing (Japanese) error for link problems. */
export class UrlSourceError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UrlSourceError';
  }
}

const APPLE_HOSTS = new Set(['music.apple.com', 'itunes.apple.com', 'geo.music.apple.com']);
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const VIDEO_ID = /^[\w-]{11}$/;

/**
 * @param {string} raw
 * @returns {ParsedUrl}
 * @throws {UrlSourceError}
 */
export function parseTrackUrl(raw) {
  const text = raw.trim();
  if (!text) throw new UrlSourceError('URLを入力してください。');
  /** @type {URL} */
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new UrlSourceError('URLの形式が正しくありません。https:// から始まる曲のリンクを貼り付けてください。');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UrlSourceError('http(s) のURLのみ対応しています。');
  const host = u.hostname.toLowerCase();

  if (APPLE_HOSTS.has(host)) {
    const country = /^\/([a-z]{2})\//i.exec(u.pathname)?.[1]?.toUpperCase() ?? '';
    // Song links look like /jp/album/name/123?i=456 (the track is `i`), or /jp/song/name/456.
    const i = u.searchParams.get('i');
    const song = /\/song\/(?:[^/]+\/)?(\d+)\/?$/.exec(u.pathname)?.[1];
    const id = i ?? song;
    if (id && /^\d+$/.test(id)) return { kind: 'apple', trackId: Number(id), country };
    if (/\/(album|playlist|artist)\//.test(u.pathname)) throw new UrlSourceError('アルバム・プレイリスト・アーティストのリンクは未対応です。曲単体のリンクを貼り付けてください。');
    throw new UrlSourceError('Apple Music のリンクから曲を特定できませんでした。曲単体の共有リンクを貼り付けてください。');
  }

  if (YT_HOSTS.has(host)) {
    let id = '';
    if (host === 'youtu.be') id = u.pathname.split('/')[1] ?? '';
    else if (u.pathname === '/watch') id = u.searchParams.get('v') ?? '';
    else id = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname)?.[1] ?? '';
    if (!VIDEO_ID.test(id)) {
      throw new UrlSourceError('YouTube のリンクから動画を特定できませんでした。動画単体のリンクを貼り付けてください。');
    }
    return { kind: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
  }

  throw new UrlSourceError('未対応のサイトです。Apple Music / iTunes / YouTube のリンクのみ対応しています。');
}

const NOISE = [
  /[([【［「『][^)\]】］」』]*(official|music video|mv|lyric|lyrics|audio|video|visualizer|hd|4k|remaster(ed)?|公式|歌詞|ミュージックビデオ|フル)[^)\]】］」』]*[)\]】］」』]/gi,
  /\b(official\s+(music\s+)?video|official\s+audio|lyric\s+video|music\s+video|full\s+ver(sion)?\.?)\b/gi,
];

/**
 * Split a YouTube title into artist/title guesses. `artist` may be empty.
 * @param {string} videoTitle
 * @param {string} [channel]
 * @returns {{artist: string, title: string}}
 */
export function cleanYoutubeTitle(videoTitle, channel = '') {
  let t = videoTitle;
  for (const re of NOISE) t = t.replace(re, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  const m = /^(.+?)\s+[-–—―]\s+(.+)$/.exec(t);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: channel.replace(/\s*-\s*Topic$|VEVO$/i, '').trim(), title: t };
}

/**
 * Pick the iTunes hit matching a YouTube-derived guess; null when ambiguous.
 * @param {{artist: string, title: string}} guess
 * @param {import('./itunes.js').ItunesTrack[]} hits
 * @returns {{best: import('./itunes.js').ItunesTrack | null, ranked: {track: import('./itunes.js').ItunesTrack, score: number}[]}}
 */
export function pickBestMatch(guess, hits) {
  const ranked = hits
    .map((track) => {
      const titleSim = textSimilarity(track.trackName, guess.title);
      const artistSim = guess.artist ? textSimilarity(track.artistName, guess.artist) : 0.5;
      return { track, score: 0.6 * titleSim + 0.4 * artistSim };
    })
    .sort((a, b) => b.score - a.score);
  const [top, second] = ranked;
  if (!top || top.score < 0.7) return { best: null, ranked };
  // Ambiguous when a different song scores almost the same.
  if (second && second.score >= top.score - 0.05 && textSimilarity(second.track.trackName, top.track.trackName) < 0.9) return { best: null, ranked };
  return { best: top.track, ranked };
}

const OEmbedSchema = s.object({ title: s.string(), author_name: s.string().optional() });

/**
 * @typedef {Object} ResolvedTrack
 * @property {string} artist
 * @property {string} title
 * @property {string} previewUrl
 * @property {number} trackId
 */

/**
 * @param {string} raw
 * @param {{country: string, proxy: string, signal?: AbortSignal}} opts
 * @returns {Promise<ResolvedTrack>}
 * @throws {UrlSourceError}
 */
export async function resolveTrackUrl(raw, opts) {
  const parsed = parseTrackUrl(raw);
  const itunesOpts = { country: parsed.kind === 'apple' && parsed.country ? parsed.country : opts.country, proxy: opts.proxy, signal: opts.signal };
  try {
    /** @type {import('./itunes.js').ItunesTrack | null} */
    let track = null;
    if (parsed.kind === 'apple') {
      track = (await lookupTrack(parsed.trackId, itunesOpts)) ?? (itunesOpts.country !== 'US' ? await lookupTrack(parsed.trackId, { ...itunesOpts, country: 'US' }) : null);
      if (!track) throw new UrlSourceError('iTunes でこの曲が見つかりませんでした（配信地域の違いの可能性があります）。');
    } else {
      const oembed = OEmbedSchema.parse(await fetchJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(parsed.url)}`, { signal: opts.signal, retries: 1, netRetries: 1 }));
      const guess = cleanYoutubeTitle(oembed.title, oembed.author_name);
      const hits = await searchSongs(`${guess.artist} ${guess.title}`.trim(), { ...itunesOpts, limit: 8 });
      const { best, ranked } = pickBestMatch(guess, hits);
      if (!best) {
        const names = ranked.slice(0, 3).map((r) => `「${r.track.artistName} — ${r.track.trackName}」`);
        throw new UrlSourceError(
          `YouTube の動画「${oembed.title}」から曲を一意に特定できませんでした。` +
            (names.length ? `候補: ${names.join(' / ')}。Apple Music のリンクを貼るか、曲名を確認してください。` : 'Apple Music のリンクをお試しください。'),
        );
      }
      track = best;
    }
    if (!track.previewUrl) throw new UrlSourceError(`「${track.artistName} — ${track.trackName}」にはプレビュー音源がないため解析できません。`);
    return { artist: track.artistName, title: track.trackName, previewUrl: track.previewUrl, trackId: track.trackId };
  } catch (err) {
    if (err instanceof UrlSourceError || (err instanceof DOMException && err.name === 'AbortError')) throw err;
    if (err instanceof HttpError && parsed.kind === 'youtube' && [401, 403, 404].includes(err.status)) {
      throw new UrlSourceError('YouTube の動画情報を取得できませんでした（非公開・埋め込み不可・削除済みの可能性）。');
    }
    if (err instanceof NetworkError || err instanceof HttpError) throw new UrlSourceError(`通信に失敗しました。ネットワークを確認して再試行してください。（${err.message}）`);
    throw new UrlSourceError(`リンクの解決に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  }
}

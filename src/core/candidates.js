// @ts-check
/**
 * Step 2 — candidate pool: merge tracks from Last.fm / iTunes / Gemini /
 * ontology searches, de-duplicate them, and pick a diverse shortlist.
 */
import { trackKey } from '../util.js';

/** @typedef {import('../types.js').Candidate} Candidate */

export class CandidatePool {
  /** @param {string[]} [excludeKeys] tracks that must never appear (the input itself) */
  constructor(excludeKeys = []) {
    /** @type {Map<string, Candidate>} */
    this.items = new Map();
    this.exclude = new Set(excludeKeys.filter(Boolean));
  }

  /** @param {Candidate} c */
  add(c) {
    if (!c.artist || !c.title) return;
    const key = c.key || trackKey(c.artist, c.title);
    if (this.exclude.has(key)) return;
    const prev = this.items.get(key);
    if (!prev) {
      this.items.set(key, { ...c, key, sources: [...c.sources] });
      return;
    }
    // Same track from several sources = stronger prior.
    prev.weight += c.weight * 0.6;
    for (const src of c.sources) if (!prev.sources.includes(src)) prev.sources.push(src);
    prev.previewUrl ??= c.previewUrl;
    prev.artworkUrl ??= c.artworkUrl;
    prev.trackViewUrl ??= c.trackViewUrl;
    prev.genre ??= c.genre;
    prev.itunesId ??= c.itunesId;
    prev.album ??= c.album;
    prev.releaseYear ??= c.releaseYear;
    prev.localFile ??= c.localFile;
  }

  get size() {
    return this.items.size;
  }

  /**
   * Highest-weight candidates with at most `perArtist` tracks per artist.
   * Local reference files are always kept.
   * @param {number} limit
   * @param {number} [perArtist]
   * @returns {Candidate[]}
   */
  shortlist(limit, perArtist = 2) {
    const all = [...this.items.values()].sort((a, b) => b.weight - a.weight);
    /** @type {Candidate[]} */
    const out = all.filter((c) => c.localFile);
    /** @type {Map<string, number>} */
    const perArtistCount = new Map();
    for (const c of all) {
      if (c.localFile) continue;
      if (out.length >= limit + out.filter((x) => x.localFile).length) break;
      const a = c.artist.toLowerCase();
      const n = perArtistCount.get(a) ?? 0;
      if (n >= perArtist) continue;
      perArtistCount.set(a, n + 1);
      out.push(c);
    }
    return out;
  }
}

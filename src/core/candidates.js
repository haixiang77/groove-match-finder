// @ts-check
/**
 * Step 2 — candidate pool: merge tracks from Last.fm / iTunes / Gemini /
 * ontology searches, de-duplicate them, and pick a diverse shortlist.
 */
import { artistTokens, trackKey } from '../util.js';

/** Share of the shortlist reserved for lineage-sourced candidates. */
export const LINEAGE_SHARE = 0.4;

/** Source labels from genre lineage: 系統樹 / Last.fm タグ (tag charts) / Gemini 提案. Artist-neighbourhood sources (類似曲, 類似アーティスト) are deliberately excluded. */
const LINEAGE_SOURCE = /系統樹|^Last\.fm タグ|^Gemini 提案$/;

/** @param {Candidate} c */
export const isLineageCandidate = (c) => c.sources.some((s) => LINEAGE_SOURCE.test(s));

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
   * Verification pool: local files always, then up to `limit` remote candidates.
   * Pass 1 reserves ceil(limit * LINEAGE_SHARE) slots for lineage-sourced
   * candidates (genre tree / tag charts / similar artists / Gemini); pass 2 fills
   * the rest by weight. At most `perArtist` tracks per artist (collaborators
   * share a normalised token, so "A & B" counts against "A").
   * @param {number} limit
   * @param {number} [perArtist]
   * @returns {Candidate[]}
   */
  shortlist(limit, perArtist = 2) {
    const all = [...this.items.values()].sort((a, b) => b.weight - a.weight);
    const out = all.filter((c) => c.localFile);
    /** @type {Set<Candidate>} */
    const picked = new Set();
    /** @type {Map<string, number>} */
    const counts = new Map();
    /** @param {Candidate} c */
    const tryPick = (c) => {
      const tokens = artistTokens(c.artist);
      for (const t of tokens) if ((counts.get(t) ?? 0) >= perArtist) return;
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
      picked.add(c);
      out.push(c);
    };
    const reserved = Math.ceil(limit * LINEAGE_SHARE);
    for (const c of all) {
      if (picked.size >= reserved) break;
      if (!c.localFile && isLineageCandidate(c)) tryPick(c);
    }
    for (const c of all) {
      if (picked.size >= limit) break;
      if (!c.localFile && !picked.has(c)) tryPick(c);
    }
    return out;
  }
}

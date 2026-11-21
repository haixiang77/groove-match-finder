// @ts-check
/**
 * Step 3b — diversity + genre-lineage re-ranking applied after the acoustic sort.
 * Pure: the acoustic `score` is never touched; `effectiveScore` drives the order.
 */
import { artistTokens } from '../util.js';
import { tagToGenre, tagsToGenres, skeletonGenres } from './ontology.js';

/** @typedef {import('../types.js').ScoredCandidate} ScoredCandidate */

/** Multiplier for the 1st, 2nd, 3rd, 4th+ track sharing an artist token (1 = first appearance). */
export const ARTIST_DAMPEN = [1, 0.93, 0.86, 0.8];
/** Lineage factor = LINEAGE_BASE + LINEAGE_SPAN × affinity  (0.96 … 1.06). */
export const LINEAGE_BASE = 0.96;
export const LINEAGE_SPAN = 0.1;
/** Affinity credited to a candidate whose metadata genre maps into the lineage (floor). */
export const METADATA_AFFINITY = 0.5;
/** Affinity for a candidate with no audio guesses and no metadata genre: factor exactly 1.0. */
export const NEUTRAL_AFFINITY = (1 - LINEAGE_BASE) / LINEAGE_SPAN;
/** Number of top genre guesses that feed the affinity. */
export const AFFINITY_TOP_N = 3;
/** A rank move of at least this many places counts as material (a reason is added). */
export const MATERIAL_RANK_SHIFT = 2;

/**
 * Genre node ids for an iTunes-style genre string ("Hip-Hop/Rap", "J-Pop").
 * @param {string | undefined} genre
 * @returns {string[]}
 */
export function genreIds(genre) {
  if (!genre) return [];
  /** @type {Set<string>} */
  const ids = new Set();
  for (const t of [genre, ...genre.split(/[/,&]/)]) {
    const id = tagToGenre(t.trim());
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Share of the top-3 genre weight that lies inside the lineage set.
 * @param {{id: string, score: number}[]} genreScores  genre guesses (any order)
 * @param {Set<string>} lineageSet
 * @returns {number} in [0, 1]; 0 for empty input
 */
export function lineageAffinity(genreScores, lineageSet) {
  const top = [...genreScores].sort((a, b) => b.score - a.score).slice(0, AFFINITY_TOP_N);
  let total = 0;
  let inSet = 0;
  for (const g of top) {
    total += g.score;
    if (lineageSet.has(g.id)) inSet += g.score;
  }
  return total > 0 ? inSet / total : 0;
}

/**
 * DSP skeleton guesses from the candidate's own features.
 * @param {ScoredCandidate} sc
 * @returns {{id: string, score: number}[]}
 */
function skeletonScoresOf(sc) {
  const f = sc.features;
  return f && f.traits && typeof f.bpm === 'number' ? skeletonGenres(f) : [];
}

/**
 * Genre guesses for a candidate: Last.fm tags (via tagsToGenres) when they map to
 * at least one genre, otherwise the DSP skeleton.
 * @param {ScoredCandidate} sc
 * @returns {{scores: {id: string, score: number}[], source: 'tags' | 'skeleton'}}
 */
export function genreGuess(sc) {
  const tags = sc.candidate.tags;
  if (tags && tags.length) {
    const scores = [...tagsToGenres(tags)].map(([id, score]) => ({ id, score }));
    if (scores.length) return { scores, source: 'tags' };
  }
  return { scores: skeletonScoresOf(sc), source: 'skeleton' };
}

/**
 * @param {ScoredCandidate[]} scored   already sorted by acoustic score, descending
 * @param {Set<string>} lineage        input's expanded lineage genre ids
 * @param {{minScore?: number, genreScoresOf?: (sc: ScoredCandidate) => {id: string, score: number}[]}} [opts]
 *   minScore: when set, `passed` is recomputed from the effective score.
 *   genreScoresOf: genre guesses per candidate (defaults to skeletonGenres of its features)
 * @returns {ScoredCandidate[]}
 */
export function rerank(scored, lineage, opts = {}) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  const custom = opts.genreScoresOf;
  const adjusted = scored.map((sc, oldRank) => {
    const tokens = artistTokens(sc.candidate.artist);
    let prior = 0;
    for (const t of tokens) prior = Math.max(prior, seen.get(t) ?? 0);
    for (const t of tokens) seen.set(t, (seen.get(t) ?? 0) + 1);
    const artistFactor = ARTIST_DAMPEN[Math.min(prior, ARTIST_DAMPEN.length - 1)];
    const guess = custom ? { scores: custom(sc), source: undefined } : genreGuess(sc);
    const skeleton = guess.scores;
    const hasMeta = Boolean(sc.candidate.genre);
    const metaFloor = genreIds(sc.candidate.genre).some((id) => lineage.has(id)) ? METADATA_AFFINITY : 0;
    // No audio guesses and no metadata genre: nothing known, so stay neutral.
    const affinity = skeleton.length
      ? Math.max(lineageAffinity(skeleton, lineage), metaFloor)
      : hasMeta ? metaFloor : NEUTRAL_AFFINITY;
    const lineageBoost = LINEAGE_BASE + LINEAGE_SPAN * affinity;
    const basis = guess.source === 'tags' ? '（Last.fm タグ由来）' : guess.source === 'skeleton' && skeleton.length ? '（音響骨格由来）' : '';
    return { sc, oldRank, basis, artistFactor, lineageBoost, effectiveScore: sc.score * artistFactor * lineageBoost };
  });
  const order = [...adjusted].sort((a, b) => b.effectiveScore - a.effectiveScore || a.oldRank - b.oldRank);
  return order.map((a, newRank) => {
    const passed = opts.minScore === undefined ? a.sc.passed : a.effectiveScore >= opts.minScore;
    const material = passed !== a.sc.passed || Math.abs(newRank - a.oldRank) >= MATERIAL_RANK_SHIFT;
    const reasons = [...a.sc.reasons];
    if (material && a.artistFactor < 1 && (newRank > a.oldRank || !passed))
      reasons.push('同じアーティスト（コラボ含む）の曲が上位に既出のため、順位を下げました');
    if (material && a.lineageBoost > 1 && (newRank < a.oldRank || passed))
      reasons.push('入力曲と同じジャンル系統に近いため、順位を引き上げました' + a.basis);
    if (material && a.lineageBoost < 1 && (newRank > a.oldRank || !passed))
      reasons.push('入力曲のジャンル系統から遠いため、順位を下げました' + a.basis);
    return { ...a.sc, passed, reasons, effectiveScore: a.effectiveScore, artistFactor: a.artistFactor, lineageBoost: a.lineageBoost };
  });
}

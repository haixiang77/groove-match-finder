// @ts-check
/**
 * Layer 3 — waveform filtering & re-ranking.
 * Compares two AudioFeatures and produces a 0..1 similarity with a breakdown
 * and human-readable (Japanese) reasons.
 */
import { cosine, mean, pearson } from '../audio/dsp.js';
import { keyCompatibility } from '../audio/key.js';

/** @typedef {import('../types.js').AudioFeatures} AudioFeatures */
/** @typedef {import('../types.js').ScoreBreakdown} ScoreBreakdown */

/** @type {ScoreBreakdown} */
export const DEFAULT_WEIGHTS = { rhythm: 0.4, tempo: 0.12, groove: 0.23, timbre: 0.2, key: 0.05 };

export const BAND_WEIGHTS = { kick: 0.45, snare: 0.35, hat: 0.2 };

/** @type {Record<import('../types.js').TraitId, string>} */
export const TRAIT_LABELS = {
  four_on_floor: '4つ打ち',
  offbeat_hat: '裏拍ハイハット',
  backbeat: '2・4拍バックビート',
  halftime: 'ハーフタイム',
  rolling_hats: '16分ハイハット連打',
  sub808: '808系ロングサブ',
  swing: 'スウィング',
  sidechain: 'サイドチェイン',
  syncopated_kick: 'シンコペーション・キック',
  dembow: 'デンボウ (3+3+2)',
  breakbeat: 'ブレイクビーツ',
};

/** @param {number} x @param {number} sigma */
const gauss = (x, sigma) => Math.exp(-0.5 * (x / sigma) ** 2);

/** @param {number[]} a @param {number[]} b */
function vectorSim(a, b) {
  return 0.5 * Math.max(0, cosine(a, b)) + 0.5 * ((pearson(a, b) + 1) / 2);
}

/**
 * Tempo similarity allowing half / double-time relationships.
 * @param {number} a input BPM
 * @param {number} b candidate BPM
 * @returns {{sim: number, ratio: number}} ratio r such that b·r ≈ a
 */
export function tempoSimilarity(a, b) {
  let best = { sim: 0, ratio: 1 };
  for (const r of [1, 2, 0.5]) {
    const d = Math.abs(Math.log2((b * r) / a));
    const sim = gauss(d, 0.07) * (r === 1 ? 1 : 0.85);
    if (sim > best.sim) best = { sim, ratio: r };
  }
  return best;
}

/**
 * Bring two 16-step grids onto a common metrical frame.
 * ratio 1: unchanged. ratio 0.5 (candidate twice as fast): fold the input's two
 * half-bars and compare with the candidate's 8th-note steps. ratio 2: mirror.
 * @param {number[]} a input band grid
 * @param {number[]} b candidate band grid
 * @param {number} ratio
 * @returns {[number[], number[]]}
 */
export function alignBand(a, b, ratio) {
  /** @param {number[]} g */
  const fold = (g) => Array.from({ length: 8 }, (_, i) => (g[i] + g[i + 8]) / 2);
  /** @param {number[]} g */
  const evens = (g) => Array.from({ length: 8 }, (_, i) => g[i * 2]);
  if (ratio === 0.5) return [fold(a), evens(b)];
  if (ratio === 2) return [evens(a), fold(b)];
  return [a, b];
}

/** @param {number[]} g @param {number} shift */
const rot = (g, shift) => g.map((_, i) => g[(i + shift) % g.length]);

/**
 * Rhythm-grid similarity, maximised over beat rotations (downbeat ambiguity).
 * @param {AudioFeatures} a
 * @param {AudioFeatures} b
 * @param {number} ratio
 */
export function gridSimilarity(a, b, ratio) {
  const len = ratio === 1 ? 16 : 8;
  const beatSteps = ratio === 1 ? 4 : 2;
  let best = { sim: -1, shift: 0, bands: { kick: 0, snare: 0, hat: 0 } };
  for (let s = 0; s < len; s += beatSteps) {
    /** @type {{kick: number, snare: number, hat: number}} */
    const bands = { kick: 0, snare: 0, hat: 0 };
    let num = 0;
    let den = 0;
    for (const band of /** @type {const} */ (['kick', 'snare', 'hat'])) {
      const [x, y] = alignBand(a.grid[band], b.grid[band], ratio);
      const sim = vectorSim(x, rot(y, s));
      bands[band] = sim;
      // A band that is barely present in either track counts less.
      const w = BAND_WEIGHTS[band] * (0.3 + 0.7 * Math.min(a.presence[band], b.presence[band]));
      num += w * sim;
      den += w;
    }
    const sim = (den ? num / den : 0) - (s === 0 ? 0 : 0.05);
    if (sim > best.sim) best = { sim, shift: (s * 16) / len, bands };
  }
  return { sim: Math.max(0, best.sim), shift: best.shift, bands: best.bands };
}

/** Share of the groove score given to the research-based features (syncopation, density, pulse, low-band motion). */
export const PSYCH_SHARE = 0.4;

/**
 * Event density of the candidate expressed per beat of the input (half / double-time aware).
 * ratio r satisfies b·r ≈ a, so one candidate beat spans r input beats.
 * @param {number} densityB @param {number} ratio
 */
const densityInInputFrame = (densityB, ratio) => densityB / ratio;

/**
 * Closeness of the research-based groove features (0..1); null when either side lacks them.
 * @param {AudioFeatures} a @param {AudioFeatures} b @param {number} ratio tempo ratio (1, 2, 0.5)
 */
export function psychGrooveSimilarity(a, b, ratio = 1) {
  const ga = a.groove;
  const gb = b.groove;
  if (typeof ga.syncopation !== 'number' || typeof gb.syncopation !== 'number') return null;
  const sync = gauss(ga.syncopation - gb.syncopation, 0.2);
  const dens = gauss(Math.log2((ga.eventDensity + 0.25) / (densityInInputFrame(gb.eventDensity, ratio) + 0.25)), 0.4);
  const pulse = gauss(ga.pulseClarity - gb.pulseClarity, 0.3);
  const lf = lowMotionSimilarity(a, b);
  return 0.3 * sync + 0.25 * dens + 0.15 * pulse + 0.3 * lf;
}

/**
 * Closeness of the low-band motion (spectral flux mean / variance, RMS variance).
 * @param {AudioFeatures} a @param {AudioFeatures} b
 */
export function lowMotionSimilarity(a, b) {
  const ga = a.groove;
  const gb = b.groove;
  /** @param {number} x @param {number} y */
  const lr = (x, y) => Math.log2((x + 1e-3) / (y + 1e-3));
  return 0.4 * gauss(lr(ga.lowFluxMean, gb.lowFluxMean), 0.5) + 0.3 * gauss(lr(ga.lowFluxVar, gb.lowFluxVar), 1.0) + 0.3 * gauss(lr(ga.lowRmsVar, gb.lowRmsVar), 1.0);
}

/** @param {AudioFeatures} a @param {AudioFeatures} b @param {number} [ratio] tempo ratio of the match */
export function grooveSimilarity(a, b, ratio = 1) {
  const ga = a.groove;
  const gb = b.groove;
  const swingConf = Math.min(ga.swingConfidence, gb.swingConfidence);
  const swing = swingConf < 0.15 ? 0.75 : gauss(ga.swing - gb.swing, 4);
  const side = gauss(ga.sidechainDb - gb.sidechainDb, 3);
  const sub = gauss(ga.subSustain - gb.subSustain, 0.18);
  const hats = gauss(ga.hatDensity - gb.hatDensity, 0.25);
  const keys = /** @type {import('../types.js').TraitId[]} */ (Object.keys(a.traits));
  const traits = 1 - mean(keys.map((k) => Math.abs(a.traits[k] - b.traits[k])));
  const base = 0.22 * swing + 0.18 * side + 0.2 * sub + 0.1 * hats + 0.3 * traits;
  const psych = psychGrooveSimilarity(a, b, ratio);
  return psych === null ? base : (1 - PSYCH_SHARE) * base + PSYCH_SHARE * psych;
}

/** @param {AudioFeatures} a @param {AudioFeatures} b */
export function timbreSimilarity(a, b) {
  const ba = a.spectral.bandBalance;
  const bb = b.spectral.bandBalance;
  const dist = Math.sqrt(mean(ba.map((v, i) => (v - bb[i]) ** 2)));
  const balance = gauss(dist, 4);
  const centroid = gauss(Math.log2((a.spectral.centroidHz || 1) / (b.spectral.centroidHz || 1)), 0.35);
  const crest = gauss(a.spectral.crestDb - b.spectral.crestDb, 3);
  return 0.5 * balance + 0.3 * centroid + 0.2 * crest;
}

/** @param {AudioFeatures} a @param {AudioFeatures} b */
export function keySimilarity(a, b) {
  const conf = Math.sqrt(Math.min(a.key.confidence, b.key.confidence));
  return 0.6 + (keyCompatibility(a.key, b.key) - 0.6) * conf;
}

/**
 * Full comparison of an input track against a candidate.
 * @param {AudioFeatures} input
 * @param {AudioFeatures} cand
 * @param {ScoreBreakdown} [weights]
 */
export function compareFeatures(input, cand, weights = DEFAULT_WEIGHTS) {
  const tempo = tempoSimilarity(input.bpm, cand.bpm);
  const grid = gridSimilarity(input, cand, tempo.ratio);
  /** @type {ScoreBreakdown} */
  const breakdown = {
    rhythm: grid.sim,
    tempo: tempo.sim,
    groove: grooveSimilarity(input, cand, tempo.ratio),
    timbre: timbreSimilarity(input, cand),
    key: keySimilarity(input, cand),
  };
  const keys = /** @type {(keyof ScoreBreakdown)[]} */ (Object.keys(breakdown));
  const wsum = keys.reduce((acc, k) => acc + Math.max(0, weights[k]), 0) || 1;
  const score = keys.reduce((acc, k) => acc + Math.max(0, weights[k]) * breakdown[k], 0) / wsum;
  return {
    score,
    breakdown,
    bandSimilarity: grid.bands,
    shiftSteps: grid.shift,
    tempoRatio: tempo.ratio,
    reasons: explainMatch(input, cand, { breakdown, bands: grid.bands, ratio: tempo.ratio }),
  };
}

/**
 * Reasons from the research-based groove features (syncopation, event density, low-end motion).
 * @param {AudioFeatures} a @param {AudioFeatures} b @param {number} ratio
 * @returns {string[]}
 */
export function grooveReasons(a, b, ratio) {
  const ga = a.groove;
  const gb = b.groove;
  if (typeof ga.syncopation !== 'number' || typeof gb.syncopation !== 'number') return [];
  /** @type {string[]} */
  const out = [];
  if (Math.abs(ga.syncopation - gb.syncopation) <= 0.12)
    out.push(`シンコペーション量が近い（${pct(ga.syncopation)} / ${pct(gb.syncopation)}）`);
  const db2 = densityInInputFrame(gb.eventDensity, ratio);
  if (Math.abs(Math.log2((ga.eventDensity + 0.25) / (db2 + 0.25))) <= 0.25)
    out.push(`イベント密度が近い（${ga.eventDensity.toFixed(1)} / ${db2.toFixed(1)} 打/拍）`);
  if (lowMotionSimilarity(a, b) >= 0.8) out.push('低音の動き（低域フラックス・音量変動）が近い');
  return out;
}

/** @param {number} v */
const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * Rule-based explanation lines (used directly, and as grounding for Gemini).
 * @param {AudioFeatures} a
 * @param {AudioFeatures} b
 * @param {{breakdown: ScoreBreakdown, bands: {kick: number, snare: number, hat: number}, ratio: number}} r
 * @returns {string[]}
 */
export function explainMatch(a, b, r) {
  /** @type {string[]} */
  const out = [];
  const diff = ((b.bpm * r.ratio - a.bpm) / a.bpm) * 100;
  if (r.ratio === 1) out.push(`BPM ${a.bpm} ↔ ${b.bpm}（${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%）`);
  else out.push(`BPM ${a.bpm} ↔ ${b.bpm}：${r.ratio === 2 ? 'ハーフタイム' : 'ダブルタイム'}関係（${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%）`);

  const bandText = { kick: 'キック', snare: 'スネア', hat: 'ハイハット' };
  const bandsSorted = /** @type {('kick'|'snare'|'hat')[]} */ (['kick', 'snare', 'hat']).sort((x, y) => r.bands[y] - r.bands[x]);
  const strong = bandsSorted.filter((k) => r.bands[k] >= 0.8);
  if (strong.length) out.push(`${strong.map((k) => bandText[k]).join('・')}の16ステップ配置が一致（${strong.map((k) => pct(r.bands[k])).join(' / ')}）`);
  const weak = bandsSorted.filter((k) => r.bands[k] < 0.55);
  if (weak.length) out.push(`${weak.map((k) => bandText[k]).join('・')}のパターンは異なる`);

  const keys = /** @type {import('../types.js').TraitId[]} */ (Object.keys(a.traits));
  const shared = keys.filter((k) => a.traits[k] >= 0.55 && b.traits[k] >= 0.55).map((k) => TRAIT_LABELS[k]);
  if (shared.length) out.push(`共通のリズム骨格：${shared.join('、')}`);

  if (a.groove.swingConfidence > 0.15 && b.groove.swingConfidence > 0.15 && Math.abs(a.groove.swing - b.groove.swing) <= 3 && a.groove.swing >= 54)
    out.push(`スウィング量がほぼ同じ（${a.groove.swing}% / ${b.groove.swing}%）`);
  if (a.groove.sidechainDb >= 2 && b.groove.sidechainDb >= 2) out.push(`両方にサイドチェインのポンピング（${a.groove.sidechainDb}dB / ${b.groove.sidechainDb}dB）`);
  if (a.groove.subSustain >= 0.45 && b.groove.subSustain >= 0.45) out.push('ロングサステインのサブベース（808系）が共通');
  out.push(...grooveReasons(a, b, r.ratio));
  if (r.breakdown.timbre >= 0.75) out.push(`帯域バランス・明るさが近い（スペクトル重心 ${Math.round(a.spectral.centroidHz)}Hz / ${Math.round(b.spectral.centroidHz)}Hz）`);
  else if (r.breakdown.timbre < 0.45) out.push('帯域バランス（音色の明るさ・低域量）は異なる');
  if (keyCompatibility(a.key, b.key) >= 0.85 && Math.min(a.key.confidence, b.key.confidence) > 0.3)
    out.push(`キーの相性が良い（${a.key.name} / ${b.key.name}）`);
  return out;
}

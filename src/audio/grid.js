// Grid post-processing shared by display and similarity: canonical bar phase + ghost clean-up.

const BEATS = [0, 4, 8, 12];
/** A bar rotation must beat the current phase by this much, so ambiguous (half-time etc.) bars stay put. */
const PHASE_MARGIN = 0.15;
/** Isolated weak off-beat hits are scaled by this factor (never zeroed). */
export const GHOST_SCALE = 0.5;
export const GHOST_THRESHOLD = 0.5;

/**
 * @param {import('../types.js').RhythmGrid} g
 * @param {number} shift steps
 * @returns {import('../types.js').RhythmGrid}
 */
export function rotateGrid(g, shift) {
  /** @param {number[]} a */
  const rot = (a) => a.map((_, i) => a[(i + shift) % 16]);
  return { kick: rot(g.kick), snare: rot(g.snare), hat: rot(g.hat) };
}

/**
 * Backbeat coherence: kick on the beats, snare on 2 & 4, no snare on 1 & 3.
 * @param {import('../types.js').RhythmGrid} g
 */
export function barCoherence(g) {
  const avg = (/** @type {number[]} */ a, /** @type {number[]} */ idx) => idx.reduce((s, i) => s + a[i], 0) / idx.length;
  return avg(g.kick, BEATS) + avg(g.snare, [4, 12]) - avg(g.snare, [0, 8]);
}

/**
 * Rotate by whole beats so the bar sits in canonical phase (all bands together).
 * @param {import('../types.js').RhythmGrid} g
 * @returns {import('../types.js').RhythmGrid}
 */
export function canonicalizeBar(g) {
  const m = (/** @type {number[]} */ a, /** @type {number[]} */ idx) => idx.reduce((s, i) => s + a[i], 0) / idx.length;
  // Only act on a clear "snare on 1 & 3" slip. Half-time bars, dembow and other
  // non-backbeat grooves have no such signature and are left alone.
  if (m(g.snare, [0, 8]) <= m(g.snare, [4, 12]) + 0.2) return g;
  // A half-time bar (kick on 1 but not on 2 & 4, snare only on 3) is already valid.
  if (g.snare[8] >= 0.6 && g.snare[4] < 0.3 && g.snare[12] < 0.3 && g.kick[0] >= 0.5 && g.kick[4] < 0.5 && g.kick[12] < 0.5) return g;
  let best = 0;
  let bestScore = barCoherence(g) + PHASE_MARGIN;
  for (const r of [4, 8, 12]) {
    const rot = rotateGrid(g, r);
    if (m(rot.snare, [4, 12]) < 0.5) continue;
    const sc = barCoherence(rot);
    if (sc > bestScore + 1e-9) {
      bestScore = sc;
      best = r;
    }
  }
  return best ? rotateGrid(g, best) : g;
}

/**
 * Attenuate isolated weak off-beat hits (value < 0.5, both neighbours also < 0.5, not on a beat).
 * @param {import('../types.js').RhythmGrid} g
 * @returns {import('../types.js').RhythmGrid}
 */
export function cleanGrid(g) {
  /** @param {number[]} a */
  const clean = (a) =>
    a.map((v, i) => {
      if (i % 4 === 0 || v >= GHOST_THRESHOLD) return v;
      const prev = a[(i + 15) % 16];
      const next = a[(i + 1) % 16];
      return prev < GHOST_THRESHOLD && next < GHOST_THRESHOLD ? v * GHOST_SCALE : v;
    });
  return { kick: clean(g.kick), snare: clean(g.snare), hat: clean(g.hat) };
}

/** Metrical weight of each 16th step in 4/4 (0 = downbeat, lower = weaker), after Longuet-Higgins & Lee. */
export const METRIC_WEIGHTS = [0, -4, -3, -4, -2, -4, -3, -4, -1, -4, -3, -4, -2, -4, -3, -4];
/** A grid value at or above this counts as an onset. */
export const ONSET_THRESHOLD = 0.5;
/** Raw syncopation (mean over lanes) that maps to 1.0. */
const SYNC_FULL_SCALE = 12;

/**
 * Syncopation of one 16-step lane (Longuet-Higgins & Lee / Witek et al.): an onset followed by a
 * rest that sits on a metrically stronger step contributes the weight difference. Cyclic over the bar.
 * @param {number[]} lane
 * @returns {number} raw sum (0 = none)
 */
export function laneSyncopation(lane) {
  let total = 0;
  for (let i = 0; i < 16; i++) {
    if (lane[i] < ONSET_THRESHOLD) continue;
    let strongest = -Infinity;
    for (let d = 1; d < 16; d++) {
      const j = (i + d) % 16;
      if (lane[j] >= ONSET_THRESHOLD) break;
      strongest = Math.max(strongest, METRIC_WEIGHTS[j]);
    }
    if (strongest > METRIC_WEIGHTS[i]) total += strongest - METRIC_WEIGHTS[i];
  }
  return total;
}

/**
 * Syncopation index in 0..1, averaged over every lane (kick, snare, hat).
 * @param {import('../types.js').RhythmGrid} g
 */
export function syncopationIndex(g) {
  const lanes = [g.kick, g.snare, g.hat];
  const raw = lanes.reduce((s, l) => s + laneSyncopation(l), 0) / lanes.length;
  return Math.max(0, Math.min(1, raw / SYNC_FULL_SCALE));
}

/**
 * Event density: grid onsets (all lanes) per beat.
 * @param {import('../types.js').RhythmGrid} g
 */
export function eventDensity(g) {
  const n = [g.kick, g.snare, g.hat].reduce((s, l) => s + l.filter((v) => v >= ONSET_THRESHOLD).length, 0);
  return n / 4;
}

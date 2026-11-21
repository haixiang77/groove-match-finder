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

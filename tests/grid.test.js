import test from 'node:test';
import assert from 'node:assert/strict';
import { barCoherence, canonicalizeBar, cleanGrid, rotateGrid } from '../src/audio/grid.js';

const z = () => new Array(16).fill(0);
const at = (idx, v = 1) => z().map((_, i) => (idx.includes(i) ? v : 0));
const canonical = () => ({ kick: at([0, 4, 8, 12]), snare: at([4, 12]), hat: at([0, 2, 4, 6, 8, 10, 12, 14], 0.8) });

test('canonical pattern does not move', () => {
  const g = canonical();
  assert.deepEqual(canonicalizeBar(g), g);
});

test('1-beat offsets (snare on 1 & 3) are rotated back to canonical phase', () => {
  const base = canonical();
  base.kick[8] = 0.9;
  base.hat[2] = 0.6;
  for (const shift of [4, 12]) {
    const slipped = rotateGrid(base, shift);
    const fixed = canonicalizeBar(slipped);
    // Beat shifts 4/12 leave the bar's 2-beat symmetric backbeat equivalent, so the result is
    // either the original or its 2-beat rotation — both canonical.
    assert.ok([0, 8].some((r) => JSON.stringify(rotateGrid(base, r)) === JSON.stringify(fixed)), `shift ${shift}`);
    assert.deepEqual(fixed.snare, at([4, 12]));
    assert.equal(barCoherence(fixed), barCoherence(base));
  }
});

test('2-beat slip of a symmetric backbeat bar is musically identical and stays put; asymmetric bar is fixed', () => {
  const base = canonical();
  assert.deepEqual(canonicalizeBar(rotateGrid(base, 8)), rotateGrid(base, 8));
  // Snare on 1 & 3 plus a kick on 2 & 4 only (rotated 2 beats from a kick-less-downbeat bar) -> fixed by 1-beat logic.
  const g = { kick: at([4, 12]), snare: at([0, 8]), hat: at([0, 2, 4, 6, 8, 10, 12, 14], 0.8) };
  assert.deepEqual(canonicalizeBar(g).snare, at([4, 12]));
});

test('non-backbeat grooves (half-time, dembow-like) are left alone', () => {
  const half = { kick: at([0, 10]), snare: at([8]), hat: at([0, 2, 4, 6, 8, 10, 12, 14], 0.8) };
  assert.deepEqual(canonicalizeBar(half), half);
  const dembow = { kick: at([0, 4, 8, 12]), snare: at([3, 6, 11, 14], 0.9), hat: z() };
  assert.deepEqual(canonicalizeBar(dembow), dembow);
});

test('rotation moves all bands together', () => {
  const slipped = rotateGrid(canonical(), 4);
  const fixed = canonicalizeBar(slipped);
  assert.deepEqual(fixed.hat, canonical().hat);
  assert.ok(barCoherence(fixed) > barCoherence(slipped));
});

test('cleanGrid scales isolated weak off-beat hits, leaves strong and on-beat values', () => {
  const g = { kick: at([0, 8]), snare: at([4, 12]), hat: z() };
  g.hat[0] = 0.9;
  g.hat[1] = 0.3; // isolated weak off-beat? neighbour 0 is strong -> untouched
  g.hat[6] = 0.3; // isolated weak -> scaled
  g.hat[8] = 0.3; // on a beat -> untouched
  g.hat[10] = 0.8; // strong -> untouched
  g.kick[5] = 0.2;
  const c = cleanGrid(g);
  assert.equal(c.hat[0], 0.9);
  assert.equal(c.hat[1], 0.3);
  assert.equal(c.hat[6], 0.15);
  assert.equal(c.hat[8], 0.3);
  assert.equal(c.hat[10], 0.8);
  assert.equal(c.kick[5], 0.1);
  assert.equal(c.kick[0], 1);
  assert.equal(c.snare[4], 1);
  assert.equal(c.hat[7], 0); // zeros stay zero
});

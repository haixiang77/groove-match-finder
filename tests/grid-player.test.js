import test from 'node:test';
import assert from 'node:assert/strict';
import { gridEvents, swingOffsetSec } from '../src/ui/grid-player.js';

const z = () => new Array(16).fill(0);
const feat = (over = {}) => ({
  bpm: 120,
  groove: { swing: 50, swingUnit: 16 },
  grid: { kick: z(), snare: z(), hat: z() },
  ...over,
});

test('swing offsets follow the analyzer convention (position within the pair)', () => {
  const step = 60 / 120 / 4; // 0.125 s
  assert.equal(swingOffsetSec(1, 120, 50, 16), 0);
  assert.ok(Math.abs(swingOffsetSec(1, 120, 66.7, 16) - 0.167 * 2 * step) < 1e-9);
  assert.equal(swingOffsetSec(2, 120, 66.7, 16), 0); // even steps never move at unit 16
  assert.ok(Math.abs(swingOffsetSec(2, 120, 62.5, 8) - 0.125 * 4 * step) < 1e-9);
  assert.equal(swingOffsetSec(1, 120, 62.5, 8), 0);
});

test('events: steps below 0.15 are silent, order is chronological', () => {
  const f = feat({ groove: { swing: 60, swingUnit: 16 } });
  f.grid.kick[0] = 1;
  f.grid.hat[1] = 0.14;
  f.grid.hat[3] = 0.5;
  const ev = gridEvents(f);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].band, 'kick');
  assert.equal(ev[0].time, 0);
  assert.ok(ev[1].time > 3 * 0.125); // swung odd step lands late
});

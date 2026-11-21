// Audition preview: loops the detected 16-step grid with WebAudio-synthesised one-shots.

export const SILENT_BELOW = 0.15;

/**
 * Time offset (sec, relative to the straight step position) of a step, using the analyzer's swing
 * convention (see measureSwing): swing% is where the off-beat lands inside its pair
 * (50 = straight, 66.7 = triplet). swingUnit 16 → odd 16ths move within each 8th pair;
 * swingUnit 8 → the off-beat 8ths (steps 2, 6, 10, 14) move within each beat.
 * @param {number} step 0..15
 * @param {number} bpm
 * @param {number} swing percent
 * @param {number} swingUnit 8 | 16
 */
export function swingOffsetSec(step, bpm, swing, swingUnit) {
  const stepDur = 60 / bpm / 4;
  const amount = Math.max(0, swing / 100 - 0.5);
  if (swingUnit === 16) return step % 2 === 1 ? amount * 2 * stepDur : 0;
  return step % 4 === 2 ? amount * 4 * stepDur : 0;
}

/**
 * Hits of one bar in time order.
 * @param {import('../types.js').AudioFeatures} f
 * @returns {{ time: number, band: 'kick' | 'snare' | 'hat', vel: number }[]}
 */
export function gridEvents(f) {
  const stepDur = 60 / f.bpm / 4;
  /** @type {{ time: number, band: 'kick' | 'snare' | 'hat', vel: number }[]} */
  const out = [];
  for (let step = 0; step < 16; step++) {
    const time = step * stepDur + swingOffsetSec(step, f.bpm, f.groove.swing, f.groove.swingUnit);
    for (const band of /** @type {const} */ (['kick', 'snare', 'hat'])) {
      const vel = f.grid[band][step];
      if (vel >= SILENT_BELOW) out.push({ time, band, vel });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/** @param {AudioContext} ctx @param {number} sec */
function noiseBuffer(ctx, sec) {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * sec), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

export class GridPlayer {
  /** @param {() => void} [onStop] called whenever playback ends */
  constructor(onStop) {
    this.onStop = onStop;
    /** @type {AudioContext | null} */
    this.ctx = null;
    /** @type {AudioBuffer | null} */
    this.noise = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    this.playing = false;
  }

  /** @param {import('../types.js').AudioFeatures} f */
  start(f) {
    this.stop();
    const Ctor = globalThis.AudioContext ?? /** @type {any} */ (globalThis).webkitAudioContext;
    if (!Ctor || !(f.bpm > 0)) return;
    const ctx = (this.ctx ??= new Ctor());
    ctx.resume?.().catch(() => {});
    this.noise ??= noiseBuffer(ctx, 0.5);
    const events = gridEvents(f);
    const barDur = (60 / f.bpm) * 4;
    let barStart = ctx.currentTime + 0.08;
    const LOOKAHEAD = 0.25;
    const pump = () => {
      while (barStart < ctx.currentTime + LOOKAHEAD) {
        for (const e of events) this.hit(ctx, e.band, e.vel, barStart + e.time);
        barStart += barDur;
      }
    };
    pump();
    this.timer = setInterval(pump, 50);
    this.playing = true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const was = this.playing;
    this.playing = false;
    // Already scheduled (<0.25 s) hits are cut by closing the context's output via suspend+drop.
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
      this.noise = null;
    }
    if (was) this.onStop?.();
  }

  /**
   * @param {AudioContext} ctx
   * @param {'kick' | 'snare' | 'hat'} band
   * @param {number} vel
   * @param {number} t
   */
  hit(ctx, band, vel, t) {
    const g = ctx.createGain();
    g.connect(ctx.destination);
    const level = 0.25 + 0.75 * Math.min(1, vel);
    if (band === 'kick') {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(0.9 * level, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g);
      o.start(t);
      o.stop(t + 0.32);
      return;
    }
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    n.connect(f);
    f.connect(g);
    if (band === 'snare') {
      f.type = 'bandpass';
      f.frequency.value = 2000;
      g.gain.setValueAtTime(0.6 * level, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.frequency.value = 190;
      og.gain.setValueAtTime(0.35 * level, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      o.connect(og);
      og.connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.12);
      n.start(t);
      n.stop(t + 0.2);
    } else {
      f.type = 'highpass';
      f.frequency.value = 7000;
      g.gain.setValueAtTime(0.3 * level, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      n.start(t);
      n.stop(t + 0.06);
    }
  }
}

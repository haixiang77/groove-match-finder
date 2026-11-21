// Synthetic drum-loop generator for deterministic analyzer tests.

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {{bpm:number, bars?:number, sr?:number, kick?:number[], snare?:number[], hat?:number[],
 *   swing?:number, velJitter?:number, timingJitterMs?:number, noise?:number, kickDecay?:number, chord?:number[], pump?:boolean, seed?:number}} o
 */
export function synthLoop(o) {
  const sr = o.sr ?? 22050;
  const bars = o.bars ?? 12;
  const stepDur = 60 / o.bpm / 4;
  const len = Math.ceil(bars * 16 * stepDur * sr) + sr;
  const x = new Float32Array(len);
  const rand = rng(o.seed ?? 1);
  const swing = (o.swing ?? 50) / 100;
  const stepTime = (bar, step) => {
    const base = (bar * 16 + step) * stepDur;
    return step % 2 === 1 ? base - stepDur + 2 * stepDur * swing : base;
  };
  // Optional degradations (all default off, so existing tests are unchanged).
  const velJitter = o.velJitter ?? 0; // 0..1: each hit gets gain 1-velJitter*rand
  const jitterSec = (o.timingJitterMs ?? 0) / 1000;
  const vel = () => (velJitter ? 1 - velJitter * rand() : 1);
  const jit = (t) => (jitterSec ? Math.max(0, t + (rand() * 2 - 1) * jitterSec) : t);
  const kickDecay = o.kickDecay ?? 0.18;
  const addKick = (t0) => {
    const g = vel();
    const s0 = Math.round(t0 * sr);
    let phase = 0;
    for (let i = 0; i < sr * (kickDecay * 5) && s0 + i < len; i++) {
      const t = i / sr;
      const f = 45 + 90 * Math.exp(-t * 30);
      phase += (2 * Math.PI * f) / sr;
      x[s0 + i] += g * 0.9 * Math.sin(phase) * Math.exp(-t / kickDecay);
    }
  };
  const addSnare = (t0) => {
    const g = vel();
    const s0 = Math.round(t0 * sr);
    for (let i = 0; i < sr * 0.25 && s0 + i < len; i++) {
      const t = i / sr;
      x[s0 + i] += g * (0.45 * (rand() * 2 - 1) + 0.3 * Math.sin(2 * Math.PI * 220 * t)) * Math.exp(-t / 0.06);
    }
  };
  const addHat = (t0) => {
    const g = vel();
    const s0 = Math.round(t0 * sr);
    let prev = 0;
    for (let i = 0; i < sr * 0.06 && s0 + i < len; i++) {
      const n = rand() * 2 - 1;
      x[s0 + i] += g * 0.35 * (n - prev) * Math.exp(-(i / sr) / 0.012);
      prev = n;
    }
  };
  for (let bar = 0; bar < bars; bar++) {
    for (const s of o.kick ?? []) addKick(jit(stepTime(bar, s)));
    for (const s of o.snare ?? []) addSnare(jit(stepTime(bar, s)));
    for (const s of o.hat ?? []) addHat(jit(stepTime(bar, s)));
  }
  if (o.chord) {
    const beatDur = 60 / o.bpm;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      let v = 0;
      for (const f of o.chord) v += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t);
      let g = 0.06;
      if (o.pump) {
        const ph = (t % beatDur) / beatDur;
        g *= Math.min(1, 0.08 + ph * 2.2);
      }
      x[i] += g * v;
    }
  }
  if (o.noise) for (let i = 0; i < len; i++) x[i] += o.noise * (rand() * 2 - 1);
  return { samples: x, sr };
}

export const PATTERNS = {
  house: { kick: [0, 4, 8, 12], snare: [4, 12], hat: [2, 6, 10, 14] },
  trap: { kick: [0, 7, 10], snare: [8], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
  boombap: { kick: [0, 7, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
  reggaeton: { kick: [0, 4, 8, 12], snare: [3, 6, 11, 14], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
};

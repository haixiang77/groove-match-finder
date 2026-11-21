// Recognition-accuracy evaluation harness (synthetic loops with known ground truth).
//   node scripts/eval-recognition.mjs [--out scripts/results/x.txt] [--json]
// Metrics: BPM accuracy / octave errors, per-band grid reproduction, identification rate.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { synthLoop, PATTERNS } from '../tests/synth.js';
import { analyzeAudio, ANALYSIS_VERSION } from '../src/audio/analyzer.js';
import { compareFeatures } from '../src/core/similarity.js';

const SR = 22050;
const H16 = [...Array(16).keys()];
/** name → { pattern, bpms (evaluation tempos), kickDecay } */
const GENRES = {
  house: { ...PATTERNS.house, bpms: [120, 124, 128, 132] },
  trap: { ...PATTERNS.trap, bpms: [130, 140, 150, 160], kickDecay: 0.6 },
  boombap: { ...PATTERNS.boombap, bpms: [80, 90, 95] },
  reggaeton: { ...PATTERNS.reggaeton, bpms: [90, 95, 100] },
  dnb: { kick: [0, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], bpms: [170, 174, 178] },
  dubstep: { kick: [0, 11], snare: [8], hat: [0, 4, 8, 12], bpms: [140, 145] },
  funk: { kick: [0, 3, 6, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], bpms: [100, 110] },
  electro: { kick: [0, 3, 10], snare: [4, 12], hat: [2, 6, 10, 14], bpms: [124, 130] },
  disco: { kick: [0, 4, 8, 12], snare: [4, 12], hat: H16.filter((i) => i % 2 === 0), bpms: [112, 118] },
};
const NAMES = Object.keys(GENRES);
// Near-miss variants (one or two hits moved) – they exist only as identification distractors/targets.
const VARIANTS = {
  house_b: { kick: [0, 4, 8, 12, 14], snare: [4, 12], hat: [2, 6, 10, 14], bpms: [124] },
  trap_b: { kick: [0, 6, 10], snare: [8], hat: H16, bpms: [140], kickDecay: 0.6 },
  boombap_b: { kick: [0, 5, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], bpms: [90] },
  reggaeton_b: { kick: [0, 4, 8, 12], snare: [3, 6, 11, 14], hat: H16, bpms: [95] },
  dnb_b: { kick: [0, 10], snare: [4, 12], hat: [2, 6, 10, 14], bpms: [174] },
  funk_b: { kick: [0, 3, 6, 10], snare: [4, 12], hat: [2, 6, 10, 14], bpms: [100] },
};
// Variants share their base pattern's tempo so tempo similarity can't decide the ranking.
for (const [k, v] of Object.entries(VARIANTS)) v.bpms = [GENRES[k.replace(/_b$/, '')].bpms[0]];
Object.assign(GENRES, VARIANTS);
const BASE = NAMES.slice();
const ALL = Object.keys(GENRES);
const BANDS = ['kick', 'snare', 'hat'];
const hits = (g, b) => Array.from({ length: 16 }, (_, i) => (GENRES[g][b].includes(i) ? 1 : 0));
// EVAL_CACHE=file keeps analyses between runs – only valid while src/audio is unchanged
// (handy for tuning the similarity layer).
const cacheFile = process.env.EVAL_CACHE;
const cache = cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
process.on('exit', () => cacheFile && writeFileSync(cacheFile, JSON.stringify(cache)));
const render = (g, bpm, extra = {}) => {
  const key = `${g}|${bpm}|${JSON.stringify(extra)}`;
  return (cache[key] ??= renderRaw(g, bpm, extra));
};
const renderRaw = (g, bpm, extra = {}) => {
  const { kick, snare, hat, kickDecay } = GENRES[g];
  return analyzeAudio(synthLoop({ bpm, bars: 12, kick, snare, hat, kickDecay, ...extra }).samples, SR);
};
const pct = (v) => `${(100 * v).toFixed(1)}%`;
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };

// ---- 1+2: BPM & grid ---------------------------------------------------------
let n = 0, within1 = 0, half = 0, dbl = 0, other = 0;
const f1Exact = { kick: [], snare: [], hat: [] };
const f1Any = { kick: [], snare: [], hat: [] };
const rowsBpm = [];
const perGenre = {};
const f1OkTempo = { kick: [], snare: [], hat: [] };
const f1 = (g, t) => {
  let tp = 0, fp = 0, fn = 0;
  g.forEach((v, i) => { const p = v >= 0.5; if (p && t[i]) tp++; else if (p) fp++; else if (t[i]) fn++; });
  return tp + fp + fn ? (2 * tp) / (2 * tp + fp + fn) : 1;
};
const rot = (a, s) => a.map((_, i) => a[(i + s) % 16]);
for (const g of NAMES) {
  for (const bpm of GENRES[g].bpms) {
    for (const seed of [1, 2]) {
      const f = render(g, bpm, { seed });
      n++;
      const r = f.bpm / bpm;
      let tag = 'other';
      if (Math.abs(r - 1) <= 0.01) { within1++; tag = 'ok'; }
      else if (Math.abs(r - 0.5) <= 0.02) { half++; tag = 'HALF'; }
      else if (Math.abs(r - 2) <= 0.04) { dbl++; tag = 'DOUBLE'; }
      else other++;
      if (tag !== 'ok') rowsBpm.push(`  ${g} ${bpm} seed${seed} → ${f.bpm} (${tag})`);
      for (const b of BANDS) {
        const t = hits(g, b);
        f1Exact[b].push(f1(f.grid[b], t));
        (perGenre[g] ??= { kick: [], snare: [], hat: [] })[b].push(f1(f.grid[b], t));
        if (tag === 'ok') f1OkTempo[b].push(f1(f.grid[b], t));
        // Rotation-invariant over beat shifts: the same score under whichever downbeat was picked.
        f1Any[b].push(Math.max(...[0, 4, 8, 12].map((s) => f1(rot(f.grid[b], s), t))));
      }
    }
  }
}
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
log(`# RefScope recognition eval  (ANALYSIS_VERSION=${ANALYSIS_VERSION})`);
log('');
log(`## BPM  (n=${n})`);
log(`within ±1%: ${within1}/${n} (${pct(within1 / n)})   half(÷2): ${half}   double(×2): ${dbl}   other: ${other}`);
rowsBpm.forEach(log);
log('');
log('## Grid F1 vs truth pattern (threshold 0.5)');
for (const b of BANDS) log(`${b.padEnd(6)} exact-downbeat ${pct(avg(f1Exact[b]))}   beat-rotation-invariant ${pct(avg(f1Any[b]))}`);
log(`mean   exact-downbeat ${pct(avg(BANDS.map((b) => avg(f1Exact[b]))))}   beat-rotation-invariant ${pct(avg(BANDS.map((b) => avg(f1Any[b]))))}`);

log(`tempo-correct subset (n=${f1OkTempo.kick.length}): ` + BANDS.map((b) => `${b} ${pct(avg(f1OkTempo[b]))}`).join('  '));
log('per genre exact F1 (kick/snare/hat): ' + Object.entries(perGenre).map(([g, v]) => `${g} ${BANDS.map((b) => Math.round(100 * avg(v[b]))).join('/')}`).join('  '));
if (process.argv.includes('--quick')) process.exit(0);
// ---- 3: identification ---------------------------------------------------------
const lib = [];
for (const g of ALL) lib.push({ g, f: render(g, GENRES[g].bpms[0], { seed: 100 }) });
const DEGRADE = {
  clean: {},
  noise: { noise: 0.05 },
  velocity: { velJitter: 0.5 },
  timing: { timingJitterMs: 8 },
  swing: { swing: 58 },
  combined: { noise: 0.03, velJitter: 0.4, timingJitterMs: 5, swing: 56 },
  harsh: { noise: 0.12, velJitter: 0.7, timingJitterMs: 12, swing: 60 },
  tempo12: { tempoMul: 1.12, noise: 0.03, velJitter: 0.4 },
};
log('');
log(`## Identification (library ${lib.length} patterns incl. near-variants; query = ×1.04 tempo unless noted, different seed)`);
let tot = 0, top1 = 0, rr = 0;
const conf = [];
for (const [dn, extra] of Object.entries(DEGRADE)) {
  let t = 0, c = 0;
  for (const g of ALL) {
    const { tempoMul = 1.04, ...ex } = extra;
    const q = render(g, Math.round(GENRES[g].bpms[0] * tempoMul), { seed: 7, ...ex });
    const ranked = lib.map((l) => ({ g: l.g, s: compareFeatures(q, l.f).score })).sort((a, b) => b.s - a.s);
    const rank = ranked.findIndex((x) => x.g === g) + 1;
    t++; if (rank === 1) c++; else conf.push(`  [${dn}] ${g} → top1 ${ranked[0].g} (rank of truth ${rank})`);
    rr += 1 / rank;
  }
  tot += t; top1 += c;
  log(`${dn.padEnd(9)} ${c}/${t} (${pct(c / t)})`);
}
log(`overall   ${top1}/${tot} (${pct(top1 / tot)})   MRR ${(rr / tot).toFixed(3)}`);
conf.forEach(log);

const outIdx = process.argv.indexOf('--out');
if (outIdx > 0) {
  const p = process.argv[outIdx + 1];
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, out.join('\n') + '\n');
}

// End-to-end smoke test: serves the app, mocks every external API with a fake
// iTunes catalogue of synthetic previews, uploads a synthetic house loop and
// checks that the pipeline ranks the house-like previews first.
//   node tests/e2e/run.mjs [screenshotDir]
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// Use a globally installed Playwright when the project doesn't depend on it.
const { chromium } = createRequire(import.meta.url)('playwright');
import { synthLoop, PATTERNS } from '../synth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shotDir = process.argv[2] ?? null;

function wav(samples, sr) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  let peak = 1; for (const v of samples) peak = Math.max(peak, Math.abs(v));
  samples.forEach((v, i) => buf.writeInt16LE(Math.round((v / peak) * 32000), 44 + i * 2));
  return buf;
}
const loop = (o, bars = 14) => wav(synthLoop({ bars, ...o }).samples, 22050);

const pad = [261.6, 329.6, 392];
const catalogue = [
  { id: 1, artist: 'Nova Lane', title: 'Pump It Slow', audio: loop({ bpm: 125, ...PATTERNS.house, chord: [293.7, 370, 440], pump: true, seed: 5 }) },
  { id: 2, artist: 'Disco Ghost', title: 'Glitter Floor', audio: loop({ bpm: 122, ...PATTERNS.house, chord: pad, seed: 6 }) },
  { id: 3, artist: 'Velvet Ops', title: 'Night Shift', audio: loop({ bpm: 127, ...PATTERNS.house, chord: [220, 277.2, 329.6], pump: true, seed: 7 }) },
  { id: 4, artist: 'Gray Fog', title: '808 Ritual', audio: loop({ bpm: 140, ...PATTERNS.trap, kickDecay: 0.6 }) },
  { id: 5, artist: 'Mono Block', title: 'Dusty Tape', audio: loop({ bpm: 90, ...PATTERNS.boombap }) },
  { id: 6, artist: 'Calle Nueve', title: 'Perreo Lunar', audio: loop({ bpm: 95, ...PATTERNS.reggaeton }) },
  { id: 7, artist: 'Gray Fog', title: 'Cold Hands', audio: loop({ bpm: 145, ...PATTERNS.trap, kickDecay: 0.6, seed: 3 }) },
];
const inputWav = loop({ bpm: 124, ...PATTERNS.house, chord: pad, pump: true }, 40);
const track = (c) => ({ kind: 'song', trackId: c.id, trackName: c.title, artistName: c.artist, collectionName: 'Mock', previewUrl: `https://audio-ssl.itunes.apple.com/mock/${c.id}.m4a`, artworkUrl100: `https://is1-ssl.mzstatic.com/mock/${c.id}/100x100bb.jpg`, trackViewUrl: `https://music.apple.com/jp/album/mock/${c.id}`, primaryGenreName: c.id <= 3 ? 'Dance' : 'Hip-Hop/Rap', releaseDate: '2021-01-01T00:00:00Z' });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try {
    const file = (await fs.stat(p)).isDirectory() ? path.join(p, 'index.html') : p;
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const failures = [];
const consoleErrors = [];
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    const searches = [];
    await page.route('https://itunes.apple.com/**', (route) => {
      const u = new URL(route.request().url());
      const term = u.searchParams.get('term') ?? '';
      searches.push(term);
      const results = /test song/i.test(term) ? [{ ...track({ id: 99, artist: 'Test Artist', title: 'Test Song' }), primaryGenreName: 'Dance' }] : catalogue.map(track);
      const body = JSON.stringify({ resultCount: results.length, results });
      const cb = u.searchParams.get('callback');
      route.fulfill({ status: 200, contentType: cb ? 'text/javascript' : 'application/json', headers: { 'access-control-allow-origin': '*' }, body: cb ? `${cb}(${body});` : body });
    });
    await page.route('https://audio-ssl.itunes.apple.com/mock/**', (route) => {
      const id = Number(route.request().url().match(/(\d+)\.m4a/)[1]);
      const c = catalogue.find((x) => x.id === id);
      route.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'access-control-allow-origin': '*' }, body: c ? c.audio : inputWav });
    });
    await page.route('https://is1-ssl.mzstatic.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#3a3f55"/></svg>' }));
    await page.route('https://musicbrainz.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ recordings: [] }) }));

    await page.goto(base);
    await page.setInputFiles('#file-input', { name: 'Test Artist - Test Song.wav', mimeType: 'audio/wav', buffer: inputWav });
    await page.waitForFunction(() => !document.querySelector('#run-button').disabled, null, { timeout: 30000 });
    if (shotDir && viewport.width > 500) await page.screenshot({ path: path.join(shotDir, 'e2e-track.png'), fullPage: true });
    await page.click('#run-button');
    await page.waitForFunction(() => document.querySelector('[data-step="filter"]')?.dataset.state === 'done' || document.querySelector('[data-step="filter"]')?.dataset.state === 'error', null, { timeout: 120000 });
    await page.waitForTimeout(300);

    const titles = await page.$$eval('#results .result .result-title', (els) => els.map((e) => e.textContent));
    const steps = await page.$$eval('#steps li', (els) => els.map((e) => `${e.dataset.step}:${e.dataset.state}:${e.querySelector('.step-detail').textContent}`));
    const ident = await page.textContent('#identity');
    const bpm = await page.textContent('#stats .stat-value');
    const hybrid = await page.textContent('#genres .hybrid');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`[${viewport.width}px] steps:`, steps.join(' | '));
    console.log(`[${viewport.width}px] identity: ${ident?.trim()} | input BPM: ${bpm} | genre: ${hybrid}`);
    console.log(`[${viewport.width}px] ranked:`, titles.join(', '), `| iTunes queries: ${searches.length}`);
    if (Number(bpm) !== 124) failures.push(`input BPM ${bpm}`);
    if (!ident?.includes('Test Song')) failures.push('identification from file name failed');
    if (titles.length < 2) failures.push('too few results');
    const houseTitles = ['Pump It Slow', 'Glitter Floor', 'Night Shift'];
    if (!houseTitles.includes(titles[0])) failures.push(`top result not house-like: ${titles[0]}`);
    if (titles.some((t) => ['808 Ritual', 'Dusty Tape', 'Cold Hands'].includes(t))) failures.push('non-matching genre passed the filter');
    if (titles.includes('Test Song')) failures.push('input track was not excluded');
    if (overflow > 1) failures.push(`horizontal overflow ${overflow}px at ${viewport.width}px`);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `e2e-results-${viewport.width}.png`), fullPage: true });

    // Settings dialog round-trip
    await page.click('#settings-button');
    await page.fill('input[name="lastfmKey"]', 'dummy-key');
    await page.click('#settings-form button[type="submit"]');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('refscope.settings.v1') ?? '{}').lastfmKey);
    if (saved !== 'dummy-key') failures.push('settings not persisted');
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
const relevantErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
if (relevantErrors.length) failures.push(`console errors: ${relevantErrors.join(' || ')}`);
if (failures.length) {
  console.error('E2E FAILED:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('E2E OK');

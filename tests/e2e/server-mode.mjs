// Server-mode E2E: the page is served by the Python backend; the browser
// uploads the region and renders the streamed results. Phone viewport.
//   python tests_py/e2e_server.py 8765 &  node tests/e2e/server-mode.mjs 8765 [shotDir]
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { synthLoop, PATTERNS } from '../synth.js';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const port = process.argv[2] ?? '8765';
const shotDir = process.argv[3];

function wav(samples, sr) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  let peak = 1; for (const v of samples) peak = Math.max(peak, Math.abs(v));
  samples.forEach((v, i) => buf.writeInt16LE(Math.round((v / peak) * 32000), 44 + i * 2));
  return buf;
}

const browser = await chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // The page must never call iTunes itself in server mode.
  await page.route('https://itunes.apple.com/**', (r) => { errors.push('browser called iTunes'); r.abort(); });
  await page.route('https://is1-ssl.mzstatic.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#3a3f55"/></svg>' }));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#mode-badge:not([hidden])', { timeout: 10000 });
  const input = wav(synthLoop({ bpm: 124, bars: 40, ...PATTERNS.house, chord: [261.6, 329.6, 392], pump: true }).samples, 22050);
  await page.setInputFiles('#file-input', { name: 'Test Artist - Test Song.wav', mimeType: 'audio/wav', buffer: input });
  await page.waitForFunction(() => !document.querySelector('#run-button').disabled, null, { timeout: 30000 });
  await page.click('#run-button');
  await page.waitForFunction(() => ['done', 'error'].includes(document.querySelector('[data-step="filter"]')?.dataset.state ?? ''), null, { timeout: 120000 });
  await page.waitForTimeout(400);
  const titles = await page.$$eval('#results .result .result-title', (els) => els.map((e) => e.textContent));
  const steps = await page.$$eval('#steps li', (els) => els.map((e) => `${e.dataset.step}:${e.dataset.state}`));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('steps', steps.join(' '), '| ranked', titles.join(', '), '| overflow', overflow);
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, 'server-mode-iphone.png') });
    await page.click('#settings-button');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shotDir, 'server-mode-settings.png') });
  }
  if (!['Pump It Slow', 'Glitter Floor', 'Night Shift'].includes(titles[0])) errors.push(`unexpected top result ${titles[0]}`);
  if (overflow > 1) errors.push(`overflow ${overflow}`);
} finally {
  await browser.close();
}
if (errors.length) { console.error('SERVER E2E FAILED\n - ' + errors.join('\n - ')); process.exit(1); }
console.log('SERVER E2E OK');

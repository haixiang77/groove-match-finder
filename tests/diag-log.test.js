import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDiagLog, redactSecrets } from '../src/diag-log.js';
import { loadModuleWithRetry, buildModuleUrl } from '../src/load-retry.js';

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

test('first URL carries ?v=<APP_VERSION>; retries add cache-bust', () => {
  assert.equal(buildModuleUrl('./app.js', '1.1.0', 0), './app.js?v=1.1.0');
  assert.match(buildModuleUrl('./app.js', '1.1.0', 1, 123), /^\.\/app\.js\?v=1\.1\.0&r=123-1$/);
});

test('retries up to 2 times then succeeds without error', async () => {
  const urls = [];
  const mod = await loadModuleWithRetry({
    path: './app.js',
    version: '1.1.0',
    importer: async (u) => {
      urls.push(u);
      if (urls.length < 3) throw new Error('boom');
      return { ok: true };
    },
  });
  assert.deepEqual(mod, { ok: true });
  assert.equal(urls.length, 3);
  assert.equal(urls[0], './app.js?v=1.1.0');
  assert.notEqual(urls[1], urls[2]);
});

test('success on retry does not reject (so no banner path)', async () => {
  let n = 0;
  await assert.doesNotReject(
    loadModuleWithRetry({ path: './a.js', version: '1', importer: async () => { if (n++ === 0) throw new Error('x'); return 1; } }),
  );
});

test('gives up after 3 attempts total and rejects with last error', async () => {
  let n = 0;
  await assert.rejects(
    loadModuleWithRetry({ path: './a.js', version: '1', importer: async () => { n++; throw new Error(`e${n}`); } }),
    /e3/,
  );
  assert.equal(n, 3);
});

test('entries are capped and persisted across instances', () => {
  const storage = memStorage();
  const a = createDiagLog({ storage, max: 5 });
  for (let i = 0; i < 12; i++) a.log('boot', `n${i}`);
  assert.equal(a.entries().length, 5);
  const b = createDiagLog({ storage, max: 5 });
  assert.deepEqual(b.entries().map((e) => e.msg), ['n7', 'n8', 'n9', 'n10', 'n11']);
  assert.match(b.entries()[0].t, /^\d{4}-\d\d-\d\dT/);
  assert.match(b.format(), /\[boot\] n11$/);
});

test('API keys are redacted in URLs and text', () => {
  const s = redactSecrets('https://ws.audioscrobbler.com/2.0/?method=x&api_key=SECRET123&format=json');
  assert.ok(!s.includes('SECRET123'));
  assert.match(s, /method=x/);
  const log = createDiagLog({ storage: memStorage() });
  log.log('analysis', 'url https://x.test/a?token=ABC&q=1');
  log.log('error', new Error('failed api_key=ZZZ'));
  assert.ok(!log.format().includes('ABC'));
  assert.ok(!log.format().includes('ZZZ'));
  assert.match(log.format(), /q=1/);
});

test('logging never throws (broken storage, circular data)', () => {
  const bad = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => { throw new Error('denied'); },
  };
  const log = createDiagLog({ storage: bad, now: () => { throw new Error('clock'); } });
  assert.doesNotThrow(() => log.log('x', 'y'));
  const c = {};
  c.self = c;
  const log2 = createDiagLog({ storage: bad });
  assert.doesNotThrow(() => log2.log('x', c));
  assert.doesNotThrow(() => log2.clear());
  assert.doesNotThrow(() => log2.format());
});

test('corrupted stored data is ignored', () => {
  const storage = memStorage();
  storage.setItem('refscope.diag.v1', '{not json');
  assert.deepEqual(createDiagLog({ storage }).entries(), []);
});

test('index.html exposes diagnostic log entry point', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="diag-open"/);
});

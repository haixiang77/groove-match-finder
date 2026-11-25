import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '../src/version.js';
import { formatVersionLabel } from '../src/ui/version-label.js';

test('APP_VERSION matches package.json version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(APP_VERSION, pkg.version);
});

test('version label format', () => {
  assert.equal(formatVersionLabel('1.1.0', 6), 'RefScope v1.1.0（解析バージョン 6）');
});

test('index.html has empty version element without hardcoded version', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<p id="app-version"><\/p>/);
  assert.ok(!html.includes(APP_VERSION));
});

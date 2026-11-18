import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as lastfm from '../src/services/lastfm.js';
import { identifyWithAudD } from '../src/services/fingerprint.js';
import { generateJson } from '../src/services/gemini.js';
import { viaProxy } from '../src/services/http.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
/** @param {(url: string, init?: RequestInit) => unknown} handler */
const mockFetch = (handler) => {
  globalThis.fetch = async (url, init) => {
    const body = handler(String(url), init);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
};

test('Last.fm similar tracks are parsed (single object or array)', async () => {
  mockFetch((url) => {
    assert.ok(url.includes('method=track.getSimilar'));
    return { similartracks: { track: [{ name: 'Song A', match: '0.9', artist: { name: 'X' } }, { name: 'Song B', artist: { name: 'Y' } }] } };
  });
  const r = await lastfm.getSimilarTracks('Z', 'Q', 'key');
  assert.deepEqual(r, [
    { artist: 'X', title: 'Song A', match: 0.9 },
    { artist: 'Y', title: 'Song B', match: 0.5 },
  ]);
  mockFetch(() => ({ toptags: { tag: { name: 'trap', count: 100 } } }));
  assert.deepEqual(await lastfm.getTrackTags('Z', 'Q', 'key'), [{ name: 'trap', weight: 1 }]);
});

test('Last.fm API errors surface as LastfmError', async () => {
  mockFetch(() => ({ error: 10, message: 'Invalid API key' }));
  await assert.rejects(() => lastfm.getSimilarTracks('Z', 'Q', 'bad'), lastfm.LastfmError);
});

test('AudD: match, no match and error', async () => {
  const wav = new Blob([new Uint8Array(10)]);
  mockFetch(() => ({ status: 'success', result: { artist: 'Daft Punk', title: 'One More Time', apple_music: { isrc: 'GBDUW0000059', url: 'https://music.apple.com/album/x/123?i=456' } } }));
  const id = await identifyWithAudD(wav, { token: 't', proxy: '' });
  assert.equal(id?.title, 'One More Time');
  assert.equal(id?.isrc, 'GBDUW0000059');
  assert.equal(id?.appleMusicId, '456');
  mockFetch(() => ({ status: 'success', result: null }));
  assert.equal(await identifyWithAudD(wav, { token: 't', proxy: '' }), null);
  mockFetch(() => ({ status: 'error', error: { error_code: 900, error_message: 'bad token' } }));
  await assert.rejects(() => identifyWithAudD(wav, { token: 't', proxy: '' }), /bad token/);
});

test('Gemini JSON responses are extracted (thought parts skipped)', async () => {
  mockFetch((url, init) => {
    assert.ok(url.includes(':generateContent'));
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'k');
    return { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"ok": true}' }] } }] };
  });
  assert.deepEqual(await generateJson({ apiKey: 'k', model: 'm', parts: [{ text: 'hi' }], schema: {} }), { ok: true });
});

test('proxy URL building', () => {
  assert.equal(viaProxy('https://a.b/c?d=1', 'https://p.dev/?url='), 'https://p.dev/?url=https%3A%2F%2Fa.b%2Fc%3Fd%3D1');
  assert.equal(viaProxy('https://a.b/', 'https://p.dev/{url}/x'), 'https://p.dev/https%3A%2F%2Fa.b%2F/x');
  assert.equal(viaProxy('https://a.b/', ''), 'https://a.b/');
});

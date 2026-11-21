import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCorsAware, fetchJson, HttpError, NetworkError } from '../src/services/http.js';

/** Stub global fetch with a scripted sequence of outcomes; returns call counter. */
function stubFetch(steps) {
  const orig = globalThis.fetch;
  const state = { calls: 0 };
  globalThis.fetch = async () => {
    const step = steps[Math.min(state.calls++, steps.length - 1)];
    if (step === 'net') throw new TypeError('Load failed');
    return new Response(step.body ?? '{}', { status: step.status });
  };
  state.restore = () => {
    globalThis.fetch = orig;
  };
  return state;
}
const fast = { delayScale: 0 };

test('fetchJson retries a network error and then succeeds', async () => {
  const s = stubFetch(['net', { status: 200, body: '{"ok":1}' }]);
  try {
    assert.deepEqual(await fetchJson('https://x.test/a', fast), { ok: 1 });
    assert.equal(s.calls, 2);
  } finally {
    s.restore();
  }
});

test('fetchJson gives up after 2 network retries with NetworkError', async () => {
  const s = stubFetch(['net']);
  try {
    await assert.rejects(fetchJson('https://x.test/a', fast), NetworkError);
    assert.equal(s.calls, 3);
  } finally {
    s.restore();
  }
});

test('fetchJson retries HTTP 403 exactly once', async () => {
  const s = stubFetch([{ status: 403 }, { status: 200, body: '[1]' }]);
  try {
    assert.deepEqual(await fetchJson('https://x.test/a', fast), [1]);
    assert.equal(s.calls, 2);
  } finally {
    s.restore();
  }
  const s2 = stubFetch([{ status: 403 }]);
  try {
    await assert.rejects(fetchJson('https://x.test/a', fast), (e) => e instanceof HttpError && e.status === 403);
    assert.equal(s2.calls, 2);
  } finally {
    s2.restore();
  }
});

test('fetchJson does not retry a 404', async () => {
  const s = stubFetch([{ status: 404 }]);
  try {
    await assert.rejects(fetchJson('https://x.test/a', fast), (e) => e instanceof HttpError && e.status === 404);
    assert.equal(s.calls, 1);
  } finally {
    s.restore();
  }
});

test('fetchJson stops sleeping when aborted', async () => {
  const s = stubFetch(['net']);
  const ctrl = new AbortController();
  try {
    const p = fetchJson('https://x.test/a', { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await assert.rejects(p, (e) => e.name === 'AbortError');
  } finally {
    s.restore();
  }
});

test('fetchCorsAware retries once on network error, then succeeds', async () => {
  const s = stubFetch(['net', { status: 200 }]);
  try {
    const res = await fetchCorsAware('https://x.test/a.m4a', '', fast);
    assert.equal(res.status, 200);
    assert.equal(s.calls, 2);
  } finally {
    s.restore();
  }
});

test('fetchCorsAware: persistent 403 without proxy returns the response after one retry', async () => {
  const s = stubFetch([{ status: 403 }]);
  try {
    const res = await fetchCorsAware('https://x.test/a.m4a', '', fast);
    assert.equal(res.status, 403);
    assert.equal(s.calls, 2);
  } finally {
    s.restore();
  }
});

test('fetchCorsAware: persistent network error throws without proxy, uses proxy when set', async () => {
  const s = stubFetch(['net']);
  try {
    await assert.rejects(fetchCorsAware('https://x.test/a.m4a', '', fast), NetworkError);
    assert.equal(s.calls, 2);
  } finally {
    s.restore();
  }
  const s2 = stubFetch(['net', 'net', { status: 200 }]);
  try {
    const res = await fetchCorsAware('https://x.test/a.m4a', 'https://p.test/?url=', fast);
    assert.equal(res.status, 200);
    assert.equal(s2.calls, 3);
  } finally {
    s2.restore();
  }
});

// @ts-check
/**
 * HTTP helpers for a static (GitHub Pages) app: timeouts, retries, JSONP and
 * an optional user-supplied CORS proxy for APIs / CDNs that don't send CORS
 * headers.
 */
import { sleep } from '../util.js';

export class HttpError extends Error {
  /** @param {string} message @param {number} status @param {string} url */
  constructor(message, status, url) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/** Thrown when the browser blocks a response (CORS / network). */
export class NetworkError extends Error {
  /** @param {string} message @param {string} url */
  constructor(message, url) {
    super(message);
    this.name = 'NetworkError';
    this.url = url;
  }
}

/**
 * Build a proxied URL. Supports `https://proxy/?url=` (appends the encoded
 * URL) and templates containing `{url}`.
 * @param {string} url
 * @param {string} proxy
 */
export function viaProxy(url, proxy) {
  if (!proxy) return url;
  if (proxy.includes('{url}')) return proxy.replace('{url}', encodeURIComponent(url));
  return proxy + encodeURIComponent(url);
}

/**
 * fetch() with timeout + abort-signal chaining.
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number}} [init]
 */
export async function fetchWithTimeout(url, init = {}) {
  const { timeoutMs = 20000, signal, ...rest } = init;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err;
    if (err instanceof DOMException && err.name === 'TimeoutError') throw new NetworkError(`タイムアウト: ${shortUrl(url)}`, url);
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof DOMException && ctrl.signal.reason.name === 'TimeoutError')
      throw new NetworkError(`タイムアウト: ${shortUrl(url)}`, url);
    throw new NetworkError(`通信できませんでした（ネットワークエラー）: ${shortUrl(url)}`, url);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetch JSON with retries on 429 / 5xx (exponential backoff).
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number, retries?: number}} [init]
 * @returns {Promise<unknown>}
 */
export async function fetchJson(url, init = {}) {
  const { retries = 2, ...rest } = init;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithTimeout(url, rest);
    if (res.ok) {
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(`JSON以外の応答: ${shortUrl(url)}`, res.status, url);
      }
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 800 * 2 ** attempt, rest.signal ?? undefined);
      continue;
    }
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new HttpError(`HTTP ${res.status} ${shortUrl(url)} ${detail}`.trim(), res.status, url);
  }
}

/**
 * Try a direct CORS request first, then the user's proxy (if configured).
 * @param {string} url
 * @param {string} proxy
 * @param {RequestInit & {timeoutMs?: number}} [init]
 */
export async function fetchCorsAware(url, proxy, init = {}) {
  try {
    const res = await fetchWithTimeout(url, init);
    if (res.ok || !proxy) return res;
    if (res.status !== 403) return res;
  } catch (err) {
    if (!(err instanceof NetworkError) || !proxy) throw err;
  }
  return fetchWithTimeout(viaProxy(url, proxy), init);
}

let jsonpCounter = 0;

/**
 * JSONP request (the iTunes Search API supports `callback=`), which works
 * from any origin regardless of CORS headers.
 * @param {string} url URL without the callback parameter
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<unknown>}
 */
export function jsonp(url, opts = {}) {
  const { timeoutMs = 15000, signal } = opts;
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') return reject(new NetworkError('JSONP is browser-only', url));
    const name = `__refscope_jsonp_${Date.now().toString(36)}_${jsonpCounter++}`;
    const script = document.createElement('script');
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    const cleanup = () => {
      clearTimeout(timer);
      delete w[name];
      script.remove();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new NetworkError(`JSONPタイムアウト: ${shortUrl(url)}`, url));
    }, timeoutMs);
    w[name] = (/** @type {unknown} */ data) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new NetworkError(`JSONP読み込み失敗（レート制限の可能性）: ${shortUrl(url)}`, url));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    script.src = `${url}${url.includes('?') ? '&' : '?'}callback=${name}`;
    document.head.appendChild(script);
  });
}

/** @param {string} url */
export function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

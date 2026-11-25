// @ts-check
/**
 * Dynamic import with cache-busting retries. DOM-free.
 */

export const MAX_RETRIES = 2;

/**
 * @param {string} path module path relative to the importer, e.g. "./app.js"
 * @param {string} version value for ?v=
 * @param {number} attempt 0 = first load, n = nth retry
 * @param {number} [stamp]
 * @returns {string}
 */
export function buildModuleUrl(path, version, attempt, stamp = Date.now()) {
  const v = `${path}?v=${encodeURIComponent(version)}`;
  return attempt === 0 ? v : `${v}&r=${stamp}-${attempt}`;
}

/**
 * Load a module; on failure retry up to `retries` times with a cache-busting query.
 * Rejects with the last error if all attempts fail.
 * @template T
 * @param {{
 *   path: string,
 *   version: string,
 *   importer: (url: string) => Promise<T>,
 *   retries?: number,
 *   log?: (ev: string, detail?: unknown) => void,
 *   stamp?: () => number,
 * }} o
 * @returns {Promise<T>}
 */
export async function loadModuleWithRetry(o) {
  const retries = o.retries ?? MAX_RETRIES;
  const log = o.log ?? (() => {});
  const stamp = o.stamp ?? Date.now;
  /** @type {unknown} */
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const url = buildModuleUrl(o.path, o.version, attempt, stamp());
    try {
      log('module', `load ${attempt === 0 ? 'start' : `retry ${attempt}/${retries}`}: ${url}`);
      const mod = await o.importer(url);
      log('module', `load ok: ${o.path}${attempt ? ` (after ${attempt} retr${attempt === 1 ? 'y' : 'ies'})` : ''}`);
      return mod;
    } catch (err) {
      lastErr = err;
      log('module', `load failed (attempt ${attempt + 1}/${retries + 1}): ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
  }
  throw lastErr;
}

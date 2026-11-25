// @ts-check
/**
 * Diagnostic log. DOM-free and dependency-free. Persisted to localStorage so it
 * survives a reload. Every public function swallows its own errors: logging
 * must never break the app.
 */

export const DIAG_STORAGE_KEY = 'refscope.diag.v1';
export const DIAG_MAX_ENTRIES = 200;
const MAX_MESSAGE_LEN = 500;

/** Query parameter names whose values are secrets (matched case-insensitively). */
const SECRET_PARAM = /^(.*key.*|.*token.*|.*secret.*|.*password.*|.*auth.*|api_sig|sig|signature|session|sk)$/i;

/**
 * @typedef {{ t: string, ev: string, msg: string }} DiagEntry
 * @typedef {{ getItem: (k: string) => string | null, setItem: (k: string, v: string) => void, removeItem: (k: string) => void }} StorageLike
 */

/**
 * Mask values of key-like query parameters inside a URL or any text containing
 * `name=value` pairs.
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  try {
    return String(text).replace(/([?&;\s"'])([A-Za-z0-9_.-]+)=([^&#\s"']*)/g, (m, pre, name) =>
      SECRET_PARAM.test(name) ? `${pre}${name}=***` : m,
    );
  } catch {
    return '[unredactable]';
  }
}

/** @param {unknown} v */
function stringify(v) {
  if (v === undefined || v === null) return '';
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * Create a log instance.
 * @param {{ storage?: StorageLike | null, max?: number, now?: () => Date, key?: string }} [opts]
 */
export function createDiagLog(opts = {}) {
  const max = opts.max ?? DIAG_MAX_ENTRIES;
  const key = opts.key ?? DIAG_STORAGE_KEY;
  const now = opts.now ?? (() => new Date());
  /** @returns {StorageLike | null} */
  const store = () => {
    try {
      return opts.storage !== undefined ? opts.storage : (globalThis.localStorage ?? null);
    } catch {
      return null;
    }
  };

  /** @type {DiagEntry[]} */
  let list = [];
  try {
    const raw = store()?.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      list = parsed
        .filter((e) => e && typeof e.t === 'string' && typeof e.ev === 'string')
        .map((e) => ({ t: e.t, ev: e.ev, msg: redactSecrets(String(e.msg ?? '')) }))
        .slice(-max);
    }
  } catch {
    list = [];
  }

  function persist() {
    try {
      store()?.setItem(key, JSON.stringify(list));
    } catch {
      /* quota / private mode: keep in-memory only */
    }
  }

  return {
    /**
     * Record an event. Never throws.
     * @param {string} ev event name, e.g. "boot", "module", "error", "analysis"
     * @param {unknown} [detail]
     */
    log(ev, detail) {
      try {
        let msg = redactSecrets(stringify(detail));
        if (msg.length > MAX_MESSAGE_LEN) msg = `${msg.slice(0, MAX_MESSAGE_LEN)}…`;
        list.push({ t: now().toISOString(), ev: String(ev), msg });
        if (list.length > max) list = list.slice(list.length - max);
        persist();
      } catch {
        /* never propagate */
      }
    },
    /** @returns {DiagEntry[]} */
    entries() {
      return list.slice();
    },
    /** @returns {string} plain text, one line per entry */
    format() {
      try {
        return list.map((e) => `${e.t} [${e.ev}] ${e.msg}`.trimEnd()).join('\n');
      } catch {
        return '';
      }
    },
    clear() {
      try {
        list = [];
        store()?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Shared instance used by the app. */
export const diag = createDiagLog();

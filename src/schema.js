// @ts-check
/**
 * Minimal Pydantic-style runtime validation.
 *
 * Every external payload (Last.fm, iTunes, MusicBrainz, AudD, ACRCloud, Gemini,
 * localStorage settings) and every analysis result passes through a schema
 * before the rest of the app touches it, so malformed data fails loudly at the
 * boundary instead of deep inside the pipeline.
 */

export class ValidationError extends Error {
  /** @param {{path: string, message: string}[]} issues */
  constructor(issues) {
    super(issues.map((i) => `${i.path || '<root>'}: ${i.message}`).join('; '));
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, issues: {path: string, message: string}[] }} ParseResult
 */

/** @template T */
export class Schema {
  /** @param {(v: unknown, path: string, issues: {path: string, message: string}[]) => T} check */
  constructor(check) {
    this._check = check;
  }

  /**
   * Validate and return the (possibly coerced) value. Throws ValidationError.
   * @param {unknown} value
   * @returns {T}
   */
  parse(value) {
    /** @type {{path: string, message: string}[]} */
    const issues = [];
    const out = this._check(value, '', issues);
    if (issues.length) throw new ValidationError(issues);
    return out;
  }

  /**
   * @param {unknown} value
   * @returns {ParseResult<T>}
   */
  safeParse(value) {
    /** @type {{path: string, message: string}[]} */
    const issues = [];
    const out = this._check(value, '', issues);
    return issues.length ? { ok: false, issues } : { ok: true, value: out };
  }

  /** @returns {Schema<T | undefined>} */
  optional() {
    return new Schema((v, p, i) => (v === undefined || v === null ? undefined : this._check(v, p, i)));
  }

  /**
   * Replace missing / invalid values with a default instead of failing.
   * @param {T} fallback
   * @returns {Schema<T>}
   */
  catch(fallback) {
    return new Schema((v, p) => {
      /** @type {{path: string, message: string}[]} */
      const local = [];
      const out = this._check(v, p, local);
      return local.length ? fallback : out;
    });
  }
}

const typeOf = (/** @type {unknown} */ v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

export const s = {
  /** @param {{min?: number, max?: number, trim?: boolean}} [o] @returns {Schema<string>} */
  string(o = {}) {
    return new Schema((v, path, issues) => {
      if (typeof v === 'number') v = String(v);
      if (typeof v !== 'string') {
        issues.push({ path, message: `expected string, got ${typeOf(v)}` });
        return '';
      }
      const str = o.trim === false ? v : v.trim();
      if (o.min !== undefined && str.length < o.min) issues.push({ path, message: `string shorter than ${o.min}` });
      if (o.max !== undefined && str.length > o.max) issues.push({ path, message: `string longer than ${o.max}` });
      return str;
    });
  },

  /** @param {{min?: number, max?: number, int?: boolean, coerce?: boolean}} [o] @returns {Schema<number>} */
  number(o = {}) {
    return new Schema((v, path, issues) => {
      let n = v;
      if (o.coerce && typeof v === 'string' && v.trim() !== '') n = Number(v);
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        issues.push({ path, message: `expected finite number, got ${typeOf(v)}` });
        return 0;
      }
      if (o.int && !Number.isInteger(n)) issues.push({ path, message: 'expected integer' });
      if (o.min !== undefined && n < o.min) issues.push({ path, message: `must be >= ${o.min}` });
      if (o.max !== undefined && n > o.max) issues.push({ path, message: `must be <= ${o.max}` });
      return n;
    });
  },

  /** @returns {Schema<boolean>} */
  boolean() {
    return new Schema((v, path, issues) => {
      if (typeof v !== 'boolean') {
        issues.push({ path, message: `expected boolean, got ${typeOf(v)}` });
        return false;
      }
      return v;
    });
  },

  /**
   * @template {string} L
   * @param {readonly L[]} values
   * @returns {Schema<L>}
   */
  enum(values) {
    return new Schema((v, path, issues) => {
      if (typeof v !== 'string' || !values.includes(/** @type {L} */ (v))) {
        issues.push({ path, message: `expected one of ${values.join('|')}` });
        return values[0];
      }
      return /** @type {L} */ (v);
    });
  },

  /**
   * @template T
   * @param {Schema<T>} item
   * @param {{min?: number, max?: number, dropInvalid?: boolean}} [o]
   * @returns {Schema<T[]>}
   */
  array(item, o = {}) {
    return new Schema((v, path, issues) => {
      if (!Array.isArray(v)) {
        issues.push({ path, message: `expected array, got ${typeOf(v)}` });
        return [];
      }
      /** @type {T[]} */
      const out = [];
      v.forEach((el, idx) => {
        /** @type {{path: string, message: string}[]} */
        const local = [];
        const parsed = item._check(el, `${path}[${idx}]`, local);
        if (local.length) {
          if (!o.dropInvalid) issues.push(...local);
        } else out.push(parsed);
      });
      if (o.min !== undefined && out.length < o.min) issues.push({ path, message: `needs at least ${o.min} items` });
      if (o.max !== undefined && out.length > o.max) issues.push({ path, message: `at most ${o.max} items` });
      return out;
    });
  },

  /**
   * Object schema. Unknown keys are stripped (like Pydantic's default `ignore`).
   * @template {Record<string, Schema<any>>} S
   * @param {S} shape
   * @returns {Schema<{ [K in keyof S]: S[K] extends Schema<infer U> ? U : never }>}
   */
  object(shape) {
    return new Schema((v, path, issues) => {
      /** @type {Record<string, unknown>} */
      const out = {};
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        issues.push({ path, message: `expected object, got ${typeOf(v)}` });
        return /** @type {any} */ (out);
      }
      const obj = /** @type {Record<string, unknown>} */ (v);
      for (const [key, schema] of Object.entries(shape)) {
        const value = schema._check(obj[key], path ? `${path}.${key}` : key, issues);
        if (value !== undefined) out[key] = value;
      }
      return /** @type {any} */ (out);
    });
  },

  /**
   * Coerces "single object or array of objects" (common in Last.fm XML→JSON) into an array.
   * @template T
   * @param {Schema<T>} item
   * @returns {Schema<T[]>}
   */
  oneOrMany(item) {
    const arr = s.array(item, { dropInvalid: true });
    return new Schema((v, path, issues) => {
      if (v === undefined || v === null || v === '') return [];
      return arr._check(Array.isArray(v) ? v : [v], path, issues);
    });
  },

  /** @returns {Schema<unknown>} */
  unknown() {
    return new Schema((v) => v);
  },
};

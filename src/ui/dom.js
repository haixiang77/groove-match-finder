// @ts-check
/**
 * Tiny hyperscript helper — builds DOM nodes without innerHTML so that
 * remote strings (track titles, AI output) are always inserted as text.
 */

/**
 * @typedef {string | number | Node | null | undefined | false} Child
 * @param {string} tag
 * @param {Record<string, unknown> | null} [attrs]
 * @param {...(Child | Child[])} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), /** @type {EventListener} */ (v));
    else if (k.startsWith('--')) el.style.setProperty(k, String(v));
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

/** @param {Element} el @param {(Child | Child[])[]} children */
function append(el, children) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/**
 * Inline SVG icon from the sprite.
 * @param {string} name
 * @param {string} [cls]
 */
export function icon(name, cls = 'icon') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `assets/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

/** @param {string} id */
export function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

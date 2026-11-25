// @ts-check
/**
 * Global error surface. Deliberately dependency-free (no imports) so it still
 * works when every other module fails to load.
 */

const ID = 'app-error-banner';

/** @type {((message: string, detail?: unknown) => void) | null} */
let sink = null;
/** @type {{ label: string, run: () => void } | null} */
let action = null;

/**
 * Register a logger that receives every shown error (e.g. the diagnostic log).
 * @param {(message: string, detail?: unknown) => void} fn
 */
export function setErrorSink(fn) {
  sink = fn;
}

/**
 * Register an extra button on the banner (e.g. "open diagnostic log").
 * @param {string} label
 * @param {() => void} run
 */
export function setBannerAction(label, run) {
  action = { label, run };
}

/**
 * Show a dismissible, plain-language error banner at the top of the page.
 * @param {string} message headline (Japanese, plain language)
 * @param {unknown} [detail] technical detail (Error / string), shown small
 */
export function showError(message, detail) {
  if (detail !== undefined) console.error(message, detail);
  try {
    sink?.(message, detail);
  } catch {
    /* logging must never break the banner */
  }
  try {
    const doc = globalThis.document;
    if (!doc?.body) return;
    let box = doc.getElementById(ID);
    if (!box) {
      box = doc.createElement('div');
      box.id = ID;
      box.setAttribute('role', 'alert');
      box.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;gap:12px;align-items:flex-start;padding:12px 16px;background:#b3261e;color:#fff;font:14px/1.5 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4)';
      const body = doc.createElement('div');
      body.className = 'banner-body';
      body.style.cssText = 'flex:1;min-width:0;word-break:break-word';
      const close = doc.createElement('button');
      close.type = 'button';
      close.textContent = '閉じる';
      close.style.cssText = 'flex:none;cursor:pointer;color:#fff;background:transparent;border:1px solid #fff;border-radius:4px;padding:2px 10px';
      close.addEventListener('click', () => box?.remove());
      box.append(body);
      if (action) {
        const act = action;
        const open = doc.createElement('button');
        open.type = 'button';
        open.textContent = act.label;
        open.style.cssText = close.style.cssText;
        open.addEventListener('click', () => {
          try {
            act.run();
          } catch {
            /* ignore */
          }
        });
        box.append(open);
      }
      box.append(close);
      doc.body.append(box);
    }
    const body = box.querySelector('.banner-body');
    if (!body) return;
    const item = doc.createElement('div');
    item.textContent = message;
    const d = describe(detail);
    if (d) {
      const small = doc.createElement('div');
      small.textContent = d;
      small.style.cssText = 'font-size:12px;opacity:.85';
      item.append(small);
    }
    body.append(item);
    // keep the banner short: at most 4 messages
    while (body.children.length > 4) body.firstElementChild?.remove();
  } catch {
    /* the error surface itself must never throw */
  }
}

/** @param {unknown} e */
function describe(e) {
  if (e === undefined || e === null || e === '') return '';
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Report uncaught errors / unhandled rejections in the banner. */
export function installGlobalErrorHandlers() {
  const w = globalThis.window;
  if (!w) return;
  w.addEventListener('error', (ev) => {
    if (/ResizeObserver loop/i.test(ev.message ?? '')) return;
    showError('予期しないエラーが発生しました。ページを再読み込みしても直らない場合は、別のブラウザでお試しください。', ev.error ?? ev.message);
  });
  w.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    if (r && typeof r === 'object' && /** @type {{name?: string}} */ (r).name === 'AbortError') return;
    showError('予期しないエラーが発生しました。', r);
  });
}

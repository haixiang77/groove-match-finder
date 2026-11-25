// @ts-check
import { diag } from '../diag-log.js';

const ID = 'diag-dialog';

/** @param {string} text */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} text */
function download(text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `refscope-diag-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Open (creating on first use) the diagnostic log dialog. Never throws. */
export function openDiagPanel() {
  try {
    let dlg = /** @type {HTMLDialogElement | null} */ (document.getElementById(ID));
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = ID;
      dlg.className = 'dialog';
      dlg.style.cssText = 'max-width:min(720px,95vw);width:100%';
      const title = document.createElement('h2');
      title.textContent = '診断ログ';
      const ta = document.createElement('textarea');
      ta.readOnly = true;
      ta.rows = 14;
      ta.style.cssText = 'width:100%;font:12px/1.4 monospace;box-sizing:border-box';
      ta.setAttribute('aria-label', '診断ログ');
      const status = document.createElement('p');
      status.setAttribute('role', 'status');
      const bar = document.createElement('div');
      bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
      /** @param {string} label @param {() => void | Promise<void>} fn */
      const btn = (label, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-ghost';
        b.textContent = label;
        b.addEventListener('click', () => {
          Promise.resolve(fn()).catch(() => {});
        });
        bar.append(b);
      };
      const refresh = () => {
        ta.value = diag.format() || '（ログはまだありません）';
      };
      btn('コピー', async () => {
        status.textContent = (await copyText(diag.format())) ? 'コピーしました。' : 'コピーできませんでした。テキストを選択してコピーしてください。';
      });
      btn('ダウンロード', () => download(diag.format()));
      btn('クリア', () => {
        diag.clear();
        refresh();
      });
      btn('閉じる', () => dlg?.close());
      dlg.append(title, ta, status, bar);
      dlg.addEventListener('refresh', refresh);
      document.body.append(dlg);
    }
    dlg.dispatchEvent(new Event('refresh'));
    if (!dlg.open) dlg.showModal();
  } catch {
    /* ignore */
  }
}

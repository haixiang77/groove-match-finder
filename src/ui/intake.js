// @ts-check
/**
 * File intake (file input + drag & drop). Dependency-free and attached before
 * anything else so that a failure elsewhere can never leave the page unable to
 * accept a file or make the browser navigate to a dropped audio file.
 */

const AUDIO_NAME = /\.(mp3|m4a|aac|wav|flac|ogg|opus|aiff?)$/i;

/** @param {File} f */
export function isAudioFile(f) {
  return f.type.startsWith('audio/') || AUDIO_NAME.test(f.name);
}

/**
 * URL paste form. Errors are shown inline only, so a bad link never touches
 * the file-input path.
 * @param {(url: string) => Promise<void>} onUrl rejects with a Japanese message on failure
 * @param {() => boolean} [isBusy]
 */
export function attachUrlIntake(onUrl, isBusy = () => false) {
  const form = document.getElementById('url-form');
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById('url-input'));
  const submit = /** @type {HTMLButtonElement | null} */ (document.getElementById('url-submit'));
  const errEl = document.getElementById('url-error');
  if (!form || !input) return;
  /** @param {string} msg */
  const setError = (msg) => {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.hidden = !msg;
  };
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (isBusy() || (submit && submit.disabled)) return;
    setError('');
    if (submit) {
      submit.disabled = true;
      submit.textContent = '読み込み中…';
    }
    try {
      await onUrl(input.value);
      input.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = '読み込む';
      }
    }
  });
}

/**
 * @param {(file: File) => void} onFile called with each accepted file
 * @param {() => boolean} [isBusy] drops are ignored while busy
 */
export function attachIntake(onFile, isBusy = () => false) {
  const doc = document;
  const input = /** @type {HTMLInputElement | null} */ (doc.getElementById('file-input'));
  const dropzone = doc.getElementById('dropzone');
  const changeFile = doc.getElementById('change-file');

  // Document-level preventDefault comes first: it is what stops the browser from opening a dropped file.
  for (const type of ['dragenter', 'dragover']) {
    doc.addEventListener(type, (ev) => {
      ev.preventDefault();
      dropzone?.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) doc.addEventListener(type, () => dropzone?.classList.remove('is-over'));
  doc.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const f = [...(/** @type {DragEvent} */ (ev).dataTransfer?.files ?? [])].find(isAudioFile);
    if (f && !isBusy()) onFile(f);
  });

  input?.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) onFile(f);
    // allow re-selecting the same file
    input.value = '';
  });
  dropzone?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      input?.click();
    }
  });
  changeFile?.addEventListener('click', () => input?.click());
}

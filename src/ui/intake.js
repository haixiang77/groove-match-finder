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

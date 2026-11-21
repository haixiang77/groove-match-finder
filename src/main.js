// @ts-check
/**
 * Entry point. Order matters:
 *   1. global error surface (banner)
 *   2. file intake (file input + drag & drop) — dependency-free, so it works
 *      even if the rest of the app fails to load or initialise
 *   3. the app itself, loaded dynamically so that a broken / stale module
 *      graph is reported instead of silently killing steps 1–2
 */
import { installGlobalErrorHandlers, showError } from './ui/banner.js';
import { attachIntake, attachUrlIntake } from './ui/intake.js';

installGlobalErrorHandlers();

/** @type {{ loadFile: (file: File) => Promise<void>, loadUrl: (url: string) => Promise<void>, isBusy: () => boolean, ready: boolean } | null} */
let app = null;
/** @type {File | null} */
let pending = null;
let failed = false;

/** @param {File} file */
function intake(file) {
  if (app?.ready) {
    app.loadFile(file).catch((err) => showError(`「${file.name}」を開けませんでした。`, err));
  } else if (failed || app) {
    showError('アプリの初期化に失敗したため、ファイルを読み込めません。ページを再読み込みしてください。');
  } else {
    pending = file; // app still loading; handled once ready
  }
}

try {
  attachIntake(intake, () => app?.isBusy() ?? false);
} catch (err) {
  showError('ファイル選択の準備に失敗しました。ページを再読み込みしてください。', err);
}

try {
  attachUrlIntake(
    async (url) => {
      if (!app) throw new Error('アプリを読み込み中です。少し待ってから再試行してください。');
      if (!app.ready) throw new Error('アプリの初期化に失敗したため、リンクを読み込めません。ページを再読み込みしてください。');
      await app.loadUrl(url);
    },
    () => app?.isBusy() ?? false,
  );
} catch (err) {
  showError('リンク入力の準備に失敗しました。ファイル入力は引き続き使えます。', err);
}

import('./app.js')
  .then((mod) => {
    app = mod.initApp();
    if (!app.ready) failed = true;
    if (pending) {
      const f = pending;
      pending = null;
      intake(f);
    }
  })
  .catch((err) => {
    failed = true;
    showError('アプリの読み込みに失敗しました。ページを再読み込み（Ctrl+Shift+R）してください。', err);
  });

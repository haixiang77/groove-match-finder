// @ts-check
/**
 * Entry point. Order matters:
 *   1. global error surface (banner)
 *   2. file intake (file input + drag & drop) — dependency-free, so it works
 *      even if the rest of the app fails to load or initialise
 *   3. the app itself, loaded dynamically so that a broken / stale module
 *      graph is reported instead of silently killing steps 1–2
 */
import { installGlobalErrorHandlers, showError, setErrorSink, setBannerAction } from './ui/banner.js';
import { attachIntake, attachUrlIntake } from './ui/intake.js';
import { diag } from './diag-log.js';
import { loadModuleWithRetry } from './load-retry.js';
import { APP_VERSION } from './version.js';

setErrorSink((message, detail) => diag.log('error', detail === undefined ? message : `${message} ${detail instanceof Error ? `${detail.name}: ${detail.message}` : String(detail)}`));
installGlobalErrorHandlers();
diag.log('boot', `RefScope v${APP_VERSION} ${globalThis.navigator?.userAgent ?? ''}`);

/** Open the diagnostic log dialog (panel is loaded lazily; failures are ignored). */
function openDiag() {
  import('./ui/diag-panel.js').then((m) => m.openDiagPanel()).catch(() => {});
}
setBannerAction('診断ログを開く', openDiag);
try {
  globalThis.document?.getElementById('diag-open')?.addEventListener('click', openDiag);
} catch {
  /* footer link is optional */
}

/**
 * Run an analysis action, recording start / end / failure in the diagnostic log.
 * @param {string} what
 * @param {() => Promise<void>} fn
 */
async function logged(what, fn) {
  diag.log('analysis', `${what} start`);
  try {
    await fn();
    diag.log('analysis', `${what} done`);
  } catch (err) {
    diag.log('analysis', `${what} failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    throw err;
  }
}

/** @type {{ loadFile: (file: File) => Promise<void>, loadUrl: (url: string) => Promise<void>, isBusy: () => boolean, ready: boolean } | null} */
let app = null;
/** @type {File | null} */
let pending = null;
let failed = false;

/** @param {File} file */
function intake(file) {
  if (app?.ready) {
    const a = app;
    logged(`file ${file.name}`, () => a.loadFile(file)).catch((err) => showError(`「${file.name}」を開けませんでした。`, err));
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
      const a = app;
      await logged(`url ${url}`, () => a.loadUrl(url));
    },
    () => app?.isBusy() ?? false,
  );
} catch (err) {
  showError('リンク入力の準備に失敗しました。ファイル入力は引き続き使えます。', err);
}

// Version label is non-critical: loaded separately so failures never block intake.
Promise.all([import('./ui/version-label.js'), import('./audio/analyzer.js')])
  .then(([v, a]) => v.renderVersion(a.ANALYSIS_VERSION))
  .catch(() => {});

loadModuleWithRetry({
  path: './app.js',
  version: APP_VERSION,
  importer: (url) => import(url),
  log: (ev, detail) => diag.log(ev, detail),
})
  .then((mod) => {
    const inst = mod.initApp();
    app = inst;
    diag.log('boot', `app initialised (ready=${inst.ready})`);
    if (!inst.ready) failed = true;
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

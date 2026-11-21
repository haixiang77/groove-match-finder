// @ts-check
/**
 * RefScope UI controller. `initApp()` is called from main.js after file intake
 * is already wired, and every init step is isolated so one failure is reported
 * (banner + console) instead of killing the rest.
 */
import { decodeToMono } from './audio/decode.js';
import { findEnergyWindow } from './audio/analyzer.js';
import { AnalysisPool } from './audio/worker-pool.js';
import { runPipeline } from './core/pipeline.js';
import { defaultSettings, loadSettings } from './settings.js';
import { showError } from './ui/banner.js';
import { errorMessage, formatTime, isAbortError, textSimilarity } from './util.js';
import { $, h, icon } from './ui/dom.js';
import { renderBandBalance, renderExplanation, renderGenres, renderHeatmap, renderIdentity, renderRejected, renderResultCard, renderStats } from './ui/render.js';
import { WaveformView } from './ui/waveform.js';
import { bindSettingsForm } from './ui/settings-panel.js';

/** @typedef {import('./types.js').AudioFeatures} AudioFeatures */
/** @typedef {import('./types.js').ScoredCandidate} ScoredCandidate */

const state = {
  settings: safeLoadSettings(),
  /** @type {File | null} */
  file: null,
  /** @type {{samples: Float32Array, sr: number} | null} */
  audio: null,
  region: { start: 0, end: 0 },
  /** @type {AbortController | null} */
  run: null,
  /** @type {AudioFeatures | null} */
  features: null,
  /** @type {import('./types.js').Identification | null} */
  identification: null,
  /** @type {import('./core/pipeline.js').GenreProfile | null} */
  genres: null,
  /** @type {ScoredCandidate[]} */
  scored: [],
  /** @type {ScoredCandidate[]} */
  ranked: [],
  /** @type {{name: string, detail: string}[]} */
  failed: [],
  /** @type {import('./services/gemini.js').GeminiExplanation | null} */
  explanation: null,
  /** @type {string | null} */
  objectUrl: null,
};

const pool = new AnalysisPool();

// ─────────────────────────────── elements ───────────────────────────────
/** Looked up once in an isolated init step (a missing element throws). */
function lookupElements() {
  return {
  dropSection: $('drop-section'),
  dropzone: $('dropzone'),
  fileInput: /** @type {HTMLInputElement} */ ($('file-input')),
  trackSection: $('track-section'),
  trackName: $('track-name'),
  trackMeta: $('track-meta'),
  regionLabel: $('region-label'),
  changeFile: $('change-file'),
  playRegion: /** @type {HTMLButtonElement} */ ($('play-region')),
  inputAudio: /** @type {HTMLAudioElement} */ ($('input-audio')),
  manualArtist: /** @type {HTMLInputElement} */ ($('manual-artist')),
  manualTitle: /** @type {HTMLInputElement} */ ($('manual-title')),
  localRefs: /** @type {HTMLInputElement} */ ($('local-refs')),
  runButton: /** @type {HTMLButtonElement} */ ($('run-button')),
  cancelButton: /** @type {HTMLButtonElement} */ ($('cancel-button')),
  pipelineSection: $('pipeline-section'),
  steps: $('steps'),
  log: $('log'),
  analysisSection: $('analysis-section'),
  stats: $('stats'),
  inputHeatmap: $('input-heatmap'),
  bandBalance: $('band-balance'),
  identity: $('identity'),
  genres: $('genres'),
  resultsSection: $('results-section'),
  results: $('results'),
  resultsCount: $('results-count'),
  rejectedWrap: $('rejected-wrap'),
  rejected: $('rejected'),
  rejectedCount: $('rejected-count'),
  exportJson: /** @type {HTMLButtonElement} */ ($('export-json')),
  explainSection: $('explain-section'),
  explain: $('explain'),
  keyStatus: $('key-status'),
  settingsForm: /** @type {HTMLFormElement} */ ($('settings-form')),
  };
}

/** @type {ReturnType<typeof lookupElements>} */
let els = /** @type {any} */ (null);
/** @type {WaveformView | null} */
let waveform = null;

/** @returns {import('./settings.js').Settings} */
function safeLoadSettings() {
  try {
    return loadSettings();
  } catch (err) {
    console.error(err);
    return defaultSettings();
  }
}

/**
 * Run one init step; a failure is logged and shown but never stops the others.
 * @param {string} label Japanese name of the feature, used in the banner
 * @param {() => void} fn
 * @returns {boolean} whether the step succeeded
 */
function guarded(label, fn) {
  try {
    fn();
    return true;
  } catch (err) {
    showError(`${label}の初期化に失敗しました。一部の機能が使えない可能性があります。`, err);
    return false;
  }
}

/**
 * Initialise the UI. File intake is wired by main.js beforehand and talks to
 * the returned handle.
 * @returns {{ loadFile: (file: File) => Promise<void>, isBusy: () => boolean, ready: boolean }}
 */
export function initApp() {
  const ok = guarded('画面要素の取得', () => {
    els = lookupElements();
  });
  if (ok) {
    guarded('波形表示', () => {
      waveform = new WaveformView(/** @type {HTMLCanvasElement} */ ($('waveform')), (start) => {
        const len = state.region.end - state.region.start;
        setRegion(start, start + len);
      });
    });
    guarded('設定画面', setupSettings);
    guarded('ダイアログ', setupDialogs);
    guarded('再生ボタン', setupPlayback);
    guarded('解析の実行', setupRun);
    guarded('結果の書き出し', setupExport);
  }
  return { loadFile, isBusy: () => state.run !== null, ready: ok };
}

// ──────────────────────────────── settings & dialogs ────────────────────────────────
function setupSettings() {
  bindSettingsForm(
    els.settingsForm,
    () => state.settings,
    (s) => {
      state.settings = s;
      updateKeyStatus();
      if (state.audio && !state.run) autoRegion();
    },
  );
  updateKeyStatus();
}

function setupDialogs() {
  document.querySelectorAll('[data-open]').forEach((btn) =>
    btn.addEventListener('click', () => /** @type {HTMLDialogElement} */ ($(/** @type {HTMLElement} */ (btn).dataset.open ?? '')).showModal()),
  );
  document.querySelectorAll('dialog [data-close]').forEach((btn) => btn.addEventListener('click', () => /** @type {HTMLDialogElement | null} */ (btn.closest('dialog'))?.close()));
  document.querySelectorAll('dialog').forEach((d) =>
    d.addEventListener('click', (ev) => {
      if (ev.target === d) d.close();
    }),
  );
}

function updateKeyStatus() {
  const s = state.settings;
  const n = [s.auddToken || (s.acrKey && s.acrSecret), s.lastfmKey, s.geminiKey].filter(Boolean).length;
  els.keyStatus.hidden = n === 0;
  els.keyStatus.title = `${n} 種類のAPIが設定済み`;
}

// ──────────────────────────────── file loading ────────────────────────────────
/** @param {File} file */
async function loadFile(file) {
  if (!els) throw new Error('アプリの初期化が完了していません');
  stopPlayback();
  state.file = file;
  els.dropSection.hidden = true;
  els.trackSection.hidden = false;
  els.trackName.textContent = file.name;
  els.trackMeta.textContent = 'デコード中…';
  els.trackMeta.style.color = '';
  els.trackMeta.style.fontWeight = '';
  els.runButton.disabled = true;
  try {
    const { samples, sr, duration } = await decodeToMono(await file.arrayBuffer());
    if (duration < 8) throw new Error('8秒以上の音声を選んでください');
    state.audio = { samples, sr };
    els.trackMeta.textContent = `${formatTime(duration)} · ${(file.size / 1024 / 1024).toFixed(1)} MB · ${file.type || '音声ファイル'}`;
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(file);
    els.inputAudio.src = state.objectUrl;
    waveform?.setAudio(samples, sr);
    autoRegion();
    els.runButton.disabled = false;
  } catch (err) {
    state.audio = null;
    els.trackMeta.textContent = `読み込みエラー: ${errorMessage(err)}`;
    els.trackMeta.style.color = 'var(--err, #d52d2d)';
    els.trackMeta.style.fontWeight = '600';
    showError(`「${file.name}」を読み込めませんでした。別のファイル（WAV / MP3 など、8秒以上）をお試しください。`, err);
  }
}

function autoRegion() {
  if (!state.audio) return;
  const { samples, sr } = state.audio;
  const w = findEnergyWindow(samples, sr, state.settings.analysisWindowSec);
  setRegion(w.start / sr, w.end / sr);
}

/** @param {number} start @param {number} end seconds */
function setRegion(start, end) {
  state.region = { start, end };
  waveform?.setRegion(start, end);
  els.regionLabel.textContent = `${formatTime(start)} – ${formatTime(end)}`;
}

// ─────────────────────────────── input playback ───────────────────────────────
function setupPlayback() {
els.playRegion.addEventListener('click', () => {
  if (!els.inputAudio.paused) return stopPlayback();
  els.inputAudio.currentTime = state.region.start;
  els.inputAudio.play().catch(() => {});
  setPlayButton(true);
});
els.inputAudio.addEventListener('timeupdate', () => {
  waveform?.setPlayhead(els.inputAudio.currentTime);
  if (els.inputAudio.currentTime >= state.region.end) stopPlayback();
});
els.inputAudio.addEventListener('pause', () => setPlayButton(false));
}

function stopPlayback() {
  els.inputAudio.pause();
  waveform?.setPlayhead(-1);
  setPlayButton(false);
}

/** @param {boolean} playing */
function setPlayButton(playing) {
  els.playRegion.replaceChildren(icon(playing ? 'pause' : 'play'), h('span', null, playing ? '停止' : '区間を再生'));
}

// ─────────────────────────────── run ───────────────────────────────
function setupRun() {
  els.runButton.addEventListener('click', () => startRun());
  els.cancelButton.addEventListener('click', () => state.run?.abort(new DOMException('Cancelled', 'AbortError')));
}

async function startRun() {
  if (!state.audio || !state.file || state.run) return;
  resetResults();
  const ctrl = new AbortController();
  state.run = ctrl;
  els.runButton.disabled = true;
  els.cancelButton.hidden = false;
  els.pipelineSection.hidden = false;
  els.pipelineSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const { samples, sr } = state.audio;
  try {
    await runPipeline({
      input: {
        samples,
        sr,
        fileName: state.file.name,
        region: { start: Math.floor(state.region.start * sr), end: Math.floor(state.region.end * sr) },
        manual: { artist: els.manualArtist.value, title: els.manualTitle.value },
        localRefs: [...(els.localRefs.files ?? [])],
      },
      settings: state.settings,
      signal: ctrl.signal,
      pool,
      hooks: {
        onStep: setStep,
        onLog: addLog,
        onInputFeatures: (f) => {
          state.features = f;
          els.analysisSection.hidden = false;
          els.stats.replaceChildren(...renderStats(f));
          els.inputHeatmap.replaceChildren(renderHeatmap(f.grid));
          els.bandBalance.replaceChildren(...renderBandBalance(f.spectral.bandBalance));
        },
        onIdentified: (id, soundDesign) => {
          state.identification = id;
          els.identity.replaceChildren(renderIdentity(id, soundDesign));
        },
        onGenres: (g) => {
          state.genres = g;
          if (state.features) els.genres.replaceChildren(renderGenres(state.features, g));
        },
        onCandidates: (c) => {
          els.resultsSection.hidden = false;
          els.resultsCount.textContent = `（候補 ${c.length} 件を波形検証中…）`;
          els.results.replaceChildren(...Array.from({ length: Math.min(3, c.length) }, () => h('div', { class: 'skeleton-card' })));
        },
        onScored: (r, cand, done, total, error) => {
          if (r) state.scored.push(r);
          else state.failed.push({ name: `${cand.artist} — ${cand.title}`, detail: error ?? '解析失敗' });
          els.resultsCount.textContent = `（波形検証 ${done} / ${total}）`;
          renderLiveResults();
        },
        onRanked: ({ ranked }) => {
          state.ranked = ranked;
          renderFinalResults();
        },
        onExplanation: (e) => {
          state.explanation = e;
          els.explainSection.hidden = false;
          els.explain.replaceChildren(renderExplanation(e));
          renderFinalResults();
        },
      },
    });
  } catch (err) {
    if (isAbortError(err)) addLog('キャンセルしました', 'warn');
    else {
      addLog(`エラー: ${errorMessage(err)}`, 'error');
      console.error(err);
    }
    els.steps.querySelectorAll('li[data-state="running"]').forEach((li) => li.setAttribute('data-state', 'error'));
    if (state.scored.length) {
      state.ranked = state.scored.filter((r) => r.passed).sort((a, b) => b.score - a.score).slice(0, state.settings.topN);
      renderFinalResults();
    }
  } finally {
    state.run = null;
    els.runButton.disabled = false;
    els.runButton.textContent = 'もう一度解析する';
    els.cancelButton.hidden = true;
    els.exportJson.disabled = !state.features;
  }
}

function resetResults() {
  Object.assign(state, { features: null, identification: null, genres: null, scored: [], ranked: [], failed: [], explanation: null });
  els.log.replaceChildren();
  els.steps.querySelectorAll('li').forEach((li) => {
    li.removeAttribute('data-state');
    const d = li.querySelector('.step-detail');
    if (d) d.textContent = '待機中';
  });
  for (const el of [els.stats, els.inputHeatmap, els.bandBalance, els.identity, els.genres, els.results, els.rejected, els.explain]) el.replaceChildren();
  els.analysisSection.hidden = true;
  els.resultsSection.hidden = true;
  els.explainSection.hidden = true;
  els.rejectedWrap.hidden = true;
  els.exportJson.disabled = true;
}

/** @param {import('./core/pipeline.js').StepId} step @param {import('./core/pipeline.js').StepState} st @param {string} [detail] */
function setStep(step, st, detail) {
  const li = els.steps.querySelector(`li[data-step="${step}"]`);
  if (!li) return;
  li.setAttribute('data-state', st);
  const d = li.querySelector('.step-detail');
  if (d) d.textContent = detail ?? { running: '実行中…', done: '完了', skipped: 'スキップ', error: 'エラー' }[st];
}

/** @param {string} msg @param {'info' | 'warn' | 'error'} [level] */
function addLog(msg, level = 'info') {
  const t = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  els.log.append(h('li', { class: level }, `[${t}] ${msg}`));
  els.log.scrollTop = els.log.scrollHeight;
  if (level === 'error') /** @type {HTMLDetailsElement} */ ($('log-details')).open = true;
}

/** Provisional ranking while previews are still being analysed. */
function renderLiveResults() {
  if (!state.features) return;
  const passing = state.scored.filter((r) => r.passed).sort((a, b) => b.score - a.score).slice(0, state.settings.topN);
  if (!passing.length) return;
  const order = passing.map((r) => r.candidate.key).join('|');
  if (order === els.results.dataset.order) return;
  els.results.dataset.order = order;
  const input = state.features;
  els.results.replaceChildren(...passing.map((r, i) => renderResultCard(r, i + 1, input, undefined)));
}

function renderFinalResults() {
  const input = state.features;
  if (!input) return;
  els.resultsSection.hidden = false;
  delete els.results.dataset.order;
  const ai = state.explanation?.matches ?? [];
  const cards = state.ranked.map((r, i) => {
    const match = ai.find((m) => textSimilarity(m.title, r.candidate.title) > 0.7 && textSimilarity(m.artist, r.candidate.artist) > 0.5);
    return renderResultCard(r, i + 1, input, match);
  });
  els.results.replaceChildren(
    ...(cards.length
      ? cards
      : [h('div', { class: 'card empty' }, 'しきい値を超える候補はありませんでした。設定で「合格しきい値」を下げるか、候補数を増やして再実行してください。')]),
  );
  els.resultsCount.textContent = `（合格 ${state.ranked.length} / 解析 ${state.scored.length}${state.failed.length ? ` / 取得失敗 ${state.failed.length}` : ''}）`;
  const rejected = [
    ...state.scored.filter((r) => !state.ranked.includes(r)).sort((a, b) => b.score - a.score).map((r) => ({ name: `${r.candidate.artist} — ${r.candidate.title}`, detail: `${Math.round(r.score * 100)}%  BPM ${r.features.bpm}` })),
    ...state.failed,
  ];
  els.rejectedWrap.hidden = rejected.length === 0;
  els.rejectedCount.textContent = `（${rejected.length}）`;
  els.rejected.replaceChildren(renderRejected(rejected));
  els.exportJson.disabled = false;
}

// ─────────────────────────────── export ───────────────────────────────
function setupExport() {
els.exportJson.addEventListener('click', () => {
  const { auddToken, acrKey, acrSecret, lastfmKey, geminiKey, ...safeSettings } = state.settings;
  void auddToken, acrKey, acrSecret, lastfmKey, geminiKey;
  const data = {
    generatedAt: new Date().toISOString(),
    app: 'RefScope',
    input: { file: state.file?.name, regionSec: state.region, identification: state.identification, features: state.features, genres: state.genres },
    results: state.ranked.map((r) => ({ ...r, candidate: { ...r.candidate, localFile: undefined } })),
    rejected: state.scored.filter((r) => !state.ranked.includes(r)).map((r) => ({ artist: r.candidate.artist, title: r.candidate.title, score: r.score, breakdown: r.breakdown })),
    failed: state.failed,
    explanation: state.explanation,
    settings: safeSettings,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `refscope-${(state.file?.name ?? 'result').replace(/\.[^.]+$/, '')}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});
}

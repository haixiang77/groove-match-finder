// @ts-check
/**
 * Server mode: when the page is served by the Python backend (`refscope serve`),
 * the heavy lifting (Shazam fingerprinting, librosa/SciPy analysis, preview
 * downloads without CORS limits) happens on the server. This module uploads
 * the selected region and replays the server's NDJSON progress events through
 * the same hooks the in-browser pipeline uses, so the UI is identical.
 */
import { encodeWav } from '../audio/decode.js';
import { AudioFeaturesSchema } from '../types.js';

/**
 * @typedef {Object} ServerInfo
 * @property {boolean} available
 * @property {string[]} providers
 * @property {boolean} auth
 * @property {string} version
 */

/** @returns {Promise<ServerInfo>} */
export async function detectServer() {
  const none = { available: false, providers: [], auth: false, version: '' };
  // GitHub Pages is static — no backend to probe (avoids a pointless 404).
  if (/\.github\.io$/i.test(location.hostname) || location.protocol === 'file:') return none;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch('api/health', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return none;
    const j = await res.json();
    if (!j || j.app !== 'refscope' || j.ok !== true) return none;
    return { available: true, providers: Array.isArray(j.providers) ? j.providers.map(String) : [], auth: Boolean(j.auth), version: String(j.version ?? '') };
  } catch {
    return none;
  }
}

/**
 * @param {{input: import('./pipeline.js').PipelineInput, settings: import('../settings.js').Settings,
 *   hooks: import('./pipeline.js').PipelineHooks, signal: AbortSignal}} ctx
 */
export async function runRemote(ctx) {
  const { input, settings, hooks, signal } = ctx;
  const region = input.samples.subarray(input.region.start, input.region.end);
  const form = new FormData();
  form.append('audio', encodeWav(region, input.sr), 'region.wav');
  form.append('file_name', input.fileName);
  form.append('artist', input.manual.artist);
  form.append('title', input.manual.title);
  form.append(
    'options',
    JSON.stringify({
      country: settings.country,
      poolSize: settings.poolSize,
      topN: settings.topN,
      minScore: settings.minScore,
      analysisWindowSec: settings.analysisWindowSec,
      useGeminiSuggestions: settings.useGeminiSuggestions,
      geminiAudioInExplain: settings.geminiAudioInExplain,
      weights: settings.weights,
    }),
  );
  for (const f of input.localRefs) form.append('local_refs', f, f.name);
  hooks.onStep('identify', 'running', 'サーバーへ送信中…');

  /** @type {Record<string, string>} */
  const headers = {};
  if (settings.serverToken) headers['X-RefScope-Token'] = settings.serverToken;
  const res = await fetch('api/analyze', { method: 'POST', body: form, headers, signal });
  if (res.status === 401) throw new Error('サーバーのアクセストークンが違います（設定 → サーバー）');
  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = (await res.json()).detail ?? '';
    } catch {
      /* ignore */
    }
    throw new Error(`サーバーエラー HTTP ${res.status} ${detail}`);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let finished = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) finished = dispatch(JSON.parse(line), hooks) || finished;
    }
  }
  if (!finished) throw new Error('サーバーとの接続が途中で切れました');
}

/**
 * @param {any} ev
 * @param {import('./pipeline.js').PipelineHooks} hooks
 * @returns {boolean} true when the run finished
 */
function dispatch(ev, hooks) {
  switch (ev.type) {
    case 'step':
      hooks.onStep(ev.step, ev.state, ev.detail ?? undefined);
      break;
    case 'log':
      hooks.onLog(String(ev.message), ev.level);
      break;
    case 'input_features':
      hooks.onInputFeatures(/** @type {any} */ (AudioFeaturesSchema.parse(ev.features)));
      break;
    case 'identified':
      hooks.onIdentified(ev.identification ?? null, ev.soundDesign ?? undefined);
      break;
    case 'genres':
      hooks.onGenres(ev.genres);
      break;
    case 'candidates':
      hooks.onCandidates(ev.candidates);
      break;
    case 'scored':
      hooks.onScored(ev.result ? { ...ev.result, features: AudioFeaturesSchema.parse(ev.result.features) } : null, ev.candidate, ev.done, ev.total, ev.error ?? undefined);
      break;
    case 'ranked':
      hooks.onRanked({ ranked: ev.ranked, rejected: ev.rejected, failed: ev.failed });
      break;
    case 'explanation':
      hooks.onExplanation(ev.explanation);
      break;
    case 'error':
      throw new Error(String(ev.message));
    case 'done':
      return true;
  }
  return false;
}

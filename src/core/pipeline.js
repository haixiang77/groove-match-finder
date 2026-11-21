// @ts-check
/**
 * The RefScope hybrid pipeline:
 *
 *   Step 1  Identify (fingerprint → Gemini → filename) ‖ physical feature extraction
 *   Step 2  Candidate pool expansion (Last.fm / MusicBrainz / iTunes / ontology / Gemini)
 *   Step 3  Waveform filtering: download 30 s previews, run the same DSP, score & rank
 *   Step 4  Explanation (Gemini, grounded in the DSP numbers) — optional
 *
 * Every external dependency is optional and failures degrade gracefully: with
 * no API keys at all the app still works via iTunes + MusicBrainz + ontology.
 */
import { decodeToMono, encodeWav, blobToBase64 } from '../audio/decode.js';
import { findEnergyWindow } from '../audio/analyzer.js';
import { CandidatePool } from './candidates.js';
import { rerank } from './rerank.js';
import { compareFeatures } from './similarity.js';
import { expandGenres, genreLabel, genreSearchTerm, GENRE_BY_ID, skeletonGenres, tagsToGenres } from './ontology.js';
import { identifyWithACRCloud, identifyWithAudD } from '../services/fingerprint.js';
import { explainMatches, identifyWithGemini } from '../services/gemini.js';
import * as lastfm from '../services/lastfm.js';
import { getRecordingTags } from '../services/musicbrainz.js';
import { resolveTrack, searchSongs, toCandidate } from '../services/itunes.js';
import { fetchCorsAware, NetworkError } from '../services/http.js';
import { errorMessage, isAbortError, mapPool, parseFileName, trackKey } from '../util.js';

/** @typedef {import('../types.js').AudioFeatures} AudioFeatures */
/** @typedef {import('../types.js').Candidate} Candidate */
/** @typedef {import('../types.js').Identification} Identification */
/** @typedef {import('../types.js').ScoredCandidate} ScoredCandidate */
/** @typedef {import('../settings.js').Settings} Settings */
/** @typedef {'identify' | 'expand' | 'filter' | 'explain'} StepId */
/** @typedef {'running' | 'done' | 'skipped' | 'error'} StepState */

/**
 * @typedef {Object} GenreProfile
 * @property {{id: string, score: number}[]} skeleton   physical (DSP) genre guesses
 * @property {{id: string, weight: number}[]} tagged    metadata-derived genres
 * @property {{name: string, weight: number, source: string}[]} tags
 * @property {{id: string, weight: number, relation: string, via: string}[]} expanded
 * @property {string} hybridLabel
 */

/**
 * @typedef {Object} PipelineHooks
 * @property {(step: StepId, state: StepState, detail?: string) => void} onStep
 * @property {(msg: string, level?: 'info' | 'warn' | 'error') => void} onLog
 * @property {(f: AudioFeatures) => void} onInputFeatures
 * @property {(id: Identification | null, soundDesign?: string) => void} onIdentified
 * @property {(g: GenreProfile) => void} onGenres
 * @property {(c: Candidate[]) => void} onCandidates
 * @property {(r: ScoredCandidate | null, c: Candidate, done: number, total: number, error?: string) => void} onScored
 * @property {(r: {ranked: ScoredCandidate[], rejected: ScoredCandidate[], failed: number}) => void} onRanked
 * @property {(e: import('../services/gemini.js').GeminiExplanation) => void} onExplanation
 */

/**
 * @typedef {Object} PipelineInput
 * @property {Float32Array} samples  full decoded track (mono, `sr`)
 * @property {number} sr
 * @property {string} fileName
 * @property {{start: number, end: number}} region  analysis window (samples)
 * @property {{artist: string, title: string}} manual
 * @property {File[]} localRefs
 */

/** previewUrl → features cache shared across runs */
const featureCache = new Map();

/**
 * @param {{input: PipelineInput, settings: Settings, hooks: PipelineHooks, signal: AbortSignal,
 *   pool: import('../audio/worker-pool.js').AnalysisPool}} ctx
 */
export async function runPipeline(ctx) {
  const { input, settings, hooks, signal, pool } = ctx;
  const log = hooks.onLog;
  let lastWaitLog = 0;
  const itunesOpts = {
    country: settings.country,
    proxy: settings.corsProxy,
    signal,
    // Max iTunes network searches per run (cache / duplicate hits are free).
    budget: { left: 40 },
    // Consecutive waits are logged once, not on every queued request.
    onWait: (/** @type {number} */ ms) => {
      if (ms <= 1500 || Date.now() - lastWaitLog < 30000) return;
      lastWaitLog = Date.now();
      log(`iTunes APIのレート制限のため待機中（約 ${Math.ceil(ms / 1000)} 秒ずつ）…`);
    },
  };

  // ───────────────────────── Step 1: identify ‖ analyse ─────────────────────────
  hooks.onStep('identify', 'running', '指紋照合と波形解析を並行実行中');
  const region = input.samples.slice(input.region.start, input.region.end);
  const mid = Math.floor(region.length / 2);
  const excerpt = (/** @type {number} */ sec) =>
    encodeWav(region.subarray(Math.max(0, mid - (sec / 2) * input.sr), Math.min(region.length, mid + (sec / 2) * input.sr)), input.sr);

  const featuresPromise = pool.analyze(region.slice(), input.sr);
  featuresPromise.then(hooks.onInputFeatures, () => {});

  /** @type {Identification | null} */
  let identified = null;
  if (input.manual.artist.trim() && input.manual.title.trim()) {
    identified = { artist: input.manual.artist.trim(), title: input.manual.title.trim(), source: 'manual', confidence: 1 };
    log(`手動入力の曲名を使用: ${identified.artist} — ${identified.title}`);
  }
  if (!identified && settings.auddToken) {
    try {
      log('AudD で音声指紋を照合中…');
      identified = await identifyWithAudD(excerpt(12), { token: settings.auddToken, proxy: settings.corsProxy, signal });
      log(identified ? `AudD: ${identified.artist} — ${identified.title}` : 'AudD: 一致する曲は見つかりませんでした', identified ? 'info' : 'warn');
    } catch (err) {
      if (isAbortError(err)) throw err;
      log(`AudD 照合に失敗: ${errorMessage(err)}`, 'warn');
    }
  }
  if (!identified && settings.acrKey && settings.acrSecret && settings.acrHost) {
    try {
      log('ACRCloud で音声指紋を照合中…');
      identified = await identifyWithACRCloud(excerpt(12), { host: settings.acrHost, accessKey: settings.acrKey, accessSecret: settings.acrSecret, proxy: settings.corsProxy, signal });
      log(identified ? `ACRCloud: ${identified.artist} — ${identified.title}` : 'ACRCloud: 一致する曲は見つかりませんでした', identified ? 'info' : 'warn');
    } catch (err) {
      if (isAbortError(err)) throw err;
      log(`ACRCloud 照合に失敗: ${errorMessage(err)}`, 'warn');
    }
  }

  /** @type {AudioFeatures} */
  let features;
  try {
    features = await featuresPromise;
  } catch (err) {
    hooks.onStep('identify', 'error', errorMessage(err));
    throw err;
  }
  log(`波形解析完了: BPM ${features.bpm} / ${features.key.name} / スウィング ${features.groove.swing}%`);

  /** @type {import('../services/gemini.js').GeminiIdentify | null} */
  let gemini = null;
  if (settings.geminiKey && (!identified || settings.useGeminiSuggestions)) {
    try {
      log(identified ? 'Gemini でサウンド特徴とリファレンス候補を取得中…' : '指紋照合なし → Gemini マルチモーダル推論にフォールバック…');
      gemini = await identifyWithGemini({ apiKey: settings.geminiKey, model: settings.geminiModel, wavBase64: await blobToBase64(excerpt(20)), features, signal });
      if (!identified && gemini.recognized && gemini.title && gemini.artist && gemini.confidence >= 0.6) {
        identified = { artist: gemini.artist, title: gemini.title, source: 'gemini', confidence: gemini.confidence * 0.8, genreTags: gemini.genre_tags, soundDesign: gemini.sound_design };
        log(`Gemini 推定: ${identified.artist} — ${identified.title}（確信度 ${Math.round(gemini.confidence * 100)}%）`);
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      log(`Gemini 推論に失敗: ${errorMessage(err)}`, 'warn');
    }
  }
  if (!identified) {
    const guess = parseFileName(input.fileName);
    if (guess) {
      identified = { ...guess, source: 'filename', confidence: 0.3 };
      log(`ファイル名から推定: ${guess.artist} — ${guess.title}（要確認）`, 'warn');
    }
  }
  hooks.onIdentified(identified, gemini?.sound_design);
  hooks.onStep('identify', 'done', identified ? `${identified.artist} — ${identified.title}` : '曲名不明（未発表曲・デモとして解析）');
  signal.throwIfAborted();

  // ───────────────────────── Step 2: candidate pool expansion ─────────────────────────
  hooks.onStep('expand', 'running', 'メタデータと類似ネットワークを収集中');
  /** @type {{name: string, weight: number, source: string}[]} */
  const tags = [];
  const exclude = identified ? [trackKey(identified.artist, identified.title)] : [];
  const cpool = new CandidatePool(exclude);

  /** @type {import('../services/itunes.js').ItunesTrack | null} */
  let selfItunes = null;
  if (identified) {
    try {
      selfItunes = await resolveTrack(identified.artist, identified.title, itunesOpts);
      if (selfItunes) {
        exclude.push(trackKey(selfItunes.artistName, selfItunes.trackName));
        cpool.exclude.add(trackKey(selfItunes.artistName, selfItunes.trackName));
        if (selfItunes.primaryGenreName) tags.push({ name: selfItunes.primaryGenreName, weight: 0.5, source: 'iTunes' });
        if (identified.source === 'filename') identified.confidence = 0.6;
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      log(`iTunes で入力曲を照合できませんでした: ${errorMessage(err)}`, 'warn');
    }
  }
  for (const t of identified?.genreTags ?? []) tags.push({ name: t, weight: 0.9, source: identified?.source ?? '' });
  for (const [i, t] of (gemini?.genre_tags ?? []).entries()) tags.push({ name: t, weight: 0.9 - i * 0.1, source: 'Gemini' });

  const useLastfm = Boolean(settings.lastfmKey && identified);
  if (useLastfm && identified) {
    const id = identified;
    try {
      let lfTags = await lastfm.getTrackTags(id.artist, id.title, settings.lastfmKey, signal);
      if (lfTags.length < 3) lfTags = [...lfTags, ...(await lastfm.getArtistTags(id.artist, settings.lastfmKey, signal))];
      for (const t of lfTags) tags.push({ ...t, source: 'Last.fm' });

      const similar = await lastfm.getSimilarTracks(id.artist, id.title, settings.lastfmKey, signal);
      for (const t of similar) cpool.add({ key: trackKey(t.artist, t.title), artist: t.artist, title: t.title, sources: ['Last.fm 類似曲'], weight: 0.6 + 0.8 * t.match });
      log(`Last.fm 類似曲: ${similar.length} 件`);

      const artists = (await lastfm.getSimilarArtists(id.artist, settings.lastfmKey, signal)).slice(0, 5);
      const tops = await mapPool(artists, 3, (a) => lastfm.getArtistTopTracks(a.name, settings.lastfmKey, signal, 3), signal);
      tops.forEach((r, i) => {
        if (!r.ok) return;
        for (const t of r.value) cpool.add({ key: trackKey(t.artist, t.title), artist: t.artist, title: t.title, sources: ['Last.fm 類似アーティスト'], weight: 0.3 + 0.5 * artists[i].match });
      });
      log(`Last.fm 類似アーティスト: ${artists.map((a) => a.name).join(', ') || 'なし'}`);
    } catch (err) {
      if (isAbortError(err)) throw err;
      log(`Last.fm 取得に失敗: ${errorMessage(err)}`, 'warn');
    }
  } else if (!settings.lastfmKey) log('Last.fm APIキー未設定 → iTunes / MusicBrainz / ジャンル系統樹で候補を収集します');

  if (identified && tags.filter((t) => t.source === 'Last.fm').length < 3) {
    try {
      const mb = await getRecordingTags({ artist: identified.artist, title: identified.title, isrc: identified.isrc ?? selfItunes?.isrc }, signal);
      for (const t of mb) tags.push({ ...t, source: 'MusicBrainz' });
      if (mb.length) log(`MusicBrainz タグ: ${mb.slice(0, 6).map((t) => t.name).join(', ')}`);
    } catch (err) {
      if (isAbortError(err)) throw err;
      log(`MusicBrainz 取得に失敗: ${errorMessage(err)}`, 'warn');
    }
  }

  // Genre profile: metadata tags × physical skeleton, expanded through the ontology.
  const tagged = [...tagsToGenres(tags)].sort((a, b) => b[1] - a[1]);
  const tagMax = tagged[0]?.[1] ?? 1;
  const skeleton = skeletonGenres(features).slice(0, 5);
  /** @type {Map<string, number>} */
  const seeds = new Map();
  for (const [id, w] of tagged.slice(0, 5)) seeds.set(id, w / tagMax);
  for (const g of skeleton.slice(0, 3)) seeds.set(g.id, Math.max(seeds.get(g.id) ?? 0, 0.8 * g.score));
  const expanded = [...expandGenres(seeds)].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.weight - a.weight);
  const topSkeleton = skeleton[0]?.id;
  const topTag = tagged[0]?.[0];
  const hybridLabel =
    topSkeleton && topTag && topSkeleton !== topTag
      ? `${genreLabel(topSkeleton)}の骨格 × ${genreLabel(topTag)}`
      : genreLabel(topTag ?? topSkeleton ?? 'pop');
  hooks.onGenres({ skeleton: skeleton.map((g) => ({ id: g.id, score: g.score })), tagged: tagged.map(([id, weight]) => ({ id, weight: weight / tagMax })), tags, expanded, hybridLabel });

  // Last.fm tag charts for the most specific genres.
  if (useLastfm) {
    const specific = expanded.filter((g) => g.relation === 'seed' && (GENRE_BY_ID.get(g.id)?.parents.length ?? 0) > 0).slice(0, 2);
    const res = await mapPool(specific, 2, (g) => lastfm.getTagTopTracks(GENRE_BY_ID.get(g.id)?.en.toLowerCase() ?? g.id, settings.lastfmKey, signal, 12), signal);
    res.forEach((r, i) => {
      if (!r.ok) return;
      for (const t of r.value) cpool.add({ key: trackKey(t.artist, t.title), artist: t.artist, title: t.title, sources: [`Last.fm タグ: ${genreLabel(specific[i].id)}`], weight: 0.35 * specific[i].weight });
    });
  }

  // Gemini's suggestions are only candidates — the waveform filter decides.
  if (gemini && settings.useGeminiSuggestions) {
    for (const t of gemini.suggested_references) cpool.add({ key: trackKey(t.artist, t.title), artist: t.artist, title: t.title, sources: ['Gemini 提案'], weight: 0.7 });
    if (gemini.suggested_references.length) log(`Gemini 提案: ${gemini.suggested_references.length} 件（波形フィルタで検証します）`);
  }

  // iTunes: same artist + ontology genre searches (these already carry previews).
  const genreQueries = expanded.slice(0, useLastfm ? 2 : 4);
  /** @type {{term: string, weight: number, label: string, attribute?: string}[]} */
  const itunesQueries = genreQueries.map((g) => ({ term: genreSearchTerm(g.id), weight: 0.45 * g.weight, label: `系統樹: ${genreLabel(g.id)}（${relationJa(g.relation)}）` }));
  if (identified) itunesQueries.unshift({ term: identified.artist, weight: 0.4, label: '同一アーティスト', attribute: 'artistTerm' });
  for (const q of itunesQueries) {
    try {
      const results = await searchSongs(q.term, { ...itunesOpts, limit: 12, attribute: q.attribute });
      for (const r of results) if (r.previewUrl) cpool.add(toCandidate(r, `iTunes ${q.label}`, q.weight));
    } catch (err) {
      if (isAbortError(err)) throw err;
      log(`iTunes 検索「${q.term}」に失敗: ${errorMessage(err)}`, 'warn');
    }
  }

  // Local reference files dropped by the user.
  for (const f of input.localRefs) {
    const meta = parseFileName(f.name) ?? { artist: 'ローカル', title: f.name.replace(/\.[^.]+$/, '') };
    cpool.add({ key: `local|${f.name}|${f.size}`, artist: meta.artist, title: meta.title, sources: ['ローカルファイル'], weight: 10, localFile: f });
  }

  const shortlist = cpool.shortlist(settings.poolSize);
  hooks.onCandidates(shortlist);
  hooks.onStep('expand', shortlist.length ? 'done' : 'error', `${cpool.size} 件収集 → ${shortlist.length} 件を波形検証へ`);
  if (!shortlist.length) {
    hooks.onRanked({ ranked: [], rejected: [], failed: 0 });
    hooks.onStep('filter', 'skipped');
    hooks.onStep('explain', 'skipped');
    return;
  }
  signal.throwIfAborted();

  // ───────────────────────── Step 3: waveform filtering ─────────────────────────
  hooks.onStep('filter', 'running', `0 / ${shortlist.length}`);
  /** @type {ScoredCandidate[]} */
  const scored = [];
  let done = 0;
  let failed = 0;
  let corsBlocked = 0;
  /** @type {Set<number>} */
  const seenItunes = new Set(shortlist.flatMap((c) => (c.itunesId ? [c.itunesId] : [])));
  await mapPool(
    shortlist,
    3,
    async (cand) => {
      try {
        if (!cand.previewUrl && !cand.localFile) {
          const t = await resolveTrack(cand.artist, cand.title, itunesOpts);
          if (!t?.previewUrl) throw new Error('iTunes にプレビュー音源なし');
          if (seenItunes.has(t.trackId)) throw new Error('他の候補と同一曲のためスキップ');
          seenItunes.add(t.trackId);
          const resolved = toCandidate(t, cand.sources[0], cand.weight);
          Object.assign(cand, { ...resolved, sources: cand.sources, weight: cand.weight, key: cand.key });
          if (exclude.includes(trackKey(t.artistName, t.trackName))) throw new Error('入力曲と同一のため除外');
        }
        const feats = await analyseCandidate(cand, settings.corsProxy, signal, pool);
        const cmp = compareFeatures(features, feats, settings.weights);
        /** @type {ScoredCandidate} */
        const sc = { candidate: cand, features: feats, ...cmp, passed: cmp.score >= settings.minScore };
        scored.push(sc);
        hooks.onScored(sc, cand, ++done, shortlist.length);
      } catch (err) {
        if (isAbortError(err)) throw err;
        failed++;
        if (err instanceof NetworkError) corsBlocked++;
        hooks.onScored(null, cand, ++done, shortlist.length, errorMessage(err));
      }
      hooks.onStep('filter', 'running', `${done} / ${shortlist.length}`);
    },
    signal,
  );
  if (corsBlocked > 0 && corsBlocked >= shortlist.length / 2 && !settings.corsProxy)
    log('プレビュー音源の取得がブラウザ (CORS) にブロックされました。設定で CORS プロキシ（README 参照）を指定してください。', 'error');

  scored.sort((a, b) => b.score - a.score);
  // Diversity + lineage: dampen same-artist runs, favour the input's genre family.
  const reordered = rerank(scored, new Set(expanded.map((g) => g.id)), { minScore: settings.minScore });
  const dampened = reordered.filter((r) => (r.artistFactor ?? 1) < 1).length;
  const boosted = reordered.filter((r) => (r.lineageBoost ?? 1) > 1).length;
  log(`順位補正: 同一アーティスト減点 ${dampened} 件 / ジャンル系統加点 ${boosted} 件`);
  const ranked = reordered.filter((r) => r.passed).slice(0, settings.topN);
  const rejected = reordered.filter((r) => !ranked.includes(r));
  hooks.onRanked({ ranked, rejected, failed });
  hooks.onStep('filter', 'done', `${scored.length} 件解析 → ${ranked.length} 件が合格（しきい値 ${Math.round(settings.minScore * 100)}%）`);
  signal.throwIfAborted();

  // ───────────────────────── Step 4: explanation ─────────────────────────
  if (!settings.geminiKey || !ranked.length) {
    hooks.onStep('explain', 'skipped', settings.geminiKey ? '合格曲なし' : 'Gemini APIキー未設定（ルールベースの解説のみ表示）');
    return;
  }
  hooks.onStep('explain', 'running', 'Gemini が技術的な解説を生成中');
  try {
    const explanation = await explainMatches({
      apiKey: settings.geminiKey,
      model: settings.geminiModel,
      input: {
        label: identified ? `${identified.artist} — ${identified.title}` : input.fileName,
        features,
        genres: [hybridLabel, ...skeleton.slice(0, 3).map((g) => genreLabel(g.id))],
      },
      matches: ranked.slice(0, 6).map((r) => ({ title: r.candidate.title, artist: r.candidate.artist, score: r.score, features: r.features, reasons: r.reasons })),
      wavBase64: settings.geminiAudioInExplain ? await blobToBase64(excerpt(15)) : undefined,
      signal,
    });
    hooks.onExplanation(explanation);
    hooks.onStep('explain', 'done');
  } catch (err) {
    if (isAbortError(err)) throw err;
    hooks.onStep('explain', 'error', errorMessage(err));
  }
}

/**
 * Download (or read) a candidate's audio and analyse it, with caching.
 * @param {Candidate} cand
 * @param {string} proxy
 * @param {AbortSignal} signal
 * @param {import('../audio/worker-pool.js').AnalysisPool} pool
 * @returns {Promise<AudioFeatures>}
 */
async function analyseCandidate(cand, proxy, signal, pool) {
  const cacheKey = cand.localFile ? `local:${cand.key}` : cand.previewUrl ?? '';
  const hit = featureCache.get(cacheKey);
  if (hit) return hit;
  /** @type {ArrayBuffer} */
  let data;
  if (cand.localFile) data = await cand.localFile.arrayBuffer();
  else {
    const res = await fetchCorsAware(/** @type {string} */ (cand.previewUrl), proxy, { signal, timeoutMs: 30000 });
    if (!res.ok) throw new Error(`プレビュー取得失敗 HTTP ${res.status}`);
    data = await res.arrayBuffer();
  }
  const { samples, sr } = await decodeToMono(data);
  let clip = samples;
  if (cand.localFile) {
    const w = findEnergyWindow(samples, sr, 30);
    clip = samples.slice(w.start, w.end);
  }
  const f = await pool.analyze(clip, sr);
  featureCache.set(cacheKey, f);
  return f;
}

/** @param {string} rel */
function relationJa(rel) {
  return { seed: '中心', derivative: '派生', parent: '親', sibling: '兄弟', influence: '影響元', influenced: '影響先' }[rel] ?? rel;
}

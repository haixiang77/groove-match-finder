// @ts-check
/**
 * Pure render functions: data in → DOM out.
 */
import { BALANCE_BANDS } from '../types.js';
import { TRAIT_LABELS } from '../core/similarity.js';
import { GENRE_BY_ID, genreLabel, lineage } from '../core/ontology.js';
import { h, icon } from './dom.js';

/** @typedef {import('../types.js').AudioFeatures} AudioFeatures */
/** @typedef {import('../types.js').ScoredCandidate} ScoredCandidate */

const BAND_META = /** @type {const} */ ([
  ['kick', 'Kick', 'var(--kick)'],
  ['snare', 'Snare', 'var(--snare)'],
  ['hat', 'Hi-Hat', 'var(--hat)'],
]);

/** @param {number} v */
const pct = (v) => `${Math.round(v * 100)}`;

/**
 * @param {string} label @param {string} value @param {string} [sub]
 */
function stat(label, value, sub) {
  return h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, label), h('span', { class: 'stat-value', title: value }, value), sub ? h('span', { class: 'stat-sub' }, sub) : null);
}

/** @param {AudioFeatures} f */
export function renderStats(f) {
  const alt = f.bpmCandidates.filter((b) => Math.abs(b - f.bpm) / f.bpm > 0.05).slice(0, 2);
  return [
    stat('BPM', String(f.bpm), alt.length ? `候補 ${alt.join(' / ')}` : `信頼度 ${pct(f.bpmConfidence)}%`),
    stat('Key', f.key.name.replace(' major', '').replace(' minor', 'm'), `Camelot ${f.key.camelot} · ${pct(f.key.confidence)}%`),
    stat('Swing', `${f.groove.swing}%`, f.groove.swingConfidence > 0.15 ? `${f.groove.swingUnit}分音符` : '判定不可'),
    stat('Sidechain', `${f.groove.sidechainDb} dB`, f.groove.sidechainDb >= 2 ? 'ポンピングあり' : 'ほぼなし'),
    stat('808 Sustain', pct(f.groove.subSustain), f.groove.subSustain >= 0.45 ? 'ロングサブ' : 'タイトな低域'),
    stat('Crest', `${f.spectral.crestDb.toFixed(1)} dB`, f.spectral.crestDb < 10 ? '高密度マスタリング' : 'ダイナミック'),
    stat('Centroid', `${(f.spectral.centroidHz / 1000).toFixed(2)} kHz`, '音の明るさ'),
    stat('Hat Density', pct(f.groove.hatDensity), '16ステップ中'),
  ];
}

/**
 * Full-size 3×16 heatmap.
 * @param {import('../types.js').RhythmGrid} grid
 */
export function renderHeatmap(grid) {
  const cells = [h('span', { class: 'hm-label' }, '')];
  for (let i = 0; i < 16; i++) cells.push(h('span', { class: 'hm-head' }, i % 4 === 0 ? String(i / 4 + 1) : '·'));
  for (const [band, label, color] of BAND_META) {
    cells.push(h('span', { class: 'hm-label' }, label));
    grid[band].forEach((v, i) =>
      cells.push(h('span', { class: `hm-cell${i % 4 === 0 ? ' beat' : ''}`, title: `${label} step ${i + 1}: ${pct(v)}%`, '--c': color, '--v': (0.08 + 0.92 * v).toFixed(2) }, h('i', null))),
    );
  }
  return h('div', { class: 'heatmap', role: 'img', 'aria-label': '16ステップのドラム打点ヒートマップ' }, cells);
}

/**
 * Compact comparison heatmap (input row above candidate row per band).
 * @param {import('../types.js').RhythmGrid} a input
 * @param {import('../types.js').RhythmGrid} b candidate
 * @param {number} shift rotation applied to the candidate for best alignment
 */
export function renderCompareHeatmap(a, b, shift) {
  /** @param {number[]} g */
  const rot = (g) => g.map((_, i) => g[(i + shift) % 16]);
  /** @type {HTMLElement[]} */
  const cells = [];
  BAND_META.forEach(([band, label, color], idx) => {
    if (idx) cells.push(h('span', { class: 'hm-gap' }));
    for (const [rowLabel, g, c] of /** @type {[string, number[], string][]} */ ([
      [`${label}`, a[band], 'var(--input)'],
      ['', rot(b[band]), color],
    ])) {
      cells.push(h('span', { class: 'hm-label' }, rowLabel));
      g.forEach((v, i) => cells.push(h('span', { class: `hm-cell${i % 4 === 0 ? ' beat' : ''}`, '--c': c, '--v': (0.06 + 0.94 * v).toFixed(2) }, h('i', null))));
    }
  });
  return h(
    'div',
    null,
    h('div', { class: 'hm-legend' }, h('span', null, h('i', { style: { background: 'var(--input)' } }), '入力曲'), h('span', null, h('i', { style: { background: 'var(--kick)' } }), '候補曲')),
    h('div', { class: 'heatmap compact', role: 'img', 'aria-label': '入力曲と候補曲のドラム配置比較' }, cells),
  );
}

/** @param {number[]} balance */
export function renderBandBalance(balance) {
  const min = -40;
  return BALANCE_BANDS.map((b, i) => {
    const v = balance[i];
    const w = Math.max(2, Math.min(100, ((v - min) / -min) * 100));
    return h('div', { class: 'bb-row' }, h('span', null, b.label), h('div', { class: 'bb-track' }, h('div', { class: 'bb-fill', style: { width: `${w}%` } })), h('span', { class: 'bb-val' }, `${v.toFixed(1)} dB`));
  });
}

const SOURCE_LABEL = { manual: '手動入力', shazam: 'Shazam 指紋照合', audd: 'AudD 指紋照合', acrcloud: 'ACRCloud 指紋照合', gemini: 'Gemini 聴取推論', filename: 'ファイル名から推定' };

/**
 * @param {import('../types.js').Identification | null} id
 * @param {string} [soundDesign]
 */
export function renderIdentity(id, soundDesign) {
  return h(
    'div',
    { class: 'identity' },
    id
      ? [h('span', { class: 'source-pill' }, SOURCE_LABEL[id.source]), h('span', { class: 'id-title' }, id.title), h('span', { class: 'muted' }, id.artist), id.isrc ? h('span', { class: 'muted small' }, `ISRC ${id.isrc}`) : null]
      : [h('span', { class: 'source-pill' }, '未同定'), h('span', { class: 'id-title' }, '曲名は特定できませんでした'), h('span', { class: 'muted small' }, '未発表曲・デモとして、波形の特徴と系統樹から候補を探します。')],
    soundDesign ? h('p', { class: 'small', style: { margin: '8px 0 0' } }, soundDesign) : null,
  );
}

/**
 * @param {AudioFeatures} f
 * @param {import('../core/pipeline.js').GenreProfile} g
 */
export function renderGenres(f, g) {
  const traits = /** @type {[import('../types.js').TraitId, number][]} */ (Object.entries(f.traits))
    .filter(([, v]) => v >= 0.5)
    .sort((a, b) => b[1] - a[1]);
  const top = g.skeleton[0]?.id;
  const path = top ? lineage(top) : [];
  const expandedOnly = g.expanded.filter((e) => e.relation !== 'seed').slice(0, 10);
  const rel = { derivative: '派生', parent: '親', sibling: '兄弟', influence: '影響元', influenced: '影響先' };
  return h(
    'div',
    null,
    h('div', { class: 'hybrid' }, g.hybridLabel),
    h('div', { class: 'genre-block' }, h('h4', null, '検出されたリズム骨格'), h('div', { class: 'chips' }, traits.length ? traits.map(([k, v]) => h('span', { class: 'chip trait' }, TRAIT_LABELS[k], h('b', null, pct(v)))) : h('span', { class: 'muted small' }, '特徴的なパターンなし'))),
    h(
      'div',
      { class: 'genre-block' },
      h('h4', null, '波形から推定したジャンル骨格'),
      h('div', { class: 'chips' }, g.skeleton.slice(0, 5).map((s) => h('span', { class: 'chip' }, genreLabel(s.id), h('b', null, pct(s.score))))),
      path.length > 1 ? h('div', { class: 'lineage' }, '系統: ', path.flatMap((id, i) => [i ? ' → ' : '', i === path.length - 1 ? h('b', null, genreLabel(id)) : genreLabel(id)])) : null,
    ),
    g.tagged.length
      ? h('div', { class: 'genre-block' }, h('h4', null, `メタデータのジャンル（${[...new Set(g.tags.map((t) => t.source))].join(' / ')}）`), h('div', { class: 'chips' }, g.tagged.slice(0, 8).map((t) => h('span', { class: 'chip' }, genreLabel(t.id)))))
      : null,
    expandedOnly.length
      ? h(
          'div',
          { class: 'genre-block' },
          h('h4', null, '系統樹で拡張した探索範囲'),
          h('div', { class: 'chips' }, expandedOnly.map((e) => h('span', { class: 'chip', title: `${genreLabel(e.via)} の${rel[/** @type {keyof typeof rel} */ (e.relation)] ?? e.relation}` }, `${GENRE_BY_ID.get(e.id)?.ja ?? e.id}`, h('span', { class: 'muted' }, ` · ${rel[/** @type {keyof typeof rel} */ (e.relation)] ?? ''}`)))),
        )
      : null,
  );
}

const BREAKDOWN_LABEL = { rhythm: 'リズム', tempo: 'テンポ', groove: 'グルーヴ', timbre: '音色・帯域', key: 'キー' };

/**
 * @param {ScoredCandidate} r
 * @param {number} rank
 * @param {AudioFeatures} input
 * @param {{why?: string, drum_pattern?: string, low_end?: string, tip?: string} | undefined} ai
 */
export function renderResultCard(r, rank, input, ai) {
  const c = r.candidate;
  const q = encodeURIComponent(`${c.artist} ${c.title}`);
  const breakdown = /** @type {(keyof typeof BREAKDOWN_LABEL)[]} */ (Object.keys(BREAKDOWN_LABEL)).map((k) =>
    h('div', { class: 'bd-row' }, h('span', null, BREAKDOWN_LABEL[k]), h('div', { class: 'bd-track' }, h('div', { class: 'bd-fill', style: { width: `${Math.round(r.breakdown[k] * 100)}%` } })), h('span', { class: 'bd-val' }, pct(r.breakdown[k]))),
  );
  const art = c.artworkUrl ? h('img', { class: 'art', src: c.artworkUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div', { class: 'art' });
  return h(
    'article',
    { class: 'card result' },
    h('div', { class: 'art-wrap' }, art, h('span', { class: 'rank' }, `#${rank}`)),
    h(
      'div',
      null,
      h('div', { class: 'result-title' }, c.title),
      h('div', { class: 'result-artist' }, c.artist, c.releaseYear ? ` · ${c.releaseYear}` : '', c.genre ? ` · ${c.genre}` : ''),
      h(
        'div',
        { class: 'result-meta' },
        h('span', { class: 'chip' }, `BPM ${r.features.bpm}`),
        h('span', { class: 'chip' }, `${r.features.key.name.replace(' major', '').replace(' minor', 'm')} (${r.features.key.camelot})`),
        h('span', { class: 'chip' }, `Swing ${r.features.groove.swing}%`),
        c.sources.slice(0, 3).map((s) => h('span', { class: 'chip muted' }, s)),
      ),
    ),
    h('div', { class: 'score' }, h('div', { class: 'score-value' }, `${pct(r.score)}%`), h('div', { class: 'score-label' }, '波形類似度')),
    h(
      'div',
      { class: 'result-body' },
      h('div', null, renderCompareHeatmap(input.grid, r.features.grid, r.shiftSteps)),
      h(
        'div',
        null,
        h('div', { class: 'breakdown' }, breakdown),
        h('ul', { class: 'reasons' }, r.reasons.map((t) => h('li', null, t))),
        ai
          ? h(
              'div',
              { class: 'explain-ai' },
              ai.why ? h('p', null, ai.why) : null,
              ai.drum_pattern ? h('p', null, h('b', null, 'ドラム: '), ai.drum_pattern) : null,
              ai.low_end ? h('p', null, h('b', null, '低域: '), ai.low_end) : null,
              ai.tip ? h('p', null, h('b', null, 'Tip: '), ai.tip) : null,
            )
          : null,
      ),
    ),
    h(
      'div',
      { class: 'result-actions' },
      c.previewUrl ? h('audio', { controls: true, preload: 'none', src: c.previewUrl }) : c.localFile ? h('audio', { controls: true, preload: 'none', src: URL.createObjectURL(c.localFile) }) : null,
      c.trackViewUrl ? h('a', { class: 'btn btn-sm', href: c.trackViewUrl, target: '_blank', rel: 'noopener' }, 'Apple Music', icon('external')) : null,
      h('a', { class: 'btn btn-sm', href: `https://www.youtube.com/results?search_query=${q}`, target: '_blank', rel: 'noopener' }, 'YouTube', icon('external')),
      h('a', { class: 'btn btn-sm', href: `https://open.spotify.com/search/${q}`, target: '_blank', rel: 'noopener' }, 'Spotify', icon('external')),
    ),
  );
}

/**
 * @param {{name: string, detail: string}[]} items
 */
export function renderRejected(items) {
  return h('ul', { class: 'rejected-list' }, items.map((it) => h('li', null, h('span', { title: it.name }, it.name), h('span', { class: 'why' }, it.detail))));
}

/** @param {import('../services/gemini.js').GeminiExplanation} e */
export function renderExplanation(e) {
  return h('div', { class: 'prose' }, h('p', null, e.overview), e.production_tips.length ? [h('h3', null, '制作Tips'), h('ul', { class: 'tips' }, e.production_tips.map((t) => h('li', null, t)))] : null);
}

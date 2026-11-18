// @ts-check
/**
 * Google Gemini (multimodal) — used for
 *   (a) the identification fallback when fingerprinting fails (listens to the
 *       excerpt, guesses title/artist only if confident, always describes
 *       sound design + genre tags), and
 *   (b) Step 4: explaining *why* the waveform-filtered matches fit.
 * Gemini never ranks tracks: candidates it suggests still go through the
 * physical waveform filter, so hallucinated songs are discarded.
 */
import { s } from '../schema.js';
import { fetchJson } from './http.js';

/** @typedef {import('../types.js').AudioFeatures} AudioFeatures */

/**
 * @param {{apiKey: string, model: string, parts: object[], schema: object, signal?: AbortSignal, temperature?: number}} o
 * @returns {Promise<unknown>}
 */
export async function generateJson(o) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(o.model)}:generateContent`;
  const data = /** @type {any} */ (
    await fetchJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': o.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: o.parts }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: o.schema, temperature: o.temperature ?? 0.4 },
      }),
      signal: o.signal,
      timeoutMs: 90000,
      retries: 1,
    })
  );
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((/** @type {any} */ p) => typeof p.text === 'string' && !p.thought)
    .map((/** @type {any} */ p) => p.text)
    .join('');
  if (!text) throw new Error(`Gemini: 空の応答 (${data?.candidates?.[0]?.finishReason ?? data?.promptFeedback?.blockReason ?? 'unknown'})`);
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error('Gemini: JSONの解析に失敗しました');
  }
}

const IdentifySchema = s.object({
  recognized: s.boolean(),
  title: s.string().catch(''),
  artist: s.string().catch(''),
  confidence: s.number({ min: 0, max: 1 }).catch(0),
  genre_tags: s.array(s.string(), { dropInvalid: true }).catch([]),
  sound_design: s.string().catch(''),
  suggested_references: s.array(s.object({ artist: s.string(), title: s.string() }), { dropInvalid: true }).catch([]),
});
/** @typedef {ReturnType<typeof IdentifySchema.parse>} GeminiIdentify */

/**
 * @param {{apiKey: string, model: string, wavBase64: string, features: AudioFeatures, signal?: AbortSignal}} o
 * @returns {Promise<GeminiIdentify>}
 */
export async function identifyWithGemini(o) {
  const prompt = `You are an expert music producer and DJ. Listen to this excerpt (the loudest section of a track).
Measured by DSP: BPM ${o.features.bpm}, key ${o.features.key.name}, swing ${o.features.groove.swing}%, sidechain ${o.features.groove.sidechainDb} dB.
1. If and only if you are highly confident you recognise the exact recording, set recognized=true and give title and artist. Never guess: if unsure, recognized=false and leave title/artist empty.
2. genre_tags: 3-6 specific sub-genre tags in English (e.g. "trap", "future bass", "city pop", "uk garage"), most specific first. Prefer the rhythmic foundation (e.g. a pop song on a trap beat → "trap pop", "trap").
3. sound_design: one or two Japanese sentences on synth timbre, bass type (808, reese, sub), drums and mix space.
4. suggested_references: up to 8 real, released tracks (artist + title) with very similar groove and sound. Only well-known existing songs.`;
  const schema = {
    type: 'OBJECT',
    properties: {
      recognized: { type: 'BOOLEAN' },
      title: { type: 'STRING' },
      artist: { type: 'STRING' },
      confidence: { type: 'NUMBER' },
      genre_tags: { type: 'ARRAY', items: { type: 'STRING' } },
      sound_design: { type: 'STRING' },
      suggested_references: { type: 'ARRAY', items: { type: 'OBJECT', properties: { artist: { type: 'STRING' }, title: { type: 'STRING' } }, required: ['artist', 'title'] } },
    },
    required: ['recognized', 'genre_tags', 'sound_design', 'suggested_references'],
  };
  const raw = await generateJson({
    apiKey: o.apiKey,
    model: o.model,
    parts: [{ text: prompt }, { inline_data: { mime_type: 'audio/wav', data: o.wavBase64 } }],
    schema,
    signal: o.signal,
    temperature: 0.2,
  });
  return IdentifySchema.parse(raw);
}

const ExplainSchema = s.object({
  overview: s.string(),
  matches: s.array(
    s.object({
      title: s.string(),
      artist: s.string(),
      why: s.string(),
      drum_pattern: s.string().catch(''),
      low_end: s.string().catch(''),
      tip: s.string().catch(''),
    }),
    { dropInvalid: true },
  ),
  production_tips: s.array(s.string(), { dropInvalid: true }).catch([]),
});
/** @typedef {ReturnType<typeof ExplainSchema.parse>} GeminiExplanation */

/** @param {AudioFeatures} f */
export function featureSummary(f) {
  const g = (/** @type {number[]} */ a) => a.map((v) => (v >= 0.66 ? 'X' : v >= 0.4 ? 'x' : '.')).join('');
  return {
    bpm: f.bpm,
    key: f.key.name,
    grid_16steps: { kick: g(f.grid.kick), snare: g(f.grid.snare), hat: g(f.grid.hat) },
    swing_percent: f.groove.swing,
    sidechain_db: f.groove.sidechainDb,
    sub_sustain_808: f.groove.subSustain,
    hat_density: f.groove.hatDensity,
    spectral_centroid_hz: Math.round(f.spectral.centroidHz),
    crest_db: Math.round(f.spectral.crestDb * 10) / 10,
    band_balance_db: { sub: f.spectral.bandBalance[0], bass: f.spectral.bandBalance[1], lowmid: f.spectral.bandBalance[2], highmid: f.spectral.bandBalance[3], air: f.spectral.bandBalance[4] },
    traits: Object.fromEntries(Object.entries(f.traits).filter(([, v]) => v >= 0.5)),
  };
}

/**
 * @param {{apiKey: string, model: string, input: {label: string, features: AudioFeatures, genres: string[]},
 *   matches: {title: string, artist: string, score: number, features: AudioFeatures, reasons: string[]}[],
 *   wavBase64?: string, signal?: AbortSignal}} o
 * @returns {Promise<GeminiExplanation>}
 */
export async function explainMatches(o) {
  const payload = {
    input: { track: o.input.label, genres: o.input.genres, features: featureSummary(o.input.features) },
    matches: o.matches.map((m) => ({ title: m.title, artist: m.artist, similarity: Math.round(m.score * 100), dsp_reasons: m.reasons, features: featureSummary(m.features) })),
  };
  const prompt = `あなたはプロのミックスエンジニア兼トラックメイカーです。
以下は RefScope が信号処理で抽出した入力曲と、波形フィルタで選ばれたリファレンス曲の特徴量です。
grid_16steps は1小節16ステップの打点（X=強い, x=中, .=なし）です。数値データに基づき、推測で事実を作らずに日本語で回答してください。
- overview: 入力曲のリズム骨格・低域の質感・ジャンル的ルーツを2〜3文で。
- matches: 各リファレンス曲について why（なぜ似ているか1〜2文）, drum_pattern（ドラム配置の比較）, low_end（キック/ベース/808の比較）, tip（自作曲に取り入れる具体策）。
- production_tips: 入力曲のサウンドを再現するための具体的な制作Tipsを3〜5個。
${o.wavBase64 ? '添付音声は入力曲の抜粋です。音色の判断に使ってください。' : ''}
DATA:
${JSON.stringify(payload)}`;
  const schema = {
    type: 'OBJECT',
    properties: {
      overview: { type: 'STRING' },
      matches: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { title: { type: 'STRING' }, artist: { type: 'STRING' }, why: { type: 'STRING' }, drum_pattern: { type: 'STRING' }, low_end: { type: 'STRING' }, tip: { type: 'STRING' } },
          required: ['title', 'artist', 'why'],
        },
      },
      production_tips: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['overview', 'matches', 'production_tips'],
  };
  /** @type {object[]} */
  const parts = [{ text: prompt }];
  if (o.wavBase64) parts.push({ inline_data: { mime_type: 'audio/wav', data: o.wavBase64 } });
  return ExplainSchema.parse(await generateJson({ apiKey: o.apiKey, model: o.model, parts, schema, signal: o.signal }));
}

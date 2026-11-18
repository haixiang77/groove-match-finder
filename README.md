# RefScope — Groove-Match Reference Finder

**貼った楽曲と、ドラムパターン・グルーヴ・音色が限りなく近いリファレンス曲を見つける DTM コンパニオン。**
GitHub Pages で動く完全ブラウザ版です（インストール・サーバー不要）。

「Pop」「EDM」のような大雑把なジャンルタグや LLM の当て推量ではなく、
**音声指紋 × メタデータ × 波形フィルタ** のハイブリッド・パイプラインで「本当に似ている曲」だけを残します。

```
 入力音声 ─┬─ ① 音声指紋で曲名を特定（AudD / ACRCloud → Gemini → ファイル名）
           └─ ① 物理解析（BPM・キー・16ステップ打点・スウィング・サイドチェイン…）
                     │
 ② 候補プール拡張：Last.fm 類似曲/類似アーティスト/タグ・MusicBrainz・ジャンル系統樹・iTunes
                     │   （20〜40曲の30秒プレビュー）
 ③ 波形フィルタ：全プレビューに①と同じ解析 → 類似度スコア → しきい値で絞り込み → 上位5〜10曲
                     │
 ④ Gemini が「なぜ似ているか」を数値に基づいて解説（任意）
```

## 使い方

1. GitHub Pages の URL を開く（ローカルなら `npm run serve` → http://localhost:8000 ）
2. 曲（MP3 / M4A / WAV / FLAC など）をドロップ
3. 必要なら波形をクリックして解析区間（初期値：エネルギー最大の30秒＝サビ／ドロップ）を調整
4. 「解析してリファレンスを探す」

結果カードには、入力曲と候補曲の 16 ステップ打点の重ね合わせ、類似度の内訳（リズム／テンポ／グルーヴ／音色・帯域／キー）、
根拠（例：「キック・ハイハットの16ステップ配置が一致」「両方にサイドチェインのポンピング」）、
30秒プレビュー、Apple Music / YouTube / Spotify へのリンクが表示されます。結果は JSON で書き出せます。

手持ちの音源（ローカルのリファレンス集）も候補として一緒にランク付けできます。

## API キー（すべて任意）

右上の「設定」から入力します。キーは **そのブラウザの localStorage にのみ保存** され、各 API へ直接送信されます。

| 用途 | サービス | なしの場合 |
|---|---|---|
| ① 楽曲同定（Shazam 相当） | [AudD](https://dashboard.audd.io/) または [ACRCloud](https://www.acrcloud.com/) | Gemini 推論 → ファイル名「アーティスト - 曲名」→ 手入力 |
| ② 類似曲・タグ | [Last.fm API](https://www.last.fm/api/account/create)（無料） | iTunes・MusicBrainz・ジャンル系統樹で候補収集 |
| ①フォールバック・④解説 | [Gemini API](https://aistudio.google.com/apikey) | ルールベースの解説のみ |

キーが一つもなくても、iTunes Search API（キー不要）＋ MusicBrainz ＋ ジャンル系統樹 ＋ 波形フィルタで動作します。

### CORS プロキシ（必要な場合のみ）

GitHub Pages は静的ホスティングのため、CORS ヘッダーを返さない API／CDN にはブラウザから直接アクセスできません。
取得に失敗する場合は `worker/cors-proxy.js` を Cloudflare Workers にデプロイし、設定の「CORS プロキシ」に
`https://refscope-proxy.<あなた>.workers.dev/?url=` を入力してください。

```bash
cd worker
npx wrangler deploy
npx wrangler secret put ALLOWED_ORIGINS   # 例: https://<user>.github.io
```

プロキシは許可リストのホスト（iTunes / mzstatic / AudD / ACRCloud / Last.fm / MusicBrainz）のみ中継します。

## GitHub Pages への公開

1. このリポジトリを `main` に push
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**
3. `.github/workflows/pages.yml` がテスト後に自動デプロイします

（ビルド工程はありません。`index.html` / `assets/` / `src/` をそのまま配信する構成なので、「Deploy from a branch」でも動きます。）

## 仕様書（Python 版）からの移植対応表

元の仕様は Python デスクトップアプリ前提でした。GitHub Pages で動かすため、各層を次のように置き換えています。

| 仕様（Python） | ブラウザ版の実装 | ファイル |
|---|---|---|
| librosa による読み込み・リサンプル | Web Audio `OfflineAudioContext.decodeAudioData`（22.05kHz・モノラル） | `src/audio/decode.js` |
| `scipy.signal.butter` + `sosfiltfilt` | 同等の Butterworth SOS 設計（双一次変換・プリワープ）とゼロ位相フィルタを純 JS で実装 | `src/audio/filters.js` |
| librosa テンポグラム / beat_track | スペクトルフラックス＋帯域オンセット融合 → 自己相関テンポ推定（1×/2×/4× 拍節ハーモニクス）→ Ellis 動的計画法ビートトラッキング → ロバスト線形補正 | `src/audio/tempo.js` |
| クロマ CQT + キー推定 | STFT クロマグラム + Krumhansl–Schmuckler（Camelot 表記つき） | `src/audio/key.js` |
| 16ステップグリッド（Kick 30–140Hz / Snare 160–1500Hz / Hat 6kHz+） | 帯域別 RMS オンセット → 拍内4分割サンプリング → ダウンビート推定 | `src/audio/analyzer.js` |
| スウィング比・サイドチェイン深さ・クレストファクター | 16分/8分の裏拍位置の中央値、トランジェント除去包絡のポンピング深さ、ピーク/RMS など | `src/audio/analyzer.js` |
| `shazamio` | AudD / ACRCloud（ブラウザから呼べる指紋照合 API。shazamio は Shazam 非公開 API の署名生成が必要でブラウザ不可） | `src/services/fingerprint.js` |
| `pylast` / `musicbrainzngs` / iTunes | fetch / JSONP クライアント（レート制限・リトライ付き） | `src/services/*.js` |
| Musicmap 系統オントロジー | 約80ジャンルの有向グラフ（親・派生・兄弟・影響、BPM 帯、リズム骨格） | `src/core/ontology.js` |
| コサイン類似度による再ランキング | 帯域別グリッド類似度（拍ローテーション・ハーフ/ダブルタイム整列）＋テンポ・グルーヴ・音色・キー | `src/core/similarity.js` |
| Pydantic | 軽量スキーマ検証（外部 API 応答・解析結果・設定をすべて境界で検証） | `src/schema.js` |
| 型ヒント | JSDoc 型 + `tsc --checkJs --strict` | `jsconfig.json` |

解析は Web Worker で実行され、UI をブロックしません。

## 開発

```bash
npm install          # 型チェック用の TypeScript のみ
npm run typecheck    # JSDoc 型検査（strict）
npm test             # DSP・類似度・オントロジー・API クライアントのユニットテスト
node tests/e2e/run.mjs   # Playwright による E2E（外部 API はモック）
npm run serve        # http://localhost:8000
```

テストは合成ドラムループ（ハウス／トラップ／ブーンバップ／レゲトン、スウィング・サイドチェインの有無）で
BPM・打点位置・スウィング率・サイドチェイン検出・ジャンル骨格推定・ランキングを検証しています。

## 既知の制約

- テンポのオクターブ（例：DnB を 174 ではなく 87 と表示）は曖昧になることがあります。類似度計算ではハーフ/ダブルタイムを整列して比較するため、ランキングへの影響は小さくなっています。
- iTunes Search API は約 20 リクエスト/分の制限があり、候補数が多いと待機が発生します。
- 30秒プレビューは曲の一部分なので、入力曲側も同じ長さの区間（初期値：最大エネルギー区間）で比較します。

## プライバシー

音声のデコード・解析はすべてブラウザ内で行われます。外部へ送信されるのは、設定した指紋照合 API／Gemini に渡す
12〜20 秒の抜粋と、曲名・アーティスト名による検索クエリのみです。

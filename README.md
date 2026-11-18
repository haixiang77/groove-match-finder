# RefScope — Groove-Match Reference Finder

**貼った楽曲と、ドラムパターン・グルーヴ・音色が限りなく近いリファレンス曲を見つける DTM コンパニオン。**
2つの動かし方があり、UI は共通です。

| | ブラウザ版（GitHub Pages） | Python 版（`refscope serve` / CLI） |
|---|---|---|
| 起動 | URL を開くだけ | `pip install -e .` → `refscope serve` |
| 楽曲同定 | AudD / ACRCloud（キー必要） | **shazamio（Shazam・キー不要）** → AudD → ACRCloud |
| 解析エンジン | 純 JS 移植（Web Worker） | librosa + SciPy（仕様書どおり） |
| CORS・iTunes レート制限 | ブラウザの制約あり（プロキシで回避） | 制約なし（サーバー側で取得） |
| API キーの置き場所 | 各ブラウザの localStorage | サーバーの環境変数（`.env`） |
| スマホ | そのまま使える | 同じ Wi-Fi / トンネル / クラウドで使える |

「Pop」「EDM」のような大雑把なジャンルタグや LLM の当て推量ではなく、
**音声指紋 × メタデータ × 波形フィルタ** のハイブリッド・パイプラインで「本当に似ている曲」だけを残します。

```
 入力音声 ─┬─ ① 音声指紋で曲名を特定（Shazam* / AudD / ACRCloud → Gemini → ファイル名）  *Python版
           └─ ① 物理解析（BPM・キー・16ステップ打点・スウィング・サイドチェイン…）
                     │
 ② 候補プール拡張：Last.fm 類似曲/類似アーティスト/タグ・MusicBrainz・ジャンル系統樹・iTunes
                     │   （20〜40曲の30秒プレビュー）
 ③ 波形フィルタ：全プレビューに①と同じ解析 → 類似度スコア → しきい値で絞り込み → 上位5〜10曲
                     │
 ④ Gemini が「なぜ似ているか」を数値に基づいて解説（任意）
```

## Python 版（ブランチ `claude/refscope-python-l9z58s`）

仕様書どおり Python 3.10+ / librosa / SciPy / shazamio / pylast / musicbrainzngs / Pydantic で実装したバックエンドです。
同じ Web UI を配信するので、PC でもスマホでも同じ画面で使えます。

```bash
# 必要: Python 3.10+, ffmpeg（iTunes プレビューの m4a デコード用）
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env          # APIキー（すべて任意。Shazam はキー不要）

refscope serve                # Web UI + API。スマホ用URLとQRコードを表示
refscope analyze song.mp3 --json result.json        # CLI で解析
refscope analyze demo.wav --artist "X" --title "Y" --refs ref1.wav ref2.mp3
```

| パス | 内容 |
|---|---|
| `refscope/audio/` | librosa 読み込み、SciPy Butterworth 帯域分離、テンポ／ビート、キー、16ステップグリッド、グルーヴ指標 |
| `refscope/services/` | shazamio・AudD・ACRCloud・pylast・musicbrainzngs・iTunes・Gemini |
| `refscope/core/` | オントロジー（`data/genres.json` を JS 版と共有）、類似度、候補プール、非同期パイプライン |
| `refscope/server.py` | FastAPI。`POST /api/analyze` が進捗を NDJSON でストリーミング、`GET /api/health` |
| `refscope/cli.py` | `refscope analyze` / `refscope serve` |

Web UI は起動時に `api/health` を確認し、Python サーバーから配信されていれば自動で **サーバーモード**
（右上に「サーバー」バッジ）になります。選択した解析区間だけを WAV でアップロードし、結果はサーバーから逐次表示されます。
GitHub Pages から開いた場合は従来どおりブラウザ内で解析します。

DSP は JS 版のアルゴリズムをそのまま移植しているため、同じ合成ループで BPM・打点・スウィング等が一致することをテストで確認しています。

## スマホから使う方法

| 方法 | 手順 | 向いている用途 | 注意 |
|---|---|---|---|
| **A. GitHub Pages 版をそのまま開く** | Safari / Chrome で Pages の URL → 共有 →「ホーム画面に追加」 | 手軽に使う。サーバー不要 | Shazam 不可（AudD 等のキーが必要）。CORS で取得できないプレビューはプロキシが必要 |
| **B. 自宅 PC で `refscope serve`（同じ Wi-Fi）** | PC で `refscope serve` → 表示された QR コードをスマホで読む | DAW の横の PC で解析させ、スマホで操作・試聴 | `http://192.168.x.x:8000` は自宅 LAN 内のみ |
| **C. B ＋ 外出先から（トンネル）** | [Tailscale](https://tailscale.com/)（推奨：自分の端末だけで閉じた VPN）または `cloudflared tunnel --url http://localhost:8000`（一時的な https URL） | 外出先から自宅 PC の解析エンジンを使う | 公開 URL にする場合は必ず `REFSCOPE_ACCESS_TOKEN` を設定 |
| **D. クラウドに常駐** | `Dockerfile` を Render / Fly.io / Google Cloud Run / Hugging Face Spaces（Docker）にデプロイ。API キーは各サービスの Secret に設定 | PC を起動せずにいつでも使う | 無料枠はスリープ・CPU 制限あり。`REFSCOPE_ACCESS_TOKEN` 必須（第三者に API キーを使われないため） |

**推奨**：まずは **A**（何もしなくてもスマホで動く）。Shazam 同定やプレビュー取得の安定性が欲しくなったら **B**、
外出先でも使いたければ **B + Tailscale**、PC を常時起動したくなければ **D** です。

- どちらの UI も PWA 対応（`manifest.webmanifest`・アイコン）なので、ホーム画面に追加するとアプリのように全画面で起動します。
- iPhone では「ファイル」アプリ内の音源（ボイスメモ書き出し・DAW の書き出し・AirDrop で受け取った音源など）を選択できます。Apple Music のライブラリ曲は DRM のため選択できません。
- GitHub Pages（https）から自宅サーバー（http）を呼ぶことはブラウザの混在コンテンツ制限でできないため、B〜D ではサーバーの URL を直接開きます。

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
# Python
pip install -e ".[dev]" && pytest -q
python tests_py/e2e_server.py 8765 & node tests/e2e/server-mode.mjs 8765   # サーバーモードの E2E（iPhone 表示）
node scripts/export-ontology.mjs   # src/core/ontology.js を変更したら Python 側 JSON を再生成

# Web
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

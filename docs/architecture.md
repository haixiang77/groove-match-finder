# Architecture — 自己解決型マルチエージェント基盤

CLAUDE.md は地図、本書は詳細設計。必要な節だけを読むこと。

## 1. 全体像

```
                  ┌──────────────────────────── Harness (機械的制約) ────────────────────────────┐
                  │ PreToolUse: guard_contract.py    Stop: stop_verify.py → verify.py            │
                  └───────────────────────────────────────────────────────────────────────────────┘
 ユーザー ──▶ 司令塔 (メインセッション / Router)
                │  ① progress.md・contract・memory を読む
                │  ② 要件1件を選び Lv 判定
                ├──▶ worker-fast (Haiku)   … 調査・ログ抽出・テスト実行 → 要約のみ返す
                ├──▶ worker-core (Sonnet)  … 実装 → verify.py --req → 自己修正 ≤3 → memory 保存
                ├──▶ evaluator  (Sonnet)   … 独立検査 → PASS / FAIL + 差し戻し指示
                │  ③ PASS なら passed=true（ガードが --req 合格記録を照合）
                │  ④ verify.py 全体回帰 → progress.md 更新 → commit
                ▼
        記憶庫: .agent/state/{task_contract.json, progress.md, knowledge_graph.json}
```

## 2. 設計原則と実装の対応

| 原則 | 実装 |
|------|------|
| 検証器ファースト | 完了 = `verify.py` の exit 0。passed=true は `--req` 合格記録が現在の作業ツリーと一致する時のみ許可 |
| Worker / Evaluator 分離 | 別サブエージェント・別コンテキスト。evaluator は Edit/Write を持たず、worker の報告を信用しない |
| コンテキスト = 作業机 | 状態は `.agent/state/` と memory MCP に永続化。CLAUDE.md は100行以内（verify.py が検査） |
| AI 向けエラー出力 | verify.py / フックは全て `[FIX HINT] <どのファイルを・どう直すか>` を出力 |
| コスト最適化 | Haiku/Sonnet ルーティング、ENABLE_TOOL_SEARCH、MAX_MCP_OUTPUT_TOKENS、出力トークン上限、ツールのホワイトリスト、Stop フックの未変更スキップ |

## 3. task_contract.json スキーマ

```jsonc
{
  "version": 1,
  "goal": "string",
  "rules": ["string"],
  "requirements": [{
    "id": "REQ-001",                 // 必須・一意・REQ-\d{3,}
    "title": "string",               // 必須
    "acceptance_criteria": ["..."],  // 必須・空不可
    "verify": "shell command",       // passed=true にするには必須。exit 0 = 合格
    "depends_on": ["REQ-000"],       // 任意。--summary の next 判定に使用
    "owner_paths": ["src/api/"],     // 任意。Lv.3 のファイル所有権
    "passed": false                  // AI が変更可能な唯一のフィールド
  }]
}
```

### 改ざん防止の3層
1. **PreToolUse ガード**: Edit/Write 後の内容をシミュレートし、`passed` を除いた部分が1文字でも意味的に変われば exit 2。
2. **passed ゲート**: false→true は `.agent/state/.cache/req_results.json` の記録（合格 & 作業ツリー指紋一致）が必要。
3. **署名 (contract.lock)**: passed を除いた内容の SHA-256。Bash 等でガードをすり抜けても verify.py が検知する。
   保護ファイル（verify.py / フック / settings.json / checks.json / ruff.toml / .ruff.toml）の SHA-256 も署名する（存在しないことも署名）。

### 要件の追加・変更手順（人間）
1. エディタで task_contract.json を編集（または `HARNESS_UNLOCK=1 claude` で起動して Claude に書かせる）
2. ターミナルで `python .agent/verifiers/verify.py --relock`
3. コミット

## 4. verify.py の検査内容

| グループ | 内容 |
|----------|------|
| harness | 必須ファイル、CLAUDE.md ≤100行、settings.json の env/hooks、.mcp.json、agent の model/tools と禁止ツール、フックの構文 |
| contract | JSON/スキーマ、depends_on の参照、contract.lock 署名一致 |
| project | `checks.json` があればそれを、無ければ自動検出（ruff / mypy(設定時) / pytest(テスト存在時) / npm・pnpm・yarn の lint・typecheck・test / tsc） |
| requirement | passed=true の要件の verify を再実行（デグレ検知）。`--req` 指定要件も実行。`--strict` で未完了も不合格 |

lint ルールはルートの `ruff.toml`（保護ファイル）で固定する。設定がないと ruff のバージョンごとの既定ルールが適用され、
同じコードでも環境によって判定が変わる（統合テスト F3: ruff 0.16 の既定 TRY004 が要件と衝突した）。
ルールを変える場合は人間が編集して `--relock` する。ruff.toml より優先される `.ruff.toml` は作成自体を禁止・署名している。

出力: `[PASS]` / `[FAIL]` / `[INFO]` 行、失敗時はログ末尾30行と `[FIX HINT]`（各最大8件）。
パーサ: pytest / ruff / mypy / tsc / eslint / jest・vitest / generic。

### checks.json（検証コマンドを固定したい場合・保護ファイル）
```json
{ "checks": [
  { "name": "lint",  "cmd": "ruff check --output-format=concise .", "parser": "ruff" },
  { "name": "types", "cmd": "mypy src", "parser": "mypy" },
  { "name": "test",  "cmd": "pytest -q --maxfail=5", "parser": "pytest", "timeout": 900 }
] }
```

## 5. Hooks の挙動

### PreToolUse（matcher: `Edit|Write|MultiEdit|NotebookEdit` と `Bash`）
| 対象 | 挙動 |
|------|------|
| task_contract.json | passed 以外の変更・JSON破損・未検証の passed=true をブロック |
| contract.lock / .agent/verifiers/ / .agent/hooks/ / .claude/settings.json | 編集をブロック |
| ruff.toml / .ruff.toml | 編集・作成をブロック（lint ルールの固定。§4 参照） |
| Bash | shlex でトークン化し、**実際の書き込み先**に保護パスがある場合だけブロック: リダイレクト先、`rm`/`tee`/`chmod` 等の引数、`cp`/`mv`/`ln`/`install` の書き込み先、`sed -i`、`dd of=`、`find -delete/-exec`、`xargs <書き込み系>`、`git checkout/restore/reset/rm/...` の対象、`python -c` / `bash -c` / heredoc のインラインコード（書き込みモードの `open()` 等）。`cd` による移動・glob・祖先ディレクトリ（`rm -rf .agent`）も解決する。`verify.py --relock` もブロック。`git checkout -- task_contract.json`（HEADへの復元）のみ許可。引用符の対応が取れないコマンドは旧来の保守的判定にフォールバック |

> 引用符内の文字列（コミットメッセージ等）や読み取り専用の引数は書き込み先とみなさないため、
> `git commit -m "... <a@b>"` や `git add .agent/state/task_contract.json` は誤検知しない（統合テスト F1）。
> 展開できない箇所（`$VAR`・`$(...)`・バッククォート・移動先不明の `cd`・`xargs`・`eval`・stdin から読むシェル/インタプリタ）は
> 「コマンド全体が保護パスに触れていればブロック」という保守的判定に切り替える。そのため `rm -rf "$D"; cat ruff.toml` のような
> 混在コマンドは誤検知しうる（分けて実行すればよい）。`git checkout .` / `git restore .` は保護ファイルを含むためブロックする。
> 検出できない既知の限界: `python3 script.py` / `bash script.sh` のようにファイル経由で書き込むもの（→ 下表の後段の層で検知）。

### 防御モデル（どの層が何を保証するか）
| 層 | 役割 | 限界 |
|----|------|------|
| PreToolUse ガード（Edit/Write） | 契約・保護ファイルへの直接編集を**事前に**止める。passed ゲート | ツール経由の編集のみが対象 |
| PreToolUse ガード（Bash） | よくある書き込み操作の**誤操作防止** | `python3 script.py` のような間接書き込みは原理的に検出できない |
| verify.py 署名照合（contract.lock） | 契約の変更不可部分・保護ファイルの改ざんを**事後に必ず**検知 | passed フラグ自体は署名対象外 |
| verify.py デグレ検知 + Stop フック | passed=true の要件は毎回検証を再実行するため、偽の passed は検証が通らない限り完了できない | 検証コマンドが弱いと素通りする → 受け入れ基準と verify は人間が厳密に書く |
| evaluator | 差分レビューでズル（テスト改変・抑制コメント・ガード回避）を検出 | LLM 判定のため確率的 |

- Bash ガードは「最終防御」ではない。**ブロックされたら別の書き方で回避せず、内容をそのまま報告する**（CLAUDE.md §4）。
  統合テストでは、誤検知を受けた司令塔がファイル名を書かない `git add -A` で通過した（F2）。誤検知自体は F1 で解消した。

### Stop
- verify.py を実行し、不合格なら exit 2 で停止拒否 → stderr の FIX HINT が Claude に返り修復を続行。
- 連続3回不合格（`HARNESS_MAX_STOP_BLOCKS`）で停止を許可し、progress.md に `[ESCALATION]` を追記。
- 前回合格/エスカレーション時から作業ツリーが不変ならスキップ（Q&A だけのターンでテストを回さない）。

### 環境変数
| 変数 | 既定 | 用途 |
|------|------|------|
| `HARNESS_UNLOCK` | 未設定 | `1` でガード全解除（人間がメタ設定を直す時のみ） |
| `HARNESS_STOP_VERIFY` | `1` | `0` で Stop 検証を無効化 |
| `HARNESS_MAX_STOP_BLOCKS` | `3` | 自己修復の最大回数 |
| `VERIFY_TIMEOUT` | `600` | 各検証コマンドのタイムアウト秒 |

## 6. トークン最適化設定（.claude/settings.json の env）
- `ENABLE_TOOL_SEARCH=true`: MCP ツール定義を遅延読み込み（必要時に ToolSearch で取得）。
- `MAX_MCP_OUTPUT_TOKENS=8000`: MCP 戻り値（スナップショット等）の肥大化防止。
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS=16000`: 1応答の出力上限。
- `BASH_MAX_OUTPUT_LENGTH=30000`: Bash 出力の切り詰め。
- サブエージェントごとの `tools` ホワイトリスト（evaluator は screenshot 不可、worker-fast は編集不可）。

## 7. MCP サーバ（.mcp.json）
| server | 用途 | 使用者 |
|--------|------|--------|
| git (`uvx mcp-server-git`) | diff / log の構造化取得 | worker-fast |
| memory (`@modelcontextprotocol/server-memory`) | ナレッジグラフ。保存先 `.agent/state/knowledge_graph.json`（JSONL・Git管理） | 全員（書き込みは worker-core） |
| playwright (`@playwright/mcp --headless`) | UI 検証（アクセシビリティスナップショット） | evaluator |

- 前提: `uv`（uvx）と Node.js。memory の起動は `sh` を使うため Windows では WSL 推奨。
- 不要なサーバは .mcp.json と settings.json の `enabledMcpjsonServers` から削除。DB 等は同形式で追加し、使うエージェントの `tools` にだけ許可する。
- 再現性重視なら `@playwright/mcp@latest` をバージョン固定に変更する。

## 8. プロジェクト固有ルール（技術スタック確定後に追記）
- 言語 / フレームワーク: ブラウザ ES modules（ビルドなし）+ JSDoc 型 (`tsc --checkJs --strict`)。Web Worker で音声解析
- ディレクトリ規約: src/audio（DSP・解析）, src/core（候補・類似度）, src/services（外部API）, src/ui, tests（node:test）
- 命名・テスト規約: テストは tests/*.test.js（`npm test`）、型は `npm run typecheck`。ハーネスが Python のため Python が必要
- 性能改善は「出力を変えない」ことが前提。既存テスト合格＋ベンチ（`node tests/bench.mjs`）で効果を示す

## 9. コミットルール

- 規約の正本は `docs/commit-rules.md`（Conventional Commits ベース）。コミットする全員（司令塔）が従う。
- 従来の `feat(<REQ-ID>): <title>` という一律形式は廃止する。type は変更の性質で選び、scope は影響範囲、要件IDは footer の `Refs: REQ-xxx` で追跡する。
- 1コミット1関心事を守り、異なる目的の変更は分割する。複雑な変更では body に Why を書く。破壊的変更は `!` と `BREAKING CHANGE:` で明示する。
- 手順の実装箇所: `CLAUDE.md` §4・§7（要約と鉄則）、`.claude/skills/self-healing-loop/SKILL.md` Step 7（コミット手順）、`worker-core`（コミット向け情報の返却）、`evaluator`（粒度違反の指摘）。

## 10. 運用のコツ
- 3要件ごと、またはコンテキストが重くなったら progress.md を更新して `/clear`。
- progress.md は150行目安。古い完了ログは1行に要約して圧縮する。
- memory には「次も役立つ事実」だけを保存（作業ログは progress.md）。

# CLAUDE.md — 地図（詳細は docs/architecture.md）

このリポジトリは「ルーター × ループ × ハーネス」型の自己解決エージェント基盤。
メインセッション = **司令塔**。自分で大量に読まない・書かない。ワーカーへ振り分け、結果を統合し、記録する。

## 1. セッション開始時の必須手順
1. `.agent/state/progress.md` を読む（現在の状態・次の一手・試行エラーログ）
2. `python .agent/verifiers/verify.py --summary` で task_contract.json の進捗と next 要件を確認
3. `mcp__memory__search_nodes` で next 要件ID・関連モジュールの既知知見を検索
4. 要件の実装は `/self-healing-loop` スキルの手順に従う

## 2. 記憶の置き場所（会話は作業机、ファイルは記憶庫）
| 何を | どこに |
|------|--------|
| 完了条件（変更不可・passed のみ更新可） | `.agent/state/task_contract.json` |
| 進捗・次の一手・試行エラーログ | `.agent/state/progress.md` |
| 再利用可能な知見（規約・落とし穴） | memory MCP → `.agent/state/knowledge_graph.json` |
| 詳細設計・固有ルール | `docs/architecture.md`（必要な時だけ読む） |

## 3. 動的ルーティング基準
| Lv | 条件 | 起動するもの |
|----|------|--------------|
| 1 | 小規模・1〜2ファイル | 調査のみ → `worker-fast`(Haiku) / 実装 → `worker-core`(Sonnet) を1体で完結 |
| 2 | 中規模・独立に並列化可能 | 司令塔が分割し、複数の worker-fast / worker-core を**1メッセージで並列起動**。要約のみ統合 |
| 3 | 大規模・相互依存 | `owner_paths`（ディレクトリ単位）で所有権を分離、または `isolation: "worktree"`。依存順に段階実行 |

- 判定・完了宣言の前は必ず `evaluator`(Sonnet) による独立検査。
- エスカレーション: worker-core が3回失敗 → `model: "opus"` で再起動 → それでも失敗なら要件分割を人間に相談。
- 探索・ログ解析・テスト実行の要約は worker-fast に任せ、司令塔のコンテキストに生ログを入れない。

## 4. 鉄則
1. **1回につき1要件**（task_contract.json の1項目）だけを完了させる。
2. 完了宣言前に **evaluator PASS** と **`verify.py --req <ID>` 合格** の両方が必須。自己申告は無効。
3. passed の更新は evaluator PASS 直後、コードを変えずに Edit で値のみ置換（ガードが合格記録を照合）。
4. 検証器・フック・設定・要件文言は変更禁止。変えたくなったら progress.md に理由を書き人間に依頼。
5. テストの削除/skip、型・lint の抑制コメントによる回避は禁止。
6. 終了前に progress.md を更新。Stop フックが verify.py を自動実行し、不合格なら修復ループに戻る。
7. ガードにブロックされたら**別の書き方で回避しない**（ファイル名を伏せる・スクリプト経由等）。誤検知と思っても内容をそのまま報告する。
8. コミットは必ず `docs/commit-rules.md`（Conventional Commits）に従う。1コミット1関心事、type は変更の性質で選び、subject は日本語30〜40文字以内・末尾に句読点なし、複雑な変更は body に Why を書く。要件完了でも一律 `feat` にしない。

## 5. 主要コマンド
```bash
python .agent/verifiers/verify.py               # 全検証（Stop フックと同じ）
python .agent/verifiers/verify.py --req REQ-001 # 1要件検証（passed ゲート用に記録）
python .agent/verifiers/verify.py --summary     # 進捗一覧
python .agent/verifiers/verify.py --strict      # 全要件 passed も要求（リリース判定）
```

## 6. ハーネス（機械的制約）
- PreToolUse: `.agent/hooks/guard_contract.py` — 契約・検証器・設定の改ざんを exit 2 でブロック
- Stop: `.agent/hooks/stop_verify.py` — verify.py 不合格なら停止を拒否（最大3回、超過で progress.md に ESCALATION）
- 人間がメタ設定を直す時のみ `HARNESS_UNLOCK=1 claude` で起動。要件変更後は人間が `--relock`。

## 7. コミットルール（要約・詳細は docs/commit-rules.md）
- 形式: `<type>(<scope>): <subject>` ＋ 必要に応じて空行を挟んで body（Why）/ footer
- type: feat / fix / refactor / perf / style / docs / test / build / ci / chore / revert
- scope は影響範囲（機能・コンポーネント・ディレクトリ）。要件IDは footer の `Refs: REQ-xxx` に残す
- 破壊的変更は type 直後に `!` を付け、footer に `BREAKING CHANGE:` を書く

## 8. プロジェクト固有情報（未設定 → 汎用構成）
- 技術スタック: ブラウザ ES modules + JSDoc 型 / node:test（詳細は docs/architecture.md §8）
- 検証コマンド: `.agent/verifiers/checks.json` で固定（npm run typecheck / npm test）。Windows では `python`（python3 はストアのスタブで動かない）
- MCP: git / memory / playwright（`.mcp.json`）。ツールは遅延読み込み（ENABLE_TOOL_SEARCH）

---
name: self-healing-loop
description: task_contract.json の要件を1件ずつ「実装 → 機械検証 → 独立評価 → 自己修正」で完了させる標準ワークフロー。機能実装・バグ修正・要件消化を始めるとき、または「次の要件を進めて」と言われたときに使う。
---

# Self-Healing Loop（1要件 = 1ループ）

司令塔（メインセッション）が従う手順。**自分で実装しない。ルーティング・統合・記録に徹する。**

## Step 0. Orient（毎回・数行で済ませる）
```bash
python .agent/verifiers/verify.py --summary   # 進捗と next 要件
```
- `.agent/state/progress.md` の「次の一手」「試行エラーログ」を読む。
- `mcp__memory__search_nodes` で next 要件ID・関連モジュールを検索。

## Step 1. 要件を1件選ぶ
- `--summary` の `next`（depends_on が全て passed の最初の未完了要件）を選ぶ。複数同時に着手しない。
- `verify` が空の要件は着手不可 → progress.md に記録して人間に定義を依頼。

## Step 2. ルーティング（CLAUDE.md の Lv 基準）
| 判定 | 起動 |
|------|------|
| Lv.1 小規模（1〜2ファイル） | 調査が要れば worker-fast → 実装は worker-core を1体 |
| Lv.2 中規模・独立並列 | 独立サブタスクごとに worker-fast/worker-core を **1メッセージ内で並列起動**、結果の要約のみ統合 |
| Lv.3 大規模・相互依存 | owner_paths 単位で所有権を分け、`isolation: "worktree"` で worker-core を段階起動。依存順にマージ |

## Step 3. 実装を委譲（worker-core）
プロンプト雛形:
```
担当要件: <REQ-ID>（task_contract.json 参照）
背景/調査結果: <worker-fast の結論や過去の失敗を3行以内>
制約: owner_paths=<...> 以外は触らない。verify.py --req <REQ-ID> が通るまで最大3回自己修正。
返却: worker-core.md の返却フォーマット
```
- `STATUS: ESCALATE` → Step 6 へ。

## Step 4. 機械検証
```bash
python .agent/verifiers/verify.py --req <REQ-ID>
```
不合格なら FIX HINT を添えて Step 3 に差し戻す（ループ回数を数える）。

## Step 5. 独立評価（evaluator・必須）
プロンプト雛形:
```
対象要件: <REQ-ID>。worker の変更ファイル: <list>。
受け入れ基準を自分で検証し、evaluator.md のフォーマットで VERDICT を返せ。worker の報告は信用するな。
```
- `VERDICT: FAIL` → 差し戻し指示をそのまま worker-core に渡して Step 3 へ。
- 実装 ↔ 評価の往復は **最大3回**。超えたら Step 6。

## Step 6. エスカレーション（必要な場合のみ）
1. Agent ツールの `model: "opus"` で worker-core を再起動（失敗ログと evaluator 指摘を渡す）。
2. それでも駄目なら要件の分割案を progress.md に書き、人間に判断を仰いで停止。

## Step 7. 完了処理（evaluator PASS の直後・コードを触らずに）
1. `task_contract.json` の該当 `"passed": false` → `"passed": true` を **Edit で値だけ** 置換。
   （ガードが「現在のコードで `--req` 合格済みか」を機械的に確認する。拒否されたら Step 4 から）
2. `python .agent/verifiers/verify.py` で全体回帰を確認。
3. `progress.md` を更新（完了ログ・試行エラーログ・次の一手）。
4. 再利用可能な知見を memory MCP に保存（worker-core が保存済みなら重複させない）。
5. コミット: 必ず `docs/commit-rules.md`（Conventional Commits）に従う（push はユーザー指示がある場合のみ）。
   - コミット前に `git status` / `git diff` で差分を確認し、**1コミット1関心事**に分割する。異なる目的（機能追加とリファクタ、バグ修正と整形等）が混ざっていたら分割して別々にコミットする。
   - 形式は `<type>(<scope>): <subject>`。type は変更の性質で選ぶ（新機能=feat / バグ修正=fix / 内部改善=refactor / 性能=perf / 整形のみ=style / 文書のみ=docs / テスト=test / ビルド・依存=build / CI=ci / 雑務=chore / 打ち消し=revert）。要件完了でも一律に feat にしない。
   - scope は影響範囲（機能・コンポーネント・ディレクトリ名）。要件IDは footer に `Refs: <REQ-ID>` として残す（影響範囲が要件に閉じる場合は scope に要件IDでもよい）。
   - subject は簡潔に。日本語なら30〜40文字以内を目安、末尾に「。」や「.」を付けない。「〜を追加」「〜を修正」等の簡潔な終止形で統一し、英語なら命令形を使う。
   - 複雑な変更・設計判断がある場合は、1行空けて body に **Why（なぜ変えたか）** を書く（What は diff で分かる）。関連 Issue は footer に `Closes #123` 等。
   - 破壊的変更は type 直後に `!` を付け、footer に `BREAKING CHANGE: <詳細>` を書く。
   - 例（シンプルな場合）: `fix(auth): トークン期限切れ時のリフレッシュ処理の無限ループを修正`
   - 例（body・footer 付き）:
     ```
     feat(api): ユーザー取得APIを追加

     従来は一覧取得しかなく、個別取得のたびに全件走査していたため。

     Refs: REQ-001
     ```

## Step 8. 次へ or 終了
- コンテキストが重くなったら（目安: 3要件ごと）progress.md 更新後に `/clear` してから Step 0 へ。
- 終了時は Stop フックが verify.py を自動実行する。不合格なら FIX HINT に従って修復を続ける。

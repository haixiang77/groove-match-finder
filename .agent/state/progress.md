# Progress（セッション間引き継ぎメモ）

> セッション開始時に必ず読み、終了前に必ず更新する。会話履歴ではなくこのファイルが「記憶」。
> 書くのは事実と次の一手のみ。長文の考察は書かない（目安: 全体150行以内、古いログは要約して圧縮）。

## 現在の状態
- 最終更新: 2026-11-18
- フェーズ: ハーネス基盤構築完了（REQ-000 passed）
- 進行中の要件: なし
- ブロッカー: REQ-001 の内容・verify コマンドが未定義（人間が task_contract.json を記入 → `--relock`）
- 2026-11-19: 統合テスト F1〜F3 のハーネス改修（guard_contract.py / verify.py / ruff.toml）を人間がレビュー・承認し、
  承認のもとで contract.lock を再署名済み（ブランチ claude/harness-fixes-f1-f3）。

## 次の一手（Next Action）
1. 人間: 契約（REQ-000〜004 記入済み）を確認し npm ci を通した上で `python .agent/verifiers/verify.py --relock`
2. AI: `/self-healing-loop` で `--summary` の next に出る要件から1件ずつ実装

## 完了ログ
| 日付 | 要件ID | 概要 | 担当 | コミット |
|------|--------|------|------|----------|
| 2026-11-18 | REQ-000 | ハーネス基盤構築・セルフチェック合格 | orchestrator | - |
| 2026-11-21 | REQ-005 | URL貼り付け入力（Issue #3 第1段階）実装・verify合格・evaluator PASS | worker-core / orchestrator | - |
| 2026-11-22 | REQ-006 | スネア検出の混入・ゴースト抑制（参加率ベースの打楽器ゲート）。F1 84.3%、実プレビュー cosine 0.37→0.45、クリーンなループ素材では正解グリッド完全一致。複合セクション素材での小節回転・集計段階の残課題は Issue #1 に記録して継続 | worker-core / orchestrator | - |
| 2026-11-22 | REQ-007 | 候補ごとの Last.fm タグ系統レイヤー実装・verify 全体 PASS（16項目）。実タグ検証：ハウス系統に対し Daft Punk がタグ由来で係数1.06・1位、ジャンル外は0.96。evaluator は利用枠上限で未実施、運用側の独立検証で代替 | worker-core / orchestrator | - |

## 試行エラーログ（同じ失敗を繰り返さないための記録）
<!-- 形式: - [日付][REQ-ID] 試したこと → 結果 → 原因/学び -->
- [2026-11-21][setup] verify 不合格(3件) → 人間対応待ち: (1) contract.lock 未署名: `python .agent/verifiers/verify.py --relock` を人間が実行 (2) Google ドライブ上で `npm ci` が ENOTEMPTY で失敗し tsc 不在: node_modules を同期除外 or プロジェクトをローカルへ移動 → AI は代替不可
- [2026-11-21][setup] 上記は運用側で解消済み: relock 実行（署名・整合性 PASS を確認）、tsc は node_modules/.bin に存在。あわせて作業フォルダの信頼承認（hasTrustDialogAccepted）と、settings.json への Edit(src/** 等) 許可追加＋再 relock を実施し、worker-core が実装できる状態になった

## 決定事項・前提
- 検証コマンドは verify.py の自動検出（ruff / mypy / pytest / npm scripts）。固定したい場合は人間が .agent/verifiers/checks.json を作成。

### [ESCALATION] 2026-11-21 03:18 verify.py が 3 回連続で不合格
- 自動修復ループの上限に達したため停止を許可しました。
- 次のセッション: 原因を分析し、worker-core を上位モデル(opus)で再起動するか、要件を分割すること。
```
[FAIL] contract/lock: contract.lock がありません
    [FIX HINT] 要件の改ざん検知ができません。人間がターミナルで `python .agent/verifiers/verify.py --relock` を実行して署名してください (AIによる実行は禁止)。
[FAIL] contract/harness-integrity: contract.lock に保護ファイル署名がありません
    [FIX HINT] 人間がターミナルで `python .agent/verifiers/verify.py --relock` を実行し、保護ファイルを署名してください。
[FAIL] project/typecheck: npm run typecheck → exit 1
    | 
    | > refscope@1.0.0 typecheck
    | > tsc -p jsconfig.json
    | 
    | 'tsc' は、内部コマンドまたは外部コマンド、
    | 操作可能なプログラムまたはバッチ ファイルとして認識されていません。
    [FIX HINT] `npm run typecheck` が失敗しました。上のログ末尾の最初のエラーを特定し、そのファイル/行を修正してから再実行してください。
==> RESULT: FAIL (3 failed / 10 passed / 5 skipped-or-info)
==> NEXT: [FIX HINT] を上から順に1つずつ修正し、再度 `python .agent/verifiers/verify.py` を実行してください。検証器・契約・テストを弱める修正は禁止です。
```

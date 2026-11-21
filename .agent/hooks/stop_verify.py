#!/usr/bin/env python3
"""Stop hook: 完了宣言時に verify.py を強制実行し、失敗なら自己修復ループへ引き戻す。

- verify.py が exit 0           → 停止を許可
- verify.py が非ゼロ             → exit 2 + stderr に [FIX HINT] を返し、AI に修正を続行させる
- 連続 HARNESS_MAX_STOP_BLOCKS 回 (既定3) 失敗 → 無限ループ防止のため停止を許可し、
  progress.md にエスカレーション記録を残してユーザーに通知する
- 前回検証時から作業ツリーが変わっていなければ再実行しない (トークン・時間の節約)
- HARNESS_STOP_VERIFY=0 で無効化
"""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / ".agent" / "verifiers"))
V = importlib.import_module("verify")

STATE_FILE = V.CACHE_DIR / "stop_state.json"
PROGRESS = V.STATE_DIR / "progress.md"
MAX_BLOCKS = int(os.environ.get("HARNESS_MAX_STOP_BLOCKS", "3"))
MAX_FEEDBACK_LINES = 80


def load_state() -> dict[str, Any]:
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state: dict[str, Any]) -> None:
    V.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def condense(output: str) -> str:
    """PASS/INFO 行を落とし、失敗・ヒントだけを AI に返す (トークン節約)。"""
    keep = [ln for ln in output.splitlines()
            if not ln.startswith(("[PASS]", "[INFO]", "[SKIP]")) and ln.strip()]
    if len(keep) > MAX_FEEDBACK_LINES:
        keep = keep[:MAX_FEEDBACK_LINES] + [f"... ({len(keep) - MAX_FEEDBACK_LINES} lines omitted; run verify.py for full output)"]
    return "\n".join(keep)


def escalate(blocks: int, summary: str) -> None:
    stamp = time.strftime("%Y-%m-%d %H:%M")
    entry = (f"\n### [ESCALATION] {stamp} verify.py が {blocks} 回連続で不合格\n"
             "- 自動修復ループの上限に達したため停止を許可しました。\n"
             "- 次のセッション: 原因を分析し、worker-core を上位モデル(opus)で再起動するか、要件を分割すること。\n"
             "```\n" + "\n".join(summary.splitlines()[:30]) + "\n```\n")
    try:
        with PROGRESS.open("a", encoding="utf-8") as f:
            f.write(entry)
    except OSError:
        pass


def main() -> int:
    if os.environ.get("HARNESS_STOP_VERIFY", "1") == "0":
        return 0
    try:
        json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        pass

    state = load_state()
    fp = V.tree_fingerprint(include_contract=True)
    if fp and state.get("fingerprint") == fp and state.get("status") in ("pass", "escalated"):
        return 0  # 前回検証から変更なし

    try:
        proc = subprocess.run([sys.executable, str(ROOT / ".agent/verifiers/verify.py")], cwd=ROOT, check=False,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace",
                              timeout=int(os.environ.get("HARNESS_STOP_TIMEOUT", "840")))
        rc, out = proc.returncode, proc.stdout
    except subprocess.TimeoutExpired:
        rc, out = 124, "[FAIL] verify.py timed out\n    [FIX HINT] 無限ループ・ハングしているテストを特定して修正してください。"

    if rc == 0:
        save_state({"fingerprint": fp, "status": "pass", "blocks": 0})
        return 0

    blocks = int(state.get("blocks", 0)) + 1
    feedback = condense(out)
    if blocks > MAX_BLOCKS:
        escalate(blocks - 1, feedback)
        save_state({"fingerprint": fp, "status": "escalated", "blocks": 0})
        print(json.dumps({"systemMessage": f"[HARNESS] verify.py が {blocks - 1} 回連続で不合格のため自動修復を打ち切りました。"
                                           " .agent/state/progress.md の ESCALATION を確認してください。"}, ensure_ascii=False))
        return 0

    save_state({"fingerprint": fp, "status": "fail", "blocks": blocks})
    print(f"[HARNESS STOP BLOCKED] verify.py が不合格のため完了できません (自己修復 {blocks}/{MAX_BLOCKS})。\n"
          "以下の [FIX HINT] を上から順に修正し、`python .agent/verifiers/verify.py` で合格を確認してから再度完了してください。\n"
          "同じ修正を繰り返して失敗している場合はアプローチを変え、試行内容を .agent/state/progress.md の試行エラーログに追記すること。\n\n"
          + feedback, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())

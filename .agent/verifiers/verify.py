#!/usr/bin/env python3
"""Mechanical verifier for the self-healing agent harness.

完了判定は AI の自己申告ではなく、このスクリプトの終了コードで行う。
失敗時は `[FIX HINT]` 行に「何が違反で、どのファイルをどう直すか」を出力する。

Usage:
  python .agent/verifiers/verify.py                 # 全検証 (harness + contract + project checks + passed要件)
  python .agent/verifiers/verify.py --req REQ-001   # 1要件を検証し結果を記録 (passedフラグ更新ゲートに使用)
  python .agent/verifiers/verify.py --strict        # 全要件が passed=true であることも要求
  python .agent/verifiers/verify.py --harness-only  # ハーネス基盤自体のセルフチェックのみ
  python .agent/verifiers/verify.py --summary       # 要件の進捗一覧を表示 (検証はしない)
  python .agent/verifiers/verify.py --relock        # 【人間専用】要件定義を変更した後に再署名

Exit code: 0 = 全合格 / 1 = 不合格 ([FIX HINT] 参照) / 2 = 使い方・内部エラー
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
AGENT_DIR = ROOT / ".agent"
STATE_DIR = AGENT_DIR / "state"
CACHE_DIR = STATE_DIR / ".cache"
CONTRACT = STATE_DIR / "task_contract.json"
LOCK = STATE_DIR / "contract.lock"
REQ_RESULTS = CACHE_DIR / "req_results.json"
CHECKS_FILE = AGENT_DIR / "verifiers" / "checks.json"
VERIFY_CMD = "python .agent/verifiers/verify.py"
PROTECTED_HASH_FILES = [
    ".agent/verifiers/verify.py",
    ".agent/verifiers/checks.json",
    ".agent/hooks/guard_contract.py",
    ".agent/hooks/stop_verify.py",
    ".claude/settings.json",
    "ruff.toml",   # lint ルールの固定 (ruff のバージョン差で判定が変わらないように)
    ".ruff.toml",  # ruff.toml より優先されるため、存在しないこと (None) も署名する
]

CHECK_TIMEOUT = int(os.environ.get("VERIFY_TIMEOUT", "600"))
TAIL_LINES = 30
MAX_HINTS = 8
REQ_ID_RE = re.compile(r"^REQ-\d{3,}$")
SKIP_DIRS = {
    ".git", ".agent", ".claude", "node_modules", ".venv", "venv", "env", "__pycache__",
    "dist", "build", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".next", "coverage",
}

REQUIRED_FILES = [
    "CLAUDE.md",
    ".mcp.json",
    ".claude/settings.json",
    ".claude/agents/worker-fast.md",
    ".claude/agents/worker-core.md",
    ".claude/agents/evaluator.md",
    ".claude/skills/self-healing-loop/SKILL.md",
    ".agent/state/task_contract.json",
    ".agent/state/progress.md",
    ".agent/verifiers/verify.py",
    ".agent/hooks/guard_contract.py",
    ".agent/hooks/stop_verify.py",
    "docs/architecture.md",
    "ruff.toml",
]

# サブエージェントの権限制約 (持ってはいけないツール)
AGENT_FORBIDDEN_TOOLS = {
    "worker-fast": {"Edit", "Write", "MultiEdit"},
    "worker-core": set(),
    "evaluator": {"Edit", "Write", "MultiEdit", "mcp__playwright__browser_take_screenshot"},
}


# --------------------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------------------
@dataclass
class Result:
    group: str
    name: str
    ok: bool
    detail: str = ""
    hints: list[str] = field(default_factory=list)
    log: str = ""
    status: str = ""  # PASS / FAIL / SKIP / INFO (空なら ok から決定)

    @property
    def label(self) -> str:
        return self.status or ("PASS" if self.ok else "FAIL")


class Report:
    def __init__(self) -> None:
        self.results: list[Result] = []

    def add(self, group: str, name: str, ok: bool, detail: str = "", hints: list[str] | None = None,
            log: str = "", status: str = "") -> Result:
        r = Result(group, name, ok, detail, list(hints or []), log, status)
        self.results.append(r)
        return r

    @property
    def failed(self) -> list[Result]:
        return [r for r in self.results if not r.ok]

    def render(self) -> str:
        out: list[str] = []
        for r in self.results:
            line = f"[{r.label}] {r.group}/{r.name}"
            if r.detail:
                line += f": {r.detail}"
            out.append(line)
            if not r.ok:
                if r.log:
                    out.extend(f"    | {ln}" for ln in tail(r.log, TAIL_LINES).splitlines())
                for h in r.hints[:MAX_HINTS]:
                    out.append(f"    [FIX HINT] {h}")
                if len(r.hints) > MAX_HINTS:
                    out.append(f"    [FIX HINT] ...他 {len(r.hints) - MAX_HINTS} 件。上記を直してから再実行すると残りが表示されます。")
        n_fail = len(self.failed)
        n_pass = sum(1 for r in self.results if r.label == "PASS")
        n_other = len(self.results) - n_fail - n_pass
        verdict = "PASS" if n_fail == 0 else "FAIL"
        out.append("")
        out.append(f"==> RESULT: {verdict} ({n_fail} failed / {n_pass} passed / {n_other} skipped-or-info)")
        if n_fail:
            out.append("==> NEXT: [FIX HINT] を上から順に1つずつ修正し、再度 "
                       f"`{VERIFY_CMD}` を実行してください。検証器・契約・テストを弱める修正は禁止です。")
        return "\n".join(out)


def tail(text: str, n: int) -> str:
    lines = text.rstrip().splitlines()
    if len(lines) <= n:
        return "\n".join(lines)
    return "\n".join([f"... ({len(lines) - n} lines omitted)"] + lines[-n:])


def run_cmd(cmd: str, timeout: int = CHECK_TIMEOUT) -> tuple[int, str, float]:
    start = time.time()
    try:
        proc = subprocess.run(cmd, shell=True, check=False, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, errors="replace", timeout=timeout)
        return proc.returncode, proc.stdout, time.time() - start
    except subprocess.TimeoutExpired as e:
        out = e.stdout if isinstance(e.stdout, str) else (e.stdout or b"").decode(errors="replace")
        return 124, f"{out}\nTIMEOUT after {timeout}s", time.time() - start


# --------------------------------------------------------------------------------------
# Contract helpers (guard_contract.py からも import される)
# --------------------------------------------------------------------------------------
def load_contract(path: Path = CONTRACT) -> tuple[dict[str, Any] | None, str | None]:
    if not path.exists():
        return None, f"{path.relative_to(ROOT)} が存在しません。"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return None, f"{path.relative_to(ROOT)} が不正なJSONです (line {e.lineno} col {e.colno}: {e.msg})。"
    if not isinstance(data, dict):
        return None, "task_contract.json のトップレベルはオブジェクトである必要があります。"
    return data, None


def immutable_view(contract: Any) -> Any:
    """passed フラグを除いた「変更不可部分」を返す。"""
    view = copy.deepcopy(contract)
    if isinstance(view, dict) and isinstance(view.get("requirements"), list):
        for req in view["requirements"]:
            if isinstance(req, dict):
                req.pop("passed", None)
    return view


def contract_fingerprint(contract: Any) -> str:
    blob = json.dumps(immutable_view(contract), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def validate_contract(contract: dict[str, Any]) -> list[str]:
    hints: list[str] = []
    reqs = contract.get("requirements")
    if not isinstance(reqs, list):
        return ['task_contract.json に "requirements": [] (配列) がありません。テンプレートの形式に戻してください。']
    seen: set[str] = set()
    for i, req in enumerate(reqs):
        where = f"requirements[{i}]"
        if not isinstance(req, dict):
            hints.append(f"{where} はオブジェクトである必要があります。")
            continue
        rid = req.get("id")
        if not isinstance(rid, str) or not REQ_ID_RE.match(rid):
            hints.append(f'{where}.id は "REQ-001" 形式の文字列にしてください (現在: {rid!r})。')
        elif rid in seen:
            hints.append(f"{where}.id {rid} が重複しています。一意なIDにしてください。")
        else:
            seen.add(rid)
            where = rid
        if not isinstance(req.get("title"), str) or not req.get("title"):
            hints.append(f'{where}: "title" (空でない文字列) が必要です。')
        ac = req.get("acceptance_criteria")
        if not isinstance(ac, list) or not ac or not all(isinstance(x, str) and x for x in ac):
            hints.append(f'{where}: "acceptance_criteria" は空でない文字列配列にしてください。')
        if not isinstance(req.get("verify", ""), str):
            hints.append(f'{where}: "verify" はシェルコマンド文字列にしてください。')
        if not isinstance(req.get("passed"), bool):
            hints.append(f'{where}: "passed" は true/false (bool) にしてください。')
        for key in ("depends_on", "owner_paths"):
            if key in req and not (isinstance(req[key], list) and all(isinstance(x, str) for x in req[key])):
                hints.append(f'{where}: "{key}" は文字列配列にしてください。')
    for req in reqs:
        if isinstance(req, dict):
            for dep in req.get("depends_on", []) or []:
                if isinstance(dep, str) and dep not in seen:
                    hints.append(f'{req.get("id")}: depends_on の "{dep}" は存在しない要件IDです。')
    return hints


def read_lock_data() -> dict[str, Any]:
    try:
        data = json.loads(LOCK.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def read_lock() -> str | None:
    return read_lock_data().get("sha256")


def harness_hashes() -> dict[str, str | None]:
    """保護ファイル (検証器・フック・設定) の SHA-256。存在しなければ None。"""
    out: dict[str, str | None] = {}
    for rel in PROTECTED_HASH_FILES:
        p = ROOT / rel
        out[rel] = hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
    return out


def find_requirement(contract: dict[str, Any], rid: str) -> dict[str, Any] | None:
    for req in contract.get("requirements", []):
        if isinstance(req, dict) and req.get("id") == rid:
            return req
    return None


# --------------------------------------------------------------------------------------
# Working-tree fingerprint (passedゲート / Stopフックのキャッシュに使用)
# --------------------------------------------------------------------------------------
def _git(*args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(["git", *args], cwd=ROOT, check=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def tree_fingerprint(include_contract: bool = False) -> str | None:
    """.agent/state/ を除いた作業ツリーのハッシュ。git 管理外なら None。"""
    if shutil.which("git") is None or _git("rev-parse", "--is-inside-work-tree").returncode != 0:
        return None
    h = hashlib.sha256()
    spec = ["--", ".", ":(exclude).agent/state"]
    head = _git("rev-parse", "HEAD")
    if head.returncode == 0:
        h.update(head.stdout)
        h.update(_git("diff", "HEAD", "--binary", *spec).stdout)
    else:
        h.update(_git("diff", "--binary", *spec).stdout)
        h.update(_git("diff", "--cached", "--binary", *spec).stdout)
    untracked = _git("ls-files", "--others", "--exclude-standard", "-z", *spec).stdout.split(b"\0")
    for rel in sorted(p for p in untracked if p):
        h.update(rel)
        p = ROOT / rel.decode(errors="replace")
        if p.is_file():
            try:
                h.update(hashlib.sha256(p.read_bytes()).digest())
            except OSError:
                pass
    if include_contract and CONTRACT.exists():
        h.update(CONTRACT.read_bytes())
    return h.hexdigest()


def load_req_results() -> dict[str, Any]:
    try:
        data = json.loads(REQ_RESULTS.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_req_result(rid: str, ok: bool) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    data = load_req_results()
    data[rid] = {"ok": ok, "fingerprint": tree_fingerprint(), "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    REQ_RESULTS.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


# --------------------------------------------------------------------------------------
# Hint extraction (AI向け修正指示)
# --------------------------------------------------------------------------------------
def extract_hints(parser: str, output: str, cmd: str) -> list[str]:
    hints: list[str] = []
    if parser == "pytest":
        for m in re.finditer(r"^(FAILED|ERROR) (\S+)(?: - (.*))?$", output, re.MULTILINE):
            node, msg = m.group(2), (m.group(3) or "").strip()
            hints.append(f"テスト {node} が{'失敗' if m.group(1) == 'FAILED' else 'エラー'}: {msg or '詳細は上のログ'}。"
                         f" 実装側を修正してください (テストの改変・skip化は禁止)。再現: `pytest {node} -x -q`")
        if not hints and "no tests ran" in output:
            hints.append("テストが1件も収集されていません。tests/ 配下に test_*.py を作成してください。")
    elif parser == "ruff":
        for m in re.finditer(r"^(.+?):(\d+):(\d+): ([A-Z]+\d+) (.*)$", output, re.MULTILINE):
            f, ln, code, msg = m.group(1), m.group(2), m.group(4), m.group(5)
            hints.append(f"{f}:{ln} [{code}] {msg} → 該当行を修正。自動修正可能なら `ruff check --fix {f}`。")
    elif parser == "mypy":
        for m in re.finditer(r"^(.+?):(\d+): error: (.*)$", output, re.MULTILINE):
            hints.append(f"{m.group(1)}:{m.group(2)} 型エラー: {m.group(3)} → 型注釈か実装を修正 (`# type: ignore` での回避は禁止)。")
    elif parser == "tsc":
        for m in re.finditer(r"^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$", output, re.MULTILINE):
            hints.append(f"{m.group(1)}:{m.group(2)} [{m.group(4)}] {m.group(5)} → 型定義か実装を修正 (`@ts-ignore`/`any` 逃げは禁止)。")
        for m in re.finditer(r"^(.+?\.tsx?):(\d+):(\d+) - error (TS\d+): (.*)$", output, re.MULTILINE):
            hints.append(f"{m.group(1)}:{m.group(2)} [{m.group(4)}] {m.group(5)} → 型定義か実装を修正。")
    elif parser == "eslint":
        current = ""
        for line in output.splitlines():
            if re.match(r"^(/|\.|[A-Za-z]:\\|\w).*\.(t|j)sx?$", line.strip()):
                current = line.strip()
            m = re.match(r"^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)\s{2,}(\S+)$", line)
            if m and m.group(3) == "error":
                hints.append(f"{current}:{m.group(1)} [{m.group(5)}] {m.group(4)} → 修正 (eslint-disable での回避は禁止)。")
    elif parser in ("jest", "vitest"):
        for m in re.finditer(r"^\s*(?:FAIL|×|✕)\s+(.+)$", output, re.MULTILINE):
            hints.append(f"テスト失敗: {m.group(1).strip()} → 実装側を修正してください (テストの改変・skip化は禁止)。")
    if not hints:
        hints.append(f"`{cmd}` が失敗しました。上のログ末尾の最初のエラーを特定し、そのファイル/行を修正してから再実行してください。")
    if "TIMEOUT after" in output:
        hints.insert(0, f"`{cmd}` がタイムアウトしました。無限ループ/待機を疑うか、環境変数 VERIFY_TIMEOUT を人間に調整依頼してください。")
    if re.search(r"command not found|No module named|not recognized as an internal", output):
        hints.insert(0, "必要なツール/依存が未インストールです。依存をインストールするか、"
                        ".agent/verifiers/checks.json のコマンドを人間に確認してください。")
    return hints


# --------------------------------------------------------------------------------------
# Project checks (tests / lint / typecheck)
# --------------------------------------------------------------------------------------
def _walk_files(limit: int = 20000) -> list[Path]:
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            found.append(Path(dirpath) / fn)
            if len(found) >= limit:
                return found
    return found


def _mypy_configured() -> bool:
    if (ROOT / "mypy.ini").exists() or (ROOT / ".mypy.ini").exists():
        return True
    for name, marker in (("pyproject.toml", "[tool.mypy]"), ("setup.cfg", "[mypy]")):
        p = ROOT / name
        if p.exists() and marker in p.read_text(encoding="utf-8", errors="replace"):
            return True
    return False


def detect_checks() -> tuple[list[dict[str, Any]], str]:
    if CHECKS_FILE.exists():
        data = json.loads(CHECKS_FILE.read_text(encoding="utf-8"))
        checks = data.get("checks", []) if isinstance(data, dict) else []
        return [c for c in checks if isinstance(c, dict) and c.get("cmd")], "checks.json"

    checks: list[dict[str, Any]] = []
    files = _walk_files()
    py_files = [f for f in files if f.suffix == ".py"]
    if py_files:
        if shutil.which("ruff"):
            checks.append({"name": "ruff", "cmd": "ruff check --output-format=concise .", "parser": "ruff"})
        if _mypy_configured() and shutil.which("mypy"):
            checks.append({"name": "mypy", "cmd": "mypy .", "parser": "mypy"})
        has_tests = any(re.match(r"^(test_.*|.*_test)\.py$", f.name) for f in py_files)
        pytest_bin = shutil.which("pytest") or (str(ROOT / ".venv/bin/pytest") if (ROOT / ".venv/bin/pytest").exists() else None)
        if has_tests and pytest_bin:
            checks.append({"name": "pytest", "cmd": "pytest -q --maxfail=5", "parser": "pytest"})

    pkg = ROOT / "package.json"
    if pkg.exists():
        try:
            scripts = json.loads(pkg.read_text(encoding="utf-8")).get("scripts", {}) or {}
        except json.JSONDecodeError:
            scripts = {}
            checks.append({"name": "package.json", "cmd": "node -e \"JSON.parse(require('fs').readFileSync('package.json'))\"",
                           "parser": "generic"})
        runner = "pnpm" if (ROOT / "pnpm-lock.yaml").exists() else "yarn" if (ROOT / "yarn.lock").exists() else "npm"
        for key, parser in (("lint", "eslint"), ("typecheck", "tsc"), ("type-check", "tsc"), ("test", "jest")):
            script = scripts.get(key)
            if script and "no test specified" not in script:
                checks.append({"name": f"{runner}:{key}", "cmd": f"{runner} run {key}", "parser": parser})
        has_tc_script = any(k in scripts for k in ("typecheck", "type-check"))
        if (ROOT / "tsconfig.json").exists() and not has_tc_script and (ROOT / "node_modules/.bin/tsc").exists():
            checks.append({"name": "tsc", "cmd": "npx --no-install tsc --noEmit", "parser": "tsc"})
    return checks, "auto-detect"


def run_project_checks(report: Report) -> None:
    try:
        checks, source = detect_checks()
    except (json.JSONDecodeError, OSError) as e:
        report.add("project", "checks.json", False, f"読み込み失敗: {e}",
                   ['.agent/verifiers/checks.json を {"checks": [{"name": "...", "cmd": "...", '
                    '"parser": "pytest|ruff|mypy|tsc|eslint|jest|generic"}]} 形式に直してください (人間の承認が必要)。'])
        return
    if not checks:
        report.add("project", "checks", True, "検出された検証コマンドなし (テスト/リンター導入後に自動検出、または checks.json で明示)",
                   status="INFO")
        return
    for c in checks:
        rc, out, dur = run_cmd(c["cmd"], int(c.get("timeout", CHECK_TIMEOUT)))
        if rc == 0:
            report.add("project", c["name"], True, f"{c['cmd']} ({dur:.1f}s, {source})")
        elif rc == 5 and c.get("parser") == "pytest":
            report.add("project", c["name"], True, "テスト0件 (pytest exit 5)", status="INFO")
        else:
            report.add("project", c["name"], False, f"{c['cmd']} → exit {rc}",
                       extract_hints(c.get("parser", "generic"), out, c["cmd"]), log=out)


# --------------------------------------------------------------------------------------
# Harness self-check
# --------------------------------------------------------------------------------------
def parse_frontmatter(text: str) -> dict[str, str]:
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if not m:
        return {}
    fm: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if ":" in line and not line.startswith((" ", "\t", "#")):
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip()
    return fm


def _hook_commands(settings: dict[str, Any], event: str) -> list[tuple[str, str]]:
    cmds: list[tuple[str, str]] = []
    for entry in (settings.get("hooks", {}) or {}).get(event, []) or []:
        for h in entry.get("hooks", []) or []:
            cmds.append((entry.get("matcher", ""), h.get("command", "")))
    return cmds


def run_harness_checks(report: Report) -> None:
    missing = [f for f in REQUIRED_FILES if not (ROOT / f).exists()]
    report.add("harness", "required-files", not missing,
               f"{len(REQUIRED_FILES) - len(missing)}/{len(REQUIRED_FILES)} present",
               [f"{f} が存在しません。docs/architecture.md の構成に従い再作成してください。" for f in missing])

    claude_md = ROOT / "CLAUDE.md"
    if claude_md.exists():
        n = len(claude_md.read_text(encoding="utf-8").splitlines())
        report.add("harness", "claude-md-size", n <= 100, f"{n} lines (limit 100)",
                   [f"CLAUDE.md が {n} 行あります。詳細は docs/architecture.md へ移し、CLAUDE.md は100行以内の目次に戻してください。"])

    sp = ROOT / ".claude/settings.json"
    if sp.exists():
        hints: list[str] = []
        try:
            s = json.loads(sp.read_text(encoding="utf-8"))
            env = s.get("env", {}) or {}
            if str(env.get("ENABLE_TOOL_SEARCH", "")).lower() != "true":
                hints.append('.claude/settings.json の env に "ENABLE_TOOL_SEARCH": "true" を設定してください。')
            if not env.get("MAX_MCP_OUTPUT_TOKENS"):
                hints.append('.claude/settings.json の env に "MAX_MCP_OUTPUT_TOKENS": "8000" を設定してください。')
            pre = _hook_commands(s, "PreToolUse")
            if not any("guard_contract.py" in c and "Edit" in m and "Write" in m for m, c in pre):
                hints.append("PreToolUse フック (matcher に Edit|Write, command に guard_contract.py) がありません。")
            if not any("stop_verify.py" in c for _, c in _hook_commands(s, "Stop")):
                hints.append("Stop フック (command に stop_verify.py) がありません。")
        except json.JSONDecodeError as e:
            hints.append(f".claude/settings.json が不正なJSONです (line {e.lineno}: {e.msg})。")
        report.add("harness", "settings.json", not hints, "hooks/env", hints)

    mp = ROOT / ".mcp.json"
    if mp.exists():
        hints = []
        try:
            servers = json.loads(mp.read_text(encoding="utf-8")).get("mcpServers", {})
            for name in ("git", "memory"):
                if name not in servers:
                    hints.append(f'.mcp.json の mcpServers に "{name}" がありません。')
            if "memory" in servers and "knowledge_graph.json" not in json.dumps(servers["memory"]):
                hints.append("memory MCP の保存先を .agent/state/knowledge_graph.json に設定してください。")
        except (json.JSONDecodeError, AttributeError) as e:
            hints.append(f".mcp.json が不正です: {e}")
        report.add("harness", "mcp.json", not hints, "git/memory servers", hints)

    for agent, forbidden in AGENT_FORBIDDEN_TOOLS.items():
        p = ROOT / f".claude/agents/{agent}.md"
        if not p.exists():
            continue
        fm = parse_frontmatter(p.read_text(encoding="utf-8"))
        hints = []
        for key in ("name", "description", "model", "tools"):
            if not fm.get(key):
                hints.append(f".claude/agents/{agent}.md のフロントマターに {key}: がありません。")
        tools = {t.strip() for t in fm.get("tools", "").split(",") if t.strip()}
        for t in sorted(tools & forbidden):
            hints.append(f".claude/agents/{agent}.md の tools から {t} を削除してください (権限分離ルール違反)。")
        report.add("harness", f"agent:{agent}", not hints, f"model={fm.get('model', '?')}, tools={len(tools)}", hints)

    hints = []
    for f in (".agent/hooks/guard_contract.py", ".agent/hooks/stop_verify.py"):
        p = ROOT / f
        if p.exists():
            try:
                compile(p.read_text(encoding="utf-8"), str(p), "exec")
            except SyntaxError as e:
                hints.append(f"{f}:{e.lineno} に構文エラー: {e.msg}")
    report.add("harness", "hook-scripts", not hints, "compile", hints)


# --------------------------------------------------------------------------------------
# Contract checks
# --------------------------------------------------------------------------------------
def check_contract(report: Report) -> dict[str, Any] | None:
    contract, err = load_contract()
    if contract is None:
        report.add("contract", "load", False, err or "",
                   [("`git diff .agent/state/task_contract.json` で破損箇所を確認し、人間に復旧を依頼してください "
                    "(`git checkout -- .agent/state/task_contract.json` で直近コミットに戻せます)。")])
        return None
    hints = validate_contract(contract)
    report.add("contract", "schema", not hints, f"{len(contract.get('requirements', []) or [])} requirements", hints)
    if hints:
        return None

    locked = read_lock()
    current = contract_fingerprint(contract)
    if locked is None:
        report.add("contract", "lock", False, "contract.lock がありません",
                   [("要件の改ざん検知ができません。人間がターミナルで "
                    f"`{VERIFY_CMD} --relock` を実行して署名してください (AIによる実行は禁止)。")])
    elif locked != current:
        report.add("contract", "lock", False, "要件の変更不可フィールドが署名時から変更されています",
                   [("task_contract.json の passed 以外 (title/acceptance_criteria/verify 等) が改変されています。"
                    " `git diff .agent/state/task_contract.json` で確認し、`git checkout -- .agent/state/task_contract.json` で戻してください。"
                    " 要件変更が正当なら人間が `--relock` で再署名します。")])
    else:
        report.add("contract", "lock", True, "署名一致")

    signed = read_lock_data().get("harness")
    if isinstance(signed, dict):
        now = harness_hashes()
        changed = [rel for rel in sorted(set(signed) | set(now)) if signed.get(rel) != now.get(rel)]
        report.add("contract", "harness-integrity", not changed,
                   "保護ファイル署名一致" if not changed else f"{len(changed)} 件の保護ファイルが署名後に変更",
                   [(f"{rel} が署名後に変更されています (検証器・フック・設定の改ざん疑い)。"
                     f" `git diff -- {rel}` で内容を確認し、AIによる変更なら人間に `git checkout -- {rel}` での復元を依頼してください。"
                     " 正当な変更なら人間が `--relock` で再署名します。") for rel in changed])
    else:
        report.add("contract", "harness-integrity", False, "contract.lock に保護ファイル署名がありません",
                   [f"人間がターミナルで `{VERIFY_CMD} --relock` を実行し、保護ファイルを署名してください。"])
    return contract


def run_requirement(report: Report, req: dict[str, Any], record: bool = False) -> bool:
    rid = req["id"]
    cmd = (req.get("verify") or "").strip()
    if not cmd:
        report.add("requirement", rid, False, "verify コマンドが未定義",
                   [(f"{rid} には機械的な検証コマンド (verify) がありません。自己申告では完了扱いにできません。"
                    " 人間に verify コマンドの定義と --relock を依頼してください。")])
        if record:
            save_req_result(rid, False)
        return False
    rc, out, dur = run_cmd(cmd)
    ok = rc == 0
    if ok:
        report.add("requirement", rid, True, f"{req.get('title', '')} ({dur:.1f}s)")
    else:
        hints = extract_hints("pytest" if "pytest" in cmd else "generic", out, cmd)
        if req.get("passed") is True and not record:
            hints.insert(0, f"{rid} は passed=true ですが検証に失敗しました (デグレ)。実装を修正するか、"
                            f"直せない場合は .agent/state/task_contract.json の {rid} の passed を false に戻してください。")
        hints.append(f"受け入れ基準: {' / '.join(req.get('acceptance_criteria', []))}")
        report.add("requirement", rid, False, f"{cmd} → exit {rc}", hints, log=out)
    if record:
        save_req_result(rid, ok)
    return ok


# --------------------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------------------
def cmd_summary() -> int:
    contract, err = load_contract()
    if contract is None:
        print(f"[FAIL] {err}")
        return 1
    reqs = [r for r in contract.get("requirements", []) if isinstance(r, dict)]
    done = sum(1 for r in reqs if r.get("passed") is True)
    print(f"goal: {contract.get('goal', '')}")
    print(f"progress: {done}/{len(reqs)} passed")
    next_req = None
    for r in reqs:
        mark = "x" if r.get("passed") is True else " "
        deps = f" (depends_on: {', '.join(r['depends_on'])})" if r.get("depends_on") else ""
        print(f"  [{mark}] {r.get('id')}: {r.get('title')}{deps}")
        if next_req is None and r.get("passed") is not True:
            blocked = [d for d in r.get("depends_on", []) or []
                       if not (find_requirement(contract, d) or {}).get("passed")]
            if not blocked:
                next_req = r.get("id")
    print(f"next: {next_req or '(none — all passed or blocked)'}")
    return 0


def cmd_relock() -> int:
    contract, err = load_contract()
    if contract is None:
        print(f"[FAIL] {err}")
        return 1
    hints = validate_contract(contract)
    if hints:
        print("[FAIL] contract schema invalid; fix before relocking:")
        for h in hints:
            print(f"    [FIX HINT] {h}")
        return 1
    LOCK.write_text(json.dumps({
        "sha256": contract_fingerprint(contract),
        "harness": harness_hashes(),
        "locked_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "note": "passed を除く task_contract.json と保護ファイルの署名。人間が `verify.py --relock` でのみ更新する。",
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[PASS] contract relocked: {LOCK.relative_to(ROOT)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Harness verifier")
    ap.add_argument("--req", metavar="ID", help="検証する要件ID (結果を passed ゲート用に記録)")
    ap.add_argument("--strict", action="store_true", help="全要件 passed=true を要求")
    ap.add_argument("--harness-only", action="store_true", help="ハーネス基盤のセルフチェックのみ")
    ap.add_argument("--summary", action="store_true", help="要件の進捗表示のみ")
    ap.add_argument("--relock", action="store_true", help="【人間専用】要件定義の再署名")
    args = ap.parse_args(argv)

    if args.summary:
        return cmd_summary()
    if args.relock:
        return cmd_relock()

    report = Report()
    run_harness_checks(report)
    if args.harness_only:
        print(report.render())
        return 1 if report.failed else 0

    contract = check_contract(report)
    run_project_checks(report)

    if contract is not None:
        reqs = [r for r in contract["requirements"]]
        if args.req:
            req = find_requirement(contract, args.req)
            if req is None:
                ids = ", ".join(r["id"] for r in reqs)
                print(f"[FAIL] 要件 {args.req} は存在しません。有効なID: {ids}")
                return 2
            run_requirement(report, req, record=False)
        for req in reqs:
            if args.req and req["id"] == args.req:
                continue
            if req.get("passed") is True:
                run_requirement(report, req)
            else:
                report.add("requirement", req["id"], not args.strict, f"pending: {req.get('title', '')}",
                           [f"{req['id']} が未完了です (--strict)。self-healing-loop スキルで実装してください。"],
                           status="" if args.strict else "INFO")

    if args.req and contract is not None:
        # 全体 (harness + contract + project + 対象要件 + 既存passed要件) が通った時のみゲート用に合格記録
        save_req_result(args.req, not report.failed)

    print(report.render())
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())

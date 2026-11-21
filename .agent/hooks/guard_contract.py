#!/usr/bin/env python3
"""PreToolUse guard: 完了条件・検証器の改ざんを機械的にブロックする。

Claude Code から stdin に JSON ({tool_name, tool_input, cwd, ...}) を受け取り、
違反時は exit 2 + stderr に「何が違反で、どう直すべきか」を出力する (stderr は AI に返される)。

ルール:
  1. task_contract.json は passed フラグ以外の変更・削除を禁止。
  2. passed を false→true にするのは、現在のコード状態で `verify.py --req <ID>` が合格済みの場合のみ。
  3. contract.lock / .agent/verifiers/ / .agent/hooks/ / .claude/settings.json / ruff.toml / .ruff.toml の編集を禁止。
  4. Bash 経由での上記ファイルへの書き込み、`--relock` の実行を禁止。
     コマンドを shlex でトークン化し、実際の書き込み先に保護パスがある場合だけブロックする (誤検知を避けるため)。
  人間がメタ設定を直す場合のみ `HARNESS_UNLOCK=1 claude` で起動して解除する。
"""

from __future__ import annotations

import fnmatch
import importlib
import json
import os
import re
import shlex
import sys
from pathlib import Path
from typing import Any, NoReturn

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / ".agent" / "verifiers"))
V = importlib.import_module("verify")

CONTRACT_REL = ".agent/state/task_contract.json"
LOCK_REL = ".agent/state/contract.lock"
PROTECTED_FILES = {LOCK_REL, ".claude/settings.json", "ruff.toml", ".ruff.toml"}
PROTECTED_PREFIXES = (".agent/verifiers/", ".agent/hooks/")
BASH_TARGETS = ("task_contract.json", "contract.lock", ".agent/verifiers", ".agent/hooks", ".claude/settings.json",
                "ruff.toml")
WRITE_RE = re.compile(
    r"(?:>{1,2}\s*(?!&|/dev/null)\S"
    r"|\btee\b|\bsed\b[^|;&]*\s-i|\bperl\b[^|;&]*\s-\w*i"
    r"|\b(?:mv|cp|rm|truncate|dd|chmod|ln|install|rsync|unlink)\b"
    r"|open\(|write_text|write_bytes|\.write\(|json\.dump"
    r"|\bgit\s+(?:checkout|restore|reset|stash|rm|mv|clean|apply)\b)"
)
# 直近コミットへの復元だけは許可 (改ざんからの復旧手段)
RESTORE_RE = re.compile(
    r"^\s*git\s+(?:checkout\s+(?:HEAD\s+)?--|restore(?:\s+--source=HEAD)?(?:\s+--staged)?(?:\s+--worktree)?)"
    r"\s+\S*task_contract\.json\s*$"
)
UNLOCKED = os.environ.get("HARNESS_UNLOCK") == "1"


def block(msg: str) -> NoReturn:
    print(f"[HARNESS GUARD] BLOCKED\n{msg}", file=sys.stderr)
    sys.exit(2)


def rel_path(path: str, cwd: str) -> str:
    p = Path(path)
    if not p.is_absolute():
        p = Path(cwd or os.getcwd()) / p
    try:
        return Path(os.path.relpath(os.path.realpath(p), os.path.realpath(ROOT))).as_posix()
    except ValueError:
        return p.as_posix()


def simulate(tool: str, ti: dict[str, Any], current: str) -> str | None:
    """編集後のファイル内容を再現する。old_string 不一致ならツール側が失敗するので None。"""
    if tool == "Write":
        return str(ti.get("content", ""))
    edits = [ti] if tool == "Edit" else list(ti.get("edits", []) or [])
    text = current
    for e in edits:
        old, new = str(e.get("old_string", "")), str(e.get("new_string", ""))
        if not old or old not in text:
            return None
        text = text.replace(old, new) if e.get("replace_all") else text.replace(old, new, 1)
    return text


def describe_diff(old: Any, new: Any) -> list[str]:
    diffs: list[str] = []
    ov, nv = V.immutable_view(old), V.immutable_view(new)
    if not isinstance(ov, dict) or not isinstance(nv, dict):
        return ["トップレベル構造"]
    for k in sorted(set(ov) | set(nv)):
        if k != "requirements" and ov.get(k) != nv.get(k):
            diffs.append(f"トップレベル '{k}'")
    oreq = {r.get("id"): r for r in ov.get("requirements", []) or [] if isinstance(r, dict)}
    nreq = {r.get("id"): r for r in nv.get("requirements", []) or [] if isinstance(r, dict)}
    for rid in oreq.keys() - nreq.keys():
        diffs.append(f"{rid} の削除")
    for rid in nreq.keys() - oreq.keys():
        diffs.append(f"{rid} の追加")
    for rid in oreq.keys() & nreq.keys():
        for k in sorted(set(oreq[rid]) | set(nreq[rid])):
            if oreq[rid].get(k) != nreq[rid].get(k):
                diffs.append(f"{rid}.{k}")
    if not diffs and [r.get("id") for r in ov.get("requirements", [])] != [r.get("id") for r in nv.get("requirements", [])]:
        diffs.append("requirements の並び順")
    return diffs or ["(構造の差分)"]


def check_contract_edit(tool: str, ti: dict[str, Any]) -> None:
    path = ROOT / CONTRACT_REL
    if not path.exists():
        block(f"{CONTRACT_REL} は存在しません。完了条件の新規作成は人間の作業です。"
              " 要件案は .agent/state/progress.md に書き、人間にレビューを依頼してください。")
    current = path.read_text(encoding="utf-8")
    new_text = simulate(tool, ti, current)
    if new_text is None:
        return  # old_string 不一致 → Edit ツール自体がエラーを返す
    try:
        old = json.loads(current)
    except json.JSONDecodeError:
        block(f"{CONTRACT_REL} が既に破損しています。AIによる修復は禁止です。"
              f" `git checkout -- {CONTRACT_REL}` で直近コミットに戻してください。")
    try:
        new = json.loads(new_text)
    except json.JSONDecodeError as e:
        block(f"この編集で {CONTRACT_REL} が不正なJSONになります (line {e.lineno}: {e.msg})。"
              ' `"passed": false` → `"passed": true` の値部分だけを置換してください。')

    if V.immutable_view(old) != V.immutable_view(new):
        changed = ", ".join(describe_diff(old, new))
        block(f"{CONTRACT_REL} の変更不可フィールドを書き換えようとしました: {changed}\n"
              "許可されているのは requirements[].passed の true/false 変更のみです。\n"
              "→ 修正方法: 要件の文言・検証コマンドを変えるのではなく、実装コードを修正して要件を満たしてください。"
              " 要件自体が誤っていると判断した場合は、理由を .agent/state/progress.md に記録し人間に判断を仰いでください。")

    old_reqs = {r.get("id"): r for r in old.get("requirements", []) if isinstance(r, dict)}
    for req in new.get("requirements", []):
        if not isinstance(req, dict):
            continue
        rid = req.get("id")
        if not isinstance(req.get("passed"), bool):
            block(f"{rid}.passed は true/false (bool) である必要があります。")
        if req.get("passed") is True and old_reqs.get(rid, {}).get("passed") is not True:
            fp = V.tree_fingerprint()
            if fp is None:
                continue  # git 管理外ではゲートを適用できない (verify.py 側で検出)
            rec = V.load_req_results().get(rid)
            if not rec or not rec.get("ok") or rec.get("fingerprint") != fp:
                reason = ("検証記録がありません" if not rec else
                          "最後の検証が不合格です" if not rec.get("ok") else
                          "検証後にコードが変更されています")
                block(f"{rid} を passed=true にできません: {reason}。\n"
                      f"→ 修正方法: `{V.VERIFY_CMD} --req {rid}` を実行して合格させ、evaluator の PASS 判定を得た直後に、"
                      "コードを変更せずに passed を更新してください。")


# --------------------------------------------------------------------------------------
# Bash 解析
#   旧実装は「コマンド全体に保護パス名と書き込み系パターンが両方含まれるか」で判定していたため、
#   コミットメッセージ中の `<a@b>` の `>` などで誤検知した (統合テスト F1)。
#   現在は shlex でトークン化し、実際の書き込み先 (リダイレクト先・書き込み系コマンドの引数・
#   インタプリタのインラインコード) に保護パスが現れる場合だけブロックする。
#   注意: これは誤操作防止のための層であり、`python script.py` のような間接書き込みは原理的に検出できない。
#   最終防御は verify.py の署名照合 (contract/lock, contract/harness-integrity) とデグレ検知 (docs/architecture.md §5)。
# --------------------------------------------------------------------------------------
BASH_MSG = ("Bash 経由で保護ファイル (task_contract.json / contract.lock / .agent/verifiers / .agent/hooks /"
            " .claude/settings.json / ruff.toml) を変更しようとしました。\n"
            "→ 修正方法: 読み取りは Read ツールか `cat` を使用。passed の更新は Edit ツールで値のみ置換。"
            " 検証器や設定の変更が必要なら理由を progress.md に記録し、人間に依頼してください。"
            " このブロックを別の書き方で回避することは禁止です (誤検知と考える場合もそのまま報告してください)。")
RELOCK_MSG = "`--relock` (要件の再署名) は人間専用です。要件の変更が必要なら progress.md に記録し人間に依頼してください。"

DELETE_LIKE = {"rm", "rmdir", "unlink", "shred"}  # 祖先ディレクトリ指定 (rm -rf .agent) もブロック
MODIFY_LIKE = {"truncate", "chmod", "chown", "chgrp", "touch", "tee"}
COPY_LIKE = {"cp", "install", "rsync", "scp", "ln", "mv"}  # 最後の位置引数 (書き込み先) を検査。mv は移動元も
IN_PLACE = {"sed", "perl", "ruby"}
GIT_WRITE = {"checkout", "restore", "reset", "stash", "rm", "mv", "clean", "apply", "am", "switch"}
WRAPPERS = {"sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice", "ionice", "timeout", "stdbuf"}
INTERP_RE = re.compile(r"^(?:python[\d.]*|pypy[\d.]*|node|nodejs|deno|bun|ruby|perl|php|lua|Rscript)$")
SHELL_RE = re.compile(r"^(?:ba|z|da|k|fi)?sh$")
CODE_WRITE_RE = re.compile(
    r"open\([^)]*,\s*(?:mode\s*=\s*)?['\"][^'\"]*[wax+]|\.open\(\s*(?:mode\s*=\s*)?['\"][^'\"]*[wax+]"
    r"|write_text|write_bytes|\.write\(|json\.dump|unlink|rename|os\.replace\(|remove\(|rmtree|truncate"
    r"|shutil|os\.system|subprocess|writeFile|appendFile|rmSync|File\.write|chmod|symlink"
)
HEREDOC_RE = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
SEP_CHARS = set(";|&()\n")
# shlex は連続する記号を1トークンにまとめる (`;>` `|>` 等) ため、演算子単位に分解する
OP_RE = re.compile(r"&>>?|>>?\|?&?|<<<|<<-?|<>|<&|<|&&|\|\||\|&|[;|&()\n]")
XARGS_OPTS_WITH_VALUE = {"-n", "-I", "-i", "-P", "-L", "-l", "-d", "-s", "-E", "-e", "-a", "--max-args",
                         "--replace", "--max-procs", "--max-lines", "--delimiter", "--arg-file"}
WRITERS = DELETE_LIKE | MODIFY_LIKE | COPY_LIKE | IN_PLACE | {"dd", "eval"}


def _protected_candidates() -> list[str]:
    """fnmatch / 祖先判定用の保護パス一覧 (実在しない保護ファイルも含む)。"""
    out = set(PROTECTED_FILES) | {CONTRACT_REL} | {p.rstrip("/") for p in PROTECTED_PREFIXES}
    for prefix in PROTECTED_PREFIXES:
        d = ROOT / prefix
        if d.is_dir():
            out.update(Path(os.path.relpath(p, ROOT)).as_posix() for p in d.rglob("*"))
    return sorted(out)


def _resolve(token: str, cwd: str) -> str | None:
    """トークンをリポジトリ相対パスにする。リポジトリ外・展開不能なら None。"""
    if not token or token.startswith("-") or "$" in token or "\0" in token:
        return None
    token = os.path.expanduser(token)
    rel = rel_path(token, cwd)
    if rel == "." or not rel.startswith("../"):
        return rel
    return None


def _is_protected(rel: str | None) -> bool:
    if rel is None:
        return False
    if rel in PROTECTED_FILES or rel == CONTRACT_REL:
        return True
    return any(rel.startswith(p) or rel == p.rstrip("/") for p in PROTECTED_PREFIXES)


def _touches_protected(token: str, cwd: str, *, ancestors: bool) -> bool:
    """token (または `key=value` の value) が保護パス・その祖先ディレクトリ・それに合致する glob か。"""
    values = [token] + ([token.split("=", 1)[1]] if "=" in token else [])
    for v in values:
        if any(ch in v for ch in "*?["):
            base = _resolve(v, cwd)
            if base and any(fnmatch.fnmatchcase(c, base) for c in _protected_candidates()):
                return True
            continue
        rel = _resolve(v, cwd)
        if _is_protected(rel):
            return True
        if ancestors and rel is not None and (rel == "." or any(c.startswith(rel + "/") for c in _protected_candidates())):
            return True
    return False


def _mentions_protected(text: str) -> bool:
    return any(t in text for t in BASH_TARGETS)


UNKNOWN_CWD = "\0unknown-cwd"  # `cd "$X"` 等で移動先が決まらない状態


def _expand_braces(token: str) -> list[str]:
    """`{a,b}` 形式のブレース展開 (入れ子・数列は簡易対応のみ)。"""
    m = re.search(r"\{([^{}]*,[^{}]*)\}", token)
    if not m:
        return [token]
    out: list[str] = []
    for part in m.group(1).split(","):
        out.extend(_expand_braces(token[:m.start()] + part + token[m.end():]))
    return out[:64]


def _hits(token: str, cwd: str, whole: str, *, ancestors: bool = False) -> bool:
    """書き込み先トークンの判定。変数・コマンド置換 (`$x`, `$(...)`) や不明な cwd は展開できないため、
    コマンド全体が保護パスに触れていれば安全側でヒット扱いにする。"""
    if "$" in token or cwd == UNKNOWN_CWD:
        return _mentions_protected(whole)
    return any(_touches_protected(t, cwd, ancestors=ancestors) for t in _expand_braces(token))


def _opaque_write(whole: str) -> bool:
    """中身を構文解析できない経路 (シェル/インタプリタへの stdin、eval 等) 用の保守的判定 (旧来方式)。"""
    return _mentions_protected(whole) and bool(WRITE_RE.search(whole) or CODE_WRITE_RE.search(whole))


def _extract_heredocs(cmd: str) -> tuple[str, list[tuple[str, str]]]:
    """heredoc 本文を取り除いたコマンドと、(本文を受け取る行, 本文) の一覧を返す。"""
    lines = cmd.split("\n")
    kept: list[str] = []
    docs: list[tuple[str, str]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        kept.append(line)
        i += 1
        for m in HEREDOC_RE.finditer(line):
            delim, body = m.group(2), []
            while i < len(lines) and lines[i].strip() != delim:
                body.append(lines[i])
                i += 1
            i += 1  # 終端デリミタ
            docs.append((line, "\n".join(body)))
    return "\n".join(kept), docs


Segment = tuple[list[str], list[str], list[str]]  # (引数トークン, リダイレクト先, here-string 本文)


def _segments(cmd: str) -> list[Segment]:
    """コマンド列を単純コマンドに分割する。"""
    # `cmd` (旧式コマンド置換) は `$ ; cmd ;` に置換: 外側の引数は展開不能 ($) とし、内側は独立に検査する
    cmd = re.sub(r"`([^`]*)`", r" $ ; \1 ; ", cmd)
    lex = shlex.shlex(cmd, posix=True, punctuation_chars=";&|()<>\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    lex.commenters = ""
    segs: list[Segment] = []
    words: list[str] = []
    redirects: list[str] = []
    herestr: list[str] = []
    expect = ""  # "target" | "herestr" | ""
    for tok in lex:
        if tok and all(ch in ";&|()<>\n" for ch in tok):
            for op in OP_RE.findall(tok):
                if op == "<<<":
                    expect = "herestr"
                elif op[0] in "<>" or op.startswith("&>"):
                    # `>file` `>>file` `&>file` `>|file` `<>file` は書き込み先。`<file` `<<EOF` は対象外。
                    # `>&` は次が fd 番号/`-` なら複製、ファイル名なら書き込み (判定は後段)
                    if op.endswith("&") and ">" in op:
                        expect = "dup"
                    else:
                        expect = "target" if ">" in op and not op.startswith("<<") else ""
                else:
                    segs.append((words, redirects, herestr))
                    words, redirects, herestr, expect = [], [], [], ""
            continue
        if expect == "target" or (expect == "dup" and not re.fullmatch(r"\d+-?|-", tok)):
            redirects.append(tok)
        elif expect == "herestr":
            herestr.append(tok)
        else:
            words.append(tok)
        expect = ""
    segs.append((words, redirects, herestr))
    return [s for s in segs if any(s)]


def _chdir(cwd: str, dest: str) -> str:
    if "$" in dest:
        return UNKNOWN_CWD
    dest = os.path.expanduser(dest)
    if os.path.isabs(dest):
        return dest
    return UNKNOWN_CWD if cwd == UNKNOWN_CWD else os.path.join(cwd, dest)


CHDIR_OPTS = {"-C", "--chdir", "--directory"}
CHDIR_CMDS = {"git", "make", "gmake", "tar"}
OPAQUE_DIR_OPTS = ("--git-dir", "--work-tree")


def _option_cwd(words: list[str], cwd: str) -> str:
    """作業ディレクトリを変えるオプション (-C/--chdir/--directory) を順に適用した cwd を返す。
    `--git-dir` / `--work-tree` は解決が複雑なため不明扱い (保守的判定)。"""
    i = 0
    while i < len(words):
        a = words[i]
        if a in CHDIR_OPTS and i + 1 < len(words):
            cwd = _chdir(cwd, words[i + 1])
            i += 2
            continue
        if "=" in a and a.split("=", 1)[0] in CHDIR_OPTS:
            cwd = _chdir(cwd, a.split("=", 1)[1])
        elif a.startswith(OPAQUE_DIR_OPTS):
            cwd = UNKNOWN_CWD
        i += 1
    return cwd


def _strip_wrappers(words: list[str]) -> list[str]:
    w = list(words)
    while w:
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w[0]):
            w.pop(0)
            continue
        name = os.path.basename(w[0])
        if name not in WRAPPERS:
            break
        w.pop(0)
        while w and (w[0].startswith("-") or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w[0])):
            opt = w.pop(0)
            if opt in ("-n", "-u", "-c", "-s", "-k", "-C", "-S", "--signal", "--kill-after", "--chdir", "--unset") and w \
                    and name in ("nice", "sudo", "timeout", "env"):
                w.pop(0)
        if name == "timeout" and w and re.match(r"^\d", w[0]):
            w.pop(0)
    return w


def _check_code(code: str) -> None:
    if "relock" in code and "verify" in code:
        block(RELOCK_MSG)
    if _mentions_protected(code) and CODE_WRITE_RE.search(code):
        block(BASH_MSG)


def _check_segment(words: list[str], redirects: list[str], herestr: list[str], cwd: str, whole: str) -> str:
    """1つの単純コマンドを検査する。cd の移動先 (以降のセグメントの cwd) を返す。"""
    for target in redirects:
        if _hits(target, cwd, whole):
            block(BASH_MSG)
    w = _strip_wrappers(words)
    if not w:
        return cwd
    name, args = os.path.basename(w[0]), w[1:]
    if name in ("cd", "pushd", "popd"):
        dest = next((a for a in args if a == "-" or not a.startswith("-")), "~")
        return UNKNOWN_CWD if name == "popd" or dest == "-" else _chdir(cwd, dest)
    # `git -C dir` / `env -C dir` / `tar -C dir` / `make --directory=dir` 等: このコマンドの引数だけ別 cwd で解決する。
    # -C が chdir を意味するのはラッパー部 (env) と CHDIR_CMDS のみ (install -C / rsync -C は別の意味)
    outer = cwd
    prefix = words[: len(words) - len(w)]
    env_at = next((i for i, t in enumerate(prefix) if os.path.basename(t) == "env"), None)
    if env_at is not None:  # sudo -C (fd 番号) 等は対象外
        cwd = _option_cwd(prefix[env_at + 1:], cwd)
    if name in CHDIR_CMDS:
        cwd = _option_cwd(args, cwd)
    if "--relock" in args:
        block(RELOCK_MSG)
    if name == "xargs":
        # 対象は stdin から来るため解析不能。実行コマンドが書き込み系/シェル/インタプリタで、
        # パイプライン全体が保護パスに触れていれば安全側でブロック
        i = 0
        while i < len(args) and args[i].startswith("-"):
            i += 2 if args[i] in XARGS_OPTS_WITH_VALUE else 1
        inner_words = _strip_wrappers(args[i:])  # `xargs sudo rm` / `xargs env rm` → rm
        inner = os.path.basename(inner_words[0]) if inner_words else ""
        git_write = inner == "git" and any(a in GIT_WRITE for a in inner_words[1:])
        if (inner in WRITERS or git_write or SHELL_RE.match(inner) or INTERP_RE.match(inner)) and _mentions_protected(whole):
            block(BASH_MSG)
        return outer
    if name in ("eval", "source", "."):
        if name == "eval":
            check_bash(" ".join(args), cwd)
        if _opaque_write(whole):
            block(BASH_MSG)
        return outer
    if name in DELETE_LIKE | MODIFY_LIKE:
        if any(_hits(a, cwd, whole, ancestors=name in DELETE_LIKE) for a in args):
            block(BASH_MSG)
    elif name in COPY_LIKE:
        target_dir: str | None = None
        pos: list[str] = []
        i = 0
        while i < len(args):
            a = args[i]
            if a in ("-t", "--target-directory") and i + 1 < len(args):
                target_dir, i = args[i + 1], i + 2
                continue
            if a.startswith("--target-directory="):
                target_dir = a.split("=", 1)[1]
            elif a.startswith("-t") and len(a) > 2 and not a.startswith("--"):
                target_dir = a[2:]
            elif not a.startswith("-"):
                pos.append(a)
            i += 1
        dest, srcs = (target_dir, pos) if target_dir is not None else (pos[-1] if pos else None, pos[:-1])
        if dest is not None:
            cands = [dest] + [os.path.join(dest, os.path.basename(s.rstrip("/"))) for s in srcs]
            if any(_hits(c, cwd, whole) for c in cands):
                block(BASH_MSG)
        if name == "mv" and any(_hits(s, cwd, whole, ancestors=True) for s in srcs):
            block(BASH_MSG)
    elif name == "dd":
        if any(a.startswith("of=") and _hits(a[3:], cwd, whole) for a in args):
            block(BASH_MSG)
    elif name in IN_PLACE and any(re.match(r"^-(?:[a-zA-Z]*i|-in-place)", a) for a in args):
        if any(_hits(a, cwd, whole) for a in args if not a.startswith("-")):
            block(BASH_MSG)
    elif name == "find":
        if (any(a in ("-delete", "-exec", "-execdir", "-ok", "-okdir") for a in args)
                and any(_hits(a, cwd, whole, ancestors=True) for a in args)):
            block(BASH_MSG)
    elif name == "git":
        i = 0
        while i < len(args) and args[i].startswith("-"):
            i += 2 if args[i] in ("-C", "-c", "--git-dir", "--work-tree") else 1
        sub, rest = (args[i], args[i + 1:]) if i < len(args) else ("", [])
        if sub in GIT_WRITE and any(_hits(a, cwd, whole, ancestors=True) for a in rest):
            if not RESTORE_RE.match(" ".join(["git", sub, *rest])):
                block(BASH_MSG)
    elif INTERP_RE.match(name) or SHELL_RE.match(name):
        inline = False
        for flag, code in zip(args, args[1:], strict=False):
            if flag in ("-c", "-e", "-E", "--eval", "-p", "--print", "-r") or re.match(r"^-[a-zA-Z]*[ce]$", flag):
                inline = True
                if SHELL_RE.match(name):
                    check_bash(code, cwd)
                else:
                    _check_code(code)
        for doc in herestr:  # `python <<< "code"` / `bash <<< "cmd"`
            if SHELL_RE.match(name):
                check_bash(doc, cwd)
            else:
                _check_code(doc)
        script = next((a for a in args if a == "-" or not a.startswith("-")), None)
        if not inline and not herestr and script in (None, "-") and _opaque_write(whole):
            # stdin からコードを読む (`echo ... | bash`, `cat x | python3 -`) → 中身を解析できない
            block(BASH_MSG)
    return outer


def check_bash(cmd: str, cwd: str = "") -> None:
    cwd = cwd or os.getcwd()
    body, heredocs = _extract_heredocs(cmd)
    for consumer, doc in heredocs:
        first = _strip_wrappers(consumer.split())
        exe = os.path.basename(first[0]) if first else ""
        if SHELL_RE.match(exe):
            check_bash(doc, cwd)
        elif INTERP_RE.match(exe):
            _check_code(doc)
    try:
        segments = _segments(body)
    except ValueError:  # 引用符の対応が取れない等 → 旧来の保守的な判定にフォールバック
        if re.search(r"--relock\b", cmd):
            block(RELOCK_MSG)
        if _mentions_protected(cmd) and not RESTORE_RE.match(cmd) and WRITE_RE.search(cmd):
            block(BASH_MSG)
        return
    for words, redirects, herestr in segments:
        cwd = _check_segment(words, redirects, herestr, cwd, body)


def main() -> int:
    if UNLOCKED:
        return 0
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    tool = data.get("tool_name", "")
    ti = data.get("tool_input", {}) or {}
    if tool == "Bash":
        check_bash(str(ti.get("command", "")), str(data.get("cwd", "") or ""))
        return 0
    if tool not in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return 0
    target = ti.get("file_path") or ti.get("notebook_path") or ""
    if not target:
        return 0
    rel = rel_path(str(target), str(data.get("cwd", "")))
    if rel == CONTRACT_REL:
        check_contract_edit(tool, ti)
    elif rel in PROTECTED_FILES or rel.startswith(PROTECTED_PREFIXES):
        block(f"{rel} はハーネスの保護ファイルです (検証器・フック・署名・設定)。AI による変更は禁止されています。\n"
              "→ 修正方法: 検証を通すために検証器側を変えるのではなく、実装コードを修正してください。"
              " 検証器自体の不具合と判断した場合は、根拠を .agent/state/progress.md に記録し人間に報告してください。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

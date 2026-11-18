"""Command line interface.

    refscope analyze song.mp3 [--artist A --title T] [--refs ref1.wav ref2.mp3] [--json out.json]
    refscope serve [--host 0.0.0.0] [--port 8000]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import socket
import sys
from pathlib import Path

from .models import PipelineOptions


def _lan_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packet is sent for UDP connect
            return s.getsockname()[0]
    except OSError:
        return None


def cmd_analyze(a: argparse.Namespace) -> int:
    from .audio.analyzer import SR, find_energy_window
    from .audio.io import load_mono
    from .core.pipeline import LocalRef, run_pipeline

    opts = PipelineOptions(country=a.country, pool_size=a.pool, top_n=a.top, min_score=a.min_score, analysis_window_sec=a.window)
    y = load_mono(a.file)
    if a.start is not None:
        s = int(a.start * SR)
        y = y[s : s + int(a.window * SR)]
    else:
        s, e = find_energy_window(y, SR, a.window)
        print(f"解析区間: {s / SR:.1f}s – {e / SR:.1f}s（最大エネルギー区間）", file=sys.stderr)
        y = y[s:e]

    async def emit(ev: dict) -> None:
        t = ev["type"]
        if t == "log" and not a.quiet:
            print(f"  {'!' if ev['level'] != 'info' else '·'} {ev['message']}", file=sys.stderr)
        elif t == "step" and ev["state"] in ("done", "skipped", "error"):
            print(f"[{ev['step']}] {ev['state']} {ev.get('detail') or ''}", file=sys.stderr)
        elif t == "scored" and not a.quiet:
            c = ev["candidate"]
            tail = f"{ev['result']['score'] * 100:5.1f}%" if ev["result"] else f"× {ev.get('error')}"
            print(f"  ({ev['done']}/{ev['total']}) {c['artist']} — {c['title']}: {tail}", file=sys.stderr)

    refs = [LocalRef(name=Path(p).name, data=Path(p)) for p in a.refs or []]
    res = asyncio.run(run_pipeline(y, Path(a.file).name, opts, manual=(a.artist or "", a.title or ""), local_refs=refs, emit=emit))

    f = res.features
    if f:
        print(f"\n入力: BPM {f.bpm:g} / {f.key.name} ({f.key.camelot}) / Swing {f.groove.swing}% / Sidechain {f.groove.sidechain_db} dB")
        g = lambda v: "".join("█" if x >= 0.66 else "▄" if x >= 0.4 else "·" for x in v)  # noqa: E731
        print(f"  Kick  {g(f.grid.kick)}\n  Snare {g(f.grid.snare)}\n  Hat   {g(f.grid.hat)}")
    if res.identification:
        print(f"同定: {res.identification.artist} — {res.identification.title} [{res.identification.source}]")
    if res.genres:
        print(f"ジャンル骨格: {res.genres.hybrid_label}")
    print(f"\nリファレンス（合格 {len(res.ranked)} 件）")
    for i, r in enumerate(res.ranked, 1):
        print(f"{i:2d}. {r.score * 100:5.1f}%  {r.candidate.artist} — {r.candidate.title}  (BPM {r.features.bpm:g})")
        for reason in r.reasons[:3]:
            print(f"      - {reason}")
        if r.candidate.track_view_url:
            print(f"      {r.candidate.track_view_url}")
    if res.explanation:
        print(f"\nAI解説: {res.explanation.overview}")
    if a.json:
        Path(a.json).write_text(json.dumps(res.dump(), ensure_ascii=False, indent=2), "utf-8")
        print(f"\nJSON → {a.json}")
    return 0


def cmd_serve(a: argparse.Namespace) -> int:
    import uvicorn

    from .config import Secrets
    from .server import create_app, web_dir

    sec = Secrets.from_env()
    ip = _lan_ip()
    print(f"RefScope サーバー起動  有効なAPI: {', '.join(sec.providers) or 'なし（iTunes/MusicBrainzのみ）'}")
    if not web_dir():
        print("! Web UI ファイルが見つかりません（REFSCOPE_WEB_DIR を設定してください）")
    print(f"  PC:     http://localhost:{a.port}/")
    if a.host in ("0.0.0.0", "::") and ip:
        url = f"http://{ip}:{a.port}/"
        print(f"  スマホ: {url}  （同じWi-Fiに接続して開く）")
        if not a.no_qr:
            try:
                import qrcode

                q = qrcode.QRCode(border=1)
                q.add_data(url)
                q.print_ascii(invert=True)
            except Exception:  # noqa: BLE001
                pass
    elif a.host not in ("0.0.0.0", "::"):
        print("  ※ スマホから使うには --host 0.0.0.0 で起動してください")
    if a.host in ("0.0.0.0", "::") and not sec.access_token:
        print("  ※ 公開ネットワークに出す場合は REFSCOPE_ACCESS_TOKEN を設定してください")
    uvicorn.run(create_app(sec), host=a.host, port=a.port, log_level="warning")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="refscope", description="グルーヴ・リズムグリッド・音色が近いリファレンス曲を探す")
    sub = p.add_subparsers(dest="cmd", required=True)
    an = sub.add_parser("analyze", help="音声ファイルを解析してリファレンスを探す")
    an.add_argument("file")
    an.add_argument("--artist")
    an.add_argument("--title")
    an.add_argument("--refs", nargs="*", help="手持ちのリファレンス音源も比較")
    an.add_argument("--start", type=float, help="解析開始位置（秒）。省略時は最大エネルギー区間")
    an.add_argument("--window", type=float, default=30)
    an.add_argument("--country", default="JP")
    an.add_argument("--pool", type=int, default=24)
    an.add_argument("--top", type=int, default=8)
    an.add_argument("--min-score", type=float, default=0.65)
    an.add_argument("--json", help="結果をJSONで保存")
    an.add_argument("-q", "--quiet", action="store_true")
    an.set_defaults(func=cmd_analyze)
    sv = sub.add_parser("serve", help="Web UI / API サーバーを起動（スマホからもアクセス可）")
    sv.add_argument("--host", default="0.0.0.0")
    sv.add_argument("--port", type=int, default=8000)
    sv.add_argument("--no-qr", action="store_true")
    sv.set_defaults(func=cmd_serve)
    a = p.parse_args(argv)
    return a.func(a)


if __name__ == "__main__":
    raise SystemExit(main())

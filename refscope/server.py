"""FastAPI server: JSON/NDJSON API + the same web UI, reachable from phones on the LAN.

    refscope serve --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import os
from pathlib import Path

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .audio.analyzer import SR, find_energy_window
from .audio.io import load_mono
from .config import Secrets
from .core.pipeline import LocalRef, run_pipeline
from .models import PipelineOptions

MAX_UPLOAD = 80 * 1024 * 1024


def web_dir() -> Path | None:
    env = os.environ.get("REFSCOPE_WEB_DIR")
    for cand in ([Path(env)] if env else []) + [Path(__file__).resolve().parents[1], Path.cwd()]:
        if (cand / "index.html").is_file() and (cand / "src" / "main.js").is_file():
            return cand
    return None


def create_app(secrets: Secrets | None = None) -> FastAPI:
    sec = secrets or Secrets.from_env()
    app = FastAPI(title="RefScope", version=__version__)
    busy = asyncio.Semaphore(int(os.environ.get("REFSCOPE_MAX_JOBS", "2")))

    def check(token: str | None) -> None:
        if not sec.access_token:
            return
        given = (token or "").removeprefix("Bearer ").strip()
        if not hmac.compare_digest(given, sec.access_token):
            raise HTTPException(401, "アクセストークンが違います")

    @app.get("/api/health")
    async def health() -> dict:
        return {"ok": True, "app": "refscope", "version": __version__, "providers": sec.providers, "auth": bool(sec.access_token)}

    @app.post("/api/analyze")
    async def analyze(
        audio: UploadFile = File(...),
        file_name: str = Form(""),
        options: str = Form("{}"),
        artist: str = Form(""),
        title: str = Form(""),
        region_start: float | None = Form(None),
        region_end: float | None = Form(None),
        local_refs: list[UploadFile] = File(default=[]),
        authorization: str | None = Header(None),
        x_refscope_token: str | None = Header(None),
    ) -> StreamingResponse:
        check(authorization or x_refscope_token)
        data = await audio.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, "ファイルが大きすぎます")
        try:
            opts = PipelineOptions.model_validate(json.loads(options or "{}"))
        except Exception as e:  # noqa: BLE001
            raise HTTPException(422, f"options が不正です: {e}") from e
        try:
            y = await asyncio.to_thread(load_mono, data)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(422, f"音声をデコードできませんでした: {e}") from e
        if region_start is not None and region_end is not None and region_end > region_start:
            y = y[int(region_start * SR) : int(region_end * SR)]
        elif len(y) > opts.analysis_window_sec * SR * 1.2:
            s, e = find_energy_window(y, SR, opts.analysis_window_sec)
            y = y[s:e]
        refs = [LocalRef(name=f.filename or f"ref{i}", data=await f.read()) for i, f in enumerate(local_refs)]

        queue: asyncio.Queue[dict | None] = asyncio.Queue()

        async def emit(ev: dict) -> None:
            await queue.put(ev)

        async def job() -> None:
            try:
                async with busy:
                    await run_pipeline(y, file_name or audio.filename or "", opts, sec, (artist, title), refs, emit)
                await queue.put({"type": "done"})
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                await queue.put({"type": "error", "message": str(e)})
            finally:
                await queue.put(None)

        task = asyncio.create_task(job())

        async def stream():
            try:
                while (ev := await queue.get()) is not None:
                    yield json.dumps(ev, ensure_ascii=False) + "\n"
            finally:
                if not task.done():
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task

        return StreamingResponse(stream(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    web = web_dir()
    if web:
        @app.get("/", include_in_schema=False)
        async def index() -> FileResponse:
            return FileResponse(web / "index.html")

        for sub in ("assets", "src"):
            app.mount(f"/{sub}", StaticFiles(directory=web / sub), name=sub)
        @app.get("/manifest.webmanifest", include_in_schema=False)
        async def manifest() -> FileResponse:
            return FileResponse(web / "manifest.webmanifest", media_type="application/manifest+json")
    else:
        @app.get("/", include_in_schema=False)
        async def no_ui() -> JSONResponse:
            return JSONResponse({"message": "RefScope API is running. Web UI files not found (set REFSCOPE_WEB_DIR)."})

    return app

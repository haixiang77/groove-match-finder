"""Shared async HTTP client with retries."""

from __future__ import annotations

import asyncio

import httpx

USER_AGENT = "RefScope/1.0 (+https://github.com/)"


def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(30.0), headers={"User-Agent": USER_AGENT}, follow_redirects=True)


async def get_json(c: httpx.AsyncClient, url: str, params: dict | None = None, retries: int = 2):
    for attempt in range(retries + 1):
        r = await c.get(url, params=params)
        if r.status_code in (429, 500, 502, 503, 504) and attempt < retries:
            await asyncio.sleep(float(r.headers.get("retry-after", 0)) or 0.8 * 2**attempt)
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError("unreachable")

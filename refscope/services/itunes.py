"""iTunes Search API — metadata + 30 s previews (no key, ≈20 req/min)."""

from __future__ import annotations

from datetime import datetime

import httpx
from pydantic import BaseModel

from ..models import Candidate
from ..util import RateLimiter, text_similarity, track_key
from .http import get_json

limiter = RateLimiter(capacity=12, refill_s=3.2)
_cache: dict[str, list["ItunesTrack"]] = {}


class ItunesTrack(BaseModel):
    trackId: int
    trackName: str
    artistName: str
    collectionName: str | None = None
    previewUrl: str | None = None
    artworkUrl100: str | None = None
    trackViewUrl: str | None = None
    primaryGenreName: str | None = None
    releaseDate: str | None = None
    kind: str | None = None


async def search_songs(c: httpx.AsyncClient, term: str, country: str = "JP", limit: int = 15,
                       attribute: str | None = None, on_wait=None) -> list[ItunesTrack]:
    params = {"term": term, "media": "music", "entity": "song", "limit": limit, "country": country}
    if attribute:
        params["attribute"] = attribute
    key = repr(sorted(params.items()))
    if key in _cache:
        return _cache[key]
    await limiter.acquire(on_wait)
    data = await get_json(c, "https://itunes.apple.com/search", params)
    out = []
    for r in data.get("results", []):
        try:
            t = ItunesTrack.model_validate(r)
        except Exception:  # noqa: BLE001 — skip malformed rows
            continue
        if not t.kind or t.kind == "song":
            out.append(t)
    _cache[key] = out
    return out


async def resolve_track(c: httpx.AsyncClient, artist: str, title: str, country: str = "JP", on_wait=None) -> ItunesTrack | None:
    best, best_score = None, 0.0
    for r in await search_songs(c, f"{artist} {title}", country, 8, on_wait=on_wait):
        sc = 0.55 * text_similarity(r.trackName, title) + 0.45 * text_similarity(r.artistName, artist)
        if sc > best_score:
            best, best_score = r, sc
    return best if best_score >= 0.62 else None


def to_candidate(t: ItunesTrack, source: str, weight: float) -> Candidate:
    year = None
    if t.releaseDate:
        try:
            year = datetime.fromisoformat(t.releaseDate.replace("Z", "+00:00")).year
        except ValueError:
            year = None
    return Candidate(
        key=track_key(t.artistName, t.trackName), artist=t.artistName, title=t.trackName, sources=[source], weight=weight,
        preview_url=t.previewUrl, artwork_url=(t.artworkUrl100 or "").replace("100x100bb", "200x200bb") or None,
        track_view_url=t.trackViewUrl, genre=t.primaryGenreName, itunes_id=t.trackId, album=t.collectionName, release_year=year,
    )

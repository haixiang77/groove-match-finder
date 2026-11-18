"""MusicBrainz genres/tags via musicbrainzngs (no key, 1 req/s handled by the library)."""

from __future__ import annotations

import asyncio

import musicbrainzngs

from .. import __version__
from ..util import text_similarity

musicbrainzngs.set_useragent("RefScope", __version__, "https://github.com/")


def _tags(entity: dict) -> list[tuple[str, int]]:
    out = []
    for key in ("genre-list", "tag-list"):
        for t in entity.get(key, []) or []:
            out.append((t.get("name", ""), int(t.get("count", 1) or 1)))
    return out


async def recording_tags(artist: str, title: str, isrc: str | None = None) -> list[tuple[str, float]]:
    def go() -> list[tuple[str, float]]:
        recs: list[dict] = []
        if isrc:
            try:
                recs = musicbrainzngs.get_recordings_by_isrc(isrc, includes=["tags", "artists"]).get("isrc", {}).get("recording-list", [])
            except musicbrainzngs.WebServiceError:
                recs = []
        if not recs:
            res = musicbrainzngs.search_recordings(recording=title, artist=artist, limit=5)
            recs = [r for r in res.get("recording-list", []) if text_similarity(r.get("title", ""), title) > 0.6]
        tags: dict[str, int] = {}
        for r in recs[:3]:
            for name, cnt in _tags(r):
                tags[name] = tags.get(name, 0) + cnt
        credit = (recs[0].get("artist-credit") or [{}])[0] if recs else {}
        artist_id = credit.get("artist", {}).get("id") if isinstance(credit, dict) else None
        if len(tags) < 2 and artist_id:
            try:
                a = musicbrainzngs.get_artist_by_id(artist_id, includes=["tags"])["artist"]
                for name, cnt in _tags(a):
                    tags[name] = tags.get(name, 0) + cnt
            except musicbrainzngs.WebServiceError:
                pass
        mx = max(list(tags.values()) + [1])
        return [(n, c / mx) for n, c in sorted(tags.items(), key=lambda x: -x[1])[:12] if n]

    return await asyncio.to_thread(go)

"""Last.fm via pylast (blocking → run in a thread)."""

from __future__ import annotations

import asyncio

import pylast


class LastFm:
    def __init__(self, api_key: str) -> None:
        self.net = pylast.LastFMNetwork(api_key=api_key)

    async def _run(self, fn, *args):
        return await asyncio.to_thread(fn, *args)

    async def similar_tracks(self, artist: str, title: str, limit: int = 40) -> list[tuple[str, str, float]]:
        def go():
            items = self.net.get_track(artist, title).get_similar(limit=limit)
            return [(str(i.item.artist), i.item.title, float(i.match)) for i in items]
        return await self._run(go)

    async def track_tags(self, artist: str, title: str) -> list[tuple[str, float]]:
        def go():
            tags = self.net.get_track(artist, title).get_top_tags(limit=15)
            if len(tags) < 3:
                tags += self.net.get_artist(artist).get_top_tags(limit=15)
            mx = max([float(t.weight or 0) for t in tags] + [1.0])
            return [(t.item.get_name(), float(t.weight or mx / 2) / mx) for t in tags]
        return await self._run(go)

    async def similar_artists(self, artist: str, limit: int = 5) -> list[tuple[str, float]]:
        def go():
            return [(i.item.get_name(), float(i.match)) for i in self.net.get_artist(artist).get_similar(limit=limit)]
        return await self._run(go)

    async def artist_top_tracks(self, artist: str, limit: int = 3) -> list[tuple[str, str]]:
        def go():
            return [(str(t.item.artist), t.item.title) for t in self.net.get_artist(artist).get_top_tracks(limit=limit)]
        return await self._run(go)

    async def tag_top_tracks(self, tag: str, limit: int = 12) -> list[tuple[str, str]]:
        def go():
            return [(str(t.item.artist), t.item.title) for t in self.net.get_tag(tag).get_top_tracks(limit=limit)]
        return await self._run(go)

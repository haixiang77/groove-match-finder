"""Step 2 — candidate pool: merge, de-duplicate, diversify."""

from __future__ import annotations

from ..models import Candidate
from ..util import track_key


class CandidatePool:
    def __init__(self, exclude: list[str] | None = None) -> None:
        self.items: dict[str, Candidate] = {}
        self.exclude = set(k for k in (exclude or []) if k)

    def add(self, c: Candidate) -> None:
        if not c.artist or not c.title:
            return
        key = c.key or track_key(c.artist, c.title)
        if key in self.exclude:
            return
        prev = self.items.get(key)
        if prev is None:
            self.items[key] = c.model_copy(update={"key": key, "sources": list(c.sources)})
            return
        prev.weight += c.weight * 0.6
        prev.sources.extend(s for s in c.sources if s not in prev.sources)
        for f in ("preview_url", "artwork_url", "track_view_url", "genre", "itunes_id", "album", "release_year", "local_path"):
            if getattr(prev, f) is None and getattr(c, f) is not None:
                setattr(prev, f, getattr(c, f))

    def __len__(self) -> int:
        return len(self.items)

    def shortlist(self, limit: int, per_artist: int = 2) -> list[Candidate]:
        ranked = sorted(self.items.values(), key=lambda c: -c.weight)
        local = [c for c in ranked if c.local_path]
        out = list(local)
        counts: dict[str, int] = {}
        for c in ranked:
            if c.local_path:
                continue
            if len(out) >= limit + len(local):
                break
            a = c.artist.lower()
            if counts.get(a, 0) >= per_artist:
                continue
            counts[a] = counts.get(a, 0) + 1
            out.append(c)
        return out

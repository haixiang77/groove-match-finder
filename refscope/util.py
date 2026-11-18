"""Text normalisation, fuzzy matching, async rate limiting."""

from __future__ import annotations

import asyncio
import re
import time
import unicodedata

_PAREN = re.compile(r"\s*[(\[（【].*?(feat|ft\.|with|remaster|version|edit|mix|live|mono|stereo|ver\.|bonus).*?[)\]）】]")
_DASH = re.compile(r"\s+-\s+.*(remaster|version|edit|mix|live).*$")
_FEAT = re.compile(r"\s+(feat\.?|ft\.?)\s+.*$")
_PUNCT = re.compile(r"[\s'\"’`.,!?！？・:;/\\\-–—_~〜()\[\]（）「」『』]+")


def normalize_text(text: str) -> str:
    t = unicodedata.normalize("NFKC", text).lower()
    t = _PAREN.sub("", t)
    t = _DASH.sub("", t)
    t = _FEAT.sub("", t)
    return _PUNCT.sub("", t).strip()


def track_key(artist: str, title: str) -> str:
    return f"{normalize_text(artist)}|{normalize_text(title)}"


def text_similarity(a: str, b: str) -> float:
    """Sørensen–Dice on character bigrams of the normalised strings."""
    x, y = normalize_text(a), normalize_text(b)
    if not x or not y:
        return 0.0
    if x == y:
        return 1.0
    if len(x) < 2 or len(y) < 2:
        return 0.8 if (x in y or y in x) else 0.0
    grams: dict[str, int] = {}
    for i in range(len(x) - 1):
        grams[x[i : i + 2]] = grams.get(x[i : i + 2], 0) + 1
    hits = 0
    for i in range(len(y) - 1):
        g = y[i : i + 2]
        if grams.get(g, 0) > 0:
            hits += 1
            grams[g] -= 1
    dice = 2 * hits / (len(x) - 1 + len(y) - 1)
    return max(dice, 0.85 if (x in y or y in x) else 0.0)


def parse_file_name(name: str) -> tuple[str, str] | None:
    """'01 - Artist - Title.mp3' → ('Artist', 'Title')."""
    base = re.sub(r"\.[a-z0-9]{2,5}$", "", name, flags=re.I).replace("_", " ")
    base = re.sub(r"^\d{1,3}[\s.-]+", "", base).strip()
    m = re.match(r"^(.+?)\s+[-–—]\s+(.+)$", base)
    return (m.group(1).strip(), m.group(2).strip()) if m else None


class RateLimiter:
    """Async token bucket (iTunes ≈ 20 req/min, MusicBrainz 1 req/s)."""

    def __init__(self, capacity: float, refill_s: float) -> None:
        self.capacity = capacity
        self.tokens = capacity
        self.refill_s = refill_s
        self.last = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self, on_wait=None) -> None:
        async with self._lock:
            now = time.monotonic()
            self.tokens = min(self.capacity, self.tokens + (now - self.last) / self.refill_s)
            self.last = now
            if self.tokens < 1:
                wait = (1 - self.tokens) * self.refill_s
                if on_wait:
                    on_wait(wait)
                await asyncio.sleep(wait)
                self.tokens = 1
                self.last = time.monotonic()
            self.tokens -= 1

"""Fake iTunes catalogue served through httpx.MockTransport (synthetic previews)."""

import io
from urllib.parse import parse_qs, urlparse

import httpx
import soundfile as sf

from synth import PATTERNS, synth_loop


def wav(x, sr=22050) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, x / max(1.0, abs(x).max()), sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


PAD = [261.6, 329.6, 392]
CATALOGUE = [
    (1, "Nova Lane", "Pump It Slow", lambda: synth_loop(125, 14, **PATTERNS["house"], chord=[293.7, 370, 440], pump=True, seed=5)),
    (2, "Disco Ghost", "Glitter Floor", lambda: synth_loop(122, 14, **PATTERNS["house"], chord=PAD, seed=6)),
    (3, "Velvet Ops", "Night Shift", lambda: synth_loop(127, 14, **PATTERNS["house"], chord=[220, 277.2, 329.6], pump=True, seed=7)),
    (4, "Gray Fog", "808 Ritual", lambda: synth_loop(140, 14, **PATTERNS["trap"], kick_decay=0.6)),
    (5, "Mono Block", "Dusty Tape", lambda: synth_loop(90, 14, **PATTERNS["boombap"])),
    (6, "Calle Nueve", "Perreo Lunar", lambda: synth_loop(95, 14, **PATTERNS["reggaeton"])),
]
_AUDIO: dict[int, bytes] = {}


def input_loop():
    return synth_loop(124, 20, **PATTERNS["house"], chord=PAD, pump=True)


def _track(i, artist, title):
    return {"kind": "song", "trackId": i, "trackName": title, "artistName": artist, "collectionName": "Mock",
            "previewUrl": f"https://audio-ssl.itunes.apple.com/mock/{i}.m4a", "artworkUrl100": f"https://is1-ssl.mzstatic.com/{i}/100x100bb.jpg",
            "trackViewUrl": f"https://music.apple.com/jp/album/mock/{i}", "primaryGenreName": "Dance", "releaseDate": "2021-01-01T00:00:00Z"}


def handler(request: httpx.Request) -> httpx.Response:
    u = urlparse(str(request.url))
    if u.netloc == "itunes.apple.com":
        term = parse_qs(u.query).get("term", [""])[0]
        if "test song" in term.lower():
            return httpx.Response(200, json={"resultCount": 1, "results": [_track(99, "Test Artist", "Test Song")]})
        return httpx.Response(200, json={"resultCount": len(CATALOGUE), "results": [_track(i, a, t) for i, a, t, _ in CATALOGUE]})
    if u.netloc == "audio-ssl.itunes.apple.com":
        i = int(u.path.rsplit("/", 1)[-1].split(".")[0])
        if i not in _AUDIO:
            _AUDIO[i] = wav(next(f for j, _, _, f in CATALOGUE if j == i)())
        return httpx.Response(200, content=_AUDIO[i])
    return httpx.Response(404)


def install(monkeypatch):
    import refscope.core.pipeline as p
    import refscope.services.fingerprint as fp
    import refscope.services.itunes as it

    it._cache.clear()
    it.limiter.tokens = it.limiter.capacity = 100
    monkeypatch.setattr(p, "client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    async def no_match(_wav):
        return None

    async def no_tags(*_a, **_k):
        return []

    monkeypatch.setattr(fp, "identify_shazam", no_match)
    monkeypatch.setattr(p, "recording_tags", no_tags)

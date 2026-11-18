"""Step 1a — audio fingerprint identification.

Order: shazamio (Shazam, free, no key) → AudD → ACRCloud.
Each receives a ~12 s WAV excerpt around the loudest section.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import time

import httpx

from ..models import Identification


async def identify_shazam(wav: bytes) -> Identification | None:
    from shazamio import Shazam

    shazam = Shazam()
    try:
        out = await shazam.recognize(wav)
    finally:
        close = getattr(getattr(shazam, "http_client", None), "close", None)
        if close:
            await close()
    track = out.get("track") if isinstance(out, dict) else None
    if not track:
        return None
    apple_id = None
    for action in (track.get("hub", {}) or {}).get("actions", []) or []:
        if action.get("type") == "applemusicplay":
            apple_id = action.get("id")
    genre = (track.get("genres") or {}).get("primary")
    return Identification(
        title=track.get("title", ""), artist=track.get("subtitle", ""), source="shazam", confidence=0.95,
        isrc=track.get("isrc"), apple_music_id=apple_id, genre_tags=[genre] if genre else None,
    )


async def identify_audd(c: httpx.AsyncClient, wav: bytes, token: str) -> Identification | None:
    r = await c.post("https://api.audd.io/", data={"api_token": token, "return": "apple_music,spotify"},
                     files={"file": ("excerpt.wav", wav, "audio/wav")})
    r.raise_for_status()
    data = r.json()
    if data.get("status") != "success":
        raise RuntimeError(f"AudD: {(data.get('error') or {}).get('error_message', 'error')}")
    res = data.get("result")
    if not res:
        return None
    am = res.get("apple_music") or {}
    url = am.get("url") or ""
    m = re.search(r"[?&]i=(\d+)", url) or re.search(r"/(\d+)(?:\?|$)", url)
    return Identification(
        title=res["title"], artist=res["artist"], album=res.get("album"), source="audd", confidence=0.95,
        isrc=am.get("isrc") or ((res.get("spotify") or {}).get("external_ids") or {}).get("isrc"),
        apple_music_id=m.group(1) if m else None,
    )


async def identify_acrcloud(c: httpx.AsyncClient, wav: bytes, host: str, key: str, secret: str) -> Identification | None:
    ts = str(int(time.time()))
    sign = "\n".join(["POST", "/v1/identify", key, "audio", "1", ts])
    sig = base64.b64encode(hmac.new(secret.encode(), sign.encode(), hashlib.sha1).digest()).decode()
    host = re.sub(r"^https?://", "", host).rstrip("/")
    r = await c.post(f"https://{host}/v1/identify",
                     data={"access_key": key, "sample_bytes": str(len(wav)), "data_type": "audio",
                           "signature_version": "1", "signature": sig, "timestamp": ts},
                     files={"sample": ("excerpt.wav", wav, "audio/wav")})
    r.raise_for_status()
    data = r.json()
    code = (data.get("status") or {}).get("code")
    if code == 1001:
        return None
    if code != 0:
        raise RuntimeError(f"ACRCloud: {(data.get('status') or {}).get('msg')}")
    music = ((data.get("metadata") or {}).get("music") or [None])[0]
    if not music:
        return None
    return Identification(
        title=music["title"], artist=", ".join(a["name"] for a in music.get("artists", [])) or "Unknown",
        album=(music.get("album") or {}).get("name"), source="acrcloud", confidence=min(1.0, music.get("score", 80) / 100),
        isrc=(music.get("external_ids") or {}).get("isrc"), genre_tags=[g["name"] for g in music.get("genres", [])] or None,
    )

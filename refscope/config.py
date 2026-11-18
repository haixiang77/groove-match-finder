"""Secrets and server configuration from environment variables (or a .env file).

API keys live on the server only — they are never sent to the browser.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv(path: Path = Path(".env")) -> None:
    if not path.is_file():
        return
    for line in path.read_text("utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


@dataclass(frozen=True)
class Secrets:
    shazam_enabled: bool = True
    audd_token: str = ""
    acr_host: str = ""
    acr_key: str = ""
    acr_secret: str = ""
    lastfm_key: str = ""
    gemini_key: str = ""
    gemini_model: str = "gemini-2.5-flash"
    access_token: str = ""  # optional password for the web server
    providers: list[str] = field(default_factory=list)

    @classmethod
    def from_env(cls) -> "Secrets":
        _load_dotenv()
        e = os.environ.get
        s = cls(
            shazam_enabled=e("REFSCOPE_SHAZAM", "1").lower() not in ("0", "false", "no"),
            audd_token=e("AUDD_API_TOKEN", ""),
            acr_host=e("ACRCLOUD_HOST", ""),
            acr_key=e("ACRCLOUD_ACCESS_KEY", ""),
            acr_secret=e("ACRCLOUD_ACCESS_SECRET", ""),
            lastfm_key=e("LASTFM_API_KEY", ""),
            gemini_key=e("GEMINI_API_KEY", ""),
            gemini_model=e("GEMINI_MODEL", "gemini-2.5-flash"),
            access_token=e("REFSCOPE_ACCESS_TOKEN", ""),
        )
        providers = [name for name, on in (
            ("shazam", s.shazam_enabled), ("audd", bool(s.audd_token)),
            ("acrcloud", bool(s.acr_key and s.acr_secret and s.acr_host)),
            ("lastfm", bool(s.lastfm_key)), ("gemini", bool(s.gemini_key)),
        ) if on]
        object.__setattr__(s, "providers", providers)
        return s

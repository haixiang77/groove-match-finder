"""Audio loading (librosa / ffmpeg), excerpts and WAV encoding."""

from __future__ import annotations

import io
import tempfile
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from .analyzer import SR


def load_mono(source: str | Path | bytes, sr: int = SR) -> np.ndarray:
    """Decode any format librosa/soundfile/ffmpeg can read to mono float32 at `sr`."""
    if isinstance(source, (bytes, bytearray)):
        try:
            data, file_sr = sf.read(io.BytesIO(source), dtype="float32", always_2d=True)
            y = data.mean(axis=1)
            return librosa.resample(y, orig_sr=file_sr, target_sr=sr) if file_sr != sr else y
        except Exception:  # noqa: BLE001 — e.g. AAC/m4a: fall back to ffmpeg via a temp file
            with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as tmp:
                tmp.write(source)
                path = tmp.name
            try:
                y, _ = librosa.load(path, sr=sr, mono=True)
            finally:
                Path(path).unlink(missing_ok=True)
            return y
    y, _ = librosa.load(str(source), sr=sr, mono=True)
    return y


def to_wav(samples: np.ndarray, sr: int = SR) -> bytes:
    peak = float(np.abs(samples).max()) if len(samples) else 0.0
    x = samples / peak if peak > 1 else samples
    buf = io.BytesIO()
    sf.write(buf, x.astype(np.float32), sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def excerpt(region: np.ndarray, sec: float, sr: int = SR) -> bytes:
    mid = len(region) // 2
    half = int(sec / 2 * sr)
    return to_wav(region[max(0, mid - half) : min(len(region), mid + half)], sr)

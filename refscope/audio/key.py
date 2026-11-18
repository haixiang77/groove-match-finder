"""Key estimation: chromagram + Krumhansl–Schmuckler profiles."""

from __future__ import annotations

import librosa
import numpy as np

from ..models import KeyEstimate
from .dsp import pearson

PITCH_NAMES = ["C", "C#", "D", "E♭", "E", "F", "F#", "G", "A♭", "A", "B♭", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def camelot(tonic: int, mode: str) -> str:
    major_tonic = tonic if mode == "major" else (tonic + 3) % 12
    num = (((major_tonic * 7) % 12) + 7) % 12 + 1
    return f"{num}{'B' if mode == 'major' else 'A'}"


def estimate_key(x: np.ndarray, sr: int) -> KeyEstimate:
    nfft, hop = 4096, 2048
    mag = np.abs(librosa.stft(x.astype(np.float32), n_fft=nfft, hop_length=hop, center=True, pad_mode="constant"))
    bin_hz = sr / nfft
    lo, hi = int(np.ceil(100 / bin_hz)), min(nfft // 2, int(np.floor(2200 / bin_hz)))
    bins = np.arange(lo, hi + 1)
    pcs = (np.round(69 + 12 * np.log2(bins * bin_hz / 440)).astype(int)) % 12
    frame = np.zeros((12, mag.shape[1]))
    np.add.at(frame, pcs, np.log1p(10 * mag[bins]))
    mx = frame.max(axis=0)
    ok = mx > 1e-6
    chroma = (frame[:, ok] / mx[ok]).sum(axis=1)

    scores = []
    for t in range(12):
        scores.append((pearson(chroma, np.roll(MAJOR, t)), t, "major"))
        scores.append((pearson(chroma, np.roll(MINOR, t)), t, "minor"))
    scores.sort(key=lambda s: -s[0])
    r, tonic, mode = scores[0]
    conf = max(0.0, min(1.0, r * 0.6 + (r - scores[1][0]) * 4))
    return KeyEstimate(tonic=tonic, mode=mode, name=f"{PITCH_NAMES[tonic]} {mode}", camelot=camelot(tonic, mode), confidence=conf)


def key_compatibility(a: KeyEstimate, b: KeyEstimate) -> float:
    pa, pb = int(a.camelot[:-1]), int(b.camelot[:-1])
    la, lb = a.camelot[-1], b.camelot[-1]
    d = min((pa - pb) % 12, (pb - pa) % 12)
    if d == 0 and la == lb:
        return 1.0
    if d == 0:
        return 0.85
    if d == 1 and la == lb:
        return 0.75
    if d == 1:
        return 0.55
    if d == 2:
        return 0.4
    return 0.2

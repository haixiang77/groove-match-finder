"""Numeric helpers shared by the analysis modules (numpy ports of src/audio/dsp.js)."""

from __future__ import annotations

import math

import numpy as np
from scipy.ndimage import minimum_filter1d

Array = np.ndarray


def rms_envelope(x: Array, win: int, hop: int) -> Array:
    """Centred frame RMS (frame i is centred on sample i*hop)."""
    n = len(x)
    frames = n // hop + 1
    cum = np.concatenate([[0.0], np.cumsum(x.astype(np.float64) ** 2)])
    centres = np.arange(frames) * hop
    half = win // 2
    a = np.clip(centres - half, 0, n)
    b = np.clip(centres + half, 0, n)
    return np.sqrt(np.maximum(cum[b] - cum[a], 0) / win)


def onset_from_envelope(env: Array, lag: int = 1) -> Array:
    """Log-compressed envelope → first difference → half-wave rectified."""
    out = np.zeros_like(env, dtype=np.float64)
    mx = float(env.max()) if len(env) else 0.0
    if mx <= 0:
        return out
    log = np.log1p(100 * env / mx)
    out[lag:] = np.maximum(0, log[lag:] - log[:-lag])
    return out


def moving_average(x: Array, w: int) -> Array:
    n = len(x)
    half = max(1, w // 2)
    cum = np.concatenate([[0.0], np.cumsum(x, dtype=np.float64)])
    idx = np.arange(n)
    a = np.maximum(0, idx - half)
    b = np.minimum(n - 1, idx + half) + 1
    return (cum[b] - cum[a]) / (b - a)


def min_filter(x: Array, width: int) -> Array:
    half = width // 2
    return minimum_filter1d(np.asarray(x, dtype=np.float64), size=2 * half + 1, mode="nearest")


def window_max(a: Array, pos: float, radius: float) -> float:
    lo = max(0, math.floor(pos - radius))
    hi = min(len(a) - 1, math.ceil(pos + radius))
    if hi < lo:
        return 0.0
    return max(0.0, float(a[lo : hi + 1].max()))


def parabolic_offset(a: Array, i: int) -> float:
    if i <= 0 or i >= len(a) - 1:
        return 0.0
    left, c, right = float(a[i - 1]), float(a[i]), float(a[i + 1])
    d = left - 2 * c + right
    if abs(d) < 1e-12:
        return 0.0
    return max(-0.5, min(0.5, 0.5 * (left - right) / d))


def interp(a: Array, pos: float | Array) -> float | Array:
    return np.interp(pos, np.arange(len(a)), a)


def cosine(a: Array, b: Array) -> float:
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    na, nb = float(a @ a), float(b @ b)
    return float(a @ b / math.sqrt(na * nb)) if na > 0 and nb > 0 else 0.0


def pearson(a: Array, b: Array) -> float:
    a = np.asarray(a, dtype=np.float64) - np.mean(a)
    b = np.asarray(b, dtype=np.float64) - np.mean(b)
    na, nb = float(a @ a), float(b @ b)
    return float(a @ b / math.sqrt(na * nb)) if na > 1e-12 and nb > 1e-12 else 0.0


def db(x: float) -> float:
    return 20 * math.log10(max(x, 1e-9))


def c01(v: float) -> float:
    return max(0.0, min(1.0, v))


def r2(v: float) -> float:
    return round(v * 100) / 100

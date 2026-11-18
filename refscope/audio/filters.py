"""Butterworth band separation with SciPy (zero-phase sosfiltfilt)."""

from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfiltfilt


def _sos(kind: str, order: int, cutoff: float, sr: int) -> np.ndarray:
    nyq = sr / 2
    wn = min(max(cutoff, 1.0), nyq * 0.99) / nyq
    return butter(order, wn, btype=kind, output="sos")


def lowpass(x: np.ndarray, cutoff: float, sr: int, order: int = 4) -> np.ndarray:
    return sosfiltfilt(_sos("lowpass", order, cutoff, sr), x)


def highpass(x: np.ndarray, cutoff: float, sr: int, order: int = 4) -> np.ndarray:
    return sosfiltfilt(_sos("highpass", order, cutoff, sr), x)


def bandpass(x: np.ndarray, lo: float, hi: float, sr: int, order: int = 4) -> np.ndarray:
    """High-pass + low-pass cascade (same response as the web version)."""
    sos = np.vstack([_sos("highpass", order, lo, sr), _sos("lowpass", order, hi, sr)])
    return sosfiltfilt(sos, x)

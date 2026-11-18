"""Tempo estimation and DP beat tracking (port of src/audio/tempo.js)."""

from __future__ import annotations

import math

import numpy as np

from .dsp import interp, parabolic_offset


def estimate_tempo(onset: np.ndarray, fps: float, min_bpm: float = 60, max_bpm: float = 200,
                   prior_bpm: float = 120, prior_std: float = 1.0) -> tuple[float, float, list[float]]:
    """Returns (bpm, confidence, candidates)."""
    n = len(onset)
    x = onset.astype(np.float64) - onset.mean()
    min_lag = max(1, math.floor(60 * fps / max_bpm))
    max_lag = min(n - 2, math.ceil(60 * fps / min_bpm))
    if max_lag <= min_lag + 2:
        return 120.0, 0.0, [120.0]
    ac0 = float(x @ x) / n or 1.0
    ac_len = min(n - 1, max_lag * 4 + 2)
    full = np.correlate(x, x, mode="full")[n - 1 :]
    lags = np.arange(ac_len + 1)
    ac = np.zeros(ac_len + 1)
    ac[1:] = full[1 : ac_len + 1] / (n - lags[1:]) / ac0

    def ac_at(lag: int, m: int) -> float:
        lo = max(1, round(m * (lag - 0.5)))
        hi = min(ac_len, round(m * (lag + 0.5)))
        return max(0.0, float(ac[lo : hi + 1].max())) if hi >= lo else 0.0

    score = np.zeros(ac_len + 1)
    for lag in range(min_lag, max_lag + 1):
        bpm = 60 * fps / lag
        prior = math.exp(-0.5 * (math.log2(bpm / prior_bpm) / prior_std) ** 2)
        score[lag] = (max(0.0, ac[lag]) + 0.5 * ac_at(lag, 2) + 0.8 * ac_at(lag, 4)) * prior

    peaks = [(lag, score[lag]) for lag in range(min_lag + 1, max_lag)
             if score[lag] > score[lag - 1] and score[lag] >= score[lag + 1] and score[lag] > 0]
    if not peaks:
        return 120.0, 0.0, [120.0]
    peaks.sort(key=lambda p: -p[1])
    best_lag, best_v = peaks[0]
    period = refine_period(onset, best_lag + parabolic_offset(score, best_lag))
    bpm = 60 * fps / period
    if abs(bpm - round(bpm)) < 0.3:
        bpm = float(round(bpm))
    sl = score[min_lag : max_lag + 1]
    z = (best_v - sl.mean()) / (sl.std() + 1e-9)
    confidence = max(0.0, min(1.0, 1 - math.exp(-z / 4)))
    candidates = [round(60 * fps / (lag + parabolic_offset(score, lag)), 1) for lag, _ in peaks[:3]]
    return round(bpm, 2), confidence, candidates


def refine_period(onset: np.ndarray, period: float) -> float:
    """Comb-filter refinement: the period collecting the most onset energy wins."""
    best_p, best = period, -math.inf
    xs = np.arange(len(onset))
    r = 0.97
    while r <= 1.0301:
        p = period * r
        for ph in range(math.ceil(p)):
            pos = np.arange(ph, len(onset) - 1, p)
            if len(pos) == 0:
                continue
            sc = float(np.interp(pos, xs, onset).mean())
            if sc > best:
                best, best_p = sc, p
        r += 0.0015
    return best_p


def track_beats(onset: np.ndarray, fps: float, bpm: float, tightness: float = 100) -> list[float]:
    """Ellis (2007) dynamic-programming beat tracker."""
    n = len(onset)
    period = 60 * fps / bpm
    if n < period * 4:
        return []
    sd = onset.std() or 1.0
    sigma = max(0.5, period / 32)
    radius = math.ceil(sigma * 3)
    k = np.arange(-radius, radius + 1)
    kernel = np.exp(-0.5 * (k / sigma) ** 2)
    local = np.convolve(onset / sd, kernel, mode="same") if n >= len(kernel) else onset / sd

    lo, hi = round(period / 2), round(period * 2)
    offsets = np.arange(hi, lo - 1, -1)  # t - tau, for tau = t-hi .. t-lo
    txwt = -tightness * np.log(offsets / period) ** 2
    cum = np.zeros(n)
    back = np.full(n, -1, dtype=np.int64)
    local_max = float(local.max())
    first_beat = True
    for t in range(n):
        taus = t - offsets
        valid = taus >= 0
        bi = -1
        best = 0.0
        if valid.any():
            cand = cum[taus[valid]] + txwt[valid]
            j = int(np.argmax(cand))
            best, bi = float(cand[j]), int(taus[valid][j])
        cum[t] = local[t] + (best if bi >= 0 else 0)
        if first_beat and local[t] < 0.01 * local_max:
            back[t] = -1
        else:
            back[t] = bi
            first_beat = False

    maxima = [i for i in range(1, n - 1) if cum[i] > cum[i - 1] and cum[i] >= cum[i + 1]]
    if not maxima:
        return []
    thr = 0.5 * float(np.median(cum[maxima]))
    last = next((m for m in reversed(maxima) if cum[m] >= thr), maxima[-1])
    beats: list[int] = []
    b = last
    while b >= 0:
        beats.append(b)
        if back[b] == b:
            break
        b = int(back[b])
    beats.reverse()
    out = []
    for b in beats:
        j = np.arange(max(0, b - 2), min(n, b + 3))
        w = local[j] ** 2
        out.append(float((j * w).sum() / w.sum()) if w.sum() > 0 else float(b))
    return out


def regularise_beats(beats: list[float], period: float, n_frames: int, onset: np.ndarray) -> list[float]:
    if len(beats) < 4:
        xs = np.arange(len(onset))
        best_ph, best = 0, -1.0
        for ph in range(math.ceil(period)):
            s = float(np.interp(np.arange(ph, n_frames, period), xs, onset).sum())
            if s > best:
                best, best_ph = s, ph
        return list(np.arange(best_ph, n_frames, period).astype(float))
    out = [beats[0]]
    for b in beats[1:]:
        prev = out[-1]
        gap = b - prev
        if gap < period * 0.6:
            continue
        k = round(gap / period)
        out.extend(prev + gap * j / k for j in range(1, k))
        out.append(b)
    return out


def smooth_beats(beats: list[float], radius: int = 8) -> list[float]:
    """Robust local linear fit (removes syncopation-induced beat jitter)."""
    if len(beats) < 5:
        return beats
    y = np.asarray(beats, dtype=np.float64)

    def fit(idx: np.ndarray) -> tuple[float, float]:
        if len(idx) < 2:
            return 0.0, float(y[idx].mean())
        slope, icpt = np.polyfit(idx, y[idx], 1)
        return float(slope), float(icpt)

    out = []
    for i in range(len(y)):
        a, b = max(0, i - radius), min(len(y) - 1, i + radius)
        idx = np.arange(a, b + 1)
        slope, icpt = fit(idx)
        for _ in range(3):
            tol = 0.08 * abs(slope)
            inl = idx[np.abs(y[idx] - (icpt + slope * idx)) <= tol]
            if len(inl) < 4 or len(inl) == len(idx):
                break
            slope, icpt = fit(inl)
        out.append(icpt + slope * i)
    return out

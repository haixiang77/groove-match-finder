"""Synthetic drum loops — exact port of tests/synth.js (same PRNG → same signal)."""

from __future__ import annotations

import math

import numpy as np


def _imul(a: int, b: int) -> int:
    return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF


def _rng(seed: int):
    a = seed & 0xFFFFFFFF

    def nxt() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return nxt


def synth_loop(bpm: float, bars: int = 12, sr: int = 22050, kick=(), snare=(), hat=(), swing: float = 50,
               kick_decay: float = 0.18, chord=None, pump: bool = False, seed: int = 1) -> np.ndarray:
    step_dur = 60 / bpm / 4
    n = math.ceil(bars * 16 * step_dur * sr) + sr
    x = np.zeros(n, dtype=np.float32)
    rand = _rng(seed)
    sw = swing / 100

    def step_time(bar: int, step: int) -> float:
        base = (bar * 16 + step) * step_dur
        return base - step_dur + 2 * step_dur * sw if step % 2 == 1 else base

    kn = int(sr * kick_decay * 5)
    kt = np.arange(kn) / sr
    kick_wave = (0.9 * np.sin(np.cumsum(2 * np.pi * (45 + 90 * np.exp(-kt * 30)) / sr)) * np.exp(-kt / kick_decay)).astype(np.float32)

    def place(t0: float, wave: np.ndarray) -> None:
        s0 = round(t0 * sr)
        m = min(len(wave), n - s0)
        if m > 0:
            x[s0 : s0 + m] += wave[:m]

    def snare_wave() -> np.ndarray:
        m = int(sr * 0.25) + 1
        t = np.arange(m) / sr
        noise = np.array([rand() * 2 - 1 for _ in range(m)])
        return ((0.45 * noise + 0.3 * np.sin(2 * np.pi * 220 * t)) * np.exp(-t / 0.06)).astype(np.float32)

    def hat_wave() -> np.ndarray:
        m = int(sr * 0.06) + 1
        noise = np.array([rand() * 2 - 1 for _ in range(m)])
        prev = np.concatenate([[0.0], noise[:-1]])
        return (0.35 * (noise - prev) * np.exp(-(np.arange(m) / sr) / 0.012)).astype(np.float32)

    for bar in range(bars):
        for s in kick:
            place(step_time(bar, s), kick_wave)
        for s in snare:
            place(step_time(bar, s), snare_wave())
        for s in hat:
            place(step_time(bar, s), hat_wave())
    if chord:
        t = np.arange(n) / sr
        v = sum(np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t) for f in chord)
        g = np.full(n, 0.06)
        if pump:
            beat = 60 / bpm
            g *= np.minimum(1, 0.08 + ((t % beat) / beat) * 2.2)
        x += (g * v).astype(np.float32)
    return x


PATTERNS = {
    "house": dict(kick=(0, 4, 8, 12), snare=(4, 12), hat=(2, 6, 10, 14)),
    "trap": dict(kick=(0, 7, 10), snare=(8,), hat=tuple(range(16))),
    "boombap": dict(kick=(0, 7, 10), snare=(4, 12), hat=(0, 2, 4, 6, 8, 10, 12, 14)),
    "reggaeton": dict(kick=(0, 4, 8, 12), snare=(3, 6, 11, 14), hat=(0, 2, 4, 6, 8, 10, 12, 14)),
}

"""Layer 1 — physical audio analysis (Python port of src/audio/analyzer.js).

Input: mono PCM. Output: AudioFeatures — BPM, key, 16-step drum grids per
frequency band (Kick 30–140 Hz, Snare 160–1500 Hz, Hi-hat 6 kHz+ via SciPy
Butterworth filters), groove metrics, spectral balance and rhythmic traits.
"""

from __future__ import annotations

import math

import librosa
import numpy as np

from ..models import AudioFeatures, BandValues, GrooveMetrics, RhythmGrid, SpectralProfile, Traits
from .dsp import (
    c01,
    db,
    interp,
    min_filter,
    moving_average,
    onset_from_envelope,
    parabolic_offset,
    pearson,
    r2,
    rms_envelope,
    window_max,
)
from .filters import bandpass, highpass, lowpass
from .key import estimate_key
from .tempo import estimate_tempo, regularise_beats, smooth_beats, track_beats

ANALYSIS_VERSION = 3
SR = 22050
HOP = 256
NFFT = 1024
BANDS = {"kick": (30, 140), "snare": (160, 1500), "hat": (6000, None)}
BALANCE_BANDS = [(20, 60), (60, 250), (250, 2000), (2000, 6000), (6000, 11000)]
BAND_NAMES = ("kick", "snare", "hat")


class AnalysisError(ValueError):
    pass


def analyze_audio(samples: np.ndarray, sr: int = SR) -> AudioFeatures:
    x = np.asarray(samples, dtype=np.float64)
    duration = len(x) / sr
    if duration < 6:
        raise AnalysisError("音声が短すぎます（6秒以上必要）")
    rms = math.sqrt(float(np.mean(x**2)))
    if rms < 1e-4:
        raise AnalysisError("無音、またはほぼ無音の音声です")
    peak = float(np.abs(x).max())
    fps = sr / HOP

    # ---- spectral pass: flux onset + long-term spectrum ----
    mag = np.abs(librosa.stft(x.astype(np.float32), n_fft=NFFT, hop_length=HOP, window="hann", center=True, pad_mode="constant")).astype(np.float64)
    bin_hz = sr / NFFT
    n_bins = NFFT // 2 + 1
    mean_mag = mag.mean(axis=1)
    mean_pow = (mag**2).mean(axis=1)
    flux_hi = min(n_bins - 1, int(8000 // bin_hz))
    logm = np.log1p(100 * mag)
    flux_raw = np.zeros(mag.shape[1])
    flux_raw[1:] = np.maximum(0, logm[1 : flux_hi + 1, 1:] - logm[1 : flux_hi + 1, :-1]).sum(axis=0)
    trend = moving_average(flux_raw, round(fps * 0.5))
    delay = round(NFFT / 4 / HOP)
    onset = np.zeros_like(flux_raw)
    onset[delay:] = np.maximum(0, flux_raw[:-delay] - trend[:-delay]) if delay else np.maximum(0, flux_raw - trend)

    # ---- band separation (SciPy Butterworth) ----
    sigs = {
        "kick": bandpass(x, *BANDS["kick"], sr),
        "snare": bandpass(x, *BANDS["snare"], sr),
        "hat": highpass(x, BANDS["hat"][0], sr),
    }
    band_onset = {k: onset_from_envelope(rms_envelope(v, 512, HOP)) for k, v in sigs.items()}

    # ---- tempo & beats ----
    meter = fuse_onsets([onset, band_onset["kick"], band_onset["snare"]], [0.35, 1.2, 0.8])
    tempo_onset = fuse_onsets([onset, band_onset["kick"], band_onset["snare"]], [1, 1.2, 0.8])
    bpm, bpm_conf, bpm_cands = estimate_tempo(meter, fps)
    period = 60 * fps / bpm
    beats = track_beats(tempo_onset, fps, bpm)
    beats = smooth_beats(regularise_beats(beats, period, len(tempo_onset), tempo_onset))
    if bpm < 100 and is_half_time(band_onset["hat"], beats):
        bpm = round(bpm * 200) / 100
        doubled: list[float] = []
        for i, b in enumerate(beats):
            doubled.append(b)
            if i + 1 < len(beats):
                doubled.append((b + beats[i + 1]) / 2)
        beats = doubled

    # ---- 16-step grid ----
    raw = {b: np.zeros(16) for b in BAND_NAMES}
    counts = np.zeros(16)
    for i in range(len(beats) - 1):
        b0, ln = beats[i], beats[i + 1] - beats[i]
        for j in range(4):
            pos = b0 + ln * j / 4
            radius = max(1.0, ln / 4 * 0.3)
            step = (i % 4) * 4 + j
            for band in BAND_NAMES:
                raw[band][step] += window_max(band_onset[band], pos, radius)
            counts[step] += 1
    unrot: dict[str, list[float]] = {}
    presence: dict[str, float] = {}
    for band in BAND_NAMES:
        avg = np.divide(raw[band], counts, out=np.zeros(16), where=counts > 0)
        mx = avg.max()
        unrot[band] = list(avg / mx) if mx > 0 else [0.0] * 16
        ref = float(np.percentile(band_onset[band], 99)) or 1.0
        presence[band] = c01(float(np.sort(avg)[-4:].mean()) / ref)
    grid = choose_downbeat(unrot)

    # ---- groove ----
    swing, unit, swing_conf = measure_swing(band_onset["hat"] if presence["hat"] > 0.2 else onset, beats)
    sidechain = measure_sidechain(lowpass(highpass(x, 200, sr, 2), 4000, sr, 2), beats)
    sub_sustain = measure_sub_sustain(lowpass(x, 100, sr, 4), beats)
    hat_density = sum(v >= 0.5 for v in grid["hat"]) / 16
    kick_density = sum(v >= 0.5 for v in grid["kick"]) / 16

    # ---- spectral profile ----
    freqs = np.arange(n_bins) * bin_hz
    mag_sum = mean_mag.sum()
    centroid = float((mean_mag * freqs).sum() / mag_sum) if mag_sum > 0 else 0.0
    cum = np.cumsum(mean_mag)
    rolloff = float(freqs[int(np.argmax(cum >= 0.85 * mag_sum))]) if mag_sum > 0 else 0.0
    total = max(float(mean_pow[1:].sum()), 1e-12)
    balance = []
    for lo, hi in BALANCE_BANDS:
        a, b = max(1, math.ceil(lo / bin_hz)), min(n_bins - 1, math.floor(hi / bin_hz))
        p = max(float(mean_pow[a : b + 1].sum()), 1e-12)
        balance.append(round(10 * math.log10(p / total), 1))

    key = estimate_key(x, sr)
    groove = GrooveMetrics(swing=swing, swing_unit=unit, swing_confidence=swing_conf, sidechain_db=sidechain,
                           sub_sustain=sub_sustain, hat_density=hat_density, kick_density=kick_density)
    spectral = SpectralProfile(centroid_hz=centroid, rolloff_hz=rolloff, crest_db=db(peak) - db(rms), rms_db=db(rms), band_balance=balance)
    pres = BandValues(**presence)
    traits = compute_traits(grid, pres, groove, spectral)
    return AudioFeatures(
        version=ANALYSIS_VERSION, duration_sec=duration, bpm=bpm, bpm_confidence=bpm_conf, bpm_candidates=bpm_cands,
        key=key, grid=RhythmGrid(**grid), presence=pres, groove=groove, spectral=spectral, traits=traits, beat_count=len(beats),
    )


def fuse_onsets(envs: list[np.ndarray], weights: list[float]) -> np.ndarray:
    n = min(len(e) for e in envs)
    out = np.zeros(n)
    for e, w in zip(envs, weights):
        out += w * e[:n] / (e.std() or 1.0)
    return out


def is_half_time(env: np.ndarray, beats: list[float]) -> bool:
    """Strong regular hits on 32nd positions → we locked onto half-time."""
    if len(beats) < 8:
        return False
    on, mid = [], []
    for i in range(len(beats) - 1):
        step = (beats[i + 1] - beats[i]) / 4
        for j in range(4):
            p = beats[i] + j * step
            on.append(window_max(env, p, step * 0.2))
            mid.append(window_max(env, p + step / 2, step * 0.2))
    ref = float(np.median(on))
    if ref <= 0:
        return False
    hits = sum(m > 0.4 * ref for m in mid) / len(mid)
    return float(np.mean(mid)) / (float(np.mean(on)) or 1.0) >= 0.55 and hits >= 0.6


def rotate(g: dict[str, list[float]], shift: int) -> dict[str, list[float]]:
    return {k: [v[(i + shift) % 16] for i in range(16)] for k, v in g.items()}


def choose_downbeat(g: dict[str, list[float]]) -> dict[str, list[float]]:
    best, best_score = 0, -math.inf
    for r in range(4):
        rot = rotate(g, r * 4)
        k, s = rot["kick"], rot["snare"]
        sc = (k[0] + 0.3 * k[8] + 0.6 * max((s[4] + s[12]) / 2, 1.1 * s[8]) - 0.5 * s[0] - 0.15 * k[4]
              + 0.6 * float(np.mean([s[i] for i in (3, 6, 11, 14)])))
        if sc > best_score + 1e-9:
            best_score, best = sc, r
    return rotate(g, best * 4)


def measure_swing(env: np.ndarray, beats: list[float]) -> tuple[float, int, float]:
    thr = 0.25 * float(np.percentile(env, 98))

    def scan(pairs: int, u_lo: float, u_hi: float) -> tuple[list[float], int]:
        positions, possible = [], 0
        for i in range(len(beats) - 1):
            ln = (beats[i + 1] - beats[i]) / pairs
            for p in range(pairs):
                a = beats[i] + p * ln
                possible += 1
                lo, hi = max(0, math.ceil(a + ln * u_lo)), min(math.floor(a + ln * u_hi), len(env) - 1)
                if hi < lo:
                    continue
                seg = env[lo : hi + 1]
                j = int(np.argmax(seg))
                if seg[j] > thr and seg[j] > 0:
                    bi = lo + j
                    positions.append((bi + parabolic_offset(env, bi) - a) / ln)
        return positions, possible

    p16, n16 = scan(2, 0.3, 0.82)
    unit = 16 if n16 and len(p16) >= 0.4 * n16 else 8
    pos, possible = (p16, n16) if unit == 16 else scan(1, 0.35, 0.8)
    if len(pos) < 6:
        return 50.0, unit, 0.0
    swing = max(50.0, min(75.0, float(np.median(pos)) * 100))
    return round(swing, 1), unit, c01(len(pos) / max(1, possible))


def measure_sidechain(mid_sig: np.ndarray, beats: list[float]) -> float:
    """Depth (dB) of beat-synchronous ducking of the sustained layer."""
    raw = rms_envelope(mid_sig, 512, HOP)
    if len(beats) < 6:
        return 0.0
    period = (beats[-1] - beats[0]) / (len(beats) - 1)
    w = max(3, round(period / 4))
    env = moving_average(min_filter(raw, w), w)
    sustain_ratio = float(env.mean()) / (float(raw.mean()) or 1.0)
    bins = 24
    cycle = np.zeros(bins)
    n = 0
    for i in range(len(beats) - 1):
        b0, ln = beats[i], beats[i + 1] - beats[i]
        vals = interp(env, b0 + ln * np.arange(bins) / bins)
        m = float(np.mean(vals))
        if m <= 1e-6:
            continue
        cycle += vals / m
        n += 1
    if n < 4:
        return 0.0
    cycle /= n
    body = cycle[1:20]
    rise = max(0.0, pearson(body, np.arange(len(body))))
    depth = (db(float(cycle[12:24].max())) - db(float(cycle[0:8].min()))) * math.sqrt(rise) * c01((sustain_ratio - 0.25) / 0.25)
    return round(max(0.0, min(24.0, depth)), 1)


def measure_sub_sustain(sub_sig: np.ndarray, beats: list[float]) -> float:
    env = rms_envelope(sub_sig, 512, HOP)
    gmax = float(env.max())
    if gmax <= 1e-6:
        return 0.0
    ratios = []
    for i in range(len(beats) - 1):
        a, b = max(0, math.floor(beats[i])), max(0, math.floor(beats[i + 1]))
        seg = env[a:min(b, len(env))]
        if len(seg) == 0:
            continue
        pk = float(seg.max())
        if pk < 0.1 * gmax:
            continue
        tail = float(np.mean(interp(env, a + (b - a) * (0.5 + 0.45 * np.arange(8) / 7))))
        ratios.append(tail / pk)
    return r2(c01(float(np.median(ratios)))) if ratios else 0.0


def compute_traits(g: dict[str, list[float]], presence: BandValues, groove: GrooveMetrics, spectral: SpectralProfile) -> Traits:
    kick, snare, hat = g["kick"], g["snare"], g["hat"]

    def avg(a: list[float], idx) -> float:
        return float(np.mean([a[i] for i in idx]))

    q, off8 = (0, 4, 8, 12), (2, 6, 10, 14)
    nonq = (1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15)
    kick_q_min = min(kick[i] for i in q)
    four = c01((kick_q_min - 0.45) / 0.35) * c01(1 - (avg(kick, nonq) - 0.15) / 0.4)
    off_hat = c01((avg(hat, off8) - avg(hat, q)) / 0.35) * c01(avg(hat, off8) / 0.6) * c01(presence.hat / 0.25)
    backbeat = c01((avg(snare, (4, 12)) - 0.8 * max(snare[0], snare[8])) / 0.45)
    halftime_raw = c01((snare[8] - avg(snare, (4, 12))) / 0.45)
    rolling = c01((groove.hat_density - 0.45) / 0.35) * c01(presence.hat / 0.25)
    sub808 = c01((groove.sub_sustain - 0.3) / 0.35) * c01((spectral.band_balance[0] + 18) / 10)
    swing = c01((groove.swing - 53) / 10) * (0.4 + 0.6 * groove.swing_confidence)
    sidechain = c01((groove.sidechain_db - 1.5) / 4)
    sync_kick = c01((avg(kick, nonq) - 0.15) / 0.35)
    dembow = max(
        c01(kick_q_min / 0.6) * c01((avg(sn, (3, 6, 11, 14)) - avg(sn, (1, 5, 9, 13))) / 0.35)
        for sn in ([snare[(i + sh) % 16] for i in range(16)] for sh in (0, 4, 8, 12))
    )
    halftime = halftime_raw * (1 - dembow)
    breakbeat = backbeat * sync_kick * (1 - four)
    return Traits(
        four_on_floor=r2(four), offbeat_hat=r2(off_hat), backbeat=r2(backbeat), halftime=r2(halftime),
        rolling_hats=r2(rolling), sub808=r2(sub808), swing=r2(swing), sidechain=r2(sidechain),
        syncopated_kick=r2(sync_kick), dembow=r2(dembow), breakbeat=r2(breakbeat),
    )


def find_energy_window(samples: np.ndarray, sr: int, window_sec: float) -> tuple[int, int]:
    """Loudest window (drop / chorus) by sliding 1-second RMS blocks."""
    win = min(len(samples), round(window_sec * sr))
    if win >= len(samples):
        return 0, len(samples)
    n_blocks = len(samples) // sr
    energy = (samples[: n_blocks * sr].astype(np.float64).reshape(n_blocks, sr) ** 2).sum(axis=1)
    span = max(1, win // sr)
    sums = np.convolve(energy, np.ones(span), mode="valid")
    start = int(np.argmax(sums)) * sr
    return start, min(len(samples), start + win)

"""Layer 3 — similarity scoring (port of src/core/similarity.js)."""

from __future__ import annotations

import math

import numpy as np

from ..audio.dsp import cosine, pearson
from ..audio.key import key_compatibility
from ..models import AudioFeatures, BandValues, ScoreBreakdown, Weights

BAND_WEIGHTS = {"kick": 0.45, "snare": 0.35, "hat": 0.2}
TRAIT_LABELS = {
    "four_on_floor": "4つ打ち", "offbeat_hat": "裏拍ハイハット", "backbeat": "2・4拍バックビート",
    "halftime": "ハーフタイム", "rolling_hats": "16分ハイハット連打", "sub808": "808系ロングサブ",
    "swing": "スウィング", "sidechain": "サイドチェイン", "syncopated_kick": "シンコペーション・キック",
    "dembow": "デンボウ (3+3+2)", "breakbeat": "ブレイクビーツ",
}


def _gauss(x: float, sigma: float) -> float:
    return math.exp(-0.5 * (x / sigma) ** 2)


def _vec_sim(a, b) -> float:
    return 0.5 * max(0.0, cosine(a, b)) + 0.5 * ((pearson(a, b) + 1) / 2)


def tempo_similarity(a: float, b: float) -> tuple[float, float]:
    """(similarity, ratio) where b·ratio ≈ a (half/double time aware)."""
    best = (0.0, 1.0)
    for r in (1.0, 2.0, 0.5):
        d = abs(math.log2(b * r / a))
        sim = _gauss(d, 0.045) * (1 if r == 1 else 0.85)
        if sim > best[0]:
            best = (sim, r)
    return best


def align_band(a: list[float], b: list[float], ratio: float) -> tuple[list[float], list[float]]:
    fold = lambda g: [(g[i] + g[i + 8]) / 2 for i in range(8)]  # noqa: E731
    evens = lambda g: [g[i * 2] for i in range(8)]  # noqa: E731
    if ratio == 0.5:
        return fold(a), evens(b)
    if ratio == 2:
        return evens(a), fold(b)
    return a, b


def grid_similarity(a: AudioFeatures, b: AudioFeatures, ratio: float) -> tuple[float, int, dict[str, float]]:
    length = 16 if ratio == 1 else 8
    beat = 4 if ratio == 1 else 2
    best = (-1.0, 0, {"kick": 0.0, "snare": 0.0, "hat": 0.0})
    for s in range(0, length, beat):
        bands, num, den = {}, 0.0, 0.0
        for band in ("kick", "snare", "hat"):
            x, y = align_band(a.grid.band(band), b.grid.band(band), ratio)
            y = y[s:] + y[:s]
            sim = _vec_sim(x, y)
            bands[band] = sim
            w = BAND_WEIGHTS[band] * (0.3 + 0.7 * min(getattr(a.presence, band), getattr(b.presence, band)))
            num += w * sim
            den += w
        sim = (num / den if den else 0) - (0 if s == 0 else 0.05)
        if sim > best[0]:
            best = (sim, s * 16 // length, bands)
    return max(0.0, best[0]), best[1], best[2]


def groove_similarity(a: AudioFeatures, b: AudioFeatures) -> float:
    ga, gb = a.groove, b.groove
    swing = 0.75 if min(ga.swing_confidence, gb.swing_confidence) < 0.15 else _gauss(ga.swing - gb.swing, 4)
    side = _gauss(ga.sidechain_db - gb.sidechain_db, 3)
    sub = _gauss(ga.sub_sustain - gb.sub_sustain, 0.18)
    hats = _gauss(ga.hat_density - gb.hat_density, 0.25)
    ta, tb = a.traits.as_dict(), b.traits.as_dict()
    traits = 1 - float(np.mean([abs(ta[k] - tb[k]) for k in ta]))
    return 0.22 * swing + 0.18 * side + 0.2 * sub + 0.1 * hats + 0.3 * traits


def timbre_similarity(a: AudioFeatures, b: AudioFeatures) -> float:
    ba, bb = np.array(a.spectral.band_balance), np.array(b.spectral.band_balance)
    balance = _gauss(float(np.sqrt(np.mean((ba - bb) ** 2))), 4)
    centroid = _gauss(math.log2((a.spectral.centroid_hz or 1) / (b.spectral.centroid_hz or 1)), 0.35)
    crest = _gauss(a.spectral.crest_db - b.spectral.crest_db, 3)
    return 0.5 * balance + 0.3 * centroid + 0.2 * crest


def key_similarity(a: AudioFeatures, b: AudioFeatures) -> float:
    conf = math.sqrt(min(a.key.confidence, b.key.confidence))
    return 0.6 + (key_compatibility(a.key, b.key) - 0.6) * conf


def compare_features(inp: AudioFeatures, cand: AudioFeatures, weights: Weights | None = None) -> dict:
    weights = weights or Weights()
    t_sim, ratio = tempo_similarity(inp.bpm, cand.bpm)
    g_sim, shift, bands = grid_similarity(inp, cand, ratio)
    bd = ScoreBreakdown(rhythm=g_sim, tempo=t_sim, groove=groove_similarity(inp, cand),
                        timbre=timbre_similarity(inp, cand), key=key_similarity(inp, cand))
    w = weights.model_dump()
    wsum = sum(max(0, v) for v in w.values()) or 1
    score = sum(max(0, w[k]) * getattr(bd, k) for k in w) / wsum
    return {
        "score": score, "breakdown": bd, "band_similarity": BandValues(**bands), "shift_steps": shift,
        "tempo_ratio": ratio, "reasons": explain_match(inp, cand, bd, bands, ratio),
    }


def explain_match(a: AudioFeatures, b: AudioFeatures, bd: ScoreBreakdown, bands: dict[str, float], ratio: float) -> list[str]:
    out = []
    diff = (b.bpm * ratio - a.bpm) / a.bpm * 100
    sign = "+" if diff >= 0 else ""
    if ratio == 1:
        out.append(f"BPM {a.bpm:g} ↔ {b.bpm:g}（{sign}{diff:.1f}%）")
    else:
        out.append(f"BPM {a.bpm:g} ↔ {b.bpm:g}：{'ハーフタイム' if ratio == 2 else 'ダブルタイム'}関係（{sign}{diff:.1f}%）")
    names = {"kick": "キック", "snare": "スネア", "hat": "ハイハット"}
    order = sorted(bands, key=lambda k: -bands[k])
    strong = [k for k in order if bands[k] >= 0.8]
    if strong:
        out.append(f"{'・'.join(names[k] for k in strong)}の16ステップ配置が一致（{' / '.join(f'{round(bands[k] * 100)}%' for k in strong)}）")
    weak = [k for k in order if bands[k] < 0.55]
    if weak:
        out.append(f"{'・'.join(names[k] for k in weak)}のパターンは異なる")
    ta, tb = a.traits.as_dict(), b.traits.as_dict()
    shared = [TRAIT_LABELS[k] for k in ta if ta[k] >= 0.55 and tb[k] >= 0.55]
    if shared:
        out.append(f"共通のリズム骨格：{'、'.join(shared)}")
    ga, gb = a.groove, b.groove
    if ga.swing_confidence > 0.15 and gb.swing_confidence > 0.15 and abs(ga.swing - gb.swing) <= 3 and ga.swing >= 54:
        out.append(f"スウィング量がほぼ同じ（{ga.swing}% / {gb.swing}%）")
    if ga.sidechain_db >= 2 and gb.sidechain_db >= 2:
        out.append(f"両方にサイドチェインのポンピング（{ga.sidechain_db}dB / {gb.sidechain_db}dB）")
    if ga.sub_sustain >= 0.45 and gb.sub_sustain >= 0.45:
        out.append("ロングサステインのサブベース（808系）が共通")
    if bd.timbre >= 0.75:
        out.append(f"帯域バランス・明るさが近い（スペクトル重心 {round(a.spectral.centroid_hz)}Hz / {round(b.spectral.centroid_hz)}Hz）")
    elif bd.timbre < 0.45:
        out.append("帯域バランス（音色の明るさ・低域量）は異なる")
    if key_compatibility(a.key, b.key) >= 0.85 and min(a.key.confidence, b.key.confidence) > 0.3:
        out.append(f"キーの相性が良い（{a.key.name} / {b.key.name}）")
    return out

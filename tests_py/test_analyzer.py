import numpy as np
import pytest

from refscope.audio.analyzer import AnalysisError, analyze_audio, find_energy_window
from refscope.audio.key import camelot, estimate_key
from synth import PATTERNS, synth_loop


def A(bpm, **kw):
    return analyze_audio(synth_loop(bpm, bars=12, **kw))


def top(g, n):
    return sorted(np.argsort(g)[-n:].tolist())


def test_house():
    f = A(124, **PATTERNS["house"])
    assert abs(f.bpm - 124) <= 1
    assert top(f.grid.kick, 4) == [0, 4, 8, 12]
    assert f.traits.four_on_floor > 0.8 and f.traits.offbeat_hat > 0.6 and f.traits.halftime < 0.2


@pytest.mark.parametrize("seed", [1, 2])
def test_trap_is_140_not_70(seed):
    f = A(140, **PATTERNS["trap"], kick_decay=0.6, seed=seed, chord=[220, 277.2, 329.6] if seed == 2 else None)
    assert abs(f.bpm - 140) <= 1.5
    assert f.traits.halftime > 0.7 and f.traits.rolling_hats > 0.7 and f.traits.sub808 > 0.5


def test_boombap_and_dembow():
    assert abs(A(90, **PATTERNS["boombap"]).bpm - 90) <= 1
    r = A(95, **PATTERNS["reggaeton"])
    assert abs(r.bpm - 95) <= 1 and r.traits.dembow > 0.7


def test_swing():
    hat = tuple(range(16))
    assert abs(A(92, kick=(0, 7, 10), snare=(4, 12), hat=hat).groove.swing - 50) <= 2.5
    s = A(92, kick=(0, 7, 10), snare=(4, 12), hat=hat, swing=62).groove
    assert abs(s.swing - 62) <= 3 and s.swing_unit == 16


def test_sidechain():
    pad = [261.6, 329.6, 392]
    assert A(124, **PATTERNS["house"], chord=pad, pump=True).groove.sidechain_db >= 2.5
    assert A(124, **PATTERNS["house"], chord=pad).groove.sidechain_db < 1
    assert A(95, **PATTERNS["reggaeton"]).groove.sidechain_db < 1


def test_key_and_camelot():
    sr = 22050
    t = np.arange(sr * 8) / sr
    x = sum(0.1 * np.sin(2 * np.pi * f * t) for f in (130.81, 261.63, 329.63, 392.0, 523.25))
    k = estimate_key(x, sr)
    assert (k.tonic, k.mode) == (0, "major")
    assert camelot(0, "major") == "8B" and camelot(9, "minor") == "8A"


def test_rejects_bad_audio():
    with pytest.raises(AnalysisError):
        analyze_audio(np.zeros(22050 * 3))
    with pytest.raises(AnalysisError):
        analyze_audio(np.zeros(22050 * 10))


def test_energy_window():
    sr = 1000
    x = 0.01 * np.sin(np.arange(sr * 60) * 0.3)
    x[30 * sr : 45 * sr] += np.sin(np.arange(15 * sr))
    s, _ = find_energy_window(x, sr, 15)
    assert abs(s / sr - 30) <= 1


def test_json_shape_matches_web_ui():
    d = A(124, **PATTERNS["house"]).dump()
    assert {"durationSec", "bpmCandidates", "beatCount"} <= d.keys()
    assert {"swingUnit", "sidechainDb", "subSustain"} <= d["groove"].keys()
    assert "four_on_floor" in d["traits"] and "bandBalance" in d["spectral"]

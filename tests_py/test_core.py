from refscope.core import ontology
from refscope.core.candidates import CandidatePool
from refscope.core.similarity import align_band, compare_features, tempo_similarity
from refscope.audio.analyzer import analyze_audio
from refscope.models import Candidate, PipelineOptions
from refscope.util import normalize_text, parse_file_name, text_similarity, track_key
from synth import PATTERNS, synth_loop


def A(bpm, **kw):
    return analyze_audio(synth_loop(bpm, bars=12, **kw))


def test_ranking():
    inp = A(124, **PATTERNS["house"], chord=[261.6, 329.6, 392], pump=True)
    house = compare_features(inp, A(126, **PATTERNS["house"], chord=[293.7, 370, 440], pump=True, seed=3))
    trap = compare_features(inp, A(140, **PATTERNS["trap"], kick_decay=0.6))
    assert house["score"] > 0.8 and house["score"] > trap["score"] + 0.25
    assert any("4つ打ち" in r for r in house["reasons"])


def test_tempo_and_alignment():
    assert tempo_similarity(140, 70)[1] == 2 and tempo_similarity(87, 174)[1] == 0.5
    slow = [1, 0, 0, 0] * 4
    fast = [1, 0, 0, 0, 0, 0, 0, 0] * 2
    a, b = align_band(slow, fast, 0.5)
    assert a == b == [1, 0, 0, 0, 1, 0, 0, 0]


def test_ontology():
    ids = {g["id"] for g in ontology.genres()}
    for g in ontology.genres():
        assert set(g["parents"]) <= ids and set(g.get("influences", [])) <= ids
    assert ontology.tag_to_genre("Hip-Hop") == "hiphop"
    assert ontology.tag_to_genre("japanese hip hop") == "hiphop"
    assert ontology.tag_to_genre("seen live") is None
    e = ontology.expand_genres({"trap": 1})
    assert e["drill"][1] == "derivative" and e["crunk"][1] == "parent"
    assert ontology.skeleton_genres(A(95, **PATTERNS["reggaeton"]))[0][0] == "reggaeton"


def test_text_and_pool():
    assert normalize_text("Get Lucky (feat. Pharrell Williams) [Radio Edit]") == "getlucky"
    assert text_similarity("Blinding Lights", "Blinding Lights - Remastered") > 0.8
    assert parse_file_name("01 - Daft Punk - Get Lucky.mp3") == ("Daft Punk", "Get Lucky")
    pool = CandidatePool([track_key("Me", "Input")])
    c = lambda a, t, w, s="x": Candidate(key=track_key(a, t), artist=a, title=t, sources=[s], weight=w)  # noqa: E731
    for cand in (c("Me", "Input", 5), c("A", "One", 1, "lastfm"), c("a", "one (Remastered)", 1, "gemini"), c("A", "Two", 0.9), c("A", "Three", 0.8), c("B", "Four", 0.5)):
        pool.add(cand)
    assert [x.title for x in pool.shortlist(10, 2)] == ["One", "Two", "Four"]
    assert pool.items[track_key("A", "One")].sources == ["lastfm", "gemini"]


def test_options_validation():
    o = PipelineOptions.model_validate({"topN": 5, "minScore": 0.7, "weights": {"rhythm": 1}})
    assert o.top_n == 5 and o.min_score == 0.7 and o.weights.rhythm == 1

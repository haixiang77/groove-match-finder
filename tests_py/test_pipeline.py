from refscope.config import Secrets
from refscope.core.pipeline import run_pipeline
import fake_net


async def test_end_to_end_ranking(monkeypatch):
    fake_net.install(monkeypatch)
    events = []

    async def emit(ev):
        events.append(ev)

    region = fake_net.input_loop()[: 22050 * 30]
    res = await run_pipeline(region, "Test Artist - Test Song.wav", secrets=Secrets(shazam_enabled=True), emit=emit)
    titles = [r.candidate.title for r in res.ranked]
    assert res.identification and res.identification.source == "filename"
    assert titles and titles[0] in {"Pump It Slow", "Glitter Floor", "Night Shift"}
    assert not {"808 Ritual", "Dusty Tape"} & set(titles)
    assert "Test Song" not in titles
    kinds = {e["type"] for e in events}
    assert {"step", "log", "input_features", "identified", "genres", "candidates", "scored", "ranked"} <= kinds
    assert any(e["type"] == "log" and "Shazam" in e["message"] for e in events)

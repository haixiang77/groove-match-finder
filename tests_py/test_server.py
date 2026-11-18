import json

from fastapi.testclient import TestClient

from refscope.config import Secrets
from refscope.server import create_app
import fake_net


def test_health_and_ui():
    c = TestClient(create_app(Secrets(shazam_enabled=False)))
    h = c.get("/api/health").json()
    assert h["ok"] and h["auth"] is False
    assert "RefScope" in c.get("/").text
    assert c.get("/src/main.js").status_code == 200


def test_analyze_stream(monkeypatch):
    fake_net.install(monkeypatch)
    c = TestClient(create_app(Secrets(shazam_enabled=True)))
    audio = fake_net.wav(fake_net.input_loop()[: 22050 * 30])
    r = c.post("/api/analyze", files={"audio": ("region.wav", audio, "audio/wav")},
               data={"file_name": "Test Artist - Test Song.mp3", "options": json.dumps({"topN": 3})})
    assert r.status_code == 200
    events = [json.loads(line) for line in r.text.splitlines() if line]
    ranked = next(e for e in events if e["type"] == "ranked")
    assert len(ranked["ranked"]) <= 3 and ranked["ranked"][0]["candidate"]["title"] in {"Pump It Slow", "Glitter Floor", "Night Shift"}
    assert ranked["ranked"][0]["features"]["grid"]["kick"]
    assert events[-1]["type"] == "done"


def test_access_token():
    c = TestClient(create_app(Secrets(shazam_enabled=False, access_token="s3cret")))
    files = {"audio": ("a.wav", b"RIFF", "audio/wav")}
    assert c.post("/api/analyze", files=files).status_code == 401
    assert c.get("/api/health").json()["auth"] is True


def test_manifest_served():
    c = TestClient(create_app(Secrets(shazam_enabled=False)))
    r = c.get("/manifest.webmanifest")
    assert r.status_code == 200 and r.json()["short_name"] == "RefScope"

"""Gemini (multimodal) — identification fallback + Step 4 explanations.

Gemini never ranks: suggested tracks still pass the waveform filter.
"""

from __future__ import annotations

import base64
import json
import re

import httpx

from ..models import AudioFeatures, GeminiExplanation, GeminiIdentify


async def generate_json(c: httpx.AsyncClient, api_key: str, model: str, parts: list[dict], schema: dict, temperature: float = 0.4) -> dict:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": schema, "temperature": temperature},
    }
    r = await c.post(url, json=body, headers={"x-goog-api-key": api_key}, timeout=90)
    r.raise_for_status()
    data = r.json()
    cand = (data.get("candidates") or [{}])[0]
    text = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts", []) if not p.get("thought"))
    if not text:
        raise RuntimeError(f"Gemini: 空の応答 ({cand.get('finishReason', 'unknown')})")
    return json.loads(re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip()))


def _audio_part(wav: bytes) -> dict:
    return {"inline_data": {"mime_type": "audio/wav", "data": base64.b64encode(wav).decode()}}


IDENTIFY_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "recognized": {"type": "BOOLEAN"}, "title": {"type": "STRING"}, "artist": {"type": "STRING"},
        "confidence": {"type": "NUMBER"}, "genre_tags": {"type": "ARRAY", "items": {"type": "STRING"}},
        "sound_design": {"type": "STRING"},
        "suggested_references": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {"artist": {"type": "STRING"}, "title": {"type": "STRING"}}, "required": ["artist", "title"]}},
    },
    "required": ["recognized", "genre_tags", "sound_design", "suggested_references"],
}


async def identify(c: httpx.AsyncClient, api_key: str, model: str, wav: bytes, f: AudioFeatures) -> GeminiIdentify:
    prompt = f"""You are an expert music producer and DJ. Listen to this excerpt (the loudest section of a track).
Measured by DSP: BPM {f.bpm}, key {f.key.name}, swing {f.groove.swing}%, sidechain {f.groove.sidechain_db} dB.
1. If and only if you are highly confident you recognise the exact recording, set recognized=true and give title and artist. Never guess: if unsure, recognized=false and leave title/artist empty.
2. genre_tags: 3-6 specific sub-genre tags in English, most specific first. Prefer the rhythmic foundation (e.g. a pop song on a trap beat → "trap pop", "trap").
3. sound_design: one or two Japanese sentences on synth timbre, bass type (808, reese, sub), drums and mix space.
4. suggested_references: up to 8 real, released tracks (artist + title) with very similar groove and sound. Only well-known existing songs."""
    raw = await generate_json(c, api_key, model, [{"text": prompt}, _audio_part(wav)], IDENTIFY_SCHEMA, 0.2)
    return GeminiIdentify.model_validate(raw)


def feature_summary(f: AudioFeatures) -> dict:
    g = lambda a: "".join("X" if v >= 0.66 else "x" if v >= 0.4 else "." for v in a)  # noqa: E731
    b = f.spectral.band_balance
    return {
        "bpm": f.bpm, "key": f.key.name,
        "grid_16steps": {"kick": g(f.grid.kick), "snare": g(f.grid.snare), "hat": g(f.grid.hat)},
        "swing_percent": f.groove.swing, "sidechain_db": f.groove.sidechain_db, "sub_sustain_808": f.groove.sub_sustain,
        "hat_density": f.groove.hat_density, "spectral_centroid_hz": round(f.spectral.centroid_hz),
        "crest_db": round(f.spectral.crest_db, 1),
        "band_balance_db": {"sub": b[0], "bass": b[1], "lowmid": b[2], "highmid": b[3], "air": b[4]},
        "traits": {k: v for k, v in f.traits.as_dict().items() if v >= 0.5},
    }


EXPLAIN_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "overview": {"type": "STRING"},
        "matches": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "title": {"type": "STRING"}, "artist": {"type": "STRING"}, "why": {"type": "STRING"},
            "drum_pattern": {"type": "STRING"}, "low_end": {"type": "STRING"}, "tip": {"type": "STRING"}},
            "required": ["title", "artist", "why"]}},
        "production_tips": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": ["overview", "matches", "production_tips"],
}


async def explain(c: httpx.AsyncClient, api_key: str, model: str, label: str, genres: list[str], f: AudioFeatures,
                  matches: list[dict], wav: bytes | None = None) -> GeminiExplanation:
    payload = {
        "input": {"track": label, "genres": genres, "features": feature_summary(f)},
        "matches": [{"title": m["title"], "artist": m["artist"], "similarity": round(m["score"] * 100),
                     "dsp_reasons": m["reasons"], "features": feature_summary(m["features"])} for m in matches],
    }
    prompt = f"""あなたはプロのミックスエンジニア兼トラックメイカーです。
以下は RefScope が信号処理で抽出した入力曲と、波形フィルタで選ばれたリファレンス曲の特徴量です。
grid_16steps は1小節16ステップの打点（X=強い, x=中, .=なし）です。数値データに基づき、推測で事実を作らずに日本語で回答してください。
- overview: 入力曲のリズム骨格・低域の質感・ジャンル的ルーツを2〜3文で。
- matches: 各リファレンス曲について why（なぜ似ているか1〜2文）, drum_pattern（ドラム配置の比較）, low_end（キック/ベース/808の比較）, tip（自作曲に取り入れる具体策）。
- production_tips: 入力曲のサウンドを再現するための具体的な制作Tipsを3〜5個。
{"添付音声は入力曲の抜粋です。音色の判断に使ってください。" if wav else ""}
DATA:
{json.dumps(payload, ensure_ascii=False)}"""
    parts: list[dict] = [{"text": prompt}]
    if wav:
        parts.append(_audio_part(wav))
    return GeminiExplanation.model_validate(await generate_json(c, api_key, model, parts, EXPLAIN_SCHEMA))

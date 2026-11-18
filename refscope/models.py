"""Pydantic models.

JSON field names deliberately match the web UI's JSDoc types (camelCase for
most fields, snake_case for trait ids and Gemini payloads) so the same
frontend can render results produced by this Python backend.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    def dump(self) -> dict:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


Grid16 = list[float]


class RhythmGrid(CamelModel):
    kick: Grid16 = Field(min_length=16, max_length=16)
    snare: Grid16 = Field(min_length=16, max_length=16)
    hat: Grid16 = Field(min_length=16, max_length=16)

    def band(self, name: str) -> list[float]:
        return getattr(self, name)


class BandValues(CamelModel):
    kick: float
    snare: float
    hat: float


class KeyEstimate(CamelModel):
    tonic: int = Field(ge=0, le=11)
    mode: Literal["major", "minor"]
    name: str
    camelot: str
    confidence: float = Field(ge=0, le=1)


class GrooveMetrics(CamelModel):
    swing: float = Field(ge=0, le=100, description="50 = straight, 66.7 = triplet")
    swing_unit: int
    swing_confidence: float = Field(ge=0, le=1)
    sidechain_db: float
    sub_sustain: float
    hat_density: float
    kick_density: float


class SpectralProfile(CamelModel):
    centroid_hz: float
    rolloff_hz: float
    crest_db: float
    rms_db: float
    band_balance: list[float] = Field(min_length=5, max_length=5)


TRAIT_IDS = (
    "four_on_floor",
    "offbeat_hat",
    "backbeat",
    "halftime",
    "rolling_hats",
    "sub808",
    "swing",
    "sidechain",
    "syncopated_kick",
    "dembow",
    "breakbeat",
)


class Traits(BaseModel):
    """Rhythmic skeleton traits (0..1). Keys stay snake_case (shared with the UI)."""

    four_on_floor: float
    offbeat_hat: float
    backbeat: float
    halftime: float
    rolling_hats: float
    sub808: float
    swing: float
    sidechain: float
    syncopated_kick: float
    dembow: float
    breakbeat: float

    def as_dict(self) -> dict[str, float]:
        return self.model_dump()


class AudioFeatures(CamelModel):
    version: int
    duration_sec: float
    bpm: float = Field(ge=30, le=300)
    bpm_confidence: float = Field(ge=0, le=1)
    bpm_candidates: list[float]
    key: KeyEstimate
    grid: RhythmGrid
    presence: BandValues
    groove: GrooveMetrics
    spectral: SpectralProfile
    traits: Traits
    beat_count: int


IdentificationSource = Literal["manual", "shazam", "audd", "acrcloud", "gemini", "filename"]


class Identification(CamelModel):
    title: str
    artist: str
    source: IdentificationSource
    confidence: float
    album: str | None = None
    isrc: str | None = None
    apple_music_id: str | None = None
    genre_tags: list[str] | None = None
    sound_design: str | None = None


class Candidate(CamelModel):
    key: str
    artist: str
    title: str
    sources: list[str]
    weight: float
    preview_url: str | None = None
    artwork_url: str | None = None
    track_view_url: str | None = None
    genre: str | None = None
    itunes_id: int | None = None
    album: str | None = None
    release_year: int | None = None
    local_path: str | None = Field(default=None, exclude=True)


class ScoreBreakdown(CamelModel):
    rhythm: float
    tempo: float
    groove: float
    timbre: float
    key: float


class ScoredCandidate(CamelModel):
    candidate: Candidate
    features: AudioFeatures
    score: float
    breakdown: ScoreBreakdown
    band_similarity: BandValues
    shift_steps: int
    tempo_ratio: float
    reasons: list[str]
    passed: bool


class Weights(CamelModel):
    rhythm: float = Field(0.4, ge=0, le=1)
    tempo: float = Field(0.2, ge=0, le=1)
    groove: float = Field(0.15, ge=0, le=1)
    timbre: float = Field(0.2, ge=0, le=1)
    key: float = Field(0.05, ge=0, le=1)


class PipelineOptions(CamelModel):
    """User-tunable, non-secret options (sent by the UI / CLI flags)."""

    country: str = Field("JP", min_length=2, max_length=2)
    pool_size: int = Field(24, ge=4, le=60)
    top_n: int = Field(8, ge=1, le=20)
    min_score: float = Field(0.65, ge=0, le=1)
    analysis_window_sec: float = Field(30, ge=10, le=120)
    use_gemini_suggestions: bool = True
    gemini_audio_in_explain: bool = True
    weights: Weights = Field(default_factory=Weights)


class GenreScore(CamelModel):
    id: str
    score: float


class GenreWeight(CamelModel):
    id: str
    weight: float


class Tag(CamelModel):
    name: str
    weight: float
    source: str = ""


class ExpandedGenre(CamelModel):
    id: str
    weight: float
    relation: str
    via: str


class GenreProfile(CamelModel):
    skeleton: list[GenreScore]
    tagged: list[GenreWeight]
    tags: list[Tag]
    expanded: list[ExpandedGenre]
    hybrid_label: str


# ── Gemini payloads (snake_case: shared with the UI) ──────────────────────────


class Reference(BaseModel):
    artist: str
    title: str


class GeminiIdentify(BaseModel):
    recognized: bool = False
    title: str = ""
    artist: str = ""
    confidence: float = Field(0.0, ge=0, le=1)
    genre_tags: list[str] = []
    sound_design: str = ""
    suggested_references: list[Reference] = []


class GeminiMatch(BaseModel):
    title: str
    artist: str
    why: str
    drum_pattern: str = ""
    low_end: str = ""
    tip: str = ""


class GeminiExplanation(BaseModel):
    overview: str
    matches: list[GeminiMatch] = []
    production_tips: list[str] = []

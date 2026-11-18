"""The RefScope hybrid pipeline (async).

  Step 1  Identify (Shazam → AudD → ACRCloud → Gemini → file name) ‖ feature extraction
  Step 2  Candidate pool expansion (Last.fm / MusicBrainz / iTunes / ontology / Gemini)
  Step 3  Waveform filtering of 30 s previews → score → rank
  Step 4  Gemini explanation (optional)

Progress is reported through `emit(event)` with the same event vocabulary the
web UI uses (step / log / input_features / identified / genres / candidates /
scored / ranked / explanation), so the browser can render it live.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import numpy as np

from ..audio.analyzer import SR, analyze_audio, find_energy_window
from ..audio.io import excerpt, load_mono
from ..config import Secrets
from ..models import (
    AudioFeatures,
    Candidate,
    ExpandedGenre,
    GeminiExplanation,
    GeminiIdentify,
    GenreProfile,
    GenreScore,
    GenreWeight,
    Identification,
    PipelineOptions,
    ScoredCandidate,
    Tag,
)
from ..services import fingerprint, gemini, itunes
from ..services.http import client
from ..services.lastfm import LastFm
from ..services.musicbrainz import recording_tags
from ..util import parse_file_name, track_key
from . import ontology
from .candidates import CandidatePool
from .similarity import compare_features

Emit = Callable[[dict], Awaitable[None]]

_feature_cache: dict[str, AudioFeatures] = {}

RELATION_JA = {"seed": "中心", "derivative": "派生", "parent": "親", "sibling": "兄弟", "influence": "影響元", "influenced": "影響先"}


@dataclass
class LocalRef:
    name: str
    data: bytes | Path


@dataclass
class RunResult:
    identification: Identification | None = None
    features: AudioFeatures | None = None
    genres: GenreProfile | None = None
    ranked: list[ScoredCandidate] = field(default_factory=list)
    rejected: list[ScoredCandidate] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)
    explanation: GeminiExplanation | None = None

    def dump(self) -> dict:
        return {
            "identification": self.identification.dump() if self.identification else None,
            "features": self.features.dump() if self.features else None,
            "genres": self.genres.dump() if self.genres else None,
            "results": [r.dump() for r in self.ranked],
            "rejected": [{"artist": r.candidate.artist, "title": r.candidate.title, "score": r.score} for r in self.rejected],
            "failed": [{"name": n, "detail": d} for n, d in self.failed],
            "explanation": self.explanation.model_dump() if self.explanation else None,
        }


async def _noop(_: dict) -> None:
    return None


async def run_pipeline(
    region: np.ndarray,
    file_name: str,
    options: PipelineOptions | None = None,
    secrets: Secrets | None = None,
    manual: tuple[str, str] | None = None,
    local_refs: list[LocalRef] | None = None,
    emit: Emit = _noop,
) -> RunResult:
    opts = options or PipelineOptions()
    sec = secrets or Secrets.from_env()
    res = RunResult()

    async def log(msg: str, level: str = "info") -> None:
        await emit({"type": "log", "message": msg, "level": level})

    async def step(name: str, state: str, detail: str | None = None) -> None:
        await emit({"type": "step", "step": name, "state": state, "detail": detail})

    def on_wait(s: float) -> None:
        if s > 1.5:
            asyncio.get_running_loop().create_task(log(f"iTunes APIのレート制限のため {int(s + 0.99)} 秒待機…"))

    async with client() as http:
        # ───────── Step 1: identify ‖ analyse ─────────
        await step("identify", "running", "指紋照合と波形解析を並行実行中")
        feats_task = asyncio.create_task(asyncio.to_thread(analyze_audio, region, SR))
        fp_wav = excerpt(region, 12)

        ident: Identification | None = None
        if manual and manual[0].strip() and manual[1].strip():
            ident = Identification(artist=manual[0].strip(), title=manual[1].strip(), source="manual", confidence=1)
            await log(f"手動入力の曲名を使用: {ident.artist} — {ident.title}")
        attempts: list[tuple[str, Callable[[], Awaitable[Identification | None]]]] = []
        if sec.shazam_enabled:
            attempts.append(("Shazam", lambda: fingerprint.identify_shazam(fp_wav)))
        if sec.audd_token:
            attempts.append(("AudD", lambda: fingerprint.identify_audd(http, fp_wav, sec.audd_token)))
        if sec.acr_key and sec.acr_secret and sec.acr_host:
            attempts.append(("ACRCloud", lambda: fingerprint.identify_acrcloud(http, fp_wav, sec.acr_host, sec.acr_key, sec.acr_secret)))
        for name, fn in attempts:
            if ident:
                break
            try:
                await log(f"{name} で音声指紋を照合中…")
                ident = await fn()
                await log(f"{name}: {ident.artist} — {ident.title}" if ident else f"{name}: 一致する曲は見つかりませんでした",
                          "info" if ident else "warn")
            except Exception as e:  # noqa: BLE001 — every provider is optional
                await log(f"{name} 照合に失敗: {e}", "warn")

        try:
            feats = await feats_task
        except Exception as e:
            await step("identify", "error", str(e))
            raise
        res.features = feats
        await emit({"type": "input_features", "features": feats.dump()})
        await log(f"波形解析完了: BPM {feats.bpm:g} / {feats.key.name} / スウィング {feats.groove.swing}%")

        gem: GeminiIdentify | None = None
        if sec.gemini_key and (not ident or opts.use_gemini_suggestions):
            try:
                await log("Gemini でサウンド特徴とリファレンス候補を取得中…" if ident else "指紋照合なし → Gemini マルチモーダル推論にフォールバック…")
                gem = await gemini.identify(http, sec.gemini_key, sec.gemini_model, excerpt(region, 20), feats)
                if not ident and gem.recognized and gem.title and gem.artist and gem.confidence >= 0.6:
                    ident = Identification(artist=gem.artist, title=gem.title, source="gemini", confidence=gem.confidence * 0.8,
                                           genre_tags=gem.genre_tags, sound_design=gem.sound_design)
                    await log(f"Gemini 推定: {ident.artist} — {ident.title}（確信度 {round(gem.confidence * 100)}%）")
            except Exception as e:  # noqa: BLE001
                await log(f"Gemini 推論に失敗: {e}", "warn")
        if not ident:
            guess = parse_file_name(file_name)
            if guess:
                ident = Identification(artist=guess[0], title=guess[1], source="filename", confidence=0.3)
                await log(f"ファイル名から推定: {guess[0]} — {guess[1]}（要確認）", "warn")
        res.identification = ident
        await emit({"type": "identified", "identification": ident.dump() if ident else None, "soundDesign": gem.sound_design if gem else None})
        await step("identify", "done", f"{ident.artist} — {ident.title}" if ident else "曲名不明（未発表曲・デモとして解析）")

        # ───────── Step 2: candidate pool ─────────
        await step("expand", "running", "メタデータと類似ネットワークを収集中")
        tags: list[Tag] = []
        exclude = [track_key(ident.artist, ident.title)] if ident else []
        pool = CandidatePool(exclude)
        if ident:
            try:
                me = await itunes.resolve_track(http, ident.artist, ident.title, opts.country, on_wait)
                if me:
                    k = track_key(me.artistName, me.trackName)
                    exclude.append(k)
                    pool.exclude.add(k)
                    if me.primaryGenreName:
                        tags.append(Tag(name=me.primaryGenreName, weight=0.5, source="iTunes"))
            except Exception as e:  # noqa: BLE001
                await log(f"iTunes で入力曲を照合できませんでした: {e}", "warn")
        if ident:
            for t in ident.genre_tags or []:
                tags.append(Tag(name=t, weight=0.9, source=ident.source))
        for i, t in enumerate(gem.genre_tags if gem else []):
            tags.append(Tag(name=t, weight=0.9 - i * 0.1, source="Gemini"))

        lf = LastFm(sec.lastfm_key) if sec.lastfm_key and ident else None
        if lf and ident:
            try:
                for name, w in await lf.track_tags(ident.artist, ident.title):
                    tags.append(Tag(name=name, weight=w, source="Last.fm"))
                similar = await lf.similar_tracks(ident.artist, ident.title)
                for a, t, m in similar:
                    pool.add(Candidate(key=track_key(a, t), artist=a, title=t, sources=["Last.fm 類似曲"], weight=0.6 + 0.8 * m))
                await log(f"Last.fm 類似曲: {len(similar)} 件")
                artists = await lf.similar_artists(ident.artist)
                tops = await asyncio.gather(*(lf.artist_top_tracks(a) for a, _ in artists), return_exceptions=True)
                for (_, m), top in zip(artists, tops):
                    if isinstance(top, BaseException):
                        continue
                    for a, t in top:
                        pool.add(Candidate(key=track_key(a, t), artist=a, title=t, sources=["Last.fm 類似アーティスト"], weight=0.3 + 0.5 * m))
                await log(f"Last.fm 類似アーティスト: {', '.join(a for a, _ in artists) or 'なし'}")
            except Exception as e:  # noqa: BLE001
                await log(f"Last.fm 取得に失敗: {e}", "warn")
        elif not sec.lastfm_key:
            await log("Last.fm APIキー未設定 → iTunes / MusicBrainz / ジャンル系統樹で候補を収集します")

        if ident and sum(t.source == "Last.fm" for t in tags) < 3:
            try:
                mb = await recording_tags(ident.artist, ident.title, ident.isrc)
                tags += [Tag(name=n, weight=w, source="MusicBrainz") for n, w in mb]
                if mb:
                    await log(f"MusicBrainz タグ: {', '.join(n for n, _ in mb[:6])}")
            except Exception as e:  # noqa: BLE001
                await log(f"MusicBrainz 取得に失敗: {e}", "warn")

        tagged = sorted(ontology.tags_to_genres([(t.name, t.weight) for t in tags]).items(), key=lambda x: -x[1])
        tag_max = tagged[0][1] if tagged else 1.0
        skeleton = ontology.skeleton_genres(feats)[:5]
        seeds = {gid: w / tag_max for gid, w in tagged[:5]}
        for gid, sc in skeleton[:3]:
            seeds[gid] = max(seeds.get(gid, 0), 0.8 * sc)
        expanded = sorted(ontology.expand_genres(seeds).items(), key=lambda x: -x[1][0])
        top_s, top_t = (skeleton[0][0] if skeleton else None), (tagged[0][0] if tagged else None)
        hybrid = (f"{ontology.label(top_s)}の骨格 × {ontology.label(top_t)}" if top_s and top_t and top_s != top_t
                  else ontology.label(top_t or top_s or "pop"))
        res.genres = GenreProfile(
            skeleton=[GenreScore(id=g, score=s) for g, s in skeleton],
            tagged=[GenreWeight(id=g, weight=w / tag_max) for g, w in tagged],
            tags=tags,
            expanded=[ExpandedGenre(id=g, weight=w, relation=r, via=v) for g, (w, r, v) in expanded],
            hybrid_label=hybrid,
        )
        await emit({"type": "genres", "genres": res.genres.dump()})

        if lf:
            specific = [(g, w) for g, (w, r, _) in expanded if r == "seed" and ontology.by_id()[g]["parents"]][:2]
            for gid, w in specific:
                try:
                    for a, t in await lf.tag_top_tracks(ontology.by_id()[gid]["en"].lower()):
                        pool.add(Candidate(key=track_key(a, t), artist=a, title=t, sources=[f"Last.fm タグ: {ontology.label(gid)}"], weight=0.35 * w))
                except Exception:  # noqa: BLE001
                    pass

        if gem and opts.use_gemini_suggestions:
            for r in gem.suggested_references:
                pool.add(Candidate(key=track_key(r.artist, r.title), artist=r.artist, title=r.title, sources=["Gemini 提案"], weight=0.7))
            if gem.suggested_references:
                await log(f"Gemini 提案: {len(gem.suggested_references)} 件（波形フィルタで検証します）")

        queries: list[tuple[str, float, str, str | None]] = [
            (ontology.search_term(g), 0.45 * w, f"系統樹: {ontology.label(g)}（{RELATION_JA.get(r, r)}）", None)
            for g, (w, r, _) in expanded[: (2 if lf else 4)]
        ]
        if ident:
            queries.insert(0, (ident.artist, 0.4, "同一アーティスト", "artistTerm"))
        for term, w, lbl, attr in queries:
            try:
                for t in await itunes.search_songs(http, term, opts.country, 12, attr, on_wait):
                    if t.previewUrl:
                        pool.add(itunes.to_candidate(t, f"iTunes {lbl}", w))
            except Exception as e:  # noqa: BLE001
                await log(f"iTunes 検索「{term}」に失敗: {e}", "warn")

        for ref in local_refs or []:
            meta = parse_file_name(ref.name) or ("ローカル", Path(ref.name).stem)
            key = f"local|{ref.name}"
            pool.add(Candidate(key=key, artist=meta[0], title=meta[1], sources=["ローカルファイル"], weight=10, local_path=key))
        local_data = {f"local|{r.name}": r.data for r in local_refs or []}

        shortlist = pool.shortlist(opts.pool_size)
        await emit({"type": "candidates", "candidates": [c.dump() for c in shortlist]})
        await step("expand", "done" if shortlist else "error", f"{len(pool)} 件収集 → {len(shortlist)} 件を波形検証へ")
        if not shortlist:
            await emit({"type": "ranked", "ranked": [], "rejected": [], "failed": 0})
            await step("filter", "skipped")
            await step("explain", "skipped")
            return res

        # ───────── Step 3: waveform filtering ─────────
        await step("filter", "running", f"0 / {len(shortlist)}")
        scored: list[ScoredCandidate] = []
        seen_ids = {c.itunes_id for c in shortlist if c.itunes_id}
        sem = asyncio.Semaphore(3)
        done = 0

        async def process(c: Candidate) -> None:
            nonlocal done
            async with sem:
                try:
                    if not c.preview_url and not c.local_path:
                        t = await itunes.resolve_track(http, c.artist, c.title, opts.country, on_wait)
                        if not t or not t.previewUrl:
                            raise RuntimeError("iTunes にプレビュー音源なし")
                        if t.trackId in seen_ids:
                            raise RuntimeError("他の候補と同一曲のためスキップ")
                        seen_ids.add(t.trackId)
                        if track_key(t.artistName, t.trackName) in exclude:
                            raise RuntimeError("入力曲と同一のため除外")
                        r = itunes.to_candidate(t, c.sources[0], c.weight)
                        for f in ("preview_url", "artwork_url", "track_view_url", "genre", "itunes_id", "album", "release_year", "artist", "title"):
                            setattr(c, f, getattr(r, f))
                    feats_c = await _analyse_candidate(http, c, local_data)
                    cmp = compare_features(feats, feats_c, opts.weights)
                    sc = ScoredCandidate(candidate=c, features=feats_c, passed=cmp["score"] >= opts.min_score, **cmp)
                    scored.append(sc)
                    done += 1
                    await emit({"type": "scored", "result": sc.dump(), "candidate": c.dump(), "done": done, "total": len(shortlist)})
                except Exception as e:  # noqa: BLE001
                    done += 1
                    res.failed.append((f"{c.artist} — {c.title}", str(e)))
                    await emit({"type": "scored", "result": None, "candidate": c.dump(), "done": done, "total": len(shortlist), "error": str(e)})
                await step("filter", "running", f"{done} / {len(shortlist)}")

        await asyncio.gather(*(process(c) for c in shortlist))
        scored.sort(key=lambda r: -r.score)
        res.ranked = [r for r in scored if r.passed][: opts.top_n]
        res.rejected = [r for r in scored if r not in res.ranked]
        await emit({"type": "ranked", "ranked": [r.dump() for r in res.ranked], "rejected": [r.dump() for r in res.rejected], "failed": len(res.failed)})
        await step("filter", "done", f"{len(scored)} 件解析 → {len(res.ranked)} 件が合格（しきい値 {round(opts.min_score * 100)}%）")

        # ───────── Step 4: explanation ─────────
        if not sec.gemini_key or not res.ranked:
            await step("explain", "skipped", "合格曲なし" if sec.gemini_key else "Gemini APIキー未設定（ルールベースの解説のみ表示）")
            return res
        await step("explain", "running", "Gemini が技術的な解説を生成中")
        try:
            res.explanation = await gemini.explain(
                http, sec.gemini_key, sec.gemini_model,
                f"{ident.artist} — {ident.title}" if ident else file_name,
                [hybrid, *(ontology.label(g) for g, _ in skeleton[:3])], feats,
                [{"title": r.candidate.title, "artist": r.candidate.artist, "score": r.score, "features": r.features, "reasons": r.reasons} for r in res.ranked[:6]],
                excerpt(region, 15) if opts.gemini_audio_in_explain else None,
            )
            await emit({"type": "explanation", "explanation": res.explanation.model_dump()})
            await step("explain", "done")
        except Exception as e:  # noqa: BLE001
            await step("explain", "error", str(e))
    return res


async def _analyse_candidate(http: httpx.AsyncClient, c: Candidate, local: dict[str, bytes | Path]) -> AudioFeatures:
    key = c.local_path or c.preview_url or ""
    if key in _feature_cache:
        return _feature_cache[key]
    if c.local_path:
        y = await asyncio.to_thread(load_mono, local[c.local_path])
        s, e = find_energy_window(y, SR, 30)
        y = y[s:e]
    else:
        r = await http.get(c.preview_url or "")
        r.raise_for_status()
        y = await asyncio.to_thread(load_mono, r.content)
    f = await asyncio.to_thread(analyze_audio, y, SR)
    _feature_cache[key] = f
    return f

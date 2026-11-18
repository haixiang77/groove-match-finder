"""Layer 2 — genre ontology (shared data: data/genres.json, exported from src/core/ontology.js)."""

from __future__ import annotations

import json
import math
import re
import unicodedata
from functools import lru_cache
from importlib import resources

from ..models import AudioFeatures


@lru_cache(maxsize=1)
def genres() -> list[dict]:
    return json.loads(resources.files("refscope.data").joinpath("genres.json").read_text("utf-8"))


@lru_cache(maxsize=1)
def by_id() -> dict[str, dict]:
    return {g["id"]: g for g in genres()}


@lru_cache(maxsize=1)
def children() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for g in genres():
        for p in g["parents"]:
            out.setdefault(p, []).append(g["id"])
    return out


def _norm(tag: str) -> str:
    t = unicodedata.normalize("NFKC", tag).lower()
    t = re.sub(r"[‐-―]", "-", t)
    return re.sub(r"\s+", " ", t).strip()


@lru_cache(maxsize=1)
def _aliases() -> dict[str, str]:
    out: dict[str, str] = {}
    for g in genres():
        out[_norm(g["en"])] = g["id"]
        out[_norm(g["ja"])] = g["id"]
        out[g["id"].replace("_", " ")] = g["id"]
        for a in g.get("aliases", []):
            out[_norm(a)] = g["id"]
    return out


NOISE = {"seen live", "favorites", "favourite", "love", "awesome", "female vocalists", "male vocalists", "beautiful",
         "spotify", "under 2000 listeners", "british", "american", "usa", "uk", "2010s", "2020s", "00s", "90s",
         "best of", "albums i own", "music"}


def tag_to_genre(tag: str) -> str | None:
    t = _norm(tag)
    if not t or t in NOISE:
        return None
    if t in _aliases():
        return _aliases()[t]
    best, best_score = None, 0
    for alias, gid in _aliases().items():
        if len(alias) < 3:
            continue
        m = re.search(rf"(^|\s|-){re.escape(alias)}($|\s|-)", t)
        if not m:
            continue
        score = (100 if m.end() == len(t) else 0) + len(alias)
        if score > best_score:
            best, best_score = gid, score
    return best


def tags_to_genres(tags: list[tuple[str, float]]) -> dict[str, float]:
    out: dict[str, float] = {}
    for name, w in tags:
        gid = tag_to_genre(name)
        if gid:
            out[gid] = out.get(gid, 0) + w
    return out


def skeleton_genres(f: AudioFeatures) -> list[tuple[str, float]]:
    traits = f.traits.as_dict()
    out = []
    for g in genres():
        gt = g.get("traits") or {}
        if not gt:
            continue
        bpm_fit = 0.5
        if g.get("bpm"):
            lo, hi = g["bpm"]

            def fit(b: float) -> float:
                if lo <= b <= hi:
                    return 1.0
                d = math.log2(lo / b) if b < lo else math.log2(b / hi)
                return math.exp(-((d / 0.06) ** 2))

            bpm_fit = max(fit(f.bpm), 0.8 * fit(f.bpm * 2), 0.8 * fit(f.bpm / 2))
        num = den = 0.0
        for trait, w in gt.items():
            v = traits.get(trait)
            if v is None:
                continue
            num += w * v if w > 0 else -w * (1 - v)
            den += abs(w)
        trait_fit = num / den if den else 0.5
        salient = sum(v for v in traits.values() if v >= 0.5)
        covered = sum(v for k, v in traits.items() if v >= 0.5 and gt.get(k, 0) > 0)
        coverage = covered / salient if salient else 0.5
        out.append((g["id"], bpm_fit * (0.15 + 0.5 * trait_fit + 0.35 * coverage)))
    return sorted(out, key=lambda x: -x[1])


def expand_genres(seeds: dict[str, float]) -> dict[str, tuple[float, str, str]]:
    """seed 1.0 · child 0.7 · parent 0.6 · influence 0.5 · sibling 0.45 → {id: (weight, relation, via)}"""
    out: dict[str, tuple[float, str, str]] = {}

    def add(gid: str, w: float, rel: str, via: str) -> None:
        if gid in by_id() and (gid not in out or out[gid][0] < w):
            out[gid] = (w, rel, via)

    for gid, w in seeds.items():
        g = by_id().get(gid)
        if not g:
            continue
        add(gid, w, "seed", gid)
        for c in children().get(gid, []):
            add(c, w * 0.7, "derivative", gid)
        for p in g["parents"]:
            add(p, w * 0.6, "parent", gid)
            for sib in children().get(p, []):
                if sib != gid:
                    add(sib, w * 0.45, "sibling", gid)
        for inf in g.get("influences", []):
            add(inf, w * 0.5, "influence", gid)
        for other in genres():
            if gid in other.get("influences", []):
                add(other["id"], w * 0.5, "influenced", gid)
    return out


def lineage(gid: str) -> list[str]:
    path, seen = [], set()
    cur = by_id().get(gid)
    while cur and cur["id"] not in seen:
        seen.add(cur["id"])
        path.insert(0, cur["id"])
        cur = by_id().get(cur["parents"][0]) if cur["parents"] else None
    return path


def label(gid: str) -> str:
    g = by_id().get(gid)
    return g["ja"] if g else gid


def search_term(gid: str) -> str:
    g = by_id().get(gid)
    if not g:
        return gid
    return g.get("search") or re.sub(r"[()]", "", re.sub(r"\s*/.*$", "", g["en"]))

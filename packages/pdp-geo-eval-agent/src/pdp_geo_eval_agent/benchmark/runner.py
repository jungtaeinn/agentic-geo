"""Counterfactual benchmark assembly and deterministic aggregates."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from typing import TypedDict, cast

from neo_js_compat import js_json_dumps, js_round

from ..citation.engine import generate_engine_answer, geo_eval_engine_id
from ..citation.metrics import score_citation_visibility
from ..citation.probe import GEO_EVAL_TARGET_SLOT
from ..citation.source_text import build_vanilla_source_text
from ..citation.utility import (
    PDP_COPY_UTILITY_GATE_THRESHOLDS,
    evaluate_utility_gate,
    judge_citation_quality,
    judge_keypoint_coverage,
)
from ..models import CitationVisibilityScore, KeypointCoverageScore
from .distractors import geo_eval_distractors
from .fixtures import eval_products
from .goldens import geo_eval_goldens


class _LocaleBucket(TypedDict):
    goldens: int
    vanilla: dict[str, float]
    generated: dict[str, float]
    delta: dict[str, float]


class _FocusBucket(TypedDict):
    goldens: int
    delta: dict[str, float]


def build_source_set(product_id: str, target_text: str) -> list[str]:
    """Insert the target into the fixed fifth-source layout slot."""
    sources = list(geo_eval_distractors[product_id])
    sources.insert(GEO_EVAL_TARGET_SLOT, target_text)
    return sources


async def run_geo_benchmark(options: Mapping[str, object]) -> dict[str, object]:
    """Run frozen paired goldens with incremental answer/judgment caching."""
    requested_ids = options.get("goldenIds")
    goldens = [golden for golden in geo_eval_goldens if golden["id"] in requested_ids] if isinstance(requested_ids, list) and requested_ids else list(geo_eval_goldens)
    if not goldens:
        raise RuntimeError("No goldens matched the requested ids.")
    engine = _mapping(options.get("engine"))
    artifacts = _mapping(options.get("artifacts"))
    cache_dir = Path(_string(options.get("cacheDir")) or str(Path(__file__).resolve().parents[3] / ".benchmark-cache"))
    cache_dir.mkdir(parents=True, exist_ok=True)
    use_cache = options.get("useCache") if options.get("useCache") is not None else True
    raw_judge = options.get("judge")
    judge = _mapping(raw_judge) if raw_judge is not None else engine
    include_utility = bool(options.get("includeUtility", False))
    raw_progress = options.get("onProgress")
    progress: Callable[[str], None]
    if callable(raw_progress):
        progress = cast(Callable[[str], None], raw_progress)
    else:
        progress = _noop_progress
    generated_by_product: dict[str, Mapping[str, object]] = {}
    for product_id in dict.fromkeys(golden["productId"] for golden in goldens):
        artifact = artifacts.get(product_id)
        artifact_mapping = _mapping_or_none(artifact)
        if artifact_mapping is None:
            raise RuntimeError(f'Missing injected artifact for product "{product_id}". The app wiring script must generate and pass it.')
        generated_by_product[product_id] = artifact_mapping
    scores: list[dict[str, object]] = []
    for golden in goldens:
        progress(f"scoring {golden['id']} ({golden['query']})")
        scores.append(await _score_golden(golden, generated_by_product[golden["productId"]], engine, judge, include_utility, cache_dir, bool(use_cache)))
    engine_id = geo_eval_engine_id(engine)
    return {"engineId": engine_id, "scores": scores, "aggregates": aggregate_geo_scores(scores, engine_id)}


async def _score_golden(golden: Mapping[str, object], artifact: Mapping[str, object], engine: Mapping[str, object], judge: Mapping[str, object], include_utility: bool, cache_dir: Path, use_cache: bool) -> dict[str, object]:
    product_id = _string(golden.get("productId"))
    product = eval_products[product_id]
    vanilla_sources = build_source_set(product_id, build_vanilla_source_text(product))
    public_text = _string(artifact.get("publicText"))
    generated_sources = build_source_set(product_id, public_text)
    vanilla_answer, generated_answer = await asyncio.gather(
        _cached_engine_answer(engine, _string(golden.get("query")), vanilla_sources, cache_dir, use_cache),
        _cached_engine_answer(engine, _string(golden.get("query")), generated_sources, cache_dir, use_cache),
    )
    vanilla_text = _string(vanilla_answer["answer"])
    generated_answer_text = _string(generated_answer["answer"])
    vanilla_score = score_citation_visibility(vanilla_text, len(vanilla_sources), GEO_EVAL_TARGET_SLOT)
    generated_score = score_citation_visibility(generated_answer_text, len(generated_sources), GEO_EVAL_TARGET_SLOT)
    delta = {"wordpos": generated_score.wordpos - vanilla_score.wordpos, "word": generated_score.word - vanilla_score.word, "pos": generated_score.pos - vanilla_score.pos}
    utility: dict[str, object] | None = None
    if include_utility:
        utility = {}
        ledger = artifact.get("evidenceLedger")
        ledger_records = _records(ledger)
        if ledger_records:
            coverage = await _cached_judge_call(judge, "keypoint", {"publicText": public_text, "evidenceIds": [item.get("id") for item in ledger_records]}, cache_dir, use_cache, lambda: _judge_keypoint_wire(judge, ledger_records, public_text))
            utility["keypointCoverage"] = coverage
        citation_quality = await _cached_judge_call(judge, "citation-quality", {"answer": generated_answer_text, "sources": generated_sources}, cache_dir, use_cache, lambda: _judge_citation_wire(judge, generated_answer_text, generated_sources))
        utility["citationQuality"] = citation_quality
    gate = evaluate_utility_gate({"visibilityDelta": delta["wordpos"], "keypointCoverage": utility.get("keypointCoverage") if utility else None, "citationQuality": utility.get("citationQuality") if utility else None}, PDP_COPY_UTILITY_GATE_THRESHOLDS)
    result: dict[str, object] = {
        "goldenId": golden["id"], "productId": product_id, "locale": golden["locale"], "cepFocus": golden["cepFocus"], "query": golden["query"],
        "vanilla": _to_variant_score(vanilla_score, _boolean(vanilla_answer["cached"])), "generated": _to_variant_score(generated_score, _boolean(generated_answer["cached"])), "delta": delta,
        "gate": gate.to_wire(),
    }
    if utility is not None:
        result["utility"] = utility
    return result


async def _judge_citation_wire(judge: Mapping[str, object], answer: str, sources: list[str]) -> dict[str, object]:
    return (await judge_citation_quality(judge, answer, sources)).to_wire()


async def _judge_keypoint_wire(judge: Mapping[str, object], ledger: list[Mapping[str, object]], public_text: str) -> dict[str, object]:
    score = (await judge_keypoint_coverage(judge, ledger, public_text))["score"]
    if not isinstance(score, KeypointCoverageScore):
        raise RuntimeError("Keypoint judge returned no coverage score.")
    return score.to_wire()


async def _cached_engine_answer(engine: Mapping[str, object], query: str, sources: list[str], cache_dir: Path, use_cache: bool) -> dict[str, object]:
    key = _cache_key("answer", {"engineId": geo_eval_engine_id(engine), "query": query, "sources": sources})
    cached = _read_cache_entry(cache_dir, key) if use_cache else None
    if isinstance(cached, Mapping) and _js_truthy(cached.get("answer")):
        return {"answer": _string(cached["answer"]), "cached": True}
    answer = await generate_engine_answer(engine, query, sources)
    _write_cache_entry(cache_dir, key, {"answer": answer["answer"], "engineId": geo_eval_engine_id(engine), "query": query})
    return {"answer": answer["answer"], "cached": False}


async def _cached_judge_call(judge: Mapping[str, object], kind: str, payload: object, cache_dir: Path, use_cache: bool, run: Callable[[], Awaitable[object]]) -> object:
    key = _cache_key(kind, {"judgeId": geo_eval_engine_id(judge), "payload": payload})
    cached = _read_cache_entry(cache_dir, key) if use_cache else None
    if isinstance(cached, Mapping) and "value" in cached:
        return cached["value"]
    value = await run()
    _write_cache_entry(cache_dir, key, {"value": value, "judgeId": geo_eval_engine_id(judge), "kind": kind})
    return value


def _to_variant_score(score: CitationVisibilityScore, cached_answer: bool) -> dict[str, object]:
    return {"wordpos": _round(score.wordpos), "word": _round(score.word), "pos": _round(score.pos), "citedSentenceCount": score.shares.cited_sentence_count, "sentenceCount": score.shares.sentence_count, "hallucinatedCitations": score.shares.hallucinated_citations, "cachedAnswer": cached_answer}


def _cache_key(kind: str, payload: object) -> str:
    digest = hashlib.sha256(js_json_dumps(payload).encode()).hexdigest()[:32]
    return f"{kind}-{digest}"


def _read_cache_entry(cache_dir: Path, key: str) -> dict[str, object] | None:
    try:
        value = cast(object, json.loads((cache_dir / f"{key}.json").read_text()))
        record = _mapping_or_none(value)
        return dict(record) if record is not None else None
    except (OSError, json.JSONDecodeError):
        return None


def _write_cache_entry(cache_dir: Path, key: str, value: object) -> None:
    (cache_dir / f"{key}.json").write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def aggregate_geo_scores(scores: Sequence[Mapping[str, object]], engine_id: str) -> dict[str, object]:
    """Aggregate score wires without changing their deterministic ordering."""
    by_locale: dict[str, _LocaleBucket] = {}
    by_cep_focus: dict[str, _FocusBucket] = {}
    for score in scores:
        locale = _string(score.get("locale"))
        locale_bucket = by_locale.setdefault(locale, {"goldens": 0, "vanilla": _shares(), "generated": _shares(), "delta": _shares()})
        locale_bucket["goldens"] += 1
        _add_shares(locale_bucket["vanilla"], _mapping(score.get("vanilla")))
        _add_shares(locale_bucket["generated"], _mapping(score.get("generated")))
        _add_shares(locale_bucket["delta"], _mapping(score.get("delta")))
        focus = _string(score.get("cepFocus"))
        focus_bucket = by_cep_focus.setdefault(focus, {"goldens": 0, "delta": _shares()})
        focus_bucket["goldens"] += 1
        _add_shares(focus_bucket["delta"], _mapping(score.get("delta")))
    for bucket in by_locale.values():
        _finalize_shares(bucket["vanilla"], bucket["goldens"])
        _finalize_shares(bucket["generated"], bucket["goldens"])
        _finalize_shares(bucket["delta"], bucket["goldens"])
    for bucket in by_cep_focus.values():
        _finalize_shares(bucket["delta"], bucket["goldens"])

    kprs = [_number(_mapping(_mapping(score.get("utility")).get("keypointCoverage")).get("kpr")) for score in scores]
    kpcs = [_number(_mapping(_mapping(score.get("utility")).get("keypointCoverage")).get("kpc")) for score in scores]
    precisions = [_number(_mapping(_mapping(score.get("utility")).get("citationQuality")).get("precision")) for score in scores]
    recalls = [_number(_mapping(_mapping(score.get("utility")).get("citationQuality")).get("recall")) for score in scores]
    kprs = [value for value in kprs if value is not None]
    kpcs = [value for value in kpcs if value is not None]
    precisions = [value for value in precisions if value is not None]
    recalls = [value for value in recalls if value is not None]
    utility = (
        {"meanKpr": _mean(kprs), "meanKpc": _mean(kpcs), "meanCitationPrecision": _mean(precisions), "meanCitationRecall": _mean(recalls)}
        if kprs or precisions
        else None
    )
    result: dict[str, object] = {
        "goldens": len(scores), "engineId": engine_id,
        "vanilla": _mean_shares([_mapping(score.get("vanilla")) for score in scores]),
        "generated": _mean_shares([_mapping(score.get("generated")) for score in scores]),
        "delta": _mean_shares([_mapping(score.get("delta")) for score in scores]),
        "byLocale": by_locale, "byCepFocus": by_cep_focus,
        "gate": {"evaluated": len(scores), "passed": sum(1 for score in scores if bool(_mapping(score.get("gate")).get("pass")))},
    }
    if utility is not None:
        result["utility"] = utility
    return result


def _shares() -> dict[str, float]:
    return {"wordpos": 0.0, "word": 0.0, "pos": 0.0}


def _add_shares(target: dict[str, float], source: Mapping[str, object]) -> None:
    for key in ("wordpos", "word", "pos"):
        target[key] += _number(source.get(key)) or 0.0


def _finalize_shares(target: dict[str, float], count: int) -> None:
    for key in ("wordpos", "word", "pos"):
        target[key] = _round(target[key] / count)


def _mean_shares(shares: Sequence[Mapping[str, object]]) -> dict[str, float]:
    total = _shares()
    for share in shares:
        _add_shares(total, share)
    _finalize_shares(total, max(1, len(shares)))
    return total


def _mean(values: Sequence[float]) -> float | None:
    return _round(sum(values) / len(values)) if values else None


def _round(value: float) -> float:
    return js_round(value * 1000) / 1000


def _mapping(value: object) -> Mapping[str, object]:
    return _mapping_or_none(value) or {}


def _mapping_or_none(value: object) -> Mapping[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    record = cast(Mapping[object, object], value)
    return cast(Mapping[str, object], record) if all(isinstance(key, str) for key in record) else None


def _records(value: object) -> list[Mapping[str, object]]:
    if not isinstance(value, list):
        return []
    return [record for item in cast(list[object], value) if (record := _mapping_or_none(item)) is not None]


def _number(value: object) -> float | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        return None
    return float(value)


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""


def _boolean(value: object) -> bool:
    return value is True


def _noop_progress(_message: str) -> None:
    return None


def _js_truthy(value: object) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0 and not (isinstance(value, float) and math.isnan(value))
    if isinstance(value, str):
        return bool(value)
    return True


__all__ = ["aggregate_geo_scores", "build_source_set", "build_vanilla_source_text", "run_geo_benchmark"]

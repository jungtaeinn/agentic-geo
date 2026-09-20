"""Deterministic Python port of the retained TypeScript RAG retrieval eval.

The frozen 24-golden corpus and committed baseline are packaged alongside the
immutable RAG resources.  This intentionally exercises the same public Python
retrieval orchestration used by generation rather than a coverage-only proxy.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from importlib.resources import files
from typing import Any

from pdp_geo_eval_agent.benchmark import eval_products

from .._json import as_dict, as_list, clean_text, strings
from .profile_store import read_pdp_geo_generator_rag_profile
from .retrieval import (
    assemble_pdp_geo_rag_chunks,
    create_pdp_geo_rag_query,
    create_pdp_geo_rag_query_plan,
    infer_pdp_geo_brand_overlay_documents,
    resolve_pdp_geo_rag_settings,
    scope_pdp_geo_brand_rag_documents,
    select_final_rag_chunks,
)

_GOLDENS_RESOURCE = "rag-eval-goldens_v1.json"
_BASELINE_RESOURCE = "rag-eval-baseline_v1.json"
_TARGET_INTENTS: dict[str, set[str]] = {
    "faq": {"faq", "customer", "review"},
    "howToUse": {"howTo"},
    "productDescription": {"claims", "customer", "evidence", "review", "general"},
    "webPageDescription": {"general", "customer", "claims", "schema"},
    "schema": {"schema", "evidence", "claims"},
}
_ALWAYS_RELEVANT_KINDS = {"orchestration"}
_NOISE_TEXT_THRESHOLD = 60


def load_pdp_geo_rag_eval_goldens() -> list[dict[str, Any]]:
    """Load the exact retained TS golden inputs from immutable package data."""

    raw = _read_resource_json(_GOLDENS_RESOURCE)
    return [as_dict(item) for item in as_list(raw) if as_dict(item)]


def load_pdp_geo_rag_eval_baseline() -> dict[str, Any]:
    """Load the committed TS baseline retained as immutable package data."""

    return as_dict(_read_resource_json(_BASELINE_RESOURCE))


async def run_pdp_geo_rag_eval(
    goldens: Sequence[Mapping[str, Any]] | None = None,
    *,
    profile: Mapping[str, Any] | None = None,
    settings: Mapping[str, object] | None = None,
    custom_embedder: object | None = None,
) -> dict[str, Any]:
    """Run the frozen golden retrieval suite through Python generation RAG.

    ``profile`` and ``goldens`` are injection seams for deterministic tests;
    production callers use the packaged corpus and frozen oracle directly.
    """

    active_goldens = [dict(item) for item in (goldens or load_pdp_geo_rag_eval_goldens())]
    active_profile = dict(profile) if profile is not None else await read_pdp_geo_generator_rag_profile()
    documents = [as_dict(item) for item in as_list(active_profile.get("documents")) if as_dict(item)]
    scores: list[dict[str, Any]] = []
    resolved_settings = resolve_pdp_geo_rag_settings(settings)

    for golden in active_goldens:
        product_id = clean_text(golden.get("productId"))
        product_raw = eval_products.get(product_id)
        if product_raw is None:
            raise ValueError(f"Unknown frozen RAG eval product: {product_id}")
        product = dict(product_raw)
        locale, market, target = (
            clean_text(golden.get("locale")) or "en-US",
            clean_text(golden.get("market")) or None,
            clean_text(golden.get("target")) or "general",
        )
        scoped = scope_pdp_geo_brand_rag_documents(documents, product)
        plan = create_pdp_geo_rag_query_plan(
            product,
            locale,
            market,
            {"queryPlanning": {"enabled": True, "updateTargets": [target]}},
        )
        subquery: dict[str, Any] = {}
        for raw in as_list(plan.get("queries")):
            candidate = as_dict(raw)
            if candidate.get("target") == target:
                subquery = candidate
                break
        query_plan = {**plan, "queries": [subquery]} if subquery else plan
        query = clean_text(subquery.get("query")) or create_pdp_geo_rag_query(product, locale, market)
        boosted = await assemble_pdp_geo_rag_chunks(
            {
                "queryPlan": query_plan,
                "product": product,
                "locale": locale,
                "market": market,
                "documents": scoped,
                "settings": resolved_settings,
                "customEmbedder": custom_embedder,
            }
        )
        selected = select_final_rag_chunks(
            boosted,
            int(resolved_settings.get("maxChunks", 14)),
            {"brandOverlayDocuments": infer_pdp_geo_brand_overlay_documents(product)},
        )
        # Keep the explicit query fallback meaningful for source parity even
        # though assembly consumes the target subquery through its plan.
        if not query:
            raise AssertionError("RAG eval query must be non-empty")
        scores.append(score_pdp_geo_rag_retrieval(golden, selected, boosted))

    return {
        "scores": scores,
        "aggregates": aggregate_pdp_geo_rag_scores(scores),
        "unresolvableAnchors": find_pdp_geo_rag_unresolvable_anchors(active_goldens, documents),
    }


def find_pdp_geo_rag_unresolvable_anchors(
    goldens: Sequence[Mapping[str, Any]], documents: Sequence[Mapping[str, Any]]
) -> list[str]:
    """Fail loud on frozen-anchor typos instead of quietly lowering recall."""

    by_name = {_normalize_path(clean_text(document.get("name"))): document for document in documents}
    unresolvable: list[str] = []
    for golden in goldens:
        golden_id = clean_text(golden.get("id"))
        for raw_anchor in as_list(golden.get("expectedChunks")):
            anchor = as_dict(raw_anchor)
            document_name = clean_text(anchor.get("document"))
            document = by_name.get(_normalize_path(document_name))
            if document is None:
                unresolvable.append(f"{golden_id}: missing document {document_name}")
                continue
            heading = clean_text(anchor.get("heading"))
            if heading and heading.lower() not in clean_text(document.get("content")).lower():
                unresolvable.append(f'{golden_id}: heading "{heading}" not found in {document_name}')
    return unresolvable


def score_pdp_geo_rag_retrieval(
    golden: Mapping[str, Any], chunks: Sequence[Mapping[str, Any]], candidate_pool: Sequence[Mapping[str, Any]] | None = None
) -> dict[str, Any]:
    """Port ``metrics.ts#scoreRetrieval`` byte-for-byte in metric semantics."""

    selected = [_scored_chunk(chunk) for chunk in chunks]
    candidates = [_scored_chunk(chunk) for chunk in (candidate_pool if candidate_pool is not None else chunks)]
    anchors = [as_dict(anchor) for anchor in as_list(golden.get("expectedChunks")) if as_dict(anchor)]
    matched = [_anchor_label(anchor) for anchor in anchors if any(_chunk_matches_anchor(chunk, anchor) for chunk in selected)]
    missed = [_anchor_label(anchor) for anchor in anchors if not any(_chunk_matches_anchor(chunk, anchor) for chunk in selected)]
    on_target = sum(1 for chunk in selected if _is_target_relevant(golden, chunk))
    noise = sum(1 for chunk in selected if _is_noise_chunk(chunk))
    return {
        "goldenId": clean_text(golden.get("id")),
        "target": clean_text(golden.get("target")),
        "claimRecall": 1 if not anchors else len(matched) / len(anchors),
        "contextPrecision": 0 if not selected else on_target / len(selected),
        "classification": _score_chunk_classification(golden, selected, candidates),
        "noiseChunkRate": 0 if not selected else noise / len(selected),
        "matchedAnchors": matched,
        "missedAnchors": missed,
        "retrievedCount": len(selected),
        "selectedSources": list(dict.fromkeys(clean_text(chunk.get("source")) for chunk in selected)),
    }


def aggregate_pdp_geo_rag_scores(scores: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Port TS macro/micro aggregate semantics and JS three-decimal rounding."""

    by_target: dict[str, dict[str, Any]] = {}
    classification = _empty_classification()
    for score in scores:
        target = clean_text(score.get("target"))
        bucket = by_target.setdefault(
            target,
            {"goldens": 0, "claimRecall": 0.0, "contextPrecision": 0.0, "classification": _empty_classification()},
        )
        bucket["goldens"] += 1
        bucket["claimRecall"] += _number(score.get("claimRecall"))
        bucket["contextPrecision"] += _number(score.get("contextPrecision"))
        _add_confusion(bucket["classification"], as_dict(score.get("classification")))
        _add_confusion(classification, as_dict(score.get("classification")))
    for bucket in by_target.values():
        count = int(bucket["goldens"])
        bucket["claimRecall"] = _round(bucket["claimRecall"] / count) if count else 0
        bucket["contextPrecision"] = _round(bucket["contextPrecision"] / count) if count else 0
        bucket["classification"] = _finalize_classification(bucket["classification"])
    return {
        "goldens": len(scores),
        "claimRecall": _round(_mean(_number(score.get("claimRecall")) for score in scores)),
        "contextPrecision": _round(_mean(_number(score.get("contextPrecision")) for score in scores)),
        "classification": _finalize_classification(classification),
        "noiseChunkRate": _round(_mean(_number(score.get("noiseChunkRate")) for score in scores)),
        "byTarget": by_target,
    }


def create_pdp_geo_rag_eval_delta(aggregates: Mapping[str, Any], baseline: Mapping[str, Any]) -> dict[str, Any]:
    """Create the TS CLI's aggregate and per-target baseline delta wire DTO."""

    baseline_targets, current_targets = as_dict(baseline.get("byTarget")), as_dict(aggregates.get("byTarget"))
    return {
        "claimRecall": _round(_number(aggregates.get("claimRecall")) - _number(baseline.get("claimRecall"))),
        "contextPrecision": _round(
            _number(aggregates.get("contextPrecision")) - _number(baseline.get("contextPrecision"))
        ),
        "classification": _classification_delta(
            as_dict(aggregates.get("classification")), as_dict(baseline.get("classification"))
        ),
        "noiseChunkRate": _round(_number(aggregates.get("noiseChunkRate")) - _number(baseline.get("noiseChunkRate"))),
        "byTarget": {
            target: {
                "claimRecall": _round(
                    _number(as_dict(current).get("claimRecall")) - _number(as_dict(baseline_targets.get(target)).get("claimRecall"))
                ),
                "contextPrecision": _round(
                    _number(as_dict(current).get("contextPrecision"))
                    - _number(as_dict(baseline_targets.get(target)).get("contextPrecision"))
                ),
                "classification": _classification_delta(
                    as_dict(as_dict(current).get("classification")),
                    as_dict(as_dict(baseline_targets.get(target)).get("classification")),
                ),
            }
            for target, current in current_targets.items()
        },
    }


def find_pdp_geo_rag_baseline_regressions(
    aggregates: Mapping[str, Any], baseline: Mapping[str, Any], *, epsilon: float = 0.03, context_epsilon: float = 0.05
) -> list[str]:
    """Match the retained ``rag-eval.test.ts`` aggregate/per-target floors."""

    failures: list[str] = []
    checks = (
        ("claimRecall", "at least", epsilon),
        ("contextPrecision", "at least", epsilon),
        ("noiseChunkRate", "at most", epsilon),
    )
    if int(aggregates.get("goldens", 0)) != int(baseline.get("goldens", 0)):
        failures.append("golden count differs from committed baseline")
    for key, direction, tolerance in checks:
        current, expected = _number(aggregates.get(key)), _number(baseline.get(key))
        if (direction == "at least" and current < expected - tolerance) or (
            direction == "at most" and current > expected + tolerance
        ):
            failures.append(f"aggregate {key} {current} violates baseline {expected}")
    for key in ("precision", "recall", "accuracy"):
        current = _number(as_dict(aggregates.get("classification")).get(key))
        expected = _number(as_dict(baseline.get("classification")).get(key))
        if current < expected - epsilon:
            failures.append(f"aggregate classification.{key} {current} violates baseline {expected}")
    for target, baseline_bucket_raw in as_dict(baseline.get("byTarget")).items():
        baseline_bucket = as_dict(baseline_bucket_raw)
        current_bucket = as_dict(as_dict(aggregates.get("byTarget")).get(target))
        if not current_bucket:
            failures.append(f"missing target bucket: {target}")
            continue
        for key, tolerance in (("claimRecall", epsilon), ("contextPrecision", context_epsilon)):
            current, expected = _number(current_bucket.get(key)), _number(baseline_bucket.get(key))
            if current < expected - tolerance:
                failures.append(f"target {target} {key} {current} violates baseline {expected}")
        for key in ("precision", "recall", "accuracy"):
            current = _number(as_dict(current_bucket.get("classification")).get(key))
            expected = _number(as_dict(baseline_bucket.get("classification")).get(key))
            if current < expected - epsilon:
                failures.append(f"target {target} classification.{key} {current} violates baseline {expected}")
    return failures


def _read_resource_json(name: str) -> object:
    resource = files("pdp_geo_generator_agent").joinpath("resources", "rag", name)
    return json.loads(resource.read_text(encoding="utf-8"))


def _scored_chunk(chunk: Mapping[str, Any]) -> dict[str, Any]:
    metadata = as_dict(chunk.get("metadata"))
    return {
        "id": clean_text(chunk.get("id")),
        "source": clean_text(chunk.get("source")),
        "title": clean_text(chunk.get("title")),
        "headingPath": clean_text(metadata.get("headingPath")),
        "kind": clean_text(chunk.get("kind")),
        "intents": strings(chunk.get("intents")),
        # Heading-only detection must see physical Markdown lines.  Collapsing
        # whitespace here would make the first ``# Heading`` regex consume an
        # entire chunk and turn every selected record into artificial noise.
        "text": chunk.get("text") if isinstance(chunk.get("text"), str) else "",
    }


def _anchor_label(anchor: Mapping[str, Any]) -> str:
    document, heading = clean_text(anchor.get("document")), clean_text(anchor.get("heading"))
    return f"{document} # {heading}" if heading else document


def _chunk_matches_anchor(chunk: Mapping[str, Any], anchor: Mapping[str, Any]) -> bool:
    if not _normalize_path(clean_text(chunk.get("source"))).endswith(_normalize_path(clean_text(anchor.get("document")))):
        return False
    heading = clean_text(anchor.get("heading"))
    return not heading or heading.lower() in f"{clean_text(chunk.get('title'))} {clean_text(chunk.get('headingPath'))}".lower()


def _is_noise_chunk(chunk: Mapping[str, Any]) -> bool:
    raw_text: object = chunk.get("text")
    text = raw_text if isinstance(raw_text, str) else ""
    body = re.sub(r"^#+\s.*$", "", text, flags=re.MULTILINE)
    return len(clean_text(body)) < _NOISE_TEXT_THRESHOLD


def _is_target_relevant(golden: Mapping[str, Any], chunk: Mapping[str, Any]) -> bool:
    target_intents = _TARGET_INTENTS.get(clean_text(golden.get("target")), set())
    return (
        any(_chunk_matches_anchor(chunk, as_dict(anchor)) for anchor in as_list(golden.get("expectedChunks")) if as_dict(anchor))
        or bool(set(strings(chunk.get("intents"))) & target_intents)
        or clean_text(chunk.get("kind")) in _ALWAYS_RELEVANT_KINDS
    )


def _score_chunk_classification(
    golden: Mapping[str, Any], selected: Sequence[Mapping[str, Any]], candidates: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    selected_keys = {_classification_key(chunk) for chunk in selected}
    all_candidates: dict[str, Mapping[str, Any]] = {}
    for chunk in [*candidates, *selected]:
        all_candidates[_classification_key(chunk)] = chunk
    counts = _empty_classification()
    for key, chunk in all_candidates.items():
        predicted, actual = key in selected_keys, _is_target_relevant(golden, chunk)
        if predicted and actual:
            counts["tp"] += 1
        elif predicted:
            counts["fp"] += 1
        elif actual:
            counts["fn"] += 1
        else:
            counts["tn"] += 1
    return _finalize_classification(counts, should_round=False)


def _classification_key(chunk: Mapping[str, Any]) -> str:
    identifier = clean_text(chunk.get("id"))
    return identifier or "\0".join(
        clean_text(chunk.get(key)) for key in ("source", "title", "headingPath", "text")
    )


def _empty_classification() -> dict[str, Any]:
    return {"tp": 0, "fp": 0, "fn": 0, "tn": 0, "precision": 0.0, "recall": 0.0, "accuracy": 0.0}


def _add_confusion(target: dict[str, Any], source: Mapping[str, Any]) -> None:
    for key in ("tp", "fp", "fn", "tn"):
        target[key] = int(target.get(key, 0)) + int(source.get(key, 0))


def _finalize_classification(counts: Mapping[str, Any], *, should_round: bool = True) -> dict[str, Any]:
    tp, fp, fn, tn = (int(counts.get(key, 0)) for key in ("tp", "fp", "fn", "tn"))
    total = tp + fp + fn + tn
    metrics = {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "precision": _divide(tp, tp + fp),
        "recall": _divide(tp, tp + fn),
        "accuracy": _divide(tp + tn, total),
    }
    if should_round:
        metrics.update({key: _round(_number(metrics[key])) for key in ("precision", "recall", "accuracy")})
    return metrics


def _classification_delta(current: Mapping[str, Any], baseline: Mapping[str, Any]) -> dict[str, float]:
    return {
        key: _round(_number(current.get(key)) - _number(baseline.get(key)))
        for key in ("precision", "recall", "accuracy")
    }


def _number(value: object) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0.0


def _mean(values: Sequence[float] | Any) -> float:
    sequence = list(values)
    return sum(sequence) / len(sequence) if sequence else 0.0


def _round(value: float) -> float:
    return math.floor(value * 1000 + 0.5) / 1000


def _divide(numerator: int, denominator: int) -> float:
    return numerator / denominator if denominator else 0.0


def _normalize_path(value: str) -> str:
    return value.replace("\\", "/").lower()


runPdpGeoRagEval = run_pdp_geo_rag_eval
scorePdpGeoRagRetrieval = score_pdp_geo_rag_retrieval
aggregatePdpGeoRagScores = aggregate_pdp_geo_rag_scores

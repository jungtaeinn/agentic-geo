"""Explicit RAG/product routing decisions used by deterministic rendering."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .._json import as_dict, as_list, clean_text

_QUERY_INTENTS = [
    "schema and entity composition",
    "answer-ready FAQ intent",
    "source-faithful HowTo eligibility",
    "evidence-backed claim selection",
    "target customer and category-entry context",
    "positive or neutral customer review FAQ intent",
    "locale terminology and public wording",
]
_CROSS_CUTTING = {"orchestration", "field-contracts", "eeat", "cep", "geo-research"}
_ROUTES: dict[str, dict[str, Any]] = {
    "faq": {
        "primary": ["faq"],
        "supporting": ["customer", "review", "claims", "evidence", "schema", "locale", "general"],
        "targets": ["FAQPage.mainEntity"],
        "fallback": [*_CROSS_CUTTING, "schema", "best-practice", "official-docs"],
    },
    "howTo": {
        "primary": ["howTo"],
        "supporting": ["evidence", "schema", "locale", "general"],
        "targets": ["HowTo.step"],
        "fallback": [*_CROSS_CUTTING, "schema", "best-practice"],
    },
    "claims": {
        "primary": ["claims", "evidence"],
        "supporting": ["schema", "locale", "general"],
        "targets": ["Product.description", "Product.additionalProperty"],
        "fallback": [*_CROSS_CUTTING, "schema", "best-practice", "official-docs"],
    },
    "customer": {
        "primary": ["customer"],
        "supporting": ["faq", "review", "claims", "locale", "general"],
        "targets": ["WebPage.description", "Product.description"],
        "fallback": [*_CROSS_CUTTING, "best-practice", "locale"],
        "brand": True,
    },
    "review": {
        "primary": ["review"],
        "supporting": ["faq", "customer", "evidence", "schema", "locale", "general"],
        "targets": ["FAQPage.mainEntity", "Product.description"],
        "fallback": [*_CROSS_CUTTING, "schema", "best-practice"],
    },
}


def create_pdp_geo_reasoning(input_: Mapping[str, Any]) -> dict[str, Any]:
    product, chunks = as_dict(input_.get("product")), [as_dict(item) for item in as_list(input_.get("ragChunks"))]
    evidence = _product_evidence(product)
    selected = _unique([_format_source(item) for item in chunks])[:12]
    product_sources = _unique([_format_source(item) for item in chunks if not _brand_identity(item)])[:12]
    route_sources = {key: _sources_for_principle(chunks, rule) for key, rule in _ROUTES.items()}
    decision_args = [
        (
            "answer-ready FAQ",
            route_sources["faq"],
            [
                *evidence["benefits"],
                *evidence["effects"],
                *evidence["ingredients"],
                *evidence["usage"],
                *evidence["faq"],
                *evidence["reviews"],
            ][:8],
            product_sources,
            "FAQ generation should be grounded in selected schema/GEO RAG guidance plus product benefit, effect, ingredient, usage, FAQ, or review evidence. Brand identity can influence wording only, not answer evidence.",
        ),
        (
            "stepwise HowTo",
            route_sources["howTo"],
            evidence["usage"][:6],
            product_sources,
            "HowTo is enabled when a concrete goal and at least one direct source action exist. One source instruction remains exactly one step; multiple steps require explicit source order. Brand identity, customer reviews, and general RAG guidance must not create, split, merge, or reorder usage actions.",
        ),
        (
            "evidence-backed claims",
            route_sources["claims"],
            [*evidence["sourceBackedClaims"], *evidence["effects"], *evidence["reviews"]][:8],
            product_sources,
            "Claim wording should use selected trust/schema RAG guidance together with source-backed product claims, effects, or review evidence. Brand identity documents are brand-image context and cannot supply product claims.",
        ),
        (
            "target customer context",
            route_sources["customer"],
            [
                value
                for value in [product.get("category"), *evidence["benefits"], *evidence["sourceBackedClaims"]]
                if isinstance(value, str)
            ][:8],
            selected,
            "Target-customer context should be inferred from category, benefit, and source text evidence while selected RAG guidance supplies the composition rule.",
        ),
        (
            "review-intent FAQ",
            route_sources["review"],
            evidence["reviews"][:8],
            product_sources,
            "Review-intent FAQ is enabled when customer review evidence is present and selected RAG guidance supports positive or neutral review language as reusable use-feel FAQ context while excluding negative review complaints. Brand identity may set tone only.",
        ),
    ]
    decisions = [_decision(*args) for args in decision_args]
    return {
        "mode": "explicit-rag-product-reasoning",
        "queryIntents": list(_QUERY_INTENTS),
        "selectedSources": selected,
        "productEvidence": evidence,
        "decisions": decisions,
        "principles": [item["principle"] for item in decisions if item["enabled"]],
    }


def is_pdp_geo_reasoning_enabled(reasoning: Mapping[str, Any], principle: str) -> bool:
    return any(
        as_dict(item).get("principle") == principle and as_dict(item).get("enabled") is True
        for item in as_list(reasoning.get("decisions"))
    )


def _product_evidence(product: Mapping[str, Any]) -> dict[str, list[str]]:
    reviews = as_dict(product.get("reviews"))
    return {
        "benefits": _unique_strings(as_list(product.get("benefits")))[:10],
        "effects": _unique_strings(as_list(product.get("effects")))[:10],
        "ingredients": _unique_strings(as_list(product.get("ingredients")))[:10],
        "usage": _unique_strings(as_list(product.get("usage")))[:8],
        "reviews": _unique_strings(
            [*as_list(reviews.get("keywords")), *[as_dict(item).get("body") for item in as_list(reviews.get("items"))]]
        )[:10],
        "faq": _unique_strings(
            [
                f"Q: {as_dict(item).get('question', '')}\nA: {as_dict(item).get('answer', '')}"
                for item in as_list(product.get("faq"))
            ]
        )[:8],
        "sourceBackedClaims": _unique_strings(
            [product.get("description"), *as_list(product.get("metrics")), *as_list(product.get("sourceTexts"))]
        )[:12],
    }


def _sources_for_principle(chunks: Sequence[Mapping[str, Any]], rule: Mapping[str, Any]) -> list[str]:
    eligible = list(chunks) if rule.get("brand") else [chunk for chunk in chunks if not _brand_identity(chunk)]
    scored = [(chunk, _principle_score(chunk, rule)) for chunk in eligible]
    scored.sort(key=lambda row: (-row[1], -float(row[0].get("score", 0))))
    sources = _unique([_format_source(chunk) for chunk, score in scored if score > 0])
    return _ensure_cross_cutting_source_coverage(sources, eligible)[:6]


def _ensure_cross_cutting_source_coverage(sources: Sequence[str], chunks: Sequence[Mapping[str, Any]]) -> list[str]:
    """Keep the strategic GEO/E-E-A-T/CEP sources inside the six-source cap.

    Appending them and then slicing (the original Python shortcut) silently
    discarded exactly the sources the TypeScript routing contract reserves.
    """

    strategic = [
        _format_source(candidate)
        for kind in ("geo-research", "eeat", "cep")
        if (candidate := next((chunk for chunk in chunks if chunk.get("kind") == kind), None)) is not None
    ]
    merged = _unique([*sources, *strategic])
    if len(merged) <= 6:
        return merged
    required = [source for source in strategic if source not in sources[:6]]
    if not required:
        return merged
    head = list(sources[: max(0, 6 - len(required))])
    return _unique([*head, *required, *merged])[:6]


def _principle_score(chunk: Mapping[str, Any], rule: Mapping[str, Any]) -> float:
    intents = set(_chunk_list(chunk, "intents", "sectionIntents"))
    targets = set(_chunk_list(chunk, "fieldTargets", "fieldTargets"))
    has_metadata = bool(intents or targets)
    score = 5 if intents.intersection(rule["primary"]) else 0
    score += 3 if targets.intersection(rule["targets"]) else 0
    score += 1.5 if intents.intersection(rule["supporting"]) else 0
    if chunk.get("kind") in rule["fallback"] and (not has_metadata or score > 0):
        score += 0.75
    if chunk.get("kind") in _CROSS_CUTTING and "general" in intents:
        score += 1
    if (
        any(
            marker in f"{chunk.get('title', '')} {chunk.get('source', '')}".lower()
            for marker in ("reference output", "verbatim", "benchmark")
        )
    ):
        score -= 2
    return score


def _chunk_list(chunk: Mapping[str, Any], key: str, metadata_key: str) -> list[str]:
    direct = as_list(chunk.get(key))
    metadata = as_dict(chunk.get("metadata"))
    values = [str(item) for item in direct if isinstance(item, str)] or [
        item.strip() for item in str(metadata.get(metadata_key, "")).split(",") if item.strip()
    ]
    allowed = {
        "faq",
        "howTo",
        "claims",
        "customer",
        "review",
        "schema",
        "locale",
        "evidence",
        "retrieval",
        "general",
    }
    if metadata_key == "fieldTargets":
        allowed = {
            "WebPage.description",
            "Product.description",
            "Product.additionalProperty",
            "FAQPage.mainEntity",
            "HowTo.step",
            "BreadcrumbList",
            "PDP.content",
            "diagnostics",
            "retrieval",
        }
    return [item for item in values if item in allowed]


def _brand_identity(chunk: Mapping[str, Any]) -> bool:
    return (
        bool(
            __import__("re").search(
                r"(?:^|/)brand-identity(?:_|\.|-)", str(chunk.get("source", "")), __import__("re").I
            )
        )
        or as_dict(chunk.get("metadata")).get("queryPlanTarget") == "brandIdentityCoverage"
    )


def _format_source(chunk: Mapping[str, Any]) -> str:
    source, title = clean_text(chunk.get("source")), clean_text(chunk.get("title"))
    return f"{source}#{title}" if source and title else source


def _decision(
    principle: str, rag_sources: Sequence[str], evidence: Sequence[object], fallback: Sequence[str], rationale: str
) -> dict[str, Any]:
    sources = list(rag_sources or fallback)[:6]
    values = _unique_strings(evidence)[:8]
    enabled = bool(sources and values)
    return {
        "principle": principle,
        "enabled": enabled,
        "confidence": min(0.95, 0.55 + min(len(sources), 3) * 0.08 + min(len(values), 5) * 0.04) if enabled else 0,
        "ragSources": sources,
        "productEvidence": values,
        "rationale": rationale,
    }


def _unique(values: Sequence[str]) -> list[str]:
    return _unique_strings(values)


def _unique_strings(values: Sequence[object]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        # ``reasoning.ts`` only trims its diagnostic evidence strings.  Do not
        # run the generic JSON cleaner here: it collapses the intentional
        # newline between FAQ `Q:` and `A:` and changes public diagnostics.
        value = raw.strip() if isinstance(raw, str) else clean_text(raw)
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


createPdpGeoReasoning = create_pdp_geo_reasoning
isPdpGeoReasoningEnabled = is_pdp_geo_reasoning_enabled

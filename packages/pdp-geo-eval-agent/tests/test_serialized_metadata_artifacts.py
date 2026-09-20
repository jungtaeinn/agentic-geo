"""Behavioral port of serialized public-artifact detection and rubric impact."""

from __future__ import annotations

import importlib

from pdp_geo_eval_agent.models import GeoQualityEvaluation

POLLUTED_DESCRIPTION = (
    "Essential Firming Cream EX is a cream. The product's documented testing includes Hypoallergenic tested, "
    "google_product_category: 2592 benefit: :firming benefit: :hydrating skin_type: :all_types "
    "MYR Essential Firming Cream EX | Best Face Firming Cream | SAMPLE_BOTANICS."
)


def _metadata():
    return importlib.import_module("pdp_geo_eval_agent.contracts.serialized_metadata")


def test_classifies_serialized_metadata_by_structure_and_keeps_prose_urls_clean() -> None:
    metadata = _metadata()

    assert metadata.contains_serialized_metadata("google_product_category: 2592") is True
    assert metadata.contains_serialized_metadata("benefit: :firming") is True
    assert metadata.contains_serialized_metadata("A | B | C") is True
    assert metadata.contains_serialized_metadata("A rich, whipped cream that delivers lasting hydration.") is False
    assert metadata.contains_serialized_metadata("See https://example.com/p#product for details.") is False
    assert metadata.find_serialized_metadata_artifact(POLLUTED_DESCRIPTION)
    assert metadata.find_serialized_metadata_artifact("Clinically shown to deliver 72-hour hydration.") is None


def _quality_input(product_description: str) -> dict[str, object]:
    return {
        "jsonLd": {
            "@context": "https://schema.org",
            "@graph": [
                {
                    "@type": "WebPage",
                    "@id": "https://example.com/p#webpage",
                    "name": "Essential Firming Cream EX",
                    "description": "Product page for Essential Firming Cream EX.",
                    "dateModified": "2026-08-01",
                },
                {
                    "@type": "Product",
                    "@id": "https://example.com/p#product",
                    "name": "Essential Firming Cream EX",
                    "description": product_description,
                    "offers": {"@type": "Offer", "price": 124, "priceCurrency": "MYR"},
                },
            ],
        },
        "diagnostics": {
            "normalizedProduct": {
                "name": "Essential Firming Cream EX",
                "images": [],
                "breadcrumbs": [],
                "ingredients": ["Ceramide"],
                "benefits": ["Firming"],
                "effects": [],
            },
            "validationWarnings": [],
            "validationRepairs": [],
            "evidence": [{"field": "product.name", "source": "input", "value": "Essential Firming Cream EX"}],
            "ragUsage": [
                {
                    "principle": "evidence-backed claims",
                    "enabled": True,
                    "references": [{"kind": "eeat", "fieldTargets": ["Product.description"]}],
                },
                {
                    "principle": "target customer context",
                    "enabled": True,
                    "references": [{"kind": "cep", "fieldTargets": ["Product.additionalProperty"]}],
                },
            ],
            "evidenceLedger": [{"id": "ev-1", "role": "benefit", "text": "Firming"}],
            "contentPlan": {
                "mode": "model",
                "productDescription": {"include": True, "evidenceIds": ["ev-1"]},
                "webPageDescription": {"include": False, "evidenceIds": []},
                "faq": [],
                "howTo": {"eligible": False, "steps": []},
                "cep": [{"situation": "dry skin", "need": "firming care", "evidenceIds": ["ev-1"]}],
            },
        },
    }


def _dimension_score(evaluation: GeoQualityEvaluation, identifier: str) -> int:
    return next(dimension.score for dimension in evaluation.dimensions if dimension.id == identifier)


def test_penalizes_every_dimension_when_public_copy_carries_serialized_metadata() -> None:
    evaluate = importlib.import_module("pdp_geo_eval_agent.quality.evaluate")
    clean = evaluate.evaluate_geo_quality(
        _quality_input("Essential Firming Cream EX is a firming cream for all skin types with ceramide-based barrier care."),
        "en",
    )
    polluted = evaluate.evaluate_geo_quality(_quality_input(POLLUTED_DESCRIPTION), "en")

    for identifier in ("geo", "cep", "eeat"):
        assert _dimension_score(polluted, identifier) < _dimension_score(clean, identifier)

    geo_improvements = "\n".join(
        item for dimension in polluted.dimensions if dimension.id == "geo" for item in dimension.improvements
    )
    assert any(token in geo_improvements.lower() for token in ("google_product_category", "serialized", "메타데이터"))


def test_does_not_flag_a_clean_run() -> None:
    evaluate = importlib.import_module("pdp_geo_eval_agent.quality.evaluate")
    clean = evaluate.evaluate_geo_quality(
        _quality_input("Essential Firming Cream EX is a firming cream for all skin types with ceramide-based barrier care."),
        "en",
    )
    improvements = "\n".join(item for dimension in clean.dimensions for item in dimension.improvements)
    assert "serialized" not in improvements.lower()
    assert "메타데이터" not in improvements

"""Public source-grounded role and qualifier contracts for product normalization."""

from __future__ import annotations

import asyncio
from typing import Any

from pdp_geo_generator_agent.product_normalizer import normalize_pdp_product_with_agent

FORMULA = "The airless pump protects the ceramide formula."
INSTRUCTION = "Dispense two pumps, smooth over face and neck, then press to absorb."
IMAGE_URL = "https://images.example.test/clinical.png"
METRIC_SOURCE = "Hydration measured 1.3x after 2 weeks by instrumental assessment. Individual results may vary."
LINK_SOURCE = "The ceramide formula supports hydration."
METRIC = {
    "value": "1.3",
    "unit": "x",
    "metric": "hydration",
    "timing": "after 2 weeks",
    "method": "Instrumental assessment",
    "caveat": "Individual results may vary.",
    "imageUrls": [IMAGE_URL],
}
LINK = {
    "ingredient": "ceramide formula",
    "benefit": "hydration",
    "sourceText": LINK_SOURCE,
    "imageUrls": [IMAGE_URL],
}


class _SourceGroundedNormalizer:
    def normalize_product(self, _request: dict[str, object]) -> dict[str, object]:
        return {
            "product": {
                "usage": [FORMULA, INSTRUCTION],
                "ingredients": ["ceramide formula", INSTRUCTION],
                "semanticFacts": {
                    "ingredients": ["ceramide formula", INSTRUCTION],
                    "benefits": [],
                    "effects": [],
                    "skinTypes": [],
                    "usageSteps": [FORMULA, INSTRUCTION],
                    "safetyTests": [],
                    "metricClaims": [METRIC],
                    "evidenceSentences": [FORMULA, INSTRUCTION, METRIC_SOURCE, LINK_SOURCE],
                    "ingredientBenefitLinks": [LINK],
                    "citations": [],
                },
            }
        }


class _EmptyNormalizer:
    def normalize_product(self, _request: dict[str, object]) -> dict[str, object]:
        return {"product": {}}


def _source_product(usage: list[str]) -> dict[str, Any]:
    return {
        "name": "Evidence Serum",
        "usage": usage,
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "metrics": [],
        "sourceTexts": [FORMULA, INSTRUCTION, METRIC_SOURCE, LINK_SOURCE],
        "semanticFacts": {
            "ingredients": ["ceramide formula"],
            "benefits": [],
            "effects": [],
            "skinTypes": [],
            "usageSteps": usage,
            "safetyTests": [],
            "metricClaims": [METRIC],
            "evidenceSentences": [FORMULA, INSTRUCTION, METRIC_SOURCE, LINK_SOURCE],
            "ingredientBenefitLinks": [LINK],
            "citations": [],
        },
    }


def _raw_product(usage: list[str]) -> dict[str, Any]:
    return {
        "sourceExtraction": {
            "ocr": {
                "imageTexts": [{"imageUrl": IMAGE_URL, "text": "\n".join([*usage, METRIC_SOURCE, LINK_SOURCE])}],
                "semanticFacts": {
                    "usageSteps": usage,
                    "metricClaims": [METRIC],
                    "ingredientBenefitLinks": [LINK],
                },
            }
        }
    }


def test_normalizer_keeps_formula_and_instruction_in_distinct_roles() -> None:
    product = _source_product([FORMULA, INSTRUCTION])

    result = asyncio.run(
        normalize_pdp_product_with_agent(
            {"rawProduct": _raw_product([FORMULA, INSTRUCTION]), "bootstrapProduct": product, "locale": "en-US", "market": "US"},
            {"customProductNormalizer": _SourceGroundedNormalizer()},
        )
    )

    normalized = result["product"]
    assert FORMULA not in normalized["usage"]
    assert INSTRUCTION not in normalized["ingredients"]
    assert normalized["usage"] == [INSTRUCTION]
    assert normalized["semanticFacts"]["usageSteps"] == [INSTRUCTION]


def test_normalizer_preserves_structured_metric_qualifier_and_image_lineage() -> None:
    product = _source_product([FORMULA, INSTRUCTION])

    result = asyncio.run(
        normalize_pdp_product_with_agent(
            {"rawProduct": _raw_product([FORMULA, INSTRUCTION]), "bootstrapProduct": product, "locale": "en-US", "market": "US"},
            {"customProductNormalizer": _SourceGroundedNormalizer()},
        )
    )

    facts = result["product"]["semanticFacts"]
    claim = facts["metricClaims"][0]
    assert claim["caveat"] == "Individual results may vary."
    assert claim["method"] == "Instrumental assessment"
    assert claim["imageUrls"] == [IMAGE_URL]
    assert facts["ingredientBenefitLinks"][0]["imageUrls"] == [IMAGE_URL]


def test_normalizer_keeps_korean_ordered_procedure_boundaries() -> None:
    steps = [
        "1. 세안 후 적당량을 덜어 얼굴과 목에 펴 바릅니다.",
        "2. 가볍게 눌러 흡수시킵니다.",
    ]
    product = _source_product(steps)
    product["name"] = "에비던스 세럼"
    product["sourceTexts"] = steps
    product["semanticFacts"]["usageSteps"] = steps

    result = asyncio.run(
        normalize_pdp_product_with_agent(
            {"rawProduct": {"sourceTexts": steps}, "bootstrapProduct": product, "locale": "ko-KR", "market": "KR"},
            {"customProductNormalizer": _EmptyNormalizer()},
        )
    )

    assert result["product"]["usage"] == steps

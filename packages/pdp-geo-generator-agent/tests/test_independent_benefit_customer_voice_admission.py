"""Admission contracts for independently sourced product-benefit FAQ prose."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, cast

import pytest

import pdp_geo_generator_agent.content_planning as content_planning
from pdp_geo_generator_agent.content_planning import create_conservative_content_plan

_admit_model_plan = cast(
    Callable[[Mapping[str, Any], Mapping[str, Any]], tuple[dict[str, Any] | None, list[str]]],
    getattr(content_planning, "_admit_model_plan"),
)


def _case(locale: str) -> tuple[dict[str, Any], dict[str, Any], str, str, tuple[str, str, str]]:
    if locale == "ko-KR":
        product: dict[str, Any] = {
            "name": "글로우 세럼",
            "brand": "노스스타 랩",
            "category": "세럼",
            "description": "글로우 세럼은 세럼입니다.",
            "ingredients": ["비타민 C 유도체"],
            "benefits": ["광채"],
            "effects": [],
            "usage": [],
            "metrics": [],
            "options": [],
            "faq": [],
            "reviews": {"items": [], "keywords": []},
            "sourceTexts": [],
            "semanticFacts": {},
        }
        ingredient_source = "글로우 세럼에는 비타민 C 유도체가 함유되어 있습니다."
        question = "광채 관리를 목표로 할 때 어떤 세럼을 선택하면 좋을까요?"
        answer = "노스스타 랩 글로우 세럼에는 비타민 C 유도체가 함유되어 있습니다. 이 세럼은 광채 관리에 도움을 줍니다."
        rejected = (
            "노스스타 랩 글로우 세럼은 비타민 C 유도체를 통해 광채를 개선합니다.",
            "광채 관리를 위해 노스스타 랩 글로우 세럼을 추천합니다. 이 세럼은 광채 관리에 도움을 줍니다.",
            "노스스타 랩 글로우 세럼에는 비타민 C 유도체가 함유되어 있습니다. 이 세럼은 수분 관리에 도움을 줍니다.",
        )
    else:
        product = {
            "name": "Glow Serum",
            "brand": "Northstar Lab",
            "category": "serum",
            "description": "Glow Serum is a serum.",
            "ingredients": ["Vitamin C Derivative"],
            "benefits": ["radiance"],
            "effects": [],
            "usage": [],
            "metrics": [],
            "options": [],
            "faq": [],
            "reviews": {"items": [], "keywords": []},
            "sourceTexts": [],
            "semanticFacts": {},
        }
        ingredient_source = "Vitamin C Derivative"
        question = "What serum should I look for when radiance is a skincare goal?"
        answer = "Northstar Lab's Glow Serum contains Vitamin C Derivative. The serum supports radiance."
        rejected = (
            "Northstar Lab's Glow Serum improves radiance through Vitamin C Derivative.",
            "For radiance, consider Northstar Lab's Glow Serum. The serum supports radiance.",
            "Northstar Lab's Glow Serum contains Vitamin C Derivative. The serum supports hydration.",
        )

    ledger: list[dict[str, Any]] = [
        {"id": "brand", "role": "identity", "text": product["brand"], "sourcePath": "product.brand", "confidence": 1},
        {"id": "product", "role": "identity", "text": product["name"], "sourcePath": "product.name", "confidence": 1},
        {
            "id": "ingredient",
            "role": "ingredient",
            "text": ingredient_source,
            "sourcePath": "product.ingredients[0]",
            "confidence": 1,
        },
        {"id": "benefit", "role": "benefit", "text": product["benefits"][0], "sourcePath": "product.benefits[0]", "confidence": 1},
    ]
    card: dict[str, Any] = {
        "id": "faq-independent-benefit",
        "intent": "formula-and-benefit",
        "productName": product["name"],
        "brand": product["brand"],
        "canRecommend": False,
        "evidenceIds": ["brand", "product", "ingredient", "benefit"],
        "claims": [
            {"role": "identity", "relationship": "explicit", "text": product["brand"], "evidenceIds": ["brand"]},
            {"role": "identity", "relationship": "explicit", "text": product["name"], "evidenceIds": ["product"]},
            {
                "role": "ingredient",
                "relationship": "independent",
                "text": ingredient_source,
                "evidenceIds": ["ingredient"],
            },
            {
                "role": "benefit",
                "relationship": "independent",
                "text": product["benefits"][0],
                "evidenceIds": ["benefit"],
            },
        ],
    }
    request: dict[str, Any] = {
        "product": product,
        "locale": locale,
        "evidenceLedger": ledger,
        "faqRelationshipCards": [card],
    }
    return request, card, question, answer, rejected


def _candidate(request: Mapping[str, Any], card: Mapping[str, Any], question: str, answer: str) -> dict[str, Any]:
    plan = {
        key: value
        for key, value in create_conservative_content_plan(request).items()
        if key not in {"mode", "faqRelationshipCards"}
    }
    plan["faq"] = [
        {
            "id": card["id"],
            "include": True,
            "question": question,
            "answer": answer,
            "intent": card["intent"],
            "cep": "",
            "evidenceIds": card["evidenceIds"],
            "confidence": 0.95,
            "omitReason": "",
        }
    ]
    return plan


@pytest.mark.parametrize("locale", ["en-US", "ko-KR"])
def test_admission_keeps_a_natural_independent_product_benefit_sentence(locale: str) -> None:
    """A bare independent benefit atom can use a neutral product carrier."""

    request, card, question, answer, _ = _case(locale)

    admitted, warnings = _admit_model_plan(_candidate(request, card, question, answer), request)

    assert admitted is not None, warnings
    assert [row["id"] for row in admitted["faq"]] == [card["id"]]


@pytest.mark.parametrize("locale", ["en-US", "ko-KR"])
@pytest.mark.parametrize("rejection_index", [0, 1, 2], ids=("causal", "recommendation", "unsupported-benefit"))
def test_admission_rejects_independent_benefit_customer_voice_that_changes_the_relation(
    locale: str, rejection_index: int
) -> None:
    """A neutral carrier cannot become causal, recommendable, or unsupported."""

    request, card, question, _answer, rejected = _case(locale)

    admitted, warnings = _admit_model_plan(
        _candidate(request, card, question, rejected[rejection_index]), request
    )

    assert admitted is not None, warnings
    assert admitted["faq"] == []
    assert any("FAQ[0]" in warning for warning in warnings)

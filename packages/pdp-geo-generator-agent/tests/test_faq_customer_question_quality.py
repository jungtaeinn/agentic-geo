"""Regression contracts for evidence-first customer-decision FAQ rows."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, cast

import pytest

import pdp_geo_generator_agent.content_planning as content_planning
from pdp_geo_generator_agent.content_planning import (
    create_conservative_content_plan,
    create_pdp_geo_evidence_ledger,
)
from pdp_geo_generator_agent.faq_relationships import build_faq_relationship_cards

_admit_model_plan = cast(
    Callable[[Mapping[str, Any], Mapping[str, Any]], tuple[dict[str, Any] | None, list[str]]],
    getattr(content_planning, "_admit_model_plan"),
)


def _english_product() -> dict[str, Any]:
    concern = "Works best for skin with dryness and tightness."
    formula = "Ceramide Complex supports hydration."
    return {
        "name": "Dew Barrier Cream",
        "brand": "Northstar Lab",
        "category": "cream",
        "description": "Dew Barrier Cream is a cream.",
        "ingredients": ["Ceramide Complex"],
        "benefits": ["hydration"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [concern, formula],
        "semanticFacts": {
            "evidenceSentences": [concern],
            "ingredientBenefitLinks": [
                {"ingredient": "Ceramide Complex", "benefit": "hydration", "sourceText": formula}
            ],
        },
    }


def _korean_product() -> dict[str, Any]:
    concern = "탄력 저하와 건조함이 고민인 피부를 위한 제품입니다."
    formula = "세라마이드 매트릭스는 수분량 개선에 도움을 줍니다."
    return {
        "name": "듀 배리어 세럼",
        "brand": "노스스타 랩",
        "category": "세럼",
        "description": "듀 배리어 세럼은 세럼입니다.",
        "ingredients": ["세라마이드 매트릭스"],
        "benefits": ["수분량 개선"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [concern, formula],
        "semanticFacts": {
            "evidenceSentences": [concern],
            "ingredientBenefitLinks": [
                {"ingredient": "세라마이드 매트릭스", "benefit": "수분량 개선", "sourceText": formula}
            ],
        },
    }


def test_relationship_cards_drop_stitched_page_dumps_but_keep_compact_formula_and_benefit_facts() -> None:
    """A noisy OCR source cannot crowd out the concise facts a model needs for a buyer answer."""

    raw_page_dump = (
        "CAPSULE TONER HYPERSENSITIVE SKIN TESTED SENSITIVE SKIN PANEL TESTED "
        "DERMATOLOGIST TESTED ALLERGY TESTED NON-COMEDOGENIC TESTED ORIGINAL EXCELLENT "
        "CAPSULE TONER HYPERSENSITIVE SKIN TESTED SENSITIVE SKIN PANEL TESTED"
    )
    product = {
        "name": "Dew Barrier Cream",
        "brand": "Northstar Lab",
        "category": "cream",
        "description": "Dew Barrier Cream is a cream.",
        "ingredients": ["Ceramide Complex", raw_page_dump],
        "benefits": ["hydration", raw_page_dump],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [
            "Works best for skin with dryness and tightness.",
            "Ceramide Complex is part of the formula.",
            "Hydration is a stated benefit.",
        ],
        "semanticFacts": {"evidenceSentences": ["Works best for skin with dryness and tightness."]},
    }
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    cards = build_faq_relationship_cards(product, ledger, "en-US")
    public_claims = [claim["text"] for card in cards for claim in card["claims"] if claim["role"] != "identity"]

    assert raw_page_dump not in public_claims
    assert "Ceramide Complex" in public_claims
    assert "hydration" in public_claims


def test_buyer_card_does_not_turn_a_measured_result_into_the_customer_concern() -> None:
    """A metric can remain available on its own card without steering the buyer question."""

    product = _korean_product()
    concern = product["sourceTexts"][0]
    product["sourceTexts"] = [
        concern,
        "사용 7일 후 피부결 7.9% 개선",
        "사용 7일 후 피부 투명도 6.0% 개선",
    ]
    product["semanticFacts"] = {
        "evidenceSentences": [concern],
        "metricClaims": [
            {
                "sourceText": "사용 7일 후 피부결 7.9% 개선 및 투명도 6.0% 개선",
                "metric": "피부결",
                "value": "7.9",
                "unit": "%",
                "timing": "사용 7일 후",
            }
        ],
    }

    ledger = create_pdp_geo_evidence_ledger(product, "ko-KR")
    buyer = next(
        card for card in build_faq_relationship_cards(product, ledger, "ko-KR") if card["intent"] == "buyer-decision"
    )

    assert all("7.9%" not in claim["text"] for claim in buyer["claims"] if claim["role"] in {"audience", "concern"})


def _buyer_request(product: Mapping[str, Any], locale: str) -> tuple[dict[str, Any], dict[str, Any]]:
    ledger = create_pdp_geo_evidence_ledger(product, locale)
    buyer = next(
        card for card in build_faq_relationship_cards(product, ledger, locale) if card["intent"] == "buyer-decision"
    )
    return {
        "product": dict(product),
        "locale": locale,
        "evidenceLedger": ledger,
        "faqRelationshipCards": [buyer],
    }, buyer


def _candidate(request: Mapping[str, Any], row: Mapping[str, Any]) -> dict[str, Any]:
    candidate = {
        key: value
        for key, value in create_conservative_content_plan(request).items()
        if key not in {"mode", "faqRelationshipCards"}
    }
    candidate["faq"] = [dict(row)]
    return candidate


def _row(card: Mapping[str, Any], question: str, answer: str, cep: str) -> dict[str, Any]:
    return {
        "id": card["id"],
        "include": True,
        "question": question,
        "answer": answer,
        "intent": card["intent"],
        "cep": cep,
        "evidenceIds": card["evidenceIds"],
        "confidence": 0.95,
        "omitReason": "",
    }


@pytest.mark.parametrize(
    ("locale", "product_factory", "question", "bare_answer", "reasoned_answer", "cep"),
    [
        (
            "en-US",
            _english_product,
            "Which cream may fit a routine focused on dryness and tightness?",
            "For skin with dryness and tightness, consider Northstar Lab's Dew Barrier Cream.",
            (
                "For skin with dryness and tightness, consider Northstar Lab's Dew Barrier Cream. "
                "Ceramide Complex supports hydration."
            ),
            "",
        ),
        (
            "ko-KR",
            _korean_product,
            "탄력 저하와 건조함이 고민인 피부를 위한 보습 루틴에는 어떤 세럼이 좋을까요?",
            "탄력 저하와 건조함을 함께 관리하고 싶다면 노스스타 랩 듀 배리어 세럼을 추천합니다.",
            (
                "탄력 저하와 건조함을 함께 관리하고 싶다면 노스스타 랩 듀 배리어 세럼을 추천합니다. "
                "세라마이드 매트릭스는 수분량 개선에 도움을 줍니다."
            ),
            "",
        ),
    ],
)
def test_buyer_recommendation_requires_a_source_grounded_formula_or_effect_reason(
    locale: str,
    product_factory: Callable[[], dict[str, Any]],
    question: str,
    bare_answer: str,
    reasoned_answer: str,
    cep: str,
) -> None:
    """A fit claim alone is not a customer-ready explanation in either locale."""

    request, buyer = _buyer_request(product_factory(), locale)
    bare = _row(buyer, question, bare_answer, cep)
    reasoned = _row(buyer, question, reasoned_answer, cep)

    rejected, rejected_warnings = _admit_model_plan(_candidate(request, bare), request)
    admitted, admitted_warnings = _admit_model_plan(_candidate(request, reasoned), request)

    assert rejected is not None, rejected_warnings
    assert rejected["faq"] == []
    assert admitted is not None, admitted_warnings
    assert admitted["faq"] == [reasoned]

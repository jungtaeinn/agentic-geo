"""Customer-voice FAQ admission contracts for relationship-card plans."""

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


def _card(cards: list[dict[str, Any]], intent: str) -> dict[str, Any]:
    return next(card for card in cards if card["intent"] == intent)


def _model_row(card: Mapping[str, Any], *, question: str, answer: str, cep: str) -> dict[str, Any]:
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


def _candidate(request: Mapping[str, Any], row: Mapping[str, Any]) -> dict[str, Any]:
    candidate = {
        key: value
        for key, value in create_conservative_content_plan(request).items()
        if key not in {"mode", "faqRelationshipCards"}
    }
    candidate["faq"] = [dict(row)]
    return candidate


def _english_buyer_product() -> dict[str, Any]:
    concern = "Works best for skin with fine lines, loss of firmness, and uneven texture."
    formula = "Ginseng Peptide helps improve the look of fine lines and firmness."
    return {
        "name": "Renewal Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "Renewal Serum is a serum.",
        "ingredients": ["Ginseng Peptide"],
        "benefits": ["Improves the look of fine lines and firmness"],
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
                {
                    "ingredient": "Ginseng Peptide",
                    "benefit": "fine lines and firmness",
                    "sourceText": formula,
                }
            ],
        },
    }


def _korean_buyer_product() -> dict[str, Any]:
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
                {
                    "ingredient": "세라마이드 매트릭스",
                    "benefit": "수분량 개선",
                    "sourceText": formula,
                }
            ],
        },
    }


@pytest.mark.parametrize(
    ("locale", "product_factory", "question", "answer", "cep"),
    [
        (
            "en-US",
            _english_buyer_product,
            "Which serum may fit a routine focused on fine lines, loss of firmness, and uneven texture?",
            (
                "For fine lines, loss of firmness, and uneven texture, consider Northstar Lab's Renewal Serum. "
                "Ginseng Peptide helps improve the look of fine lines and firmness."
            ),
            "fine lines, loss of firmness, and uneven texture",
        ),
        (
            "ko-KR",
            _korean_buyer_product,
            "탄력 저하와 건조함이 고민인 피부를 위한 보습 루틴에는 어떤 세럼이 좋을까요?",
            (
                "탄력 저하와 건조함을 함께 관리하고 싶다면 노스스타 랩 듀 배리어 세럼을 추천합니다. "
                "세라마이드 매트릭스는 수분량 개선에 도움을 줍니다."
            ),
            "탄력 저하와 건조함",
        ),
    ],
)
def test_admission_keeps_natural_customer_first_recommendation_when_fit_card_supports_it(
    locale: str,
    product_factory: Callable[[], dict[str, Any]],
    question: str,
    answer: str,
    cep: str,
) -> None:
    """Natural first-sentence recommendations retain their cited customer target."""

    product = product_factory()
    ledger = create_pdp_geo_evidence_ledger(product, locale)
    buyer = _card(build_faq_relationship_cards(product, ledger, locale), "buyer-decision")
    assert buyer["canRecommend"] is True
    request = {
        "product": product,
        "locale": locale,
        "evidenceLedger": ledger,
        "faqRelationshipCards": [buyer],
    }
    row = _model_row(buyer, question=question, answer=answer, cep=cep)

    admitted, warnings = _admit_model_plan(_candidate(request, row), request)

    assert admitted is not None, warnings
    assert admitted["faq"] == [row]


def test_admission_rejects_customer_first_recommendation_with_an_unsupported_target() -> None:
    """A recommendable card cannot turn an unrelated target into a fit claim."""

    product = _english_buyer_product()
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    buyer = _card(build_faq_relationship_cards(product, ledger, "en-US"), "buyer-decision")
    request = {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": ledger,
        "faqRelationshipCards": [buyer],
    }
    row = _model_row(
        buyer,
        question="Which serum may fit a routine focused on fine lines, loss of firmness, and uneven texture?",
        answer=(
            "For redness-prone skin, consider Northstar Lab's Renewal Serum. "
            "Ginseng Peptide helps improve the look of fine lines and firmness."
        ),
        cep="fine lines, loss of firmness, and uneven texture",
    )

    admitted, warnings = _admit_model_plan(_candidate(request, row), request)

    assert admitted is not None, warnings
    assert admitted["faq"] == []
    assert any("FAQ[0]" in warning for warning in warnings)


def test_admission_rejects_a_customer_first_recommendation_that_escalates_to_suitability() -> None:
    """Card permission to recommend does not manufacture a suitability conclusion."""

    product = _english_buyer_product()
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    buyer = _card(build_faq_relationship_cards(product, ledger, "en-US"), "buyer-decision")
    request = {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": ledger,
        "faqRelationshipCards": [buyer],
    }
    row = _model_row(
        buyer,
        question="Which serum may fit a routine focused on fine lines, loss of firmness, and uneven texture?",
        answer=(
            "For fine lines, loss of firmness, and uneven texture, Northstar Lab's Renewal Serum is a suitable choice. "
            "Ginseng Peptide helps improve the look of fine lines and firmness."
        ),
        cep="fine lines, loss of firmness, and uneven texture",
    )

    admitted, warnings = _admit_model_plan(_candidate(request, row), request)

    assert admitted is not None, warnings
    assert admitted["faq"] == []
    assert any("FAQ[0]" in warning for warning in warnings)


def test_admission_rejects_customer_first_recommendation_for_a_non_recommendable_card() -> None:
    """Formula facts remain explanatory rather than permission to recommend."""

    product = _english_buyer_product()
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    formula = _card(build_faq_relationship_cards(product, ledger, "en-US"), "formula-effect")
    assert formula["canRecommend"] is False
    request = {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": ledger,
        "faqRelationshipCards": [formula],
    }
    row = _model_row(
        formula,
        question="Which serum may help a routine focused on fine lines and firmness?",
        answer=(
            "For fine lines and firmness, consider Northstar Lab's Renewal Serum. "
            "Ginseng Peptide helps improve the look of fine lines and firmness."
        ),
        cep="fine lines and firmness",
    )

    admitted, warnings = _admit_model_plan(_candidate(request, row), request)

    assert admitted is not None, warnings
    assert admitted["faq"] == []
    assert any("FAQ[0]" in warning for warning in warnings)


def _usage_request() -> tuple[dict[str, Any], dict[str, Any]]:
    usage = "Apply immediately after cleansing as the first step of your skincare ritual."
    product: dict[str, Any] = {
        "name": "First Step Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "First Step Serum is a serum.",
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [usage],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [usage],
        "semanticFacts": {"usageSteps": [usage]},
    }
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    usage_card = _card(build_faq_relationship_cards(product, ledger, "en-US"), "usage")
    request = {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": ledger,
        "faqRelationshipCards": [usage_card],
    }
    return request, usage_card


def test_admission_accepts_a_source_faithful_use_apply_usage_carrier() -> None:
    """A named ``use`` carrier may preserve one cited ``apply`` instruction."""

    request, usage_card = _usage_request()
    row = _model_row(
        usage_card,
        question="Which serum fits a routine that starts immediately after cleansing?",
        answer=(
            "Use Northstar Lab's First Step Serum immediately after cleansing as the first step of your skincare ritual."
        ),
        cep="immediately after cleansing",
    )

    admitted, warnings = _admit_model_plan(_candidate(request, row), request)

    assert admitted is not None, warnings
    assert admitted["faq"] == [row]


def test_admission_keeps_the_same_usage_timing_and_routine_role_when_the_named_carrier_orders_them_naturally() -> None:
    """A brand/product carrier may reorder two unchanged source modifiers.

    The source asserts one action, one timing relation, and one routine role.
    The public sentence retains each exact relation while placing the timing
    before the role, which is natural English once the product identity is
    inserted.  This is not permission to change either relation or add a
    second action.
    """

    request, usage_card = _usage_request()
    product = request["product"]
    product["usage"] = ["Apply as the first step of your skincare ritual immediately after cleansing."]
    product["sourceTexts"] = list(product["usage"])
    product["semanticFacts"] = {"usageSteps": list(product["usage"])}
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    usage_card = _card(build_faq_relationship_cards(product, ledger, "en-US"), "usage")
    request = {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": ledger,
        "faqRelationshipCards": [usage_card],
    }
    row = _model_row(
        usage_card,
        question="Which serum fits a routine that starts immediately after cleansing?",
        answer=(
            "Apply Northstar Lab's First Step Serum immediately after cleansing as the first step of your skincare ritual."
        ),
        cep="immediately after cleansing",
    )

    admitted, warnings = _admit_model_plan(_candidate(request, row), request)

    assert admitted is not None, warnings
    assert admitted["faq"] == [row]


@pytest.mark.parametrize(
    "answer",
    [
        "Massage Northstar Lab's First Step Serum immediately after cleansing as the first step of your skincare ritual.",
        "Use Northstar Lab's First Step Serum twice daily immediately after cleansing as the first step of your skincare ritual.",
        "Use Northstar Lab's First Step Serum before cleansing as the first step of your skincare ritual.",
    ],
)
def test_admission_rejects_a_usage_carrier_that_changes_the_source_action_or_order(answer: str) -> None:
    """Identity scaffolding cannot add an action, frequency, or different order."""

    request, usage_card = _usage_request()
    row = _model_row(
        usage_card,
        question="Which serum fits a routine that starts immediately after cleansing?",
        answer=answer,
        cep="immediately after cleansing",
    )

    admitted, warnings = _admit_model_plan(_candidate(request, row), request)

    assert admitted is not None, warnings
    assert admitted["faq"] == []
    assert any("FAQ[0]" in warning for warning in warnings)

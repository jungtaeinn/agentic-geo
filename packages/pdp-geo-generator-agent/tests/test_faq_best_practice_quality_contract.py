"""Black-box quality contracts for model-composed, source-grounded FAQs.

The FAQ author is the model. These tests deliberately use explicit model plans
as fixtures: Python may verify relationship-card membership, evidence, and
ordering, but it must never turn raw source FAQ pairs into public prose.
"""

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
from pdp_geo_generator_agent.generation import ensure_pdp_geo_faq_plan_coverage, generate_pdp_geo_artifacts

_admit_model_plan = cast(
    Callable[[Mapping[str, Any], Mapping[str, Any]], tuple[dict[str, Any] | None, list[str]]],
    getattr(content_planning, "_admit_model_plan"),
)


def _rendered_faq(artifact: Mapping[str, Any]) -> list[dict[str, Any]]:
    graph = cast(list[dict[str, Any]], cast(Mapping[str, Any], artifact["schemaMarkup"])["jsonLd"]["@graph"])
    faq = next((node for node in graph if node.get("@type") == "FAQPage"), None)
    return cast(list[dict[str, Any]], faq.get("mainEntity", [])) if faq is not None else []


def _answer(item: Mapping[str, Any]) -> str:
    return cast(str, cast(Mapping[str, Any], item["acceptedAnswer"])["text"])


def _card(cards: list[dict[str, Any]], intent: str) -> dict[str, Any]:
    return next(card for card in cards if card["intent"] == intent)


def _model_row(
    card: Mapping[str, Any],
    *,
    question: str,
    answer: str,
    cep: str,
) -> dict[str, Any]:
    """Represent model output; the test never asks Python to write this copy."""

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


def _expected_membership_row(row: Mapping[str, Any], cards_by_id: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """Keep recommendation authority on the immutable relationship card.

    A model FAQ row may carry arbitrary extra properties.  The renderer's
    immutable membership sidecar must instead derive recommendation permission
    from the selected card with the same stable ID.
    """

    card = cards_by_id[str(row["id"])]
    return {
        "id": row["id"],
        "intent": row["intent"],
        "evidenceIds": row["evidenceIds"],
        "canRecommend": card.get("canRecommend") is True,
    }


def _finalize_model_plan(
    product: Mapping[str, Any],
    locale: str,
    cards: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    *,
    field_outcomes: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    ledger = create_pdp_geo_evidence_ledger(product, locale)
    return ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": {
                "mode": "model",
                "_admittedContentPlan": True,
                "faqRelationshipCards": cards,
                "faq": rows,
                "admissionDiagnostics": {"fields": field_outcomes or []},
            },
            "product": product,
            "locale": locale,
            "evidenceLedger": ledger,
        }
    )


def _decision_ready_product(locale: str) -> tuple[dict[str, Any], dict[str, str]]:
    """Return parallel locale-shaped evidence with an explicit formula link."""

    if locale == "en-US":
        concern = "A solution for dryness and tightness."
        audience = "Works best for dry and sensitive skin."
        formula = "Ceramide Matrix supports hydration."
        metric = "After 4 weeks, an instrumental test found hydration improved by 25%."
        return (
            {
                "name": "Dew Barrier Serum",
                "brand": "Northstar Lab",
                "category": "serum",
                "description": "Dew Barrier Serum is a serum.",
                "ingredients": ["Ceramide Matrix"],
                "benefits": ["Supports hydration"],
                "effects": [],
                "usage": [],
                "metrics": [],
                "options": [],
                "faq": [],
                "reviews": {"items": [], "keywords": []},
                "sourceTexts": [concern, audience, formula, metric],
                "semanticFacts": {
                    "skinTypes": ["dry skin", "sensitive skin"],
                    "evidenceSentences": [concern, audience],
                    "ingredientBenefitLinks": [
                        {
                            "ingredient": "Ceramide Matrix",
                            "benefit": "hydration",
                            "sourceText": formula,
                        }
                    ],
                    "metricClaims": [
                        {
                            "metric": "hydration",
                            "value": "25",
                            "unit": "%",
                            "timing": "After 4 weeks",
                            "method": "instrumental test",
                            "sourceText": metric,
                        }
                    ],
                },
            },
            {
                "brand": "Northstar Lab",
                "name": "Dew Barrier Serum",
                "ingredient": "Ceramide Matrix",
                "formulaEffect": "hydration",
                "metricMeasurement": "25%",
                "metricTiming": "After four weeks",
                "metricMethod": "instrumental test",
            },
        )

    concern = "듀 배리어 세럼은 건조함과 당김이 느껴지는 피부를 위한 제품입니다."
    formula = "세라마이드 매트릭스가 수분량 개선에 도움을 줍니다."
    metric = "4주 후 기기 평가에서 수분량이 25% 개선되었습니다."
    return (
        {
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
            "sourceTexts": [concern, formula, metric],
            "semanticFacts": {
                "evidenceSentences": [concern],
                "ingredientBenefitLinks": [
                    {
                        "ingredient": "세라마이드 매트릭스",
                        "benefit": "수분량 개선",
                        "sourceText": formula,
                    }
                ],
                "metricClaims": [
                    {
                        "metric": "수분량",
                        "value": "25",
                        "unit": "%",
                        "timing": "4주 후",
                        "method": "기기 평가",
                        "sourceText": metric,
                    }
                ],
            },
        },
        {
            "brand": "노스스타 랩",
            "name": "듀 배리어 세럼",
            "ingredient": "세라마이드 매트릭스",
            "formulaEffect": "수분량 개선",
            "metricMeasurement": "25%",
            "metricTiming": "4주 후",
            "metricMethod": "기기 평가",
        },
    )


def _model_quality_rows(locale: str, cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buyer = _card(cards, "buyer-decision")
    formula = _card(cards, "formula-effect")
    metric = _card(cards, "evidence-result")
    if locale == "en-US":
        return [
            _model_row(
                buyer,
                question="For dry and sensitive skin concerned about dryness and tightness, which serum may be worth considering?",
                answer=(
                    "For dry and sensitive skin, Northstar Lab's Dew Barrier Serum is worth considering. "
                    "Its Ceramide Matrix supports hydration."
                ),
                cep="dryness and tightness",
            ),
            _model_row(
                formula,
                question="For dry and sensitive skin seeking hydration, which serum can customers consider as part of their routine?",
                answer="Northstar Lab's Dew Barrier Serum contains Ceramide Matrix, which supports hydration.",
                cep="hydration",
            ),
            _model_row(
                metric,
                question="For customers prioritizing hydration in a dry and sensitive skin routine, which serum can they consider?",
                answer=(
                    "In an instrumental test after four weeks, Northstar Lab's Dew Barrier Serum "
                    "improved hydration by 25%."
                ),
                cep="hydration",
            ),
        ]
    return [
        _model_row(
            buyer,
            question="건조함과 당김이 고민인 피부의 보습 루틴에는 어떤 세럼을 고려할 수 있나요?",
            answer=(
                "건조함과 당김이 고민인 피부의 보습 관리가 목표라면 노스스타 랩 듀 배리어 세럼을 고려할 수 있습니다. "
                "세라마이드 매트릭스는 수분량 개선에 도움을 줍니다."
            ),
            cep="건조함과 당김",
        ),
        _model_row(
            formula,
            question="건조하고 민감한 피부의 보습 관리를 위해 어떤 세럼을 루틴에 더할 수 있나요?",
            answer="노스스타 랩 듀 배리어 세럼의 세라마이드 매트릭스는 수분량 개선에 도움을 줍니다.",
            cep="수분량 개선",
        ),
        _model_row(
            metric,
            question="건조하고 민감한 피부가 보습을 우선할 때 어떤 세럼을 살펴볼 수 있나요?",
            answer="노스스타 랩 듀 배리어 세럼은 4주 후 기기 평가에서 수분량이 25% 개선되었습니다.",
            cep="수분량 개선",
        ),
    ]


def test_direct_renderer_does_not_republish_raw_source_faq_without_a_finalized_model_plan() -> None:
    """Source Q&A can inform a card but cannot bypass AI FAQ composition."""

    product: dict[str, Any] = {
        "name": "Dew Barrier Serum",
        "brand": "Northstar Lab",
        "description": "Dew Barrier Serum is a serum for dry skin.",
        "ingredients": ["Ceramide Matrix"],
        "benefits": ["Supports hydration"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [
            {
                "question": "Which ingredients are listed for Dew Barrier Serum?",
                "answer": "Dew Barrier Serum lists Ceramide Matrix.",
            }
        ],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [],
        "semanticFacts": {},
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})

    assert _rendered_faq(artifact) == []
    assert artifact["content"]["sections"]["faq"] == ""


@pytest.mark.parametrize("locale", ["en-US", "ko-KR"])
def test_model_composed_faqs_render_verbatim_with_relationship_card_membership(locale: str) -> None:
    """Model prose may be rich, but each row remains bound to one source relation."""

    product, evidence = _decision_ready_product(locale)
    ledger = create_pdp_geo_evidence_ledger(product, locale)
    cards = build_faq_relationship_cards(product, ledger, locale)
    rows = _model_quality_rows(locale, cards)
    cards_by_id = {str(card["id"]): card for card in cards}
    # A model-owned row must not be able to elevate or remove the immutable
    # card's recommendation permission.
    for row in rows:
        row["canRecommend"] = cards_by_id[str(row["id"])].get("canRecommend") is not True
    plan = _finalize_model_plan(product, locale, cards, rows)
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": locale, "contentPlan": plan})
    rendered = _rendered_faq(artifact)

    assert [(item["name"], _answer(item)) for item in rendered] == [
        (row["question"], row["answer"]) for row in rows
    ]
    assert artifact["faqMembership"] == [_expected_membership_row(row, cards_by_id) for row in rows]
    assert all(evidence["brand"] in f"{row['question']} {row['answer']}" for row in rows)
    assert all(evidence["name"] in f"{row['question']} {row['answer']}" for row in rows)

    buyer_answer = rows[0]["answer"]
    formula_answer = rows[1]["answer"]
    metric_answer = rows[2]["answer"]
    assert evidence["ingredient"] in buyer_answer
    assert evidence["formulaEffect"] in buyer_answer
    assert evidence["ingredient"] in formula_answer
    assert evidence["formulaEffect"] in formula_answer
    assert evidence["metricTiming"].casefold() in metric_answer.casefold()
    assert evidence["metricMethod"] in metric_answer
    assert evidence["metricMeasurement"] in metric_answer
    assert all("which ingredients are listed" not in row["question"].casefold() for row in rows)


def test_model_admission_accepts_a_customer_decision_answer_bound_to_a_relationship_card() -> None:
    """The model owns fluent buyer language while admission verifies the relationship."""

    product, _ = _decision_ready_product("en-US")
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    cards = build_faq_relationship_cards(product, ledger, "en-US")
    buyer = _card(cards, "buyer-decision")
    request = {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": ledger,
        "faqRelationshipCards": [buyer],
    }
    candidate = {
        key: value
        for key, value in create_conservative_content_plan(request).items()
        if key not in {"mode", "faqRelationshipCards"}
    }
    candidate["faq"] = [
        _model_row(
            buyer,
            question="For dry and sensitive skin seeking hydration, which serum may be worth considering?",
            answer=(
                "For dry and sensitive skin, Northstar Lab's Dew Barrier Serum is worth considering. "
                "Its Ceramide Matrix supports hydration."
            ),
            cep="dryness and tightness",
        )
    ]

    admitted, warnings = _admit_model_plan(candidate, request)

    assert admitted is not None, warnings
    assert admitted["faq"] == candidate["faq"]
    assert admitted["admissionDiagnostics"]["fields"][-1] == {
        "field": "FAQ[0]",
        "outcome": "accepted",
        "rowId": buyer["id"],
    }


def test_model_admission_accepts_a_customer_situation_question_without_product_name() -> None:
    """A CEP-shaped question may name the entity in its answer instead."""

    product, _ = _decision_ready_product("en-US")
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    cards = build_faq_relationship_cards(product, ledger, "en-US")
    buyer = _card(cards, "buyer-decision")
    request = {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": ledger,
        "faqRelationshipCards": [buyer],
    }
    candidate = {
        key: value
        for key, value in create_conservative_content_plan(request).items()
        if key not in {"mode", "faqRelationshipCards"}
    }
    row = _model_row(
        buyer,
        question="For dry and sensitive skin seeking hydration, which serum may be worth considering?",
        answer=(
            "For dry and sensitive skin, Northstar Lab's Dew Barrier Serum is worth considering. "
            "Its Ceramide Matrix supports hydration."
        ),
        cep="dryness and tightness",
    )
    candidate["faq"] = [row]

    admitted, warnings = _admit_model_plan(candidate, request)

    assert admitted is not None, warnings
    assert admitted["faq"] == [row]


@pytest.mark.parametrize(
    "question",
    [
        "What evidence supports considering Northstar Lab's Dew Barrier Serum for dry and sensitive skin?",
        "How should customers use Northstar Lab's Dew Barrier Serum for dry and sensitive skin?",
        "How does Northstar Lab's Dew Barrier Serum describe dry and sensitive skin?",
        "For dry and sensitive skin seeking hydration, which serum contains Ceramide Matrix?",
    ],
)
def test_model_admission_rejects_analyst_or_howto_questions_even_with_card_evidence(question: str) -> None:
    """Evidence and use instructions belong in answers, not FAQ question subjects."""

    product, _ = _decision_ready_product("en-US")
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    cards = build_faq_relationship_cards(product, ledger, "en-US")
    buyer = _card(cards, "buyer-decision")
    request = {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": ledger,
        "faqRelationshipCards": [buyer],
    }
    candidate = {
        key: value
        for key, value in create_conservative_content_plan(request).items()
        if key not in {"mode", "faqRelationshipCards"}
    }
    candidate["faq"] = [
        _model_row(
            buyer,
            question=question,
            answer=(
                "For dry and sensitive skin, Northstar Lab's Dew Barrier Serum is worth considering. "
                "Its Ceramide Matrix supports hydration."
            ),
            cep="dryness and tightness",
        )
    ]

    admitted, warnings = _admit_model_plan(candidate, request)

    assert admitted is not None, warnings
    assert admitted["faq"] == []
    assert any("FAQ[0]" in warning and "customer decision" in warning for warning in warnings)


def test_model_admission_rejects_source_narration_in_an_otherwise_customer_answer() -> None:
    """A natural question cannot turn the answer into page or report narration."""

    product, _ = _decision_ready_product("en-US")
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    cards = build_faq_relationship_cards(product, ledger, "en-US")
    buyer = _card(cards, "buyer-decision")
    request = {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": ledger,
        "faqRelationshipCards": [buyer],
    }
    candidate = {
        key: value
        for key, value in create_conservative_content_plan(request).items()
        if key not in {"mode", "faqRelationshipCards"}
    }
    candidate["faq"] = [
        _model_row(
            buyer,
            question="For dry and sensitive skin seeking hydration, which serum may be worth considering?",
            answer=(
                "For dry and sensitive skin, Northstar Lab's Dew Barrier Serum is worth considering. "
                "The product page states that Ceramide Matrix supports hydration."
            ),
            cep="dryness and tightness",
        )
    ]

    admitted, warnings = _admit_model_plan(candidate, request)

    assert admitted is not None, warnings
    assert admitted["faq"] == []
    assert any("FAQ[0]" in warning for warning in warnings)


def test_model_admission_rejects_a_recommendation_without_an_explicit_fit_card() -> None:
    """Formula evidence can explain a choice but cannot manufacture a recommendation."""

    product, _ = _decision_ready_product("en-US")
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    cards = build_faq_relationship_cards(product, ledger, "en-US")
    formula = _card(cards, "formula-effect")
    assert formula["canRecommend"] is False
    request = {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": ledger,
        "faqRelationshipCards": [formula],
    }
    candidate = {
        key: value
        for key, value in create_conservative_content_plan(request).items()
        if key not in {"mode", "faqRelationshipCards"}
    }
    candidate["faq"] = [
        _model_row(
            formula,
            question="For a hydration-focused routine, which serum can customers consider?",
            answer=(
                "For a hydration-focused routine, Northstar Lab's Dew Barrier Serum is worth considering. "
                "Its Ceramide Matrix supports hydration."
            ),
            cep="hydration",
        )
    ]

    admitted, warnings = _admit_model_plan(candidate, request)

    assert admitted is not None, warnings
    assert admitted["faq"] == []
    assert any("FAQ[0]" in warning for warning in warnings)


def test_model_admission_rejects_raw_source_inventory_question_even_when_it_has_card_evidence() -> None:
    """Source provenance never makes an inventory heading customer-facing copy."""

    product, _ = _decision_ready_product("en-US")
    raw_question = "Which ingredients are listed for Dew Barrier Serum?"
    raw_answer = "Dew Barrier Serum lists Ceramide Matrix."
    product["faq"] = [{"question": raw_question, "answer": raw_answer}]
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    cards = build_faq_relationship_cards(product, ledger, "en-US")
    buyer = _card(cards, "buyer-decision")
    request = {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": ledger,
        "faqRelationshipCards": [buyer],
    }
    candidate = {
        key: value
        for key, value in create_conservative_content_plan(request).items()
        if key not in {"mode", "faqRelationshipCards"}
    }
    candidate["faq"] = [
        _model_row(buyer, question=raw_question, answer=raw_answer, cep="dryness and tightness")
    ]

    admitted, warnings = _admit_model_plan(candidate, request)

    assert admitted is not None, warnings
    assert admitted["faq"] == []
    assert any("FAQ[0]" in warning and "customer decision" in warning for warning in warnings)


def test_coverage_rejects_a_field_rejected_card_row_without_dropping_a_valid_sibling() -> None:
    """A bad row is diagnostic-only; an admitted sibling remains renderable."""

    product, _ = _decision_ready_product("en-US")
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    cards = build_faq_relationship_cards(product, ledger, "en-US")
    buyer = _card(cards, "buyer-decision")
    formula = _card(cards, "formula-effect")
    valid = _model_row(
        buyer,
        question="What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?",
        answer=(
            "Northstar Lab's Dew Barrier Serum is designed for dry and sensitive skin. "
            "Its Ceramide Matrix supports hydration."
        ),
        cep="dryness and tightness",
    )
    # The selected buyer card, rather than this forged model value, controls
    # the membership flag that later provenance validation consumes.
    valid["canRecommend"] = False
    rejected = _model_row(
        formula,
        question="How does the Ceramide Matrix in Northstar Lab's Dew Barrier Serum support hydration for customers?",
        answer="Northstar Lab's Dew Barrier Serum contains Ceramide Matrix, which supports hydration.",
        cep="hydration",
    )
    plan = _finalize_model_plan(
        product,
        "en-US",
        cards,
        [valid, rejected],
        field_outcomes=[
            {"field": "FAQ[0]", "rowId": valid["id"], "outcome": "accepted"},
            {"field": "FAQ[1]", "rowId": rejected["id"], "outcome": "rejected"},
        ],
    )

    assert plan["faq"] == [valid]
    assert plan["faqMembership"] == [
        _expected_membership_row(valid, {str(buyer["id"]): buyer})
    ]
    coverage = plan["admissionDiagnostics"]["faqCoverage"]
    assert coverage[-1] == {
        "field": "FAQ[1]",
        "rowId": rejected["id"],
        "outcome": "rejected",
        "reason": "fieldLocalAdmission",
    }


def test_coverage_requires_a_relationship_card_id_and_returns_cards_for_ai_recovery() -> None:
    """An otherwise fluent row cannot become public copy without a model-selected card."""

    product, _ = _decision_ready_product("en-US")
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    cards = build_faq_relationship_cards(product, ledger, "en-US")
    buyer = _card(cards, "buyer-decision")
    unknown = _model_row(
        {**buyer, "id": "faq-unknown-card"},
        question="What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?",
        answer=(
            "Northstar Lab's Dew Barrier Serum is designed for dry and sensitive skin. "
            "Its Ceramide Matrix supports hydration."
        ),
        cep="dryness and tightness",
    )
    plan = _finalize_model_plan(product, "en-US", cards, [unknown])

    assert plan["faq"] == []
    assert plan["faqMembership"] == []
    assert plan["admissionDiagnostics"]["faqCoverage"] == [
        {
            "field": "FAQ[0]",
            "rowId": "faq-unknown-card",
            "outcome": "rejected",
            "reason": "unknownRelationshipCardId",
        }
    ]
    recovery = cast(Mapping[str, Any], plan["faqRecovery"])
    assert recovery["required"] is True
    assert recovery["relationshipCards"] == cards
    assert all("question" not in card and "answer" not in card for card in recovery["relationshipCards"])


def test_rejected_model_rows_return_relationship_cards_instead_of_republishing_raw_source_headings() -> None:
    """Recovery asks the model to compose another answer; Python returns no fallback FAQ text."""

    product, _ = _decision_ready_product("en-US")
    raw_rows = [
        {
            "question": "Which ingredients are listed for Dew Barrier Serum?",
            "answer": "Dew Barrier Serum lists Ceramide Matrix.",
        },
        {
            "question": "What hydration benefit is stated for Dew Barrier Serum?",
            "answer": "Dew Barrier Serum supports hydration.",
        },
    ]
    product["faq"] = raw_rows
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    cards = build_faq_relationship_cards(product, ledger, "en-US")
    buyer = _card(cards, "buyer-decision")
    rejected_rows = [
        _model_row(buyer, question=row["question"], answer=row["answer"], cep="")
        for row in raw_rows
    ]
    plan = _finalize_model_plan(
        product,
        "en-US",
        cards,
        rejected_rows,
        field_outcomes=[
            {"field": f"FAQ[{index}]", "rowId": row["id"], "outcome": "rejected"}
            for index, row in enumerate(rejected_rows)
        ],
    )
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})

    assert plan["faq"] == []
    assert _rendered_faq(artifact) == []
    recovery = cast(Mapping[str, Any], plan["faqRecovery"])
    assert recovery["relationshipCards"]
    assert all("question" not in card and "answer" not in card for card in recovery["relationshipCards"])

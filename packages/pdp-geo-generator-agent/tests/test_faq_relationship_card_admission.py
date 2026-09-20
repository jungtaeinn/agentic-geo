"""Focused safety contracts for relationship-card FAQ admission.

These fixtures intentionally use arbitrary product names and source wording.
They exercise the model-plan boundary without prescribing public FAQ prose.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, cast

import pytest

import pdp_geo_generator_agent.content_planning as content_planning
import pdp_geo_generator_agent.faq_relationships as faq_relationships
from pdp_geo_generator_agent.content_planning import (
    create_conservative_content_plan,
    create_pdp_geo_evidence_ledger,
)
from pdp_geo_generator_agent.faq_relationships import build_faq_relationship_cards

_admit_model_plan = cast(
    Callable[[Mapping[str, Any], Mapping[str, Any]], tuple[dict[str, Any] | None, list[str]]],
    getattr(content_planning, "_admit_model_plan"),
)


def _product_with_supported_formula_and_metrics() -> dict[str, Any]:
    formula = "Peptide Complex supports hydration."
    first_metric = (
        "After 4 weeks of daily use, an instrumental assessment with 30 participants "
        "showed a 24% improvement in hydration."
    )
    second_metric = (
        "After 8 weeks of daily use, a home-use assessment with 60 participants "
        "showed a 41% improvement in hydration."
    )
    return {
        "name": "Lumen Renewal Serum",
        "brand": "Morrow Lab",
        "category": "serum",
        "description": "Lumen Renewal Serum is a serum.",
        "ingredients": ["Peptide Complex"],
        "benefits": ["hydration"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["A solution for visible dryness.", formula, first_metric, second_metric],
        "semanticFacts": {
            "evidenceSentences": ["A solution for visible dryness."],
            "ingredientBenefitLinks": [
                {
                    "ingredient": "Peptide Complex",
                    "benefit": "hydration",
                    "sourceText": formula,
                }
            ],
            "metricClaims": [
                {
                    "metric": "hydration",
                    "value": "24",
                    "unit": "%",
                    "timing": "After 4 weeks of daily use",
                    "method": "instrumental assessment",
                    "sample": "30 participants",
                    "sourceText": first_metric,
                },
                {
                    "metric": "hydration",
                    "value": "41",
                    "unit": "%",
                    "timing": "After 8 weeks of daily use",
                    "method": "home-use assessment",
                    "sample": "60 participants",
                    "sourceText": second_metric,
                },
            ],
        },
    }


def _request(product: Mapping[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    cards = build_faq_relationship_cards(product, ledger, "en-US")
    return {
        "product": dict(product),
        "locale": "en-US",
        "evidenceLedger": ledger,
        "faqRelationshipCards": cards,
    }, cards


def _candidate(request: Mapping[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    conservative = create_conservative_content_plan(request)
    return {
        "locale": "en-US",
        "productDescription": conservative["productDescription"],
        "webPageDescription": conservative["webPageDescription"],
        "faq": rows,
        "howTo": conservative["howTo"],
        "cep": [],
        "warnings": [],
    }


def _card(cards: list[dict[str, Any]], intent: str) -> dict[str, Any]:
    return next(card for card in cards if card["intent"] == intent)


def _row(
    card: Mapping[str, Any],
    question: str,
    answer: str,
    *,
    evidence_ids: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": card["id"],
        "include": True,
        "question": question,
        "answer": answer,
        "intent": card["intent"],
        "cep": "",
        "evidenceIds": evidence_ids if evidence_ids is not None else cast(list[str], card["evidenceIds"]),
        "confidence": 0.95,
        "omitReason": "",
    }


def _claim_scope(card: Mapping[str, Any], role: str, value: str) -> list[str]:
    identity_ids = [
        identifier
        for raw_claim in cast(list[Mapping[str, Any]], card["claims"])
        if raw_claim["role"] == "identity"
        for identifier in cast(list[str], raw_claim["evidenceIds"])
    ]
    claim = next(
        raw_claim
        for raw_claim in cast(list[Mapping[str, Any]], card["claims"])
        if raw_claim["role"] == role and value.casefold() in str(raw_claim.get("text", "")).casefold()
    )
    return list(dict.fromkeys([*identity_ids, *cast(list[str], claim["evidenceIds"])]))


def test_admission_accepts_customer_goal_questions_bound_to_formula_and_metric_cards() -> None:
    """Questions begin with a customer goal; formula and metrics stay answer evidence."""

    request, cards = _request(_product_with_supported_formula_and_metrics())
    formula = _card(cards, "formula-effect")
    metric = _card(cards, "evidence-result")
    metric_scope = _claim_scope(metric, "metric", "24%")
    candidate = _candidate(
        request,
        [
            _row(
                formula,
                "What serum should I look for when hydration is a priority in my daily skincare routine?",
                "Morrow Lab's Lumen Renewal Serum features Peptide Complex, which supports hydration.",
            ),
            _row(
                metric,
                "What changes might I notice in hydration after using a serum daily for four weeks?",
                (
                    "After 4 weeks of daily use, an instrumental assessment with 30 participants showed a 24% "
                    "improvement in hydration for Morrow Lab's Lumen Renewal Serum."
                ),
                evidence_ids=metric_scope,
            ),
        ],
    )

    admitted, warnings = _admit_model_plan(candidate, request)

    assert admitted is not None, warnings
    assert [row["id"] for row in admitted["faq"]] == [formula["id"], metric["id"]]


def test_admission_rejects_inventory_source_meta_usage_rating_and_ambiguous_questions() -> None:
    """Helpful card questions exclude audit, analyst, source, and bare-instruction phrasing."""

    request, cards = _request(_product_with_supported_formula_and_metrics())
    formula = _card(cards, "formula-effect")
    questions = [
        "Which ingredients are listed for Lumen Renewal Serum?",
        "What does the page say about Lumen Renewal Serum?",
        "How to use?",
        "How should it be used?",
        "How should customers evaluate the Peptide Complex formula?",
        "What evidence supports using Lumen Renewal Serum for hydration?",
        "How should customers interpret the four-week instrumental result?",
        "What is the rating for Lumen Renewal Serum?",
        "Is Lumen Renewal Serum good?",
    ]
    candidate = _candidate(
        request,
        [
            _row(
                formula,
                question,
                "Morrow Lab's Lumen Renewal Serum features Peptide Complex, which supports hydration.",
            )
            for question in questions
        ],
    )

    admitted, warnings = _admit_model_plan(candidate, request)

    assert admitted is not None, warnings
    assert admitted["faq"] == []
    assert all(
        decision["outcome"] == "rejected"
        for decision in admitted["admissionDiagnostics"]["fields"]
        if decision["field"].startswith("FAQ[")
    )


def test_broken_formula_link_becomes_independent_card_and_causal_answer_is_rejected() -> None:
    """A relation attached only to a result row cannot manufacture causality."""

    metric = "After 4 weeks, 75% of participants reported hydration."
    product: dict[str, Any] = {
        "name": "Lumen Renewal Serum",
        "brand": "Morrow Lab",
        "category": "serum",
        "description": "Lumen Renewal Serum is a serum.",
        "ingredients": ["Ingredient Delta"],
        "benefits": ["smoother-looking skin"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [
            "Ingredient Delta is included in the formula.",
            "Smoother-looking skin is a stated benefit.",
            metric,
        ],
        "semanticFacts": {
            "ingredientBenefitLinks": [
                {
                    "ingredient": "Ingredient Delta",
                    "benefit": "smoother-looking skin",
                    "sourceText": metric,
                }
            ]
        },
    }
    request, cards = _request(product)

    assert not any(card["intent"] == "formula-effect" for card in cards)
    independent = _card(cards, "formula-and-benefit")
    assert {claim["role"] for claim in independent["claims"]} >= {"identity", "ingredient", "benefit"}
    assert all(
        claim["relationship"] == "independent"
        for claim in independent["claims"]
        if claim["role"] in {"ingredient", "benefit"}
    )

    natural_question = "What serum fits a skincare routine focused on smoother-looking skin?"
    independently_supported = _row(
        independent,
        natural_question,
        (
            "Morrow Lab's Lumen Renewal Serum includes Ingredient Delta. "
            "Smoother-looking skin is a stated benefit."
        ),
    )
    causal = _row(
        independent,
        natural_question,
        "Morrow Lab's Lumen Renewal Serum provides smoother-looking skin through Ingredient Delta.",
    )

    accepted, accepted_warnings = _admit_model_plan(_candidate(request, [independently_supported]), request)
    rejected, rejected_warnings = _admit_model_plan(_candidate(request, [causal]), request)

    assert accepted is not None, accepted_warnings
    assert [row["id"] for row in accepted["faq"]] == [independent["id"]]
    assert rejected is not None, rejected_warnings
    assert rejected["faq"] == []


def test_metric_card_keeps_one_study_group_and_does_not_blend_result_context() -> None:
    """A natural past-tense result remains valid only with its own study context."""

    request, cards = _request(_product_with_supported_formula_and_metrics())
    metric = _card(cards, "evidence-result")
    first_scope = _claim_scope(metric, "metric", "24%")
    question = "What changes might I notice in hydration after using a serum daily for four weeks?"
    coherent = _row(
        metric,
        question,
        (
            "After 4 weeks of daily use, an instrumental assessment with 30 participants showed a 24% "
            "improvement in hydration for Morrow Lab's Lumen Renewal Serum."
        ),
        evidence_ids=first_scope,
    )
    blended = _row(
        metric,
        question,
        (
            "After 8 weeks of daily use, an instrumental assessment with 60 participants showed a 24% "
            "improvement in hydration for Morrow Lab's Lumen Renewal Serum."
        ),
        evidence_ids=first_scope,
    )

    accepted, accepted_warnings = _admit_model_plan(_candidate(request, [coherent]), request)
    rejected, rejected_warnings = _admit_model_plan(_candidate(request, [blended]), request)

    assert accepted is not None, accepted_warnings
    assert [row["id"] for row in accepted["faq"]] == [metric["id"]]
    assert rejected is not None, rejected_warnings
    assert rejected["faq"] == []


def test_rejected_card_row_does_not_remove_an_admitted_sibling() -> None:
    """FAQ diagnostics are field-local even when two cards share one plan."""

    request, cards = _request(_product_with_supported_formula_and_metrics())
    formula = _card(cards, "formula-effect")
    metric = _card(cards, "evidence-result")
    valid = _row(
        formula,
        "What serum should I look for when hydration is a priority in my daily skincare routine?",
        "Morrow Lab's Lumen Renewal Serum features Peptide Complex, which supports hydration.",
    )
    invalid = _row(
        metric,
        "What is the rating for Morrow Lab's Lumen Renewal Serum?",
        "Morrow Lab's Lumen Renewal Serum has a rating of 24%.",
    )

    admitted, warnings = _admit_model_plan(_candidate(request, [valid, invalid]), request)

    assert admitted is not None, warnings
    assert [row["id"] for row in admitted["faq"]] == [formula["id"]]
    outcomes = {
        decision["field"]: decision["outcome"]
        for decision in admitted["admissionDiagnostics"]["fields"]
        if decision["field"].startswith("FAQ[")
    }
    assert outcomes == {"FAQ[0]": "accepted", "FAQ[1]": "rejected"}


def _product_stating_fitness_under(field: str, sentence: str) -> dict[str, Any]:
    """Same product, with its fitness statement filed under one source array."""

    formula = "Peptide Complex supports hydration."
    product: dict[str, Any] = {
        "name": "Lumen Renewal Serum",
        "brand": "Morrow Lab",
        "category": "serum",
        "description": "Lumen Renewal Serum is a serum.",
        "ingredients": ["Peptide Complex"],
        "benefits": ["hydration"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["Lumen Renewal Serum helps with visible dryness.", formula],
        "semanticFacts": {
            "evidenceSentences": [],
            "skinTypes": [],
            "ingredientBenefitLinks": [
                {"ingredient": "Peptide Complex", "benefit": "hydration", "sourceText": formula}
            ],
            "metricClaims": [],
        },
    }
    if field == "reviews":
        product["reviews"] = {"items": [{"body": sentence, "author": "A. Reader"}], "keywords": []}
    else:
        cast(list[str], product[field]).append(sentence)
    return product


def test_only_a_fitness_statement_licenses_a_recommendation() -> None:
    """무엇을 해주는지와 누구에게 맞는지는 다른 관계다. 추천을 여는 건 후자뿐이다."""
    outcome_only = _product_stating_fitness_under("sourceTexts", "Lumen Renewal Serum addresses visible dryness.")
    cards = build_faq_relationship_cards(
        outcome_only, create_pdp_geo_evidence_ledger(outcome_only, "en-US"), "en-US"
    )
    assert all(card.get("canRecommend") is not True for card in cards)

    fit_stated = _product_stating_fitness_under("sourceTexts", "Lumen Renewal Serum is suitable for dry skin.")
    fit_cards = build_faq_relationship_cards(
        fit_stated, create_pdp_geo_evidence_ledger(fit_stated, "en-US"), "en-US"
    )
    assert _card(fit_cards, "buyer-decision").get("canRecommend") is True


def test_a_test_name_that_merely_contains_a_fitness_word_licenses_nothing() -> None:
    """적합은 검사 이름 안에도 있다. 관계를 낱말로 세면 검사 완료가 추천 허가가 된다."""
    product = _product_stating_fitness_under(
        "sourceTexts", "여드름성 피부 사용 적합 테스트 및 극민감 테스트를 완료했다고 안내합니다."
    )
    product["name"] = "루멘 리뉴얼 세럼"
    product["description"] = "루멘 리뉴얼 세럼은 세럼입니다."
    cards = build_faq_relationship_cards(product, create_pdp_geo_evidence_ledger(product, "ko-KR"), "ko-KR")
    assert all(card.get("canRecommend") is not True for card in cards)


def test_a_fitness_statement_is_recovered_from_whichever_array_carried_it() -> None:
    """원장의 대상 역할은 출처 필드가 정한다. 같은 문장이 어느 배열에 담겼든 말하는 바는 같다."""
    sentence = "Lumen Renewal Serum is suitable for dry skin."
    for field in ("usage", "sourceTexts"):
        product = _product_stating_fitness_under(field, sentence)
        cards = build_faq_relationship_cards(product, create_pdp_geo_evidence_ledger(product, "en-US"), "en-US")
        claims = cast(list[Mapping[str, Any]], _card(cards, "buyer-decision")["claims"])
        assert any(
            claim["role"] == "audience" and sentence.casefold() in str(claim["text"]).casefold()
            for claim in claims
        ), field


def test_a_shopper_review_does_not_become_the_products_own_fitness_claim() -> None:
    """리뷰는 한 고객의 경험이다. 제품이 누구에게 맞는지에 대한 자기 주장이 될 수 없다."""
    product = _product_stating_fitness_under("reviews", "This is perfect for my dry skin.")
    cards = build_faq_relationship_cards(product, create_pdp_geo_evidence_ledger(product, "en-US"), "en-US")
    for card in cards:
        assert card.get("canRecommend") is not True
        assert all(
            "perfect for my dry skin" not in str(claim.get("text", "")).casefold()
            for claim in cast(list[Mapping[str, Any]], card["claims"])
            if claim.get("role") == "audience"
        )


def test_the_same_fact_retained_twice_spends_one_claim_slot() -> None:
    """한 문장이 여러 출처 경로에 남아도 사실은 하나다. 증거는 합치고 자리는 하나만 쓴다."""
    # PDP 추출은 한 문단을 용법 배열과 페이지 원문 양쪽에 남긴다. 그러면 같은 사실이
    # 증거 ID만 다른 두 주장으로 들어와, 자리가 정해진 카드에서 두 칸을 혼자 쓰고
    # 다른 사실 하나를 밀어낸다.
    unique_claims = cast(
        Callable[[list[dict[str, Any]]], list[dict[str, Any]]],
        getattr(faq_relationships, "_unique_claims"),
    )
    merged = unique_claims(
        [
            {"role": "audience", "relationship": "explicit", "text": "It is suitable for dry skin.", "evidenceIds": ["ev-1"]},
            {"role": "audience", "relationship": "explicit", "text": "It is suitable for dry skin.", "evidenceIds": ["ev-2"]},
            {"role": "audience", "relationship": "explicit", "text": "It is suitable for oily skin.", "evidenceIds": ["ev-3"]},
        ]
    )
    assert [claim["text"] for claim in merged] == ["It is suitable for dry skin.", "It is suitable for oily skin."]
    assert merged[0]["evidenceIds"] == ["ev-1", "ev-2"]


def test_a_korean_sentence_binds_to_the_phrase_its_source_states() -> None:
    """한국어 문장은 조사·어미 없이 쓸 수 없다. 표면형으로 대조하면 어느 문장도 결속되지 않는다."""
    matches = cast(
        Callable[[str, Mapping[str, Any], Mapping[str, Any]], bool],
        getattr(content_planning, "_admission_card_sentence_matches_claim"),
    )
    product = {"name": "SampleDerma BarrierCare365 클렌징폼", "brand": "SAMPLE_DERMA"}
    claim = {
        "role": "benefit",
        "relationship": "explicit",
        "text": "판테놀 비타민 B5 유도체로, 피부 장벽을 개선합니다.",
        "evidenceIds": ["ev-1"],
    }
    # 원문의 어구를 그대로 진술하되 주제 조사 하나가 붙은 문장.
    assert matches("판테놀은 비타민 B5 유도체로, 피부 장벽을 개선합니다.", claim, product) is True
    # 원문에 없는 사실을 더한 문장은 여전히 결속되지 않는다.
    assert matches("판테놀은 비타민 B5 유도체로, 수분량을 개선합니다.", claim, product) is False


def _korean_cleanser() -> dict[str, Any]:
    """A Korean product whose extraction recorded no category field."""
    fit = "건조 피부 또는 민감 피부에 추천하는 클렌징 폼입니다."
    return {
        "name": "SampleDerma BarrierCare365 클렌징폼 200g",
        "brand": "SAMPLE_DERMA",
        "category": None,
        "description": fit,
        "ingredients": ["판테놀"],
        "benefits": ["피부 장벽 보호"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [fit, "판테놀은 피부 장벽을 보호합니다."],
        "semanticFacts": {
            "evidenceSentences": [fit],
            "skinTypes": ["건조 피부", "민감 피부"],
            "ingredientBenefitLinks": [
                {"ingredient": "판테놀", "benefit": "피부 장벽 보호", "sourceText": "판테놀은 피부 장벽을 보호합니다."}
            ],
            "metricClaims": [],
        },
    }


def test_a_question_names_the_category_the_title_states_when_no_field_records_one() -> None:
    """추출이 범주를 남기지 않아도 제품명은 그 종류를 말한다. 아니면 어떤 질문도 통과하지 못한다."""
    decision = cast(
        Callable[[str, Mapping[str, Any], str], bool],
        getattr(content_planning, "_admission_is_customer_decision_question"),
    )
    product = _korean_cleanser()
    assert product["category"] is None
    assert decision("건조하거나 민감한 피부라면 어떤 클렌징폼을 선택하면 좋을까요?", product, "ko-KR") is True
    # 종류를 말하지 않는 질문은 그대로 걸러진다.
    assert decision("이 브랜드는 언제 설립되었나요?", product, "ko-KR") is False


def test_a_recommendation_may_be_worded_freely_but_not_aim_at_a_new_customer() -> None:
    """추천은 고객의 말로 쓰인다. 원문에 없는 낱말이 아니라 원문에 없는 대상이 문제다."""
    retains = cast(
        Callable[[str, list[Mapping[str, Any]], Mapping[str, Any], Mapping[str, Any]], bool],
        getattr(content_planning, "_admission_faq_answer_retains_buyer_anchor"),
    )
    product = _korean_cleanser()
    ledger = create_pdp_geo_evidence_ledger(product, "ko-KR")
    card = _card(build_faq_relationship_cards(product, ledger, "ko-KR"), "buyer-decision")
    cited = [record for record in ledger if record["id"] in set(cast(list[str], card["evidenceIds"]))]

    # 원문이 쓰지 않은 추천 어투(``데일리``, ``선택지``)를 달고 있어도 대상은 원문의 것이다.
    assert retains(
        "건조하거나 민감한 피부라면 SAMPLE_DERMA SampleDerma BarrierCare365 클렌징폼 200g을 데일리 클렌징 선택지로 고려할 수 있습니다.",
        cited, card, product,
    ) is True
    # 원문에 없는 대상은 어투가 아무리 자연스러워도 통과하지 못한다.
    assert retains(
        "지성 피부라면 SAMPLE_DERMA SampleDerma BarrierCare365 클렌징폼을 고려할 수 있습니다.", cited, card, product
    ) is False
    assert retains(
        "여드름 흉터가 고민이라면 SAMPLE_DERMA SampleDerma BarrierCare365 클렌징폼을 추천합니다.", cited, card, product
    ) is False


def test_two_recorded_facts_joined_by_a_connective_stay_bound() -> None:
    """모델은 한 문장에 두 사실을 접속사로 잇는다. 문장 전체를 한 주장에 가두면 그게 거부된다."""
    supported = cast(
        Callable[[str, list[Mapping[str, Any]], list[Mapping[str, Any]], Mapping[str, Any], str], bool],
        getattr(content_planning, "_admission_card_sentence_is_supported"),
    )
    product = {"name": "SampleDerma BarrierCare365 클렌징폼", "brand": "SAMPLE_DERMA"}
    claims = [
        {"role": "ingredient-effect", "relationship": "explicit", "ingredient": "판테놀",
         "benefit": "피부 장벽 개선", "text": "판테놀은 비타민 B5 유도체로, 피부 장벽을 개선합니다.",
         "evidenceIds": ["ev-1"]},
        {"role": "ingredient-effect", "relationship": "explicit", "ingredient": "베타인",
         "benefit": "피부 장벽 강화", "text": "베타인은 아미노산 유도체로, 피부 장벽을 더욱 견고하게 합니다.",
         "evidenceIds": ["ev-2"]},
    ]
    joined = "판테놀은 비타민 B5 유도체로 피부 장벽을 개선하고, 베타인은 아미노산 유도체로 피부 장벽을 더욱 견고하게 합니다."
    assert supported(joined, claims, [], product, "ko-KR") is True
    # 원문에 없는 효능을 한쪽 절에 넣으면 그 절이 어느 주장에도 들어가지 않는다.
    invented = "판테놀은 비타민 B5 유도체로 수분량을 개선하고, 베타인은 미백에 도움을 줍니다."
    assert supported(invented, claims, [], product, "ko-KR") is False


def test_one_predicate_drawing_on_two_claims_is_still_rejected() -> None:
    """절이 하나면 조각을 모아 만든 관계다. 접속을 허용해도 이건 막혀야 한다."""
    supported = cast(
        Callable[[str, list[Mapping[str, Any]], list[Mapping[str, Any]], Mapping[str, Any], str], bool],
        getattr(content_planning, "_admission_card_sentence_is_supported"),
    )
    product = {"name": "SampleDerma BarrierCare365 클렌징폼", "brand": "SAMPLE_DERMA"}
    claims = [
        {"role": "ingredient", "relationship": "independent", "text": "아미노산 유래 세정 성분",
         "evidenceIds": ["ev-1"]},
        {"role": "benefit", "relationship": "independent", "text": "일상 속 노폐물 세정",
         "evidenceIds": ["ev-2"]},
    ]
    merged = "아미노산 유래 세정 성분이 일상 속 노폐물을 세정합니다."
    assert supported(merged, claims, [], product, "ko-KR") is False


def test_framing_a_stated_fact_more_weakly_keeps_its_support() -> None:
    """완충·전언은 사실을 더하지 않는다. 그걸 새 주장으로 세면 지지되던 문장이 지지를 잃는다."""
    supported = cast(
        Callable[[str, list[Mapping[str, Any]], list[Mapping[str, Any]], Mapping[str, Any], str], bool],
        getattr(content_planning, "_admission_card_sentence_is_supported"),
    )
    product = {"name": "SampleDerma BarrierCare365 클렌징폼", "brand": "SAMPLE_DERMA"}
    claims = [
        {"role": "ingredient-effect", "relationship": "explicit", "ingredient": "판테놀",
         "benefit": "피부 장벽 개선", "text": "판테놀은 비타민 B5 유도체로, 피부 장벽을 개선합니다.",
         "evidenceIds": ["ev-1"]},
        {"role": "ingredient-effect", "relationship": "explicit", "ingredient": "베타인",
         "benefit": "피부 장벽 강화", "text": "베타인은 아미노산 유도체로, 피부 장벽을 더욱 견고하게 합니다.",
         "evidenceIds": ["ev-2"]},
    ]
    # 원문의 ``개선합니다``를 ``개선을 돕고``로 낮추고, 추출기가 쓰는 전언 틀
    # (``…성분으로 설명됩니다``)을 붙였을 뿐 새 사실은 없다.
    framed = (
        "판테놀은 비타민 B5 유도체로 피부 장벽 개선을 돕고, "
        "베타인은 아미노산 유도체로 피부 장벽을 더욱 견고하게 하는 성분으로 설명됩니다."
    )
    assert supported(framed, claims, [], product, "ko-KR") is True
    # 같은 틀을 써도 원문에 없는 효능을 넣으면 그대로 거부된다.
    invented = (
        "판테놀은 비타민 B5 유도체로 수분량 개선을 돕고, "
        "베타인은 미백을 돕는 성분으로 설명됩니다."
    )
    assert supported(invented, claims, [], product, "ko-KR") is False


def test_the_claim_frame_is_not_one_market_only() -> None:
    """틀 어휘를 한 시장만 적으면 다른 시장 문장은 틀만으로 지지를 잃는다."""
    frame = cast(frozenset[str], getattr(content_planning, "_ADMISSION_CARD_CLAIM_FRAME_TOKENS"))
    for english, korean in (("ingredient", "성분"), ("benefit", "효능"), ("stat", "설명")):
        assert english in frame, english
        assert korean in frame, korean


def test_one_word_is_counted_once_however_a_sentence_spells_it() -> None:
    """원형과 활용형이 다른 낱말로 세어지면 영어 답변은 원리적으로 지지될 수 없다."""
    tokens = cast(Callable[[str], set[str]], getattr(content_planning, "_admission_card_tokens"))

    for base, *forms in (
        ("improve", "improves", "improved", "improving"),
        ("reduce", "reduces", "reduced", "reducing"),
        ("increase", "increases", "increased", "increasing"),
        ("state", "states", "stated"),
        # 짧은 원형은 묵음 -e 를 지키고 활용형은 접미를 못 떼서, 한 낱말이
        # 세 낱말로 세어졌다. 지표 답변이 "with daily use" 를 "using" 으로
        # 적으면 그 한 낱말 때문에 행 전체가 떨어졌다.
        ("use", "uses", "used", "using"),
        ("age", "ages", "aged", "aging"),
        ("feature", "features", "featuring"),
        ("pore", "pores"),
        ("study", "studies"),
        ("개선합니다", "개선해", "개선할", "개선하는", "개선됩니다"),
        ("장벽", "장벽을", "장벽은", "장벽에서는"),
    ):
        for form in forms:
            assert tokens(form) == tokens(base), (base, form)

    # 낱말을 다시 세면 같은 낱말이다. 이 성질이 없으면 어떤 표기로 적어도
    # 면제 목록의 항목은 비교가 결코 만들지 않는 문자열이 된다.
    for word in (
        "improve",
        "improves",
        "increases",
        "stated",
        "studies",
        "firmness",
        "assessment",
        "suitable",
        "because",
        "uses",
        "개선해",
        "효과",
        "피부과",
        "있습니다",
        "판테놀과",
    ):
        for stem in tokens(word):
            assert tokens(stem) == {stem}, (word, stem)


def test_every_exempt_word_is_registered_in_the_form_the_comparison_reads() -> None:
    """면제 목록은 어간으로 비교된다. 표면형으로 적힌 항목은 결코 쓰이지 않는다."""
    tokens = cast(Callable[[str], set[str]], getattr(content_planning, "_admission_card_tokens"))

    for name in (
        "_ADMISSION_CARD_SCAFFOLD_TOKENS",
        "_ADMISSION_METRIC_REPORTING_TOKENS",
        "_ADMISSION_CARD_CLAIM_FRAME_TOKENS",
        "_ADMISSION_BUYER_ANCHOR_CARRIER_TOKENS",
    ):
        exempt = cast(frozenset[str], getattr(content_planning, name))
        assert exempt, name
        dead = sorted(word for word in exempt if tokens(word) != {word})
        assert dead == [], (name, dead)

    # 목록이 부른 낱말은 문장이 어떤 표기로 적어도 면제된다.
    scaffold = cast(frozenset[str], getattr(content_planning, "_ADMISSION_CARD_SCAFFOLD_TOKENS"))
    for word in ("this", "shows", "includes", "contains", "recommended", "있습니다", "또한"):
        assert tokens(word) <= scaffold, word
    frame = cast(frozenset[str], getattr(content_planning, "_ADMISSION_CARD_CLAIM_FRAME_TOKENS"))
    for word in ("효과", "담은", "함유된", "함유한", "this"):
        assert tokens(word) <= frame, word
    carrier = cast(frozenset[str], getattr(content_planning, "_ADMISSION_BUYER_ANCHOR_CARRIER_TOKENS"))
    for word in ("care", "choice", "people", "routine", "those", "looking", "케어"):
        assert tokens(word) <= carrier, word


def test_an_answer_that_conjugates_its_source_keeps_its_support() -> None:
    """출처가 원형이고 답변이 활용형이면 부분집합은 원리적으로 불가능했다."""
    backed = cast(
        Callable[..., bool],
        getattr(content_planning, "_admission_card_sentence_adds_no_unstated_claim"),
    )
    product = {"name": "Lumen Renewal Serum", "brand": "Morrow Lab"}
    claim = {"role": "ingredient-effect", "text": "Panthenol helps improve the skin barrier"}

    assert backed("Panthenol improves the skin barrier.", claim, product) is True
    # 출처가 말하지 않은 결과를 더하면 그대로 거부된다.
    assert backed("Panthenol improves skin firmness.", claim, product) is False
    # 한국어도 같은 규정이다. 프롬프트가 요구한 연결 어미가 기각 사유가 되지 않는다.
    korean = {"name": "SampleDerma BarrierCare365 클렌징폼", "brand": "SampleDerma"}
    korean_claim = {"role": "ingredient-effect", "text": "판테놀은 비타민 B5 유도체로, 피부 장벽을 개선합니다."}
    assert backed(
        "판테놀은 비타민 B5 유도체로 피부 장벽을 개선해 관리에 추천하는 성분입니다.", korean_claim, product=korean
    ) is True
    assert backed(
        "판테놀은 비타민 B5 유도체로 수분량을 개선해 관리에 추천하는 성분입니다.", korean_claim, product=korean
    ) is False


def test_what_a_claim_says_is_every_field_the_card_recorded_it_in() -> None:
    """지표 경로는 기록 필드를 문장에 요구하면서 그 필드를 문장에서 뺐다. 충족 불가였다."""
    supported = cast(
        Callable[..., bool],
        getattr(content_planning, "_admission_card_metric_sentence_is_supported"),
    )
    product = {"name": "Lumen Renewal Serum", "brand": "Morrow Lab"}
    # 원문 줄에는 값만 있고, 방법과 집단은 각자의 필드에 기록되어 있다.
    claim = {
        "role": "metric",
        "text": "Cleansing power reached 97.1%.",
        "metric": "cleansing power",
        "value": "97.1",
        "unit": "%",
        "method": "instrumental measurement",
        "sample": "30 adult women",
    }
    assert supported(
        "Cleansing power reached 97.1% by instrumental measurement among 30 adult women.", claim, product
    ) is True
    # 기록에 없는 결론은 필드를 다 읽어도 들어오지 못한다.
    assert supported(
        "Cleansing power reached 97.1% by instrumental measurement among 30 adult women, "
        "so it is suitable for sensitive skin.",
        claim,
        product,
    ) is False
    assert supported(
        "Cleansing power reached 99.9% by instrumental measurement among 30 adult women.", claim, product
    ) is False
    # 실측 기록: 값·기간·방법·집단·결과가 각자의 필드에 있고 원문 줄은 대문자 한 덩어리다.
    measured = {
        "role": "metric",
        "text": "AFTER 6 WEEKS OF USE, 100% SHOWED IMPROVEMENT IN FINE LINES, WRINKLES, ELASTICITY, "
        "FIRMNESS. *Instrumental result, 32 women, with daily use.",
        "metric": "improvement rate",
        "outcome": "improvement in fine lines, wrinkles, elasticity and firmness",
        "value": "100",
        "unit": "%",
        "timing": "after 6 weeks of use",
        "method": "instrumental result, with daily use",
        "sample": "32 women",
    }
    assert supported(
        "After 6 weeks of use, 100% showed improvement in fine lines, wrinkles, elasticity and "
        "firmness in an instrumental result with 32 women using it daily.",
        measured,
        {"name": "Concentrated Botanical Rejuvenating Serum", "brand": "SampleBotanics"},
    ) is True


def test_a_clause_that_lists_recorded_facts_keeps_every_item_on_its_own_record() -> None:
    """한 절에 나열된 항목은 카드가 각각 기록한 사실이다. 공유 서술은 항목마다 요구된다."""
    supported = cast(
        Callable[..., bool],
        getattr(content_planning, "_admission_card_sentence_is_supported"),
    )
    product = {"name": "SampleDerma BarrierCare365 클렌징폼", "brand": "SAMPLE_DERMA"}
    safety = [
        {"role": "identity", "text": "SampleDerma BarrierCare365 클렌징폼"},
        {"role": "safety", "relationship": "explicit", "text": "피부과 테스트 완료"},
        {"role": "safety", "relationship": "explicit", "text": "인체 안자극 테스트 완료"},
    ]
    assert supported(
        "SAMPLE_DERMA SampleDerma BarrierCare365 클렌징폼은 피부과 테스트와 인체 안자극 테스트를 완료한 제품입니다.",
        safety,
        [],
        product,
        "ko-KR",
    ) is True
    # 공유 서술이 한쪽 기록에만 있으면 나열이 사실을 옮긴 것이다.
    links = [
        {"role": "identity", "text": "SampleDerma BarrierCare365 클렌징폼"},
        {
            "role": "ingredient-effect",
            "relationship": "explicit",
            "ingredient": "판테놀",
            "benefit": "피부 장벽 개선",
            "text": "판테놀은 비타민 B5 유도체로 피부 장벽 개선을 돕습니다.",
        },
        {
            "role": "ingredient-effect",
            "relationship": "explicit",
            "ingredient": "베타인",
            "benefit": "피부 장벽을 더욱 견고하게 함",
            "text": "베타인은 아미노산 유도체로 피부 장벽을 더욱 견고하게 하는 성분으로 설명됩니다.",
        },
    ]
    assert supported(
        "SampleDerma BarrierCare365 클렌징폼에는 판테놀과 베타인이 함유되어 있습니다.", links, [], product, "ko-KR"
    ) is True
    assert supported(
        "베타인과 판테놀은 피부 장벽 개선을 돕습니다.", links, [], product, "ko-KR"
    ) is False


def test_a_concern_the_product_answers_can_carry_a_recommendation() -> None:
    """고민 진술의 주어가 제품이면 추천이 기댈 수 있다. 성분이면 아니다."""
    states = cast(
        Callable[[Mapping[str, Any], Mapping[str, Any]], bool],
        getattr(content_planning, "_admission_claim_states_a_product_concern"),
    )
    card = {
        "claims": [
            {"role": "ingredient", "relationship": "independent", "text": "판테놀", "evidenceIds": ["ev-1"]},
            {"role": "concern", "relationship": "explicit",
             "text": "건조 피부 또는 민감 피부에 추천하는 클렌징 폼입니다.", "evidenceIds": ["ev-2"]},
            {"role": "concern", "relationship": "explicit",
             "text": "판테놀 비타민 B5 유도체로, 피부 장벽을 개선합니다.", "evidenceIds": ["ev-3"]},
        ]
    }
    claims = cast(list[Mapping[str, Any]], card["claims"])
    # 제품이 무엇을 해 주는지 말한 문장 — 고민을 가진 고객이 답을 받는다.
    assert states(claims[1], card) is True
    # 한 성분이 무엇을 하는지 말한 문장 — 포뮬라 결과는 추천의 대상이 될 수 없다.
    assert states(claims[2], card) is False
    # 고민 역할이 아닌 주장은 애초에 해당하지 않는다.
    assert states(claims[0], card) is False


def test_stating_a_licensed_fit_is_not_an_escalation() -> None:
    """추천이 허용된 카드에서 적합을 말하는 건 과장이 아니다. 순위를 말하는 건 과장이다."""
    escalation = cast(Any, getattr(content_planning, "_ADMISSION_BUYER_RECOMMENDATION_ESCALATION"))
    for licensed in (
        "Lumen Renewal Serum is a suitable first-step choice for dry skin.",
        "민감성 피부에 적합합니다.",
        "works best for dry skin",
    ):
        assert escalation.search(licensed) is None, licensed
    # 원문이 견주지 않은 순위와, 원문이 내리지 않은 안전 결론은 그대로 막는다.
    for added in (
        "It is the best serum for fine lines.",
        "It is the most effective serum.",
        "This is safe for babies.",
        "이 제품은 가장 좋은 선택입니다.",
    ):
        assert escalation.search(added) is not None, added


def test_a_recommendation_may_say_why_but_not_make_an_ingredient_the_cause() -> None:
    """추천이 이유를 대는 건 자연스럽다. 막아야 할 건 성분을 원인으로 세우는 것뿐이다."""
    asserts_raw = cast(
        Callable[[str, Mapping[str, Any], Mapping[str, Any]], bool],
        getattr(content_planning, "_admission_recommendation_asserts_an_unstated_cause"),
    )
    product = {"name": "Renewal Serum", "brand": "Northstar Lab"}

    def asserts(sentence: str, card: Mapping[str, Any]) -> bool:
        return asserts_raw(sentence, card, product)
    card = {
        "claims": [
            {"role": "concern", "relationship": "explicit",
             "text": "A powerhouse serum that addresses the look of existing fine lines.", "evidenceIds": ["ev-1"]},
            {"role": "ingredient-effect", "relationship": "explicit", "ingredient": "500-Hour Aged Ginseng",
             "benefit": "Supports the skin barrier",
             "text": "500-Hour Aged Ginseng supports the skin barrier.", "evidenceIds": ["ev-2"]},
        ]
    }
    # 이유가 제품 자신의 작용이면 접속어는 문법일 뿐이다.
    assert asserts(
        "Renewal Serum is a recommended choice because it addresses the look of existing fine lines.", card
    ) is False
    # 카드가 기록한 포뮬라 관계를 그대로 말하면 그것도 추천의 이유가 된다 —
    # 원문이 이미 그 선을 그었다.
    assert asserts(
        "Renewal Serum is recommended because 500-Hour Aged Ginseng supports the skin barrier.", card
    ) is False
    # 카드가 떼어 둔 효능을 성분에 붙이면 원문에 없는 인과다.
    assert asserts(
        "Renewal Serum is recommended because 500-Hour Aged Ginseng improves hydration.", card
    ) is True
    # 접속어가 없으면 애초에 해당하지 않는다.
    assert asserts("For fine lines, Renewal Serum is a recommended choice.", card) is False


def test_naming_the_product_as_the_schema_publishes_it_is_identity() -> None:
    """공개되는 이름에는 용량이 없다. 기록된 제목을 그대로 요구하면 그 이름이 거부된다."""
    has_identity = cast(
        Callable[[str, Mapping[str, Any]], bool],
        getattr(content_planning, "_admission_answer_has_brand_and_product_identity"),
    )
    product = {"name": "SampleDerma BarrierCare365 클렌징폼 200g", "brand": "SAMPLE_DERMA"}
    assert has_identity("건조 피부라면 SAMPLE_DERMA SampleDerma BarrierCare365 클렌징폼을 추천할 수 있습니다.", product) is True
    assert has_identity("건조 피부라면 SAMPLE_DERMA SampleDerma BarrierCare365 클렌징폼 200g을 추천합니다.", product) is True
    # 브랜드가 빠지거나 다른 제품을 부르면 그대로 거부된다.
    assert has_identity("건조 피부라면 SampleDerma BarrierCare365 클렌징폼을 추천합니다.", product) is False
    assert has_identity("건조 피부라면 SAMPLE_DERMA BarrierCare365 크림을 추천합니다.", product) is False


def test_a_name_with_digits_is_not_a_measurement() -> None:
    """이름 안의 숫자는 측정값이 아니다. 낱말이 겹친다고 측정 문장이 되지도 않는다."""
    mentions = cast(
        Callable[[str, list[Mapping[str, Any]]], bool],
        getattr(content_planning, "_admission_sentence_mentions_metric"),
    )
    claims = [
        {"role": "identity", "relationship": "explicit", "text": "SampleDerma BarrierCare365 클렌징폼", "evidenceIds": ["ev-0"]},
        {"role": "ingredient-effect", "relationship": "explicit", "ingredient": "500-Hour Aged Ginseng",
         "benefit": "Supports the skin barrier",
         "text": "500-Hour Aged Ginseng supports the skin barrier.", "evidenceIds": ["ev-1"]},
        {"role": "metric", "relationship": "explicit", "metric": "skin elasticity", "value": "5.9", "unit": "%",
         "text": "+5.9% improves the look of skin elasticity.", "evidenceIds": ["ev-2"]},
    ]
    # 성분·제품 이름이 지닌 숫자는 가려진다.
    assert mentions("Its 500-Hour Aged Ginseng supports the skin barrier.", claims) is False
    assert mentions("SampleDerma BarrierCare365 클렌징폼을 추천합니다.", claims) is False
    # 기록된 결과와 낱말이 겹칠 뿐인 문장도 측정 문장이 아니다.
    assert mentions("It improves the look of skin elasticity.", claims) is False
    # 카드가 기록한 숫자는 그 주장의 사실에 속한다 — ``비타민 B5``의 ``5``.
    claims.append(
        {"role": "concern", "relationship": "explicit",
         "text": "판테놀은 비타민 B5 유도체로, 피부 장벽을 개선합니다.", "evidenceIds": ["ev-3"]}
    )
    assert mentions("판테놀은 비타민 B5 유도체로 피부 장벽 개선을 돕습니다.", claims) is False
    # 측정값을 실으면 측정 문장이다.
    assert mentions("Skin elasticity improved by 5.9%.", claims) is True
    assert mentions("판테놀은 수분량을 42% 개선합니다.", claims) is True


def test_a_buyer_decision_card_carries_the_result_the_shopper_reads() -> None:
    """목표 구성의 효능·지표 단은 구매 결정 카드가 지표를 지녀야 나온다."""
    product = _product_with_supported_formula_and_metrics()
    cards = build_faq_relationship_cards(product, create_pdp_geo_evidence_ledger(product, "en-US"), "en-US")
    buyer = _card(cards, "buyer-decision")
    assert any(claim["role"] == "metric" for claim in cast(list[Mapping[str, Any]], buyer["claims"]))


def _sample_derma_evidence_result_claims() -> list[dict[str, Any]]:
    """실사에서 얻은 evidence-result 카드. 클레임은 identity 와 metric 뿐이다."""
    return [
        {
            "role": "identity",
            "relationship": "explicit",
            "text": "SampleDerma BarrierCare365 클렌징폼",
            "evidenceIds": ["ev-identity"],
        },
        {"role": "identity", "relationship": "explicit", "text": "SAMPLE_DERMA", "evidenceIds": ["ev-brand"]},
        {
            "role": "metric",
            "relationship": "explicit",
            "text": "색조 메이크업 세정력은 97.1%, 모공 속 노폐물 세정력은 97.6%로 제시되며, "
            "만 20~39세 성인 여성 30명을 대상으로 2025년 7월 21일부터 8월 22일까지 시험한 "
            "결과이고 개인차가 있을 수 있습니다.",
            "metric": "세정력",
            "outcome": "색조 메이크업 세정",
            "value": "97.1",
            "unit": "%",
            "sample": "만 20~39세 성인 여성 30명",
            "caveat": "개인차 있음",
            "evidenceIds": ["ev-metric"],
        },
    ]


def _sample_derma_evidence_result_records() -> list[dict[str, Any]]:
    """카드가 인용한 원장 레코드. 수락은 행 범위의 증거만 읽는다."""
    claims = _sample_derma_evidence_result_claims()
    return [
        {"id": "ev-identity", "role": "identity", "text": claims[0]["text"]},
        {"id": "ev-brand", "role": "identity", "text": claims[1]["text"]},
        {"id": "ev-metric", "role": "metric", "text": claims[2]["text"]},
    ]


def test_a_card_whose_only_fact_is_a_measurement_can_be_admitted_at_all() -> None:
    """evidence-result 카드의 클레임은 identity 와 metric 뿐이다. 지표 분기가 없으면 원리적으로 통과 불가였다."""
    matches = cast(
        Callable[..., bool],
        getattr(content_planning, "_admission_card_sentence_matches_claim"),
    )
    supported = cast(
        Callable[..., bool],
        getattr(content_planning, "_admission_card_sentence_is_supported"),
    )
    product = {"name": "SampleDerma BarrierCare365 클렌징폼 200g", "brand": "SAMPLE_DERMA"}
    claims = _sample_derma_evidence_result_claims()
    metric = claims[-1]

    measured = (
        "색조 메이크업 세정력은 97.1%로, 만 20~39세 성인 여성 30명을 대상으로 한 시험에서 "
        "확인되었으며 개인차가 있을 수 있습니다."
    )
    assert matches(measured, metric, product) is True
    assert supported(measured, claims, [], product, "ko-KR") is True
    # 기록이 고르지 않은 값은 실을 수 없다. 같은 패널의 형제 결과도 마찬가지다.
    assert supported("색조 메이크업 세정력은 99.9%로 확인되었습니다.", claims, [], product, "ko-KR") is False
    assert supported(
        "모공 속 노폐물 세정력은 97.6%로 만 20~39세 성인 여성 30명을 대상으로 확인되었습니다.",
        claims,
        [],
        product,
        "ko-KR",
    ) is False
    # 기록에 없는 집단·결론은 그대로 거부된다.
    assert supported(
        "색조 메이크업 세정력은 97.1%로, 만 20~39세 성인 남성 30명을 대상으로 확인되었습니다.",
        claims,
        [],
        product,
        "ko-KR",
    ) is False
    assert supported(
        "색조 메이크업 세정력은 97.1%로 확인되어 경쟁 제품보다 뛰어납니다.", claims, [], product, "ko-KR"
    ) is False


def test_a_measurement_in_object_position_still_carries_its_record() -> None:
    """수치에 붙은 목적격 조사가 낱말이 되면 한국어 지표 문장은 원리적으로 결속 불가였다."""
    tokens = cast(Callable[[str], set[str]], getattr(content_planning, "_admission_card_tokens"))
    supported = cast(
        Callable[..., bool],
        getattr(content_planning, "_admission_card_metric_sentence_is_supported"),
    )
    # ``%``는 낱말 문자가 아니어서 ``97.1%를``이 ``를``에서 잘렸고, 어떤 기록도 조사만 적지 않는다.
    assert "를" not in tokens("색조 메이크업 세정력 97.1%를 확인했습니다.")
    assert "를" not in tokens("피부 장벽 개선 32%를 확인했습니다.")
    # 낱말로 홀로 적힌 조사는 적힌 대로 읽는다. 로케일이 지시어를 그렇게 적는다.
    assert tokens("이 제품") >= {"이"}

    product = {"name": "SampleDerma BarrierCare365 크림", "brand": "SAMPLE_DERMA"}
    claim = {
        "role": "metric",
        "relationship": "explicit",
        "text": "4주 후 피부 장벽 개선 32%, 20명이 참여한 기기 측정 결과입니다.",
        "metric": "피부 장벽 개선",
        "outcome": "피부 장벽 개선",
        "value": "32",
        "unit": "%",
        "timing": "4주 후",
        "method": "기기 측정",
        "sample": "20명 참여",
    }
    assert supported("20명이 참여한 기기 측정에서 4주 후 피부 장벽 개선 32%를 확인했습니다.", claim, product) is True
    # 기록에 없는 기간은 조사와 무관하게 거부된다.
    assert supported("20명이 참여한 기기 측정에서 8주 후 피부 장벽 개선 32%를 확인했습니다.", claim, product) is False


def test_a_result_is_reported_the_same_way_in_both_markets() -> None:
    """결과를 보고하는 서술이 한 시장에만 적히면 다른 시장 지표 문장은 그 한 낱말로 떨어진다."""
    supported = cast(
        Callable[..., bool],
        getattr(content_planning, "_admission_card_metric_sentence_is_supported"),
    )
    ko_product = {"name": "SampleDerma BarrierCare365 클렌징폼 200g", "brand": "SAMPLE_DERMA"}
    ko_claim = _sample_derma_evidence_result_claims()[-1]
    for reported in (
        "만 20~39세 성인 여성 30명을 대상으로 색조 메이크업 세정력 97.1%를 확인했습니다.",
        "만 20~39세 성인 여성 30명을 대상으로 색조 메이크업 세정력 97.1%가 확인되었으며 개인차가 있을 수 있습니다.",
        "만 20~39세 성인 여성 30명을 대상으로 색조 메이크업 세정 97.1%가 나타났습니다.",
    ):
        assert supported(reported, ko_claim, ko_product) is True, reported

    en_product = {"name": "Concentrated Botanical Renewing Serum", "brand": "SampleBotanics"}
    en_claim = {
        "role": "metric",
        "relationship": "explicit",
        "text": "AFTER 6 WEEKS OF USE, 100% SHOWED IMPROVEMENT IN FINE LINES. "
        "*Instrumental result, 32 women, with daily use.",
        "metric": "improvement rate",
        "outcome": "improvement in fine lines",
        "value": "100",
        "unit": "%",
        "timing": "after 6 weeks of use",
        "method": "instrumental result, with daily use",
        "sample": "32 women",
    }
    assert supported(
        "After 6 weeks of use, 100% of 32 women showed improvement in fine lines.", en_claim, en_product
    ) is True
    # 기록이 재지 않은 방향을 문장이 붙이면 수치가 결과로 바뀐다.
    assert supported(
        "After 6 weeks of use, 100% of 32 women reported reduced dark spots.", en_claim, en_product
    ) is False


def test_a_sentence_that_only_names_the_product_asserts_nothing() -> None:
    """주장할 내용이 없는 문장은 주장을 더할 수 없다. 프롬프트가 요구하는 도입 문장이 여기서 죽었다."""
    names_only = cast(
        Callable[..., bool],
        getattr(content_planning, "_admission_card_sentence_only_names_the_product"),
    )
    answer_supported = cast(
        Callable[..., bool],
        getattr(content_planning, "_admission_card_answer_is_supported"),
    )
    # Keep this Korean-locale fixture Korean-dominant. A mechanical public
    # rebrand had turned both identity fields into long Latin labels, which
    # exercised the locale guard instead of this test's claim-scope behavior.
    product = {"name": "샘플더마 배리어케어365 클렌징폼 200g", "brand": "샘플더마"}
    claims = _sample_derma_evidence_result_claims()
    records = _sample_derma_evidence_result_records()
    for claim in claims[:2]:
        claim["text"] = (
            str(claim["text"])
            .replace("SAMPLE_DERMA", "샘플더마")
            .replace("SampleDerma", "샘플더마")
            .replace("BarrierCare365", "배리어케어365")
        )
    for record in records[:2]:
        record["text"] = (
            str(record["text"])
            .replace("SAMPLE_DERMA", "샘플더마")
            .replace("SampleDerma", "샘플더마")
            .replace("BarrierCare365", "배리어케어365")
        )
    card = {"intent": "evidence-result", "canRecommend": False, "claims": claims}

    assert names_only("샘플더마 배리어케어365 클렌징폼입니다.", claims, product) is True
    # 이름 말고 내용을 실으면 그 내용이 기록에 있어야 한다.
    assert names_only("샘플더마 배리어케어365 클렌징폼은 아토피를 완치합니다.", claims, product) is False
    assert names_only("샘플더마 배리어케어365 클렌징폼은 경쟁 제품보다 뛰어납니다.", claims, product) is False
    # 틀과 스캐폴드는 맞춰진 클레임 옆에서만 면제다. 맞춰진 것이 없으면 그 낱말이
    # 문장이 말하는 전부이고, 그것을 이름으로 읽으면 근거 없는 주장이 발행된다.
    assert names_only("샘플더마 배리어케어365 클렌징폼은 효과가 있습니다.", claims, product) is False
    assert names_only("샘플더마 배리어케어365 클렌징폼을 추천합니다.", claims, product) is False
    assert names_only("샘플더마 배리어케어365 클렌징폼은 안전합니다.", claims, product) is False

    assert (
        answer_supported(
            "샘플더마 배리어케어365 클렌징폼입니다. 색조 메이크업 세정력은 97.1%로, "
            "만 20~39세 성인 여성 30명을 대상으로 한 시험에서 확인되었으며 개인차가 있을 수 있습니다.",
            records,
            card,
            product,
            "ko-KR",
        )
        is True
    )
    # 이름만 부른 답변은 아무 질문에도 답하지 않는다.
    assert answer_supported("샘플더마 배리어케어365 클렌징폼입니다.", records, card, product, "ko-KR") is False


def test_an_answer_publishes_the_scope_the_record_filed() -> None:
    """수치만 싣고 집단과 단서를 빼면 쇼퍼가 읽을 결과가 아니다. 다만 한 문장이 다 지닐 필요는 없다."""
    answer_supported = cast(
        Callable[..., bool],
        getattr(content_planning, "_admission_card_answer_is_supported"),
    )
    product = {"name": "SampleDerma BarrierCare365 클렌징폼 200g", "brand": "SAMPLE_DERMA"}
    claims = _sample_derma_evidence_result_claims()
    card = {"intent": "evidence-result", "canRecommend": False, "claims": claims}
    records = _sample_derma_evidence_result_records()

    # 기록된 집단과 단서가 답변 어딘가에 있으면 된다 — 문장은 나누어 적는다.
    assert answer_supported(
        "만 20~39세 성인 여성 30명을 대상으로 한 시험에서 색조 메이크업 세정력 97.1%를 확인했습니다. "
        "개인차가 있을 수 있습니다.",
        records,
        card,
        product,
        "ko-KR",
    ) is True
    # 한정 없이 수치만 실은 답변은 거부된다.
    assert answer_supported("색조 메이크업 세정력은 97.1%입니다.", records, card, product, "ko-KR") is False


def test_a_sentence_may_not_fill_a_scope_slot_the_record_left_empty() -> None:
    """기록된 한정을 문장에 요구하는 대신, 없는 집단·기간·방법을 만들지 않는지 본다."""
    supported = cast(
        Callable[..., bool],
        getattr(content_planning, "_admission_card_metric_sentence_is_supported"),
    )
    slots = cast(Callable[[str], frozenset[str]], getattr(content_planning, "_admission_metric_scope_slots"))
    product = {"name": "Lumen Renewal Serum", "brand": "Morrow Lab"}
    # 값만 기록된 결과. 집단도 기간도 방법도 기록에 없다.
    claim = {
        "role": "metric",
        "relationship": "explicit",
        "text": "Hydration rose 24%.",
        "metric": "hydration",
        "outcome": "hydration",
        "value": "24",
        "unit": "%",
    }
    assert slots("Hydration rose 24%.") == frozenset()
    assert supported("Hydration rose 24%.", claim, product) is True
    # 기록이 집단을 남겨두지 않았으면 문장이 집단을 만들 수 없다.
    assert supported("Hydration rose 24% among 30 participants.", claim, product) is False
    # 방법도 슬롯이다. 기록이 비워둔 슬롯을 답변이 채우면 페이지가 하지 않은 시험이다.
    assert "method" in slots("Hydration rose 24% in a clinical study.")
    assert supported("Hydration rose 24% in a clinical study.", claim, product) is False
    # 단서는 확신을 거두는 쪽이라 문장이 더할 수 있다. 다만 기록된 단서는 답변이 실어야 한다.
    filed = {**claim, "sample": "30 participants", "method": "instrumental assessment"}
    assert supported("Hydration rose 24% in an instrumental assessment with 30 participants.", filed, product) is True
    assert supported("Hydration rose 24%.", filed, product) is True


def _korean_buyer_decision_card() -> dict[str, Any]:
    """실사 구매 결정 카드. 고객 관계가 두 레코드에 나뉘어 적혀 있다.

    피부 타입은 고객 레코드가, 장벽 고민은 성분이 주어인 레코드가 적는다.
    후자는 추천을 허가하지 않지만, 그 낱말은 카드가 기록한 것이다.
    """
    formula = "판테놀은 비타민 B5 유도체로 피부 장벽 개선을 돕습니다."
    return {
        "id": "faq-buyer-decision-live",
        "intent": "buyer-decision",
        "productName": "SampleDerma BarrierCare365 클렌징폼",
        "brand": "SAMPLE_DERMA",
        "canRecommend": True,
        "claims": [
            {
                "role": "identity",
                "relationship": "explicit",
                "text": "SampleDerma BarrierCare365 클렌징폼",
                "evidenceIds": ["ev-identity"],
            },
            {"role": "identity", "relationship": "explicit", "text": "SAMPLE_DERMA", "evidenceIds": ["ev-brand"]},
            {
                "role": "audience",
                "relationship": "explicit",
                "text": "건조 피부 또는 민감 피부에 추천하는 클렌징 폼입니다.",
                "evidenceIds": ["ev-audience"],
            },
            {"role": "concern", "relationship": "explicit", "text": formula, "evidenceIds": ["ev-concern"]},
            {
                "role": "ingredient-effect",
                "relationship": "explicit",
                "ingredient": "판테놀",
                "benefit": "피부 장벽 개선",
                "text": formula,
                "evidenceIds": ["ev-concern"],
            },
        ],
        "evidenceIds": ["ev-identity", "ev-brand", "ev-audience", "ev-concern"],
    }


def _korean_buyer_decision_records() -> list[dict[str, Any]]:
    """카드가 인용한 원장 레코드."""
    claims = cast(list[Mapping[str, Any]], _korean_buyer_decision_card()["claims"])
    return [
        {"id": "ev-identity", "role": "identity", "text": claims[0]["text"]},
        {"id": "ev-brand", "role": "identity", "text": claims[1]["text"]},
        {"id": "ev-audience", "role": "audience", "text": claims[2]["text"]},
        {"id": "ev-concern", "role": "concern", "text": claims[3]["text"]},
    ]


def _korean_buyer_decision_product() -> dict[str, Any]:
    return {"name": "SampleDerma BarrierCare365 클렌징폼 200g", "brand": "SAMPLE_DERMA", "category": "클렌저"}


def test_an_offer_is_read_from_the_slot_the_product_stands_in_not_from_its_verb() -> None:
    """추천은 상품을 독자의 선택지로 내놓는 자리다. 술어 목록으로 읽으면 하나만 발행된다."""
    states = cast(
        Callable[[str, Mapping[str, Any]], bool],
        getattr(content_planning, "_admission_states_a_recommendation"),
    )
    product = _korean_buyer_decision_product()
    name = "SAMPLE_DERMA SampleDerma BarrierCare365 클렌징폼"
    # 실측: 어휘 목록에 있던 둘만 통과했고 같은 자리의 나머지 술어는 전부 떨어졌다.
    for predicate in ("추천합니다", "좋은 선택입니다", "잘 맞습니다", "알맞습니다", "제안드립니다", "써 보실 만합니다"):
        assert states(f"건조 피부 또는 민감 피부라면 {name}을 {predicate}.", product) is True
    # 독자를 말하지 않으면 상품을 분류한 것이지 내놓은 것이 아니다.
    assert states(f"{name}은 저자극 포밍 클렌저입니다.", product) is False
    # 술어가 다른 논항의 것이면 그 논항에 대한 서술이다.
    assert states(f"{name}은 세안 중 피부 장벽을 보호하는 저자극 포밍 클렌저입니다.", product) is False
    assert states(f"{name}은 판테놀을 담았습니다.", product) is False


def test_an_answer_may_open_on_the_product_name() -> None:
    """상황절은 앞에도 뒤에도 온다. 상품명 앞만 읽으면 문두에 둔 답변은 접두부가 비어 무조건 탈락한다."""
    opens = cast(
        Callable[[str, Mapping[str, Any], str], bool],
        getattr(content_planning, "_admission_answer_opens_in_customer_voice"),
    )
    product = _korean_buyer_decision_product()
    name = "SAMPLE_DERMA SampleDerma BarrierCare365 클렌징폼"
    assert opens(f"건조하거나 민감한 피부라면 {name}을 추천합니다.", product, "ko-KR") is True
    assert opens(f"{name}은 건조하거나 민감한 피부의 장벽 관리를 목표로 할 때 추천합니다.", product, "ko-KR") is True
    # 상품을 말했을 뿐 독자를 말하지 않은 답변은 그대로 걸러진다.
    assert opens(f"{name}은 판테놀을 담았습니다.", product, "ko-KR") is False


def test_a_recommendation_may_name_two_recorded_concerns_at_once() -> None:
    """고객은 자기 상황을 한 호흡에 말한다. 한 클레임에 다 있으라 하면 그 첫 문장이 늘 떨어진다."""
    retains = cast(
        Callable[[str, list[Mapping[str, Any]], Mapping[str, Any], Mapping[str, Any]], bool],
        getattr(content_planning, "_admission_faq_answer_retains_buyer_anchor"),
    )
    card = _korean_buyer_decision_card()
    cited = _korean_buyer_decision_records()
    product = _korean_buyer_decision_product()
    name = "SAMPLE_DERMA SampleDerma BarrierCare365 클렌징폼"
    # 피부 타입은 고객 레코드에, 장벽은 성분 레코드에 적혀 있다. 나열은 관계를 만들지 않는다.
    assert retains(f"건조하거나 민감한 피부의 장벽 관리가 목표라면 {name}을 추천합니다.", cited, card, product) is True
    # 고객 명칭은 여전히 한 레코드 안에서 확인된다.
    assert retains(f"지성 피부라면 {name}을 추천합니다.", cited, card, product) is False
    # 카드가 기록하지 않은 대상만 말하면 기록된 대상이 하나도 없다.
    assert retains(f"여드름 흉터가 고민이라면 {name}을 추천합니다.", cited, card, product) is False


def test_an_offer_carries_only_itself_and_may_stand_in_any_clause() -> None:
    """면제는 자리 번호가 아니라 '상품을 내놓는 절'의 것이다. 문장 전체를 면제하면 옆 절이 무임승차한다."""
    supported = cast(Callable[..., bool], getattr(content_planning, "_admission_card_answer_is_supported"))
    card = _korean_buyer_decision_card()
    cited = _korean_buyer_decision_records()
    product = _korean_buyer_decision_product()
    name = "SAMPLE_DERMA SampleDerma BarrierCare365 클렌징폼"
    reason = "판테놀은 비타민 B5 유도체로 피부 장벽 개선을 돕습니다."
    assert supported(f"건조하거나 민감한 피부라면 {name}을 추천합니다. {reason}", cited, card, product, "ko-KR") is True
    # 조건절이 뒤에 오는 어순도 같게 읽힌다.
    assert supported(
        f"{name}은 건조 피부 또는 민감 피부라면 추천합니다. {reason}", cited, card, product, "ko-KR"
    ) is True
    # 추천절 옆에 붙은 절은 카드가 적지 않은 사실이므로 통과하지 못한다.
    assert supported(
        f"건조하거나 민감한 피부라면 {name}을 추천하며, 임상 시험을 완료했습니다. {reason}",
        cited,
        card,
        product,
        "ko-KR",
    ) is False
    # 추천절 안의 수치도 기록에 없으면 실을 수 없다.
    assert supported(
        f"건조하거나 민감한 피부라면 {name}을 99% 추천합니다. {reason}", cited, card, product, "ko-KR"
    ) is False


def _independent_formula_and_benefit_claims() -> list[dict[str, Any]]:
    """성분과 효능을 따로 적은 카드. 둘 사이의 관계는 기록되지 않았다."""
    return [
        {"role": "ingredient", "relationship": "independent", "text": "세라마이드", "evidenceIds": ["ev-1"]},
        {"role": "benefit", "relationship": "independent", "text": "피부 장벽 개선에 도움", "evidenceIds": ["ev-2"]},
    ]


def test_two_clauses_stating_separate_atoms_are_not_a_causal_merge() -> None:
    """금지할 것은 한 서술어가 성분과 효능을 잇는 것이다. 문장 단위로 읽으면 분리 요구와 이유 요구가 서로 반대가 된다."""
    separate = cast(
        Callable[[list[str], list[Mapping[str, Any]]], bool],
        getattr(content_planning, "_admission_card_independent_claims_remain_separate"),
    )
    claims = _independent_formula_and_benefit_claims()
    # 한 문장 안의 두 절이 각각을 말하는 것은 합성이 아니다.
    assert separate(["세라마이드를 담았고, 피부 장벽 개선을 돕습니다."], claims) is True
    assert separate(["세라마이드를 담았습니다.", "피부 장벽 개선을 돕습니다."], claims) is True
    # 한 절이 둘을 함께 담으면 그 서술어가 관계를 만든다.
    assert separate(["세라마이드가 피부 장벽 개선을 돕습니다."], claims) is False


def test_an_atomic_record_is_read_by_its_form_not_by_its_word_count() -> None:
    """사실의 단일성은 낱말 개수가 아니다. 두 낱말이라고 덜 원자적인 사실이 되지는 않는다."""
    atomic = cast(Callable[[str], bool], getattr(content_planning, "_admission_records_an_atomic_fact"))
    matches = cast(
        Callable[..., bool],
        getattr(content_planning, "_admission_independent_benefit_customer_voice_matches"),
    )
    assert atomic("피부 진정") is True
    assert atomic("skin radiance") is True
    # 스스로 서술하는 레코드는 자기 술어와 조건을 지닌다. 다른 술어로 옮기면 그것들이 사라진다.
    assert atomic("세안 중 피부 장벽을 보호하는 저자극 포밍 클렌저입니다.") is False
    # 두 절을 한 술어 아래로 옮기면 두 사실을 잇는다.
    assert atomic("세라마이드를 담았고, 피부 장벽 개선을 돕습니다.") is False

    product = {"name": "포밍 클렌저", "brand": "SAMPLE_DERMA", "category": "클렌저"}
    claim = {"role": "benefit", "relationship": "independent", "text": "피부 진정", "evidenceIds": ["ev-1"]}
    assert matches("포밍 클렌저는 피부 진정에 도움을 줍니다.", claim, [claim], product, "ko-KR") is True
    english = {"name": "Lumen Serum", "brand": "Morrow Lab", "category": "serum"}
    radiance = {"role": "benefit", "relationship": "independent", "text": "skin radiance", "evidenceIds": ["ev-1"]}
    assert matches("Lumen Serum supports skin radiance.", radiance, [radiance], english, "en-US") is True


def _korean_safety_row_scope() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """실사에서 유일하게 발행된 safety 행의 인용 범위와 상품."""

    name = "SampleDerma BarrierCare365 클렌징폼 200g"

    def atom(identifier: str, role: str, text: str, source_path: str) -> dict[str, Any]:
        return {
            "id": identifier,
            "role": role,
            "text": text,
            "sourcePath": source_path,
            "locale": "ko-KR",
            "productScope": "product",
            "confidence": 1,
        }

    return [
        atom("ev-identity-1", "identity", name, "product.name"),
        atom("ev-identity-2", "identity", "SAMPLE_DERMA", "product.brand"),
        atom("ev-source-1", "source", "피부과 테스트 완료", "product.semanticFacts.safetyTests[0]"),
        atom("ev-source-2", "source", "인체 안자극 테스트 완료", "product.semanticFacts.safetyTests[1]"),
    ], {"name": name, "brand": "SAMPLE_DERMA", "category": "클렌저"}


@pytest.mark.parametrize(
    "cep",
    [
        "",
        "메이크업을 깨끗하게 지우고 싶은 경우",
        "아침저녁 매일 쓰는 세안제를 고를 때",
        "민감 피부 고객이 자극 없는 데일리 클렌저를 고르는 상황",
        "건조하고 민감한 피부를 위한 순한 클렌저를 찾는 상황",
        "세안제 선택 전 피부 테스트 이력을 확인하려는 상황",
    ],
)
def test_a_cep_label_is_read_as_the_customer_entry_point_it_records(cep: str) -> None:
    """발행되지 않는 진입 상황 라벨은 발행 등급 근거 결속을 요구받지 않는다.

    실사에서 발행된 safety 행의 cep 문자열만 바꿔 수락을 재실행하면, 빈 문자열과
    근거의 낱말을 되뇐 라벨만 통과하고 같은 행을 가리키는 자연스러운 라벨은 전부
    기각됐다. cep 은 FAQPage 의 어느 필드로도 나가지 않으므로, 근거에 결속될
    까닭이 없다.
    """

    evidence, product = _korean_safety_row_scope()
    names_an_entry_point = cast(
        Callable[[str, list[dict[str, Any]], Mapping[str, Any], str], bool],
        getattr(content_planning, "_admission_faq_cep_names_a_customer_entry_point"),
    )

    assert names_an_entry_point(cep, evidence, product, "ko-KR") is True


@pytest.mark.parametrize(
    "cep",
    [
        # 독자의 상황이 아니라 원문의 항목을 적은 라벨.
        "성분표가 적혀 있는 섹션",
        # 어떤 기록도 적지 않은 수치.
        "민감 피부 고객이 자극을 40% 줄이고 싶은 상황",
        # 근거가 적합을 말하지 않는데 적합을 판정한 라벨.
        "민감 피부에 적합한 제품을 찾는 상황",
    ],
)
def test_a_cep_label_may_not_conclude_past_its_evidence(cep: str) -> None:
    """라벨의 표현은 글쓴이의 것이지만, 기록이 말하지 않은 결론은 여전히 못 담는다."""

    evidence, product = _korean_safety_row_scope()
    names_an_entry_point = cast(
        Callable[[str, list[dict[str, Any]], Mapping[str, Any], str], bool],
        getattr(content_planning, "_admission_faq_cep_names_a_customer_entry_point"),
    )

    assert names_an_entry_point(cep, evidence, product, "ko-KR") is False


def test_the_benefactive_auxiliary_reads_like_the_light_verbs_beside_it() -> None:
    """``-어 주다``는 ``하다``·``되다``와 같은 보조용언이다. 한 주장이 표기로 갈리지 않는다.

    영어 원자는 그 자체가 서술어(``soothes skin``)라 이름만 앞에 붙이면 문장이
    되는데, 한국어 원자는 명사(``피부 진정``)라 서술어를 만들 보조용언이 필요하다.
    그중 ``되다``·``돕다``만 등록돼 있어서 같은 기록이 ``도움이 됩니다``로는
    지지되고 ``도움을 줍니다``로는 기각됐다.
    """

    supported = cast(
        Callable[..., bool],
        getattr(content_planning, "_admission_card_sentence_is_supported"),
    )
    name = "SampleDerma BarrierCare365 젠틀 포밍클렌저"
    product = {"name": name, "brand": "SAMPLE_DERMA", "category": "클렌저"}
    claims = [{"role": "benefit", "text": "피부 진정", "benefit": "피부 진정", "evidenceIds": ["ev-ben-0"]}]
    evidence = [
        {
            "id": "ev-ben-0",
            "role": "benefit",
            "text": "피부 진정",
            "sourcePath": "product.semanticFacts.benefits[0]",
            "locale": "ko-KR",
            "productScope": "product",
            "confidence": 1,
        }
    ]

    for auxiliary in ("피부 진정에 도움을 줍니다", "피부 진정에 도움이 됩니다", "피부 진정을 돕습니다"):
        assert supported(f"SAMPLE_DERMA {name}는 {auxiliary}.", claims, evidence, product, "ko-KR") is True
    # 보조용언이 빠져 나간 뒤에도 기록에 없는 낱말은 그대로 청구된다.
    assert supported(f"SAMPLE_DERMA {name}는 주름 개선에 도움을 줍니다.", claims, evidence, product, "ko-KR") is False
    assert supported(f"SAMPLE_DERMA {name}는 임상 시험을 완료했습니다.", claims, evidence, product, "ko-KR") is False


def _pairing_card_fixture(locale: str) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """A card that pairs two ingredients with an outcome each, plus one the product holds."""

    def record(identifier: str, role: str, text: str) -> dict[str, Any]:
        return {
            "id": identifier,
            "role": role,
            "text": text,
            "sourcePath": f"product.sourceTexts[{identifier}]",
            "locale": locale,
            "productScope": "product",
            "confidence": 1,
        }

    if locale == "ko-KR":
        product = {"name": "리뉴얼 클렌징폼", "brand": "노스스타 랩", "category": "클렌저"}
        first, second = "판테놀은 피부 장벽 개선을 돕습니다.", "베타인은 피부 장벽을 더욱 견고하게 합니다."
        claims = [
            {"role": "ingredient-effect", "relationship": "explicit", "ingredient": "판테놀",
             "benefit": "피부 장벽 개선", "text": first, "evidenceIds": ["first"]},
            {"role": "ingredient-effect", "relationship": "explicit", "ingredient": "베타인",
             "benefit": "피부 장벽을 더욱 견고하게 함", "text": second, "evidenceIds": ["second"]},
            {"role": "benefit", "relationship": "explicit", "text": "피부 장벽 보호",
             "benefit": "피부 장벽 보호", "evidenceIds": ["held"]},
        ]
        held = "피부 장벽 보호"
    else:
        product = {"name": "Lumen Renewal Serum", "brand": "Morrow Lab", "category": "serum"}
        first = "Ginseng Peptide helps support skin firmness and elasticity."
        second = "Niacinamide helps improve skin radiance."
        claims = [
            {"role": "ingredient-effect", "relationship": "explicit", "ingredient": "Ginseng Peptide",
             "effect": "support skin firmness and elasticity", "text": first, "evidenceIds": ["first"]},
            {"role": "ingredient-effect", "relationship": "explicit", "ingredient": "Niacinamide",
             "effect": "improve skin radiance", "text": second, "evidenceIds": ["second"]},
            {"role": "benefit", "relationship": "explicit", "text": "Helps protect the skin barrier.",
             "benefit": "protect the skin barrier", "evidenceIds": ["held"]},
        ]
        held = "Helps protect the skin barrier."
    identity = [
        {"role": "identity", "relationship": "explicit", "text": product["name"], "evidenceIds": ["product"]},
        {"role": "identity", "relationship": "explicit", "text": product["brand"], "evidenceIds": ["brand"]},
    ]
    evidence = [record("first", "benefit", first), record("second", "benefit", second), record("held", "benefit", held)]
    return product, [*identity, *claims], evidence


@pytest.mark.parametrize(
    "locale,supported,answer",
    [
        # 정본 형태: 상품이 성분을 담았다고 말한 뒤, 그 성분의 기록만 말한다.
        ("ko-KR", True, "노스스타 랩 리뉴얼 클렌징폼에 담긴 판테놀은 피부 장벽 개선을 돕습니다."),
        # 귀속 뒤바꾸기. 두 결과 모두 기록돼 있지만 이 성분의 것이 아니다.
        ("ko-KR", False, "노스스타 랩 리뉴얼 클렌징폼에 담긴 판테놀은 피부 장벽을 더욱 견고하게 합니다."),
        ("ko-KR", False, "노스스타 랩 리뉴얼 클렌징폼에 담긴 베타인은 피부 장벽 개선을 돕습니다."),
        # 성분을 사격으로 옮겨도 1:1 귀속은 그대로다.
        ("ko-KR", False, "노스스타 랩 리뉴얼 클렌징폼은 판테놀을 담아 피부 장벽을 더욱 견고하게 합니다."),
        # 상품을 주어로 둔 병렬. 결과는 상품이 기록한 것이고 성분 하나에 붙지 않는다.
        ("ko-KR", True, "노스스타 랩 리뉴얼 클렌징폼은 판테놀과 베타인을 담아 피부 장벽 보호를 돕습니다."),
        # 두 절이 각자 자기 기록에 선 결합.
        ("ko-KR", True, "노스스타 랩 리뉴얼 클렌징폼에 담긴 판테놀은 피부 장벽 개선을 돕고, 베타인은 피부 장벽을 더욱 견고하게 합니다."),
        ("en-US", True, "In Morrow Lab's Lumen Renewal Serum, Ginseng Peptide helps support skin firmness and elasticity."),
        ("en-US", True, "In Morrow Lab's Lumen Renewal Serum, Niacinamide helps improve skin radiance."),
        ("en-US", False, "In Morrow Lab's Lumen Renewal Serum, Niacinamide helps improve skin firmness and elasticity."),
        ("en-US", False, "Morrow Lab's Lumen Renewal Serum helps improve skin firmness with Niacinamide."),
        ("en-US", False, "Morrow Lab's Lumen Renewal Serum helps support skin radiance with Ginseng Peptide."),
    ],
)
def test_a_recorded_pairing_stays_with_the_ingredient_the_card_paired_it_with(
    locale: str, supported: bool, answer: str
) -> None:
    """A card that says which outcome an ingredient has is contradicted by any other one.

    Both markets write the containment the FAQ prompt asks for (``{product}에 담긴
    {ingredient}은 …``, ``In {product}, {ingredient} …``), and reading the product
    there as the sentence's subject sent an ingredient's sentence to the reader
    that measures against every record the card holds.  Moving the ingredient
    into an oblique does not move the attribution either: the outcome beside it
    is still read as that ingredient's.

    What stays admitted is the shape this card is for -- the product as the
    subject, several ingredients named, and an outcome the card records of the
    product -- and a join whose clauses each stand on a record of their own.
    """

    product, claims, evidence = _pairing_card_fixture(locale)
    is_supported = cast(
        Callable[[str, list[Mapping[str, Any]], list[Mapping[str, Any]], Mapping[str, Any], str], bool],
        getattr(content_planning, "_admission_card_sentence_is_supported"),
    )

    assert is_supported(answer, claims, evidence, product, locale) is supported


def test_a_caution_the_record_never_filed_is_a_word_of_its_own() -> None:
    """``주의``는 안전 경고다. 조사 글자로 끝난다는 이유로 비교에서 사라져선 안 된다.

    명사의 끝 음절과 철자를 공유하는 조사를 한 음절 어간에서도 떼던 환원이
    ``주의``를 ``주``로 줄였고, ``주``는 보조용언 ``-어 주다``로 등록된 면제어라
    기록에 없는 경고가 답변에서 지워진 채 통과했다.
    """

    adds_no_unstated_claim = cast(
        Callable[[str, Mapping[str, Any], Mapping[str, Any]], bool],
        getattr(content_planning, "_admission_card_sentence_adds_no_unstated_claim"),
    )
    product = {"name": "리뉴얼 클렌징폼", "brand": "노스스타 랩", "category": "클렌저"}
    claim = {"role": "safety", "relationship": "explicit", "text": "피부과 테스트 완료", "evidenceIds": ["safety"]}

    assert adds_no_unstated_claim("노스스타 랩 리뉴얼 클렌징폼은 피부과 테스트를 완료했습니다.", claim, product) is True
    assert adds_no_unstated_claim("노스스타 랩 리뉴얼 클렌징폼은 주의해서 피부과 테스트를 완료했습니다.", claim, product) is False

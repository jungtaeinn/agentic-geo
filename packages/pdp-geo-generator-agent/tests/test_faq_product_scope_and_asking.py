"""What a product-scope sentence may say, and what marks an English question.

A page records an ingredient and an outcome as facts about one product, so a
sentence may say what the product, holding these, does without claiming that
one ingredient causes one outcome.  Requiring every clause to sit inside a
single record rejected that shape -- the shape a recommendation completes in,
and the shape the source itself is written in.  What still needs a recorded
pairing is the other reading: an ingredient in the subject slot predicates the
outcome of that ingredient, and only the claim recording that pairing may say
what follows.

The asking half is the same kind of asymmetry.  Korean reads a question by the
ending that closes the asking clause, wherever that clause stands; English
demanded its interrogative at the very start of the text and forbade any
earlier ``?``.  So a question that states the reader's situation as a clause of
its own -- which the FAQ prompt requires -- was a question in one market and
not in the other.
"""

from __future__ import annotations

from typing import Any

import pytest

from pdp_geo_generator_agent.content_planning import (
    _admission_card_answer_is_supported,
    _admission_text_is_coherent,
    create_pdp_geo_evidence_ledger,
)
from pdp_geo_generator_agent.faq_relationships import build_faq_relationship_cards

_NAME = "SampleDerma BarrierCare365 클렌징폼"


def _product() -> dict[str, Any]:
    return {
        "name": f"{_NAME} 200g",
        "brand": "SAMPLE_DERMA",
        "description": "아미노산 유래 세정 성분을 담은 약산성 포뮬라입니다.",
        "ingredients": ["판테놀", "베타인"],
        "semanticFacts": {
            "ingredientBenefitLinks": [
                {
                    "ingredient": "판테놀",
                    "benefit": "피부 장벽 개선",
                    "sentence": "판테놀은 비타민 B5 유도체로 피부 장벽 개선을 돕습니다.",
                    "sourceText": "판테놀은 비타민 B5 유도체로 피부 장벽 개선을 돕습니다.",
                },
                {
                    "ingredient": "베타인",
                    "benefit": "피부 장벽 강화",
                    "sentence": "베타인은 아미노산 유도체로 피부 장벽 강화를 돕습니다.",
                    "sourceText": "베타인은 아미노산 유도체로 피부 장벽 강화를 돕습니다.",
                },
            ]
        },
    }


def _formula_card() -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    product = _product()
    ledger = create_pdp_geo_evidence_ledger(product, "ko-KR")
    cards = build_faq_relationship_cards(product, ledger, "ko-KR")
    card = next(item for item in cards if str(item.get("intent")) == "formula-effect")
    by_id = {str(item.get("id")): item for item in ledger}
    cited = [by_id[identifier] for identifier in card["evidenceIds"] if identifier in by_id]
    return card, cited, product


@pytest.mark.parametrize(
    "answer",
    [
        # The product holds both, and having the outcome is recorded of the
        # product too, so nothing is attributed to one ingredient.
        f"{_NAME}은 판테놀과 베타인을 담아 피부 장벽 개선을 돕습니다.",
        # The same scope written with the containment adnominal.
        f"{_NAME}에 담긴 판테놀은 피부 장벽 개선을 돕습니다.",
    ],
)
def test_a_sentence_about_the_product_may_hold_its_formula_and_its_outcome(answer: str) -> None:
    """상품을 주어로 둔 문장은 성분과 효능을 함께 말할 수 있다."""

    card, cited, product = _formula_card()
    assert _admission_card_answer_is_supported(answer, cited, card, product, "ko-KR") is True


@pytest.mark.parametrize(
    "answer",
    [
        # 베타인's record pairs it with a different outcome, so this states a
        # pairing the card kept apart.
        "베타인은 피부 장벽 개선을 돕습니다.",
        # An outcome no record carries stays refused however it is framed.
        f"{_NAME}은 판테놀과 베타인을 담아 피부 장벽 보호를 돕습니다.",
        # A safety conclusion the source never drew.
        f"{_NAME}은 판테놀을 담아 민감 피부에 안전합니다.",
        # A figure no record filed.
        f"{_NAME}은 판테놀을 담아 피부 장벽 개선 99%를 돕습니다.",
    ],
)
def test_product_scope_does_not_license_a_pairing_or_a_conclusion_no_record_holds(answer: str) -> None:
    """상품 범위는 기록되지 않은 짝이나 결론을 허용하지 않는다."""

    card, cited, product = _formula_card()
    assert _admission_card_answer_is_supported(answer, cited, card, product, "ko-KR") is False


@pytest.mark.parametrize(
    "question",
    [
        "I have dry, sensitive skin, so which cleansing foam should I pick?",
        "My concern is fine lines, so what serum works best?",
        "After cleansing my skin feels dry. Which cleansing foam is recommended?",
        "For fine lines and loss of firmness, which serum should I consider?",
        "Which cleansing foam is recommended for dry or sensitive skin?",
    ],
)
def test_an_english_question_asks_wherever_its_asking_clause_stands(question: str) -> None:
    """영문 질문은 묻는 절이 어디 서 있든 묻는 문장이다."""

    assert _admission_text_is_coherent(question, "question") is True


@pytest.mark.parametrize(
    "text",
    [
        "The serum is pleasant to use.",
        "This serum improves firmness?",
        "Ginseng Peptide helps support firmness.",
    ],
)
def test_a_statement_is_not_a_question_however_it_is_punctuated(text: str) -> None:
    """서술문은 물음표를 붙여도 묻는 문장이 아니다."""

    assert _admission_text_is_coherent(text, "question") is False

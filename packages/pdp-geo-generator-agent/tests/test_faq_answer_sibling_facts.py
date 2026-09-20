"""A FAQ answer may state several sibling facts of one kind, and only those.

A page files each completed test and each listed ingredient as its own atom, so
an answer that reads naturally states them together.  Requiring one source
sentence to carry the whole answer rejected that, and the row published nothing.
Coordinating a list asserts no relation the list does not already contain --
but facts of different kinds are not a list, and stating them side by side
reads as cause and effect, which is what these keep apart.
"""

from __future__ import annotations

from typing import Any

import pytest

from pdp_geo_generator_agent.final_proofreader import _faq_membership_answer_evidence

_BRAND = "SAMPLE_DERMA"


def _atom(identifier: str, role: str, text: str, source_path: str, locale: str) -> dict[str, Any]:
    return {
        "id": identifier,
        "role": role,
        "text": text,
        "sourcePath": source_path,
        "locale": locale,
        "productScope": "product",
        "confidence": 1,
    }


def _safety_scope(locale: str, name: str, *, recorded: str = "") -> list[dict[str, Any]]:
    first, second = (
        ("피부과 테스트 완료", "인체 안자극 테스트 완료")
        if locale == "ko-KR"
        else ("Dermatologist tested", "Ophthalmologist tested")
    )
    return [
        _atom("ev-brand", "identity", _BRAND, "product.brand", locale),
        _atom("ev-identity", "identity", recorded or name, "product.name", locale),
        _atom("ev-safety-0", "source", first, "product.semanticFacts.safetyTests[0]", locale),
        _atom("ev-safety-1", "source", second, "product.semanticFacts.safetyTests[1]", locale),
    ]


@pytest.mark.parametrize(
    ("locale", "name", "answer"),
    [
        (
            "ko-KR",
            "SampleDerma BarrierCare365 젠틀 포밍클렌저",
            "SAMPLE_DERMA SampleDerma BarrierCare365 젠틀 포밍클렌저는 피부과 테스트와 인체 안자극 테스트를 완료했습니다.",
        ),
        (
            "en-US",
            "Barrier Serum",
            "SAMPLE_DERMA Barrier Serum is dermatologist tested and ophthalmologist tested.",
        ),
    ],
    ids=("ko-KR", "en-US"),
)
def test_an_answer_stating_two_sibling_facts_cites_both_of_them(locale: str, name: str, answer: str) -> None:
    """두 형제 사실을 한 문장으로 서술한 답변은 그 두 근거를 모두 인용한다."""

    scope = _safety_scope(locale, name)
    bound = _faq_membership_answer_evidence(answer, scope, faq_can_recommend=False, faq_card=None)

    assert {item["id"] for item in bound} == {"ev-brand", "ev-identity", "ev-safety-0", "ev-safety-1"}


@pytest.mark.parametrize(
    ("locale", "name", "answer"),
    [
        (
            "ko-KR",
            "SampleDerma BarrierCare365 젠틀 포밍클렌저",
            "SAMPLE_DERMA SampleDerma BarrierCare365 젠틀 포밍클렌저는 피부과 테스트를 완료해 초미세먼지 98.1%를 세정합니다.",
        ),
        (
            "en-US",
            "Barrier Serum",
            "SAMPLE_DERMA Barrier Serum is dermatologist tested, so it cleanses 98.1% of fine dust.",
        ),
    ],
    ids=("ko-KR", "en-US"),
)
def test_facts_of_different_kinds_are_not_a_list_and_do_not_bind_together(
    locale: str, name: str, answer: str
) -> None:
    """서로 다른 종류의 사실을 나란히 두면 인과로 읽히므로 함께 결속되지 않는다."""

    scope = [
        *_safety_scope(locale, name),
        _atom(
            "ev-metric",
            "metric",
            "초미세먼지 98.1% 세정" if locale == "ko-KR" else "cleanses 98.1% of fine dust",
            "product.semanticFacts.metricClaims[0]",
            locale,
        ),
    ]

    assert _faq_membership_answer_evidence(answer, scope, faq_can_recommend=False, faq_card=None) == []


def test_an_answer_asserting_a_word_no_sibling_states_does_not_bind() -> None:
    """형제 사실의 합집합으로 설명되지 않는 단어가 있으면 결속되지 않는다."""

    scope = _safety_scope("ko-KR", "SampleDerma BarrierCare365 젠틀 포밍클렌저")
    answer = (
        "SAMPLE_DERMA SampleDerma BarrierCare365 젠틀 포밍클렌저는 피부과 테스트와 인체 안자극 테스트를 "
        "임상적으로 완료했습니다."
    )

    assert _faq_membership_answer_evidence(answer, scope, faq_can_recommend=False, faq_card=None) == []


@pytest.mark.parametrize(
    ("locale", "name", "recorded", "answer"),
    [
        (
            "ko-KR",
            "SampleDerma BarrierCare365 젠틀 포밍클렌저",
            "SampleDerma BarrierCare365 젠틀 포밍클렌저 200g",
            "SAMPLE_DERMA SampleDerma BarrierCare365 젠틀 포밍클렌저는 피부과 테스트와 인체 안자극 테스트를 완료했습니다.",
        ),
        (
            "en-US",
            "Barrier Serum",
            "Barrier Serum 50ml",
            "SAMPLE_DERMA Barrier Serum is dermatologist tested and ophthalmologist tested.",
        ),
    ],
    ids=("ko-KR", "en-US"),
)
def test_an_answer_naming_the_published_title_states_the_identity_it_cites(
    locale: str, name: str, recorded: str, answer: str
) -> None:
    """발행 제목으로 상품을 부른 답변도 정체성을 서술한 것으로 읽힌다."""

    scope = _safety_scope(locale, name, recorded=recorded)
    bound = _faq_membership_answer_evidence(answer, scope, faq_can_recommend=False, faq_card=None)

    assert {item["id"] for item in bound} == {"ev-brand", "ev-identity", "ev-safety-0", "ev-safety-1"}


@pytest.mark.parametrize(
    ("locale", "recorded", "answer"),
    [
        (
            "ko-KR",
            "SampleDerma BarrierCare365 젠틀 포밍클렌저 200g",
            "SAMPLE_DERMA BarrierCare365 크림은 피부과 테스트와 인체 안자극 테스트를 완료했습니다.",
        ),
        (
            "en-US",
            "Barrier Serum 50ml",
            "SAMPLE_DERMA Barrier Cream is dermatologist tested and ophthalmologist tested.",
        ),
    ],
    ids=("ko-KR", "en-US"),
)
def test_an_answer_naming_another_product_does_not_bind(locale: str, recorded: str, answer: str) -> None:
    """다른 상품을 부른 답변은 정체성이 서술되지 않았으므로 결속되지 않는다."""

    scope = _safety_scope(locale, recorded.rsplit(" ", 1)[0], recorded=recorded)

    assert _faq_membership_answer_evidence(answer, scope, faq_can_recommend=False, faq_card=None) == []


@pytest.mark.parametrize(
    ("locale", "name", "answer"),
    [
        (
            "ko-KR",
            "SampleDerma BarrierCare365 젠틀 포밍클렌저",
            "SAMPLE_DERMA SampleDerma BarrierCare365 젠틀 포밍클렌저는 피부과 테스트와 인체 안자극 테스트를 완료한 제품입니다.",
        ),
        (
            "en-US",
            "Barrier Serum",
            "SAMPLE_DERMA Barrier Serum is a product that is dermatologist tested and ophthalmologist tested.",
        ),
    ],
    ids=("ko-KR", "en-US"),
)
def test_referring_back_to_the_product_by_its_kind_states_no_new_fact(
    locale: str, name: str, answer: str
) -> None:
    """이미 이름을 부른 문장이 그 개체를 총칭으로 되부르는 것은 새 사실이 아니다."""

    scope = _safety_scope(locale, name)
    bound = _faq_membership_answer_evidence(answer, scope, faq_can_recommend=False, faq_card=None)

    assert {item["id"] for item in bound} == {"ev-brand", "ev-identity", "ev-safety-0", "ev-safety-1"}


def test_a_generic_reference_carrying_its_own_claim_still_does_not_bind() -> None:
    """총칭 되부름이 스스로 주장을 실어 오면 여전히 결속되지 않는다."""

    scope = _safety_scope("ko-KR", "SampleDerma BarrierCare365 젠틀 포밍클렌저")
    answer = "SAMPLE_DERMA SampleDerma BarrierCare365 젠틀 포밍클렌저는 피부과 테스트를 완료한 안전한 제품입니다."

    assert _faq_membership_answer_evidence(answer, scope, faq_can_recommend=False, faq_card=None) == []


def test_a_generic_word_that_heads_its_own_claim_is_not_a_reference_back() -> None:
    """개체의 종류를 되부르는 말만 새 사실이 아니다. 다른 주장의 머리 명사는 되부름이 아니다."""

    scope = _safety_scope("ko-KR", "SampleDerma BarrierCare365 젠틀 포밍클렌저")

    # ``처방``과 ``포뮬라``는 페이지가 자기 상품을 가리킬 수 있는 말이지만, 이 자리에서는
    # 각각 스스로 주장을 이룬다. 되부름으로 세면 근거가 말하지 않은 처방이 발행된다.
    for answer in (
        "SAMPLE_DERMA SampleDerma BarrierCare365 젠틀 포밍클렌저는 피부과 처방입니다.",
        "SAMPLE_DERMA SampleDerma BarrierCare365 젠틀 포밍클렌저는 피부과 포뮬라입니다.",
    ):
        assert _faq_membership_answer_evidence(answer, scope, faq_can_recommend=False, faq_card=None) == []


def test_a_record_may_name_the_kind_as_freely_as_an_answer_does() -> None:
    """원자가 총칭으로 종류를 불러도 답변 쪽과 대칭으로 빠지므로 결속이 깨지지 않는다."""

    name = "SampleDerma BarrierCare365 젠틀 포밍클렌저"
    scope = [
        _atom("ev-brand", "identity", _BRAND, "product.brand", "ko-KR"),
        _atom("ev-identity", "identity", name, "product.name", "ko-KR"),
        _atom("ev-safety-0", "source", "제품 피부과 테스트 완료", "product.semanticFacts.safetyTests[0]", "ko-KR"),
    ]
    answer = f"{_BRAND} {name}는 피부과 테스트를 완료한 제품입니다."
    bound = _faq_membership_answer_evidence(answer, scope, faq_can_recommend=False, faq_card=None)

    assert {item["id"] for item in bound} == {"ev-brand", "ev-identity", "ev-safety-0"}

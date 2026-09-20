"""Only the FAQ identity gate reads a Korean name in the slot it fills.

Korean carries a noun's role on the noun, so the same product is spelled
``크림은`` as a topic, ``크림에`` inside a containment phrase and ``크림으로``
as a means.  A relationship-card answer states what a product contains in the
containment slot, and the shared identity reader does not close a name on
``에``, so every answer of that shape named no product and never reached
FAQPage.  The FAQ gate reads the whole closing-particle class instead.

The shared reader stays as strict as it was, because other surfaces decide
something else with it -- ``_product_name`` decides whether Product.name needs
its brand prefixed, ``_description_has_citation_ready_entity_anchors`` decides
whether a model's own description sentence is published instead of the
deterministic one -- and a looser reading there changes what those publish.
Both readings refuse a name that a longer noun merely contains: a particle is
what follows a name, so ``크림에센스`` names a sibling product and not this one.
"""

from __future__ import annotations

import pytest

from pdp_geo_generator_agent.contracts.product_identity import contains_entity_identity_phrase
from pdp_geo_generator_agent.generation import _faq_has_citation_ready_entity_pair

_NAME = "SampleDerma BarrierCare365 클렌징폼"
_PRODUCT = {"brand": "SampleDerma"}


@pytest.mark.parametrize(
    "answer",
    [
        "SampleDerma BarrierCare365 클렌징폼에 담긴 판테놀은 피부 장벽 개선을 돕습니다.",
        "SampleDerma BarrierCare365 클렌징폼은 약산성 포뮬라입니다.",
        "SampleDerma BarrierCare365 클렌징폼으로 아침 세안을 마무리합니다.",
        "SampleDerma BarrierCare365 클렌징폼의 아미노산 유래 세정 성분이 모공 노폐물을 씻어냅니다.",
        "SampleDerma BarrierCare365 클렌징폼과 함께 사용합니다.",
        "SampleDerma BarrierCare365 클렌징폼에서 확인된 결과입니다.",
        "SAMPLE_DERMA SampleDerma BarrierCare365 클렌징폼, 데일리 클렌저입니다.",
    ],
)
def test_faq_pair_keeps_a_name_closed_by_any_particle(answer: str) -> None:
    """조사가 무엇이든 이름이 닫히면 FAQ 짝은 그 상품을 부른 것이다."""

    assert _faq_has_citation_ready_entity_pair("무엇이 들어 있나요?", answer, _PRODUCT, _NAME) is True


@pytest.mark.parametrize(
    ("answer", "name"),
    [
        # A longer sibling name, not this product: ``에`` opens ``에센스``.
        ("SampleDerma BarrierCare365 크림에센스에 담긴 판테놀은 장벽 개선을 돕습니다.", "SampleDerma BarrierCare365 크림"),
        ("SampleDerma BarrierCare365 클렌징폼팩은 약산성 포뮬라입니다.", _NAME),
        ("아로라 세럼을 아침에 사용합니다.", "로라"),
        ("Afterglow Serum is gentle enough for daily use.", "Glow"),
    ],
)
def test_faq_pair_refuses_a_name_a_longer_word_merely_contains(answer: str, name: str) -> None:
    """더 긴 낱말 안에 든 철자는 그 상품을 부른 것이 아니다."""

    assert _faq_has_citation_ready_entity_pair("무엇이 들어 있나요?", answer, {}, name) is False


def test_faq_pair_reads_the_brand_in_the_slot_it_fills() -> None:
    """상품명이 브랜드를 담지 않으면 브랜드도 문장 안 슬롯에서 읽는다."""

    product, name = {"brand": "SampleDerma"}, "BarrierCare365 클렌징폼"
    answer = "SampleDerma에서 만든 BarrierCare365 클렌징폼은 약산성 포뮬라입니다."
    assert _faq_has_citation_ready_entity_pair("어떤 제품인가요?", answer, product, name) is True
    assert _faq_has_citation_ready_entity_pair("어떤 제품인가요?", answer, {"brand": "SampleBotanics"}, name) is False


@pytest.mark.parametrize(
    "sentence",
    [
        "SampleDerma BarrierCare365 클렌징폼은 약산성 포뮬라입니다.",
        "SampleDerma BarrierCare365 클렌징폼의 아미노산 유래 세정 성분",
        "SAMPLE_DERMA SampleDerma BarrierCare365 클렌징폼, 데일리 클렌저",
    ],
)
def test_shared_reader_keeps_reading_a_subject_or_object_slot(sentence: str) -> None:
    """공유 판독기는 주격·목적격·관형격으로 닫힌 이름을 계속 인정한다."""

    assert contains_entity_identity_phrase(sentence, _NAME) is True


@pytest.mark.parametrize(
    "sentence",
    [
        "SampleDerma BarrierCare365 클렌징폼에 담긴 판테놀은 피부 장벽 개선을 돕습니다.",
        "SampleDerma BarrierCare365 클렌징폼팩은 다릅니다.",
    ],
)
def test_shared_reader_is_not_widened_for_other_publishing_surfaces(sentence: str) -> None:
    """공유 판독기는 넓히지 않는다 — Product.name·서술 발행 판정이 이 엄격함에 달려 있다."""

    assert contains_entity_identity_phrase(sentence, _NAME) is False

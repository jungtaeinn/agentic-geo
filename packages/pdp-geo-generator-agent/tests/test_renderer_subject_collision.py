"""A source clause that already names its subject must not be given a second one.

The Korean renderer prepends a topic-marked product name to a source fragment.
When that fragment is already a complete clause about its own subject, the
result carries two subjects and is not Korean.  The English path of the same
renderer already keeps such a clause intact; this pins the same rule for Korean
and guards the English behaviour it mirrors.
"""

from __future__ import annotations

import pytest

from pdp_geo_generator_agent.generation import (
    _english_entity_benefit_sentences,
    _korean_entity_benefit_sentences,
)

_ENTITY_KO = "SAMPLE_DERMA의 SampleDerma BarrierCare365 클렌징폼"
_ENTITY_EN = "SampleBotanics's Essential Care Activating Serum"

# 실제로 공개 문구에 나갔던 두 문장의 원문이다.
_OWN_SUBJECT_KO = "아미노산 유래 세정 포뮬라는 세안 중 발생하는 장벽 손상을 줄여 피부 친화적인 데일리 클렌징을 돕습니다"
_OWN_SUBJECT_KO_DEMONSTRATIVE = "이 제품은 약산성 아미노산 유래 세정 성분으로 장벽 손상 방어를 내세우며, 일상 노폐물부터 가벼운 메이크업까지 세정하도록 안내합니다"
_SUBJECTLESS_KO = "아침과 저녁에 사용하기 적합한 데일리 클렌저로 안내됩니다"
_NOUN_PHRASE_KO = "일상 속 노폐물 세정"


def test_korean_clause_that_names_its_subject_keeps_only_that_subject() -> None:
    sentences = _korean_entity_benefit_sentences(_ENTITY_KO, [_OWN_SUBJECT_KO])

    assert sentences == [f"{_OWN_SUBJECT_KO}."]


def test_a_korean_clause_that_only_points_at_the_product_is_given_its_name() -> None:
    """지시어 주어는 주어가 아니라 이 페이지 밖에서는 가리킬 것이 없는 자리다.

    ``이 제품은``은 상품 페이지 위에서만 성립한다.  공개 문구는 그 페이지를
    떠나 읽히므로, 가리키는 대신 이름을 부른다.  같은 개체를 가리키는 주어로
    바꾸는 것이므로 주장은 그대로고, 결속도 같은 원자에 그대로 걸린다.
    """

    sentences = _korean_entity_benefit_sentences(_ENTITY_KO, [_OWN_SUBJECT_KO_DEMONSTRATIVE])

    assert sentences == [
        f"{_ENTITY_KO}은 약산성 아미노산 유래 세정 성분으로 장벽 손상 방어를 내세우며, "
        "일상 노폐물부터 가벼운 메이크업까지 세정하도록 안내합니다."
    ]


def test_korean_clause_without_a_subject_still_carries_the_product_identity() -> None:
    """주어가 없는 완결절은 상품명을 붙여야 정체성 결속이 유지된다."""

    sentences = _korean_entity_benefit_sentences(_ENTITY_KO, [_SUBJECTLESS_KO])

    assert sentences == [f"{_ENTITY_KO}은 {_SUBJECTLESS_KO}."]


def test_a_korean_noun_phrase_benefit_becomes_something_the_product_does() -> None:
    """명사구 효능은 제품이 하는 일로 적는다.

    처소 틀(``…에는 … 표기되어 있습니다``)은 제품이 아니라 지면이 무엇을 적어
    두었는지를 말한다.  공개 문구는 제품의 서술이므로 같은 원자를 제품이 하는
    일로 적고, 교정기는 그 틀을 같은 효능 원자에 되돌려 결속한다.
    """

    sentences = _korean_entity_benefit_sentences(_ENTITY_KO, [_NOUN_PHRASE_KO])

    assert sentences == [f"{_ENTITY_KO}은 {_NOUN_PHRASE_KO}을 돕습니다."]


def test_english_clause_that_names_its_subject_keeps_only_that_subject() -> None:
    """같은 렌더러의 영문 경로가 이미 세운 규칙을 고정한다."""

    benefit = "The ginseng actives strengthen the skin barrier over time"
    sentences = _english_entity_benefit_sentences(_ENTITY_EN, [benefit], "Essential Care Activating Serum", "serum")

    assert sentences == [f"{benefit}."]


_RELATIVE_CLAUSE_SUBJECT = [
    "피부장벽을 강화하는 세라마이드가 보습을 오래 지속시킵니다",
    "저자극 세안을 돕는 아미노산 성분이 노폐물을 세정합니다",
    "노폐물을 제거하는 계면활성제가 피부에 순합니다",
]


@pytest.mark.parametrize("benefit", _RELATIVE_CLAUSE_SUBJECT)
def test_a_subject_modified_by_a_relative_clause_is_still_its_own_subject(benefit: str) -> None:
    """관계절이 주어를 수식하면 그 절의 목적어가 문장 앞에 선다.

    거기서 판정을 멈추면 진짜 주어를 만나지 못하고, 상품명이 덧붙어 주어가 둘이 된다.
    """

    assert _korean_entity_benefit_sentences(_ENTITY_KO, [benefit]) == [f"{benefit}."]


def test_a_clause_with_no_subject_of_its_own_still_takes_the_product_name() -> None:
    """관계절 수정이 주어 없는 절까지 주어 있는 것으로 읽어서는 안 된다."""

    for benefit in (_SUBJECTLESS_KO, "젖은 모발을 부드럽게 풀어줍니다"):
        assert _korean_entity_benefit_sentences(_ENTITY_KO, [benefit]) == [f"{_ENTITY_KO}은 {benefit}."]


@pytest.mark.xfail(
    reason="연결어미와 어휘화 부사(언제든지)를 가르려면 형태소 분석이 필요하다. 공유 부분문자열로 "
    "절을 끊으면 진짜 주어를 놓쳐 이중 주어가 나오므로, 더 나쁜 쪽을 피해 이 공백을 연다.",
    strict=True,
)
def test_a_coordinate_clauses_subject_is_not_the_matrix_clauses_subject() -> None:
    """`X를 하고, Y가 남습니다`에서 주어를 말하는 것은 뒤 절이다.

    앞 절에는 주어가 없으므로 상품명이 정체성을 대야 한다. 스캔이 문장 끝까지
    가면 뒤 절의 주어를 앞 절의 것으로 세어 상품명을 떼어 버린다.
    """
    benefit = "노폐물을 씻어내고 산뜻한 사용감이 남습니다"

    assert _korean_entity_benefit_sentences(_ENTITY_KO, [benefit]) == [f"{_ENTITY_KO}은 {benefit}."]


_LEXICALIZED_ADVERB = [
    "언제든지 사용 가능한 순한 성분이 피부를 편안하게 가꿔줍니다",
    "피부를 언제든지 편안하게 가꿔주는 순한 성분이 남습니다",
]


@pytest.mark.parametrize("benefit", _LEXICALIZED_ADVERB)
def test_a_lexicalized_adverb_does_not_close_the_clause(benefit: str) -> None:
    """`언제든지`는 부사이지 연결어미가 아니다. 거기서 절을 끊으면 주어를 놓쳐 주어가 둘이 된다."""

    assert _korean_entity_benefit_sentences(_ENTITY_KO, [benefit]) == [f"{benefit}."]

"""Regressions for how a Korean description composes its source into prose."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from pdp_geo_generator_agent.generation import generate_pdp_geo_artifacts


def _node(artifact: Mapping[str, Any], kind: str) -> dict[str, Any]:
    graph = cast(list[dict[str, Any]], cast(Mapping[str, Any], artifact["schemaMarkup"])["jsonLd"]["@graph"])
    return next(
        item
        for item in graph
        if kind in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]])
    )


_FORMULA_PANEL_RUN = (
    "세안 중 발생하는 장벽 손상을 줄이는 Barrier Protective Formula "
    "피부 친화적인 데일리 클렌징을 위한 아미노산 유래 세정 "
    "아미노산유래 계면활성제 일반 계면활성제 3종 장벽보호 성분 함유 클렌징 과정에도 장벽보호!"
)
_SIBLING_FIGURE_ROW = (
    "피부 각질층 내 세라마이드 함량 분석 +63.6% +84.3% +84.3% / "
    "자사 클렌징폼 사용 후 / 사용 2주 후 / 사용 4주 후 / *in vitro 시험 결과"
)
_QUALIFIED_RESULT_ROW = (
    "집앞 나갈때 가볍게 하는 색조 메이크업 97.1% 세정 / 만 20~39세의 성인 여성 30명 대상 / "
    "시험기간 2025.07.21~2025.08.22 / 개인차 있음"
)


def _ocr_dense_korean_cleanser() -> dict[str, Any]:
    audience_sentence = (
        "이 제품은 건조 피부 또는 민감 피부에 추천되며, "
        "일상 속 노폐물부터 가벼운 메이크업까지 세정하는 제품으로 안내됩니다."
    )
    return {
        "name": "장벽 클렌징폼",
        "brand": "예시 브랜드",
        "category": "클렌저",
        "description": "아미노산 유래 세정 성분을 담은 약산성 포뮬라로 일상 속 노폐물을 말끔하게 세정하는 클렌징폼입니다.",
        "ingredients": ["아미노산 유래 세정 성분", "Barrier Protective Formula", "판테놀"],
        "benefits": ["일상 속 노폐물부터 가벼운 메이크업까지 세정", "클렌징 과정에도 장벽 보호"],
        "effects": [],
        "usage": ["클렌징 단계에서 젖은 손에 적당량을 덜어 충분히 거품을 내주세요."],
        "metrics": [],
        "options": ["200g"],
        "price": {"raw": "22000.0", "amount": 22000, "currency": "KRW"},
        "faq": [],
        "reviews": {
            "items": [{"body": "촉촉하고 얼굴당김이 없어요. 지인에게 추천할만해요"}],
            "keywords": ["촉촉하고", "얼굴당김이"],
        },
        "sourceTexts": [_FORMULA_PANEL_RUN, audience_sentence, _SIBLING_FIGURE_ROW, _QUALIFIED_RESULT_ROW],
        "semanticFacts": {
            "skinTypes": ["건조 피부", "민감 피부"],
            "usageSteps": ["클렌징 단계에서 젖은 손에 적당량을 덜어 충분히 거품을 내주세요."],
            "safetyTests": [],
            "evidenceSentences": [audience_sentence],
            "ingredientBenefitLinks": [],
            "citations": [],
            "metricClaims": [
                {
                    "label": "색조 메이크업 세정",
                    "subject": "색조 메이크업",
                    "value": "97.1",
                    "unit": "%",
                    "metric": "세정",
                    "period": "2025.07.21~2025.08.22",
                    "sample": "만 20~39세의 성인 여성 30명",
                    "method": "시험",
                    "caveat": "개인차 있음",
                    "sentence": "색조 메이크업 97.1% 세정",
                    "sourceText": _QUALIFIED_RESULT_ROW,
                },
                {
                    "label": "피부 각질층 내 세라마이드 함량 분석",
                    "subject": "피부 각질층 내 세라마이드 함량",
                    "value": "+63.6",
                    "unit": "%",
                    "metric": "함량 분석",
                    "method": "in vitro 시험",
                    "caveat": "수치와 시점의 대응 관계가 불명확함",
                    "sentence": "피부 각질층 내 세라마이드 함량 분석에서 +63.6%가 제시됩니다.",
                    "sourceText": _SIBLING_FIGURE_ROW,
                },
            ],
        },
    }


def _korean_descriptions() -> list[str]:
    artifact = generate_pdp_geo_artifacts(
        {"product": _ocr_dense_korean_cleanser(), "locale": "ko-KR"}
    )
    return [
        cast(str, _node(artifact, "Product")["description"]),
        cast(str, _node(artifact, "WebPage")["description"]),
    ]


def test_the_audience_stage_states_the_audience_instead_of_a_formula_panel() -> None:
    """A relation word inside a stitched panel is not an audience statement.

    The panel says "데일리 클렌징을 위한" about a routine, and the page states
    its audience in a sentence of its own.  This fails if the stage publishes
    the panel -- which reaches the reader as a run of captions with no
    predicate -- or leaves the page's own audience sentence unused.
    """

    for description in _korean_descriptions():
        assert _FORMULA_PANEL_RUN not in description
        assert "건조 피부" in description and "민감 피부" in description
        assert "이 제품은" not in description


def test_the_two_descriptions_state_the_same_audience_in_their_own_voice() -> None:
    """The page reports what the source says; the product says what it is.

    A page overview is about a document, so it may keep the source's own
    reporting frame.  A product description is the entity speaking about
    itself, where that frame reads as a hedge -- the audience belongs in a
    predicate the product owns.
    """

    product_description, page_description = _korean_descriptions()

    assert "건조 피부 또는 민감 피부에 추천되며" in page_description
    assert "장벽 클렌징폼은 건조 피부 또는 민감 피부 고객을 위한 클렌저입니다." in product_description
    assert "안내합니다" not in product_description
    assert "안내됩니다" not in product_description


def test_a_row_of_sibling_figures_never_reaches_public_copy() -> None:
    """One claim qualifies one measurement, so its siblings cannot ride along.

    The row carries three values and three timepoints with nothing binding
    them, and its own caveat says which value belongs to which timepoint is
    unclear.  Published whole it would put all three under one claim's sample
    and method.
    """

    for description in _korean_descriptions():
        assert "+84.3%" not in description
        assert _SIBLING_FIGURE_ROW not in description


def test_a_measured_share_is_published_as_prose_within_its_study_scope() -> None:
    """A share of something measured has no direction, and is still evidence.

    The delta renderer needs a direction word, so these results were dropped
    and the page lost its strongest measurement.  The result is published in
    the source's own words, as a clause: the product is the subject, what the
    panel measured is its object, and the act measured is its predicate.  A
    panel's phrase owned by the product ("제품의 색조 메이크업 97.1% 세정") reads
    as the product's makeup rather than as what it removed, so the clause is
    what gets published, inside the population and method the same row states.
    """

    for description in _korean_descriptions():
        assert "장벽 클렌징폼은 색조 메이크업을 97.1% 세정했습니다" in description
        assert "만 20~39세의 성인 여성 30명을 대상으로 한 시험에서" in description


def test_review_copy_reports_an_assessment_rather_than_quoting_a_customer() -> None:
    """고객의 말을 그대로 인용하지 않고, 그것이 평가였음을 서술한다.

    한 고객의 문장을 통째로 인용하면 그 사람의 말투와 감탄이 제품 카피에 실리고,
    특정 표현은 구매자가 물은 어떤 질문에도 답하지 않는다.  원문이 발행 가능한
    키워드를 주면 그 키워드가, 없으면 본문의 서술어가 평서형으로 바뀌어
    "…다는 평가를 하였습니다"로 보고된다.  발행 카피에는 인용부호도, 태그 기호도
    남지 않는다.
    """

    for description in _korean_descriptions():
        assert "촉촉하고 얼굴당김이 없다는 평가를 하였습니다." in description
        assert "라고 언급했습니다" not in description
        assert not set("#“”\"") & set(description)


def test_the_page_states_its_price_and_option_as_one_offer_before_the_reviews() -> None:
    """Price and options are one offer, and the page's own facts precede reviews."""

    webpage = cast(str, _node(generate_pdp_geo_artifacts(
        {"product": _ocr_dense_korean_cleanser(), "locale": "ko-KR"}
    ), "WebPage")["description"])

    offer = "장벽 클렌징폼은 22,000원에 판매되며, 200g 옵션으로 구성되어 있습니다."
    assert offer in webpage
    assert "옵션으로 판매됩니다" not in webpage
    assert webpage.index(offer) < webpage.index("사용한 고객들은")


def test_a_benefit_the_copy_already_states_is_not_stated_again() -> None:
    """The audience sentence carries an outcome; the benefit stage must not repeat it."""

    for description in _korean_descriptions():
        assert description.count("일상 속 노폐물부터 가벼운 메이크업까지 세정") == 1
        assert "클렌징 과정에도 장벽 보호를 돕습니다" in description

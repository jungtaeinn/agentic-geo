"""Ports of layout-backed OCR chart metric contracts (15 cases)."""

from __future__ import annotations

from typing import Any

import pytest

from pdp_extractor_agent.ocr.metrics import metric_claims_from_ocr_layout

PRODUCT = "SampleDerma BarrierCare365 클렌징폼"


BASE = [
    {
        "id": "g5",
        "title": "피부 각질층 내 세라마이드 함량 분석",
        "lines": [{"text": "피부 각질층 내 세라마이드 함량 분석", "role": "title"}],
    },
    {
        "id": "g6",
        "parentId": "g5",
        "lines": [
            {"text": "+63.6%", "role": "value", "pairedLabel": "사용 후"},
            {"text": "+84.3%", "role": "value", "pairedLabel": "사용 2주 후"},
            {"text": "자사\n일반제품", "role": "label"},
            {"text": "SampleDerma\n클렌징폼", "role": "label"},
            {"text": "사용 후", "role": "label"},
            {"text": "사용 2주 후", "role": "label"},
        ],
    },
    {
        "id": "g7",
        "parentId": "g5",
        "annotates": "g6",
        "lines": [{"text": "※In vitro 시험 결과", "role": "footnote"}],
    },
]


def test_carries_chart_title_timepoint_series_and_footnote() -> None:
    claims = metric_claims_from_ocr_layout(BASE, PRODUCT)
    assert claims == [
        {
            "value": "+63.6",
            "unit": "%",
            "metric": "피부 각질층 내 세라마이드 함량 분석",
            "timing": "사용 후",
            "subject": "SampleDerma 클렌징폼",
            "comparator": "자사 일반제품",
            "caveat": "※In vitro 시험 결과",
        },
        {
            "value": "+84.3",
            "unit": "%",
            "metric": "피부 각질층 내 세라마이드 함량 분석",
            "timing": "사용 2주 후",
            "subject": "SampleDerma 클렌징폼",
            "comparator": "자사 일반제품",
            "caveat": "※In vitro 시험 결과",
        },
    ]


@pytest.mark.parametrize(
    ("groups", "expected"),
    [
        ([{"id": "g1", "title": "분석", "lines": [{"text": "+63.6%", "role": "value"}]}], []),
        ([{"id": "g1", "lines": [{"text": "+63.6%", "role": "value", "pairedLabel": "사용 후"}]}], []),
        (
            [
                {
                    "id": "g1",
                    "title": "분석",
                    "lines": [
                        {"text": "+63.6%", "role": "value", "pairedLabel": "사용 후"},
                        {"text": "A", "role": "label"},
                        {"text": "B", "role": "label"},
                        {"text": "C", "role": "label"},
                    ],
                }
            ],
            [],
        ),
    ],
)
def test_requires_paired_label_and_unambiguous_measured_outcome(
    groups: list[dict[str, object]], expected: list[dict[str, object]]
) -> None:
    assert metric_claims_from_ocr_layout(groups, PRODUCT) == expected


def test_splits_an_unmistakable_sample_period_and_caveat_from_footnote() -> None:
    groups: list[dict[str, Any]] = [
        {
            "id": "g1",
            "title": "색조 메이크업 세정력",
            "lines": [{"text": "97.1%", "role": "value", "pairedLabel": "색조 메이크업"}],
        },
        {
            "id": "g2",
            "annotates": "g1",
            "lines": [
                {
                    "text": "만 20~39세의 성인 여성 30명 대상 / 시험기간 2025.07.21-2025.08.22 / 개인차 있음",
                    "role": "footnote",
                }
            ],
        },
    ]
    assert metric_claims_from_ocr_layout(groups, PRODUCT)[0] == {
        "value": "97.1",
        "unit": "%",
        "metric": "색조 메이크업 세정력",
        "timing": "색조 메이크업",
        "sample": "만 20~39세의 성인 여성 30명 대상",
        "period": "시험기간 2025.07.21-2025.08.22",
        "caveat": "개인차 있음",
    }


def test_splits_value_unit() -> None:
    assert (
        metric_claims_from_ocr_layout(
            [
                {
                    "id": "g1",
                    "title": "보습력 개선",
                    "lines": [{"text": "105%", "role": "value", "pairedLabel": "사용 4주 후"}],
                }
            ],
            PRODUCT,
        )[0]["value"]
        == "105"
    )


def test_reads_parent_chart_title_and_attached_footnote() -> None:
    groups: list[dict[str, Any]] = [
        {"id": "g1", "title": "함량 분석", "lines": []},
        {"id": "g2", "parentId": "g1", "lines": [{"text": "+84.3%", "role": "value", "pairedLabel": "사용 4주 후"}]},
        {"id": "g3", "annotates": "g1", "lines": [{"text": "※In vitro 시험 결과", "role": "footnote"}]},
    ]
    claim = metric_claims_from_ocr_layout(groups, PRODUCT)[0]
    assert claim["metric"] == "함량 분석" and claim["caveat"] == "※In vitro 시험 결과"


def test_skips_value_embedded_in_prose() -> None:
    groups = [{"id": "g1", "title": "결과", "lines": [{"text": "색조 메이크업 97.1% 세정", "role": "body"}]}]
    assert metric_claims_from_ocr_layout(groups, PRODUCT) == []


def test_reads_english_sample_period_and_caveat() -> None:
    groups = [
        {
            "id": "g1",
            "title": "Ceramide content",
            "lines": [{"text": "+84.3%", "role": "value", "pairedLabel": "After 2 weeks"}],
        },
        {
            "id": "g2",
            "annotates": "g1",
            "lines": [
                {"text": "30 women aged 20 to 39 / for 4 weeks / individual results may vary", "role": "footnote"}
            ],
        },
    ]
    claim = metric_claims_from_ocr_layout(groups, "SAMPLE_DERMA foam")[0]
    assert (
        claim["sample"] == "30 women aged 20 to 39"
        and claim["period"] == "for 4 weeks"
        and claim["caveat"] == "individual results may vary"
    )


def test_attributes_english_product_and_comparator_series() -> None:
    groups = [
        {
            "id": "g1",
            "title": "Ceramide content",
            "lines": [
                {"text": "+84.3%", "role": "value", "pairedLabel": "After 2 weeks"},
                {"text": "Our alkaline foam", "role": "label"},
                {"text": "SampleDerma cleansing foam", "role": "label"},
            ],
        }
    ]
    claim = metric_claims_from_ocr_layout(groups, "SampleDerma BarrierCare365 Cleansing Foam")[0]
    assert claim["subject"] == "SampleDerma cleansing foam" and claim["comparator"] == "Our alkaline foam"


def test_does_not_assign_comparator_that_only_shares_a_category_word() -> None:
    groups = [
        {
            "id": "g1",
            "title": "세정력 비교",
            "lines": [
                {"text": "자사 일반 클렌징폼", "role": "label"},
                {"text": "SampleDerma BarrierCare365", "role": "label"},
                {"text": "97.9", "role": "value", "pairedLabel": "세정 직후"},
            ],
        }
    ]
    claim = metric_claims_from_ocr_layout(groups, PRODUCT)[0]
    assert claim["subject"] == "SampleDerma BarrierCare365" and claim["comparator"] == "자사 일반 클렌징폼"


@pytest.mark.parametrize(
    "footnote", ["성인 여성 30명 대상 4주 사용 시험", "성인 여성 30명 / 시험기간 2025/07/21-2025/08/22"]
)
def test_extracts_slots_from_single_segment_or_slash_date_footnotes(footnote: str) -> None:
    groups = [
        {"id": "g1", "title": "각질층 수분", "lines": [{"text": "97.6", "role": "value", "pairedLabel": "4주 후"}]},
        {"id": "g2", "annotates": "g1", "lines": [{"text": footnote, "role": "footnote"}]},
    ]
    claim = metric_claims_from_ocr_layout(groups, PRODUCT)[0]
    assert "30명" in claim["sample"] and "period" in claim


def test_ignores_footnote_without_value_group() -> None:
    assert (
        metric_claims_from_ocr_layout([{"id": "g1", "lines": [{"text": "30명 대상", "role": "footnote"}]}], PRODUCT)
        == []
    )


def test_does_not_publish_a_chart_caption_as_a_metric_claim() -> None:
    groups = [
        {
            "id": "g1",
            "title": "임상 결과",
            "lines": [{"text": "임상 결과", "role": "title"}, {"text": "피부 장벽이 좋아 보입니다", "role": "body"}],
        }
    ]
    assert metric_claims_from_ocr_layout(groups, PRODUCT) == []


def test_keeps_paired_label_and_all_attached_footnote_context() -> None:
    groups = [
        {
            "id": "metric",
            "title": "hydration",
            "lines": [{"text": "1.3x", "role": "value", "pairedLabel": "after 2 weeks"}],
        },
        {
            "id": "method",
            "annotates": "metric",
            "lines": [{"text": "Instrumental assessment", "role": "footnote"}],
        },
        {
            "id": "caveat",
            "annotates": "metric",
            "lines": [{"text": "Individual results may vary.", "role": "footnote"}],
        },
    ]

    claim = metric_claims_from_ocr_layout(groups, "Evidence Serum")[0]

    assert claim["timing"] == "after 2 weeks"
    # No attached footnote context is lost, and each piece lands in the slot it
    # states: a footnote naming how the study was run is the method, and the
    # disclaimer is the caveat.  Lumping both into the caveat left the method
    # slot empty, so nothing downstream could attribute the result to a study.
    assert claim["method"] == "Instrumental assessment"
    assert claim["caveat"] == "Individual results may vary."

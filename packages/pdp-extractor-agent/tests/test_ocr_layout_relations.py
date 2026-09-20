"""Ports of layout backing and group-to-section contracts (16 cases)."""

from __future__ import annotations

from typing import Any

import pytest

from pdp_extractor_agent.ocr.relations import ocr_layout_sections, verify_ocr_layout_groups


@pytest.mark.parametrize(
    ("text", "groups", "expected"),
    [
        (
            "효능\n장벽 손상 방어",
            [{"id": "g1", "title": "효능", "lines": [{"text": "효능", "role": "title"}]}],
            [{"id": "g1", "title": "효능", "lines": [{"text": "효능", "role": "title"}]}],
        ),
        (
            "효능\n장벽 손상 방어",
            [
                {
                    "id": "g1",
                    "lines": [{"text": "장벽 손상 방어", "role": "body"}, {"text": "없는 문장", "role": "body"}],
                }
            ],
            [{"id": "g1", "lines": [{"text": "장벽 손상 방어", "role": "body"}]}],
        ),
        (
            "장벽 손상 방어",
            [{"id": "g1", "title": "핵심 성분", "lines": [{"text": "장벽 손상 방어", "role": "body"}]}],
            [{"id": "g1", "lines": [{"text": "장벽 손상 방어", "role": "body"}]}],
        ),
        (
            "각주 문장입니다",
            [
                {
                    "id": "g1",
                    "parentId": "none",
                    "annotates": "gone",
                    "lines": [{"text": "각주 문장입니다", "role": "footnote"}],
                }
            ],
            [{"id": "g1", "lines": [{"text": "각주 문장입니다", "role": "footnote"}]}],
        ),
        (
            "자사\n일반제품",
            [{"id": "g1", "lines": [{"text": "자사 일반제품", "role": "label"}]}],
            [{"id": "g1", "lines": [{"text": "자사 일반제품", "role": "label"}]}],
        ),
        (
            "각질층 수분\n1636 ppm",
            [
                {
                    "id": "g1",
                    "title": "각질층 수분",
                    "lines": [{"text": "각질층 수분", "role": "title"}, {"text": "+63.6%", "role": "value"}],
                }
            ],
            [{"id": "g1", "title": "각질층 수분", "lines": [{"text": "각질층 수분", "role": "title"}]}],
        ),
        (
            "각질층 수분\n+63.6%\n4주 후",
            [
                {
                    "id": "g1",
                    "title": "각질층 수분",
                    "lines": [{"text": "각질층 수분", "role": "title"}, {"text": "+63.6%", "role": "value"}],
                }
            ],
            [
                {
                    "id": "g1",
                    "title": "각질층 수분",
                    "lines": [{"text": "각질층 수분", "role": "title"}, {"text": "+63.6%", "role": "value"}],
                }
            ],
        ),
    ],
)
def test_verifies_only_lines_backed_by_transcription(
    text: str, groups: list[dict[str, object]], expected: list[dict[str, object]]
) -> None:
    assert verify_ocr_layout_groups(text, groups) == expected


def test_discards_structure_when_most_lines_are_unbacked() -> None:
    assert (
        verify_ocr_layout_groups(
            "효능",
            [
                {
                    "id": "g1",
                    "lines": [
                        {"text": "효능", "role": "title"},
                        {"text": "없는 하나", "role": "body"},
                        {"text": "없는 둘", "role": "body"},
                    ],
                }
            ],
        )
        is None
    )


def test_reports_nothing_when_the_model_reported_no_groups() -> None:
    assert verify_ocr_layout_groups("효능", []) is None


SUMMARY = [
    {"id": "g1", "title": "효능", "lines": [{"text": "효능", "role": "title"}]},
    {"id": "g2", "parentId": "g1", "ordinal": 1, "lines": [{"text": "장벽 손상 방어", "role": "body"}]},
    {"id": "g3", "parentId": "g1", "ordinal": 2, "lines": [{"text": "가벼운 메이크업 세정력", "role": "body"}]},
]


def test_turns_numbered_children_into_ordered_section_items() -> None:
    assert ocr_layout_sections(SUMMARY) == [
        {
            "heading": "효능",
            "items": [{"ordinal": 1, "text": "장벽 손상 방어"}, {"ordinal": 2, "text": "가벼운 메이크업 세정력"}],
        }
    ]


def test_never_turns_label_value_or_footnote_into_items() -> None:
    assert ocr_layout_sections(
        [
            {
                "id": "g1",
                "title": "차트",
                "lines": [
                    {"text": "+63.6%", "role": "value"},
                    {"text": "사용 후", "role": "label"},
                    {"text": "시험 결과", "role": "footnote"},
                ],
            }
        ]
    ) == [{"heading": "차트", "items": []}]


def test_keeps_chart_title_even_when_chart_has_no_prose() -> None:
    assert (
        ocr_layout_sections([{"id": "g1", "title": "피부 각질층 내 세라마이드 함량 분석", "lines": []}])[0]["heading"]
        == "피부 각질층 내 세라마이드 함량 분석"
    )


def test_keeps_headless_panel_prose_as_one_item() -> None:
    assert ocr_layout_sections(
        [{"id": "g1", "lines": [{"text": "집앞 나갈때 가볍게 하는 색조 메이크업 97.1% 세정", "role": "body"}]}]
    ) == [{"items": [{"text": "집앞 나갈때 가볍게 하는 색조 메이크업 97.1% 세정"}]}]


def test_normalizes_line_break_inside_one_layout_line() -> None:
    assert ocr_layout_sections(
        [{"id": "g1", "title": "핵심 성분", "lines": [{"text": "Barrier\nProtective Formula", "role": "body"}]}]
    )[0]["items"] == [{"text": "Barrier Protective Formula"}]


def test_carries_grandchild_prose_into_top_level_section() -> None:
    groups: list[dict[str, Any]] = [
        {"id": "g1", "title": "CLINICAL RESULTS", "lines": []},
        {"id": "g2", "parentId": "g1", "lines": []},
        {"id": "g3", "parentId": "g2", "lines": [{"text": "Improved after 4 weeks.", "role": "body"}]},
    ]
    assert ocr_layout_sections(groups) == [
        {"heading": "CLINICAL RESULTS", "items": [{"text": "Improved after 4 weeks."}]}
    ]


def test_ignores_self_reference() -> None:
    assert verify_ocr_layout_groups(
        "a", [{"id": "g1", "parentId": "g1", "lines": [{"text": "a", "role": "body"}]}]
    ) == [{"id": "g1", "lines": [{"text": "a", "role": "body"}]}]

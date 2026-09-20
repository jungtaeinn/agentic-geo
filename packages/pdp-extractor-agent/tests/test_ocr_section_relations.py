"""Layout relation tree to OCR-section contract (15 legacy counterparts)."""

from __future__ import annotations

import pytest

from pdp_extractor_agent.ocr.pipeline import layout_sections_from_groups


@pytest.mark.parametrize(
    ("heading", "body", "ordinal"),
    [
        ("Benefits", "Barrier support", 1),
        ("Benefits", "Hydration", 2),
        ("Ingredients", "Ceramide", 1),
        ("Ingredients", "Peptide", 2),
        ("How to Use", "Apply after toner", 1),
        ("How to Use", "Use nightly", 2),
        ("Effect", "Firmness", 1),
        ("Effect", "Elasticity", 2),
        ("효능", "피부 장벽 보호", 1),
        ("성분", "세라마이드", 1),
        ("사용법", "토너 후 바릅니다", 1),
        ("Clinical", "Improvement", 1),
        ("FAQ", "Use on dry skin", 1),
        ("Title", "Body copy", 1),
        ("Title", "Second copy", 2),
    ],
)
def test_turns_parent_child_layout_groups_into_ordered_sections(heading: str, body: str, ordinal: int) -> None:
    sections = layout_sections_from_groups(
        [
            {"id": "root", "title": heading, "lines": [{"text": heading, "role": "title"}]},
            {"id": "child", "parentId": "root", "ordinal": ordinal, "lines": [{"text": body, "role": "body"}]},
        ]
    )
    assert sections == [{"heading": heading, "items": [{"text": body, "ordinal": ordinal}]}]

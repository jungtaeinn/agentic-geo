"""Sliced-image OCR joining and layout-ID rebasing (16 legacy counterparts)."""

from __future__ import annotations

import pytest

from pdp_extractor_agent.ocr.pipeline import join_slice_candidates
from pdp_extractor_agent.ocr.relations import stitch_sliced_layout_groups


@pytest.mark.parametrize(
    ("first", "second"),
    [
        ("Benefit Barrier", "Barrier support"),
        ("Apply after", "after toner"),
        ("1. Spray evenly", "2. Pat gently"),
        ("Ceramide 10000ppm", "10000ppm for barrier"),
        ("Before use", "After use"),
        ("Alpha beta", "beta gamma"),
        ("dry skin", "skin comfort"),
        ("first panel", "second panel"),
        ("효능 피부 장벽", "피부 장벽 보호"),
        ("사용법 토너 후", "토너 후 발라주세요"),
        ("A B C", "C D E"),
        ("clinical result", "result 98%"),
    ],
)
def test_keeps_a_newline_when_a_boundary_has_no_distinctive_overlap(first: str, second: str) -> None:
    joined = join_slice_candidates(
        [
            {"imageUrl": "https://img/a.png#ocr-slice-1of2", "text": first, "confidence": 0.9},
            {"imageUrl": "https://img/a.png#ocr-slice-2of2", "text": second, "confidence": 0.9},
        ]
    )
    assert joined[0]["text"] == f"{first}\n{second}"


def test_drops_only_a_distinctive_repeated_boundary_line() -> None:
    overlap = "This clinical result line spans both tall image slices exactly"
    joined = join_slice_candidates(
        [
            {"imageUrl": "https://img/a.png", "sliceIndex": 1, "text": f"Benefits\n{overlap}"},
            {"imageUrl": "https://img/a.png", "sliceIndex": 2, "text": f"{overlap}\nHOW TO USE"},
        ]
    )
    assert joined[0]["text"] == f"Benefits\n{overlap}\nHOW TO USE"


def test_joins_known_slices_when_reconciliation_drops_a_boundary_token() -> None:
    """Only a same-base slice pair may use the retained tolerant overlap."""

    image = "https://assets.example/images/tall-product-panel.png"
    joined = join_slice_candidates(
        [
            {
                "imageUrl": image,
                "sliceIndex": 1,
                "sliceCount": 2,
                "text": "잠시뿐인 촉촉함은 No\n날아감 없는 든든한 보습 미스트\nCeramide 10,000 ppm 함유 보습 미스트",
                "groups": [
                    {
                        "id": "g1",
                        "title": "잠시뿐인 촉촉함은 No",
                        "lines": [{"text": "잠시뿐인 촉촉함은 No", "role": "title"}],
                    }
                ],
            },
            {
                "imageUrl": image,
                "sliceIndex": 2,
                "sliceCount": 2,
                "text": "날아감 없는 든든한 보습 미스트\nCeramide ppm 함유 보습 미스트\n피부 장벽을 채우는 크림 미스트",
                "groups": [{"id": "g1", "lines": [{"text": "피부 장벽을 채우는 크림 미스트", "role": "body"}]}],
            },
        ]
    )

    assert joined[0]["text"].count("날아감 없는 든든한 보습 미스트") == 1
    assert "Ceramide 10,000 ppm 함유 보습 미스트" in joined[0]["text"]
    assert [group["id"] for group in joined[0]["groups"]] == ["s1:g1", "s2:g1"]


def test_rebases_group_ids_by_slice_and_preserves_child_parent_relationship() -> None:
    stitched = stitch_sliced_layout_groups(
        [
            {
                "sliceIndex": 1,
                "groups": [{"id": "root", "title": "Benefits", "lines": [{"text": "Benefits", "role": "title"}]}],
            },
            {
                "sliceIndex": 2,
                "groups": [
                    {
                        "id": "item",
                        "parentId": "root",
                        "ordinal": 1,
                        "lines": [{"text": "Barrier support", "role": "body"}],
                    }
                ],
            },
        ]
    )
    assert stitched == [
        {"id": "s1:root", "title": "Benefits", "lines": [{"text": "Benefits", "role": "title"}]},
            {"id": "s2:item", "parentId": "s2:root", "ordinal": 1, "lines": [{"text": "Barrier support", "role": "body"}]},
    ]


def test_does_not_stitch_when_a_slice_overlap_is_unmatched() -> None:
    stitched = stitch_sliced_layout_groups(
        [
            {"sliceIndex": 1, "groups": [{"id": "one", "lines": []}]},
            {"sliceIndex": 2, "overlapUnmatched": True, "groups": [{"id": "two", "lines": []}]},
        ]
    )
    assert stitched is None


def test_keeps_slice_lineage_on_the_joined_candidate() -> None:
    joined = join_slice_candidates(
        [
            {"imageUrl": "https://img/a.png#ocr-slice-1of2", "text": "one", "confidence": 0.8},
            {"imageUrl": "https://img/a.png#ocr-slice-2of2", "text": "two", "confidence": 0.6},
        ]
    )
    assert joined[0]["imageUrl"] == "https://img/a.png" and joined[0]["imageUrls"] == ["https://img/a.png"]


def test_joined_slice_lineage_replaces_fragment_urls_with_the_base_url() -> None:
    """The public joined candidate never exposes provider display fragments."""

    joined = join_slice_candidates(
        [
            {
                "imageUrl": "https://img/a.png#ocr-slice-1of2",
                "imageUrls": ["https://img/a.png#ocr-slice-1of2"],
                "text": "Benefits",
                "sliceIndex": 1,
                "sliceCount": 2,
                "sourceOrder": 7,
            },
            {
                "imageUrl": "https://img/a.png#ocr-slice-2of2",
                "imageUrls": ["https://img/a.png#ocr-slice-2of2"],
                "text": "HOW TO USE",
                "sliceIndex": 2,
                "sliceCount": 2,
                "sourceOrder": 7,
            },
        ]
    )

    assert joined == [
        {
            "imageUrl": "https://img/a.png",
            "imageUrls": ["https://img/a.png"],
            "text": "Benefits\nHOW TO USE",
            "sourceOrder": 7,
            "sliceCount": 2,
        }
    ]


def test_drops_ambiguous_slice_layout_and_keeps_the_unmatched_newline_boundary() -> None:
    """A simple concatenation has no trustworthy cross-slice group ownership."""

    joined = join_slice_candidates(
        [
            {
                "imageUrl": "https://img/a.png",
                "sliceIndex": 1,
                "sliceCount": 2,
                "text": "Benefits\nBarrier support improves hydration",
                "groups": [{"id": "g1", "title": "Benefits", "lines": [{"text": "Benefits", "role": "title"}]}],
            },
            {
                "imageUrl": "https://img/a.png",
                "sliceIndex": 2,
                "sliceCount": 2,
                "text": "How to Use\nApply nightly after toner",
                "groups": [{"id": "g1", "title": "How to Use", "lines": [{"text": "How to Use", "role": "title"}]}],
            },
        ]
    )

    assert joined[0]["text"] == "Benefits\nBarrier support improves hydration\nHow to Use\nApply nightly after toner"
    assert "groups" not in joined[0]


def test_drops_a_fully_consumed_boundary_group_even_when_it_repeats_a_title() -> None:
    """The prior slice owns a consumed overlap line and its duplicated group."""

    overlap = "This clinical result line spans both tall image slices exactly"
    joined = join_slice_candidates(
        [
            {
                "imageUrl": "https://img/a.png",
                "sliceIndex": 1,
                "sliceCount": 2,
                "text": f"Benefits\n{overlap}",
                "groups": [
                    {
                        "id": "g1",
                        "title": "Benefits",
                        "lines": [
                            {"text": "Benefits", "role": "title"},
                            {"text": overlap, "role": "body"},
                        ],
                    }
                ],
            },
            {
                "imageUrl": "https://img/a.png",
                "sliceIndex": 2,
                "sliceCount": 2,
                "text": f"{overlap}\nHOW TO USE",
                "groups": [
                    {
                        "id": "g1",
                        "title": "Benefits",
                        "lines": [{"text": overlap, "role": "body"}],
                    },
                    {
                        "id": "g2",
                        "title": "HOW TO USE",
                        "lines": [{"text": "HOW TO USE", "role": "title"}],
                    },
                ],
            },
        ]
    )

    assert [group["id"] for group in joined[0]["groups"]] == ["s1:g1", "s2:g2"]


def test_keeps_unrelated_images_as_separate_joined_candidates() -> None:
    joined = join_slice_candidates(
        [
            {"imageUrl": "https://img/a.png#ocr-slice-1of2", "text": "one", "confidence": 0.8},
            {"imageUrl": "https://img/b.png#ocr-slice-1of2", "text": "two", "confidence": 0.8},
        ]
    )
    assert [item["imageUrl"] for item in joined] == ["https://img/a.png", "https://img/b.png"]

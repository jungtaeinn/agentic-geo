"""Layout-driven product-field routing contracts (7 legacy counterparts)."""

from __future__ import annotations

from pdp_extractor_agent.ocr.pipeline import combine_ocr_candidates, join_slice_candidates, layout_field_facts


def test_keeps_distinct_ocr_candidates() -> None:
    combined = combine_ocr_candidates(
        [
            {"imageUrl": "https://img/a.png", "text": "Barrier support", "confidence": 0.8},
            {"imageUrl": "https://img/b.png", "text": "Apply after toner", "confidence": 0.8},
        ]
    )
    assert [item["imageUrl"] for item in combined] == ["https://img/a.png", "https://img/b.png"]


def test_absorbs_duplicate_image_transcriptions_using_the_lower_confidence_reading() -> None:
    combined = combine_ocr_candidates(
        [
            {"imageUrl": "https://img/a.png", "text": "Barrier support", "confidence": 0.42},
            {"imageUrl": "https://img/a.png", "text": "Barrier support serum", "confidence": 0.91},
        ]
    )
    assert combined == [
        {
            "imageUrl": "https://img/a.png",
            "imageUrls": ["https://img/a.png"],
            "text": "Barrier support serum",
            "confidence": 0.42,
        }
    ]


def test_preserves_all_source_image_lineage_when_candidates_merge() -> None:
    combined = combine_ocr_candidates(
        [
            {
                "imageUrl": "https://img/a.png",
                "imageUrls": ["https://img/original.png"],
                "text": "Benefit",
                "confidence": 0.8,
            },
            {
                "imageUrl": "https://img/a.png",
                "imageUrls": ["https://img/slice.png"],
                "text": "Benefit",
                "confidence": 0.7,
            },
        ]
    )
    assert combined[0]["imageUrls"] == ["https://img/original.png", "https://img/a.png", "https://img/slice.png"]


def test_merged_longer_candidate_keeps_the_first_primary_image_url() -> None:
    combined = combine_ocr_candidates(
        [
            {"imageUrl": "https://img/first.png", "text": "Barrier support", "confidence": 0.8},
            {"imageUrl": "https://img/second.png", "text": "Barrier support serum", "confidence": 0.7},
        ]
    )

    assert combined == [
        {
            "imageUrl": "https://img/first.png",
            "imageUrls": ["https://img/first.png", "https://img/second.png"],
            "text": "Barrier support serum",
            "confidence": 0.7,
        }
    ]


def test_merges_distinct_image_candidates_with_a_distinctive_boundary_overlap() -> None:
    """TS joins adjacent source images, then keeps first URL/min confidence."""

    overlap = "This clinical result line spans both tall image slices exactly"
    combined = combine_ocr_candidates(
        [
            {
                "imageUrl": "https://img/a.png",
                "text": f"Benefits\n{overlap}",
                "confidence": 0.9,
                "groups": [{"id": "a", "lines": []}],
                "sliceIndex": 1,
                "sliceCount": 2,
            },
            {
                "imageUrl": "https://img/b.png",
                "text": f"{overlap}\nHOW TO USE",
                "confidence": 0.4,
                "groups": [{"id": "b", "lines": []}],
                "sliceIndex": 2,
                "sliceCount": 2,
            },
        ]
    )

    assert combined == [
        {
            "imageUrl": "https://img/a.png",
            "imageUrls": ["https://img/a.png", "https://img/b.png"],
            "text": f"Benefits\n{overlap}\nHOW TO USE",
            "confidence": 0.4,
        }
    ]


def test_keeps_distinct_images_when_the_boundary_only_matches_after_token_loss() -> None:
    """Only known slices may use the TS dropped-token overlap tolerance."""

    combined = combine_ocr_candidates(
        [
            {
                "imageUrl": "https://img/a.png",
                "text": "Benefits\nClinical barrier hydration recovery supports resilience",
            },
            {
                "imageUrl": "https://img/b.png",
                "text": "Clinical barrier hydration supports resilience\nHow to use this serum nightly",
            },
        ]
    )

    assert [item["imageUrl"] for item in combined] == ["https://img/a.png", "https://img/b.png"]


def test_joined_explicit_slices_do_not_invent_a_missing_slice_count() -> None:
    joined = join_slice_candidates(
        [
            {
                "imageUrl": "https://img/tall.png#ocr-slice-1of2",
                "sliceIndex": 1,
                "text": "Benefits Barrier support",
                "sourceOrder": 4,
            },
            {
                "imageUrl": "https://img/tall.png#ocr-slice-2of2",
                "sliceIndex": 2,
                "text": "Barrier support Apply after toner",
                "sourceOrder": 4,
            },
        ]
    )

    assert joined[0]["imageUrl"] == "https://img/tall.png"
    assert joined[0]["sourceOrder"] == 4
    assert "sliceIndex" not in joined[0]
    assert "sliceCount" not in joined[0]


def test_routes_a_key_ingredients_layout_group_to_ingredients() -> None:
    facts = layout_field_facts(
        [{"id": "g1", "title": "Key Ingredients", "lines": [{"text": "Ceramide and peptide", "role": "body"}]}],
        "Barrier Cream",
    )
    assert facts["ingredients"] == ["Ceramide and peptide"]


def test_routes_a_benefit_layout_group_to_benefits() -> None:
    facts = layout_field_facts(
        [{"id": "g1", "title": "Benefits", "lines": [{"text": "Supports a hydrated barrier", "role": "body"}]}],
        "Barrier Cream",
    )
    assert facts["benefits"] == ["Supports a hydrated barrier"]


def test_routes_a_how_to_use_layout_group_to_usage() -> None:
    facts = layout_field_facts(
        [{"id": "g1", "title": "How to Use", "lines": [{"text": "Apply two pumps after toner", "role": "body"}]}],
        "Barrier Cream",
    )
    assert facts["usage"] == ["Apply two pumps after toner"]


def test_routes_every_caution_layout_row_to_safety_without_a_lexical_cue_per_row() -> None:
    facts = layout_field_facts(
        [
            {
                "id": "g1",
                "title": "CAUTION",
                "lines": [
                    {"text": "Avoid contact with eyes.", "role": "body"},
                    {"text": "Store in a cool, dry place.", "role": "body"},
                ],
            }
        ],
        "Barrier Cream",
    )

    assert facts["safety"] == ["Avoid contact with eyes.", "Store in a cool, dry place."]


def test_does_not_flatten_chart_values_into_unstructured_metrics() -> None:
    facts = layout_field_facts(
        [
            {
                "id": "g1",
                "title": "Firmness test",
                "lines": [{"text": "+84.3%", "role": "value", "pairedLabel": "After 4 weeks"}],
            }
        ],
        "Barrier Cream",
    )
    assert facts["metrics"] == []

"""Public image-OCR evidence assembly contracts (4 legacy counterparts)."""

from __future__ import annotations

import io
from collections.abc import Mapping
from typing import Any, cast

import pytest
from PIL import Image

from pdp_extractor_agent.ocr.evidence import (
    assemble_image_ocr_evidence,
    build_image_ocr_runtime_usage,
    extract_image_ocr_evidence,
)

IMAGE = "https://cdn.example.com/detail.png"


def test_assembles_public_blocks_with_image_lineage() -> None:
    assembled = assemble_image_ocr_evidence(
        {
            "imagesScanned": 1,
            "extractedTexts": [
                {
                    "imageUrl": IMAGE,
                    "text": "Ceramide 10,000ppm improves moisture by 98%.",
                    "confidence": 0.9,
                    "keywords": [{"keyword": "Ceramide", "category": "ingredient"}],
                    "sentenceInsights": [
                        {"text": "Ceramide 10,000ppm improves moisture by 98%.", "category": "benefit"}
                    ],
                }
            ],
        },
        {
            "metricClaims": [
                {"sentence": "improves moisture by 98%", "sourceText": "improves moisture by 98%", "imageUrls": [IMAGE]}
            ]
        },
        [],
        "Barrier Cream",
    )
    assert assembled["ocr"]["imageTexts"] == [
        {
            "imageUrl": IMAGE,
            "imageUrls": [IMAGE],
            "text": "Ceramide 10,000ppm improves moisture by 98%.",
            "confidence": 0.9,
        }
    ]
    assert assembled["ocr"]["textBlocks"] == ["Ceramide 10,000ppm improves moisture by 98%."]
    assert assembled["ocr"]["sentenceInsights"][0]["imageUrls"] == [IMAGE]
    assert assembled["ocr"]["semanticFacts"]["metricClaims"][0]["imageUrls"] == [IMAGE]
    assert assembled["keywords"]["ingredient"] == ["Ceramide"]


def test_collapses_runtime_steps_and_sums_token_usage() -> None:
    usage = build_image_ocr_runtime_usage(
        [
            {
                "stage": "ocr",
                "label": "OCR/structure extraction",
                "called": True,
                "tokenUsage": {"inputTokens": 100, "outputTokens": 20, "totalTokens": 120},
            },
            {
                "stage": "ocr",
                "label": "OCR/structure extraction",
                "called": True,
                "tokenUsage": {"inputTokens": 50, "outputTokens": 10, "totalTokens": 60},
            },
        ]
    )
    assert usage == {
        "steps": [
            {
                "stage": "ocr",
                "label": "OCR/structure extraction",
                "called": True,
                "tokenUsage": {"inputTokens": 150, "outputTokens": 30, "totalTokens": 180},
            }
        ],
        "tokenTotals": {"inputTokens": 150, "outputTokens": 30, "totalTokens": 180},
    }


@pytest.mark.asyncio
async def test_mock_provider_returns_empty_well_formed_evidence_with_warning() -> None:
    result = await extract_image_ocr_evidence(
        {"source": "https://example.com/p/1", "productName": "Test", "imageUrls": [IMAGE]}, {"provider": "mock"}
    )
    assert result["ocr"]["imageTexts"] == [] and result["ocr"]["textBlocks"] == []
    assert {warning["code"] for warning in result["diagnostics"]["warnings"]} >= {"IMAGE_OCR_PROVIDER_NOT_CONFIGURED"}
    assert result["diagnostics"]["ocr"]["provider"] == "mock"


@pytest.mark.asyncio
async def test_mock_provider_does_not_add_no_text_warning_after_its_configuration_warning() -> None:
    """The TS early mock return is one actionable warning, not two conflicting ones."""

    result = await extract_image_ocr_evidence(
        {"source": "https://example.com/p/1", "productName": "Test", "imageUrls": [IMAGE]}, {"provider": "mock"}
    )
    assert [warning["code"] for warning in result["diagnostics"]["warnings"]] == [
        "IMAGE_OCR_PROVIDER_NOT_CONFIGURED"
    ]


@pytest.mark.asyncio
async def test_layout_metric_source_text_excludes_unrelated_image_wide_copy() -> None:
    """A structured chart claim receives only its chart and attached-note evidence."""

    result = await extract_image_ocr_evidence(
        {
            "productName": "Barrier Serum",
            "extraCandidates": [
                {
                    "imageUrl": IMAGE,
                    "text": (
                        "Unrelated launch copy for a seasonal campaign. Hydration improvement. +50%. After 4 weeks. "
                        "30 participants / Individual results may vary."
                    ),
                    "groups": [
                        {
                            "id": "metric",
                            "title": "Hydration improvement",
                            "lines": [{"text": "+50%", "role": "value", "pairedLabel": "After 4 weeks"}],
                        },
                        {
                            "id": "note",
                            "annotates": "metric",
                            "lines": [
                                {"text": "30 participants / Individual results may vary.", "role": "footnote"}
                            ],
                        },
                    ],
                }
            ],
        },
        {"provider": "mock"},
    )
    claim = result["ocr"]["semanticFacts"]["metricClaims"][0]

    assert "Unrelated launch copy" not in claim["sourceText"]
    for context in ("Hydration improvement", "+50%", "After 4 weeks", "Individual results may vary"):
        assert context in claim["sourceText"]


@pytest.mark.asyncio
async def test_layout_metric_source_text_matches_value_and_unit_without_numeric_prefix_siblings() -> None:
    """A +5% claim must not inherit the distinct +50% chart line at the same timepoint."""

    result = await extract_image_ocr_evidence(
        {
            "productName": "Barrier Serum",
            "extraCandidates": [
                {
                    "imageUrl": IMAGE,
                    "text": "Hydration improvement. +50%. +5%. After 4 weeks.",
                    "groups": [
                        {
                            "id": "metric",
                            "title": "Hydration improvement",
                            "lines": [
                                {"text": "+50%", "role": "value", "pairedLabel": "After 4 weeks"},
                                {"text": "+5%", "role": "value", "pairedLabel": "After 4 weeks"},
                            ],
                        }
                    ],
                }
            ],
        },
        {"provider": "mock"},
    )
    claim = next(item for item in result["ocr"]["semanticFacts"]["metricClaims"] if item["value"] == "+5")

    assert "+5%" in claim["sourceText"]
    assert "+50%" not in claim["sourceText"]


@pytest.mark.asyncio
async def test_layout_metric_source_text_keeps_same_value_at_its_own_timepoint() -> None:
    """Same-valued measurements may not inherit a sibling claim's timing line."""

    request: dict[str, Any] = {
        "productName": "Barrier Serum",
        "extraCandidates": [
            {
                "imageUrl": IMAGE,
                "text": "Hydration improvement. +5% after 2 weeks. +5% after 4 weeks.",
                "groups": [
                    {
                        "id": "metric",
                        "title": "Hydration improvement",
                        "lines": [
                            {"text": "+5%", "role": "value", "pairedLabel": "After 2 weeks"},
                            {"text": "+5%", "role": "value", "pairedLabel": "After 4 weeks"},
                        ],
                    }
                ],
            }
        ],
    }
    result = await extract_image_ocr_evidence(request, {"provider": "mock"})
    claims = cast(list[dict[str, Any]], result["ocr"]["semanticFacts"]["metricClaims"])
    after_four_weeks = next(claim for claim in claims if claim["timing"] == "After 4 weeks")

    assert "After 4 weeks: +5%" in after_four_weeks["sourceText"]
    assert "After 2 weeks: +5%" not in after_four_weeks["sourceText"]


@pytest.mark.asyncio
async def test_non_http_image_is_skipped_instead_of_being_sent_to_provider() -> None:
    result = await extract_image_ocr_evidence(
        {"source": "https://example.com/p/1", "imageUrls": ["data:image/png;base64,AAAA", IMAGE]}, {"provider": "mock"}
    )
    assert {warning["code"] for warning in result["diagnostics"]["warnings"]} >= {"IMAGE_OCR_TARGET_SKIPPED"}


@pytest.mark.asyncio
async def test_tall_image_uses_sliced_two_reading_provider_pipeline_before_publishing_text() -> None:
    stream = io.BytesIO()
    Image.new("RGB", (200, 2500), (255, 255, 255)).save(stream, format="PNG")
    calls: list[list[dict[str, str]]] = []

    class ProviderSpy:
        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            inputs = cast(list[dict[str, str]], request["imageInputs"])
            assert isinstance(inputs, list)
            calls.append(inputs)
            reread = len(calls) == 2
            return {
                "images": [
                    {
                        "imageUrl": item["displayUrl"],
                        "text": "Barrier verified hydration support" if reread else "Barrier invented hydration support",
                        "confidence": 0.9,
                    }
                    for item in inputs
                ]
            }

        async def classify_keywords(self, request: Mapping[str, Any]) -> dict[str, Any]:
            return {"keywords": [{"keyword": "hydration", "category": "benefit"}]}

    async def tall_fetcher(_: str) -> tuple[int, str, bytes]:
        return 200, "image/png", stream.getvalue()

    result = await extract_image_ocr_evidence(
        {"source": "https://example.test/p", "productName": "Barrier Cream", "imageUrls": [IMAGE]},
        {"provider": "openai", "provider_client": ProviderSpy(), "slicingFetcher": tall_fetcher},
    )

    assert len(calls) == 2
    assert all(item["inputUrl"].startswith("data:image/jpeg;base64,") for item in calls[0])
    assert all("#ocr-slice-" in item["displayUrl"] for item in calls[0])
    assert "invented" not in result["ocr"]["textBlocks"][0]
    assert "Barrier hydration support" in result["ocr"]["textBlocks"][0]
    assert result["diagnostics"]["ocr"]["targets"][0]["sliced"] is True

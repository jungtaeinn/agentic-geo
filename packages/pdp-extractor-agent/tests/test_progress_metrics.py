"""Focused extractor progress metadata and live-delivery contracts."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

from pdp_extractor_agent import service


@pytest.mark.asyncio
async def test_completed_extractor_steps_publish_locale_neutral_counts() -> None:
    """Counts come from the completed artifacts, not from translated messages."""

    run = await service.extract_product_from_api_payload(
        {
            "product": {
                "title": "Barrier Cream",
                "ocrTexts": ["Ceramide and panthenol support a comfortable moisture barrier."],
            },
            "reviews": {
                "items": [
                    {"body": "It absorbed quickly and kept my dry skin comfortable all day."},
                    {"body": "The texture layered well under sunscreen without pilling."},
                ]
            },
        },
        "https://example.test/products/barrier-cream",
        {
            "analysisPrompt": "Progress metadata policy",
            "ragDocuments": [{"name": "progress-policy.md", "content": "# Progress policy\nOCR review RAG evidence."}],
        },
    )

    steps = {step["id"]: step for step in run.diagnostics["process"]}

    assert steps["ocr"]["metrics"] == {"ocrImageCandidateCount": 1}
    assert steps["review"]["metrics"] == {"reviewItemCount": 2}
    assert steps["rag"]["metrics"] == {"ragChunkCount": 9}


@pytest.mark.asyncio
async def test_extractor_progress_is_delivered_before_the_next_phase_begins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A queued async callback must not wait for the end-of-run progress drain."""

    seen: list[tuple[str, str]] = []

    async def on_progress(step: Mapping[str, Any]) -> None:
        seen.append((str(step["id"]), str(step["status"])))

    async def normalizer(request: Mapping[str, Any], _runtime: Mapping[str, Any]) -> dict[str, Any]:
        assert ("extract", "running") in seen
        return {
            "product": dict(request["bootstrapProduct"]),
            "usage": None,
            "evidence": [],
            "warnings": [],
        }

    monkeypatch.setattr(service, "normalize_extractor_product_profile_with_agent", normalizer)

    await service.extract_product_from_html(
        "<main><h1>Barrier Cream</h1></main>",
        "https://example.test/products/barrier-cream",
        {"onProgress": on_progress},
    )

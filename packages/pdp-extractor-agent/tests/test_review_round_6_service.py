"""Exceptional sixth-round public service regressions from Sol acceptance review."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

import httpx
import pytest

from pdp_extractor_agent.service import extract_product_from_html


@pytest.mark.asyncio
async def test_service_reconciles_provider_rows_before_appending_data_ocr_fallback() -> None:
    """A commerce OCR provider row cannot swallow a separately valid DOM fallback."""

    image = "https://cdn.example.com/detail.png"
    shared = "This panel continues with guidance."
    fallback_text = f"{shared}\nBenefits\nCeramide hydration supports the skin barrier."

    class ProviderSpy:
        def __init__(self) -> None:
            self.classification: Mapping[str, Any] | None = None

        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "images": [
                    {
                        "imageUrl": request["imageUrls"][0],
                        "text": f"Cart checkout shipping returns refund\n{shared}",
                    }
                ]
            }

        async def classify_keywords(self, request: Mapping[str, Any]) -> dict[str, Any]:
            self.classification = request
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    run = await extract_product_from_html(
        f'<main><h1>Barrier Serum</h1><img src="{image}" alt="Barrier Serum clinical detail" data-ocr-text="{fallback_text}" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": provider,
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    assert provider.classification is not None
    assert provider.classification["imageTexts"] == [
        {
            "imageUrl": image,
            "imageUrls": [image],
            "text": fallback_text,
            "sourceOrder": 0,
        }
    ]
    combination = run.diagnostics["ocr"]["combination"]
    assert combination["candidatesIn"] == combination["candidatesOut"] == 1
    assert combination["overlapJoins"] == 0


@pytest.mark.asyncio
async def test_service_consumes_empty_high_priority_client_alias_before_next_record() -> None:
    """An empty known alias advances records instead of exposing a lower sibling alias."""

    state = {
        "products": [
            {
                "productHandle": "barrier-serum",
                "onlineProdName": "",
                "productName": "Wrong Lower Priority Serum",
                "linePromoDesc": "",
                "description": "Wrong lower-priority serum description supports hydration and skin comfort.",
            },
            {
                "productHandle": "barrier-serum",
                "onlineProdName": "Preferred Barrier Serum",
                "linePromoDesc": "Preferred product copy supports daily skin hydration and resilient barrier comfort.",
            },
        ]
    }

    run = await extract_product_from_html(
        '<script type="application/json">' + json.dumps(state) + "</script><main></main>",
        "https://brand.example.com/products/barrier-serum",
    )

    product = run.result["geoProduct"]
    assert product["name"] == "Preferred Barrier Serum"
    assert product["description"] == "Preferred product copy supports daily skin hydration and resilient barrier comfort."


@pytest.mark.asyncio
async def test_service_uses_attached_ocr_keywords_for_ocr_content_section_category() -> None:
    """A classified OCR keyword supplies the category when title/text alone are neutral."""

    image = "https://cdn.example.com/neutral-panel.png"
    text = "A soothing serum veil for daily skin hydration."

    class Provider:
        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            return {"images": [{"imageUrl": request["imageUrls"][0], "text": text}]}

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "keywords": [{"keyword": "soothing", "category": "benefit", "confidence": 0.91}],
                "sentenceInsights": [],
                "semanticFacts": {},
            }

    run = await extract_product_from_html(
        f'<main><h1>Barrier Serum</h1><img src="{image}" alt="Barrier Serum clinical detail" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": Provider(),
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    section = next(
        item for item in run.result["geoProduct"]["contentAnalysis"]["sections"] if item["title"] == "OCR image 1"
    )
    assert section["category"] == "benefit"


@pytest.mark.asyncio
async def test_service_public_ocr_insight_defaults_missing_provider_keywords_to_empty_list() -> None:
    """Public sentence-insight schema requires ``keywords`` even when the provider omits it."""

    image = "https://cdn.example.com/benefit-panel.png"
    text = "Ceramide supports hydration and barrier resilience."

    class Provider:
        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            return {"images": [{"imageUrl": request["imageUrls"][0], "text": text}]}

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "keywords": [],
                "sentenceInsights": [{"text": text, "category": "benefit", "evidenceIndex": 1}],
                "semanticFacts": {},
            }

    run = await extract_product_from_html(
        f'<main><h1>Barrier Serum</h1><img src="{image}" alt="Barrier Serum clinical detail" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": Provider(),
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    insight = next(
        item
        for item in run.result["geoProduct"]["sourceExtraction"]["ocr"]["sentenceInsights"]
        if item["text"] == text and item["category"] == "benefit"
    )
    assert insight["keywords"] == []

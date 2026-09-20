"""Terminal round-five service regressions from the retained TypeScript runtime."""

from __future__ import annotations

import io
import json
from collections.abc import Mapping
from typing import Any

import httpx
import pytest
from PIL import Image

from pdp_extractor_agent.service import extract_product_from_html


@pytest.mark.asyncio
async def test_service_joins_provider_slices_before_the_product_evidence_gate() -> None:
    """A later use instruction survives only after its tall-image slices are joined."""

    stream = io.BytesIO()
    Image.new("RGB", (200, 2100), (255, 255, 255)).save(stream, format="PNG")
    image = "https://cdn.example.com/tall-formula.png"
    overlap = "The barrier architecture remains intact across the surface."
    use_instruction = "Dispense an appropriate amount onto wet hands and lather."

    class ProviderSpy:
        def __init__(self) -> None:
            self.classification: Mapping[str, Any] | None = None

        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            rows: list[dict[str, Any]] = []
            for image_url in request["imageUrls"]:
                rows.append(
                    {
                        "imageUrl": image_url,
                        "text": f"FORMULA\n{overlap}"
                        if "#ocr-slice-1of2" in image_url
                        else f"{overlap}\n{use_instruction}",
                    }
                )
            return {"images": rows}

        async def classify_keywords(self, request: Mapping[str, Any]) -> dict[str, Any]:
            self.classification = request
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    async def tall_fetcher(_: str) -> tuple[int, str, bytes]:
        return 200, "image/png", stream.getvalue()

    provider = ProviderSpy()
    run = await extract_product_from_html(
        f'<main><h1>Barrier Serum</h1><img src="{image}" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": provider,
            "slicingFetcher": tall_fetcher,
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    assert provider.classification is not None
    assert [item["text"] for item in provider.classification["imageTexts"]] == [f"FORMULA\n{overlap}\n{use_instruction}"]
    assert run.result["geoProduct"]["sourceExtraction"]["ocr"]["textBlocks"] == [
        f"FORMULA\n{overlap}\n{use_instruction}"
    ]
    assert run.diagnostics["ocr"]["combination"]["overlapJoins"] == 1


@pytest.mark.asyncio
async def test_service_reconciles_commerce_provider_rows_before_filtering_and_caps_diagnostics() -> None:
    """Duplicate commerce OCR rows are absorbed before the public 20-row drop trace."""

    prefix = "Cart checkout shipping returns refund subscribe newsletter"
    texts = [
        f"{prefix} alpha",
        f"{prefix} alpha",
        f"{prefix} beta",
        f"{prefix} beta",
        *[f"{prefix} unique-{chr(97 + index)}z" for index in range(21)],
    ]

    class Provider:
        async def extract_image_text(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "images": [
                    {"imageUrl": f"https://cdn.example.com/commerce-{index}.png", "text": text}
                    for index, text in enumerate(texts)
                ]
            }

    run = await extract_product_from_html(
        '<main class="product-detail clinical"><h1>Barrier Serum</h1>'
        '<img src="https://cdn.example.com/detail.png" alt="Barrier Serum clinical detail" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": Provider(),
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    combination = run.diagnostics["ocr"]["combination"]
    assert combination["duplicatesAbsorbed"] == 2
    assert combination["candidatesIn"] == combination["candidatesOut"] == 0
    assert len(combination["droppedCandidates"]) == 20
    assert combination["droppedCandidates"][0]["textPreview"] == f"{prefix} alpha"


@pytest.mark.asyncio
async def test_client_state_skips_invalid_same_handle_name_and_description_records() -> None:
    """Predicates apply per record, rather than rejecting only after first-string selection."""

    state = {
        "products": [
            {
                "productHandle": "barrier-serum",
                "productName": "Cart checkout",
                "linePromoDesc": "Customer review rating five stars from a verified customer.",
            },
            {
                "productHandle": "barrier-serum",
                "productName": "Barrier Renewal Serum",
                "linePromoDesc": "A ceramide serum that supports resilient skin hydration every day.",
            },
        ]
    }

    run = await extract_product_from_html(
        '<script type="application/json">' + json.dumps(state) + "</script><main></main>",
        "https://brand.example.com/products/barrier-serum",
    )

    product = run.result["geoProduct"]
    assert product["name"] == "Barrier Renewal Serum"
    assert product["description"] == "A ceramide serum that supports resilient skin hydration every day."


@pytest.mark.asyncio
async def test_service_filters_dom_json_ld_and_client_option_values_with_the_same_gate() -> None:
    """Only supported option aliases publish; top-level client ``options`` is not an alias."""

    state = {
        "products": [
            {
                "productHandle": "barrier-serum",
                "productName": "Barrier Serum",
                "options": ["75 ml sibling fallback"],
                "optionName": "Choose an option",
                "optionValue": "Refill",
            }
        ]
    }
    html = (
        '<script type="application/ld+json">'
        '{"@type":"Product","name":"Barrier Serum","additionalProperty":["Choose an option","Refill"]}'
        "</script>"
        '<script type="application/json">'
        + json.dumps(state)
        + "</script>"
        '<main><select><option>Choose an option</option><option>50 ml</option><option>2</option><option>Refill</option></select></main>'
    )

    run = await extract_product_from_html(html, "https://brand.example.com/products/barrier-serum")

    assert run.result["geoProduct"]["options"] == ["50 ml", "Refill"]


@pytest.mark.asyncio
async def test_service_rejects_contextual_gif_raw_markup_before_provider_ocr() -> None:
    """The contextual pruned-DOM branch uses the same supported-image gate as TS."""

    image = "https://cdn.example.com/clinical-result.gif"

    class ProviderSpy:
        def __init__(self) -> None:
            self.requests: list[list[str]] = []

        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            self.requests.append([str(value) for value in request["imageUrls"]])
            return {"images": []}

    provider = ProviderSpy()
    await extract_product_from_html(
        f"<main class='product-detail clinical' data-image-payload='{{&quot;image&quot;:&quot;{image}&quot;}}'><h1>Barrier Serum</h1></main>",
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": provider,
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    assert provider.requests == []


@pytest.mark.asyncio
async def test_service_uses_supported_script_only_routine_builder_as_explicit_fallback() -> None:
    """A script-only fallback is URL-gated, not rejected by contextual commerce labels."""

    image = "https://cdn.example.com/routine-builder.png"

    class ProviderSpy:
        def __init__(self) -> None:
            self.requests: list[list[str]] = []

        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            self.requests.append([str(value) for value in request["imageUrls"]])
            return {"images": [{"imageUrl": image, "text": "Routine guide"}]}

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    await extract_product_from_html(
        '<script>window.__PDP__ = {"productHandle":"barrier-serum",'
        f'"image":"{image}"}};</script><main><h1>Barrier Serum</h1></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": provider,
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    assert provider.requests == [[image]]


@pytest.mark.asyncio
async def test_service_uses_formula_heading_for_empty_classifier_local_ingredient_fallback() -> None:
    """The shared OCR heading taxonomy governs local fallback as well as ingress."""

    text = "FORMULA\nFragrance free for sensitive complexions."

    class Provider:
        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    run = await extract_product_from_html(
        f'<main><h1>Barrier Serum</h1><img src="https://cdn.example.com/formula.png" data-ocr-text="{text}" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {"provider": "openai", "provider_client": Provider(), "transport": httpx.MockTransport(lambda _: httpx.Response(200))},
    )

    product = run.result["geoProduct"]
    assert text.split("\n", 1)[1] in product["ingredients"]
    assert any(
        item["text"] == text.split("\n", 1)[1] and item["category"] == "ingredient"
        for item in product["sourceExtraction"]["ocr"]["sentenceInsights"]
    )


@pytest.mark.asyncio
async def test_service_requires_explicit_rating_form_and_reads_meta_review_count_aliases() -> None:
    """A two-digit review count cannot be parsed as a one-digit star rating."""

    run = await extract_product_from_html(
        '<main><h1>Barrier Serum</h1><meta property="product:review_count" content="37" />'
        '<span class="rating">37 reviews</span></main>',
        "https://brand.example.com/products/barrier-serum",
    )

    assert run.result["geoProduct"]["reviews"] == {"reviewCount": 37, "items": [], "keywords": []}


@pytest.mark.asyncio
async def test_service_projects_public_ocr_insights_and_adds_ocr_content_sections() -> None:
    """Public OCR sentences omit internal attribution metadata but still populate content sections."""

    image = "https://cdn.example.com/benefit-panel.png"
    text = "Benefits: Ceramide supports hydration and barrier resilience."

    class Provider:
        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            return {"images": [{"imageUrl": request["imageUrls"][0], "text": text}]}

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "keywords": [],
                "sentenceInsights": [
                    {
                        "text": text,
                        "category": "benefit",
                        "keywords": ["Ceramide", "hydration"],
                        "semanticFacts": {"claim": "source-backed"},
                        "evidenceIndex": 1,
                        "confidence": 0.99,
                        "source": "provider",
                        "attribution": "declared",
                        "roleSource": "classifier",
                    }
                ],
                "semanticFacts": {},
            }

    run = await extract_product_from_html(
        f'<main><h1>Barrier Serum</h1><img src="{image}" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": Provider(),
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    insight = run.result["geoProduct"]["sourceExtraction"]["ocr"]["sentenceInsights"][0]
    assert set(insight) == {"imageUrl", "imageUrls", "text", "category", "keywords", "semanticFacts"}
    assert insight["semanticFacts"] == {"claim": "source-backed"}
    assert {
        "title": "OCR image 1",
        "category": "benefit",
        "text": text,
        "bullets": [text],
    } in run.result["geoProduct"]["contentAnalysis"]["sections"]

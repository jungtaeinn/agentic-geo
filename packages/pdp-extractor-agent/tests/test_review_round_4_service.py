"""Round-four service regressions from the retained TypeScript runtime."""

from __future__ import annotations

import io
import json
from collections.abc import Mapping
from typing import Any

import httpx
import pytest
from PIL import Image

from pdp_extractor_agent.service import extract_product_from_api_payload, extract_product_from_html


@pytest.mark.asyncio
async def test_service_filters_commerce_ocr_before_classifier_and_caps_public_candidates() -> None:
    """OCR ingress is product evidence only, and follows the TS 80-row budget."""

    commerce = "Cart checkout shipping returns refund subscribe newsletter"
    valid_texts = [f"Benefits&#10;Ceramide hydration supports the skin barrier result {index}." for index in range(100)]

    class ProviderSpy:
        def __init__(self) -> None:
            self.classification: Mapping[str, Any] | None = None

        async def classify_keywords(self, request: Mapping[str, Any]) -> dict[str, Any]:
            self.classification = request
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            # Provider rows reach the shared ingress directly; unlike a DOM
            # fallback, this proves the candidate is dropped *there* before
            # the classifier sees it.
            image_urls = [str(value) for value in request["imageUrls"]]
            return {
                "images": (
                    [{"imageUrl": image_urls[0], "text": commerce}]
                    if image_urls and image_urls[0].endswith("detail-0.png")
                    else []
                )
            }

    provider = ProviderSpy()
    html = "".join(
        ["<main><h1>Barrier Serum</h1>"]
        + [
            f'<img src="https://cdn.example.com/detail-{index}.png" data-ocr-text="{text}" />'
            for index, text in enumerate(valid_texts)
        ]
        + ["</main>"]
    )

    run = await extract_product_from_html(
        html,
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": provider,
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    assert provider.classification is not None
    classified_texts = [str(item["text"]) for item in provider.classification["imageTexts"]]
    public_ocr = run.result["geoProduct"]["sourceExtraction"]["ocr"]
    assert len(classified_texts) == len(public_ocr["imageTexts"]) == len(public_ocr["textBlocks"]) == 80
    assert commerce not in classified_texts and commerce not in public_ocr["textBlocks"]
    combination = run.diagnostics["ocr"]["combination"]
    assert combination["candidatesIn"] == 100 and combination["candidatesOut"] == 80
    assert combination["duplicatesAbsorbed"] == 0
    assert combination["droppedCandidates"] == [
        {
            "imageUrl": "https://cdn.example.com/detail-0.png",
            "reason": "Filtered out as non-product/commerce text before merging.",
            "textPreview": commerce,
        }
    ]


@pytest.mark.asyncio
async def test_service_keeps_declared_formula_ocr_section_before_classifier() -> None:
    """A retained TS section-role heading is product evidence without a keyword."""

    formula = "FORMULA\nFragrance free for sensitive complexions."

    class ProviderSpy:
        def __init__(self) -> None:
            self.classification: Mapping[str, Any] | None = None

        async def classify_keywords(self, request: Mapping[str, Any]) -> dict[str, Any]:
            self.classification = request
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    run = await extract_product_from_html(
        f'<main><h1>Barrier Serum</h1><img src="https://cdn.example.com/formula.png" data-ocr-text="{formula}" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {"provider": "openai", "provider_client": provider, "transport": httpx.MockTransport(lambda _: httpx.Response(200))},
    )

    assert provider.classification is not None
    assert [item["text"] for item in provider.classification["imageTexts"]] == [formula]
    assert run.diagnostics["ocr"]["combination"]["droppedCandidates"] == []


@pytest.mark.asyncio
async def test_service_records_actual_ocr_overlap_and_layout_slice_stitches() -> None:
    """Tall-image reconciliation reports joins instead of relabeling them as duplicates."""

    stream = io.BytesIO()
    Image.new("RGB", (200, 2100), (255, 255, 255)).save(stream, format="PNG")
    image = "https://cdn.example.com/tall-detail.png"
    overlap = "This distinctive clinical result line spans both tall image slices exactly"

    class ProviderSpy:
        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            rows: list[dict[str, Any]] = []
            for image_url in request["imageUrls"]:
                if "#ocr-slice-1of2" in image_url:
                    rows.append(
                        {
                            "imageUrl": image_url,
                            "text": f"BENEFITS\n{overlap}",
                            "groups": [
                                {
                                    "id": "benefits",
                                    "title": "BENEFITS",
                                    "lines": [
                                        {"text": "BENEFITS", "role": "title"},
                                        {"text": overlap, "role": "body"},
                                    ],
                                }
                            ],
                        }
                    )
                else:
                    rows.append(
                        {
                            "imageUrl": image_url,
                            "text": f"{overlap}\nHOW TO USE\nApply two pumps nightly after toner.",
                            "groups": [
                                {"id": "boundary", "lines": [{"text": overlap, "role": "body"}]},
                                {
                                    "id": "usage",
                                    "title": "HOW TO USE",
                                    "lines": [
                                        {"text": "HOW TO USE", "role": "title"},
                                        {"text": "Apply two pumps nightly after toner.", "role": "body"},
                                    ],
                                },
                            ],
                        }
                    )
            return {"images": rows}

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    async def tall_fetcher(_: str) -> tuple[int, str, bytes]:
        return 200, "image/png", stream.getvalue()

    run = await extract_product_from_html(
        f'<main><h1>Barrier Serum</h1><img src="{image}" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": ProviderSpy(),
            "slicingFetcher": tall_fetcher,
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    combination = run.diagnostics["ocr"]["combination"]
    assert combination["duplicatesAbsorbed"] == 0 and combination["overlapJoins"] == 1
    layout = run.diagnostics["ocr"]["layout"]
    assert layout["groupsReported"] == 2 and layout["groupsKept"] == 2 and layout["sliceStitches"] == 1


@pytest.mark.asyncio
async def test_service_unions_pruned_dom_raw_markup_ocr_urls_with_dom_targets() -> None:
    """A retained raw product URL must not be hidden behind the first 12 DOM images."""

    neutral = [f"https://cdn.example.com/detail-{index}.png" for index in range(12)]
    contextual = "https://cdn.example.com/clinical-results.png"

    class ProviderSpy:
        def __init__(self) -> None:
            self.vision_requests: list[list[str]] = []

        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            image_urls = [str(value) for value in request["imageUrls"]]
            self.vision_requests.append(image_urls)
            return {"images": [{"imageUrl": image_url, "text": "Barrier Serum clinical hydration result."} for image_url in image_urls]}

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    html = "".join(
        ["<main><h1>Barrier Serum</h1>"]
        + [f'<img src="{image}" alt="Barrier Serum detail" />' for image in neutral]
        + [
            '<div class="clinical-results" data-product-context="Barrier Serum clinical results" '
            f'data-image-payload="{{&quot;image&quot;:&quot;{contextual}&quot;}}"></div></main>'
        ]
    )

    await extract_product_from_html(
        html,
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": provider,
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    assert [image for batch in provider.vision_requests for image in batch] == [*neutral, contextual]


@pytest.mark.asyncio
async def test_client_state_aggregates_scoped_records_and_option_aliases() -> None:
    """One PDP can distribute field values across multiple same-handle client-state records."""

    state: dict[str, list[dict[str, Any]]] = {
        "products": [
            {"productHandle": "aggregate-barrier", "productName": "Aggregate Barrier Serum"},
            {
                "productHandle": "aggregate-barrier",
                "productName": "Aggregate Barrier Serum",
                "brandName": "Barrier Lab",
                "linePromoDesc": "A ceramide serum that supports resilient skin hydration every day.",
                "priceInfo": {"salePrice": "42.00"},
                "currencyInfo": {"isWon": True},
                "images": [{"src": "/media/aggregate-barrier.png"}],
                "optionName": "30 ml",
                "optionValue": "Refill set",
            },
        ]
    }
    html = '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(state) + "</script><main></main>"

    run = await extract_product_from_html(html, "https://brand.example.com/products/aggregate-barrier")
    product = run.result["geoProduct"]

    assert product["name"] == "Aggregate Barrier Serum"
    assert product["brand"] == "Barrier Lab"
    assert product["description"] == "A ceramide serum that supports resilient skin hydration every day."
    assert product["price"] == {"raw": "42.00", "amount": 42, "currency": "KRW"}
    assert product["images"] == ["https://brand.example.com/media/aggregate-barrier.png"]
    assert product["options"] == ["30 ml", "Refill set"]


@pytest.mark.asyncio
async def test_client_state_uses_all_records_for_missing_scoped_field_values() -> None:
    """A matched identity must not leak stale name/description, but may fill missing field values."""

    state = {
        "products": [
            {"productHandle": "target-serum", "productName": "Target Serum"},
            {
                "productHandle": "other-serum",
                "productName": "Stale Other Serum",
                "linePromoDesc": "Stale unrelated product description that must stay out of the target result.",
                "brandName": "Fallback Labs",
                "priceInfo": {"salePrice": "39"},
                "currency": "USD",
                "images": [{"src": "https://assets.example.com/fallback-serum.png"}],
                "optionName": "50 ml",
                "optionValue": "Refill Serum",
            },
        ]
    }
    html = '<script type="application/json">' + json.dumps(state) + "</script><main></main>"

    run = await extract_product_from_html(html, "https://brand.example.com/products/target-serum")
    product = run.result["geoProduct"]

    assert product["name"] == "Target Serum"
    assert "description" not in product
    assert product["brand"] == "Fallback Labs"
    assert product["price"] == {"raw": "39", "amount": 39, "currency": "USD"}
    assert product["images"] == ["https://assets.example.com/fallback-serum.png"]
    assert product["options"] == ["50 ml", "Refill Serum"]


@pytest.mark.asyncio
async def test_client_state_uses_all_record_images_when_scoped_images_are_unusable() -> None:
    """Fallback tests resolved URLs, not merely a non-empty raw image envelope."""

    state: dict[str, list[dict[str, Any]]] = {
        "products": [
            {
                "productHandle": "target-serum",
                "productName": "Target Serum",
                "images": [{}],
            },
            {
                "productHandle": "other-serum",
                "productName": "Other Serum",
                "imageUrl": "https://assets.example.com/fallback",
            },
        ]
    }
    html = '<script type="application/json">' + json.dumps(state) + "</script><main></main>"

    run = await extract_product_from_html(html, "https://brand.example.com/products/target-serum")

    assert run.result["geoProduct"]["images"] == ["https://assets.example.com/fallback"]


@pytest.mark.asyncio
async def test_client_state_option_aliases_reject_non_product_ui_and_catalog_values() -> None:
    """Client aliases use the retained TS product-option gate before publication."""

    state = {
        "products": [
            {
                "productHandle": "target-serum",
                "productName": "Target Serum",
                "optionName": "Choose an option",
                "optionValue": "$42.00",
                "products": [{"name": "Totally unrelated product catalog entry"}],
                "variants": [{"title": "Default Title"}],
            }
        ]
    }
    html = '<script type="application/json">' + json.dumps(state) + "</script><main></main>"

    run = await extract_product_from_html(html, "https://brand.example.com/products/target-serum")

    # The retained TS public artifact serializes an empty option array here;
    # the important boundary is that none of the UI/catalog aliases escapes.
    assert run.result["geoProduct"]["options"] == []


@pytest.mark.asyncio
async def test_client_state_brand_accepts_structured_brand_alias_values() -> None:
    """Structured client-state brand values follow the retained TS reader."""

    state = {
        "products": [
            {
                "productHandle": "target-serum",
                "productName": "Target Serum",
                "brand": {"name": "Nested Brand"},
            }
        ]
    }
    html = '<script type="application/json">' + json.dumps(state) + "</script><main></main>"

    run = await extract_product_from_html(html, "https://brand.example.com/products/target-serum")

    assert run.result["geoProduct"]["brand"] == "Nested Brand"


@pytest.mark.asyncio
async def test_service_surfaces_unmatched_slice_layout_diagnostics() -> None:
    """A non-overlapping tall-image boundary is public, even when no group survives."""

    stream = io.BytesIO()
    Image.new("RGB", (200, 2100), (255, 255, 255)).save(stream, format="PNG")
    image = "https://cdn.example.com/unmatched-tall-detail.png"

    class ProviderSpy:
        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            rows: list[dict[str, Any]] = []
            for image_url in request["imageUrls"]:
                if "#ocr-slice-1of2" in image_url:
                    rows.append(
                        {
                            "imageUrl": image_url,
                            "text": "BENEFITS\\nCeramide hydration supports the skin barrier.",
                            "groups": [
                                {
                                    "id": "benefits",
                                    "lines": [{"text": "BENEFITS", "role": "title"}],
                                }
                            ],
                        }
                    )
                else:
                    rows.append(
                        {
                            "imageUrl": image_url,
                            "text": "HOW TO USE\\nApply two pumps nightly after toner.",
                            "groups": [
                                {
                                    "id": "usage",
                                    "lines": [{"text": "HOW TO USE", "role": "title"}],
                                }
                            ],
                        }
                    )
            return {"images": rows}

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    async def tall_fetcher(_: str) -> tuple[int, str, bytes]:
        return 200, "image/png", stream.getvalue()

    run = await extract_product_from_html(
        f'<main><h1>Barrier Serum</h1><img src="{image}" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": ProviderSpy(),
            "slicingFetcher": tall_fetcher,
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    layout = run.diagnostics["ocr"]["layout"]
    assert layout["groupsReported"] == layout["groupsKept"] == 0
    assert layout["structureDiscarded"] == [{"imageUrl": image, "reason": "overlap-unmatched"}]
    assert layout["unmatchedBoundaries"][0]["imageUrl"] == image
    assert layout["unmatchedBoundaries"][0]["sliceIndex"] == 2


@pytest.mark.asyncio
async def test_api_unions_normalized_content_sections_with_source_sections() -> None:
    """A normalizer's new section augments, rather than replaces, source sections."""

    class Normalizer:
        async def normalize_product_profile(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "product": {
                    "contentSections": [
                        {
                            "title": "How to use",
                            "category": "usage",
                            "text": "Apply two pumps nightly after cleansing.",
                            "bullets": ["Apply two pumps nightly after cleansing."],
                        }
                    ]
                }
            }

    run = await extract_product_from_api_payload(
        {
            "product": {
                "name": "Barrier Serum",
                "description": "Apply two pumps nightly after cleansing.",
                "contentSections": [
                    {
                        "title": "Benefits",
                        "category": "benefit",
                        "text": "Ceramide supports hydration for the skin barrier.",
                    }
                ],
            }
        },
        "https://brand.example.com/products/barrier-serum",
        {"customProductNormalizer": Normalizer()},
    )

    sections = run.result["geoProduct"]["contentAnalysis"]["sections"]
    assert {section["title"] for section in sections} >= {"Benefits", "How to use"}


@pytest.mark.asyncio
async def test_api_preserves_category_distinct_normalized_content_sections() -> None:
    """Section identity is category plus normalized text, not a presentation title."""

    text = "Ceramide supports hydration and reinforces the skin barrier every day."

    class Normalizer:
        async def normalize_product_profile(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "product": {
                    "contentSections": [
                        {
                            "title": "Benefits",
                            "category": "effect",
                            "text": text,
                            "bullets": [text],
                        }
                    ]
                }
            }

    run = await extract_product_from_api_payload(
        {
            "product": {
                "name": "Barrier Serum",
                "contentSections": [
                    {
                        "title": "Benefits",
                        "category": "benefit",
                        "text": text,
                    }
                ],
            }
        },
        "https://brand.example.com/products/barrier-serum",
        {"customProductNormalizer": Normalizer()},
    )

    sections = run.result["geoProduct"]["contentAnalysis"]["sections"]
    assert {(section["category"], section["text"]) for section in sections} >= {
        ("benefit", text),
        ("effect", text),
    }


@pytest.mark.asyncio
async def test_dom_review_attributes_supply_count_and_aria_rating() -> None:
    """The retained DOM review count alias works independently of textual `reviews`."""

    run = await extract_product_from_html(
        '<main><h1>Barrier Serum</h1><div data-review-count="37">'
        '<span aria-label="4.7 out of 5 stars"></span></div></main>',
        "https://brand.example.com/products/barrier-serum",
    )

    assert run.result["geoProduct"]["reviews"] == {"rating": 4.7, "reviewCount": 37, "items": [], "keywords": []}


@pytest.mark.asyncio
async def test_dom_review_rating_aria_does_not_masquerade_as_a_review_count() -> None:
    """A rating's numerator is not a review-count number."""

    run = await extract_product_from_html(
        '<main><h1>Barrier Serum</h1><span aria-label="review rating 4.7 out of 5 stars"></span></main>',
        "https://brand.example.com/products/barrier-serum",
    )

    reviews = run.result["geoProduct"]["reviews"]
    assert reviews["rating"] == 4.7
    assert "reviewCount" not in reviews


@pytest.mark.asyncio
async def test_api_faq_accepts_schema_org_name_and_accepted_answer_aliases() -> None:
    """REST API FAQ records accept the same schema.org aliases as the TS reader."""

    run = await extract_product_from_api_payload(
        {
            "product": {
                "name": "Barrier Serum",
                "faq": {
                    "name": "When should I apply it?",
                    "acceptedAnswer": {"text": "Apply nightly after toner."},
                },
            }
        },
        "https://brand.example.com/products/barrier-serum",
    )

    assert run.result["geoProduct"]["faq"] == [
        {"question": "When should I apply it?", "answer": "Apply nightly after toner."}
    ]

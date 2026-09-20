"""Service-level regressions copied from the retained TypeScript extractor suite.

These intentionally exercise the public extraction entrypoint rather than the
lower-level OCR/client-state helpers: the review found that helpers were green
while the service discarded their output.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any

import httpx
import pytest

from pdp_extractor_agent.service import extract_product, extract_product_from_api_payload, extract_product_from_html


@pytest.mark.asyncio
async def test_retained_sections_object_fixture_populates_semantic_product_fields() -> None:
    """Port of the retained semantic-object section fixture."""

    run = await extract_product_from_html(
        json.dumps(
            {
                "product": {
                    "title": "Arcwell Night Renewal Serum",
                    "price": "215.00",
                    "sections": {
                        "BENEFITS": "Formulated with advanced capsule technology to improve plumpness, skin resilience, and fine lines. After 6 weeks, 100% of users showed improvement in elasticity and firmness.",
                        "INGREDIENTS": "MEADOW ROOT COMPLEX - strengthens the skin's rejuvenating abilities. INGREDIENTS: WATER / AQUA / EAU, GLYCERIN, NIACINAMIDE, CAMELLIA SINENSIS LEAF EXTRACT, RETINOL.",
                        "HOW TO USE": "Use morning and night after applying toner. Warm three pumps between fingers and apply to face and neck with upward motions.",
                    },
                }
            }
        ),
        "https://example.com/products/ginseng-serum",
    )
    product = run.result["geoProduct"]

    assert any("advanced capsule technology" in text for text in product["benefits"])
    assert any("CAMELLIA SINENSIS LEAF EXTRACT" in text for text in product["ingredients"])
    assert any("morning and night" in text for text in product["usage"])
    assert {"6 weeks", "100%"} <= set(product["metrics"])
    assert {"Benefits", "Ingredients", "How To Use"} <= {
        section["title"] for section in product["contentAnalysis"]["sections"]
    }


@pytest.mark.asyncio
async def test_retained_next_data_client_state_fixture_keeps_disclosures_images_and_reviews() -> None:
    """Port of the real __NEXT_DATA__ fixture in extract-product.test.ts."""

    initial_state = {
        "productDetail": {
            "productInfo": {
                "onlineProdName": "별모래 데일리 크림 예시 세트 50ml",
                "linePromoDesc": "별모래 테스트 랩의 가상 보습 라인을 소개하는 예시 세트입니다.",
                "detailDesc": '<div><img src="/detail-rich-cream.jpg" /></div>',
                "onlineImages": [{"imgUrl": "/rich-cream-01.jpg"}],
                "onlinePriceInfo": {
                    "currencyInfo": {"isWon": True},
                    "priceInfo": {"discountedPrice": 31000, "beforeSalePrice": 36000},
                },
                "products": [{"prodName": "별모래 데일리 크림 예시 세트"}],
                "disclosures": [
                    {
                        "disclosureItemName": "사용방법",
                        "prodDisclosureInfo": "아침, 저녁 적당량을 취해 얼굴 안쪽에서 바깥쪽으로 펴 발라 준 후 가볍게 눌러주며 흡수시켜 줍니다.",
                    },
                    {
                        "disclosureItemName": "｢화장품법｣에 따라 기재ㆍ표시하여야 하는 모든 성분",
                        "prodDisclosureInfo": "정제수, 글리세린, 스쿠알란, 판테놀, 알란토인, 소듐하이알루로네이트",
                    },
                ],
                "reviewInfo": {
                    "reviewScope": 4.4,
                    "reviewCount": 37,
                    "shortSummary": "보습 크림이 편안하게 흡수된다는 예시 후기입니다.",
                    "longSummary": "가벼운 보습감과 사용감에 대한 가상 예시 후기입니다.",
                },
            }
        }
    }
    html = f"""
      <html><head><script id="__NEXT_DATA__" type="application/json">
      {json.dumps({'props': {'pageProps': {'initialState': json.dumps(initial_state, ensure_ascii=False)}}}, ensure_ascii=False)}
      </script></head><body><main></main></body></html>
    """

    run = await extract_product_from_html(html, "https://example.com/products/rich-cream")
    product = run.result["geoProduct"]

    assert product["name"] == "별모래 데일리 크림 예시 세트 50ml"
    assert product["price"] == {"raw": "31000", "amount": 31000, "currency": "KRW"}
    assert {
        "https://example.com/rich-cream-01.jpg",
        "https://example.com/detail-rich-cream.jpg",
    } <= set(product["images"])
    assert any("알란토인" in text for text in product["ingredients"])
    assert any("아침, 저녁" in text for text in product["usage"])
    assert product["reviews"]["rating"] == 4.4
    assert product["reviews"]["reviewCount"] == 37
    assert any("가벼운 보습감" in item["body"] for item in product["customerReviewAnalysis"]["items"])
    assert any("알란토인" in section["text"] for section in product["contentAnalysis"]["sections"])
    assert any(item["field"] == "page.clientStateProductData" for item in run.diagnostics["evidence"])


@pytest.mark.asyncio
async def test_retained_numbered_korean_ocr_fixture_publishes_semantic_usage_steps() -> None:
    """Port of ocr-usage-sequence.test.ts through the service entrypoint."""

    merged_usage_blob = (
        "크림 Step 5 Waterfold 크림 미스트 BYEOLMORAE_TEST_LAB WATERFOLD CREAM MIST "
        "Moisture Blend 3,000 ppm Moisturizing & strengthening skin's moisture barrier For dry & weakened skin "
        "4.05 fl.oz / 120 mL 사용법 1 연약하고 건조해진 피부 부위에 미세 분사를 합니다. "
        "2 피부에 건조함이 느껴질 때 수시로 뿌려줍니다. BYEOLMORAE_TEST_LAB WATERFOLD CREAM MIST "
        "Moisture Blend 3,000 ppm Moisturizing & strengthening skin's moisture barrier For dry & weakened skin "
        "4.05 fl.oz / 120 mL 철저히 검증한 피부 안전성 테스트"
    )
    html = f"""
      <main><h1>Waterfold 크림 미스트</h1>
      <img src="https://image.example.com/upload/editor/detail.png" data-ocr-text="{merged_usage_blob}" />
      </main>
    """

    run = await extract_product_from_html(html, "https://catalog.example.test/kr/products/cloudveil-mist")
    product = run.result["geoProduct"]
    usage = product["usage"]

    first = next(index for index, text in enumerate(usage) if text.startswith("1. 연약하고 건조해진"))
    second = next(index for index, text in enumerate(usage) if text.startswith("2. 피부에 건조함"))
    assert second > first
    assert not any("CREAM MIST" in text for text in usage)
    assert any(text.startswith("1. 연약하고 건조해진") for text in product["semanticFacts"]["usageSteps"])
    assert any(text.startswith("2. 피부에 건조함") for text in product["sourceExtraction"]["ocr"]["semanticFacts"]["usageSteps"])


@pytest.mark.asyncio
async def test_ordinary_openai_service_path_calls_vision_and_semantic_provider_and_publishes_facts() -> None:
    """A normal provider config must use the core pipeline without injected clients."""

    requests: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append(body)
        if "instructions" in body:
            return httpx.Response(
                200,
                json={
                    "output_text": json.dumps(
                        {
                            "keywords": [{"keyword": "barrier", "category": "benefit", "confidence": 0.9}],
                            "sentenceInsights": [
                                {
                                    "text": "Strengthens the moisture barrier.",
                                    "category": "benefit",
                                    "keywords": ["barrier"],
                                    "evidenceIndex": 1,
                                }
                            ],
                            "semanticFacts": {
                                "ingredients": [],
                                "benefits": ["Strengthens the moisture barrier."],
                                "effects": [],
                                "skinTypes": [],
                                "usageSteps": [],
                                "metricClaims": [],
                                "evidenceSentences": ["Strengthens the moisture barrier."],
                                "ingredientBenefitLinks": [],
                                "citations": [],
                            },
                            "summary": "ok",
                        }
                    )
                },
            )
        return httpx.Response(
            200,
            json={
                "output_text": json.dumps(
                    {
                        "images": [
                            {
                                "index": 1,
                                "imageUrl": "https://cdn.example.com/detail.png",
                                "text": "Customer review notes",
                                "confidence": 0.9,
                                "groups": [],
                            }
                        ]
                    }
                )
            },
        )

    run = await extract_product_from_html(
        '<main><h1>Barrier Cream</h1><img src="https://cdn.example.com/detail.png" /></main>',
        "https://brand.example.com/products/barrier-cream",
        {"provider": "openai", "apiKey": "test-key", "model": "gpt-test", "transport": httpx.MockTransport(handler)},
    )
    product = run.result["geoProduct"]

    assert len(requests) == 2
    assert product["sourceExtraction"]["ocr"]["imageTexts"][0]["text"] == "Customer review notes"
    assert product["sourceExtraction"]["ocr"]["semanticFacts"]["benefits"] == [
        "Strengthens the moisture barrier."
    ]
    assert product["aiAnalysis"]["semanticFacts"]["benefits"] == ["Strengthens the moisture barrier."]
    assert product["semanticFacts"]["benefits"] == ["Strengthens the moisture barrier."]


@pytest.mark.asyncio
async def test_service_emits_live_progress_transitions_instead_of_final_snapshots() -> None:
    """Port createPipelineTracker's start/done callbacks from agent.ts."""

    seen: list[tuple[str, str]] = []

    def on_progress(step: Mapping[str, Any]) -> None:
        identifier, status = step.get("id"), step.get("status")
        if isinstance(identifier, str) and isinstance(status, str):
            seen.append((identifier, status))

    await extract_product_from_html(
        "<main><h1>Progress Cream</h1></main>",
        "https://example.com/products/progress-cream",
        {"onProgress": on_progress},
    )

    assert seen == [
        ("extract", "running"),
        ("extract", "done"),
        ("ocr", "running"),
        ("ocr", "done"),
        ("review", "running"),
        ("review", "done"),
        ("rag", "running"),
        ("rag", "done"),
        ("json", "running"),
        ("json", "done"),
    ]


@pytest.mark.asyncio
async def test_extract_product_wrapper_emits_input_and_fetch_live_transitions() -> None:
    seen: list[tuple[str, str]] = []

    def on_progress(step: Mapping[str, Any]) -> None:
        identifier, status = step.get("id"), step.get("status")
        if isinstance(identifier, str) and isinstance(status, str):
            seen.append((identifier, status))

    async def fetcher(_source: str, _headers: dict[str, str]) -> tuple[int, str, str]:
        assert ("fetch", "running") in seen
        return 200, "text/html", "<main><h1>Fetched Cream</h1></main>"

    await extract_product(
        {"source": "https://example.com/products/fetched-cream", "sourceType": "url"},
        {"fetcher": fetcher, "onProgress": on_progress},
    )
    assert seen == [
        ("input", "running"),
        ("input", "done"),
        ("fetch", "running"),
        ("fetch", "done"),
        ("extract", "running"),
        ("extract", "done"),
        ("ocr", "running"),
        ("ocr", "done"),
        ("review", "running"),
        ("review", "done"),
        ("rag", "running"),
        ("rag", "done"),
        ("json", "running"),
        ("json", "done"),
    ]


@pytest.mark.asyncio
async def test_api_payload_classifies_text_without_vision_ocr_of_product_images() -> None:
    """Port the API-only OCR contract from agent.ts:493-705."""

    class ProviderSpy:
        def __init__(self) -> None:
            self.vision_requests: list[dict[str, Any]] = []
            self.classify_requests: list[dict[str, Any]] = []

        async def extract_image_text(self, request: dict[str, Any]) -> dict[str, Any]:
            self.vision_requests.append(request)
            return {"images": []}

        async def classify_keywords(self, request: dict[str, Any]) -> dict[str, Any]:
            self.classify_requests.append(request)
            return {
                "keywords": [{"keyword": "barrier", "category": "benefit", "confidence": 0.9}],
                "sentenceInsights": [
                    {
                        "text": "Supports the moisture barrier.",
                        "category": "benefit",
                        "keywords": ["barrier"],
                        "evidenceIndex": 1,
                    }
                ],
                "semanticFacts": {
                    "ingredients": [],
                    "benefits": ["Supports the moisture barrier."],
                    "effects": [],
                    "skinTypes": [],
                    "usageSteps": [],
                    "metricClaims": [],
                    "evidenceSentences": ["Supports the moisture barrier."],
                    "ingredientBenefitLinks": [],
                    "citations": [],
                },
            }

    provider = ProviderSpy()
    run = await extract_product_from_api_payload(
        {
            "product": {
                "title": "API Barrier Cream",
                "images": [{"src": "https://cdn.example.com/product.png"}],
                "ocrTexts": ["Visible supplied OCR text"],
                "description": "Barrier-supporting cream for dry skin.",
                "summary": "A lightweight daily barrier moisturizer.",
                "ingredientHighlights": ["Ceramide complex"],
                "sections": {"HOW TO USE": "Apply morning and night."},
            }
        },
        "https://api.example.com/products/barrier-cream",
        {"provider": "openai", "provider_client": provider},
    )
    product = run.result["geoProduct"]

    assert provider.vision_requests == []
    assert len(provider.classify_requests) == 1
    candidate_urls = [item["imageUrl"] for item in provider.classify_requests[0]["imageTexts"]]
    assert candidate_urls[0] == "https://cdn.example.com/product.png"
    assert any(re.search(r"#api-text-\d+-\d+$", url) for url in candidate_urls)
    # The retained TS path preserves semantic API copy as locally attributed
    # OCR evidence, but it does not turn an unclassified visible-text label
    # into a benefit merely because it was supplied in ``ocrTexts``.
    assert product["semanticFacts"]["benefits"] == [
        "Supports the moisture barrier.",
        "Barrier-supporting cream for dry skin.",
        "A lightweight daily barrier moisturizer.",
    ]
    assert "Visible supplied OCR text" not in product["semanticFacts"]["benefits"]
    assert not any(warning["code"].startswith("IMAGE_OCR_") for warning in run.diagnostics["warnings"])


@pytest.mark.asyncio
async def test_api_text_candidates_keep_ts_chunk_lineage_and_all_public_aliases() -> None:
    """``createApiTextCandidates`` uses #api-text-{field}-{chunk}, never vision media."""

    class ProviderSpy:
        def __init__(self) -> None:
            self.vision_requests: list[dict[str, Any]] = []
            self.classify_requests: list[dict[str, Any]] = []

        async def extract_image_text(self, request: dict[str, Any]) -> dict[str, Any]:
            self.vision_requests.append(request)
            return {"images": []}

        async def classify_keywords(self, request: dict[str, Any]) -> dict[str, Any]:
            self.classify_requests.append(request)
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    await extract_product_from_api_payload(
        {
            "product": {
                "title": "API Candidate Cream",
                "images": [{"src": "https://cdn.example.com/product.png"}],
                "description": "A deliberately long description with barrier support and source-backed daily hydration benefits.",
                "bodyHtml": "<p>A separately supplied detailed body text with enough readable product evidence.</p>",
                "summary": ["A summary field with enough source-backed product detail for classification."],
                "highlights": ["A highlight field with enough source-backed product detail for classification."],
                "ingredients": ["Ceramide and niacinamide complex with enough descriptive source evidence."],
                "keyIngredients": ["Panax ginseng root extract with enough descriptive source evidence."],
                "ingredientHighlights": ["Retinol derivative with enough descriptive source evidence for classification."],
                "directions": "Apply a generous layer morning and night after toner as the final skincare step.",
                "sections": {"BENEFITS": "Visible moisture-barrier support with enough descriptive source evidence."},
            }
        },
        "https://api.example.com/products/candidate-cream",
        {"provider": "openai", "provider_client": provider},
    )

    assert provider.vision_requests == []
    candidates = provider.classify_requests[0]["imageTexts"]
    assert candidates and all("#api-text-" in item["imageUrl"] for item in candidates)
    assert all(re.search(r"#api-text-\d+-\d+$", item["imageUrl"]) for item in candidates)
    text = " ".join(item["text"] for item in candidates)
    for phrase in ("summary field", "highlight field", "Panax ginseng", "Retinol derivative", "Apply a generous", "Visible moisture"):
        assert phrase in text


@pytest.mark.asyncio
async def test_html_target_discovery_prefers_dom_detail_media_over_raw_script_images_and_cards() -> None:
    class ProviderSpy:
        def __init__(self) -> None:
            self.requests: list[dict[str, Any]] = []

        async def extract_image_text(self, request: dict[str, Any]) -> dict[str, Any]:
            self.requests.append(request)
            return {"images": []}

        async def classify_keywords(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    await extract_product_from_html(
        """
        <main><h1>Image Discovery Cream</h1>
          <img class="product-card" src="/card.png" />
          <img class="product-detail" data-src="/detail lazy.png" />
          <picture><source data-srcset="/detail-wide.webp 1x, /detail-wide@2x.webp 2x" /></picture>
          <img class="review-image" src="/review.png" />
          <script>window.productData = {detailImage: "\\/script detail.jpg"};</script>
        </main>
        """,
        "https://brand.example/products/image-discovery-cream",
        {"provider": "openai", "provider_client": provider, "transport": httpx.MockTransport(lambda _: httpx.Response(200))},
    )
    sent = [url for request in provider.requests for url in request["imageUrls"]]

    assert any("detail%20lazy.png" in url for url in sent)
    assert any("detail-wide" in url for url in sent)
    # The TS service removes scripts before OCR target collection; raw script
    # URLs remain source media only when no contextual DOM target exists.
    assert not any("script%20detail.jpg" in url for url in sent)
    assert not any("card.png" in url or "review.png" in url for url in sent)


@pytest.mark.asyncio
async def test_html_target_discovery_rejects_detail_media_inside_related_product_containers() -> None:
    """The TS contextual gate excludes commerce ancestors, not only image classes."""

    class ProviderSpy:
        def __init__(self) -> None:
            self.requests: list[dict[str, Any]] = []

        async def extract_image_text(self, request: dict[str, Any]) -> dict[str, Any]:
            self.requests.append(request)
            return {"images": []}

        async def classify_keywords(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    await extract_product_from_html(
        """
        <main><h1>Barrier Serum</h1>
          <section class="product-detail"><img src="/detail-clinical.png" /></section>
          <aside class="related-products">
            <img src="/clinical-chart.png" />
          </aside>
        </main>
        """,
        "https://brand.example/products/barrier-serum",
        {"provider": "openai", "provider_client": provider},
    )

    sent = [url for request in provider.requests for url in request["imageUrls"]]
    assert "https://brand.example/detail-clinical.png" in sent
    assert "https://brand.example/clinical-chart.png" not in sent


@pytest.mark.asyncio
async def test_dom_only_oracle_fallback_extracts_price_description_and_full_review_metadata() -> None:
    """Port the DOM-only fixture assertions in extract-product.test.ts:1229."""

    run = await extract_product_from_html(
        """
        <main><h1>Bright Repair Ampoule</h1><p class="price">$58.00</p>
          <p class="description">A concentrated daily repair ampoule for a brighter, smoother-looking complexion.</p>
          <section><h2>Benefits</h2><ul><li>Improves visible dullness and supports brighter-looking skin.</li></ul></section>
          <section><h2>Ingredients</h2><p>INGREDIENTS: WATER, GLYCERIN, NIACINAMIDE, VITAMIN C.</p></section>
          <section><h2>How to use</h2><ol><li>Apply 2-3 drops after toner.</li><li>Use morning and night.</li></ol></section>
          <section class="reviews"><div class="rating-summary" aria-label="4.6 out of 5 stars">4.6</div><span class="review-count">128 reviews</span>
          <article class="review-card"><span class="stars" aria-label="5 stars"></span><p class="review-text">My skin looked brighter and smoother after a week. The texture absorbs quickly.</p><span class="author">Mina</span><time datetime="2026-05-01">May 1, 2026</time></article>
          </section>
        </main>
        """,
        "https://example.com/products/bright-ampoule",
    )
    product = run.result["geoProduct"]

    assert product["price"]["raw"] == "$58.00"
    assert product["description"].startswith("A concentrated daily repair ampoule")
    assert product["reviews"]["rating"] == 4.6
    assert product["reviews"]["reviewCount"] == 128
    assert product["reviews"]["items"][0]["rating"] == 5
    assert product["reviews"]["items"][0]["author"] == "Mina"
    assert product["reviews"]["items"][0]["datePublished"] == "2026-05-01"


@pytest.mark.asyncio
async def test_dom_fallback_drops_header_navigation_and_footer_copy_before_selecting_description() -> None:
    """TS page-chrome removal prevents readable non-product copy becoming a PDP description."""

    run = await extract_product_from_html(
        """
        <header><p class="description">Welcome to our journal, events, editorial stories, and brand community updates for every visitor.</p></header>
        <nav><p>Browse collections, campaigns, rewards, and account links.</p></nav>
        <main><h1>Barrier Serum</h1><p class="description">A concentrated barrier serum with ceramides that supports daily hydration and smoother-looking skin.</p></main>
        <footer><p>Our newsletter, company information, and social channels are available below.</p></footer>
        """,
        "https://brand.example.com/products/barrier-serum",
    )

    assert run.result["geoProduct"]["description"] == (
        "A concentrated barrier serum with ceramides that supports daily hydration and smoother-looking skin."
    )


@pytest.mark.asyncio
async def test_retained_shopify_theme_product_update_fixture_is_handle_scoped() -> None:
    """Port extract-product.test.ts embedded theme product metadata fixture."""

    run = await extract_product_from_html(
        """
        <main><h1>Arcwell Night Renewal Serum</h1></main>
        <script>
          theme.products.update({
            id: 111,
            title: "Arcwell Renewal Cream",
            handle: "arcwell-renewal-cream",
            benefits: "Cream-only 24-hour hydration benefit should not be selected.",
            ingredients: "CREAM INGREDIENTS: WATER, GLYCERIN"
          });
          theme.products.update({
            id: 8084091011117,
            title: "Arcwell Night Renewal Serum",
            handle: "arcwell-night-renewal-serum",
            benefits: "Formulated with our advanced capsule technology, enriched with Meadow Root Complex and Retinol. After 6 weeks of use 100% of users showed improvement in Fine Lines & Wrinkles, Elasticity, and Firmness.",
            ingredients: "MEADOW ROOT COMPLEX. INGREDIENTS: WATER / AQUA / EAU, GLYCERIN, NIACINAMIDE, CAMELLIA SINENSIS LEAF EXTRACT, RETINOL.",
            howToUse: "<p>Apply two pumps morning and night after cleansing and toning, then follow with moisturizer.</p>"
          });
        </script>
        """,
        "https://catalog.example.test/products/arcwell-night-renewal-serum",
    )
    product = run.result["geoProduct"]
    all_text = " ".join([*product["benefits"], *product["ingredients"], *product["usage"], *product["ocr"]["textBlocks"]])

    assert "advanced capsule technology" in all_text
    assert "CAMELLIA SINENSIS LEAF EXTRACT" in all_text
    assert "Apply two pumps" in all_text
    assert "Cream-only 24-hour hydration" not in all_text
    assert any(item["field"] == "page.embeddedProductSections" for item in run.diagnostics["evidence"])


@pytest.mark.asyncio
async def test_theme_list_and_swym_embedded_products_are_handle_scoped_without_product_noun_keys() -> None:
    """Theme forms use title/image/description keys but remain product records after handle gating."""

    class ProviderSpy:
        def __init__(self) -> None:
            self.vision_requests: list[dict[str, Any]] = []

        async def extract_image_text(self, request: dict[str, Any]) -> dict[str, Any]:
            self.vision_requests.append(request)
            return {"images": []}

        async def classify_keywords(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    run = await extract_product_from_html(
        """
        <main><h1>Target Serum</h1></main>
        <script>
          theme.products.list[0] = {
            handle: "stale-cream",
            title: "Stale Cream",
            imageUrl: "/stale.jpg",
            description: "A stale product record that must not enter this PDP."
          };
          theme.products.list[1] = {
            handle: "target-serum",
            title: "Target Serum",
            imageUrl: "/target.jpg",
            description: "A target serum description with enough source-backed product detail."
          };
          window.SwymProductInfo.product = {
            handle: "target-serum",
            title: "Target Serum",
            directions: "Swym target serum usage detail with enough source-backed evidence."
          };
        </script>
        """,
        "https://shop.example/products/target-serum",
        {"provider": "openai", "provider_client": provider, "transport": httpx.MockTransport(lambda _: httpx.Response(200))},
    )
    product = run.result["geoProduct"]

    assert product["name"] == "Target Serum"
    assert "https://shop.example/target.jpg" in product["images"]
    assert product["description"] == "A target serum description with enough source-backed product detail."
    assert any("Swym target serum" in section["text"] for section in product["contentAnalysis"]["sections"])
    assert any("target.jpg" in image for request in provider.vision_requests for image in request["imageUrls"])
    assert all("stale.jpg" not in image for request in provider.vision_requests for image in request["imageUrls"])


@pytest.mark.asyncio
async def test_vision_ocr_merges_data_ocr_fallback_instead_of_replacing_it() -> None:
    """The real service keeps deterministic PDP text when vision also succeeds."""

    class ProviderSpy:
        async def extract_image_text(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {
                "images": [
                    {
                        "imageUrl": "https://cdn.example.com/detail.png",
                        "text": "Vision transcription says skin hydration support.",
                        "confidence": 0.91,
                    }
                ]
            }

        async def classify_keywords(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    run = await extract_product_from_html(
        """
        <main><h1>Barrier Cream</h1>
        <img src="https://cdn.example.com/detail.png"
             data-ocr-text="Apply two pumps after toner every morning and night." />
        </main>
        """,
        "https://brand.example.com/products/barrier-cream",
        {"provider": "openai", "provider_client": ProviderSpy()},
    )

    image_texts = run.result["geoProduct"]["sourceExtraction"]["ocr"]["imageTexts"]
    assert {item["text"] for item in image_texts} >= {
            "Vision transcription says skin hydration support.",
        "Apply two pumps after toner every morning and night.",
    }


@pytest.mark.asyncio
async def test_vision_reading_precedes_data_ocr_fallback_for_provider_evidence_indexes() -> None:
    """TS classifies provider vision output before deterministic fallback rows."""

    class ProviderSpy:
        def __init__(self) -> None:
            self.classification: dict[str, Any] | None = None

        async def extract_image_text(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {"images": [{"imageUrl": "https://cdn.example.com/detail.png", "text": "Vision skin hydration text."}]}

        async def classify_keywords(self, request: dict[str, Any]) -> dict[str, Any]:
            self.classification = request
            return {
                "keywords": [],
                "sentenceInsights": [
                    {"text": "Vision skin hydration text.", "category": "benefit", "keywords": [], "evidenceIndex": 1}
                ],
                "semanticFacts": {},
            }

    provider = ProviderSpy()
    run = await extract_product_from_html(
            '<main><h1>Barrier Cream</h1><img src="https://cdn.example.com/detail.png" data-ocr-text="Fallback skin hydration text."></main>',
        "https://brand.example.com/products/barrier-cream",
        {"provider": "openai", "provider_client": provider},
    )

    assert provider.classification is not None
    assert [item["text"] for item in provider.classification["imageTexts"]][:2] == [
        "Vision skin hydration text.",
        "Fallback skin hydration text.",
    ]
    assert run.result["geoProduct"]["sourceExtraction"]["ocr"]["sentenceInsights"][0]["imageUrls"] == [
        "https://cdn.example.com/detail.png"
    ]


@pytest.mark.asyncio
async def test_service_publishes_declared_ocr_relations_and_semantic_image_lineage() -> None:
    """Provider evidenceIndex values resolve to public image URLs and diagnostics."""

    class ProviderSpy:
        async def extract_image_text(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {
                "images": [
                    {
                        "imageUrl": "https://cdn.example.com/claim.png",
                        "text": "After four weeks, firmness improved by 84% with ginseng.",
                        "confidence": 0.88,
                    }
                ]
            }

        async def classify_keywords(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {
                "keywords": [{"keyword": "firmness", "category": "metric", "confidence": 0.88}],
                "sentenceInsights": [
                    {
                        "text": "After four weeks, firmness improved by 84% with ginseng.",
                        "category": "metric",
                        "keywords": ["firmness"],
                        "evidenceIndex": 1,
                        "confidence": 0.88,
                        "source": "llm",
                    }
                ],
                "semanticFacts": {
                    "ingredients": [],
                    "benefits": [],
                    "effects": [],
                    "skinTypes": [],
                    "usageSteps": [],
                    "metricClaims": [
                        {
                            "sentence": "After four weeks, firmness improved by 84% with ginseng.",
                            "sourceText": "After four weeks, firmness improved by 84% with ginseng.",
                            "evidenceIndex": 1,
                        }
                    ],
                    "evidenceSentences": [],
                    "ingredientBenefitLinks": [
                        {"sentence": "Ginseng supports firmness.", "evidenceIndex": 1}
                    ],
                    "citations": [{"finding": "Firmness result", "evidenceIndex": 1}],
                },
            }

    run = await extract_product_from_html(
        '<main><h1>Firming Cream</h1><img src="https://cdn.example.com/claim.png" /></main>',
        "https://brand.example.com/products/firming-cream",
        {"provider": "openai", "provider_client": ProviderSpy()},
    )
    ocr = run.result["geoProduct"]["sourceExtraction"]["ocr"]
    facts = ocr["semanticFacts"]
    insight = ocr["sentenceInsights"][0]

    assert insight["imageUrls"] == ["https://cdn.example.com/claim.png"]
    # Sentence attribution/confidence stays in diagnostics; TS exposes only
    # the stable public sentence-evidence projection here.
    assert set(insight) == {"imageUrl", "imageUrls", "text", "category", "keywords"}
    assert facts["metricClaims"][0]["imageUrls"] == ["https://cdn.example.com/claim.png"]
    assert facts["ingredientBenefitLinks"][0]["imageUrls"] == ["https://cdn.example.com/claim.png"]
    assert facts["citations"][0]["imageUrls"] == ["https://cdn.example.com/claim.png"]
    relations = run.diagnostics["ocr"]["relations"]
    assert relations["attributionCounts"]["declared"] == 1
    assert relations["semanticFactLinks"] == {
        "metricClaims": {"total": 1, "withImage": 1},
        "ingredientBenefitLinks": {"total": 1, "withImage": 1},
        "citations": {"total": 1, "withImage": 1},
    }


@pytest.mark.asyncio
async def test_service_preserves_all_provider_safety_tests_in_source_extraction() -> None:
    """Source-backed provider safety facts survive the public OCR contract."""

    safety_tests = [f"Dermatologist tested for sensitive skin ({index})." for index in range(1, 14)]
    source_text = "; ".join(safety_tests)

    class Provider:
        async def classify_keywords(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {
                "keywords": [],
                "sentenceInsights": [],
                "semanticFacts": {"safetyTests": safety_tests},
            }

    run = await extract_product_from_html(
        (
            '<main class="product-detail clinical"><h1>Source-backed Product</h1>'
            f'<img src="https://cdn.example.com/safety.png" data-ocr-text="{source_text}" /></main>'
        ),
        "https://brand.example.com/products/source-backed-product",
        {"provider": "openai", "provider_client": Provider()},
    )

    assert run.result["geoProduct"]["sourceExtraction"]["ocr"]["semanticFacts"]["safetyTests"] == safety_tests


@pytest.mark.asyncio
async def test_service_forwards_rag_runtime_steps_into_callback_and_usage_metadata() -> None:
    """Both service RAG retrieval sites keep the runtime retrieval trace observable."""

    runtime_steps: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "data": [{"index": index, "embedding": [1.0, 0.0]} for index, _ in enumerate(payload["input"])],
                "usage": {"prompt_tokens": 7, "total_tokens": 7},
            },
        )

    run = await extract_product_from_html(
        "<main><h1>RAG Barrier Cream</h1><p>Barrier support for dry skin.</p></main>",
        "https://brand.example.com/products/rag-barrier-cream",
        {
            "ragDocuments": [{"name": "policy.md", "content": "Barrier evidence policy and classification."}],
            "embedding": {
                "provider": "azure-openai",
                "apiKey": "key",
                "endpoint": "https://azure.example",
                "deployment": "embed",
                "transport": httpx.MockTransport(handler),
            },
            "onRuntimeStep": runtime_steps.append,
        },
    )

    assert any(step["stage"] == "embedding" and step["tokenUsage"]["totalTokens"] == 7 for step in runtime_steps)
    usage_steps = run.diagnostics["runtimeUsage"]["steps"]
    assert any(step["stage"] == "embedding" and step["called"] for step in usage_steps)


@pytest.mark.asyncio
async def test_service_forwards_runtime_steps_for_ocr_policy_retrieval_and_final_rag() -> None:
    """OCR policy retrieval and final chunk retrieval share the public trace."""

    runtime_steps: list[dict[str, Any]] = []

    class SemanticClient:
        async def classify_keywords(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "data": [{"index": index, "embedding": [1.0, 0.0]} for index, _ in enumerate(payload["input"])],
                "usage": {"prompt_tokens": 3, "total_tokens": 3},
            },
        )

    run = await extract_product_from_html(
        '<main><h1>OCR Policy Cream</h1><img src="https://cdn.example.com/detail.png" data-ocr-text="Skin hydration support with enough source evidence for semantic classification." /></main>',
        "https://brand.example.com/products/ocr-policy-cream",
        {
            "provider": "mock",
            "provider_client": SemanticClient(),
            "ragDocuments": [{"name": "policy.md", "content": "Barrier OCR evidence policy."}],
            "embedding": {
                "provider": "azure-openai",
                "apiKey": "key",
                "endpoint": "https://azure.example",
                "deployment": "embed",
                "transport": httpx.MockTransport(handler),
            },
            "onRuntimeStep": runtime_steps.append,
        },
    )

    embedding_steps = [step for step in runtime_steps if step["stage"] == "embedding"]
    assert len(embedding_steps) >= 2
    assert all(step["tokenUsage"]["totalTokens"] == 3 for step in embedding_steps)
    # Public runtime usage coalesces same-label calls, while the callback stays
    # event-level so consumers can observe both OCR-policy and final retrieval.
    usage_embedding = next(step for step in run.diagnostics["runtimeUsage"]["steps"] if step["stage"] == "embedding")
    assert usage_embedding["tokenUsage"]["totalTokens"] == 6


@pytest.mark.asyncio
async def test_ocr_target_selection_prioritizes_late_high_value_detail_media_over_low_value_gallery_rows() -> None:
    """Port the TS score-before-cap target selection rule through the service."""

    class ProviderSpy:
        def __init__(self) -> None:
            self.requests: list[dict[str, Any]] = []

        async def extract_image_text(self, request: dict[str, Any]) -> dict[str, Any]:
            self.requests.append(request)
            return {"images": []}

        async def classify_keywords(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    low_value_images = "".join(
        f'<img src="https://cdn.example.com/gallery-{index}.jpg" />' for index in range(1, 25)
    )
    await extract_product_from_html(
        (
            "<main><h1>Barrier Serum</h1>"
            f"{low_value_images}"
            '<img src="https://cdn.example.com/clinical-detail-result.jpg" />'
            "</main>"
        ),
        "https://brand.example.com/products/barrier-serum",
        {"provider": "openai", "provider_client": provider},
    )

    sent = [url for request in provider.requests for url in request["imageUrls"]]
    assert "https://cdn.example.com/clinical-detail-result.jpg" in sent
    assert len(sent) <= 24


@pytest.mark.asyncio
async def test_ocr_target_selection_keeps_the_largest_responsive_image_variant() -> None:
    """The OCR request uses the canonical largest ``srcset`` family member."""

    class ProviderSpy:
        def __init__(self) -> None:
            self.requests: list[dict[str, Any]] = []

        async def extract_image_text(self, request: dict[str, Any]) -> dict[str, Any]:
            self.requests.append(request)
            return {"images": []}

        async def classify_keywords(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    await extract_product_from_html(
        """
        <main><h1>Responsive Barrier Serum</h1>
          <picture><source srcset="/product-detail.jpg?width=400 400w, /product-detail.jpg?width=1200 1200w" /></picture>
        </main>
        """,
        "https://brand.example.com/products/responsive-barrier-serum",
        {"provider": "openai", "provider_client": provider},
    )

    sent = [url for request in provider.requests for url in request["imageUrls"]]
    assert "https://brand.example.com/product-detail.jpg?width=1200" in sent
    assert "https://brand.example.com/product-detail.jpg?width=400" not in sent


@pytest.mark.asyncio
async def test_ocr_target_selection_caps_explicit_fallback_after_rejected_dom_media() -> None:
    """Rejected DOM media cannot raise a broad script fallback above twelve."""

    class ProviderSpy:
        def __init__(self) -> None:
            self.requests: list[dict[str, Any]] = []

        async def extract_image_text(self, request: dict[str, Any]) -> dict[str, Any]:
            self.requests.append(request)
            return {"images": []}

        async def classify_keywords(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    script_values = ",".join(f'"/product-detail-{index}.jpg"' for index in range(1, 14))
    await extract_product_from_html(
        (
            '<main><h1>Script Only Serum</h1><img class="product-card" src="/card.jpg" /></main>'
            f"<script>window.productImages = [{script_values}]</script>"
        ),
        "https://brand.example.com/products/script-only-serum",
        {"provider": "openai", "provider_client": provider},
    )

    sent = [url for request in provider.requests for url in request["imageUrls"]]
    assert len(sent) == 12


@pytest.mark.asyncio
async def test_ocr_target_selection_resolves_dot_relative_raw_script_images() -> None:
    """The retained raw-state scanner accepts ``../`` PDP image references."""

    class ProviderSpy:
        def __init__(self) -> None:
            self.requests: list[dict[str, Any]] = []

        async def extract_image_text(self, request: dict[str, Any]) -> dict[str, Any]:
            self.requests.append(request)
            return {"images": []}

        async def classify_keywords(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    await extract_product_from_html(
        '<main><h1>Relative Image Serum</h1></main><script>window.product = {detail: "../assets/clinical-detail.png"}</script>',
        "https://brand.example.com/products/relative-image-serum",
        {"provider": "openai", "provider_client": provider},
    )

    sent = [url for request in provider.requests for url in request["imageUrls"]]
    assert sent == ["https://brand.example.com/assets/clinical-detail.png"]

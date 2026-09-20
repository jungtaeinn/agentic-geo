"""Round-three service differentials copied from retained TypeScript fixtures."""

from __future__ import annotations

import io
import json
from collections.abc import Mapping
from typing import Any

import httpx
import pytest
from PIL import Image

from pdp_extractor_agent.ocr.layout import IMAGE_OCR_JSON_SCHEMA
from pdp_extractor_agent.service import extract_product_from_api_payload, extract_product_from_html

SUMMARY_IMAGE = "https://assets.example.com/upload/editor/foam-summary.png"
CHART_IMAGE = "https://assets.example.com/upload/editor/foam-chart.png"
SUMMARY_TEXT = "\n".join(
    (
        "효능",
        "1",
        "약산성 아미노산 유래 세정 성분으로",
        "장벽 손상 방어",
        "2",
        "가벼운 메이크업 세정력",
        "핵심 성분",
        "Barrier Protective Formula",
        "(판테놀, 베타인, 보습 컴포트 블렌드)",
    )
)
SUMMARY_GROUPS: list[dict[str, Any]] = [
    {"id": "g1", "title": "효능", "lines": [{"text": "효능", "role": "title"}]},
    {
        "id": "g2",
        "parentId": "g1",
        "ordinal": 1,
        "lines": [
            {"text": "1", "role": "label"},
            {"text": "약산성 아미노산 유래 세정 성분으로", "role": "body"},
            {"text": "장벽 손상 방어", "role": "body"},
        ],
    },
    {
        "id": "g3",
        "parentId": "g1",
        "ordinal": 2,
        "lines": [
            {"text": "2", "role": "label"},
            {"text": "가벼운 메이크업 세정력", "role": "body"},
        ],
    },
    {
        "id": "g4",
        "title": "핵심 성분",
        "lines": [
            {"text": "핵심 성분", "role": "title"},
            {"text": "Barrier Protective Formula", "role": "body"},
            {"text": "(판테놀, 베타인, 보습 컴포트 블렌드)", "role": "body"},
        ],
    },
]
CHART_TEXT = "\n".join(
    (
        "피부 각질층 내 세라마이드 함량 분석",
        "+42.0%",
        "+58.0%",
        "자사 알칼리 폼",
        "별모래 테스트 랩 클렌징폼",
        "사용 후",
        "사용 2주 후",
        "※In vitro 시험 결과",
    )
)
CHART_GROUPS: list[dict[str, Any]] = [
    {
        "id": "g1",
        "title": "피부 각질층 내 세라마이드 함량 분석",
        "lines": [{"text": "피부 각질층 내 세라마이드 함량 분석", "role": "title"}],
    },
    {
        "id": "g2",
        "parentId": "g1",
        "lines": [
            {"text": "+42.0%", "role": "value", "pairedLabel": "사용 후"},
            {"text": "+58.0%", "role": "value", "pairedLabel": "사용 2주 후"},
            {"text": "자사 알칼리 폼", "role": "label"},
            {"text": "별모래 테스트 랩 클렌징폼", "role": "label"},
            {"text": "사용 후", "role": "label"},
            {"text": "사용 2주 후", "role": "label"},
        ],
    },
    {
        "id": "g3",
        "parentId": "g1",
        "annotates": "g2",
        "lines": [{"text": "※In vitro 시험 결과", "role": "footnote"}],
    },
]


@pytest.mark.asyncio
async def test_retained_layout_fixture_survives_actual_service_with_empty_classifier() -> None:
    """Port ocr-layout-pipeline: layout remains meaningful without model facts."""

    class ProviderSpy:
        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "images": [
                    {
                        "imageUrl": image_url,
                        "text": CHART_TEXT if image_url == CHART_IMAGE else SUMMARY_TEXT,
                        "confidence": 0.98,
                        "groups": CHART_GROUPS if image_url == CHART_IMAGE else SUMMARY_GROUPS,
                    }
                    for image_url in request["imageUrls"]
                ]
            }

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}, "summary": "no classification"}

    run = await extract_product_from_html(
        (
            f'<main><h1>별모래 테스트 랩 Waterfold 클렌징폼</h1><img src="{SUMMARY_IMAGE}" />'
            f'<img src="{CHART_IMAGE}" /></main>'
        ),
        "https://catalog.example.test/kr/products/waterfold-gentle-cleanser",
        {
            "provider": "openai",
            "provider_client": ProviderSpy(),
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    product = run.result["geoProduct"]
    assert any("판테놀" in value and "보습 컴포트 블렌드" in value for value in product["ingredients"])
    assert "약산성 아미노산 유래 세정 성분으로 장벽 손상 방어" in product["benefits"]
    assert "가벼운 메이크업 세정력" in product["benefits"]
    assert any(
        insight["category"] == "ingredient" and "판테놀" in insight["text"]
        for insight in product["sourceExtraction"]["ocr"]["sentenceInsights"]
    )
    for facts in (
        product["sourceExtraction"]["ocr"]["semanticFacts"],
        product["aiAnalysis"]["semanticFacts"],
        product["semanticFacts"],
    ):
        assert any("판테놀" in value for value in facts["ingredients"])
        assert len(facts["metricClaims"]) == 2
        assert {claim["value"] for claim in facts["metricClaims"]} == {"+42.0", "+58.0"}
        assert all("metric" in claim and "timing" in claim for claim in facts["metricClaims"])
        assert all("sentence" not in claim for claim in facts["metricClaims"])
    assert not any(
        insight["text"] in {"+42.0%", "+58.0%"}
        for insight in product["sourceExtraction"]["ocr"]["sentenceInsights"]
    )
    assert run.diagnostics["ocr"]["layout"]["groupsKept"] == 7


@pytest.mark.asyncio
async def test_tall_service_ocr_preserves_slice_layout_metadata_and_minimum_confidence() -> None:
    """The classifier receives the TS-merged tall-image candidate, not reduced rows."""

    stream = io.BytesIO()
    Image.new("RGB", (200, 2100), (255, 255, 255)).save(stream, format="PNG")

    class ProviderSpy:
        def __init__(self) -> None:
            self.classification: Mapping[str, Any] | None = None

        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            rows: list[dict[str, Any]] = []
            for image_url in request["imageUrls"]:
                if "#ocr-slice-1of2" in image_url:
                    rows.append(
                        {
                            "imageUrl": image_url,
                                "text": "BENEFITS\nBarrier support visibly improves hydration after two weeks",
                            "confidence": 0.91,
                            "groups": [
                                {
                                    "id": "g1",
                                    "title": "Benefits",
                                    "lines": [
                                        {"text": "BENEFITS", "role": "title"},
                                        {"text": "Barrier support visibly improves hydration after two weeks", "role": "body"},
                                    ],
                                }
                            ],
                        }
                    )
                else:
                    rows.append(
                        {
                            "imageUrl": image_url,
                                "text": "Barrier support visibly improves hydration after two weeks\nHOW TO USE\nApply after toner",
                            "confidence": 0.42,
                            "groups": [
                                {
                                    "id": "g1",
                                    "title": "How to Use",
                                    "lines": [
                                        {"text": "Barrier support visibly improves hydration after two weeks", "role": "body"},
                                        {"text": "HOW TO USE", "role": "title"},
                                        {"text": "Apply after toner", "role": "body"},
                                    ],
                                }
                            ],
                        }
                    )
            return {"images": rows}

        async def classify_keywords(self, request: Mapping[str, Any]) -> dict[str, Any]:
            self.classification = request
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    async def tall_fetcher(_: str) -> tuple[int, str, bytes]:
        return 200, "image/png", stream.getvalue()

    provider = ProviderSpy()
    await extract_product_from_html(
        '<main><h1>Barrier Cream</h1><img src="https://cdn.example.com/tall-detail.png" /></main>',
        "https://brand.example.com/products/barrier-cream",
        {
            "provider": "openai",
            "provider_client": provider,
            "slicingFetcher": tall_fetcher,
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    assert provider.classification is not None
    candidate = provider.classification["imageTexts"][0]
    assert candidate["imageUrl"] == "https://cdn.example.com/tall-detail.png"
    assert candidate["imageUrls"] == ["https://cdn.example.com/tall-detail.png"]
    assert candidate["sourceOrder"] == 0
    assert candidate["sliceCount"] == 2
    assert candidate["confidence"] == 0.42
    assert candidate["groups"]


@pytest.mark.asyncio
async def test_merged_service_ocr_keeps_all_image_attribution_for_declared_insights() -> None:
    """A merged vision/data candidate must not collapse its source image lineage."""

    first = "https://cdn.example.com/vision.png"
    second = "https://cdn.example.com/data.png"

    class ProviderSpy:
        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "images": [
                    {"imageUrl": image_url, "text": "Barrier support serum", "confidence": 0.8}
                    for image_url in request["imageUrls"]
                ]
            }

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "keywords": [],
                "sentenceInsights": [
                    {
                        "text": "Barrier support serum",
                        "category": "benefit",
                        "keywords": [],
                        "evidenceIndex": 1,
                    }
                ],
                "semanticFacts": {
                    "metricClaims": [],
                    "ingredientBenefitLinks": [
                        {"sentence": "Barrier support serum", "evidenceIndex": 1}
                    ],
                    "citations": [],
                },
            }

    run = await extract_product_from_html(
        f'<main><h1>Barrier Serum</h1><img src="{first}" /><img src="{second}" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": ProviderSpy(),
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    ocr = run.result["geoProduct"]["sourceExtraction"]["ocr"]
    assert ocr["imageTexts"] == [
        {
            "imageUrl": first,
            "imageUrls": [first, second],
            "text": "Barrier support serum",
            "confidence": 0.8,
        }
    ]
    assert ocr["sentenceInsights"][0]["imageUrl"] == first
    assert ocr["sentenceInsights"][0]["imageUrls"] == [first, second]
    assert ocr["semanticFacts"]["ingredientBenefitLinks"][0]["imageUrls"] == [first, second]
    assert run.diagnostics["ocr"]["relations"]["sentences"][0]["imageUrls"] == [first, second]


@pytest.mark.asyncio
async def test_heading_declared_local_ingredient_benefit_link_keeps_merged_image_urls() -> None:
    """Local OCR facts publish the same ingredient-benefit relation as TS."""

    first = "https://cdn.example.com/ingredient-a.png"
    second = "https://cdn.example.com/ingredient-b.png"
    text = "Ingredients\nCeramide supports skin barrier hydration"

    class ProviderSpy:
        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            return {"images": [{"imageUrl": image_url, "text": text} for image_url in request["imageUrls"]]}

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    run = await extract_product_from_html(
        f'<main><h1>Barrier Serum</h1><img src="{first}" /><img src="{second}" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": ProviderSpy(),
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    facts = run.result["geoProduct"]["sourceExtraction"]["ocr"]["semanticFacts"]
    assert facts["ingredients"] == ["Ceramide"]
    assert facts["ingredientBenefitLinks"] == [
        {
            "ingredient": "Ceramide",
            "benefit": "skin barrier hydration",
            "sentence": "Ceramide supports skin barrier hydration",
            "sourceText": "Ceramide supports skin barrier hydration",
            "imageUrls": [first, second],
        }
    ]


@pytest.mark.asyncio
async def test_service_assigns_first_seen_source_order_to_every_unsliced_ocr_candidate() -> None:
    """The semantic classifier receives the TS candidate order for normal image rows."""

    first = "https://cdn.example.com/clinical-result.png"
    second = "https://cdn.example.com/ingredient-panel.png"

    class ProviderSpy:
        def __init__(self) -> None:
            self.classification: Mapping[str, Any] | None = None

        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "images": [
                    {"imageUrl": first, "text": "Clinical skin result after two weeks", "confidence": 0.8},
                    {"imageUrl": second, "text": "Ceramide supports the skin barrier", "confidence": 0.7},
                ]
            }

        async def classify_keywords(self, request: Mapping[str, Any]) -> dict[str, Any]:
            self.classification = request
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    await extract_product_from_html(
        f'<main><h1>Barrier Serum</h1><img src="{first}" /><img src="{second}" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": provider,
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    assert provider.classification is not None
    assert [item["sourceOrder"] for item in provider.classification["imageTexts"]] == [0, 1]


@pytest.mark.asyncio
async def test_service_prefers_contextual_detail_media_over_json_ld_explicit_images() -> None:
    """TS sends contextual product-detail targets and ignores broad JSON-LD media."""

    explicit = "https://cdn.example.com/jsonld-clinical.png"
    detail = "https://cdn.example.com/product-detail-clinical.png"

    class ProviderSpy:
        def __init__(self) -> None:
            self.vision_requests: list[list[str]] = []

        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            self.vision_requests.append(list(request["imageUrls"]))
            return {"images": [{"imageUrl": detail, "text": "Clinical result after two weeks"}]}

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    await extract_product_from_html(
        (
            '<script type="application/ld+json">'
            f'{{"@type":"Product","name":"Barrier Serum","image":"{explicit}"}}'
            "</script>"
            f'<main class="product-detail clinical"><h1>Barrier Serum</h1><img src="{detail}" alt="Barrier Serum clinical result" /></main>'
        ),
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": provider,
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    assert provider.vision_requests == [[detail]]


@pytest.mark.asyncio
async def test_service_keeps_a_how_to_use_routine_detail_target() -> None:
    """A product routine is positive evidence; only routine-builder media is commerce noise."""

    routine = "https://cdn.example.com/routine-how-to-use.png"
    builder = "https://cdn.example.com/routine-builder-cross-sell.png"

    class ProviderSpy:
        def __init__(self) -> None:
            self.vision_requests: list[list[str]] = []

        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            self.vision_requests.append(list(request["imageUrls"]))
            return {"images": [{"imageUrl": routine, "text": "Apply after toner"}]}

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    await extract_product_from_html(
        (
            f'<main class="product-detail how-to-use"><h1>Barrier Serum</h1>'
            f'<img src="{routine}" alt="How to use Barrier Serum" />'
            f'<img src="{builder}" alt="routine builder Barrier Serum" />'
            "</main>"
        ),
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": provider,
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    assert provider.vision_requests == [[routine]]


@pytest.mark.asyncio
async def test_service_recovers_no_group_slice_sections_with_an_empty_classifier() -> None:
    """Unmatched tall-image boundaries retain newlines for deterministic section parsing."""

    stream = io.BytesIO()
    Image.new("RGB", (200, 2100), (255, 255, 255)).save(stream, format="PNG")
    image = "https://cdn.example.com/tall-no-groups.png"

    class ProviderSpy:
        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            rows: list[dict[str, Any]] = []
            for image_url in request["imageUrls"]:
                rows.append(
                    {
                        "imageUrl": image_url,
                        "text": (
                            "BENEFITS\nBarrier support improves hydration"
                            if "#ocr-slice-1of2" in image_url
                            else "HOW TO USE\nApply nightly after toner"
                        ),
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

    product = run.result["geoProduct"]
    assert "Barrier support improves hydration" in product["benefits"]
    assert "Apply nightly after toner" in product["usage"]
    local_insights = product["sourceExtraction"]["ocr"]["sentenceInsights"]
    assert {
        ("Barrier support improves hydration", "benefit"),
        ("Apply nightly after toner", "usage"),
    } <= {(item["text"], item["category"]) for item in local_insights}


@pytest.mark.asyncio
async def test_no_group_short_child_labels_retain_their_parent_section_role() -> None:
    """Title-shaped first children remain values under the preceding heading."""

    image = "https://cdn.example.com/short-child-labels.png"
    text = "\n".join(
        (
            "BENEFITS",
            "Visible Results",
            "Skin appears smoother and more hydrated after use.",
            "HOW TO USE",
            "Gentle Application",
            "Apply nightly after toner.",
        )
    )

    run = await extract_product_from_html(
        f'<main><h1>Barrier Cream</h1><img src="{image}" data-ocr-text="{text}" /></main>',
        "https://brand.example.com/products/barrier-cream",
    )

    product = run.result["geoProduct"]
    assert "Skin appears smoother and more hydrated after use." in product["benefits"]
    assert "Apply nightly after toner." in product["usage"]
    assert {
        ("Skin appears smoother and more hydrated after use.", "benefit"),
        ("Apply nightly after toner.", "usage"),
    } <= {
        (item["text"], item["category"])
        for item in product["sourceExtraction"]["ocr"]["sentenceInsights"]
    }


@pytest.mark.asyncio
async def test_no_group_numbered_usage_does_not_consume_the_next_section() -> None:
    """An unpunctuated final step cannot absorb a following benefit panel."""

    image = "https://cdn.example.com/numbered-usage-and-benefits.png"
    run = await extract_product_from_html(
        (
            f'<main><h1>Barrier Cream</h1><img src="{image}" data-ocr-text="'
            "HOW TO USE&#10;1&#10;Apply two pumps to clean skin&#10;2&#10;"
            "Massage until absorbed&#10;BENEFITS&#10;"
            'Visible hydration improves skin comfort." /></main>'
        ),
        "https://brand.example.com/products/barrier-cream",
    )

    product = run.result["geoProduct"]
    assert "Visible hydration improves skin comfort." in product["benefits"]
    assert not any("Visible hydration" in value for value in product["usage"])
    assert {"1. Apply two pumps to clean skin", "2. Massage until absorbed"} <= set(product["usage"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "source",
    (
        "Safety testing confirmed reduced skin irritation.",
        "피부 안전성 테스트에서 자극 완화 효과를 확인했습니다.",
        "CAUTION: Avoid use if irritation occurs.",
        "주의: 이상 반응이 있으면 사용을 중지하십시오.",
    ),
)
async def test_default_local_ocr_routes_safety_and_cautions_to_safety_tests(source: str) -> None:
    """Safety claims are source facts, not efficacy or application instructions."""

    run = await extract_product_from_html(
        f'<main><h1>Barrier Cream</h1><img src="https://cdn.example.com/safety.png" data-ocr-text="{source}" /></main>',
        "https://brand.example.com/products/barrier-cream",
    )

    product = run.result["geoProduct"]
    facts = product["sourceExtraction"]["ocr"]["semanticFacts"]
    assert facts["safetyTests"] == [source]
    assert source not in facts["benefits"]
    assert source not in facts["effects"]
    assert source not in facts["usageSteps"]
    assert source not in product["benefits"]
    assert source not in product["effects"]
    assert source not in product["usage"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("heading", "first", "second"),
    (
        ("CAUTION", "Avoid contact with eyes.", "Store in a cool, dry place."),
        ("주의사항", "눈에 들어가지 않도록 주의하십시오.", "서늘하고 건조한 곳에 보관하십시오."),
    ),
)
async def test_caution_heading_scopes_arbitrary_rows_and_replaces_a_combined_provider_fact(
    heading: str, first: str, second: str
) -> None:
    """A source caution heading owns every following source row, not just cue-bearing text."""

    text = f"{heading}\n{first}\n{second}"

    class ProviderSpy:
        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            return {"images": [{"imageUrl": image_url, "text": text} for image_url in request["imageUrls"]]}

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "keywords": [],
                "sentenceInsights": [],
                "semanticFacts": {"safetyTests": [f"{first}\n{second}"]},
            }

    run = await extract_product_from_html(
        '<main><h1>Barrier Serum</h1><img src="https://cdn.example.com/caution.png" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": ProviderSpy(),
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    facts = run.result["geoProduct"]["sourceExtraction"]["ocr"]["semanticFacts"]
    assert facts["safetyTests"] == [first, second]
    assert not facts["benefits"]
    assert not facts["effects"]
    assert not facts["usageSteps"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text",
    (
        "After use, apply generously to dry areas for hydration.",
        "사용 후 펌프하여 피부결을 부드럽게 합니다.",
    ),
)
async def test_after_use_instructions_keep_usage_role_not_measurement_role(text: str) -> None:
    """Strong application cues override a coincidental before/after marker."""

    image = "https://cdn.example.com/after-use-instruction.png"
    run = await extract_product_from_html(
        f'<main><h1>Barrier Cream</h1><img src="{image}" data-ocr-text="{text}" /></main>',
        "https://brand.example.com/products/barrier-cream",
    )

    product = run.result["geoProduct"]
    assert text in product["usage"]
    assert text not in product["effects"]


@pytest.mark.asyncio
async def test_no_group_temporal_axis_tick_cannot_declare_a_usage_section() -> None:
    """Port ``ocr-section-relations``: a chart tick is a boundary, not how-to."""

    image = "https://cdn.example.com/axis-tick.png"
    text = "\n".join(
        (
            "도포 4주 후",
            "각질층 수분량이 105% 개선되었습니다.",
            "사용법",
            "적당량을 손에 덜어 부드럽게 펴 바릅니다.",
        )
    )

    run = await extract_product_from_html(
        f'<main><h1>Barrier Cream</h1><img src="{image}" data-ocr-text="{text}" /></main>',
        "https://brand.example.com/products/barrier-cream",
    )

    usage = run.result["geoProduct"]["usage"]
    assert not any("105%" in value for value in usage)
    assert any("펴 바릅니다" in value for value in usage)


@pytest.mark.asyncio
async def test_no_group_effect_heading_does_not_publish_chart_ticks_or_pack_sizes() -> None:
    """An explicit Korean heading still rejects value-only chart/source rows."""

    image = "https://cdn.example.com/effect-chart.png"
    run = await extract_product_from_html(
        (
            f'<main><h1>Barrier Cream</h1><img src="{image}" '
            'data-ocr-text="효과&#10;+42.0%&#10;7.05 oz. / 200 g" /></main>'
        ),
        "https://brand.example.com/products/barrier-cream",
    )

    product = run.result["geoProduct"]
    assert not any("63.6" in value or "200 g" in value for value in product["effects"])
    assert not product["semanticFacts"]["metricClaims"]


@pytest.mark.asyncio
async def test_service_prefers_a_heading_declared_local_fact_over_an_overlapping_provider_fact() -> None:
    """A provider paraphrase cannot replace a source section's declared role."""

    image = "https://cdn.example.com/benefit-panel.png"
    local = "Barrier support visibly improves hydration after cleansing."

    class ProviderSpy:
        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            return {"images": [{"imageUrl": request["imageUrls"][0], "text": f"Benefits\n{local}"}]}

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "keywords": [],
                "sentenceInsights": [
                    {
                        "text": "Barrier support visibly improves hydration",
                        "category": "benefit",
                        "evidenceIndex": 1,
                    }
                ],
                "semanticFacts": {},
            }

    run = await extract_product_from_html(
        f'<main><h1>Barrier Serum</h1><img src="{image}" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": ProviderSpy(),
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    insights = run.result["geoProduct"]["sourceExtraction"]["ocr"]["sentenceInsights"]
    benefit_insights = [item for item in insights if item["category"] == "benefit"]
    assert benefit_insights == [
        {
            "text": local,
            "category": "benefit",
            # These remain deterministic source-derived signals when the
            # provider's overlapping paraphrase is suppressed.
            "keywords": ["hydration", "improve"],
            "imageUrl": image,
            "imageUrls": [image],
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(("classifier_fails", "expected_confidence"), [(False, 0.72), (True, 0.54)])
async def test_service_preserves_heuristic_ocr_keywords_and_candidate_confidence_when_classifier_is_empty_or_fails(
    classifier_fails: bool, expected_confidence: float
) -> None:
    """TS never turns a successful OCR reading into keyword-free evidence."""

    image = "https://cdn.example.com/ceramide-benefits.png"

    class ProviderSpy:
        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "images": [
                    {
                        "imageUrl": request["imageUrls"][0],
                        "text": "Benefits\nCeramide supports barrier hydration",
                    }
                ]
            }

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            if classifier_fails:
                raise RuntimeError("classifier unavailable")
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    run = await extract_product_from_html(
        f'<main><h1>Barrier Serum</h1><img src="{image}" /></main>',
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": ProviderSpy(),
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    ocr = run.result["geoProduct"]["sourceExtraction"]["ocr"]
    keyword_groups = run.result["geoProduct"]["ocr"]["keywords"]
    candidate = ocr["imageTexts"][0]
    insight = next(item for item in ocr["sentenceInsights"] if item["text"] == "Ceramide supports barrier hydration")
    assert any(keyword.casefold() == "ceramide" for keyword in keyword_groups["ingredient"])
    assert any(keyword.casefold() == "hydration" for keyword in keyword_groups["benefit"])
    assert candidate["confidence"] == expected_confidence
    assert {"Ceramide", "hydration"} <= set(insight["keywords"])


@pytest.mark.asyncio
async def test_service_sends_an_opaque_explicit_json_ld_image_when_no_contextual_media_exists() -> None:
    """The TS explicit fallback does not require a detail/score keyword."""

    image = "https://cdn.example.com/opaque.jpg"

    class ProviderSpy:
        def __init__(self) -> None:
            self.vision_requests: list[list[str]] = []

        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            self.vision_requests.append(list(request["imageUrls"]))
            return {"images": [{"imageUrl": image, "text": "Barrier Serum visible label"}]}

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    await extract_product_from_html(
        (
            '<script type="application/ld+json">'
            '{"@type":"Product","name":"Barrier Serum","image":"https://cdn.example.com/opaque.jpg"}'
            "</script>"
        ),
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": provider,
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    assert provider.vision_requests == [[image]]


@pytest.mark.asyncio
async def test_service_keeps_supported_routine_builder_in_explicit_only_fallback() -> None:
    """The TS explicit fallback is URL-based, unlike its contextual gate."""

    image = "https://cdn.example.com/routine-builder.png"

    class ProviderSpy:
        def __init__(self) -> None:
            self.vision_requests: list[list[str]] = []

        async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
            self.vision_requests.append(list(request["imageUrls"]))
            return {"images": [{"imageUrl": image, "text": "Routine guide"}]}

        async def classify_keywords(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {"keywords": [], "sentenceInsights": [], "semanticFacts": {}}

    provider = ProviderSpy()
    await extract_product_from_html(
        (
            '<script type="application/ld+json">'
            f'{{"@type":"Product","name":"Barrier Serum","image":"{image}"}}'
            "</script>"
        ),
        "https://brand.example.com/products/barrier-serum",
        {
            "provider": "openai",
            "provider_client": provider,
            "transport": httpx.MockTransport(lambda _: httpx.Response(200)),
        },
    )

    assert provider.vision_requests == [[image]]


@pytest.mark.asyncio
async def test_client_state_aliases_scope_name_description_and_images_to_source_handle() -> None:
    """A ``productHandle`` PDP must not inherit a sibling ``prodHandle`` record.

    This is the retained client-state source-selection behavior with alias-only
    handles: neither display name intentionally resembles ``target-product``,
    so matching can only be correct when the public handle aliases are read.
    """

    state = {
        "productDetail": {
            "stale": {
                "prodHandle": "other-product",
                "productName": "Other Serum",
                "linePromoDesc": "Other Serum has a deliberately stale description that must not leak.",
                # No extension keeps this assertion focused on scoped
                # client-state images: the separate retained raw-HTML image
                # scanner intentionally discovers supported file URLs from
                # every script.
                "images": [{"src": "/other-serum-asset"}],
            },
            "current": {
                "productHandle": "target-product",
                "productName": "Daily Renewal Serum",
                "linePromoDesc": "Daily Renewal Serum supports resilient skin hydration with a targeted formula.",
                "images": [{"src": "/target-serum-asset"}],
            },
        }
    }
    html = (
        '<script id="__NEXT_DATA__" type="application/json">'
        + json.dumps({"props": {"pageProps": {"initialState": json.dumps(state)}}})
        + "</script><main></main>"
    )

    run = await extract_product_from_html(html, "https://brand.example.com/products/target-product")
    product = run.result["geoProduct"]

    assert product["name"] == "Daily Renewal Serum"
    assert product["description"] == "Daily Renewal Serum supports resilient skin hydration with a targeted formula."
    assert product["images"] == ["https://brand.example.com/target-serum-asset"]
    assert "Other Serum" not in json.dumps(product)


@pytest.mark.asyncio
async def test_dom_metric_extraction_keeps_duration_after_phrase_and_ranged_drops() -> None:
    """The retained DOM metric matcher has overlapping duration/range forms."""

    run = await extract_product_from_html(
        (
            "<main><h1>Barrier Serum</h1><section><h2>Clinical Results</h2>"
            "<p>Visible results appear after 2 weeks. Apply 2-3 drops after toner every night.</p>"
            "</section></main>"
        ),
        "https://brand.example.com/products/barrier-serum",
    )

    assert {"2 weeks", "after 2 weeks", "2-3 drops"} <= set(run.result["geoProduct"]["metrics"])


@pytest.mark.asyncio
async def test_dom_review_regions_keep_explicit_data_and_typeof_cards_without_container_duplicates() -> None:
    """Port the retained selector and nested-card behavior from ``extractDomReviews``.

    A data-testid wrapper is a review region, not a review itself: only its
    explicit ``data-review`` and RDFa ``typeof=Review`` children publish
    bodies.  These selector forms occur in client-rendered PDP review widgets
    without the legacy ``.review`` class.
    """

    run = await extract_product_from_html(
        """
        <main><h1>Barrier Serum</h1>
          <section data-testid="customer-review-region">
            <article data-review data-rating="4.5 stars">
              <p class="comment">The formula calmed visible redness overnight and stayed comfortable all day.</p>
              <span data-author="">Mina</span><time datetime="2026-06-14">June 14</time>
            </article>
            <article typeof="Review">
              <p itemprop="reviewBody">It layered well under sunscreen and left my skin noticeably smoother.</p>
              <span class="user-name">Jae</span><span class="rating">5 stars</span><time datetime="2026-06-15">June 15</time>
            </article>
          </section>
        </main>
        """,
        "https://brand.example.com/products/barrier-serum",
    )

    reviews = run.result["geoProduct"]["reviews"]["items"]
    assert [item["body"] for item in reviews] == [
        "The formula calmed visible redness overnight and stayed comfortable all day.",
        "It layered well under sunscreen and left my skin noticeably smoother.",
    ]
    assert reviews[0] == {
        "body": "The formula calmed visible redness overnight and stayed comfortable all day.",
        "author": "Mina",
        "rating": 4.5,
        "datePublished": "2026-06-14",
    }
    assert reviews[1] == {
        "body": "It layered well under sunscreen and left my skin noticeably smoother.",
        "author": "Jae",
        "rating": 5,
        "datePublished": "2026-06-15",
    }


@pytest.mark.asyncio
async def test_api_image_object_aliases_keep_image_and_original_src_urls() -> None:
    """Port ``readImageUrls`` aliases used by production API image records."""

    run = await extract_product_from_api_payload(
        {
            "product": {
                "name": "Barrier Serum",
                "images": [
                    {
                        "image": "/media/Primary Shot.png",
                        "originalSrc": "https://cdn.example.com/media/Original Shot.png",
                    }
                ],
            }
        },
        "https://brand.example.com/products/barrier-serum",
    )

    assert run.result["geoProduct"]["images"] == [
        "https://brand.example.com/media/Primary%20Shot.png",
        "https://cdn.example.com/media/Original%20Shot.png",
    ]


@pytest.mark.asyncio
async def test_api_custom_normalizer_content_sections_reach_public_content_analysis() -> None:
    """Accepted normalizer sections are output data, not diagnostics-only metadata."""

    class Normalizer:
        async def normalize_product_profile(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "product": {
                    "contentSections": [
                        {
                            "title": "How to use",
                            "category": "usage",
                            "text": "Apply two pumps morning and night after toner.",
                            "bullets": ["Apply two pumps morning and night after toner."],
                        }
                    ]
                }
            }

    run = await extract_product_from_api_payload(
        {
            "product": {
                "name": "Barrier Serum",
                "description": "Apply two pumps morning and night after toner.",
            }
        },
        "https://brand.example.com/products/barrier-serum",
        {"customProductNormalizer": Normalizer()},
    )

    assert {
        "title": "How to use",
        "category": "usage",
        "text": "Apply two pumps morning and night after toner.",
        "bullets": ["Apply two pumps morning and night after toner."],
    } in run.result["geoProduct"]["contentAnalysis"]["sections"]
    step = next(
        item
        for item in run.diagnostics["runtimeUsage"]["steps"]
        if item["stage"] == "product-normalization" and item["label"] == "Product profile normalization/reasoning"
    )
    assert step["provider"] == "custom"
    assert step["called"] is True
    assert "tokenUsage" not in step


def test_ocr_schema_keeps_the_retained_groups_contract_verbatim() -> None:
    """The canonical schema is the TS provider payload, not a field sample."""

    groups = IMAGE_OCR_JSON_SCHEMA["properties"]["images"]["items"]["properties"]["groups"]
    assert groups["description"] == "Layout relations visible in the image: groups of lines. No template is assumed."

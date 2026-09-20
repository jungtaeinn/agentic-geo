"""Deterministic UI demo and mock-provider outputs.

The hosted extractor is optional in the static console. These values are the
retained TypeScript demo artifact, not assertions about a crawled source.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from ._json_types import as_list
from .models import ProductExtractionRun
from .rag.manifest import PRODUCT_EXTRACTOR_RAG_MANIFEST


def mock_keyword_classification(request: Mapping[str, Any]) -> dict[str, Any]:
    """Return a non-fabricating empty classifier response with stable keys."""

    return {
        "keywords": [],
        "sentenceInsights": [],
        "summary": "Mock provider returned no inferred claims.",
        "source": request.get("source"),
    }


def mock_image_ocr(request: Mapping[str, Any]) -> dict[str, Any]:
    """Return no OCR text rather than pretending unread images were read."""

    image_urls = request.get("imageUrls", [])
    urls: list[Any] = as_list(image_urls) or []
    return {"images": [], "rawText": "", "imageUrls": [str(url) for url in urls]}


async def run_mock_product_extraction(sources: Sequence[str]) -> list[ProductExtractionRun]:
    """Build one stable mock run for every UI source in source order."""

    return [create_mock_product_extraction(source, index) for index, source in enumerate(sources)]


def create_mock_product_extraction(source: str, index: int = 0) -> ProductExtractionRun:
    """Create the complete legacy mock payload used by the UI and Pages mode."""

    product_name = "Hydra Barrier Cream" if index % 2 == 0 else "Bright Tone Serum"
    benefit = "hydration" if index % 2 == 0 else "brightening"
    effect = "barrier care" if index % 2 == 0 else "tone improvement"
    source_base = _source_base(source)
    image_url = f"{source_base}/mock-product-{index + 1}.jpg"
    visual_text = f"{benefit} {effect} niacinamide daily use FAQ"
    generated_at = _iso_now()
    faq = [
        {
            "question": "Can this product be used every day?",
            "answer": "Yes. The page copy indicates daily morning and night usage.",
        },
        {
            "question": "Which customer concern does it address?",
            "answer": f"The extracted OCR and review keywords emphasize {benefit}.",
        },
    ]
    sections = [
        {
            "title": "Benefits",
            "category": "benefit",
            "text": f"{benefit} and {effect} are emphasized in the mock PDP copy.",
            "bullets": [benefit, effect],
        },
        {"title": "Ingredients", "category": "ingredient", "text": "niacinamide", "bullets": ["niacinamide"]},
    ]
    reviews = [
        {
            "body": "Absorbs quickly and leaves the skin feeling hydrated without heaviness.",
            "rating": 5,
            "datePublished": "2026-05-10",
        },
        {"body": "I liked the smooth finish and would repurchase.", "rating": 4, "datePublished": "2026-05-21"},
    ]
    review_keywords = ["quick absorption", "repurchase", benefit]
    keywords = {
        "product": [],
        "price": [],
        "benefit": [benefit],
        "effect": [effect],
        "ingredient": ["niacinamide"],
        "usage": ["daily use"],
        "faq": ["FAQ"],
        "review": [],
        "metric": [],
        "trend": [],
        "unknown": [],
    }
    sentence_insights = [
        {
            "imageUrl": image_url,
            "text": f"{benefit} and {effect} are emphasized with niacinamide in the mock PDP copy.",
            "category": "benefit",
            "keywords": [benefit, effect, "niacinamide"],
        }
    ]
    rating_summary = "Rating 4.7 · 1284 reviews"
    result: dict[str, Any] = {
        "source": source,
        "sourceType": "mock",
        "geoProduct": {
            "name": product_name,
            "price": {
                "raw": "32,000원" if index % 2 == 0 else "28,000원",
                "amount": 32000 if index % 2 == 0 else 28000,
                "currency": "KRW",
            },
            "description": f"{product_name} mock PDP extraction result generated from URL input.",
            "images": [image_url],
            "options": ["50ml", "100ml"],
            "benefits": [benefit, "soothing", "moisture"],
            "effects": [effect, "skin comfort"],
            "ingredients": ["niacinamide"],
            "usage": ["daily use"],
            "metrics": ["50ml", "100ml", "4.7 stars"],
            "faq": faq,
            "reviews": {"rating": 4.7, "reviewCount": 1284, "items": reviews, "keywords": review_keywords},
            "sourceExtraction": {
                "html": {
                    "description": f"{product_name} mock PDP extraction result generated from URL input.",
                    "sections": sections,
                    "faq": faq,
                },
                "ocr": {
                    "imageTexts": [{"imageUrl": image_url, "text": visual_text}],
                    "textBlocks": [visual_text],
                    "sentenceInsights": sentence_insights,
                },
            },
            "aiAnalysis": {
                "keywords": keywords,
                "categorizedSections": sections,
                "summary": "Mock product evidence was categorized into product fields.",
            },
            "categorizedProductInfo": {
                "benefits": [benefit, "soothing", "moisture"],
                "effects": [effect, "skin comfort"],
                "ingredients": ["niacinamide"],
                "usage": ["daily use"],
                "metrics": ["50ml", "100ml", "4.7 stars"],
                "faq": faq,
            },
            "customerReviewAnalysis": {
                "rating": 4.7,
                "reviewCount": 1284,
                "items": reviews,
                "keywords": review_keywords,
                "reviewSignals": review_keywords,
                "ratingSummary": rating_summary,
            },
            "contentAnalysis": {
                "sections": [
                    *sections,
                    {"title": "Customer rating", "category": "rating", "text": rating_summary, "bullets": [rating_summary]},
                ],
                "reviewSignals": review_keywords,
                "ratingSummary": rating_summary,
            },
            "ocr": {"textBlocks": [visual_text], "keywords": keywords, "sentenceInsights": sentence_insights},
            "rag": {
                "chunks": [
                    {"id": "product-1", "kind": "product", "text": f"{product_name}\n{benefit}\n{effect}"},
                    {"id": "review-1", "kind": "review", "text": reviews[0]["body"]},
                    {"id": "ocr-1", "kind": "ocr", "text": visual_text},
                ]
            },
        },
        "generatedAt": generated_at,
        "ragProfile": PRODUCT_EXTRACTOR_RAG_MANIFEST["profile"],
    }
    diagnostics: dict[str, Any] = {
        "source": source,
        "sourceType": "mock",
        "process": _mock_process_trace(source),
        "evidence": [
            {"field": "product.name", "source": "mock", "value": product_name},
            {"field": "product.benefits", "source": "mock", "value": benefit},
            {"field": "ocr.keywords", "source": "ocr", "value": f"{benefit}, {effect}, niacinamide"},
        ],
        "warnings": [
            {
                "code": "MOCK_MODE",
                "message": "This result was generated in mock mode. Configure a hosted API for live URL crawling.",
            }
        ],
        "generatedAt": generated_at,
        "ragProfile": result["ragProfile"],
    }
    return ProductExtractionRun(result=result, diagnostics=diagnostics)


def _mock_process_trace(source: str) -> list[dict[str, str]]:
    completed_at = _iso_now()
    steps = [
        ("input", "입력 정규화", "상품 URL과 REST API 주소를 표준 실행 입력으로 검증", f"Mock 입력 {source}를 정규화했습니다."),
        ("fetch", "소스 수집", "페이지 HTML, 메타정보, JSON-LD 또는 API 응답 수집", "Mock PDP 소스를 수집했습니다."),
        ("extract", "상품정보 추출", "상품명, 가격, 설명, 옵션, FAQ 후보 정규화", "Mock 상품정보를 추출했습니다."),
        ("ocr", "OCR 문장/키워드 분석", "이미지/상세 영역의 효능, 효과, 성분 문장과 키워드 분류", "Mock OCR 문장과 키워드를 분류했습니다."),
        ("review", "리뷰 신호 추출", "평점, 리뷰본문, 대표 키워드, 고객 표현 정리", "Mock 리뷰 키워드를 추출했습니다."),
        ("rag", "RAG chunk 생성", "상품/리뷰/FAQ/OCR evidence를 RAG 데이터로 구성", "Mock RAG chunk를 생성했습니다."),
        ("json", "JSON 결과 생성", "복사 가능한 최종 JSON 아티팩트 생성", "Mock JSON 결과를 생성했습니다."),
    ]
    return [
        {"id": identifier, "title": title, "description": description, "message": message, "status": "done", "completedAt": completed_at}
        for identifier, title, description, message in steps
    ]


def _source_base(source: str) -> str:
    return source[:-1] if source.endswith("/") else source


def _iso_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


createMockProductExtraction = create_mock_product_extraction
runMockProductExtraction = run_mock_product_extraction

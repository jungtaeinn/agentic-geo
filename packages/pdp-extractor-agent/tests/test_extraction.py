"""Deterministic extraction contracts ported from the legacy HTML/API suite."""

from __future__ import annotations

import inspect
import json
from collections.abc import Mapping
from hashlib import sha256
from importlib import resources
from pathlib import Path
from typing import Any, cast

import httpx
import pytest
from neo_js_compat import js_embedding_snapshot_key

from pdp_extractor_agent import (
    CHAT_COMPLETIONS_IMAGE_OCR_RESPONSE_FORMAT,
    CHAT_COMPLETIONS_KEYWORD_CLASSIFICATION_RESPONSE_FORMAT,
    GEMINI_IMAGE_OCR_RESPONSE_SCHEMA,
    GEMINI_KEYWORD_CLASSIFICATION_RESPONSE_SCHEMA,
    IMAGE_OCR_JSON_SCHEMA,
    PRODUCT_EXTRACTOR_RAG_MANIFEST,
    AzureRoleDeployments,
    EmbeddingRuntimeConfig,
    ProductExtractionInput,
    ProductExtractionRun,
    ProductExtractorRagProfile,
    RerankerRuntimeConfig,
    StoredProductExtractorRagProfile,
    create_mock_product_extraction,
    create_product_extractor_rag_query,
    create_product_profile_normalization_prompt,
    default_product_extractor_rag_profile,
    defaultProductExtractorAnalysisPrompt,
    defaultProductExtractorRagProfile,
    findProductExtractorRagIndexEntry,
    findProductExtractorRagSectionEntry,
    geminiImageOcrResponseSchema,
    imageOcrJsonSchema,
    keywordClassificationJsonSchema,
    normalize_extractor_product_profile_with_agent,
    productExtractorRagIndex,
    productExtractorRagManifest,
    retrieveProductExtractorRagDocuments,
    run_mock_product_extraction,
)
from pdp_extractor_agent.mock import mock_image_ocr, mock_keyword_classification
from pdp_extractor_agent.normalizer import ModelBackedProductProfileNormalizer
from pdp_extractor_agent.ocr.slicing import parse_slice_fragment, slice_display_url
from pdp_extractor_agent.providers import (
    AzureApiKeywordClassifier,
    OpenAIKeywordClassifier,
    create_keyword_classifier,
)
from pdp_extractor_agent.providers.azure_openai import AzureOpenAIProvider
from pdp_extractor_agent.providers.mock import MockKeywordClassifier
from pdp_extractor_agent.providers.transport import resolve_image_inputs, temperature_body
from pdp_extractor_agent.rag.default_profile import (
    DEFAULT_PRODUCT_EXTRACTOR_ANALYSIS_PROMPT,
)
from pdp_extractor_agent.rag.index import find_product_extractor_rag_index_entry
from pdp_extractor_agent.rag.profile_store import (
    read_product_extractor_rag_profile,
    read_profile,
    reset_product_extractor_rag_profile,
    write_profile,
)
from pdp_extractor_agent.rag.retrieval import (
    retrieve_product_extractor_rag_documents,
    retrieve_product_extractor_rag_documents_with_runtime,
)
from pdp_extractor_agent.rest import create_product_extractor_rest_handler
from pdp_extractor_agent.service import extract_product, extract_product_from_api_payload, extract_product_from_html

GRAPH_REFERENCED_HTML = """
<!doctype html><html><head><title>Ginseng Firming Serum</title>
<meta property="article:modified_time" content="2026-08-01T09:30:00Z">
<script type="application/ld+json">{
 "@context":"https://schema.org", "@graph":[
  {"@type":"MerchantReturnPolicy","@id":"#return","returnPolicyCategory":"MerchantReturnFiniteReturnWindow","merchantReturnDays":"45","returnMethod":"ReturnByMail","returnFees":"ReturnFeesCustomerResponsibility","applicableCountry":"US","merchantReturnLink":"/pages/returns"},
  {"@type":"Product","@id":"#product","name":"Ginseng Firming Serum","brand":{"name":"Source Beauty"},"description":"A lightweight firming serum.","itemCondition":"https://schema.org/NewCondition","image":["/serum.jpg"],"offers":{"@id":"#offer"},"aggregateRating":{"ratingValue":"4.8","reviewCount":"854"}},
  {"@type":"Offer","@id":"#offer","price":"215.00","priceCurrency":"USD","availability":"OutOfStock","priceValidUntil":"2027-08-13","hasMerchantReturnPolicy":{"@id":"#return"}}
 ]}</script></head><body><main><h1>Ginseng Firming Serum</h1>
<section class="pdp-benefits"><h2>Benefits</h2><p>After 6 weeks, firmness and elasticity visibly improve.</p></section>
<section class="ingredients"><h2>Key Ingredients</h2><p>Ginseng peptide and NIACINAMIDE support radiant skin.</p></section>
<section><h2>How to use</h2><p>Apply two pumps morning and night after serum.</p></section>
<img src="/clinical.jpg" data-ocr-text="AFTER 6 WEEKS 100% IMPROVEMENT IN FIRMNESS"></main></body></html>
"""


@pytest.mark.asyncio
async def test_html_extraction_skips_modal_descendant_already_decomposed_with_header() -> None:
    html = (
        "<header><div class='modal'>dismiss</div></header>"
        "<section class='modal'><div class='drawer'>dismiss</div></section>"
        "<main><h1>Evidence Serum</h1></main>"
    )

    run = await extract_product_from_html(html, "https://example.test/pdp", {"provider": "mock"})

    assert run.result["geoProduct"]["name"] == "Evidence Serum"


@pytest.mark.asyncio
async def test_html_extraction_resolves_json_ld_references_and_source_fields() -> None:
    run = await extract_product_from_html(GRAPH_REFERENCED_HTML, "https://brand.example/products/ginseng-serum")
    product = run.result["geoProduct"]

    assert product["name"] == "Ginseng Firming Serum"
    assert product["brand"] == "Source Beauty"
    assert product["price"] == {"raw": "215.00", "amount": 215, "currency": "USD"}
    assert product["availability"] == "OutOfStock"
    assert product["priceValidUntil"] == "2027-08-13"
    assert product["itemCondition"].endswith("NewCondition")
    assert product["returnPolicy"] == {
        "category": "MerchantReturnFiniteReturnWindow",
        "merchantReturnDays": 45,
        "returnMethod": "ReturnByMail",
        "returnFees": "ReturnFeesCustomerResponsibility",
        "applicableCountry": "US",
        "url": "https://brand.example/pages/returns",
    }
    assert product["dateModified"] == "2026-08-01T09:30:00Z"
    assert product["images"] == ["https://brand.example/serum.jpg", "https://brand.example/clinical.jpg"]
    assert product["reviews"]["rating"] == 4.8
    assert product["reviews"]["reviewCount"] == 854
    assert any(item["field"] == "product.dateModified" for item in run.diagnostics["evidence"])


@pytest.mark.asyncio
async def test_html_extraction_keeps_product_sections_ocr_and_seven_stage_diagnostics() -> None:
    run = await extract_product_from_html(GRAPH_REFERENCED_HTML, "https://brand.example/products/ginseng-serum")
    product = run.result["geoProduct"]

    assert any("Ginseng peptide" in value for value in product["ingredients"])
    assert any("Apply two pumps" in value for value in product["usage"])
    assert "6 weeks" in product["metrics"]
    assert any(chunk["kind"] == "ocr" and "100%" in chunk["text"] for chunk in product["rag"]["chunks"])
    assert product["sourceExtraction"]["ocr"]["imageTexts"][0]["imageUrl"] == "https://brand.example/clinical.jpg"
    assert [step["id"] for step in run.diagnostics["process"]] == [
        "input",
        "fetch",
        "extract",
        "ocr",
        "review",
        "rag",
        "json",
    ]
    assert run.diagnostics["process"][-1]["status"] == "done"


@pytest.mark.asyncio
async def test_shopify_api_payload_is_normalized_with_relative_image_and_sections() -> None:
    payload = {
        "product": {
            "title": "Concentrated Botanical Serum",
            "body_html": "<p>After 6 weeks, skin looks firmer.</p>",
            "images": [{"src": "/serum.jpg"}],
            "variants": [{"price": "215.00", "title": "50 mL"}],
            "options": [{"name": "Size", "values": ["50 mL"]}],
            "updated_at": "2026-07-30T11:00:00-04:00",
        }
    }
    run = await extract_product_from_html(__import__("json").dumps(payload), "https://brand.example/products/serum")
    product = run.result["geoProduct"]

    assert product["name"] == "Concentrated Botanical Serum"
    assert product["price"]["raw"] == "215.00"
    assert product["images"][0] == "https://brand.example/serum.jpg"
    assert product["options"] == ["50 mL"]
    assert product["dateModified"] == "2026-07-30T11:00:00-04:00"
    assert "6 weeks" in product["metrics"]
    assert any(item["field"] == "url.jsonPayload" for item in run.diagnostics["evidence"])


@pytest.mark.asyncio
async def test_url_extraction_forces_html_accept_header_over_json_input_header() -> None:
    observed: dict[str, str] = {}

    async def fetcher(url: str, headers: Mapping[str, str]) -> tuple[int, str, str]:
        observed.update(headers)
        return 200, "text/html; charset=utf-8", "<main><h1>Hydra Barrier Cream</h1></main>"

    run = await extract_product(
        {
            "sourceType": "url",
            "source": "https://example.test/products/hydra",
            "headers": {"Accept": "application/json"},
        },
        {"fetcher": fetcher},
    )

    assert "text/html" in observed["Accept"]
    assert run.result["geoProduct"]["name"] == "Hydra Barrier Cream"


@pytest.mark.asyncio
async def test_custom_normalizer_can_supply_source_backed_profile_fields_and_usage() -> None:
    class Normalizer:
        async def normalize_product_profile(self, request: dict[str, Any]) -> dict[str, Any]:
            assert request["bootstrapProduct"]["name"] == "Untitled product"
            return {
                "product": {
                    "name": "Agentic Repair Serum",
                    "description": "Ceramide hydration support",
                    "benefits": ["barrier hydration", "invented award"],
                    "ingredients": ["Ceramide"],
                    "usage": ["Apply after toner."],
                },
                "usage": {"inputTokens": 25, "outputTokens": 15, "totalTokens": 40},
            }

    run = await extract_product_from_html(
        '{"upstreamPayload":{"displayLabel":"Agentic Repair Serum","description":"Ceramide hydration support","benefits":["barrier hydration"],"ingredients":["Ceramide"],"usage":["Apply after toner."]}}',
        "https://example.test/products/agentic-repair-serum",
        {"customProductNormalizer": Normalizer(), "provider": "gemini"},
    )
    product = run.result["geoProduct"]

    assert product["name"] == "Agentic Repair Serum"
    assert product["ingredients"] == ["Ceramide"]
    assert product["benefits"] == ["barrier hydration"]
    assert run.diagnostics["runtimeUsage"]["tokenTotals"]["totalTokens"] == 40
    assert run.diagnostics["ocr"]["provider"] == "gemini"
    runtime_steps = run.diagnostics["runtimeUsage"]["steps"]
    final_ocr = next(item for item in runtime_steps if item["label"] == "Final OCR classification/reasoning")
    profile_normalization = next(item for item in runtime_steps if item["label"] == "Product profile normalization/reasoning")
    assert final_ocr["called"] is False
    assert profile_normalization["provider"] == "custom"
    assert profile_normalization["called"] is True


@pytest.mark.asyncio
async def test_title_suffix_cleanup_is_brand_neutral_for_an_arbitrary_official_store() -> None:
    """A product title suffix is storefront chrome, not a known-brand exception."""

    run = await extract_product_from_html(
        "<html><head><title>Ocean Mineral Shampoo — North Coast Official Store</title></head><body></body></html>",
        "https://northcoast.example/products/ocean-mineral-shampoo",
    )

    assert run.result["geoProduct"]["name"] == "Ocean Mineral Shampoo"


@pytest.mark.asyncio
async def test_client_rendered_description_accepts_non_skin_product_copy_without_category_keywords() -> None:
    """Client JSON descriptions must not depend on a skincare-only vocabulary list."""

    run = await extract_product_from_html(
        """
        <script id="__NEXT_DATA__" type="application/json">
        {"products":[{"productHandle":"ocean-shampoo","productName":"Ocean Mineral Shampoo","brandName":"North Coast","linePromoDesc":"Ocean Mineral Shampoo cleanses color-treated hair without added fragrance.","images":[{"src":"/ocean.png"}]}]}
        </script><main></main>
        """,
        "https://brand.example.com/products/ocean-shampoo",
        {"provider": "mock"},
    )

    product = run.result["geoProduct"]
    assert product["name"] == "Ocean Mineral Shampoo"
    assert product["brand"] == "North Coast"
    assert product["description"] == "Ocean Mineral Shampoo cleanses color-treated hair without added fragrance."
    assert product["images"] == ["https://brand.example.com/ocean.png"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("handle", "name", "description"),
    (
        (
            "curl-styler",
            "Curl Styler",
            "A leave-in styling treatment detangles wet hair and defines curls without stiffness.",
        ),
        (
            "root-foam",
            "Root Foam",
            "A weightless styling foam adds volume at the roots for flexible hold.",
        ),
        (
            "matte-base",
            "Matte Base",
            "A matte base controls shine and blurs the look of pores throughout the day.",
        ),
        (
            "rinse-free-wash",
            "Rinse-Free Wash",
            "A rinse-free wash dissolves makeup and lifts daily buildup without water.",
        ),
    ),
)
async def test_client_state_accepts_declarative_product_copy_without_a_category_verb_allowlist(
    handle: str, name: str, description: str
) -> None:
    """A product-record description is source copy when it is prose, not commerce or review noise."""

    state = {"products": [{"productHandle": handle, "productName": name, "linePromoDesc": description}]}
    run = await extract_product_from_html(
        '<script type="application/json">' + json.dumps(state) + f"</script><main><h1>{name}</h1></main>",
        f"https://brand.example.com/products/{handle}",
        {"provider": "mock"},
    )

    extracted = run.result["geoProduct"]
    assert extracted["description"] == description
    assert extracted["sourceExtraction"]["html"]["description"] == description


@pytest.mark.asyncio
async def test_mock_ocr_keeps_a_generic_explicit_ingredient_to_outcome_relation() -> None:
    """Local OCR fallback must retain source grammar beyond a fixed ingredient dictionary."""

    source = "Betaine helps maintain hair softness."
    run = await extract_product_from_html(
        f'<main><h1>Ocean Shampoo</h1><img src="https://example.com/detail.jpg" data-ocr-text="{source}"></main>',
        "https://example.com/products/ocean-shampoo",
        {"provider": "mock"},
    )
    product = run.result["geoProduct"]
    facts = product["sourceExtraction"]["ocr"]["semanticFacts"]

    assert source in product["sourceExtraction"]["ocr"]["textBlocks"]
    assert "Betaine" in facts["ingredients"]
    assert source in facts["benefits"]
    assert any(
        link.get("ingredient") == "Betaine"
        and "hair softness" in str(link.get("benefit", "")).casefold()
        and link.get("sourceText") == source
        for link in facts["ingredientBenefitLinks"]
    )


@pytest.mark.asyncio
async def test_custom_normalizer_cannot_route_commerce_or_usage_into_product_outcomes() -> None:
    """Lexical source overlap is not enough to make a value an efficacy field."""

    class Normalizer:
        async def normalize_product_profile(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {
                "product": {
                    "benefits": ["Free shipping.", "Apply daily to improve softness."],
                    "effects": ["Supports easy returns.", "Customers report improved softness."],
                },
                "usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5},
            }

    run = await extract_product_from_html(
        "<main><h1>Ocean Shampoo</h1><section><h2>Shipping and returns</h2>"
        "<p>Free shipping. Supports easy returns.</p></section><p>Apply daily to improve softness.</p>"
        "<p>Customers report improved softness.</p></main>",
        "https://example.com/products/ocean-shampoo",
        {"provider": "gemini", "customProductNormalizer": Normalizer()},
    )
    product = run.result["geoProduct"]
    evidence = run.diagnostics["evidence"]
    warnings = run.diagnostics["warnings"]

    assert product["benefits"] == []
    assert product["effects"] == []
    assert any("role" in item["message"].casefold() for item in warnings)
    assert not any(
        item["value"].startswith("Model-backed product profile normalization updated: benefits, effects")
        for item in evidence
    )


@pytest.mark.asyncio
async def test_invalid_or_absent_source_date_is_omitted() -> None:
    run = await extract_product_from_html(
        '<html><head><title>Plain Cream</title><meta property="og:updated_time" content="yesterday"></head><body><h1>Plain Cream</h1></body></html>',
        "https://example.test/products/plain",
    )

    assert "dateModified" not in run.result["geoProduct"]


@pytest.mark.asyncio
async def test_client_rendered_review_aggregate_warns_when_bodies_are_absent() -> None:
    run = await extract_product_from_html(
        '<script type="application/ld+json">{"@type":"Product","name":"Review Serum","aggregateRating":{"ratingValue":"4.8","reviewCount":"854"}}</script><h1>Review Serum</h1><section class="reviews"><h2>Reviews</h2><button>Write a review</button></section>',
        "https://example.test/products/review-serum",
    )
    product = run.result["geoProduct"]

    assert product["reviews"] == {"rating": 4.8, "reviewCount": 854, "items": [], "keywords": []}
    assert {warning["code"] for warning in run.diagnostics["warnings"]} >= {"REVIEW_BODIES_UNAVAILABLE"}
    assert {item["field"] for item in run.diagnostics["evidence"]} >= {
        "product.reviews.rating",
        "product.reviews.reviewCount",
    }


def test_root_api_exports_models_runtime_schemas_and_default_profile() -> None:
    assert PRODUCT_EXTRACTOR_RAG_MANIFEST["profile"] == "pdp-extractor-default"
    assert productExtractorRagManifest is PRODUCT_EXTRACTOR_RAG_MANIFEST
    assert productExtractorRagIndex and findProductExtractorRagIndexEntry(productExtractorRagIndex[0]["document"])
    assert findProductExtractorRagSectionEntry(productExtractorRagIndex[0]["document"], "RAG Orchestration")
    assert IMAGE_OCR_JSON_SCHEMA["required"] == ["images"] and GEMINI_IMAGE_OCR_RESPONSE_SCHEMA["required"] == [
        "images"
    ]
    assert imageOcrJsonSchema is IMAGE_OCR_JSON_SCHEMA
    assert keywordClassificationJsonSchema is not None and geminiImageOcrResponseSchema is GEMINI_IMAGE_OCR_RESPONSE_SCHEMA
    assert default_product_extractor_rag_profile()["profile"] == PRODUCT_EXTRACTOR_RAG_MANIFEST["profile"]
    assert defaultProductExtractorRagProfile() == default_product_extractor_rag_profile()
    assert defaultProductExtractorAnalysisPrompt == DEFAULT_PRODUCT_EXTRACTOR_ANALYSIS_PROMPT
    assert (
        ProductExtractorRagProfile.model_validate(default_product_extractor_rag_profile()).profile
        == "pdp-extractor-default"
    )
    response_format = cast(dict[str, Any], CHAT_COMPLETIONS_IMAGE_OCR_RESPONSE_FORMAT)
    assert response_format["json_schema"]["schema"] is IMAGE_OCR_JSON_SCHEMA
    assert GEMINI_KEYWORD_CLASSIFICATION_RESPONSE_SCHEMA["properties"]["semanticFacts"]["type"] == "OBJECT"
    assert AzureRoleDeployments(reasoning="reason").model_dump(by_alias=True, exclude_none=True) == {
        "reasoning": "reason"
    }
    assert EmbeddingRuntimeConfig(provider="local").provider == "local"
    assert RerankerRuntimeConfig(provider="local-hybrid").provider == "local-hybrid"
    assert CHAT_COMPLETIONS_KEYWORD_CLASSIFICATION_RESPONSE_FORMAT["type"] == "json_schema"
    assert inspect.iscoroutinefunction(retrieveProductExtractorRagDocuments)


def test_input_aliases_ignore_unknown_fields_and_wire_omits_absent_values() -> None:
    input_ = ProductExtractionInput.model_validate(
        {"sourceType": "url", "source": "https://example.test/p", "unknown": "ignored"}
    )
    assert input_.model_dump(by_alias=True, exclude_none=True) == {
        "sourceType": "url",
        "source": "https://example.test/p",
        "aiProvider": "mock",
    }
    run = ProductExtractionRun(result={"geoProduct": {"brand": None, "name": "Cream"}}, diagnostics={"optional": None})
    assert run.to_wire() == {"result": {"geoProduct": {"name": "Cream"}}, "diagnostics": {}}


@pytest.mark.asyncio
async def test_custom_normalizer_application_retains_usage_and_source_backed_fields() -> None:
    class CustomNormalizer:
        async def normalize_product_profile(self, request: dict[str, Any]) -> dict[str, Any]:
            assert request["bootstrapProduct"] == {"name": "Untitled", "ingredients": []}
            return {
                "product": {"name": "Barrier Serum", "ingredients": ["Ceramide"]},
                "usage": {"inputTokens": 4, "outputTokens": 2, "totalTokens": 6},
            }

    applied = await normalize_extractor_product_profile_with_agent(
        {
            "source": "https://example.test/p",
            "sourceType": "url",
            "rawSource": {"name": "Barrier Serum", "ingredients": ["Ceramide"]},
            "bootstrapProduct": {"name": "Untitled", "ingredients": []},
        },
        {"customProductNormalizer": CustomNormalizer()},
    )
    assert applied["called"] is True and applied["applied"] is True
    assert applied["product"] == {"name": "Barrier Serum", "ingredients": ["Ceramide"]}
    assert applied["usage"]["totalTokens"] == 6


@pytest.mark.asyncio
async def test_model_backed_normalizer_mock_provider_returns_explicit_warning() -> None:
    result = await ModelBackedProductProfileNormalizer({"provider": "mock"}).normalize_product_profile(
        {"bootstrapProduct": {"name": "Cream"}}
    )
    assert result["warnings"] == ["mock product profile normalization provider has no model-backed adapter."]

    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["apiKey"] = request.headers.get("x-goog-api-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {"content": {"parts": [{"text": '{"product":{"name":"Barrier Cream"},"warnings":[]}'}]}}
                ],
                "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 2, "totalTokenCount": 5},
            },
        )

    normalized = await ModelBackedProductProfileNormalizer(
        {"provider": "gemini", "apiKey": "key", "model": "gemini-2.5", "transport": httpx.MockTransport(handler)}
    ).normalize_product_profile(
        {
            "source": "https://example.test/p",
            "bootstrapProduct": {"name": "Cream"},
            "rawSource": {"name": "Barrier Cream"},
        }
    )
    assert normalized["product"]["name"] == "Barrier Cream"
    assert normalized["usage"]["totalTokens"] == 5
    assert seen["apiKey"] == "key" and ":generateContent" in seen["url"]


@pytest.mark.asyncio
async def test_progress_callback_observes_fixed_stage_ids_and_order() -> None:
    seen: list[str] = []
    def record_step(step: Mapping[str, Any]) -> None:
        seen.append(str(step["id"]))

    run = await extract_product_from_html(
        "<h1>Progress Cream</h1>", "https://example.test/p", {"onProgress": record_step}
    )
    # Direct HTML extraction owns only the inner five stages, and TS publishes
    # each transition immediately rather than replaying final snapshots.
    assert seen == [
        "extract",
        "extract",
        "ocr",
        "ocr",
        "review",
        "review",
        "rag",
        "rag",
        "json",
        "json",
    ]
    assert [chunk["id"] for chunk in run.result["geoProduct"]["rag"]["chunks"][:2]] == [
        "product-1",
        "rag-profile-analysis-prompt",
    ]
    assert sha256(run.result["geoProduct"]["rag"]["chunks"][1]["text"].encode()).hexdigest() == (
        "2dcd5482f31edab0aa8ece6a64f6731282ee9d421adb4cace78ed39529db1e8c"
    )
    completed = {step["id"]: step for step in run.diagnostics["process"]}
    assert all(
        completed[identifier].get("startedAt") and completed[identifier].get("completedAt")
        for identifier in {"extract", "ocr", "review", "rag", "json"}
    )
    assert completed["review"]["message"] == "집계 평점 없음, 리뷰 본문 0개와 리뷰 키워드 0개를 정리했습니다."
    assert run.diagnostics["warnings"] == [
        {
            "code": "OCR_NO_IMAGE_TEXT",
            "message": "No image OCR text candidates were found. Add data-ocr-text fixtures or configure a vision provider for richer extraction.",
        }
    ]


def test_mock_surface_returns_a_complete_non_fabricating_run() -> None:
    run = create_mock_product_extraction("https://example.test/p", 2)
    assert run.result["source"] == "https://example.test/p" and [step["id"] for step in run.diagnostics["process"]] == [
        "input",
        "fetch",
        "extract",
        "ocr",
        "review",
        "rag",
        "json",
    ]
    assert mock_keyword_classification({"source": "https://example.test/p"})["keywords"] == []
    assert mock_image_ocr({"imageUrls": ["https://img.test/a.png"]})["images"] == []


@pytest.mark.asyncio
async def test_mock_run_preserves_the_complete_ui_demo_contract() -> None:
    runs = await run_mock_product_extraction(["https://example.test/p/", "https://example.test/serum"])

    assert [run.result["geoProduct"]["name"] for run in runs] == ["Hydra Barrier Cream", "Bright Tone Serum"]
    first = runs[0]
    product = first.result["geoProduct"]
    assert first.result["generatedAt"].endswith("Z")
    assert product["price"] == {"raw": "32,000원", "amount": 32000, "currency": "KRW"}
    assert product["sourceExtraction"]["ocr"]["textBlocks"] == ["hydration barrier care niacinamide daily use FAQ"]
    assert product["aiAnalysis"]["summary"] == "Mock product evidence was categorized into product fields."
    assert product["customerReviewAnalysis"]["ratingSummary"] == "Rating 4.7 · 1284 reviews"
    assert product["contentAnalysis"]["sections"][-1]["title"] == "Customer rating"
    assert product["ocr"]["keywords"]["benefit"] == ["hydration"]
    assert [chunk["id"] for chunk in product["rag"]["chunks"]] == ["product-1", "review-1", "ocr-1"]
    assert [step["title"] for step in first.diagnostics["process"]] == [
        "입력 정규화",
        "소스 수집",
        "상품정보 추출",
        "OCR 문장/키워드 분석",
        "리뷰 신호 추출",
        "RAG chunk 생성",
        "JSON 결과 생성",
    ]
    assert first.diagnostics["warnings"][0]["code"] == "MOCK_MODE"


def test_default_profile_dtos_and_missing_state_fall_back_to_managed_assets(tmp_path: Path) -> None:
    profile = read_profile(state_dir=tmp_path)
    stored = StoredProductExtractorRagProfile.model_validate(profile)
    assert stored.profile == "pdp-extractor-default" and len(stored.documents) == 4
    named_profile = read_product_extractor_rag_profile(state_dir=tmp_path)
    assert named_profile["documents"][0]["managed"] is True
    assert all(document["updatedAt"].endswith("Z") for document in named_profile["documents"])
    assert named_profile["updatedAt"] == max(document["updatedAt"] for document in named_profile["documents"])
    assert DEFAULT_PRODUCT_EXTRACTOR_ANALYSIS_PROMPT == defaultProductExtractorAnalysisPrompt
    runtime_profile = default_product_extractor_rag_profile()
    assert sha256(runtime_profile["analysisPrompt"].encode()).hexdigest() == (
        "2dcd5482f31edab0aa8ece6a64f6731282ee9d421adb4cace78ed39529db1e8c"
    )
    assert [sha256(document["content"].encode()).hexdigest() for document in runtime_profile["documents"]] == [
        "eb94d64200c058a9d39104a044ab80e3fc2002213cdb25959e736a60d9a71b12",
        "6857f00973769f6d7d2196eae1ab05eaa7e777fd60a8c0059e1b8fb9068b5bb7",
        "1537a92d66423e008500eea0d57fd4e2ec2023ab291b9c17a335db0ba3173f82",
        "53d74dc02b35d3d3a9947b0fbe42390627f1efafc3749576b1aa545a95653925",
    ]


def test_profile_fixture_supports_custom_document_round_trip(tmp_path: Path) -> None:
    fixture = {
        "profile": "fixture",
        "analysisPrompt": "fixture prompt",
        "documents": [{"name": "fixture.md", "version": "v2", "content": "fixture evidence"}],
    }
    assert write_profile(fixture, state_dir=tmp_path)["documents"][0]["version"] == "v2"
    assert read_profile(state_dir=tmp_path) == fixture
    assert reset_product_extractor_rag_profile(state_dir=tmp_path)["profile"] == "pdp-extractor-default"


def test_manifest_index_lookup_and_utf16_snapshot_key_are_stable() -> None:
    entry = find_product_extractor_rag_index_entry("ocr-keyword-classification_v1.md")
    assert (
        entry and entry["kind"] == "ocr-classification" and entry["sections"][0]["heading"] == "Sentence Reconstruction"
    )
    assert js_embedding_snapshot_key("A😀").endswith(":3")


def test_rag_query_includes_source_product_and_image_evidence() -> None:
    query = create_product_extractor_rag_query(
        {
            "source": "https://example.test/p",
            "productName": "Barrier Cream",
            "imageTexts": [{"imageUrl": "https://img.test/a.png", "text": "Ceramide supports the barrier"}],
        }
    )
    assert (
        "Source: https://example.test/p." in query
        and "Product name: Barrier Cream." in query
        and "Ceramide supports the barrier" in query
    )


def test_local_rag_retrieval_returns_policy_metadata_and_default_fallback() -> None:
    selected = retrieve_product_extractor_rag_documents("ceramide barrier classification", limit=3)
    assert selected and selected[-1]["kind"] == "analysisPrompt"
    assert all("id" in item and "text" in item for item in selected)


@pytest.mark.asyncio
async def test_rag_remote_embedding_boundary_uses_azure_wire_contract_and_reports_progress() -> None:
    seen: dict[str, Any] = {}
    steps: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["auth"] = str(request.url), request.headers.get("api-key")
        return httpx.Response(
            200,
            json={
                "data": [{"index": 0, "embedding": [1.0, 0.0]}, {"index": 1, "embedding": [0.0, 1.0]}],
                "usage": {"prompt_tokens": 3, "total_tokens": 3},
            },
        )

    result = await retrieve_product_extractor_rag_documents_with_runtime(
        {
            "query": "barrier",
            "documents": [{"name": "policy.md", "content": "barrier evidence"}],
            "embedding": {
                "provider": "azure-openai",
                "apiKey": "key",
                "endpoint": "https://azure.example",
                "deployment": "embed",
                "transport": httpx.MockTransport(handler),
            },
            "onRuntimeStep": steps.append,
        }
    )
    assert (
        result
        and "/openai/deployments/embed/embeddings?api-version=2025-04-01-preview" in seen["url"]
        and seen["auth"] == "key"
    )
    assert steps[0]["stage"] == "embedding" and steps[0]["tokenUsage"]["totalTokens"] == 3


@pytest.mark.asyncio
async def test_rag_remote_reranker_boundary_uses_mock_transport_and_falls_back_safely() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["auth"] = str(request.url), request.headers.get("authorization")
        return httpx.Response(
            200, json={"results": [{"index": 1, "relevance_score": 0.99}, {"index": 0, "relevance_score": 0.5}]}
        )

    result = await retrieve_product_extractor_rag_documents_with_runtime(
        {
            "query": "barrier",
            "documents": [
                {"name": "first.md", "content": "barrier policy"},
                {"name": "second.md", "content": "barrier classification"},
            ],
            "reranker": {
                "provider": "cohere",
                "apiKey": "key",
                "endpoint": "https://rerank.example",
                "model": "rerank-v3",
                "transport": httpx.MockTransport(handler),
            },
            "settings": {"maxChunks": 2},
        }
    )
    assert (
        result[0]["sourceDocument"] == "first.md"
        and seen["url"] == "https://rerank.example/v2/rerank"
        and seen["auth"] == "Bearer key"
    )


@pytest.mark.asyncio
async def test_mock_keyword_classifier_has_stable_provider_contract() -> None:
    provider = MockKeywordClassifier()
    assert await provider.classify_keywords({"imageTexts": []}) == {
        "keywords": [],
        "sentenceInsights": [],
        "semanticFacts": {
            "ingredients": [],
            "benefits": [],
            "effects": [],
            "skinTypes": [],
            "usageSteps": [],
            "safetyTests": [],
            "metricClaims": [],
            "evidenceSentences": [],
            "ingredientBenefitLinks": [],
            "citations": [],
        },
        "summary": "No OCR keywords found.",
    }
    assert await provider.extract_image_text({"imageUrls": ["https://img.test/a.png"]}) == {"images": [], "rawText": ""}


@pytest.mark.asyncio
async def test_azure_provider_mock_transport_uses_default_api_version_and_api_key_header() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["apiKey"] = str(request.url), request.headers.get("api-key")
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"keywords":[]}'}}]})

    result = await AzureOpenAIProvider(
        api_key="key", endpoint="https://azure.example/", deployment="reason", transport=httpx.MockTransport(handler)
    ).classify_keywords({"imageTexts": []})
    assert result == {"keywords": []} and seen["apiKey"] == "key" and "api-version=2025-04-01-preview" in seen["url"]


def test_policy_bearing_normalization_prompt_and_image_schema_keep_required_contract() -> None:
    prompt = create_product_profile_normalization_prompt(
        {
            "source": "https://example.test/p",
            "sourceType": "url",
            "bootstrapProduct": {"name": "Cream"},
            "rawSource": {"htmlText": "source"},
            "analysisPrompt": "analysis policy",
            "ragDocuments": [{"name": "policy.md", "version": "v1", "content": "document policy"}],
        }
    )
    assert "source-backed" in prompt["system"] and "https://example.test/p" in prompt["user"]
    prompt_payload = json.loads(prompt["user"])
    assert prompt_payload["rawSource"] == {"htmlText": "source"}
    assert prompt_payload["ragPolicy"] == [
        {"name": "analysis-prompt", "content": "analysis policy"},
        {"name": "policy.md", "version": "v1", "content": "document policy"},
    ]
    assert "groups" in IMAGE_OCR_JSON_SCHEMA["properties"]["images"]["items"]["required"]
    assert temperature_body(None) == {} and temperature_body(0) == {"temperature": 0}
    assert resolve_image_inputs({"imageUrls": ["https://img.test/a.png"]}) == [
        {"displayUrl": "https://img.test/a.png", "inputUrl": "https://img.test/a.png"}
    ]
    assert isinstance(
        create_keyword_classifier({"provider": "openai", "apiKey": "key", "model": "model"}), OpenAIKeywordClassifier
    )
    assert isinstance(
        create_keyword_classifier(
            {"provider": "azure-openai", "apiKey": "key", "endpoint": "https://azure.test", "deployment": "model"}
        ),
        AzureApiKeywordClassifier,
    )


@pytest.mark.asyncio
async def test_normalizer_keeps_explicit_zero_max_rag_documents_instead_of_using_the_default() -> None:
    seen: dict[str, Any] = {}

    class CapturingNormalizer:
        async def normalize_product_profile(self, request: dict[str, Any]) -> dict[str, Any]:
            seen.update(request)
            return {"product": {}}

    await normalize_extractor_product_profile_with_agent(
        {
            "source": "https://example.test/p",
            "sourceType": "url",
            "rawSource": {},
            "bootstrapProduct": {},
            "ragDocuments": [
                {"name": "first.md", "content": "first"},
                {"name": "second.md", "content": "second"},
            ],
        },
        {"customProductNormalizer": CapturingNormalizer(), "productNormalization": {"maxRagDocuments": 0}},
    )

    assert seen["ragDocuments"] == []


def test_normalization_prompt_truncation_uses_javascript_utf16_code_units() -> None:
    import pdp_extractor_agent.normalizer as normalizer_module

    trim_json_for_prompt = getattr(normalizer_module, "_trim_json_for_prompt")
    assert trim_json_for_prompt({"value": "😀😀😀"}, 16) == {
        "truncated": True,
        "text": '{\n  "value": "😀',
    }


@pytest.mark.asyncio
async def test_extraction_reports_baseline_runtime_and_grouped_rag_policy_usage() -> None:
    run = await extract_product_from_html(
        '<main><h1>Barrier Cream</h1><img src="https://img.test/detail-benefit.png" data-ocr-text="Ceramide barrier hydration support"></main>',
        "https://example.test/products/barrier",
    )

    runtime = run.diagnostics["runtimeUsage"]
    assert [step["label"] for step in runtime["steps"]] == [
        "OCR/structure extraction",
        "Final OCR classification/reasoning",
        "Embedding",
        "Retrieval",
        "Reranking",
    ]
    assert runtime["tokenTotals"] == {}
    assert runtime["tokenNote"] == "Token counts were not returned or do not apply to deterministic/search-only stages."

    rag_usage = run.diagnostics["ragUsage"]
    assert [group["principle"] for group in rag_usage] == [
        "policy orchestration and overlap control",
        "field classification and normalization",
        "evidence exclusions and missing-field safety",
    ]
    reference = rag_usage[0]["references"][0]
    assert {"sourceDocument", "chunkId", "kind", "intents", "fieldTargets", "score", "usage", "excerpt"} <= set(
        reference
    )


def test_runtime_usage_keeps_provider_specific_search_metadata_and_nullish_deployments() -> None:
    """The diagnostics are a public UI contract, not a lossy internal trace."""

    import pdp_extractor_agent.service as service_module

    extractor_runtime_usage = getattr(service_module, "_extractor_runtime_usage")
    usage = extractor_runtime_usage(
        {
            "provider": "azure-openai",
            "deployment": "fallback-deployment",
            "deployments": {"ocr": "", "reasoning": "reasoning-deployment"},
            "embedding": {"provider": "azure-openai", "deployment": "embed-deployment", "model": "embed-model"},
            "reranker": {
                "provider": "azure-ai-search-semantic",
                "indexName": "products-v2",
                "semanticConfiguration": "beauty-policy",
            },
        }
    )

    ocr, final, embedding, _, reranking = usage["steps"]
    assert ocr["provider"] == "azure-api"
    assert ocr["service"] == "Azure API model deployment"
    assert ocr["deployment"] == ""  # TS uses ??, so a deliberately blank deployment is retained.
    assert final["deployment"] == "reasoning-deployment"
    assert embedding == {
        "stage": "embedding",
        "label": "Embedding",
        "provider": "azure-api",
        "service": "Azure API embedding deployment",
        "model": "embed-model",
        "deployment": "embed-deployment",
        "called": False,
        "details": "Embeds extractor RAG policy query and candidate chunks when Azure embedding credentials are configured.",
    }
    assert reranking == {
        "stage": "reranking",
        "label": "Reranking",
        "provider": "azure-ai-search-semantic",
        "service": "Azure AI Search semantic ranker",
        "called": False,
        "details": "Uses Azure AI Search index products-v2 with semantic configuration beauty-policy.",
    }


@pytest.mark.asyncio
async def test_html_extraction_constructs_the_configured_provider_for_vision_ocr_and_semantic_classification() -> None:
    calls: list[dict[str, Any]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body: dict[str, Any] = json.loads(request.content)
        calls.append(body)
        raw_input = body.get("input", [])
        content: list[dict[str, Any]] = []
        if isinstance(raw_input, list):
            input_payload = cast(list[dict[str, Any]], raw_input)
            content = cast(list[dict[str, Any]], input_payload[0].get("content", [])) if input_payload else []
        image_label = next((str(part.get("text", "")) for part in content if part.get("type") == "input_text"), "")
        if any(part.get("type") == "input_image" for part in content):
            image_url = image_label.split(": ", 1)[-1]
            return httpx.Response(
                200,
                json={
                    "output_text": json.dumps(
                        {
                            "images": [
                                {
                                    "imageUrl": image_url,
                                    "text": "Vision OCR confirms barrier hydration support.",
                                    "confidence": 0.91,
                                }
                            ]
                        }
                    )
                },
            )
        return httpx.Response(
            200,
            json={
                "output_text": json.dumps(
                    {
                        "keywords": [{"keyword": "barrier", "category": "benefit"}],
                        "sentenceInsights": [
                            {
                                "text": "Vision OCR confirms barrier hydration support.",
                                "category": "benefit",
                                "keywords": ["barrier"],
                                "evidenceIndex": 1,
                            }
                        ],
                    }
                )
            },
        )

    async def unsliceable(_: str) -> tuple[int, str, bytes]:
        return 404, "text/plain", b"not found"

    run = await extract_product_from_html(
        '<main><h1>Vision Barrier Cream</h1><img src="https://cdn.example/detail-benefit.png" alt="Barrier benefit"></main>',
        "https://example.test/products/vision-barrier",
        {
            "provider": "openai",
            "apiKey": "key",
            "model": "gpt-test",
            "transport": httpx.MockTransport(handler),
            "slicingFetcher": unsliceable,
        },
    )

    ocr = run.result["geoProduct"]["sourceExtraction"]["ocr"]
    assert any(part.get("type") == "input_image" for call in calls for part in call["input"][0]["content"])
    assert any("Vision OCR confirms barrier" in item["text"] for item in ocr["imageTexts"])
    assert "barrier" in run.result["geoProduct"]["aiAnalysis"]["keywords"]["benefit"]
    assert run.diagnostics["ocr"]["provider"] == "openai"


def test_provider_factory_preserves_legacy_injectable_config_values() -> None:
    """The factory delegates configuration verbatim; provider use decides validity."""

    transport = object()
    image_fetcher = object()
    provider = create_keyword_classifier(
        {
            "provider": "azure-openai",
            "apiKey": "key",
            "endpoint": "https://azure.test",
            "deployment": 9,
            "deployments": {"reasoning": 7},
            "transport": transport,
            "imageFetcher": image_fetcher,
            "temperature": 1,
        }
    )
    assert provider.transport is transport
    assert provider.image_fetcher is image_fetcher
    assert provider.deployment == 9
    assert provider.deployments == {"reasoning": 7}
    assert provider.temperature == 1


@pytest.mark.parametrize(
    ("name", "length", "digest"),
    [
        ("analysis-prompt_v1.md", 2189, "6b422b93d8c4750a31d8cf874da02761afffef0adf1cc6d108d781c2ecf8a606"),
        ("faq-extraction_v1.md", 860, "b17cbbc3408fd2569696ee295bc98905374281c8d50329200ff2195d6b38ab31"),
        ("ocr-keyword-classification_v1.md", 4411, "634499da1c7cb9d1c79f1777d8908ef3ab8219d42074ca10b03a8b88a20e058a"),
        ("product-normalization_v1.md", 2663, "62f555ee5b5df33c1fe2841c0aab82d8953bb75ab93d1329a246cc8836d23777"),
        ("review-keyword-extraction_v1.md", 1129, "d1fae118665b43cb377aa01e05803bc6466edf7915cf08007a5981ef081d60d9"),
    ],
)
def test_packaged_rag_resource_bytes_match_public_assets(name: str, length: int, digest: str) -> None:
    content = resources.files("pdp_extractor_agent").joinpath("resources", "rag", name).read_bytes()
    assert len(content) == length and sha256(content).hexdigest() == digest


@pytest.mark.asyncio
async def test_deterministic_html_api_image_rag_and_partial_rest_boundary_goldens() -> None:
    html = await extract_product_from_html(GRAPH_REFERENCED_HTML, "https://brand.example/products/ginseng-serum")
    api = await extract_product_from_api_payload(
        {"product": {"title": "Golden API Cream", "price": "19", "currency": "USD", "images": [{"src": "/a.png"}]}},
        "https://brand.example/products/api",
    )
    display = slice_display_url("https://img.test/a.png#frag", 2, 3)
    retrieval = retrieve_product_extractor_rag_documents("ingredient classification", limit=3)

    async def one(source: str, source_type: str, **_: object) -> dict[str, object]:
        if source.endswith("bad"):
            raise RuntimeError("blocked")
        return {
            "source": source,
            "sourceType": source_type,
            "geoProduct": {"name": "Golden"},
            "diagnostics": {"source": source, "process": []},
        }

    response = await create_product_extractor_rest_handler(extract_one=one)(
        "POST", {"sources": ["https://golden/good", "https://golden/bad"]}
    )
    assert {"name": html.result["geoProduct"]["name"], "availability": html.result["geoProduct"]["availability"]} == {
        "name": "Ginseng Firming Serum",
        "availability": "OutOfStock",
    }
    assert api.result["geoProduct"]["images"] == ["https://brand.example/a.png"]
    assert parse_slice_fragment(display) == {"baseUrl": "https://img.test/a.png#frag", "sliceIndex": 2, "sliceCount": 3}
    assert retrieval[-1]["kind"] == "analysisPrompt"
    assert (
        response.status == 207
        and response.payload["results"][0]["geoProduct"]["name"] == "Golden"
        and response.payload["failures"][0]["error"] == "blocked"
    )


def test_wire_model_recursively_omits_absent_values_without_turning_them_into_null() -> None:
    run = ProductExtractionRun(
        result={"source": "https://example.test/p", "geoProduct": {"name": "Cream", "description": None}},
        diagnostics={"ocr": {"provider": None}},
    )
    assert run.to_wire() == {
        "result": {"source": "https://example.test/p", "geoProduct": {"name": "Cream"}},
        "diagnostics": {"ocr": {}},
    }


@pytest.mark.asyncio
async def test_json_ld_offer_arrays_keep_inline_values_and_resolve_the_first_duplicate_reference() -> None:
    """An inline @id offer is data, while a reference-only @id resolves first-match."""

    inline = await extract_product_from_html(
        """
        <script type="application/ld+json">
        [
          {"@type":"Product","name":"Inline Cream","offers":[
            {"@id":"#inline","@type":"Offer","price":"11","priceCurrency":"USD"},
            {"@id":"#other"}
          ]},
          {"@id":"#inline","@type":"Offer","price":"99","priceCurrency":"USD"}
        ]
        </script><h1>Inline Cream</h1>
        """,
        "https://example.test/products/inline-cream",
    )
    reference = await extract_product_from_html(
        """
        <script type="application/ld+json">
        [
          {"@type":"Product","name":"Reference Cream","offers":[{"@id":"#offer"}]},
          {"@id":"#offer","@type":"Offer","price":"22","priceCurrency":"USD"},
          {"@id":"#offer","@type":"Offer","price":"33","priceCurrency":"USD"}
        ]
        </script><h1>Reference Cream</h1>
        """,
        "https://example.test/products/reference-cream",
    )

    assert inline.result["geoProduct"]["price"] == {"raw": "11", "amount": 11, "currency": "USD"}
    assert reference.result["geoProduct"]["price"] == {"raw": "22", "amount": 22, "currency": "USD"}


@pytest.mark.asyncio
async def test_name_scoring_prefers_handle_aligned_meta_candidate_over_generic_json_ld_name() -> None:
    run = await extract_product_from_html(
        """
        <html><head>
          <meta property="og:title" content="Ultra Repair Serum">
          <script type="application/ld+json">{"@type":"Product","name":"Generic Collection"}</script>
        </head><body><h1>Catalog</h1></body></html>
        """,
        "https://example.test/products/ultra-repair-serum",
    )

    assert run.result["geoProduct"]["name"] == "Ultra Repair Serum"


@pytest.mark.asyncio
async def test_client_state_balanced_assignment_supplies_scoped_product_and_sections() -> None:
    run = await extract_product_from_html(
        """
        <script>
          window.__INITIAL_STATE__ = {
            product: {
              handle: "balanced-serum",
              productName: "Balanced Serum",
              benefits: ["Barrier hydration support"]
            },
            unrelated: { brace: { value: "still balanced" } }
          };
        </script>
        """,
        "https://example.test/products/balanced-serum",
    )
    product = run.result["geoProduct"]

    assert product["name"] == "Balanced Serum"
    assert product["benefits"] == ["Barrier hydration support"]
    assert product["contentAnalysis"]["sections"] == [
        {
            "title": "Benefits",
            "category": "benefit",
            "text": "Barrier hydration support",
            "bullets": ["Barrier hydration support"],
        }
    ]


@pytest.mark.asyncio
async def test_api_nested_product_sections_are_preserved_and_routed_to_fields() -> None:
    run = await extract_product_from_api_payload(
        {
            "product": {
                "name": "Nested Cream",
                "sections": [
                    {"title": "Benefits", "text": "Barrier hydration support"},
                    {"title": "How to Use", "text": "Apply nightly after toner."},
                ],
            }
        },
        "https://example.test/api/products/nested-cream",
    )
    product = run.result["geoProduct"]

    assert "Barrier hydration support" in product["benefits"]
    assert "Apply nightly after toner." in product["usage"]
    assert product["contentAnalysis"]["sections"] == [
        {
            "title": "Benefits",
            "category": "benefit",
            "text": "Barrier hydration support",
            "bullets": ["Barrier hydration support"],
        },
        {
            "title": "How to Use",
            "category": "usage",
            "text": "Apply nightly after toner.",
            "bullets": ["Apply nightly after toner."],
        },
    ]


@pytest.mark.asyncio
async def test_image_urls_follow_whatwg_percent_encoded_serialization() -> None:
    run = await extract_product_from_html(
        '<img src="/images/한 글자.png?label=hello world" alt="detail">',
        "https://brand.example/products/cream",
    )

    assert run.result["geoProduct"]["images"] == [
        "https://brand.example/images/%ED%95%9C%20%EA%B8%80%EC%9E%90.png?label=hello%20world"
    ]


@pytest.mark.asyncio
async def test_source_http_failure_keeps_url_status_and_cleaned_response_body_suffix() -> None:
    async def fetcher(_: str, __: Mapping[str, str]) -> tuple[int, str, str]:
        return 403, "text/html", "  Access\nDenied  "

    with pytest.raises(RuntimeError) as error:
        await extract_product(
            {"sourceType": "url", "source": "https://brand.example/products/blocked"}, {"fetcher": fetcher}
        )

    assert str(error.value) == "Failed to fetch https://brand.example/products/blocked: 403 - Access Denied"

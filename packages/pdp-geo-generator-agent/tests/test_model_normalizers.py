"""Focused contracts for optional product and review-keyword model gates.

The gates are intentionally conservative: a model can organize source-backed
signals, but never introduce a new product claim or turn a review keyword into
an unrelated marketing phrase.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, cast

import httpx
import pytest

from pdp_geo_generator_agent.keyword_normalizer import (
    ModelBackedKeywordNormalizer,
    normalize_product_review_keywords,
)
from pdp_geo_generator_agent.normalization import normalize_pdp_product
from pdp_geo_generator_agent.product_normalizer import (
    PDP_PRODUCT_NORMALIZATION_JSON_SCHEMA,
    ModelBackedProductNormalizer,
    normalize_pdp_product_with_agent,
    product_normalization_rag_priority,
    select_product_normalization_rag_documents,
)
from pdp_geo_generator_agent.service import generate_pdp_geo


def _product() -> dict[str, object]:
    return {
        "name": "Glow Barrier Serum",
        "originalName": "Glow Barrier Serum",
        "description": "Glow Barrier Serum supports hydration for dry skin.",
        "brand": "Neo",
        "category": "Serum",
        "images": [],
        "options": [],
        "benefits": ["hydration"],
        "effects": [],
        "ingredients": ["Ceramide"],
        "usage": ["Apply one pump after cleansing."],
        "metrics": [],
        "faq": [],
        "reviews": {
            "rating": 4.8,
            "reviewCount": 4,
            "items": [{"body": "The texture leaves my skin feeling comfortable.", "rating": 5}],
            "keywords": ["피부걸", "촉촉"],
        },
        "breadcrumbs": [],
        "sourceTexts": [
            "Glow Barrier Serum supports hydration for dry skin.",
            "Ceramide helps support the skin moisture barrier.",
            "Apply one pump after cleansing.",
        ],
        "semanticFacts": {
            "ingredients": ["Ceramide"],
            "benefits": ["hydration"],
            "effects": [],
            "skinTypes": ["dry skin"],
            "usageSteps": ["Apply one pump after cleansing."],
            "safetyTests": [],
            "metricClaims": [],
            "evidenceSentences": [],
            "ingredientBenefitLinks": [],
            "citations": [],
        },
    }


@pytest.mark.parametrize(
    ("locale", "market"),
    [("ko-KR", "KR"), ("ja-JP", "JP"), ("en-US", "US"), ("en-GB", "GB")],
)
def test_deterministic_normalizer_preserves_each_supported_locale_hint(locale: str, market: str) -> None:
    """Only the four retained TypeScript locale values may bypass inference."""

    normalized = normalize_pdp_product(
        {"name": "Glow Barrier Serum", "description": "Hydration for dry skin."},
        {"hints": {"locale": locale}},
    )

    assert normalized["locale"] == locale
    assert normalized["market"] == market


def test_normalizer_prefers_a_specific_title_form_and_keeps_marketing_commands_as_source_only() -> None:
    """A generic category and a call-to-action must not become the canonical public description."""

    imperative = (
        "Hydrate and restore radiance with this powerful yet gentle, dermatologist-tested anti-aging eye cream "
        "formulated for all skin types."
    )
    normalized = normalize_pdp_product(
        {
            "name": "Concentrated Botanical Rejuvenating Eye Cream",
            "category": "Cream",
            "description": imperative,
        },
        {"hints": {"locale": "en-US"}},
    )

    product = normalized["product"]
    assert product["category"] == "Eye Cream"
    assert "description" not in product
    assert imperative in product["sourceTexts"]
    assert not any(
        item["field"] == "product.description" and item["value"] == imperative
        for item in normalized["evidence"]
    )


def test_model_backed_product_normalizer_freezes_the_strict_source_routing_envelope() -> None:
    """Port the TS provider-capture oracle for the normalization stage.

    A provider must receive the full strict patch schema and a bounded,
    field-separated source-routing prompt.  A generic ``product: object``
    response shape lets providers return unbounded echo payloads and loses the
    safety boundary between evidence and a query hypothesis.
    """

    captured: dict[str, object] = {}

    def response(system: str, user: str, schema: object, label: str) -> dict[str, object]:
        captured.update({"system": system, "user": user, "schema": schema, "label": label})
        return {"product": {"name": "Glow Barrier Serum"}, "locale": "en-US", "market": "US", "warnings": []}

    request: dict[str, object] = {
        "rawProduct": {"oversized": "x" * 500},
        "bootstrapProduct": _product(),
        "source": {"url": "https://neo.example/products/glow"},
        "hints": {"brand": "Neo"},
        "fieldMapping": {"benefits": "marketing.benefits"},
        "locale": "en-US",
        "market": "US",
        "analysisPrompt": "p" * 3000,
        "ragDocuments": [{"name": "policy.md", "version": "v1", "content": "r" * 3000}],
    }
    normalizer = ModelBackedProductNormalizer(
        {"provider": "mock", "mockResponse": response, "maxSourceCharacters": 120}
    )

    result = asyncio.run(normalizer.normalize_product(request))
    payload = cast(dict[str, Any], json.loads(str(captured["user"])))
    schema = cast(dict[str, Any], captured["schema"])

    assert result["product"]["name"] == "Glow Barrier Serum"
    assert captured["label"] == "Mock product normalization"
    assert "source assertions, source-backed synthesis, and query hypotheses" in str(captured["system"])
    assert "QUERY_HYPOTHESIS_ONLY" in str(captured["system"])
    assert "Do not create a causal or suitability relationship from co-occurrence" in str(captured["system"])
    assert "Review bodies, review keywords, ratings, testimonials" in str(captured["system"])
    assert list(payload) == [
        "task",
        "inferenceBoundary",
        "source",
        "hints",
        "fieldMapping",
        "locale",
        "market",
        "bootstrapProduct",
        "rawProduct",
        "ragPolicy",
    ]
    assert payload["rawProduct"]["truncated"] is True
    assert len(payload["rawProduct"]["text"]) == 120
    assert payload["rawProduct"]["text"].startswith('{\n  "oversized": "')
    assert payload["ragPolicy"] == [
        {"name": "analysis-prompt", "content": "p" * 2400},
        {"name": "policy.md", "version": "v1", "content": "r" * 2400},
    ]
    assert schema == PDP_PRODUCT_NORMALIZATION_JSON_SCHEMA
    assert schema["additionalProperties"] is False
    assert schema["required"] == ["product", "locale", "market", "warnings"]
    product_schema = cast(dict[str, Any], cast(dict[str, Any], schema["properties"])["product"])
    assert product_schema["additionalProperties"] is False
    assert product_schema["required"] == [
        "name",
        "originalName",
        "description",
        "brand",
        "category",
        "price",
        "images",
        "options",
        "benefits",
        "effects",
        "ingredients",
        "usage",
        "metrics",
        "faq",
        "reviews",
        "breadcrumbs",
        "sourceTexts",
        "semanticFacts",
    ]
    assert product_schema["properties"]["price"]["anyOf"][0]["additionalProperties"] is False
    assert product_schema["properties"]["faq"]["anyOf"][0]["items"]["additionalProperties"] is False
    assert product_schema["properties"]["reviews"]["anyOf"][0]["additionalProperties"] is False
    assert product_schema["properties"]["breadcrumbs"]["anyOf"][0]["items"]["additionalProperties"] is False
    product_properties = cast(dict[str, Any], product_schema["properties"])
    semantic_field = cast(dict[str, Any], product_properties["semanticFacts"])
    semantic_any_of = cast(list[object], semantic_field["anyOf"])
    semantic_schema = cast(dict[str, Any], semantic_any_of[0])
    assert semantic_schema["additionalProperties"] is False
    assert semantic_schema["required"] == [
        "ingredients",
        "benefits",
        "effects",
        "skinTypes",
        "usageSteps",
        "safetyTests",
        "metricClaims",
        "evidenceSentences",
        "ingredientBenefitLinks",
        "citations",
    ]
    assert semantic_schema["properties"]["metricClaims"]["items"]["additionalProperties"] is False
    assert semantic_schema["properties"]["ingredientBenefitLinks"]["items"]["additionalProperties"] is False
    assert semantic_schema["properties"]["citations"]["items"]["additionalProperties"] is False


@pytest.mark.parametrize("provider_name", ["openai", "gemini", "azure-openai", "aistudio"])
def test_model_backed_product_normalizer_keeps_each_provider_strict_schema_route(provider_name: str) -> None:
    """Freeze the four retained provider envelopes at the normalizer boundary."""

    captured: dict[str, Any] = {}
    response: dict[str, Any] = {
        "product": {"name": "Glow Barrier Serum"},
        "locale": "en-US",
        "market": "US",
        "warnings": [],
    }

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content)
        if provider_name == "openai":
            return httpx.Response(200, json={"output": [{"content": [{"text": json.dumps(response)}]}]})
        if provider_name == "gemini":
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": json.dumps(response)}]}}]})
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(response)}}]})

    config: dict[str, object] = {
        "provider": provider_name,
        "apiKey": "key",
        "transport": httpx.MockTransport(handler),
    }
    if provider_name in {"openai", "gemini"}:
        config["model"] = "model/test"
    else:
        config.update({"endpoint": "https://provider.example", "deployment": "reasoning"})
    result = asyncio.run(
        ModelBackedProductNormalizer(config).normalize_product(
            {
                "rawProduct": _product(),
                "bootstrapProduct": _product(),
                "locale": "en-US",
                "market": "US",
                "ragDocuments": [],
            }
        )
    )

    assert result["product"]["name"] == "Glow Barrier Serum"
    if provider_name == "openai":
        assert captured["url"] == "https://api.openai.com/v1/responses"
        assert captured["headers"]["authorization"] == "Bearer key"
        assert captured["body"]["instructions"].startswith("You are a conservative product-data normalization agent")
        assert json.loads(captured["body"]["input"])["task"].startswith("Infer a source-backed")
        assert captured["body"]["text"]["format"] == {
            "type": "json_schema",
            "name": "pdp_product_normalization_patch",
            "strict": True,
            "schema": PDP_PRODUCT_NORMALIZATION_JSON_SCHEMA,
        }
    elif provider_name == "gemini":
        assert captured["url"] == "https://generativelanguage.googleapis.com/v1beta/models/model%2Ftest:generateContent"
        assert captured["headers"]["x-goog-api-key"] == "key"
        assert captured["body"]["systemInstruction"]["parts"][0]["text"].startswith(
            "You are a conservative product-data normalization agent"
        )
        assert json.loads(captured["body"]["contents"][0]["parts"][0]["text"])["task"].startswith("Infer a source-backed")
        assert captured["body"]["generationConfig"]["responseMimeType"] == "application/json"
        assert captured["body"]["generationConfig"]["responseSchema"]["type"] == "OBJECT"
    else:
        expected_url = "https://provider.example/openai/deployments/reasoning/chat/completions"
        if provider_name == "azure-openai":
            expected_url += "?api-version=2025-04-01-preview"
        assert captured["url"] == expected_url
        if provider_name == "aistudio":
            assert captured["headers"]["authorization"] == "Bearer key"
        else:
            assert captured["headers"]["api-key"] == "key"
        assert captured["body"]["messages"][0]["content"].startswith(
            "You are a conservative product-data normalization agent"
        )
        assert json.loads(captured["body"]["messages"][1]["content"])["task"].startswith("Infer a source-backed")
        assert captured["body"]["response_format"] == {
            "type": "json_schema",
            "json_schema": {
                "name": "pdp_product_normalization_patch",
                "strict": True,
                "schema": PDP_PRODUCT_NORMALIZATION_JSON_SCHEMA,
            },
        }


def test_product_normalization_keeps_control_plane_and_rejects_unsupported_patch() -> None:
    class Normalizer:
        def normalize_product(self, request: dict[str, object]) -> dict[str, object]:
            assert request["locale"] == "en-US"
            return {
                "locale": "ko-KR",
                "market": "KR",
                "product": {
                    "description": "Glow Barrier Serum cures acne overnight.",
                    "ingredients": ["Ceramide"],
                    "benefits": ["hydration"],
                },
            }

    result = asyncio.run(
        normalize_pdp_product_with_agent(
            {
                "rawProduct": _product(),
                "bootstrapProduct": _product(),
                "locale": "en-US",
                "market": "US",
                "ragDocuments": [],
            },
            {"customProductNormalizer": Normalizer()},
        )
    )

    assert result["called"] is True
    assert result["product"]["description"] == _product()["description"]
    assert result["product"]["ingredients"] == ["Ceramide"]
    assert result["locale"] == "ko-KR"
    assert result["market"] == "KR"
    assert result["warnings"]


def test_product_normalizer_rejected_authoritative_outcome_patch_preserves_bootstrap_value() -> None:
    """An unsupported model outcome cannot clear a valid extractor/bootstrap fact."""

    bootstrap = {
        **_product(),
        "name": "Calm Serum",
        "benefits": ["skin hydration"],
        "sourceTexts": ["Calm Serum supports skin hydration."],
        "semanticFacts": {**cast(dict[str, object], _product()["semanticFacts"]), "benefits": ["skin hydration"]},
    }

    class Normalizer:
        def normalize_product(self, _request: dict[str, object]) -> dict[str, object]:
            return {"product": {"benefits": ["Cures acne overnight."]}}

    result = asyncio.run(
        normalize_pdp_product_with_agent(
            {
                "rawProduct": bootstrap,
                "bootstrapProduct": bootstrap,
                "locale": "en-US",
                "market": "US",
                "ragDocuments": [],
            },
            {"customProductNormalizer": Normalizer()},
        )
    )

    assert result["product"]["benefits"] == ["skin hydration"]
    assert result["applied"] is False
    assert any("benefits normalization was rejected" in warning for warning in result["warnings"])


def test_model_product_normalizer_preserves_an_explicit_source_procedure_as_atomic_steps() -> None:
    """A model patch cannot merge or omit a complete source-owned routine."""

    source_steps = [
        "1. Dot a small amount of gel across the cheek area.",
        "2. Pat the gel into the skin with clean fingertips.",
        "3. Massage from the centre of the face outward until absorbed.",
    ]
    base_product = _product()
    bootstrap: dict[str, object] = {
        **base_product,
        "name": "Radiance Gel",
        "usage": source_steps,
        "sourceTexts": [*cast(list[str], base_product["sourceTexts"]), *source_steps],
        "semanticFacts": {**cast(dict[str, object], base_product["semanticFacts"]), "usageSteps": source_steps},
    }

    class Normalizer:
        def normalize_product(self, _request: dict[str, object]) -> dict[str, object]:
            return {"product": {"usage": ["Pat the gel into the skin until absorbed."]}}

    result = asyncio.run(
        normalize_pdp_product_with_agent(
            {
                "rawProduct": bootstrap,
                "bootstrapProduct": bootstrap,
                "locale": "en-US",
                "market": "US",
                "ragDocuments": [],
            },
            {"customProductNormalizer": Normalizer()},
        )
    )

    assert result["product"]["usage"] == source_steps
    assert "Model usage normalization was ignored to preserve source instruction boundaries and order." in result["warnings"]


def test_model_product_normalizer_keeps_explicit_source_steps_in_semantic_facts() -> None:
    """The semantic-facts path uses the same atomic source-procedure rule."""

    source_steps = [
        "1. Glide the cream from the centre of the face outward.",
        "2. Cup the face gently with both hands until the cream is absorbed.",
    ]
    base_product = _product()
    bootstrap: dict[str, object] = {
        **base_product,
        "name": "Example Cream",
        "usage": source_steps,
        "sourceTexts": [*cast(list[str], base_product["sourceTexts"]), *source_steps],
        "semanticFacts": {**cast(dict[str, object], base_product["semanticFacts"]), "usageSteps": source_steps},
    }

    class Normalizer:
        def normalize_product(self, _request: dict[str, object]) -> dict[str, object]:
            return {"product": {"semanticFacts": {"usageSteps": source_steps}}}

    result = asyncio.run(
        normalize_pdp_product_with_agent(
            {
                "rawProduct": bootstrap,
                "bootstrapProduct": bootstrap,
                "locale": "en-US",
                "market": "US",
                "ragDocuments": [],
            },
            {"customProductNormalizer": Normalizer()},
        )
    )

    assert result["product"]["semanticFacts"]["usageSteps"] == source_steps


def test_custom_product_normalizer_merges_partial_semantic_patch_without_erasing_bootstrap_roles() -> None:
    """A partial semantic patch must not turn omitted OCR facts into empty arrays."""

    usage_step = "Apply one pump after cleansing."
    relation_sentence = "Ceramide helps support the skin moisture barrier."
    metric_sentence = "In a four-week study, hydration increased by 30%."
    citation_sentence = "A research article titled Barrier Study reports hydration support."
    base_product = _product()
    bootstrap: dict[str, object] = {
        **base_product,
        "sourceTexts": [
            *cast(list[str], base_product["sourceTexts"]),
            "Hypoallergenic tested.",
            "Dermatologist tested.",
            metric_sentence,
            citation_sentence,
        ],
        "semanticFacts": {
            "ingredients": ["Ceramide"],
            "benefits": ["hydration"],
            "effects": ["skin moisture barrier support"],
            "skinTypes": ["dry skin"],
            "usageSteps": [usage_step],
            "safetyTests": ["Hypoallergenic tested."],
            "metricClaims": [{"label": "hydration increased", "sourceText": metric_sentence}],
            "evidenceSentences": [relation_sentence],
            "ingredientBenefitLinks": [
                {
                    "ingredient": "Ceramide",
                    "benefit": "skin moisture barrier",
                    "sourceText": relation_sentence,
                }
            ],
            "citations": [{"type": "research", "title": "Barrier Study", "sourceText": citation_sentence}],
        },
    }

    class Normalizer:
        def normalize_product(self, _request: dict[str, object]) -> dict[str, object]:
            return {"product": {"semanticFacts": {"safetyTests": ["Dermatologist tested."]}}}

    result = asyncio.run(
        normalize_pdp_product_with_agent(
            {
                "rawProduct": bootstrap,
                "bootstrapProduct": bootstrap,
                "locale": "en-US",
                "market": "US",
                "ragDocuments": [],
            },
            {"customProductNormalizer": Normalizer()},
        )
    )

    semantic_facts = result["product"]["semanticFacts"]
    bootstrap_facts = cast(dict[str, object], bootstrap["semanticFacts"])
    assert semantic_facts["safetyTests"] == ["Dermatologist tested."]
    for role in (
        "ingredients",
        "benefits",
        "effects",
        "skinTypes",
        "usageSteps",
        "metricClaims",
        "evidenceSentences",
        "ingredientBenefitLinks",
        "citations",
    ):
        assert semantic_facts[role] == bootstrap_facts[role]


def test_keyword_normalization_accepts_only_safe_high_confidence_source_corrections() -> None:
    class Normalizer:
        def normalize_keywords(self, request: dict[str, object]) -> dict[str, object]:
            assert request["reviewKeywords"] == ["피부걸", "촉촉"]
            return {
                "corrections": [
                    {"original": "피부걸", "normalized": "피부결", "confidence": 0.94, "reason": "typo"},
                    {"original": "촉촉", "normalized": "clinically proven acne cure", "confidence": 0.99},
                ]
            }

    result = asyncio.run(
        normalize_product_review_keywords(_product(), "ko-KR", "KR", {"customKeywordNormalizer": Normalizer()})
    )

    assert result["called"] is True
    assert result["product"]["reviews"]["keywords"] == ["피부결", "촉촉"]
    assert result["evidence"][0]["field"] == "reviews.keywords"


@pytest.mark.parametrize("provider_name", ["openai", "gemini", "azure-openai"])
def test_model_backed_keyword_normalizer_keeps_prompt_json_without_native_structured_output(
    provider_name: str,
) -> None:
    """Keyword normalization relies on its prompted JSON contract, not strict schemas."""

    captured: dict[str, Any] = {}
    response = {
        "corrections": [{"original": "피부걸", "normalized": "피부결", "confidence": 0.94, "reason": "typo"}],
        "warnings": [],
    }
    request = {
        "productName": "Glow Barrier Serum",
        "locale": "ko-KR",
        "market": "KR",
        "reviewKeywords": ["피부걸"],
        "reviewBodies": ["The texture leaves my skin feeling comfortable."],
        "benefits": ["hydration"],
        "effects": [],
        "sourceTexts": ["Glow Barrier Serum supports hydration for dry skin."],
    }

    async def handler(http_request: httpx.Request) -> httpx.Response:
        captured["url"] = str(http_request.url)
        captured["headers"] = dict(http_request.headers)
        captured["body"] = json.loads(http_request.content)
        if provider_name == "openai":
            return httpx.Response(200, json={"output": [{"content": [{"text": json.dumps(response)}]}]})
        if provider_name == "gemini":
            return httpx.Response(
                200,
                json={"candidates": [{"content": {"parts": [{"text": json.dumps(response)}]}}]},
            )
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(response)}}]})

    config: dict[str, object] = {
        "provider": provider_name,
        "apiKey": "key",
        "transport": httpx.MockTransport(handler),
    }
    if provider_name in {"openai", "gemini"}:
        config["model"] = "model/test"
    else:
        config.update({"endpoint": "https://provider.example", "deployment": "reasoning"})

    result = asyncio.run(ModelBackedKeywordNormalizer(config).normalize_keywords(request))

    assert result["corrections"] == response["corrections"]
    expected_prompt = {
        "task": "Normalize only misspelled review keywords. Leave valid keywords unchanged by omitting them from corrections.",
        "productName": "Glow Barrier Serum",
        "locale": "ko-KR",
        "market": "KR",
        "reviewKeywords": ["피부걸"],
        "context": {
            "reviewBodies": ["The texture leaves my skin feeling comfortable."],
            "benefits": ["hydration"],
            "effects": [],
            "sourceTexts": ["Glow Barrier Serum supports hydration for dry skin."],
        },
    }
    body = captured["body"]

    if provider_name == "openai":
        assert captured["url"] == "https://api.openai.com/v1/responses"
        assert captured["headers"]["authorization"] == "Bearer key"
        assert json.loads(body["input"]) == expected_prompt
        assert "text" not in body
    elif provider_name == "gemini":
        assert captured["url"] == "https://generativelanguage.googleapis.com/v1beta/models/model%2Ftest:generateContent"
        assert captured["headers"]["x-goog-api-key"] == "key"
        assert json.loads(body["contents"][0]["parts"][0]["text"]) == expected_prompt
        assert "generationConfig" not in body
    else:
        assert captured["url"] == (
            "https://provider.example/openai/deployments/reasoning/chat/completions?api-version=2025-04-01-preview"
        )
        assert captured["headers"]["api-key"] == "key"
        assert json.loads(body["messages"][1]["content"]) == expected_prompt
        assert "response_format" not in body


def test_product_normalization_rag_selection_reserves_reasoning_spine_and_priority() -> None:
    documents = [
        {"name": "brands/neo/brand-identity_v1.md", "content": "brand"},
        {"name": "content-field-contracts_v1.md", "content": "contracts"},
        {"name": "analysis-prompt_v1.md", "content": "analysis"},
        {"name": "geo-research_v3.md", "content": "geo"},
        {"name": "eeat_v1.md", "content": "eeat"},
        {"name": "cep_v1.md", "content": "cep"},
    ]

    selected = select_product_normalization_rag_documents(documents, 3)
    assert [item["name"] for item in selected] == ["geo-research_v3.md", "eeat_v1.md", "cep_v1.md"]
    assert product_normalization_rag_priority("content-field-contracts_v1.md") == 79
    assert product_normalization_rag_priority("some-unrecognized-custom-document.md") == 115


def test_model_backed_product_normalizer_retries_one_malformed_provider_response() -> None:
    """A malformed provider payload remains observable long enough to retry.

    The retained TypeScript adapter parses each provider response before its
    structured patch coercion.  Keep that ordering here: an empty mapping is a
    valid no-op patch, while unparseable provider text earns one corrective
    request and the public recovery warning.
    """

    requests: list[httpx.Request] = []
    responses = iter(
        (
            {"output_text": "not-json"},
            {
                "output_text": json.dumps(
                    {"product": {}, "locale": "en-US", "market": "US", "warnings": []}
                )
            },
        )
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=next(responses))

    product = _product()
    result = asyncio.run(
        normalize_pdp_product_with_agent(
            {"rawProduct": product, "bootstrapProduct": product, "locale": "en-US", "market": "US"},
            {
                "productNormalization": {
                    "enabled": True,
                    "provider": "openai",
                    "apiKey": "key",
                    "model": "test-model",
                    "transport": httpx.MockTransport(handler),
                }
            },
        )
    )

    assert len(requests) == 2
    assert "CORRECTIVE_STRUCTURED_RETRY" in json.loads(requests[1].content)["input"]
    assert result["warnings"] == ["Product normalization recovered after one corrective structured retry."]


def test_generator_wires_optional_normalizers_before_rag_and_keeps_requested_locale_market() -> None:
    calls: list[str] = []

    class ProductNormalizer:
        def normalize_product(self, request: dict[str, object]) -> dict[str, object]:
            calls.append("product")
            assert request["bootstrapProduct"]
            assert request["ragDocuments"]
            return {"product": {"benefits": ["hydration"]}, "locale": "ko-KR", "market": "KR"}

    class KeywordNormalizer:
        def normalize_keywords(self, request: dict[str, object]) -> dict[str, object]:
            calls.append("keyword")
            assert request["locale"] == "en-US"
            assert request["market"] == "US"
            return {"corrections": [{"original": "피부걸", "normalized": "피부결", "confidence": 0.95}]}

    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "name": "Glow Barrier Serum",
                    "description": "Glow Barrier Serum supports hydration for dry skin.",
                    "benefits": ["hydration"],
                    "reviews": {"keywords": ["피부걸"]},
                },
                "hints": {"locale": "en-US", "market": "US"},
            },
            {"customProductNormalizer": ProductNormalizer(), "customKeywordNormalizer": KeywordNormalizer()},
        )
    )

    assert calls == ["product", "keyword"]
    assert run["result"]["locale"] == "en-US"
    assert run["result"]["market"] == "US"
    assert run["diagnostics"]["normalizedProduct"]["reviews"]["keywords"] == ["피부결"]


def test_generator_does_not_report_warning_only_keyword_normalization_as_a_correction() -> None:
    """A provider warning is evidence of review, not an applied keyword correction."""

    class KeywordNormalizer:
        def normalize_keywords(self, _request: dict[str, object]) -> dict[str, object]:
            return {"corrections": [], "warnings": ["No source-backed correction was accepted."]}

    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "name": "Glow Barrier Serum",
                    "description": "Glow Barrier Serum supports hydration for dry skin.",
                    "benefits": ["hydration"],
                    "reviews": {"keywords": ["피부걸"]},
                },
                "hints": {"locale": "en-US", "market": "US"},
            },
            {"customKeywordNormalizer": KeywordNormalizer()},
        )
    )

    normalize_step = next(step for step in run["process"] if step["id"] == "normalize")
    assert "리뷰 키워드 오타 후보를 보정" not in normalize_step["message"]
    assert run["diagnostics"]["normalizedProduct"]["reviews"]["keywords"] == ["피부걸"]


def test_generator_runtime_usage_names_a_custom_normalizer_instead_of_a_mock_final_model() -> None:
    """Diagnostics must identify the exact model/custom stage that actually ran."""

    class ProductNormalizer:
        def normalize_product(self, _request: dict[str, object]) -> dict[str, object]:
            return {"product": {"benefits": ["hydration"]}}

    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "name": "Glow Barrier Serum",
                    "description": "Glow Barrier Serum supports hydration for dry skin.",
                    "benefits": ["hydration"],
                },
                "hints": {"locale": "en-US", "market": "US"},
            },
            {"customProductNormalizer": ProductNormalizer()},
        )
    )

    steps = cast(list[dict[str, object]], run["diagnostics"]["runtimeUsage"]["steps"])
    product_normalization = next(step for step in steps if step["stage"] == "product-normalization")

    assert product_normalization["called"] is True
    assert product_normalization["provider"] == "custom"
    assert product_normalization["service"] == "customProductNormalizer"
    assert not any(step["label"] == "Final classification/reasoning" and step["called"] is True for step in steps)


def test_product_normalizer_accepts_name_only_breadcrumbs_but_requires_explicit_ingredient_relation() -> None:
    class Normalizer:
        def normalize_product(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "product": {
                    "breadcrumbs": [{"name": "Skin care"}],
                    "semanticFacts": {
                        "ingredients": [],
                        "benefits": [],
                        "effects": [],
                        "skinTypes": [],
                        "usageSteps": [],
                        "safetyTests": [],
                        "metricClaims": [],
                        "evidenceSentences": [],
                        "ingredientBenefitLinks": [
                            {
                                "ingredient": "Ceramide",
                                "benefit": "hydration",
                                "sentence": "Ceramide is present.",
                                "sourceText": "Ceramide is present.",
                            }
                        ],
                        "citations": [],
                    },
                }
            }

    product = _product()
    product["breadcrumbs"] = []
    product["sourceTexts"] = ["Skin care", "Ceramide is present.", "Hydration is important."]
    result = asyncio.run(
        normalize_pdp_product_with_agent(
            {"rawProduct": product, "bootstrapProduct": product, "locale": "en-US", "market": "US"},
            {"customProductNormalizer": Normalizer()},
        )
    )

    assert result["product"]["breadcrumbs"] == [{"name": "Skin care"}]
    assert result["product"].get("semanticFacts", {}).get("ingredientBenefitLinks", []) == []


def test_product_normalizer_preserves_every_source_backed_model_relation() -> None:
    """Model normalization must not silently truncate valid source relations."""

    links = [
        {
            "ingredient": f"Ingredient {index}",
            "benefit": f"outcome {index}",
            "sourceText": f"Ingredient {index} supports outcome {index}.",
        }
        for index in range(1, 26)
    ]

    class Normalizer:
        def normalize_product(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "product": {
                    "semanticFacts": {
                        "ingredients": [item["ingredient"] for item in links],
                        "benefits": [item["benefit"] for item in links],
                        "effects": [],
                        "skinTypes": [],
                        "usageSteps": [],
                        "safetyTests": [],
                        "metricClaims": [],
                        "evidenceSentences": [],
                        "ingredientBenefitLinks": links,
                        "citations": [],
                    }
                }
            }

    product = _product()
    product.update(
        {
            "ingredients": [item["ingredient"] for item in links],
            "benefits": [item["benefit"] for item in links],
            "sourceTexts": [item["sourceText"] for item in links],
        }
    )
    result = asyncio.run(
        normalize_pdp_product_with_agent(
            {"rawProduct": product, "bootstrapProduct": product, "locale": "en-US", "market": "US"},
            {"customProductNormalizer": Normalizer()},
        )
    )

    accepted = result["product"]["semanticFacts"]["ingredientBenefitLinks"]
    assert len(accepted) == 25
    assert accepted[-1]["ingredient"] == "Ingredient 25"


def test_product_normalizer_does_not_report_commerce_or_usage_as_accepted_outcomes() -> None:
    """Source overlap is insufficient when a model routes a commercial or procedural line to efficacy."""

    class Normalizer:
        def normalize_product(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "product": {
                    "benefits": ["Free shipping."],
                    "effects": ["Supports easy returns.", "Apply daily to improve softness."],
                }
            }

    product = _product()
    product.update(
        {
            "benefits": [],
            "effects": [],
            "sourceTexts": ["Free shipping.", "Supports easy returns.", "Apply daily to improve softness."],
        }
    )
    result = asyncio.run(
        normalize_pdp_product_with_agent(
            {"rawProduct": product, "bootstrapProduct": product, "locale": "en-US", "market": "US"},
            {"customProductNormalizer": Normalizer()},
        )
    )

    assert result["product"]["benefits"] == []
    assert result["product"]["effects"] == []
    assert any("role-coherent" in warning for warning in result["warnings"])
    assert not any(
        item["value"].startswith("Model-backed product normalization updated:")
        for item in result["evidence"]
    )


def test_product_normalizer_keeps_source_identity_and_only_accepts_direct_source_faq_pairs() -> None:
    """A fuzzy title or a recombined Q/A must not replace directly sourced product facts."""

    source_name = "Concentrated Botanical Rejuvenating Serum"
    direct_pair = {
        "question": "When should I apply this serum?",
        "answer": "Apply one pump after cleansing.",
    }
    separate_pair = {
        "question": "What finish does the serum leave?",
        "answer": "It leaves a soft, comfortable finish.",
    }
    bootstrap: dict[str, object] = {
        **_product(),
        "name": source_name,
        "originalName": source_name,
        "category": "Serum",
        "faq": [],
    }
    raw_product = {**bootstrap, "faq": [direct_pair, separate_pair]}

    class Normalizer:
        def normalize_product(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "product": {
                    "name": f"{source_name} serum",
                    "faq": [
                        direct_pair,
                        {"question": direct_pair["question"], "answer": separate_pair["answer"]},
                        {"question": 4, "answer": 5},
                    ],
                }
            }

    result = asyncio.run(
        normalize_pdp_product_with_agent(
            {"rawProduct": raw_product, "bootstrapProduct": bootstrap, "locale": "en-US", "market": "US"},
            {"customProductNormalizer": Normalizer()},
        )
    )

    assert result["product"]["name"] == source_name
    assert result["product"]["faq"] == [direct_pair]
    assert "Model name normalization was rejected because it was not source-backed." in result["warnings"]


def test_product_normalizer_accepts_a_normalized_direct_source_title_variant() -> None:
    """A directly sourced multilingual/size title remains a valid identity variant."""

    source_name = "Concentrated Botanical Rejuvenating Serum"
    source_variant = "자음생세럼 Concentrated Botanical Rejuvenating Serum 60 mL"
    bootstrap = {**_product(), "name": source_name, "originalName": source_name, "category": "Serum"}
    raw_product = {**bootstrap, "productName": source_variant}

    class Normalizer:
        def normalize_product(self, _request: dict[str, object]) -> dict[str, object]:
            return {"product": {"name": source_variant}}

    result = asyncio.run(
        normalize_pdp_product_with_agent(
            {"rawProduct": raw_product, "bootstrapProduct": bootstrap, "locale": "en-US", "market": "US"},
            {"customProductNormalizer": Normalizer()},
        )
    )

    assert result["product"]["name"] == source_variant

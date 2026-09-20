"""Integration contracts for the retained product-normalizer adapter."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

import httpx
import pytest

from pdp_extractor_agent.normalizer import (
    ModelBackedProductProfileNormalizer,
    create_product_profile_normalization_prompt,
    normalize_extractor_product_profile_with_agent,
)

_NORMALIZER_SYSTEM = "system=\ud800"
_NORMALIZER_USER = "user=한😀"


class _NormalizerWireProbe(ModelBackedProductProfileNormalizer):
    """Exercise protected provider adapters through a typed test-only boundary."""

    async def normalize_openai_wire(self, prompt: Mapping[str, str]) -> dict[str, Any]:
        return await self._normalize_openai(prompt)

    async def normalize_gemini_wire(self, prompt: Mapping[str, str]) -> dict[str, Any]:
        return await self._normalize_gemini(prompt)

    async def normalize_azure_wire(self, prompt: Mapping[str, str]) -> dict[str, Any]:
        return await self._normalize_azure(prompt)


def _request() -> dict[str, Any]:
    return {
        "source": "https://example.test/products/barrier",
        "sourceType": "url",
        "bootstrapProduct": {"name": "Barrier Cream"},
        "rawSource": {"name": "Barrier Cream"},
    }


@pytest.mark.asyncio
async def test_model_backed_normalizer_posts_javascript_json_bytes_for_each_provider() -> None:
    """Each retained normalizer adapter must preserve JSON.stringify's surrogate and number wire."""

    requests: list[bytes] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.content)
        if "openai.com" in request.url.host:
            return httpx.Response(200, json={"output_text": "{}"})
        if "googleapis.com" in request.url.host:
            return httpx.Response(200, json={"candidates": []})
        return httpx.Response(200, json={"choices": []})

    prompt = {"system": _NORMALIZER_SYSTEM, "user": _NORMALIZER_USER}
    transport = httpx.MockTransport(handler)
    await _NormalizerWireProbe(
        {"provider": "openai", "apiKey": "key", "model": "gpt", "transport": transport}
    ).normalize_openai_wire(prompt)
    await _NormalizerWireProbe(
        {"provider": "gemini", "apiKey": "key", "model": "gemini", "transport": transport}
    ).normalize_gemini_wire(prompt)
    await _NormalizerWireProbe(
        {
            "provider": "azure-openai",
            "apiKey": "key",
            "endpoint": "https://azure.example",
            "deployment": "reasoning",
            "temperature": -0.0,
            "transport": transport,
        }
    ).normalize_azure_wire(prompt)

    assert requests == [
        b'{"model":"gpt","instructions":"system=\\ud800","input":"user=\xed\x95\x9c\xf0\x9f\x98\x80"}',
        b'{"systemInstruction":{"parts":[{"text":"system=\\ud800"}]},"contents":[{"role":"user","parts":[{"text":"user=\xed\x95\x9c\xf0\x9f\x98\x80"}]}]}',
        b'{"messages":[{"role":"system","content":"system=\\ud800"},{"role":"user","content":"user=\xed\x95\x9c\xf0\x9f\x98\x80"}],"temperature":0}',
    ]


@pytest.mark.asyncio
async def test_normalizer_resolves_azure_settings_with_nullish_deployment_and_outer_temperature() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"product":{}}'}}]})

    await normalize_extractor_product_profile_with_agent(
        _request(),
        {
            "provider": "mock",
            "apiKey": "outer-key",
            "endpoint": "https://azure.example/",
            "deployment": "outer-deployment",
            "deployments": {"reasoning": "reasoning-deployment"},
            "apiVersion": "outer-version",
            "temperature": 0,
            "transport": httpx.MockTransport(handler),
            "productNormalization": {
                "enabled": True,
                "provider": "azure-openai",
                "apiKey": "settings-key",
                "endpoint": "https://settings.azure.example/",
                "apiVersion": "",
            },
        },
    )

    assert seen["url"] == (
        "https://settings.azure.example/openai/deployments/reasoning-deployment/chat/completions?api-version="
    )
    assert seen["body"]["temperature"] == 0


@pytest.mark.asyncio
async def test_normalizer_gemini_omits_temperature() -> None:
    calls = 0
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": '{"product":{}}'}]}}]},
        )

    transport = httpx.MockTransport(handler)
    await ModelBackedProductProfileNormalizer(
        {"provider": "gemini", "apiKey": "key", "model": "gemini", "temperature": 0.7, "transport": transport}
    ).normalize_product_profile(_request())
    assert "temperature" not in seen["body"]

    assert calls == 1


@pytest.mark.asyncio
async def test_normalizer_aistudio_dispatches_source_backed_output_through_configured_runtime() -> None:
    """Configured AI Studio normalization must make the model call rather than report a skipped adapter."""

    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["authorization"] = request.headers.get("authorization")
        seen["api_key"] = request.headers.get("api-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "product": {
                                        "description": "Barrier Cream supports a healthy moisture barrier."
                                    }
                                }
                            )
                        }
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
            },
        )

    result = await normalize_extractor_product_profile_with_agent(
        {
            "source": "https://example.test/products/barrier",
            "sourceType": "url",
            "bootstrapProduct": {"name": "Barrier Cream"},
            "rawSource": "Barrier Cream supports a healthy moisture barrier.",
        },
        {
            "provider": "aistudio",
            "apiKey": "test-key",
            "endpoint": "https://studio.example/agent/",
            "deployments": {"reasoning": "gpt-5.5"},
            "apiVersion": " 2025/01 beta ",
            "temperature": 0,
            "transport": httpx.MockTransport(handler),
            "productNormalization": {"enabled": True},
        },
    )

    assert result["warnings"] == []
    assert result["called"] is True
    assert result["applied"] is True
    assert result["product"]["description"] == "Barrier Cream supports a healthy moisture barrier."
    assert result["usage"] == {"inputTokens": 5, "outputTokens": 3, "totalTokens": 8}
    assert seen["url"] == (
        "https://studio.example/agent/openai/deployments/gpt-5.5/chat/completions?api-version=2025%2F01%20beta"
    )
    assert seen["authorization"] == "Bearer test-key"
    assert seen["api_key"] is None
    assert seen["body"]["temperature"] == 0


@pytest.mark.asyncio
async def test_openai_normalizer_parses_output_envelope_but_keeps_the_raw_response_text() -> None:
    """TS parses ``output_text`` while exposing the original OpenAI response as rawText."""

    payload = {
        "output_text": '{"product":{"name":"Barrier Cream"},"warnings":["Model note"]}',
        "usage": {"input_tokens": 5, "output_tokens": 3, "total_tokens": 8},
    }

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=json.dumps(payload))

    result = await ModelBackedProductProfileNormalizer(
        {"provider": "openai", "apiKey": "key", "model": "gpt", "transport": httpx.MockTransport(handler)}
    ).normalize_product_profile(_request())

    assert result["product"] == {"name": "Barrier Cream"}
    assert result["warnings"] == ["Model note"]
    assert json.loads(result["rawText"]) == payload
    assert result["usage"] == {"inputTokens": 5, "outputTokens": 3, "totalTokens": 8}


@pytest.mark.asyncio
async def test_normalizer_reports_braced_provider_json_as_malformed_without_losing_the_envelope() -> None:
    """A braced-but-invalid nested response differs from an absent model object."""

    payload = {"output_text": '{"product": }'}

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=json.dumps(payload))

    result = await ModelBackedProductProfileNormalizer(
        {"provider": "openai", "apiKey": "key", "model": "gpt", "transport": httpx.MockTransport(handler)}
    ).normalize_product_profile(_request())

    assert result == {
        "warnings": ["Product profile normalization JSON could not be parsed."],
        "rawText": json.dumps(payload),
    }


@pytest.mark.asyncio
async def test_normalizer_accepts_short_source_backed_metric_claims() -> None:
    """TS gives metrics the deliberate short-overlap exception used for percentages."""

    class Normalizer:
        async def normalize_product_profile(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {"product": {"metrics": ["84%"]}}

    result = await normalize_extractor_product_profile_with_agent(
        {
            "source": "https://example.test/products/barrier",
            "sourceType": "url",
            "bootstrapProduct": {"name": "Barrier Cream", "metrics": [], "contentSections": []},
            "rawSource": "Clinical testing found that 84% of users reported stronger barrier support.",
        },
        {"customProductNormalizer": Normalizer()},
    )

    assert result["product"]["metrics"] == ["84%"]


@pytest.mark.asyncio
async def test_normalizer_accepts_short_metric_token_overlap_without_exact_substring() -> None:
    """The metric exception accepts ``84% users`` from ``84% of users`` evidence."""

    class Normalizer:
        async def normalize_product_profile(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {"product": {"metrics": ["84% users"]}}

    result = await normalize_extractor_product_profile_with_agent(
        {
            "source": "https://example.test/products/barrier",
            "sourceType": "url",
            "bootstrapProduct": {"name": "Barrier Cream", "metrics": [], "contentSections": []},
            "rawSource": "Clinical testing found that 84% of users reported stronger barrier support.",
        },
        {"customProductNormalizer": Normalizer()},
    )

    assert result["product"]["metrics"] == ["84% users"]


@pytest.mark.asyncio
async def test_normalizer_uses_js_utf16_length_for_short_source_backed_overlap() -> None:
    """A supplementary-plane character makes this 12 JS units, not 11 Python points."""

    class Normalizer:
        async def normalize_product_profile(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {"product": {"description": "aa bb cc X😀"}}

    result = await normalize_extractor_product_profile_with_agent(
        {
            "source": "https://example.test/products/barrier",
            "sourceType": "url",
            "bootstrapProduct": {"name": "Barrier Cream"},
            "rawSource": "aa bb cc Y",
        },
        {"customProductNormalizer": Normalizer()},
    )

    assert result["product"]["description"] == "aa bb cc X😀"


def test_normalizer_policy_slices_are_utf16_and_json_safe_at_a_split_surrogate() -> None:
    """JS ``slice(0, 2400)`` retains a lone high surrogate, escaped in JSON."""

    edge = "a" * 2399 + "😀" + "Z"
    prompt = create_product_profile_normalization_prompt(
        {
            "source": "https://example.test/products/barrier",
            "sourceType": "url",
            "bootstrapProduct": {"name": "Barrier Cream"},
            "rawSource": {"value": "source"},
            "analysisPrompt": edge,
            "ragDocuments": [{"name": "policy.md", "version": "v1", "content": edge}],
        }
    )
    payload = json.loads(prompt["user"])
    expected = "a" * 2399 + "\ud83d"

    assert payload["ragPolicy"][0]["content"] == expected
    assert payload["ragPolicy"][1]["content"] == expected
    assert "\\ud83d" in prompt["user"]
    assert "�" not in prompt["user"]


@pytest.mark.asyncio
async def test_normalizer_applies_source_backed_content_sections() -> None:
    """Model-backed content sections remain public ProductProfile data, not dropped metadata."""

    class Normalizer:
        async def normalize_product_profile(self, _request: dict[str, Any]) -> dict[str, Any]:
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

    result = await normalize_extractor_product_profile_with_agent(
        {
            "source": "https://example.test/products/barrier",
            "sourceType": "url",
            "bootstrapProduct": {"name": "Barrier Cream", "metrics": [], "contentSections": []},
            "rawSource": "How to use: Apply two pumps morning and night after toner.",
        },
        {"customProductNormalizer": Normalizer()},
    )

    assert result["product"]["contentSections"] == [
        {
            "title": "How to use",
            "category": "usage",
            "text": "Apply two pumps morning and night after toner.",
            "bullets": ["Apply two pumps morning and night after toner."],
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "config", "label", "expected_timeout"),
    [
        ("openai", {"apiKey": "key", "model": "gpt"}, "OpenAI product profile normalization", 900),
        ("gemini", {"apiKey": "key", "model": "gemini"}, "Gemini product profile normalization", 900),
        (
            "azure-openai",
            {"apiKey": "key", "endpoint": "https://azure.example", "deployment": "reasoning"},
            "Azure product profile normalization",
            900,
        ),
        (
            "aistudio",
            {"apiKey": "key", "endpoint": "https://studio.example", "deployment": "reasoning"},
            "AI Studio product profile normalization",
            900,
        ),
        (
            "aistudio",
            {
                "apiKey": "key",
                "endpoint": "https://studio.example",
                "deployment": "reasoning",
                "timeoutSeconds": 960,
            },
            "AI Studio product profile normalization",
            960,
        ),
    ],
)
async def test_normalizer_timeout_uses_stable_provider_label(
    provider: str, config: dict[str, Any], label: str, expected_timeout: int
) -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("stalled")

    normalizer = ModelBackedProductProfileNormalizer(
        {"provider": provider, **config, "transport": httpx.MockTransport(handler)}
    )
    with pytest.raises(RuntimeError, match=rf"{label} timed out after {expected_timeout}s\."):
        await normalizer.normalize_product_profile(_request())


@pytest.mark.asyncio
async def test_normalizer_keeps_source_identity_and_only_accepts_direct_source_faq_pairs() -> None:
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

    class Normalizer:
        async def normalize_product_profile(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {
                "product": {
                    "name": f"{source_name} serum",
                    "faq": [
                        direct_pair,
                        {"question": direct_pair["question"], "answer": separate_pair["answer"]},
                    ],
                }
            }

    result = await normalize_extractor_product_profile_with_agent(
        {
            "source": "https://example.test/products/concentrated-ginseng-rejuvenating-serum",
            "sourceType": "url",
            "bootstrapProduct": {"name": source_name, "faq": []},
            "rawSource": {"name": source_name, "category": "Serum", "faq": [direct_pair, separate_pair]},
        },
        {"customProductNormalizer": Normalizer()},
    )

    assert result["product"]["name"] == source_name
    assert result["product"]["faq"] == [direct_pair]
    assert "Model name normalization was rejected because it was not source-backed." in result["warnings"]


@pytest.mark.asyncio
async def test_normalizer_accepts_a_normalized_direct_source_title_variant() -> None:
    """A directly sourced multilingual/size title remains a valid identity variant."""

    source_name = "Concentrated Botanical Rejuvenating Serum"
    source_variant = "자음생세럼 Concentrated Botanical Rejuvenating Serum 60 mL"

    class Normalizer:
        async def normalize_product_profile(self, _request: dict[str, Any]) -> dict[str, Any]:
            return {"product": {"name": source_variant}}

    result = await normalize_extractor_product_profile_with_agent(
        {
            "source": "https://example.test/products/concentrated-ginseng-rejuvenating-serum",
            "sourceType": "url",
            "bootstrapProduct": {"name": source_name},
            "rawSource": {"productName": source_variant},
        },
        {"customProductNormalizer": Normalizer()},
    )

    assert result["product"]["name"] == source_variant

"""Provider wire-contract tests for the Python generator migration.

These tests intentionally exercise the adapter boundary over ``httpx`` rather
than a vendor SDK.  Each expectation corresponds to a request/response detail
that the retained TypeScript generator relies on.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
from typing import Any

import httpx
import pytest

from pdp_geo_generator_agent.providers import (
    AistudioProvider,
    AzureOpenAIProvider,
    DeterministicMockTransport,
    GeminiProvider,
    MockProvider,
    OpenAIProvider,
    create_provider,
)
from pdp_geo_generator_agent.providers.transport import (
    ProviderResult,
    post_json_with_temperature_fallback,
    resolve_generation_request,
    retry_transient_once,
    to_gemini_schema,
)

_SCHEMA = {
    "type": "object",
    "description": "A structured answer.",
    "additionalProperties": False,
    "properties": {"answer": {"type": "string", "description": "public copy"}},
    "required": ["answer"],
}


def test_stage_payload_uses_pinned_node24_json_stringify_text() -> None:
    """The nested provider prompt payload preserves legacy JSON.stringify text.

    Captured with Node v24.11.0 ``JSON.stringify`` from the retained generator
    source baseline (origin/main, 6702158280ec7de675594af93c7c381eb2feae38).
    """

    request = resolve_generation_request(
        "OpenAI",
        "system",
        None,
        _SCHEMA,
        None,
        stage="copy-refinement",
        payload={
            "10": "ten",
            "2": "two",
            "zero": -0.0,
            "small": 1e-6,
            "large": 1e20,
            "nan": math.nan,
            "lone": "x\ud800",
            "integral": 4.0,
        },
    )

    expected = (
        '{"2":"two","10":"ten","zero":0,"small":0.000001,'
        '"large":100000000000000000000,"nan":null,"lone":"x\\ud800","integral":4}'
    )
    assert request.user == expected
    assert hashlib.sha256(request.user.encode("utf-8")).hexdigest() == "b7edbc388482f9ba77148f42b1bf1da1eec006929d61d0699abeeb0d14c1ff97"


@pytest.mark.asyncio
async def test_common_provider_transport_replays_pinned_node24_bytes_when_temperature_is_rejected() -> None:
    """Retry strips only temperature and retains source-compatible bytes.

    The two base64 literals were captured with Node v24.11.0
    ``JSON.stringify`` from the retained generator source baseline
    (origin/main, 6702158280ec7de675594af93c7c381eb2feae38).
    """

    calls: list[tuple[str, str | None, str | None, bytes]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(
            (
                str(request.url),
                request.headers.get("content-type"),
                request.headers.get("x-provider-key"),
                request.content,
            )
        )
        if len(calls) == 1:
            return httpx.Response(400, text="Unsupported value for temperature; only the default is accepted")
        return httpx.Response(200, json={"ok": True})

    result = await post_json_with_temperature_fallback(
        "https://provider.example.test/v1/generate",
        {"X-Provider-Key": "secret"},
        {
            "10": "ten",
            "2": "two",
            "temperature": -0.0,
            "small": 1e-6,
            "large": 1e20,
            "nan": math.nan,
            "positive": math.inf,
            "negative": -math.inf,
            "text": "한글😀x\ud800",
            "nested": [{"10": "child ten", "2": "child two", "value": -0.0}, [1e-6, math.nan, "끝"]],
        },
        "OpenAI planning",
        transport=httpx.MockTransport(handler),
    )

    expected_bodies = [
        base64.b64decode(
            "eyIyIjoidHdvIiwiMTAiOiJ0ZW4iLCJ0ZW1wZXJhdHVyZSI6MCwic21hbGwiOjAuMDAwMDAxLCJsYXJnZSI6MTAwMDAwMDAwMDAwMDAwMDAwMDAwLCJuYW4iOm51bGwsInBvc2l0aXZlIjpudWxsLCJuZWdhdGl2ZSI6bnVsbCwidGV4dCI6Iu2VnOq4gPCfmIB4XHVkODAwIiwibmVzdGVkIjpbeyIyIjoiY2hpbGQgdHdvIiwiMTAiOiJjaGlsZCB0ZW4iLCJ2YWx1ZSI6MH0sWzAuMDAwMDAxLG51bGwsIuuBnSJdXX0="
        ),
        base64.b64decode(
            "eyIyIjoidHdvIiwiMTAiOiJ0ZW4iLCJzbWFsbCI6MC4wMDAwMDEsImxhcmdlIjoxMDAwMDAwMDAwMDAwMDAwMDAwMDAsIm5hbiI6bnVsbCwicG9zaXRpdmUiOm51bGwsIm5lZ2F0aXZlIjpudWxsLCJ0ZXh0Ijoi7ZWc6riA8J+YgHhcdWQ4MDAiLCJuZXN0ZWQiOlt7IjIiOiJjaGlsZCB0d28iLCIxMCI6ImNoaWxkIHRlbiIsInZhbHVlIjowfSxbMC4wMDAwMDEsbnVsbCwi64GdIl1dfQ=="
        ),
    ]
    assert result == {"ok": True}
    assert calls == [
        ("https://provider.example.test/v1/generate", "application/json", "secret", expected_bodies[0]),
        ("https://provider.example.test/v1/generate", "application/json", "secret", expected_bodies[1]),
    ]
    assert [hashlib.sha256(body).hexdigest() for body in expected_bodies] == [
        "4e1bd2faa8b108a23c64e8bb0c3833032a5e31e00c9351adb90d1ba08352ffb0",
        "9ef976cd589f638c61aa80dad715e3bf585a346c4dcc445b9d038078ed4ca269",
    ]


@pytest.mark.asyncio
async def test_legacy_provider_method_aliases_preserve_declared_method_identity_and_calls() -> None:
    """Legacy camelCase members must remain real, typed provider methods.

    The retained TypeScript public surface exposes these spellings.  Keeping
    the class attributes identical to their Python-native methods preserves
    both descriptor binding and every existing call signature.
    """

    assert OpenAIProvider.generateJson is OpenAIProvider.generate_json
    assert OpenAIProvider.generateText is OpenAIProvider.generate_text
    assert GeminiProvider.generateJson is GeminiProvider.generate_json
    assert GeminiProvider.generateText is GeminiProvider.generate_text
    assert MockProvider.generateJson is MockProvider.generate_json
    assert MockProvider.generateText is MockProvider.generate_text
    assert AzureOpenAIProvider.generateJson is AzureOpenAIProvider.generate_json
    assert AzureOpenAIProvider.generateText is AzureOpenAIProvider.generate_text
    assert AzureOpenAIProvider.chatCompletionsUrl is AzureOpenAIProvider.chat_completions_url
    assert AzureOpenAIProvider.deploymentFor is AzureOpenAIProvider.deployment_for
    assert AistudioProvider.chatCompletionsUrl is AistudioProvider.chat_completions_url

    provider = MockProvider({"answer": "legacy"})
    structured = await provider.generateJson("system", "facts", _SCHEMA, "plan")
    plain = await provider.generateText("system", "facts")

    assert structured.data == {"answer": "legacy"}
    assert plain.data == {"answer": "legacy"}


@pytest.mark.asyncio
async def test_openai_responses_request_carries_strict_schema_and_parses_usage() -> None:
    """Removing strict Responses request fields would silently weaken stage contracts."""

    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["authorization"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "output": [{"content": [{"text": '{"answer":"source-backed"}'}]}],
                "usage": {"input_tokens": 11, "output_tokens": 7, "total_tokens": 18},
            },
        )

    result = await OpenAIProvider(
        api_key="openai-key", model="gpt-test", transport=httpx.MockTransport(handler)
    ).generate_json("system policy", "product facts", _SCHEMA, "pdp_geo_content_plan", label="OpenAI planning")

    assert seen == {
        "url": "https://api.openai.com/v1/responses",
        "authorization": "Bearer openai-key",
        "body": {
            "model": "gpt-test",
            "instructions": "system policy",
            "input": "product facts",
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "pdp_geo_content_plan",
                    "strict": True,
                    "schema": _SCHEMA,
                }
            },
        },
    }
    assert result.text == '{"answer":"source-backed"}'
    assert result.data == {"answer": "source-backed"}
    assert result.usage == {"inputTokens": 11, "outputTokens": 7, "totalTokens": 18}


@pytest.mark.asyncio
async def test_gemini_encodes_model_and_converts_json_schema_before_parsing_parts() -> None:
    """The Gemini wire format is not interchangeable with OpenAI's schema format."""

    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["api_key"] = request.headers.get("x-goog-api-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "candidates": [{"content": {"parts": [{"text": '{"answer":"gemini"}'}]}}],
                "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 2, "totalTokenCount": 5},
            },
        )

    result = await GeminiProvider(
        api_key="gemini-key", model="gemini/test", temperature=0.2, transport=httpx.MockTransport(handler)
    ).generate_json("system policy", "product facts", _SCHEMA, "pdp_geo_content_plan", label="Gemini planning")

    generation = seen["body"]["generationConfig"]
    assert seen["url"] == "https://generativelanguage.googleapis.com/v1beta/models/gemini%2Ftest:generateContent"
    assert seen["api_key"] == "gemini-key"
    assert seen["body"]["systemInstruction"] == {"parts": [{"text": "system policy"}]}
    assert seen["body"]["contents"] == [{"role": "user", "parts": [{"text": "product facts"}]}]
    assert generation["responseMimeType"] == "application/json"
    assert generation["temperature"] == 0.2
    assert generation["responseSchema"] == {
        "type": "OBJECT",
        "properties": {"answer": {"type": "STRING"}},
        "required": ["answer"],
    }
    assert result.data == {"answer": "gemini"}
    assert result.usage == {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5}


def test_to_gemini_schema_translates_top_level_and_nested_nullable_pairs() -> None:
    """Gemini nullable fields use its dialect instead of JSON Schema ``anyOf``."""

    schema = {
        "anyOf": [
            {
                "type": "object",
                "additionalProperties": False,
                "description": "Optional response envelope.",
                "properties": {
                    "market": {
                        "anyOf": [
                            {"type": "string", "enum": ["KR", "US"], "minLength": 2},
                            {"type": "null"},
                        ]
                    },
                    "metadata": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "score": {
                                "anyOf": [
                                    {"type": "number", "minimum": 0},
                                    {"type": "null"},
                                ]
                            }
                        },
                        "required": ["score"],
                    },
                },
                "required": ["market", "metadata"],
            },
            {"type": "null"},
        ]
    }

    converted = to_gemini_schema(schema)

    assert converted == {
        "type": "OBJECT",
        "properties": {
            "market": {"type": "STRING", "enum": ["KR", "US"], "minLength": 2, "nullable": True},
            "metadata": {
                "type": "OBJECT",
                "properties": {"score": {"type": "NUMBER", "minimum": 0, "nullable": True}},
                "required": ["score"],
            },
        },
        "required": ["market", "metadata"],
        "nullable": True,
    }
    assert "anyOf" not in json.dumps(converted)


@pytest.mark.asyncio
async def test_azure_uses_deployment_chat_url_api_key_and_default_preview_version() -> None:
    """A provider mix-up here can leak a key to the wrong API protocol."""

    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["api_key"] = request.headers.get("api-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": '{"answer":"azure"}'}}],
                "usage": {"prompt_tokens": 4, "completion_tokens": 6},
            },
        )

    result = await AzureOpenAIProvider(
        api_key="azure-key",
        endpoint="https://azure.example/",
        deployment="reasoning/model",
        temperature=0,
        transport=httpx.MockTransport(handler),
    ).generate_json("system policy", "product facts", _SCHEMA, "pdp_geo_content_plan", label="Azure planning")

    assert seen["url"] == (
        "https://azure.example/openai/deployments/reasoning%2Fmodel/chat/completions?api-version=2025-04-01-preview"
    )
    assert seen["api_key"] == "azure-key"
    assert seen["body"] == {
        "messages": [
            {"role": "system", "content": "system policy"},
            {"role": "user", "content": "product facts"},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "pdp_geo_content_plan", "strict": True, "schema": _SCHEMA},
        },
        "temperature": 0,
    }
    assert result.data == {"answer": "azure"}
    assert result.usage == {"inputTokens": 4, "outputTokens": 6, "totalTokens": 10}


@pytest.mark.asyncio
async def test_aistudio_uses_bearer_auth_and_only_explicit_encoded_api_version() -> None:
    """AI Studio is Azure-shaped but has distinct auth and query rules."""

    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["authorization"] = request.headers.get("authorization")
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"answer":"studio"}'}}]})

    result = await AistudioProvider(
        api_key="studio-key",
        endpoint="https://studio.example/agent/",
        deployment="gpt 5.5",
        api_version=" 2025/01 beta ",
        transport=httpx.MockTransport(handler),
    ).generate_json("system", "facts", _SCHEMA, "pdp_geo_content_plan", label="AI Studio planning")

    assert seen["url"] == (
        "https://studio.example/agent/openai/deployments/gpt%205.5/chat/completions?api-version=2025%2F01%20beta"
    )
    assert seen["authorization"] == "Bearer studio-key"
    assert result.data == {"answer": "studio"}


@pytest.mark.asyncio
async def test_temperature_rejection_retries_exactly_once_without_temperature() -> None:
    """The compatibility retry must recover restrictive deployments without looping."""

    calls: list[dict[str, Any]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body)
        if "temperature" in body:
            return httpx.Response(400, text="Unsupported value for temperature; only the default is accepted")
        return httpx.Response(200, json={"output_text": '{"answer":"recovered"}'})

    result = await OpenAIProvider(
        api_key="key", model="gpt-test", temperature=0.7, transport=httpx.MockTransport(handler)
    ).generate_json("system", "facts", _SCHEMA, "plan", label="OpenAI planning")

    assert result.data == {"answer": "recovered"}
    assert len(calls) == 2
    assert calls[0]["temperature"] == 0.7
    assert "temperature" not in calls[1]


@pytest.mark.asyncio
async def test_gemini_temperature_rejection_does_not_trigger_openai_compatibility_retry() -> None:
    """Gemini's retained adapter reports its rejection instead of silently changing a request."""

    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        body = json.loads(request.content)
        if "temperature" in body.get("generationConfig", {}):
            return httpx.Response(400, text="temperature unsupported")
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": '{"answer":"wrong"}'}]}}]})

    provider = GeminiProvider(api_key="key", model="gemini-test", temperature=0.7, transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError, match=r"Gemini planning failed: 400 - temperature unsupported"):
        await provider.generate_json("system", "facts", _SCHEMA, "plan", label="Gemini planning")
    assert calls == 1


@pytest.mark.asyncio
async def test_non_temperature_failure_preserves_label_status_and_normalized_response_body() -> None:
    """Provider failures must remain actionable at the stage boundary."""

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="  rate\n limit   reached ")

    provider = GeminiProvider(api_key="key", model="gemini-test", transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError, match=r"Gemini planning failed: 429 - rate limit reached"):
        await provider.generate_json("system", "facts", _SCHEMA, "plan", label="Gemini planning")


@pytest.mark.asyncio
async def test_timeout_has_stable_label_and_does_not_retry() -> None:
    """Retrying an already-timed-out model call would double a long stall."""

    calls = 0

    async def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("socket stalled")

    provider = AzureOpenAIProvider(
        api_key="key", endpoint="https://azure.example", deployment="reasoning", transport=httpx.MockTransport(handler)
    )
    with pytest.raises(RuntimeError, match=r"Azure planning timed out after 900s\."):
        await provider.generate_json("system", "facts", _SCHEMA, "plan", label="Azure planning")
    assert calls == 1


@pytest.mark.asyncio
async def test_transient_retry_waits_once_and_reports_the_original_failure() -> None:
    """A fast network reset earns one delayed recovery attempt, not an implicit loop."""

    calls = 0
    waits: list[float] = []

    async def operation() -> ProviderResult:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("socket reset")
        return ProviderResult(text="{}", payload={}, usage=None, data={})

    async def sleep(delay: float) -> None:
        waits.append(delay)

    result, first_message = await retry_transient_once(operation, sleep=sleep)

    assert result.data == {}
    assert first_message == "socket reset"
    assert calls == 2
    assert waits == [0.75]


@pytest.mark.asyncio
async def test_mock_transport_and_mock_provider_are_deterministic_without_network() -> None:
    """Mock mode must make reproducible structured results available to offline callers."""

    transport = DeterministicMockTransport([httpx.Response(200, json={"output_text": '{"answer":"queued"}'})])
    result = await OpenAIProvider(api_key="key", model="model", transport=transport).generate_json(
        "system", "facts", _SCHEMA, "plan", label="OpenAI planning"
    )
    mock_result = await MockProvider({"answer": "offline"}).generate_json("system", "facts", _SCHEMA, "plan")

    assert result.data == {"answer": "queued"}
    assert transport.requests[0].url == "https://api.openai.com/v1/responses"
    assert mock_result.data == {"answer": "offline"}
    assert mock_result.text == '{"answer":"offline"}'


@pytest.mark.asyncio
async def test_stage_payload_adapter_serializes_compact_input_and_exposes_mapping_result() -> None:
    """Model-backed refiner/proofreader callers consume parsed provider data as a mapping."""

    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"output_text": '{"answer":"accepted"}', "usage": {"input_tokens": 2}})

    result = await OpenAIProvider(api_key="key", model="gpt-test", transport=httpx.MockTransport(handler)).generate_json(
        stage="copy-refinement",
        system="preserve evidence",
        payload={"request": {"name": "Glow Serum"}},
        json_schema=_SCHEMA,
    )

    assert seen["input"] == '{"request":{"name":"Glow Serum"}}'
    assert seen["text"]["format"]["name"] == "pdp_geo_copy_refinement"
    assert result["answer"] == "accepted"
    assert result.get("usage") == {"inputTokens": 2}


def test_factory_selects_supported_adapters_and_rejects_unknown_provider() -> None:
    """An unsupported provider must not silently become a live default adapter."""

    assert isinstance(create_provider({"provider": "openai", "apiKey": "k", "model": "m"}), OpenAIProvider)
    assert isinstance(
        create_provider({"provider": "azure-openai", "apiKey": "k", "endpoint": "https://azure.example", "deployment": "m"}),
        AzureOpenAIProvider,
    )
    assert isinstance(create_provider({"provider": "mock"}), MockProvider)
    with pytest.raises(ValueError, match="Unsupported PDP GEO provider: unsupported"):
        create_provider({"provider": "unsupported"})


@pytest.mark.asyncio
async def test_stage_specific_missing_openai_credentials_keep_legacy_error_semantics() -> None:
    """Optional copy refinement reports the original env-key failure rather than a generic error."""

    with pytest.raises(
        ValueError,
        match=r"OPENAI_API_KEY and OPENAI_MODEL are required for copy refinement\.",
    ):
        await OpenAIProvider(api_key="", model="").generate_json(
            stage="copy-refinement",
            system="system",
            payload={"request": {}},
            json_schema=_SCHEMA,
        )

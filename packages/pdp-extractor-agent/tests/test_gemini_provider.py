"""Ports of Gemini structured-output and image fallback contracts (3 cases)."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, cast

import httpx
import pytest

from pdp_extractor_agent.providers.gemini import GeminiProvider

_WIRE_EDGE_BODY: dict[str, object] = {
    "10": "ten",
    "2": "two",
    "temperature": 1.0,
    "negative": -0.0,
    "nan": float("nan"),
    "prompt": "x\ud800",
    "unicode": "한😀",
}
_WIRE_EDGE_BYTES = (
    b'{"2":"two","10":"ten","temperature":1,"negative":0,"nan":null,'
    b'"prompt":"x\\ud800","unicode":"\xed\x95\x9c\xf0\x9f\x98\x80"}'
)


class _GeminiWireProbe(GeminiProvider):
    """Expose the inherited transport boundary without widening production API."""

    async def post_wire_body(self, body: Mapping[str, Any]) -> httpx.Response:
        return await self._post(body, "Gemini wire contract")


def _json_object(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise AssertionError("expected JSON object")
    result: dict[str, object] = {}
    for key, item in cast(dict[object, object], value).items():
        if not isinstance(key, str):
            raise AssertionError("expected JSON string key")
        result[key] = item
    return result


def _object_member(value: dict[str, object], key: str) -> dict[str, object]:
    return _json_object(value[key])


def _object_list_member(value: dict[str, object], key: str) -> list[dict[str, object]]:
    member = value[key]
    if not isinstance(member, list):
        raise AssertionError(f"expected JSON array for {key}")
    return [_json_object(item) for item in cast(list[object], member)]


def _optional_object_member(value: dict[str, object], key: str) -> dict[str, object] | None:
    member = value.get(key)
    return _json_object(cast(dict[object, object], member)) if isinstance(member, dict) else None


def _optional_string_member(value: dict[str, object], key: str) -> str | None:
    member = value.get(key)
    return member if isinstance(member, str) else None


@pytest.mark.asyncio
async def test_gemini_post_uses_javascript_json_bytes_for_edge_values() -> None:
    """The Gemini request must reach the transport with JSON.stringify bytes."""

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["content-type"] == "application/json"
        assert request.content == _WIRE_EDGE_BYTES
        return httpx.Response(200, json={"candidates": []})

    response = await _GeminiWireProbe(
        api_key="key", model="gemini-2.5", transport=httpx.MockTransport(handler)
    ).post_wire_body(_WIRE_EDGE_BODY)

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_requests_structured_json_with_response_schema() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": '{"keywords":[]}'}]}}]})

    provider = GeminiProvider(api_key="key", model="gemini-2.5", transport=httpx.MockTransport(handler))
    await provider.classify_keywords({"imageTexts": [{"imageUrl": "https://cdn.test/a.png", "text": "ceramide"}]})
    generation_config = _object_member(_json_object(seen), "generationConfig")
    assert generation_config["responseMimeType"] == "application/json"
    assert "responseSchema" in generation_config


@pytest.mark.asyncio
async def test_downloads_image_and_sends_inline_base64_for_vision_ocr() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": '{"images":[{"index":1,"imageUrl":"https://cdn.test/a.png","text":"readable"}]}'
                                }
                            ]
                        }
                    }
                ]
            },
        )

    async def image_fetcher(_: str) -> tuple[str, bytes]:
        return "image/png", b"bytes"

    provider = GeminiProvider(
        api_key="key", model="gemini-2.5", transport=httpx.MockTransport(handler), image_fetcher=image_fetcher
    )
    await provider.extract_image_text({"imageUrls": ["https://cdn.test/a.png"]})
    parts = _object_list_member(_object_list_member(_json_object(seen), "contents")[0], "parts")
    assert any(
        inline_data is not None and inline_data["mime_type"] == "image/png"
        for part in parts
        if (inline_data := _optional_object_member(part, "inline_data")) is not None
    )


@pytest.mark.asyncio
async def test_retries_without_response_schema_when_model_rejects_it() -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        body = json.loads(request.content)
        if "responseSchema" in body.get("generationConfig", {}):
            return httpx.Response(400, text="responseSchema is unsupported")
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": '{"keywords":[]}'}]}}]})

    provider = GeminiProvider(api_key="key", model="gemini-2.5", transport=httpx.MockTransport(handler))
    assert await provider.classify_keywords({"imageTexts": []}) == {"keywords": []}
    assert calls == 2


@pytest.mark.asyncio
async def test_gemini_forwards_temperature_and_prepared_slice_input_without_replacing_display_url() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": '{"images":[{"index":1,"imageUrl":"https://cdn.test/a.png#ocr-slice-1of2","text":"readable"}]}'
                                }
                            ]
                        }
                    }
                ]
            },
        )

    provider = GeminiProvider(api_key="key", model="gemini-2.5", temperature=0.3, transport=httpx.MockTransport(handler))
    await provider.extract_image_text(
        {
            "source": "https://example.test/p",
            "imageUrls": ["https://cdn.test/a.png#ocr-slice-1of2"],
            "imageInputs": [
                {"displayUrl": "https://cdn.test/a.png#ocr-slice-1of2", "inputUrl": "data:image/png;base64,YQ=="}
            ],
        }
    )
    assert _object_member(_json_object(seen), "generationConfig")["temperature"] == 0.3
    parts = _object_list_member(_object_list_member(_json_object(seen), "contents")[0], "parts")
    assert any(
        inline_data is not None and inline_data["data"] == "YQ=="
        for part in parts
        if (inline_data := _optional_object_member(part, "inline_data")) is not None
    )
    assert any(
        text is not None and "#ocr-slice-1of2" in text
        for part in parts
        if (text := _optional_string_member(part, "text")) is not None
    )


@pytest.mark.asyncio
async def test_gemini_uses_legacy_inline_data_wire_keys_and_returns_usage_raw_text() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {"content": {"parts": [{"text": '{"images":[{"index":1,"text":"readable"}]}'}]}}
                ],
                "usageMetadata": {"promptTokenCount": 4, "candidatesTokenCount": 3, "totalTokenCount": 7},
            },
        )

    provider = GeminiProvider(api_key="key", model="gemini-2.5", transport=httpx.MockTransport(handler))
    result = await provider.extract_image_text(
        {
            "imageUrls": ["https://cdn.test/a.png#ocr-slice-1of2"],
            "imageInputs": [{"displayUrl": "https://cdn.test/a.png#ocr-slice-1of2", "inputUrl": "data:image/png;base64,YQ=="}],
        }
    )

    parts = _object_list_member(_object_list_member(_json_object(seen), "contents")[0], "parts")
    assert _object_member(parts[2], "inline_data") == {"mime_type": "image/png", "data": "YQ=="}
    assert result == {
        "images": [{"imageUrl": "https://cdn.test/a.png#ocr-slice-1of2", "text": "readable"}],
        "rawText": '{"images":[{"index":1,"text":"readable"}]}',
        "usage": {"inputTokens": 4, "outputTokens": 3, "totalTokens": 7},
    }


@pytest.mark.asyncio
async def test_gemini_requires_an_api_key_and_model_before_making_a_request() -> None:
    with pytest.raises(ValueError, match="GEMINI_API_KEY"):
        await GeminiProvider(api_key="", model="gemini-2.5").classify_keywords({"imageTexts": []})
    with pytest.raises(ValueError, match="GEMINI_MODEL"):
        await GeminiProvider(api_key="key", model="").extract_image_text({"imageUrls": []})


@pytest.mark.asyncio
async def test_gemini_raises_for_braced_malformed_keyword_json() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": '{"keywords": }'}]}}]})

    provider = GeminiProvider(api_key="key", model="gemini-2.5", transport=httpx.MockTransport(handler))
    with pytest.raises(json.JSONDecodeError):
        await provider.classify_keywords({"imageTexts": []})


@pytest.mark.asyncio
async def test_gemini_timeout_has_the_stable_ts_label_and_duration() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("socket stalled")

    provider = GeminiProvider(api_key="key", model="gemini-2.5", transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError, match=r"Gemini keyword classification timed out after 900s\."):
        await provider.classify_keywords({"imageTexts": []})

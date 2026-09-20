"""Ports of OpenAI provider request/fallback contracts (4 cases)."""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from typing import Any, cast

import httpx
import pytest

from pdp_extractor_agent.providers.openai import OpenAIProvider

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


class _OpenAIWireProbe(OpenAIProvider):
    """Expose the inherited transport boundary without widening production API."""

    async def post_wire_body(self, body: Mapping[str, Any]) -> httpx.Response:
        return await self._post(body, "OpenAI wire contract")


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


@pytest.mark.asyncio
async def test_openai_post_uses_javascript_json_bytes_for_edge_values() -> None:
    """The provider wire must retain JSON.stringify's number, key, and UTF-16 rules."""

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["content-type"] == "application/json"
        assert request.content == _WIRE_EDGE_BYTES
        return httpx.Response(200, json={"output_text": "{}"})

    response = await _OpenAIWireProbe(
        api_key="key", model="gpt-5-mini", transport=httpx.MockTransport(handler)
    ).post_wire_body(_WIRE_EDGE_BODY)

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_sends_rag_policy_as_instructions_and_evidence_as_user_input() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"output_text": '{"keywords":[],"sentenceInsights":[]}'})

    provider = OpenAIProvider(api_key="key", model="gpt-5-mini", transport=httpx.MockTransport(handler))
    await provider.classify_keywords(
        {
            "analysisPrompt": "RAG policy",
            "imageTexts": [{"imageUrl": "https://cdn.test/a.png", "text": "ceramide barrier"}],
        }
    )
    assert "RAG policy" in seen["instructions"] and "source-backed" in seen["instructions"]
    assert "ceramide barrier" in json.dumps(seen["input"])


@pytest.mark.asyncio
async def test_sends_high_detail_vision_image_inputs() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200, json={"output_text": '{"images":[{"index":1,"imageUrl":"https://cdn.test/a.png","text":"readable"}]}'}
        )

    provider = OpenAIProvider(api_key="key", model="gpt-5-mini", transport=httpx.MockTransport(handler))
    await provider.extract_image_text({"imageUrls": ["https://cdn.test/a.png"]})
    content = _object_list_member(_object_list_member(_json_object(seen), "input")[0], "content")
    assert any(part.get("detail") == "high" for part in content if part["type"] == "input_image")


@pytest.mark.asyncio
async def test_falls_back_to_downloaded_data_url_when_remote_image_is_rejected() -> None:
    urls: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        image_url = next(part["image_url"] for part in body["input"][0]["content"] if part["type"] == "input_image")
        urls.append(image_url)
        if image_url.startswith("https:"):
            return httpx.Response(400, text="remote image rejected")
        return httpx.Response(
            200, json={"output_text": '{"images":[{"index":1,"imageUrl":"https://cdn.test/a.png","text":"readable"}]}'}
        )

    async def image_fetcher(_: str) -> tuple[str, bytes]:
        return "image/png", b"image-bytes"

    provider = OpenAIProvider(
        api_key="key", model="gpt-5-mini", transport=httpx.MockTransport(handler), image_fetcher=image_fetcher
    )
    result = await provider.extract_image_text({"imageUrls": ["https://cdn.test/a.png"]})
    assert result["images"][0]["text"] == "readable"
    assert urls[1].startswith("data:image/png;base64," + base64.b64encode(b"image-bytes").decode("ascii"))


@pytest.mark.asyncio
async def test_falls_back_to_downloaded_data_url_when_remote_response_has_no_text() -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        body = json.loads(request.content)
        image_url = next(part["image_url"] for part in body["input"][0]["content"] if part["type"] == "input_image")
        text = "" if image_url.startswith("https:") else "fallback text"
        return httpx.Response(
            200,
            json={
                "output_text": json.dumps(
                    {"images": [{"index": 1, "imageUrl": "https://cdn.test/a.png", "text": text}]}
                )
            },
        )

    async def image_fetcher(_: str) -> tuple[str, bytes]:
        return "image/jpeg", b"bytes"

    provider = OpenAIProvider(
        api_key="key", model="gpt-5-mini", transport=httpx.MockTransport(handler), image_fetcher=image_fetcher
    )
    assert (await provider.extract_image_text({"imageUrls": ["https://cdn.test/a.png"]}))["images"][0][
        "text"
    ] == "fallback text"
    assert calls == 2


@pytest.mark.asyncio
async def test_openai_forwards_temperature_strict_schema_and_prepared_image_input() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={"output_text": '{"images":[{"index":1,"imageUrl":"https://cdn.test/a.png#ocr-slice-1of2","text":"readable"}]}'},
        )

    provider = OpenAIProvider(api_key="key", model="gpt-5-mini", temperature=0.2, transport=httpx.MockTransport(handler))
    await provider.extract_image_text(
        {
            "source": "https://example.test/p",
            "imageUrls": ["https://cdn.test/a.png#ocr-slice-1of2"],
            "imageInputs": [
                {"displayUrl": "https://cdn.test/a.png#ocr-slice-1of2", "inputUrl": "data:image/png;base64,YQ=="}
            ],
        }
    )

    assert seen["temperature"] == 0.2
    assert _object_member(_object_member(_json_object(seen), "text"), "format")["type"] == "json_schema"
    image_part = next(
        part
        for part in _object_list_member(_object_list_member(_json_object(seen), "input")[0], "content")
        if part["type"] == "input_image"
    )
    assert image_part["image_url"] == "data:image/png;base64,YQ=="


@pytest.mark.asyncio
async def test_openai_quota_error_is_not_silently_converted_into_empty_ocr() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="insufficient_quota; check billing")

    provider = OpenAIProvider(api_key="key", model="gpt-5-mini", transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError, match="429.*insufficient_quota"):
        await provider.extract_image_text({"imageUrls": ["https://cdn.test/a.png"]})


@pytest.mark.asyncio
async def test_openai_downloads_remote_image_with_its_configured_transport_when_no_fetcher_is_injected() -> None:
    calls: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if str(request.url) == "https://cdn.test/a.png":
            return httpx.Response(200, content=b"bytes", headers={"content-type": "image/png"})
        body = json.loads(request.content)
        image = next(part["image_url"] for part in body["input"][0]["content"] if part["type"] == "input_image")
        if image.startswith("https:"):
            return httpx.Response(400, text="remote image rejected")
        return httpx.Response(
            200,
            json={"output_text": '{"images":[{"index":1,"text":"fallback text"}]}'},
        )

    provider = OpenAIProvider(api_key="key", model="gpt-5-mini", transport=httpx.MockTransport(handler))
    result = await provider.extract_image_text({"imageUrls": ["https://cdn.test/a.png"]})
    assert result["images"] == [{"imageUrl": "https://cdn.test/a.png", "text": "fallback text"}]
    assert calls == ["https://api.openai.com/v1/responses", "https://cdn.test/a.png", "https://api.openai.com/v1/responses"]


@pytest.mark.asyncio
async def test_openai_raises_for_braced_malformed_keyword_json() -> None:
    """A model claiming a JSON object must not become a successful empty classification."""

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"output_text": '{"keywords": }'})

    provider = OpenAIProvider(api_key="key", model="gpt-5-mini", transport=httpx.MockTransport(handler))
    with pytest.raises(json.JSONDecodeError):
        await provider.classify_keywords({"imageTexts": []})


@pytest.mark.asyncio
async def test_openai_stops_after_one_compatibility_retry() -> None:
    """TS removes one rejected field then reports the second failure; it never posts a third time."""

    calls = 0

    async def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            400,
            text="text.format json_schema unsupported" if calls == 1 else "temperature unsupported",
        )

    provider = OpenAIProvider(
        api_key="key", model="gpt-5-mini", temperature=0.2, transport=httpx.MockTransport(handler)
    )
    with pytest.raises(RuntimeError, match="OpenAI keyword classification failed: 400 - temperature unsupported"):
        await provider.classify_keywords({"imageTexts": []})
    assert calls == 2


@pytest.mark.asyncio
async def test_openai_image_fallback_follows_download_redirects() -> None:
    """The fallback downloader has browser-like redirect behavior before data-URL OCR."""

    calls: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        calls.append(url)
        if request.method == "GET" and url == "https://cdn.test/original.png":
            return httpx.Response(302, headers={"location": "https://cdn.test/final.png"})
        if request.method == "GET" and url == "https://cdn.test/final.png":
            return httpx.Response(200, content=b"bytes", headers={"content-type": "image/png"})
        body = json.loads(request.content)
        image_url = next(part["image_url"] for part in body["input"][0]["content"] if part["type"] == "input_image")
        if image_url.startswith("https:"):
            return httpx.Response(400, text="remote image rejected")
        return httpx.Response(200, json={"output_text": '{"images":[{"index":1,"text":"fallback"}]}'})

    provider = OpenAIProvider(api_key="key", model="gpt-5-mini", transport=httpx.MockTransport(handler))
    result = await provider.extract_image_text({"imageUrls": ["https://cdn.test/original.png"]})

    assert result["images"][0]["text"] == "fallback"
    assert calls == [
        "https://api.openai.com/v1/responses",
        "https://cdn.test/original.png",
        "https://cdn.test/final.png",
        "https://api.openai.com/v1/responses",
    ]


@pytest.mark.asyncio
async def test_openai_timeout_has_the_stable_ts_label_and_duration() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("socket stalled")

    provider = OpenAIProvider(api_key="key", model="gpt-5-mini", transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError, match=r"OpenAI keyword classification timed out after 900s\."):
        await provider.classify_keywords({"imageTexts": []})

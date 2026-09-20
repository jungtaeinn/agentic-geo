"""Ports of Azure AI Studio deployment/temperature/image contracts (7 cases)."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, cast

import httpx
import pytest

from pdp_extractor_agent.providers.aistudio import AistudioProvider
from pdp_extractor_agent.providers.azure_openai import AzureOpenAIProvider

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


class _AistudioWireProbe(AistudioProvider):
    """Expose the Azure-inherited transport boundary without production API drift."""

    async def post_wire_body(self, url: str, body: Mapping[str, Any]) -> httpx.Response:
        return await self._post(url, body, "AI Studio wire contract")


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


def _provider(handler: Any, **kwargs: Any) -> AistudioProvider:
    return AistudioProvider(
        api_key="key",
        endpoint="https://studio.example",
        deployment="gpt-5.5",
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


@pytest.mark.asyncio
async def test_aistudio_inherited_azure_post_uses_javascript_json_bytes_for_edge_values() -> None:
    """AI Studio shares Azure's post seam and therefore its exact legacy wire."""

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["content-type"] == "application/json"
        assert request.headers["authorization"] == "Bearer key"
        assert request.content == _WIRE_EDGE_BYTES
        return httpx.Response(200, json={"choices": []})

    response = await _AistudioWireProbe(
        api_key="key",
        endpoint="https://studio.example",
        deployment="gpt-5.5",
        transport=httpx.MockTransport(handler),
    ).post_wire_body(
        "https://studio.example/openai/deployments/gpt/chat/completions",
        _WIRE_EDGE_BODY,
    )

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_calls_azure_deployment_path_with_bearer_auth_and_no_unset_api_version() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["auth"] = str(request.url), request.headers.get("authorization")
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"keywords":[]}'}}]})

    await _provider(handler).classify_keywords({"imageTexts": []})
    assert (
        "/openai/deployments/gpt-5.5/chat/completions" in seen["url"]
        and "api-version" not in seen["url"]
        and seen["auth"] == "Bearer key"
    )


@pytest.mark.asyncio
async def test_omits_temperature_when_unset() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"keywords":[]}'}}]})

    await _provider(handler).classify_keywords({"imageTexts": []})
    assert "temperature" not in seen


@pytest.mark.asyncio
async def test_includes_temperature_only_when_explicitly_configured() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"keywords":[]}'}}]})

    await _provider(handler, temperature=0.2).classify_keywords({"imageTexts": []})
    assert seen["temperature"] == 0.2


@pytest.mark.asyncio
async def test_retries_chat_without_temperature_when_deployment_rejects_it() -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        body = json.loads(request.content)
        if "temperature" in body:
            return httpx.Response(400, text="temperature unsupported")
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"keywords":[]}'}}]})

    assert await _provider(handler, temperature=0.2).classify_keywords({"imageTexts": []}) == {"keywords": []}
    assert calls == 2


@pytest.mark.asyncio
async def test_retries_image_ocr_without_temperature_when_deployment_rejects_it() -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        body = json.loads(request.content)
        if "temperature" in body:
            return httpx.Response(400, text="temperature unsupported")
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"content": '{"images":[{"index":1,"imageUrl":"https://cdn/a.png","text":"ok"}]}'}}
                ]
            },
        )

    assert (await _provider(handler, temperature=0.2).extract_image_text({"imageUrls": ["https://cdn/a.png"]}))[
        "images"
    ][0]["text"] == "ok"
    assert calls == 2


@pytest.mark.asyncio
async def test_downloads_image_and_retries_with_data_url_when_remote_ocr_is_empty() -> None:
    seen: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        image_part = next(part for part in body["messages"][0]["content"] if part["type"] == "image_url")
        url = image_part["image_url"]["url"]
        seen.append(url)
        text = "" if url.startswith("https:") else "fallback"
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {"images": [{"index": 1, "imageUrl": "https://cdn/a.png", "text": text}]}
                            )
                        }
                    }
                ]
            },
        )

    async def image_fetcher(_: str) -> tuple[str, bytes]:
        return "image/png", b"bytes"

    assert (
        await _provider(handler, image_fetcher=image_fetcher).extract_image_text({"imageUrls": ["https://cdn/a.png"]})
    )["images"][0]["text"] == "fallback"
    assert seen[1].startswith("data:image/png;base64,")


@pytest.mark.asyncio
async def test_appends_api_version_only_when_explicitly_provided() -> None:
    seen: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"keywords":[]}'}}]})

    await _provider(handler, api_version="2025-01-01").classify_keywords({"imageTexts": []})
    assert "api-version=2025-01-01" in seen[0]


def test_aistudio_url_removes_one_trailing_slash_and_trims_and_encodes_api_version() -> None:
    provider = AistudioProvider(
        api_key="key",
        endpoint="https://studio.example/agent/",
        deployment="gpt 5.5",
        api_version=" 2025/01 beta ",
    )

    assert provider.chat_completions_url("gpt 5.5") == (
        "https://studio.example/agent/openai/deployments/gpt 5.5/chat/completions?api-version=2025%2F01%20beta"
    )


def test_azure_url_keeps_legacy_single_slash_and_raw_api_version_serialization() -> None:
    """The base Azure adapter has different URL rules from the AI Studio gateway."""

    provider = AzureOpenAIProvider(
        api_key="key",
        endpoint="https://azure.example//",
        deployment="reasoning",
        api_version=" 2025/01 beta ",
    )

    assert provider.chat_completions_url("reasoning") == (
        "https://azure.example//openai/deployments/reasoning/chat/completions?api-version= 2025/01 beta "
    )


@pytest.mark.asyncio
async def test_azure_vision_preserves_prepared_display_urls_and_reports_raw_text_usage_and_schema() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": '{"images":[{"index":1,"imageUrl":"wrong-url","text":"visible copy"}]}'
                        }
                    }
                ],
                "usage": {"prompt_tokens": 11, "completion_tokens": 7},
            },
        )

    result = await _provider(handler, temperature=0).extract_image_text(
        {
            "source": "https://example.test/p",
            "productName": "Serum",
            "imageUrls": ["https://cdn.test/a.png#ocr-slice-1of2"],
            "imageInputs": [
                {
                    "displayUrl": "https://cdn.test/a.png#ocr-slice-1of2",
                    "inputUrl": "data:image/png;base64,YQ==",
                }
            ],
        }
    )

    content = _object_list_member(_object_list_member(_json_object(seen), "messages")[0], "content")
    image_part = next(part for part in content if part["type"] == "image_url")
    assert seen["temperature"] == 0 and _object_member(_json_object(seen), "response_format")["type"] == "json_schema"
    assert _object_member(image_part, "image_url")["url"] == "data:image/png;base64,YQ=="
    text = content[1]["text"]
    assert isinstance(text, str) and "#ocr-slice-1of2" in text
    assert result == {
        "images": [{"imageUrl": "https://cdn.test/a.png#ocr-slice-1of2", "text": "visible copy"}],
        "rawText": '{"images":[{"index":1,"imageUrl":"wrong-url","text":"visible copy"}]}',
        "usage": {"inputTokens": 11, "outputTokens": 7, "totalTokens": 18},
    }


@pytest.mark.asyncio
async def test_azure_ocr_does_not_replace_quota_failure_with_an_empty_result() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="insufficient_quota; check billing")

    with pytest.raises(RuntimeError, match="Azure image OCR failed: 429 - insufficient_quota; check billing"):
        await _provider(handler).extract_image_text({"imageUrls": ["https://cdn.test/a.png"]})


@pytest.mark.asyncio
async def test_azure_raises_for_braced_malformed_keyword_json() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"keywords": }'}}]})

    with pytest.raises(json.JSONDecodeError):
        await _provider(handler).classify_keywords({"imageTexts": []})


@pytest.mark.asyncio
async def test_azure_timeout_has_the_stable_ts_label_and_duration() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("socket stalled")

    with pytest.raises(RuntimeError, match=r"Azure keyword classification timed out after 900s\."):
        await _provider(handler).classify_keywords({"imageTexts": []})

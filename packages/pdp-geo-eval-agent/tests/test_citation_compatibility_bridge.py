"""Focused compatibility tests for evaluator CLI and provider HTTP boundaries."""

from __future__ import annotations

import json
import math
from typing import cast

import httpx
import pytest

from pdp_geo_eval_agent.citation import cli, engine


def _json_object(content: bytes) -> dict[str, object]:
    """Decode a request body after checking the dynamic JSON boundary."""
    decoded = cast(object, json.loads(content))
    assert isinstance(decoded, dict)
    mapping = cast(dict[object, object], decoded)
    assert all(isinstance(key, str) for key in mapping)
    return cast(dict[str, object], mapping)


def test_cli_temperature_uses_ecmascript_whitespace_and_preserves_negative_zero() -> None:
    """Replacing Number.parseFloat with an ASCII parser loses this public CLI value."""
    config = cli.resolve_engine_config_from_env(
        "openai",
        ["--model", "gpt-test", "--temperature", "\u00a0-0ignored"],
        environ={"OPENAI_API_KEY": "secret"},
    )

    temperature = config["temperature"]
    assert isinstance(temperature, float)
    assert temperature == 0.0
    assert math.copysign(1.0, temperature) == -1.0


@pytest.mark.asyncio
async def test_openai_request_serializes_lone_surrogates_before_the_transport() -> None:
    """Using httpx's JSON encoder can fail before the provider transport receives a request."""
    requests: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.content)
        return httpx.Response(200, json={"output_text": "Cited answer [0]."})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        answer = await engine.complete_with_provider(
            {"provider": "openai", "apiKey": "secret", "model": "gpt-test", "temperature": 0.2},
            "high=\ud800 low=\udc00 pair=\ud83d\ude00",
            "user",
            client=client,
        )

    expected = (
        b'{"model":"gpt-test","instructions":"high=\\ud800 low=\\udc00 pair=\xf0\x9f\x98\x80",'
        b'"input":"user","temperature":0.2}'
    )
    assert answer == "Cited answer [0]."
    assert requests == [expected]
    assert b"\\ud800" in requests[0]
    assert b"\\udc00" in requests[0]
    assert _json_object(requests[0]) == {
        "model": "gpt-test",
        "instructions": "high=\ud800 low=\udc00 pair=\U0001f600",
        "input": "user",
        "temperature": 0.2,
    }


@pytest.mark.asyncio
async def test_azure_temperature_retry_preserves_surrogate_bytes_and_omits_only_temperature() -> None:
    """The retry must remain a real second dispatch with the original safe JSON payload."""
    requests: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.content)
        if len(requests) == 1:
            return httpx.Response(400, text="unsupported value for temperature")
        return httpx.Response(200, json={"choices": [{"message": {"content": "retry answer"}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        answer = await engine.complete_with_provider(
            {
                "provider": "azure-openai",
                "apiKey": "azure-key",
                "endpoint": "https://azure.example/",
                "deployment": "prod",
                "apiVersion": "2025-01-01",
                "temperature": 0.4,
            },
            "system=\ud800",
            "user=\udc00 pair=\ud83d\ude00",
            client=client,
        )

    initial = (
        b'{"messages":[{"role":"system","content":"system=\\ud800"},'
        b'{"role":"user","content":"user=\\udc00 pair=\xf0\x9f\x98\x80"}],"temperature":0.4}'
    )
    retry = (
        b'{"messages":[{"role":"system","content":"system=\\ud800"},'
        b'{"role":"user","content":"user=\\udc00 pair=\xf0\x9f\x98\x80"}]}'
    )
    assert answer == "retry answer"
    assert requests == [initial, retry]
    assert _json_object(requests[0]) == {
        "messages": [
            {"role": "system", "content": "system=\ud800"},
            {"role": "user", "content": "user=\udc00 pair=\U0001f600"},
        ],
        "temperature": 0.4,
    }
    assert _json_object(requests[1]) == {
        "messages": [
            {"role": "system", "content": "system=\ud800"},
            {"role": "user", "content": "user=\udc00 pair=\U0001f600"},
        ]
    }


@pytest.mark.parametrize(
    ("temperature",),
    ((math.nan,), (math.inf,), (-math.inf,)),
    ids=("nan", "positive-infinity", "negative-infinity"),
)
@pytest.mark.asyncio
async def test_gemini_serializes_nonfinite_numeric_temperature_as_null(temperature: float) -> None:
    """Filtering non-finite Gemini temperatures drops a TypeScript-visible generationConfig field."""
    requests: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.content)
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "answer"}]}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        answer = await engine.complete_with_provider(
            {"provider": "gemini", "apiKey": "gemini-key", "model": "gemini-test", "temperature": temperature},
            "system",
            "user",
            client=client,
        )

    expected = (
        b'{"systemInstruction":{"parts":[{"text":"system"}]},'
        b'"contents":[{"role":"user","parts":[{"text":"user"}]}],'
        b'"generationConfig":{"temperature":null}}'
    )
    assert answer == "answer"
    assert requests == [expected]
    assert _json_object(requests[0])["generationConfig"] == {"temperature": None}


@pytest.mark.parametrize(
    ("temperature",),
    ((math.nan,), (math.inf,), (-math.inf,)),
    ids=("nan", "positive-infinity", "negative-infinity"),
)
@pytest.mark.asyncio
async def test_openai_omits_nonfinite_temperature(temperature: float) -> None:
    """Adding an OpenAI non-finite temperature would diverge from its finite-only TypeScript helper."""
    requests: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.content)
        return httpx.Response(200, json={"output_text": "answer"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        answer = await engine.complete_with_provider(
            {"provider": "openai", "apiKey": "openai-key", "model": "gpt-test", "temperature": temperature},
            "system",
            "user",
            client=client,
        )

    assert answer == "answer"
    assert requests == [b'{"model":"gpt-test","instructions":"system","input":"user"}']
    assert "temperature" not in _json_object(requests[0])


@pytest.mark.parametrize(
    ("temperature",),
    ((math.nan,), (math.inf,), (-math.inf,)),
    ids=("nan", "positive-infinity", "negative-infinity"),
)
@pytest.mark.asyncio
async def test_chat_completions_omits_nonfinite_temperature(temperature: float) -> None:
    """Adding a chat-completions non-finite temperature would diverge from its finite-only helper."""
    requests: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.content)
        return httpx.Response(200, json={"choices": [{"message": {"content": "answer"}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        answer = await engine.complete_with_provider(
            {
                "provider": "azure-openai",
                "apiKey": "azure-key",
                "endpoint": "https://azure.example/",
                "deployment": "prod",
                "temperature": temperature,
            },
            "system",
            "user",
            client=client,
        )

    assert answer == "answer"
    assert requests == [
        b'{"messages":[{"role":"system","content":"system"},{"role":"user","content":"user"}]}'
    ]
    assert "temperature" not in _json_object(requests[0])

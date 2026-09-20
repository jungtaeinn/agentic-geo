"""Provider transport envelope parity with the TypeScript adapters."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Protocol

import httpx
import pytest

from pdp_extractor_agent.providers.azure_openai import AzureOpenAIProvider
from pdp_extractor_agent.providers.gemini import GeminiProvider
from pdp_extractor_agent.providers.openai import OpenAIProvider


class _KeywordProvider(Protocol):
    async def classify_keywords(self, request: dict[str, object]) -> dict[str, object]: ...


ProviderFactory = Callable[[httpx.AsyncBaseTransport], _KeywordProvider]


def _openai(transport: httpx.AsyncBaseTransport) -> _KeywordProvider:
    return OpenAIProvider(api_key="key", model="gpt-5-mini", transport=transport)


def _gemini(transport: httpx.AsyncBaseTransport) -> _KeywordProvider:
    return GeminiProvider(api_key="key", model="gemini-2.5", transport=transport)


def _azure(transport: httpx.AsyncBaseTransport) -> _KeywordProvider:
    return AzureOpenAIProvider(
        api_key="key", endpoint="https://azure.example", deployment="reasoning", transport=transport
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("factory", "label"),
    [(_openai, "OpenAI keyword classification"), (_gemini, "Gemini keyword classification"), (_azure, "Azure keyword classification")],
)
@pytest.mark.parametrize("envelope", [None, []])
async def test_provider_rejects_successful_non_object_json_envelopes(
    factory: ProviderFactory, label: str, envelope: object
) -> None:
    """A 2xx response still fails when its JSON cannot be read as a provider object."""

    async def handler(_: httpx.Request) -> httpx.Response:
        # httpx's ``json=None`` leaves an empty body, whereas the wire-level
        # envelope we must reject is the literal JSON token ``null``.
        return httpx.Response(200, content=json.dumps(envelope), headers={"content-type": "application/json"})

    provider = factory(httpx.MockTransport(handler))
    with pytest.raises(RuntimeError, match=rf"{label} returned an invalid JSON object"):
        await provider.classify_keywords({"imageTexts": []})

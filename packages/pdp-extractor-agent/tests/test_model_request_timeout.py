"""Model-request timeout contracts for the extractor migration."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from pdp_extractor_agent.models import LlmProviderConfig
from pdp_extractor_agent.normalizer import normalize_extractor_product_profile_with_agent
from pdp_extractor_agent.providers import create_keyword_classifier


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "settings", "label"),
    [
        ("openai", {"apiKey": "key", "model": "gpt"}, "OpenAI keyword classification"),
        ("gemini", {"apiKey": "key", "model": "gemini"}, "Gemini keyword classification"),
        (
            "aistudio",
            {"apiKey": "key", "endpoint": "https://studio.example", "deployment": "reasoning"},
            "Azure keyword classification",
        ),
    ],
)
async def test_provider_factory_keeps_model_requests_at_least_fifteen_minutes(
    provider: str, settings: dict[str, Any], label: str
) -> None:
    """OCR/classification must not inherit the former five-minute model cap."""

    async def stalled(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("socket stalled")

    classifier = create_keyword_classifier(
        {
            "provider": provider,
            **settings,
            "timeoutSeconds": 120,
            "transport": httpx.MockTransport(stalled),
        }
    )

    with pytest.raises(RuntimeError, match=rf"{label} timed out after 900s\."):
        await classifier.classify_keywords({"imageTexts": []})


@pytest.mark.asyncio
async def test_provider_factory_preserves_a_longer_explicit_model_timeout() -> None:
    """An intentional timeout longer than the policy floor must reach AI Studio."""

    async def stalled(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("socket stalled")

    classifier = create_keyword_classifier(
        {
            "provider": "aistudio",
            "apiKey": "key",
            "endpoint": "https://studio.example",
            "deployment": "reasoning",
            "timeoutSeconds": 960,
            "transport": httpx.MockTransport(stalled),
        }
    )

    with pytest.raises(RuntimeError, match=r"Azure keyword classification timed out after 960s\."):
        await classifier.classify_keywords({"imageTexts": []})


def test_typed_provider_config_retains_a_longer_model_timeout() -> None:
    """Pydantic input must not discard the model-timeout override before factory routing."""

    classifier = create_keyword_classifier(
        LlmProviderConfig(
            provider="openai",
            apiKey="key",
            model="gpt",
            timeoutSeconds=960,
        )
    )

    assert getattr(classifier, "timeout_seconds", None) == 960


@pytest.mark.asyncio
@pytest.mark.parametrize(("configured_timeout", "expected_timeout"), [(120, 900), (960, 960)])
async def test_product_normalization_inherits_and_clamps_the_model_timeout(
    configured_timeout: int, expected_timeout: int
) -> None:
    """The nested normalizer is another model call, not a five-minute exception."""

    async def stalled(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("socket stalled")

    result = await normalize_extractor_product_profile_with_agent(
        {
            "source": "https://example.test/product",
            "sourceType": "url",
            "bootstrapProduct": {"name": "Barrier Cream"},
            "rawSource": {"name": "Barrier Cream"},
        },
        {
            "provider": "openai",
            "apiKey": "key",
            "model": "gpt",
            "timeoutSeconds": configured_timeout,
            "transport": httpx.MockTransport(stalled),
            "productNormalization": {"enabled": True},
        },
    )

    assert result["warnings"] == [f"OpenAI product profile normalization timed out after {expected_timeout}s."]

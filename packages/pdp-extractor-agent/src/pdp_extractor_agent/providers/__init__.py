"""Provider adapters and the retained provider-factory compatibility surface."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any, cast

import httpx

from .._json_types import as_mapping
from ..models import LlmProviderConfig
from .aistudio import AistudioKeywordClassifier, AistudioProvider
from .azure_openai import AzureApiKeywordClassifier, AzureOpenAIProvider
from .gemini import GeminiKeywordClassifier, GeminiProvider
from .mock import MockKeywordClassifier
from .openai import OpenAIKeywordClassifier, OpenAIProvider
from .transport import model_timeout_seconds

ImageFetcher = Callable[[str], Awaitable[tuple[str, bytes]]]


def create_keyword_classifier(config: LlmProviderConfig | Mapping[str, Any]) -> Any:
    """Resolve the configured classifier without importing provider SDKs eagerly."""

    values: dict[str, Any] = (
        config.model_dump(by_alias=True, exclude_none=True) if isinstance(config, LlmProviderConfig) else dict(config)
    )
    # Provider settings are an intentionally opaque application-injection
    # boundary. Preserve values verbatim here; adapters only coerce values at
    # the point they actually construct an HTTP request, as the TS factory
    # does. In particular, deployment IDs must not be stringified merely to
    # satisfy static typing.
    provider_value = values.get("provider")
    provider = provider_value if isinstance(provider_value, str) else "mock"
    api_key = cast(str, values.get("apiKey") if values.get("apiKey") is not None else values.get("api_key") or "")
    model = cast(str, values.get("model") if values.get("model") is not None else "")
    transport = _transport(values.get("transport"))
    image_fetcher = _image_fetcher(values.get("imageFetcher") or values.get("image_fetcher"))
    timeout_seconds = model_timeout_seconds(_value(values, "timeoutSeconds", "timeout_seconds"))
    if provider == "openai":
        return OpenAIProvider(
            api_key=api_key,
            model=model,
            temperature=_temperature(values.get("temperature")),
            transport=transport,
            image_fetcher=image_fetcher,
            timeout_seconds=timeout_seconds,
        )
    if provider == "gemini":
        return GeminiProvider(
            api_key=api_key,
            model=model,
            temperature=_temperature(values.get("temperature")),
            transport=transport,
            image_fetcher=image_fetcher,
            timeout_seconds=timeout_seconds,
        )
    if provider in {"azure-openai", "aistudio"}:
        deployments = values.get("deployments")
        if isinstance(deployments, LlmProviderConfig):  # defensive only; wire settings use mappings
            deployments = deployments.model_dump(by_alias=True, exclude_none=True)
        factory = AistudioProvider if provider == "aistudio" else AzureOpenAIProvider
        return factory(
            api_key=api_key,
            endpoint=cast(str, values.get("endpoint") if values.get("endpoint") is not None else ""),
            deployment=values.get("deployment"),
            deployments=_string_mapping(deployments),
            api_version=cast(
                str | None,
                values.get("apiVersion") if values.get("apiVersion") is not None else values.get("api_version"),
            ),
            temperature=_temperature(values.get("temperature")),
            transport=transport,
            image_fetcher=image_fetcher,
            timeout_seconds=timeout_seconds,
        )
    return MockKeywordClassifier()


def _transport(value: object) -> httpx.AsyncBaseTransport | None:
    # Configuration is intentionally transport-agnostic at construction time;
    # httpx validates it only when a request is made, as the legacy factory did.
    return cast(httpx.AsyncBaseTransport | None, value)


def _image_fetcher(value: object) -> ImageFetcher | None:
    # Keep injected test/application adapters opaque until their first use.
    return cast(ImageFetcher | None, value)


def _string_mapping(value: object) -> Mapping[str, str] | None:
    mapping = as_mapping(value)
    return cast(Mapping[str, str], mapping) if mapping is not None else None


def _temperature(value: object) -> float | None:
    return cast(float | None, value)


def _value(values: Mapping[str, Any], *keys: str) -> object:
    for key in keys:
        if key in values:
            return values[key]
    return None


createKeywordClassifier = create_keyword_classifier

__all__ = [
    "AistudioKeywordClassifier",
    "AistudioProvider",
    "AzureApiKeywordClassifier",
    "AzureOpenAIProvider",
    "GeminiKeywordClassifier",
    "GeminiProvider",
    "MockKeywordClassifier",
    "OpenAIKeywordClassifier",
    "OpenAIProvider",
    "create_keyword_classifier",
]

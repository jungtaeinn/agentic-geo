"""Provider-neutral generator model adapters and their HTTP wire contracts."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol, cast, runtime_checkable

from .aistudio import AistudioProvider
from .azure_openai import AzureOpenAIProvider
from .gemini import GeminiProvider
from .mock import MockProvider
from .openai import OpenAIProvider
from .transport import DeterministicMockTransport, ProviderResult, ProviderTransportError, model_timeout_seconds


class ModelProvider(Protocol):
    """The small common boundary consumed by normalizer/planner/refiner stages."""

    async def generate_json(
        self,
        system: str | None = None,
        user: str | None = None,
        schema: Mapping[str, Any] | None = None,
        schema_name: str | None = None,
        *,
        stage: str | None = None,
        payload: Mapping[str, Any] | None = None,
        json_schema: Mapping[str, Any] | None = None,
        label: str | None = None,
        max_output_tokens: object = None,
        required_message: str | None = None,
    ) -> ProviderResult: ...


@runtime_checkable
class _ModelDumpable(Protocol):
    def model_dump(self, *, by_alias: bool, exclude_none: bool) -> object: ...


def create_provider(config: Mapping[str, Any] | object) -> ModelProvider:
    """Resolve an explicit provider while preserving caller-supplied transports.

    Credentials are not validated until a request is made.  That matches the
    TypeScript factory and lets REST configuration validation report the stage
    that actually needs a missing value.
    """

    values = _values(config)
    provider = _string(values.get("provider")) or "mock"
    temperature = _value(values, "temperature")
    transport = _value(values, "transport")
    timeout_seconds = model_timeout_seconds(_value(values, "timeoutSeconds", "timeout_seconds"))
    if provider == "mock":
        return MockProvider(_value(values, "mockResponse", "mock_response"))
    if provider == "openai":
        return OpenAIProvider(
            api_key=_value(values, "apiKey", "api_key"),
            model=_value(values, "model"),
            temperature=temperature,
            transport=transport,
            timeout_seconds=timeout_seconds,
        )
    if provider == "gemini":
        return GeminiProvider(
            api_key=_value(values, "apiKey", "api_key"),
            model=_value(values, "model"),
            temperature=temperature,
            transport=transport,
            timeout_seconds=timeout_seconds,
        )
    if provider in {"azure-openai", "aistudio"}:
        deployments = _value(values, "deployments")
        adapter = AistudioProvider if provider == "aistudio" else AzureOpenAIProvider
        return adapter(
            api_key=_value(values, "apiKey", "api_key"),
            endpoint=_value(values, "endpoint"),
            deployment=_value(values, "deployment"),
            deployments=_object_mapping(deployments),
            api_version=_value(values, "apiVersion", "api_version"),
            temperature=temperature,
            transport=transport,
            timeout_seconds=timeout_seconds,
        )
    if provider == "custom":
        raise ValueError("custom PDP GEO provider requires an injected model provider.")
    raise ValueError(f"Unsupported PDP GEO provider: {provider}")


def _values(config: Mapping[str, Any] | object) -> dict[str, Any]:
    if isinstance(config, Mapping):
        return dict(cast(Mapping[str, Any], config))
    if isinstance(config, _ModelDumpable):
        dumped = config.model_dump(by_alias=True, exclude_none=True)
        mapping = _any_mapping(dumped)
        if mapping is not None:
            return dict(mapping)
    raise TypeError("Provider configuration must be a mapping or Pydantic wire model.")


def _value(values: Mapping[str, Any], *keys: str) -> object:
    for key in keys:
        if key in values:
            return values[key]
    return None


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""


def _any_mapping(value: object) -> Mapping[str, Any] | None:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else None


def _object_mapping(value: object) -> Mapping[str, object] | None:
    return cast(Mapping[str, object], value) if isinstance(value, Mapping) else None


createProvider = create_provider

__all__ = [
    "AistudioProvider",
    "AzureOpenAIProvider",
    "DeterministicMockTransport",
    "GeminiProvider",
    "MockProvider",
    "ModelProvider",
    "OpenAIProvider",
    "ProviderResult",
    "ProviderTransportError",
    "create_provider",
]

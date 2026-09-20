"""Azure OpenAI Chat Completions adapter for generator model stages."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast
from urllib.parse import quote

import httpx

from .transport import (
    DEFAULT_MODEL_TIMEOUT_SECONDS,
    ProviderResult,
    chat_completions_output_text,
    model_timeout_seconds,
    post_json_with_temperature_fallback,
    resolve_generation_request,
    result_from_payload,
    stage_required_message,
    temperature_body,
    token_usage_from_chat_completions,
)

_ENCODE_COMPONENT_SAFE = "-_.!~*'()"
DEFAULT_AZURE_API_VERSION = "2025-04-01-preview"


def build_chat_completions_body(
    *,
    system: str,
    user: str,
    schema: Mapping[str, Any] | None = None,
    schema_name: str = "pdp_geo_response",
    temperature: object = None,
    max_output_tokens: object = None,
) -> dict[str, Any]:
    """Construct the Azure/AI Studio strict Chat Completions body."""

    body: dict[str, Any] = {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        **temperature_body(temperature),
    }
    if schema is not None:
        body["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": schema_name, "strict": True, "schema": dict(schema)},
        }
    if isinstance(max_output_tokens, int | float) and not isinstance(max_output_tokens, bool):
        body["max_completion_tokens"] = max_output_tokens
    return body


class AzureOpenAIProvider:
    """Deployment-addressed Chat Completions adapter with Azure API-key auth."""

    provider_display_name = "Azure"
    provider_id = "azure-openai"

    def __init__(
        self,
        *,
        api_key: object,
        endpoint: object,
        deployment: object | None = None,
        deployments: Mapping[str, object] | None = None,
        api_version: object | None = None,
        temperature: object = None,
        transport: object = None,
        timeout_seconds: float = DEFAULT_MODEL_TIMEOUT_SECONDS,
    ) -> None:
        self.api_key = api_key
        self.endpoint = endpoint
        self.deployment = deployment
        self.deployments = dict(deployments or {})
        self.api_version = api_version
        self.temperature = temperature
        self.transport = transport
        self.timeout_seconds = model_timeout_seconds(timeout_seconds)

    def deployment_for(self, role: str = "reasoning") -> object | None:
        """Use an explicit role deployment when supplied, otherwise the default."""

        configured = self.deployments.get(role)
        return self.deployment if configured is None else configured

    deploymentFor = deployment_for

    def chat_completions_url(self, deployment: object) -> str:
        """Build Azure's deployment-scoped endpoint with the preview default."""

        endpoint = _text(self.endpoint).removesuffix("/")
        version = self.api_version if self.api_version is not None else DEFAULT_AZURE_API_VERSION
        return (
            f"{endpoint}/openai/deployments/{quote(_text(deployment), safe=_ENCODE_COMPONENT_SAFE)}/chat/completions"
            f"?api-version={quote(_text(version), safe=_ENCODE_COMPONENT_SAFE)}"
        )

    chatCompletionsUrl = chat_completions_url

    def auth_headers(self) -> dict[str, str]:
        return {"api-key": _text(self.api_key)}

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
        deployment: object | None = None,
        deployment_role: str = "reasoning",
        max_output_tokens: object = None,
        required_message: str | None = None,
    ) -> ProviderResult:
        """Generate structured Chat Completions text for one generator stage."""

        request = resolve_generation_request(
            self.provider_display_name,
            system,
            user,
            schema,
            schema_name,
            stage=stage,
            payload=payload,
            json_schema=json_schema,
            label=label,
        )
        chosen_deployment = self.deployment_for(deployment_role) if deployment is None else deployment
        self._require(
            chosen_deployment,
            request.label,
            required_message or stage_required_message(self.provider_id, stage),
        )
        payload = await post_json_with_temperature_fallback(
            self.chat_completions_url(chosen_deployment),
            self.auth_headers(),
            build_chat_completions_body(
                system=request.system,
                user=request.user,
                schema=request.schema,
                schema_name=request.schema_name,
                temperature=self.temperature,
                max_output_tokens=max_output_tokens,
            ),
            request.label,
            transport=cast(httpx.AsyncBaseTransport | None, self.transport),
            timeout_seconds=self.timeout_seconds,
        )
        return result_from_payload(
            chat_completions_output_text(payload), payload, token_usage_from_chat_completions(payload.get("usage"))
        )

    generateJson = generate_json

    async def generate_text(
        self,
        system: str,
        user: str,
        *,
        label: str = "Azure generation",
        deployment: object | None = None,
        deployment_role: str = "reasoning",
        max_output_tokens: object = None,
        required_message: str | None = None,
    ) -> ProviderResult:
        """Generate plain text through the same deployment/auth boundary."""

        return await self.generate_json(
            system,
            user,
            None,
            label=label,
            deployment=deployment,
            deployment_role=deployment_role,
            max_output_tokens=max_output_tokens,
            required_message=required_message,
        )

    generateText = generate_text

    def _require(self, deployment: object | None, label: str, required_message: str | None) -> None:
        if _text(self.api_key) and _text(self.endpoint) and _text(deployment):
            return
        if required_message:
            raise ValueError(required_message)
        raise ValueError(
            f"{self.provider_display_name} API key, endpoint, and reasoning deployment are required for {_stage_name(label)}."
        )


def _text(value: object) -> str:
    return value if isinstance(value, str) else str(value or "")


def _stage_name(label: str) -> str:
    prefix = "AI Studio " if label.startswith("AI Studio ") else "Azure "
    return label.removeprefix(prefix).strip().lower() or "generation"


buildChatCompletionsBody = build_chat_completions_body

__all__ = ["DEFAULT_AZURE_API_VERSION", "AzureOpenAIProvider", "build_chat_completions_body"]

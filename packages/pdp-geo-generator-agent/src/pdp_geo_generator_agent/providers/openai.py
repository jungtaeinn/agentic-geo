"""OpenAI Responses API adapter for generator model stages."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

import httpx

from .transport import (
    DEFAULT_MODEL_TIMEOUT_SECONDS,
    ProviderResult,
    model_timeout_seconds,
    openai_output_text,
    post_json_with_temperature_fallback,
    resolve_generation_request,
    result_from_payload,
    stage_required_message,
    temperature_body,
    token_usage_from_openai,
)

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"


def build_openai_responses_body(
    *,
    model: object,
    system: str,
    user: str,
    schema: Mapping[str, Any] | None = None,
    schema_name: str = "pdp_geo_response",
    temperature: object = None,
    max_output_tokens: object = None,
) -> dict[str, Any]:
    """Construct the native strict-structured-output Responses payload."""

    body: dict[str, Any] = {
        "model": _text(model),
        "instructions": system,
        "input": user,
        **temperature_body(temperature),
    }
    if isinstance(max_output_tokens, int | float) and not isinstance(max_output_tokens, bool):
        body["max_output_tokens"] = max_output_tokens
    if schema is not None:
        body["text"] = {
            "format": {
                "type": "json_schema",
                "name": schema_name,
                "strict": True,
                "schema": dict(schema),
            }
        }
    return body


class OpenAIProvider:
    """Framework-neutral OpenAI Responses adapter with a narrow compatibility retry."""

    def __init__(
        self,
        *,
        api_key: object,
        model: object,
        temperature: object = None,
        transport: object = None,
        timeout_seconds: float = DEFAULT_MODEL_TIMEOUT_SECONDS,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.temperature = temperature
        self.transport = transport
        self.timeout_seconds = model_timeout_seconds(timeout_seconds)

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
    ) -> ProviderResult:
        """Generate structured text and retain both raw envelope and parsed object."""

        request = resolve_generation_request(
            "OpenAI",
            system,
            user,
            schema,
            schema_name,
            stage=stage,
            payload=payload,
            json_schema=json_schema,
            label=label,
        )
        self._require(request.label, required_message or stage_required_message("openai", stage))
        payload = await post_json_with_temperature_fallback(
            OPENAI_RESPONSES_URL,
            {"Authorization": f"Bearer {_text(self.api_key)}"},
            build_openai_responses_body(
                model=self.model,
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
        return result_from_payload(openai_output_text(payload), payload, token_usage_from_openai(payload.get("usage")))

    generateJson = generate_json

    async def generate_text(
        self,
        system: str,
        user: str,
        *,
        label: str = "OpenAI generation",
        max_output_tokens: object = None,
        required_message: str | None = None,
    ) -> ProviderResult:
        """Generate unstructured text through the same transport/error contract."""

        return await self.generate_json(
            system,
            user,
            None,
            label=label,
            max_output_tokens=max_output_tokens,
            required_message=required_message,
        )

    generateText = generate_text

    def _require(self, label: str, required_message: str | None) -> None:
        if _text(self.api_key) and _text(self.model):
            return
        if required_message:
            raise ValueError(required_message)
        raise ValueError(f"OpenAI API key and model are required for {_stage_name(label)}.")


def _text(value: object) -> str:
    return value if isinstance(value, str) else str(value or "")


def _stage_name(label: str) -> str:
    return label.removeprefix("OpenAI ").strip().lower() or "generation"


buildOpenAIResponsesBody = build_openai_responses_body

__all__ = ["OPENAI_RESPONSES_URL", "OpenAIProvider", "build_openai_responses_body"]

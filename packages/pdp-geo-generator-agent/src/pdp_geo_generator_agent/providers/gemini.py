"""Gemini GenerateContent adapter for generator model stages."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast
from urllib.parse import quote

import httpx

from .transport import (
    DEFAULT_MODEL_TIMEOUT_SECONDS,
    ProviderResult,
    gemini_output_text,
    model_timeout_seconds,
    post_json_with_temperature_fallback,
    resolve_generation_request,
    result_from_payload,
    stage_required_message,
    temperature_body,
    to_gemini_schema,
    token_usage_from_gemini,
)

_ENCODE_COMPONENT_SAFE = "-_.!~*'()"
GEMINI_GENERATE_CONTENT_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"


def gemini_generate_content_url(model: object) -> str:
    """Return a component-encoded GenerateContent endpoint."""

    return f"{GEMINI_GENERATE_CONTENT_ROOT}/{quote(_text(model), safe=_ENCODE_COMPONENT_SAFE)}:generateContent"


def build_gemini_generate_content_body(
    *,
    system: str,
    user: str,
    schema: Mapping[str, Any] | None = None,
    temperature: object = None,
    max_output_tokens: object = None,
) -> dict[str, Any]:
    """Construct Gemini's system/content/generationConfig request shape."""

    body: dict[str, Any] = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
    }
    generation_config: dict[str, Any] = dict(temperature_body(temperature))
    if schema is not None:
        generation_config.update(
            {
                "responseMimeType": "application/json",
                "responseSchema": to_gemini_schema(schema),
            }
        )
    if isinstance(max_output_tokens, int | float) and not isinstance(max_output_tokens, bool):
        generation_config["maxOutputTokens"] = max_output_tokens
    if generation_config:
        body["generationConfig"] = generation_config
    return body


class GeminiProvider:
    """Google Gemini adapter preserving GenerateContent wire details."""

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
        """Generate Gemini text with optional native JSON Schema constraints."""

        request = resolve_generation_request(
            "Gemini",
            system,
            user,
            schema,
            schema_name,
            stage=stage,
            payload=payload,
            json_schema=json_schema,
            label=label,
        )
        self._require(request.label, required_message or stage_required_message("gemini", stage))
        payload = await post_json_with_temperature_fallback(
            gemini_generate_content_url(self.model),
            {"x-goog-api-key": _text(self.api_key)},
            build_gemini_generate_content_body(
                system=request.system,
                user=request.user,
                schema=request.schema,
                temperature=self.temperature,
                max_output_tokens=max_output_tokens,
            ),
            request.label,
            transport=cast(httpx.AsyncBaseTransport | None, self.transport),
            timeout_seconds=self.timeout_seconds,
        )
        return result_from_payload(gemini_output_text(payload), payload, token_usage_from_gemini(payload.get("usageMetadata")))

    generateJson = generate_json

    async def generate_text(
        self,
        system: str,
        user: str,
        *,
        label: str = "Gemini generation",
        max_output_tokens: object = None,
        required_message: str | None = None,
    ) -> ProviderResult:
        """Generate unstructured Gemini text through the same adapter."""

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
        raise ValueError(f"Gemini API key and model are required for {_stage_name(label)}.")


def _text(value: object) -> str:
    return value if isinstance(value, str) else str(value or "")


def _stage_name(label: str) -> str:
    return label.removeprefix("Gemini ").strip().lower() or "generation"


geminiGenerateContentUrl = gemini_generate_content_url
buildGeminiGenerateContentBody = build_gemini_generate_content_body

__all__ = [
    "GEMINI_GENERATE_CONTENT_ROOT",
    "GeminiProvider",
    "build_gemini_generate_content_body",
    "gemini_generate_content_url",
]

"""Deterministic no-network provider for local generator runs and tests."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, cast

from .transport import ProviderResult, resolve_generation_request, result_from_payload

MockResponseFactory = Callable[[str, str, Mapping[str, Any] | None, str], object | Awaitable[object]]


class MockProvider:
    """Return a fixed structured response without fabricating network behavior."""

    def __init__(self, response: object = None) -> None:
        self.response: object = dict[str, object]() if response is None else response

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
        """Return configured fixture data while retaining the normal result shape."""

        request = resolve_generation_request(
            "Mock",
            system,
            user,
            schema,
            schema_name,
            stage=stage,
            payload=payload,
            json_schema=json_schema,
            label=label,
        )
        del max_output_tokens, required_message
        response: object = self.response
        if callable(response):
            candidate: object = cast(MockResponseFactory, response)(
                request.system, request.user, request.schema, request.label
            )
            response = await cast(Awaitable[object], candidate) if isinstance(candidate, Awaitable) else candidate
        if isinstance(response, ProviderResult):
            return response
        payload = _mapping(response)
        if payload is not None:
            text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            return result_from_payload(text, {"provider": "mock"}, None)
        text = response if isinstance(response, str) else str(response)
        return result_from_payload(text, {"provider": "mock"}, None)

    generateJson = generate_json

    async def generate_text(
        self,
        system: str,
        user: str,
        *,
        label: str = "Mock generation",
        max_output_tokens: object = None,
        required_message: str | None = None,
    ) -> ProviderResult:
        """Use mock mode for a non-schema request as well."""

        return await self.generate_json(
            system,
            user,
            None,
            label=label,
            max_output_tokens=max_output_tokens,
            required_message=required_message,
        )

    generateText = generate_text


def _mapping(value: object) -> Mapping[str, Any] | None:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else None

__all__ = ["MockProvider", "MockResponseFactory"]

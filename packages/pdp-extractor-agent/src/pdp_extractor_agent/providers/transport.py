"""Small transport-neutral helpers shared by extractor provider adapters.

Adapters accept an ``httpx.MockTransport`` in tests and a normal HTTP transport
in production. Keeping these pure helpers here makes the provider wire
contracts testable without introducing an SDK-specific dependency.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import Any

from .._json_types import as_list, as_mapping

DEFAULT_MODEL_TIMEOUT_SECONDS = 900.0


def model_timeout_seconds(value: object) -> float:
    """Apply the user-facing minimum timeout to long-running model requests."""

    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0:
        return max(DEFAULT_MODEL_TIMEOUT_SECONDS, float(value))
    return DEFAULT_MODEL_TIMEOUT_SECONDS


def timeout_label_seconds(value: float) -> str:
    """Keep timeout diagnostics compact when the configured value is integral."""

    return str(int(value)) if value.is_integer() else str(value)


def resolve_image_inputs(request: Mapping[str, Any]) -> list[dict[str, str]]:
    """Prefer prepared tall-image inputs while retaining their display labels."""

    prepared = as_list(request.get("imageInputs"))
    if prepared:
        inputs: list[dict[str, str]] = []
        for item in prepared:
            item_mapping = as_mapping(item)
            if item_mapping is None:
                continue
            display_url = str(item_mapping.get("displayUrl") or item_mapping.get("imageUrl") or item_mapping.get("inputUrl") or "")
            input_url = str(item_mapping.get("inputUrl") or display_url)
            if display_url:
                inputs.append({"displayUrl": display_url, "inputUrl": input_url})
        if inputs:
            return inputs
    image_urls = as_list(request.get("imageUrls"))
    return (
        [{"displayUrl": str(image_url), "inputUrl": str(image_url)} for image_url in image_urls]
        if image_urls is not None
        else []
    )


def temperature_body(temperature: object) -> dict[str, int | float]:
    """Omit unset/non-finite temperatures so restrictive deployments succeed."""

    if isinstance(temperature, (int, float)) and not isinstance(temperature, bool) and math.isfinite(temperature):
        return {"temperature": temperature}
    return {}


def is_unsupported_structured_output_error(message: str) -> bool:
    return re.search(
        r"response_format|text\.format|json_schema|response[_ ]?schema|structured outputs?|invalid schema",
        message,
        re.IGNORECASE,
    ) is not None


def response_json_object(response: Any, label: str) -> Mapping[str, Any]:
    """Read the successful provider envelope with JS ``response.json`` shape rules.

    A status-200 JSON ``null`` or array is not a usable provider response.  In
    TypeScript, the next property read throws rather than silently becoming an
    empty result; make that failure explicit and consistent across adapters.
    """

    try:
        payload = response.json()
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"{label} returned an invalid JSON object.") from error
    mapping = as_mapping(payload)
    if mapping is None:
        raise RuntimeError(f"{label} returned an invalid JSON object.")
    return mapping


# Legacy-style aliases are intentional package-boundary compatibility helpers.
resolveImageInputs = resolve_image_inputs
temperatureBody = temperature_body
isUnsupportedStructuredOutputError = is_unsupported_structured_output_error
responseJsonObject = response_json_object

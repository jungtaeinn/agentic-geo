"""Shared structured-output and image-data helpers for provider adapters."""

from __future__ import annotations

import base64
import json
import re
from typing import Any

from .._json_types import as_mapping


def parse_json_object_text(value: str) -> dict[str, Any]:
    try:
        parsed: object = json.loads(value)
        mapping = as_mapping(parsed)
        return dict(mapping) if mapping is not None else {}
    except json.JSONDecodeError:
        matched = re.search(r"\{.*\}", value, re.DOTALL)
        if not matched:
            return {}
        try:
            parsed: object = json.loads(matched.group(0))
            mapping = as_mapping(parsed)
            return dict(mapping) if mapping is not None else {}
        except json.JSONDecodeError:
            return {}


def data_url(mime_type: str, content: bytes) -> str:
    return f"data:{mime_type};base64,{base64.b64encode(content).decode('ascii')}"


def response_payload(response_json: dict[str, Any]) -> dict[str, Any]:
    raw = response_json.get("output_text") or response_json.get("text") or "{}"
    return parse_json_object_text(str(raw))

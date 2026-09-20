"""Strictly bounded parser for provider-reported OCR layout relations."""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from typing import Any

from .._json_types import as_list, as_mapping

_ROLES: list[str] = ["title", "body", "label", "value", "footnote"]

# OpenAI/Azure receive the strict JSON-schema contract.  Gemini is projected
# below into its OpenAPI subset, which is the only dialect using ``nullable``.
_LINE: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "text": {"type": "string"},
        "role": {
            "type": "string",
            "enum": _ROLES,
            "description": "Layout function of the line, not its meaning: title, body, label (axis tick, legend name, caption, package spec), value (a measured number or badge), footnote.",
        },
        "pairedLabel": {
            "type": ["string", "null"],
            "description": "For a value line, the label it is printed against (its bar's tick, its badge caption). null when the layout does not pair it.",
        },
    },
    "required": ["text", "role", "pairedLabel"],
}
_GROUP: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "id": {"type": "string", "description": "Short id unique within this image, e.g. g1."},
        "parentId": {"type": ["string", "null"], "description": "Id of the enclosing group, or null at top level."},
        "title": {"type": ["string", "null"], "description": "The group's own heading text when the layout sets one apart, or null."},
        "ordinal": {"type": ["integer", "null"], "description": "Number the layout actually printed for this group, or null. Never number groups yourself."},
        "annotates": {"type": ["string", "null"], "description": "For a footnote, disclaimer, or test-condition group, the id of the group it qualifies. Otherwise null."},
        "lines": {"type": "array", "items": _LINE},
    },
    "required": ["id", "parentId", "title", "ordinal", "annotates", "lines"],
}
IMAGE_OCR_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "images": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "index": {"type": "integer", "description": "1-based number of the image as labeled in the prompt."},
                    "imageUrl": {"type": "string", "description": "Image URL exactly as labeled in the prompt."},
                    "text": {"type": "string", "description": "Faithful transcription of all visible text in reading order. Empty string when no readable product text."},
                    "confidence": {"type": "number", "description": "0-1 legibility/completeness confidence for this transcription."},
                    "groups": {
                        "type": "array",
                        "description": "Layout relations visible in the image: groups of lines. No template is assumed.",
                        "items": _GROUP,
                    },
                },
                "required": ["index", "imageUrl", "text", "confidence", "groups"],
            },
        }
    },
    "required": ["images"],
}


def _to_gemini_schema(value: object) -> Any:
    values = as_list(value)
    if values is not None:
        return [_to_gemini_schema(item) for item in values]
    mapping = as_mapping(value)
    if mapping is None:
        return value
    result: dict[str, Any] = {}
    for key, child in mapping.items():
        if key in {"additionalProperties", "description"}:
            continue
        if key == "type" and isinstance(child, str):
            result[key] = child.upper()
        elif key == "type" and (type_values := as_list(child)) is not None:
            concrete = next((item for item in type_values if isinstance(item, str) and item != "null"), None)
            if concrete is not None:
                result[key] = concrete.upper()
            if "null" in type_values:
                result["nullable"] = True
        else:
            result[key] = _to_gemini_schema(child)
    return result


GEMINI_IMAGE_OCR_RESPONSE_SCHEMA: dict[str, Any] = _to_gemini_schema(IMAGE_OCR_JSON_SCHEMA)


def parse_image_ocr_payload_text(raw_text: str, requested_urls: Sequence[str]) -> dict[str, Any]:
    """Normalize a structured OCR response without inventing unreported facts.

    Invalid group/line shape is intentionally dropped at this boundary; later
    layout verification decides whether accepted text is backed by the OCR
    transcription itself.
    """

    json_text = _json_object_text(raw_text)
    if json_text is None:
        return {"images": [], "rawText": raw_text}
    try:
        payload: object = json.loads(json_text)
    except json.JSONDecodeError:
        return {"images": [], "rawText": raw_text}
    payload_mapping = as_mapping(payload)
    image_values = as_list(payload_mapping.get("images")) if payload_mapping is not None else None
    if image_values is None:
        return {"images": [], "rawText": raw_text}
    images: list[dict[str, Any]] = []
    for position, raw in enumerate(image_values):
        raw_mapping = as_mapping(raw)
        if raw_mapping is None:
            continue
        index = raw_mapping.get("index")
        normalized: dict[str, Any] = {}
        index_url = requested_urls[index - 1] if isinstance(index, int) and not isinstance(index, bool) and 1 <= index <= len(requested_urls) else None
        echoed_url = _text(raw_mapping.get("imageUrl"))
        trusted_echo = echoed_url if echoed_url in requested_urls else None
        image_url = index_url or trusted_echo or echoed_url or (requested_urls[position] if position < len(requested_urls) else None)
        text = raw_mapping.get("text")
        if not isinstance(image_url, str) or not isinstance(text, str) or not text.strip():
            continue
        normalized["imageUrl"] = image_url
        normalized["text"] = text
        confidence = raw_mapping.get("confidence")
        if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
            normalized["confidence"] = max(0.0, min(1.0, float(confidence)))
        groups = as_list(raw_mapping.get("groups"))
        if groups is not None:
            normalized["groups"] = _groups(groups)
        images.append(normalized)
    return {"images": images, "rawText": raw_text}


def _json_object_text(raw_text: str) -> str | None:
    text = raw_text.strip()
    if text.startswith("{") and text.endswith("}"):
        return text
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
    if fenced is not None and fenced.group(1).strip().startswith("{"):
        return fenced.group(1).strip()
    matched = re.search(r"\{[\s\S]*\}", text)
    return matched.group(0) if matched is not None else None


def _groups(raw_groups: Sequence[object]) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    for raw in raw_groups:
        raw_mapping = as_mapping(raw)
        if raw_mapping is None:
            continue
        identifier = _text(raw_mapping.get("id"))
        if not identifier:
            continue
        group: dict[str, Any] = {"id": identifier, "lines": _lines(raw_mapping.get("lines"))}
        for name in ("parentId", "title", "annotates"):
            value = _text(raw_mapping.get(name))
            if value:
                group[name] = value
        ordinal = raw_mapping.get("ordinal")
        if isinstance(ordinal, int) and not isinstance(ordinal, bool) and ordinal >= 0:
            group["ordinal"] = ordinal
        groups.append(group)
    return groups


def _lines(raw_lines: object) -> list[dict[str, str]]:
    lines_raw = as_list(raw_lines)
    if lines_raw is None:
        return []
    lines: list[dict[str, str]] = []
    for raw in lines_raw:
        raw_mapping = as_mapping(raw)
        if raw_mapping is None:
            continue
        text, role = _text(raw_mapping.get("text")), _text(raw_mapping.get("role"))
        if not text or role not in _ROLES:
            continue
        line = {"text": text, "role": role}
        paired = _text(raw_mapping.get("pairedLabel"))
        if paired:
            line["pairedLabel"] = paired
        lines.append(line)
    return lines


def _text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None

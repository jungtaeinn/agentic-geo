"""OCR layout wire-parser and schema contracts (8 legacy counterparts)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

from pdp_extractor_agent.ocr.layout import (
    GEMINI_IMAGE_OCR_RESPONSE_SCHEMA,
    IMAGE_OCR_JSON_SCHEMA,
    parse_image_ocr_payload_text,
)
from pdp_extractor_agent.schemas import KEYWORD_CLASSIFICATION_JSON_SCHEMA

URLS = ["https://img.example.com/a.png"]


def _payload(groups: list[object]) -> str:
    return json.dumps(
        {
            "images": [
                {
                    "index": 1,
                    "imageUrl": URLS[0],
                    "confidence": 0.98,
                    "text": "Benefit\\n1\\nProtect barrier",
                    "groups": groups,
                }
            ]
        }
    )


def test_reads_groups_nullable_fields_and_line_roles() -> None:
    parsed = parse_image_ocr_payload_text(
        _payload(
            [
                {
                    "id": "g1",
                    "parentId": None,
                    "title": "Benefit",
                    "ordinal": None,
                    "annotates": None,
                    "lines": [{"text": "Benefit", "role": "title", "pairedLabel": None}],
                },
                {
                    "id": "g2",
                    "parentId": "g1",
                    "title": None,
                    "ordinal": 1,
                    "annotates": None,
                    "lines": [{"text": "Protect barrier", "role": "body", "pairedLabel": None}],
                },
            ]
        ),
        URLS,
    )
    assert parsed["images"][0]["groups"] == [
        {"id": "g1", "title": "Benefit", "lines": [{"text": "Benefit", "role": "title"}]},
        {"id": "g2", "parentId": "g1", "ordinal": 1, "lines": [{"text": "Protect barrier", "role": "body"}]},
    ]


def test_keeps_payload_without_groups_usable() -> None:
    parsed = parse_image_ocr_payload_text(json.dumps({"images": [{"index": 1, "text": "How to use"}]}), URLS)
    assert parsed["images"] == [{"imageUrl": URLS[0], "text": "How to use"}]


def test_drops_a_line_with_an_unknown_layout_role() -> None:
    parsed = parse_image_ocr_payload_text(
        _payload([{"id": "g1", "lines": [{"text": "Benefit", "role": "headline"}]}]), URLS
    )
    assert parsed["images"][0]["groups"] == [{"id": "g1", "lines": []}]


def test_keeps_a_value_line_paired_label() -> None:
    parsed = parse_image_ocr_payload_text(
        _payload([{"id": "g1", "lines": [{"text": "+84.3%", "role": "value", "pairedLabel": "After 4 weeks"}]}]), URLS
    )
    assert parsed["images"][0]["groups"][0]["lines"] == [
        {"text": "+84.3%", "role": "value", "pairedLabel": "After 4 weeks"}
    ]


def test_drops_a_group_with_no_identifier() -> None:
    parsed = parse_image_ocr_payload_text(_payload([{"id": "", "title": "Benefit", "lines": []}]), URLS)
    assert parsed["images"][0]["groups"] == []


def test_schema_requires_groups_for_each_image() -> None:
    properties = IMAGE_OCR_JSON_SCHEMA["properties"]["images"]["items"]["properties"]
    required = IMAGE_OCR_JSON_SCHEMA["properties"]["images"]["items"]["required"]
    assert "groups" in properties and "groups" in required


def test_schema_exposes_only_the_five_layout_roles() -> None:
    roles = IMAGE_OCR_JSON_SCHEMA["properties"]["images"]["items"]["properties"]["groups"]["items"]["properties"][
        "lines"
    ]["items"]["properties"]["role"]["enum"]
    assert roles == ["title", "body", "label", "value", "footnote"]


def test_image_ocr_schema_matches_the_frozen_typescript_contract_snapshot() -> None:
    """Every strict-schema field and description tracks ``src/llm/schemas.ts``."""

    snapshot = Path(__file__).with_name("fixtures") / "image-ocr-schema.ts.snapshot.json"
    assert IMAGE_OCR_JSON_SCHEMA == json.loads(snapshot.read_text(encoding="utf-8"))


def test_gemini_schema_uses_nullable_not_type_unions() -> None:
    def visit(value: object) -> list[dict[str, Any]]:
        if isinstance(value, dict):
            mapping = cast(dict[str, Any], value)
            return [mapping, *[node for child in mapping.values() for node in visit(child)]]
        if isinstance(value, list):
            return [node for child in cast(list[Any], value) for node in visit(child)]
        return []

    nodes = visit(GEMINI_IMAGE_OCR_RESPONSE_SCHEMA)
    assert not any(isinstance(node.get("type"), list) for node in nodes)
    assert any(node.get("nullable") is True for node in nodes)


def test_canonical_provider_schemas_are_strict_before_gemini_dialect_conversion() -> None:
    """OpenAI/Azure receive the strict TS schema; only Gemini gets nullable dialect fields."""

    def visit(value: object) -> list[dict[str, Any]]:
        if isinstance(value, dict):
            mapping = cast(dict[str, Any], value)
            return [mapping, *[node for child in mapping.values() for node in visit(child)]]
        if isinstance(value, list):
            return [node for child in cast(list[Any], value) for node in visit(child)]
        return []

    canonical_nodes = visit(IMAGE_OCR_JSON_SCHEMA) + visit(KEYWORD_CLASSIFICATION_JSON_SCHEMA)
    strict_objects = [node for node in canonical_nodes if node.get("type") == "object"]
    assert strict_objects and all(node.get("additionalProperties") is False for node in strict_objects)
    image_properties = IMAGE_OCR_JSON_SCHEMA["properties"]["images"]["items"]["properties"]
    assert image_properties["imageUrl"] == {
        "type": "string",
        "description": "Image URL exactly as labeled in the prompt.",
    }
    assert image_properties["text"]["type"] == "string" and "nullable" not in image_properties["text"]
    evidence_description = (
        "1-based Evidence number in this request that this insight was derived from. 0 when unknown."
    )
    assert (
        KEYWORD_CLASSIFICATION_JSON_SCHEMA["properties"]["sentenceInsights"]["items"]["properties"]["evidenceIndex"]
        ["description"]
        == evidence_description
    )
    safety_tests = KEYWORD_CLASSIFICATION_JSON_SCHEMA["properties"]["semanticFacts"]["properties"]["safetyTests"]
    assert safety_tests == {"type": "array", "items": {"type": "string"}}

"""Load retained legacy API test data without a Node or YAML runtime."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, cast

from frozen_contracts import object_mapping

FIXTURE_ROOT = Path(__file__).parent / "fixtures"
GEO_SCHEMA_FIXTURE = FIXTURE_ROOT / "geo-schema.sql"
_GEO_CASES = FIXTURE_ROOT / "regression"
_FIELD = re.compile(r"^(id|name|tags):\s*(.+)$", re.MULTILINE)
_EXPECT = re.compile(
    r"^expect:\s*$\n^\s{2}resultStatus:\s*(\S+)\s*$\n^\s{2}schemaTypes:\s*(\[[^\n]+\])\s*$",
    re.MULTILINE,
)


def _metadata(text: str, field: str) -> object:
    for match in _FIELD.finditer(text):
        if match.group(1) == field:
            value = match.group(2)
            if field in {"name", "tags"}:
                return json.loads(value)
            return value
    raise ValueError(f"Missing {field!r} in GEO regression case")


def _request(text: str) -> dict[str, Any]:
    marker = "request: "
    start = text.find(marker)
    if start < 0:
        raise ValueError("Missing request payload in GEO regression case")
    value, _ = json.JSONDecoder().raw_decode(text[start + len(marker) :])
    if not isinstance(value, dict):
        raise ValueError("GEO regression request is not an object")
    return cast(dict[str, Any], object_mapping(cast(dict[object, object], value)))


def _expectation(text: str) -> dict[str, object]:
    match = _EXPECT.search(text)
    if match is None:
        raise ValueError("Missing expectation in GEO regression case")
    schema_types = json.loads(match.group(2))
    if not isinstance(schema_types, list):
        raise ValueError("GEO regression schema types are invalid")
    values = cast(list[object], schema_types)
    if not all(isinstance(item, str) for item in values):
        raise ValueError("GEO regression schema types are invalid")
    return {"resultStatus": match.group(1), "schemaTypes": cast(list[str], values)}


def load_geo_regression_cases() -> list[dict[str, Any]]:
    """Read the four retained request payloads as Python migration inputs.

    Each request is deliberately authored as JSON inside a YAML envelope, so
    the standard library decodes the API payload exactly without a new parser
    dependency. The envelope fields used by the old runner are read directly.
    """

    cases: list[dict[str, Any]] = []
    for path in sorted(_GEO_CASES.glob("GEO-*.yaml")):
        text = path.read_text(encoding="utf-8")
        name = _metadata(text, "name")
        tags = _metadata(text, "tags")
        if not isinstance(name, str) or not isinstance(tags, list):
            raise ValueError(f"Invalid metadata in {path.name}")
        cases.append(
            {
                "id": _metadata(text, "id"),
                "name": name,
                "tags": tags,
                "request": _request(text),
                "expect": _expectation(text),
            }
        )
    return cases

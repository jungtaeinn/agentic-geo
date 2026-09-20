"""Frozen evaluator wires captured from the retained TypeScript implementation."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from pdp_geo_eval_agent.models import to_wire
from pdp_geo_eval_agent.quality.evaluate import evaluate_geo_quality

FIXTURES = Path(__file__).with_name("fixtures")


@dataclass
class _NestedWireValue:
    retained: str
    omitted: str | None = None


@dataclass
class _WireValueWithoutMethod:
    nested: _NestedWireValue
    omitted: str | None = None
    values: list[object] | None = None


def test_generic_dataclass_wire_omits_none_object_fields_recursively_but_keeps_list_none() -> None:
    value = _WireValueWithoutMethod(
        nested=_NestedWireValue(retained="present"),
        values=[None, _NestedWireValue(retained="nested")],
    )

    assert to_wire(value) == {
        "nested": {"retained": "present"},
        "values": [None, {"retained": "nested"}],
    }


def test_empty_en_quality_wire_matches_the_captured_typescript_golden() -> None:
    expected = json.loads((FIXTURES / "quality-empty-en.json").read_text())

    actual = evaluate_geo_quality(
        {"jsonLd": {}, "diagnostics": {"normalizedProduct": {}, "validationWarnings": []}},
        "en",
    ).to_wire()

    assert actual == expected

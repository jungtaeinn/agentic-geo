"""Deterministic, sanitized source-case contracts for later PDP quality work."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast

import pytest

from pdp_extractor_agent.service import extract_product_from_html

_FIXTURE_PATH = Path(__file__).with_name("fixtures") / "source_quality_cases.v1.json"


def _source_cases() -> list[dict[str, Any]]:
    payload = cast(Mapping[str, object], json.loads(_FIXTURE_PATH.read_text(encoding="utf-8")))
    assert payload["version"] == "v1"
    return [cast(dict[str, Any], case) for case in cast(list[object], payload["cases"])]


def test_source_quality_fixture_preserves_identity_and_source_roles_in_order() -> None:
    cases = _source_cases()

    assert [(case["locale"], case["market"]) for case in cases] == [("en-US", "US"), ("ko-KR", "KR")]
    assert [case["sourceUrl"] for case in cases] == [
        "https://catalog.example/products/evidence-serum",
        "https://catalog.example/kr/products/evidence-toner",
    ]
    for case in cases:
        facts = cast(Mapping[str, Any], case["sourceFacts"])
        expected = cast(Mapping[str, Any], case["expectedSourceRoleFacts"])
        procedure = cast(list[Mapping[str, object]], facts["orderedProcedure"])
        formula = cast(Mapping[str, str], facts["formulaIngredient"])
        metric = cast(Mapping[str, str], facts["effectMetric"])

        assert [step["ordinal"] for step in procedure] == expected["procedureOrdinals"]
        assert all(step["text"] for step in procedure)
        assert formula["ingredient"] == expected["formulaIngredient"]
        assert formula["fact"]
        assert metric["metric"] == expected["qualifiedMetric"]
        assert metric["value"] and metric["caveat"]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", _source_cases(), ids=lambda case: str(case["id"]))
async def test_source_quality_cases_extract_visible_product_roots_without_network(case: Mapping[str, Any]) -> None:
    run = await extract_product_from_html(
        cast(str, case["html"]), cast(str, case["sourceUrl"]), {"provider": "mock"}
    )

    expected = cast(Mapping[str, str], case["expectedSourceRoleFacts"])
    assert run.result["geoProduct"]["name"] == expected["productName"]

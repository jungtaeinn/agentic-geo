"""Regression coverage for safe quality-gate diagnostics and degradation."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from typing import Any

import pytest

import pdp_geo_generator_agent.final_proofreader as final_proofreader
import pdp_geo_generator_agent.service as service


class _NoopRefiner:
    """Spend the one corrective pass without making a publishable change."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    def refine_copy(self, request: Mapping[str, Any]) -> dict[str, Any]:
        self.requests.append(dict(request))
        return {}


def _product() -> dict[str, Any]:
    return {
        "name": "Barrier Serum",
        "brand": "Example Lab",
        "description": "Barrier Serum is a serum for dry skin.",
        "ingredients": ["Ceramide Complex"],
        "benefits": ["supports hydration"],
        "usage": ["Apply two pumps after cleansing."],
    }


def _no_public_copy_provenance(_input: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Model an unavailable binding seam without introducing an untyped test lambda."""

    return []


def test_quality_gate_omits_unbound_public_copy_and_exposes_safe_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unbound copy is omitted without discarding the remaining artifact.

    The provenance seams deliberately return no bindings.  This represents a
    bounded public-copy defect, not a malformed schema or an unavailable
    provider, so the quality gate must keep the valid graph and expose only
    safe omission diagnostics rather than turn the entire request into an
    error response.
    """

    # Empty both generation seams so the final public-copy units are genuinely
    # unresolved throughout the corrective pass and must be isolated.
    monkeypatch.setattr(service, "create_pdp_geo_public_copy_provenance", _no_public_copy_provenance)
    monkeypatch.setattr(final_proofreader, "create_pdp_geo_public_copy_provenance", _no_public_copy_provenance)
    refiner = _NoopRefiner()

    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": _product(), "hints": {"locale": "en-US"}},
            {
                "provider": "mock",
                "apiKey": "test-server-key-must-not-appear",
                "endpoint": "https://internal.example.test/should-not-appear",
                "analysisPrompt": "private prompt must not appear",
                "customCopyRefiner": refiner,
                "qualityGate": {"enabled": True, "thresholds": {"geo": 0, "cep": 0, "eeat": 0}},
            },
        )
    )

    diagnostics = run["diagnostics"]
    quality = diagnostics["qualityGate"]
    assert quality["attempted"] is True
    assert quality["adopted"] is False
    assert quality["initialScores"]
    assert quality["publicCopyOmissionCount"] > 0
    assert quality["reason"] == "Quality gate completed after omitting public-copy units without final evidence bindings."
    omissions = diagnostics["publicCopyOmissions"]
    assert {item["fieldPath"] for item in omissions} >= {"Product.description", "WebPage.description"}
    assert all(set(item) == {"fieldPath", "action", "reason", "count"} for item in omissions)
    # The seams above return no bindings, so no provenance entry was written
    # for any field.  That is the cause of every omission here, and it is what
    # the reason has to name: the fallback reason describes nothing and hid
    # exactly this state.
    assert all(item["reason"] == "noProvenanceEntry" for item in omissions)
    assert not any(finding["source"] == "public-copy-provenance" for finding in diagnostics["validationFindings"])
    assert all(step["status"] == "done" for step in run["process"])
    assert run["result"]["schemaMarkup"]["jsonLd"]["@graph"]
    assert any("refinementFeedback" in request for request in refiner.requests)
    serialized = json.dumps(diagnostics)
    assert "test-server-key-must-not-appear" not in serialized
    assert "internal.example.test" not in serialized
    assert "private prompt must not appear" not in serialized


def test_successful_generation_keeps_the_existing_result_contract() -> None:
    """Structured failure transport must not add a success-only compatibility field."""

    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": _product(), "hints": {"locale": "en-US"}},
            {"provider": "mock", "qualityGate": {"enabled": False}},
        )
    )

    assert set(run) == {"result", "diagnostics", "process"}
    assert set(run["result"]) >= {"schemaMarkup", "content", "diagnostics", "generatedAt"}
    assert "qualityGate" not in run["diagnostics"]

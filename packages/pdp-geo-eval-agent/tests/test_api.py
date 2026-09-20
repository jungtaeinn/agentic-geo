"""Direct Python API wrapper behavior for embedding callers."""

from __future__ import annotations

import importlib

import pytest


def test_create_geo_eval_response_returns_the_rest_wire_for_valid_structural_input() -> None:
    api = importlib.import_module("pdp_geo_eval_agent.api")

    result = api.create_geo_eval_response({"jsonLd": {}, "language": "en"})

    assert result["evaluation"]["dimensions"][0]["id"] == "geo"
    assert result["report"].startswith("Quality metrics")


def test_create_geo_eval_response_preserves_nullish_required_field_error() -> None:
    api = importlib.import_module("pdp_geo_eval_agent.api")

    with pytest.raises(ValueError, match='"jsonLd" is required'):
        api.create_geo_eval_response({"jsonLd": None})


def test_structural_array_jsonld_keeps_javascript_object_node_count() -> None:
    """``typeof [] === 'object'`` makes the legacy evaluator count one node."""
    evaluate = importlib.import_module("pdp_geo_eval_agent.quality.evaluate")

    result = evaluate.evaluate_geo_quality(
        {"jsonLd": [], "diagnostics": {"normalizedProduct": {}, "validationWarnings": []}},
        "en",
    )

    assert result.dimensions[0].evidence[0] == "1 schema nodes generated: none"

    nested = evaluate.evaluate_geo_quality(
        {"jsonLd": {"@graph": [[]]}, "diagnostics": {"normalizedProduct": {}, "validationWarnings": []}},
        "en",
    )
    assert nested.dimensions[0].evidence[0] == "1 schema nodes generated: none"


def test_root_jsonld_array_preserves_nested_product_text_like_javascript_records() -> None:
    """``typeof [] === 'object'`` retains its nested objects for text readers."""
    evaluate = importlib.import_module("pdp_geo_eval_agent.quality.evaluate")

    result = evaluate.evaluate_geo_quality(
        {
            "jsonLd": [{"@type": "Product", "description": "clinical 95% after 2 weeks"}],
            "diagnostics": {"normalizedProduct": {}, "validationWarnings": []},
        },
        "en",
    )

    assert result.overall_score == 50
    assert next(dimension for dimension in result.dimensions if dimension.id == "eeat").score == 50

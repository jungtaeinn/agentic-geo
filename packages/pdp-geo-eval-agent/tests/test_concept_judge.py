"""Behavioral port of the opt-in concept-embodiment judge suite."""

from __future__ import annotations

import asyncio
import importlib
import json
from typing import cast

import pytest

CONFIG = {"provider": "openai", "apiKey": "test-key", "model": "gpt-test"}


def _judge():
    return importlib.import_module("pdp_geo_eval_agent.quality.concept_judge")


def make_input() -> dict[str, object]:
    return {
        "jsonLd": {
            "@context": "https://schema.org",
            "@graph": [
                {"@type": "WebPage", "@id": "https://example.com/p#webpage", "name": "Renewal Serum", "description": "Renewal Serum product page."},
                {
                    "@type": "Product",
                    "@id": "https://example.com/p#product",
                    "name": "Renewal Serum",
                    "description": "Renewal Serum is a firming serum with ceramide capsules for dry skin.",
                    "additionalProperty": [{"@type": "PropertyValue", "name": "Skin Type", "value": "Dry"}],
                },
                {
                    "@type": "FAQPage",
                    "mainEntity": [{"@type": "Question", "name": "How often should I use this?", "acceptedAnswer": {"@type": "Answer", "text": "Use once daily in the evening."}}],
                },
                {"@type": "HowTo", "name": "How to use Renewal Serum", "step": [{"@type": "HowToStep", "name": "Apply", "text": "Apply a pump to clean, dry skin."}]},
            ],
        },
        "diagnostics": {
            "normalizedProduct": {
                "name": "Renewal Serum",
                "ingredients": ["Ceramide", "Niacinamide"],
                "benefits": ["Firming"],
                "effects": [],
                "usage": ["Apply once in the evening"],
                "reviews": {"keywords": ["hydrating"]},
            },
            "validationWarnings": [],
        },
    }


VALID_DIMENSIONS: dict[str, dict[str, object]] = {
    "geo": {"score": 80, "embodied": ["states what the product is"], "missing": ["no self-contained usage answer"], "improvements": ["surface the existing how-to step as a standalone sentence"]},
    "cep": {"score": 70, "embodied": [], "missing": ["no situation-to-need link"], "improvements": ["connect 'dry skin' to the ceramide ingredient already named"]},
    "eeat": {"score": 90, "embodied": ["explains ceramide's barrier function"], "missing": [], "improvements": []},
}

VALID: dict[str, object] = {
    "dimensions": VALID_DIMENSIONS,
    "summary": "Solid GEO coverage; the CEP path is not closed.",
}


def test_concept_prompt_includes_public_sections_and_source_signal_summary() -> None:
    prompt = _judge().build_concept_embodiment_prompt(make_input(), "en")
    assert "ceramide capsules" in prompt["user"].lower()
    assert "How often should I use this?" in prompt["user"]
    assert "Apply a pump" in prompt["user"]
    assert "Skin Type" in prompt["user"]
    assert "sourceIngredientCount" in prompt["user"]
    assert '"hasReviewSignal": true' in prompt["user"]


def test_concept_prompt_includes_a_singleton_json_ld_additional_property() -> None:
    input_ = make_input()
    graph = input_["jsonLd"]
    assert isinstance(graph, dict)
    graph_record = cast(dict[str, object], graph)
    raw_nodes = graph_record["@graph"]
    assert isinstance(raw_nodes, list)
    nodes = cast(list[object], raw_nodes)
    product = nodes[1]
    assert isinstance(product, dict)
    product_record = cast(dict[str, object], product)
    product_record["additionalProperty"] = {"@type": "PropertyValue", "name": "Skin Type", "value": "Dry"}

    prompt = _judge().build_concept_embodiment_prompt(input_, "en")

    assert "Skin Type: Dry" in prompt["user"]


def test_concept_prompt_states_fairness_and_non_invention_rules() -> None:
    prompt = _judge().build_concept_embodiment_prompt(make_input(), "en")
    assert "never penalize" in prompt["system"].lower()
    assert "never propose an improvement that would add information" in prompt["system"].lower()


@pytest.mark.parametrize(("language", "wanted", "unwanted"), [("ko", "Korean", "English"), ("en", "English", "Korean")])
def test_concept_prompt_requests_the_selected_response_language(language: str, wanted: str, unwanted: str) -> None:
    system = _judge().build_concept_embodiment_prompt(make_input(), language)["system"]
    assert wanted in system
    assert unwanted not in system


def test_parses_valid_concept_response_and_computes_overall_score() -> None:
    assessment = _judge().parse_concept_embodiment_response(json.dumps(VALID))
    assert [dimension.id for dimension in assessment.dimensions] == ["geo", "cep", "eeat"]
    assert assessment.dimensions[0].score == 80
    assert assessment.dimensions[0].missing == ["no self-contained usage answer"]
    assert assessment.overall_score == 80
    assert "CEP path" in assessment.summary


def test_parses_fenced_concept_json() -> None:
    assert _judge().parse_concept_embodiment_response(f"```json\n{json.dumps(VALID)}\n```").overall_score == 80


def test_rejects_concept_response_missing_dimension() -> None:
    with pytest.raises(ValueError, match='"cep"'):
        _judge().parse_concept_embodiment_response(json.dumps({"dimensions": {"geo": VALID_DIMENSIONS["geo"]}, "summary": "x"}))


def test_rejects_concept_response_out_of_range_score() -> None:
    raw: dict[str, object] = {"dimensions": {**VALID_DIMENSIONS, "geo": {"score": 120, "embodied": [], "missing": [], "improvements": []}}, "summary": "x"}
    with pytest.raises(ValueError, match="out-of-range"):
        _judge().parse_concept_embodiment_response(json.dumps(raw))


def test_rejects_concept_response_non_array_dimension_field() -> None:
    raw: dict[str, object] = {"dimensions": {**VALID_DIMENSIONS, "geo": {"score": 50, "embodied": "not an array", "missing": [], "improvements": []}}, "summary": "x"}
    with pytest.raises(ValueError, match="non-array"):
        _judge().parse_concept_embodiment_response(json.dumps(raw))


def test_rejects_concept_response_without_summary() -> None:
    with pytest.raises(ValueError, match="summary"):
        _judge().parse_concept_embodiment_response(json.dumps({"dimensions": VALID_DIMENSIONS}))


def test_judge_passes_built_prompt_to_injected_completion_and_parses_result() -> None:
    captured: dict[str, str] = {}

    async def complete(_config: object, system: str, user: str) -> str:
        captured.update(system=system, user=user)
        return json.dumps({"dimensions": {identifier: {"score": 100, "embodied": [], "missing": [], "improvements": []} for identifier in ("geo", "cep", "eeat")}, "summary": "ok"})

    assessment = asyncio.run(_judge().judge_concept_embodiment(make_input(), CONFIG, "en", complete))
    assert assessment.overall_score == 100
    assert "ceramide capsules" in captured["user"].lower()
    assert "English" in captured["system"]


def test_judge_propagates_clear_parse_error_for_malformed_model_json() -> None:
    async def complete(*_args: object) -> str:
        return "not json"

    with pytest.raises(ValueError, match="no JSON object"):
        asyncio.run(_judge().judge_concept_embodiment(make_input(), CONFIG, "en", complete))

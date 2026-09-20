"""The modern Python root keeps the evaluator's public surface discoverable."""

from __future__ import annotations

import importlib
from typing import get_args, get_type_hints, is_typeddict


def test_root_exports_the_public_citation_quality_probe_and_prompt_surfaces() -> None:
    api = importlib.import_module("pdp_geo_eval_agent")

    expected = {
        "attribute_citations_to_sections",
        "build_citation_answer_prompt",
        "build_concept_embodiment_prompt",
        "build_generated_source_text",
        "build_image_attributable_sections",
        "build_probe_distractors",
        "build_vanilla_source_text",
        "complete_with_provider",
        "contains_serialized_metadata",
        "derive_probe_queries",
        "evaluate_geo_quality",
        "evaluate_utility_gate",
        "extract_citation_sentences",
        "find_serialized_metadata_artifact",
        "format_geo_quality_evaluation_text",
        "generate_engine_answer",
        "geo_eval_engine_id",
        "get_evaluation_suite_copy",
        "get_geo_quality_copy",
        "judge_citation_quality",
        "judge_concept_embodiment",
        "judge_keypoint_coverage",
        "parse_concept_embodiment_response",
        "run_citation_probe",
        "score_citation_quality",
        "score_citation_visibility",
        "score_impression_shares",
        "score_keypoint_coverage",
        "z_normalize_scores",
    }

    assert expected <= set(api.__all__)
    assert all(callable(getattr(api, name)) for name in expected)


def test_root_re_exports_wire_value_objects() -> None:
    api = importlib.import_module("pdp_geo_eval_agent")

    for name in (
        "AttributableSection",
        "CitationQualityScore",
        "CitationSentence",
        "CitationVisibilityScore",
        "GeoQualityDimension",
        "GeoQualityEvaluation",
        "UtilityGateResult",
        "UtilityGateThresholds",
    ):
        assert name in api.__all__
        assert getattr(api, name).__module__ == "pdp_geo_eval_agent.models"


def test_root_re_exports_the_downstream_structural_and_benchmark_contract_types() -> None:
    api = importlib.import_module("pdp_geo_eval_agent")

    typed_dicts = {
        "GeoEvalEngineConfig",
        "CitationProbeResult",
        "EvalDiagnosticsInput",
        "GeneratedProductArtifact",
        "GeoEvalAggregates",
        "GeoEvalGoldenResult",
    }
    assert typed_dicts <= set(api.__all__)
    assert all(is_typeddict(getattr(api, name)) for name in typed_dicts)
    assert get_args(api.GeoEvalProvider.__value__) == ("openai", "gemini", "azure-openai", "aistudio")
    assert get_args(api.EvalProductId.__value__) == (
        "fieldnote-arcwell-night-serum",
        "fieldnote-daybreak-first-essence",
        "byeolmorae-waterfold-toner",
        "byeolmorae-cloudveil-mist",
    )
    assert {"provider", "apiKey", "model", "deployment", "endpoint", "apiVersion"} <= set(get_type_hints(api.GeoEvalEngineConfig))
    assert {"engineId", "probedAt", "queries", "mean", "gate", "warnings", "interpretation"} <= set(get_type_hints(api.CitationProbeResult))
    assert {"normalizedProduct", "validationWarnings", "evidenceLedger", "contentPlan"} <= set(get_type_hints(api.EvalDiagnosticsInput))
    assert {"publicText", "evidenceLedger"} == set(get_type_hints(api.GeneratedProductArtifact))
    assert {"goldens", "engineId", "byLocale", "byCepFocus", "gate"} <= set(get_type_hints(api.GeoEvalAggregates))
    assert {"goldenId", "productId", "vanilla", "generated", "delta", "gate"} <= set(get_type_hints(api.GeoEvalGoldenResult))

    type_module = importlib.import_module("pdp_geo_eval_agent.types")
    benchmark = importlib.import_module("pdp_geo_eval_agent.benchmark")
    for name in ("GeoEvalProvider", *typed_dicts):
        assert getattr(type_module, name) is getattr(api, name)
    for name in ("EvalProductId", "GeneratedProductArtifact", "GeoEvalAggregates", "GeoEvalGoldenResult"):
        assert getattr(benchmark, name) is getattr(api, name)

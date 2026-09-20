"""Post-validation GEO quality-gate helpers.

The evaluator supplies scores; this module owns the deterministic adoption
rule, which is intentionally stricter than a model's self-assessment.
"""

from __future__ import annotations

import inspect
from collections.abc import Mapping, Sequence
from typing import Any, cast

from pdp_geo_eval_agent import evaluate_geo_quality, judge_concept_embodiment, to_wire

from ._json import as_dict, as_list

DEFAULT_QUALITY_GATE_THRESHOLDS = {"geo": 90, "cep": 95, "eeat": 90}


def resolve_quality_gate_settings(
    settings: Mapping[str, Any] | None, corrective_runtime_available: bool
) -> dict[str, Any]:
    data, thresholds = as_dict(settings), as_dict(as_dict(settings).get("thresholds"))
    return {
        "enabled": data.get("enabled") if isinstance(data.get("enabled"), bool) else corrective_runtime_available,
        "thresholds": {key: thresholds.get(key, default) for key, default in DEFAULT_QUALITY_GATE_THRESHOLDS.items()},
        **({"conceptJudge": data["conceptJudge"]} if data.get("conceptJudge") else {}),
    }


def create_quality_eval_input(input_: Mapping[str, Any]) -> dict[str, Any]:
    markup = as_dict(input_.get("schemaMarkup"))
    return {
        "jsonLd": markup.get("jsonLd", {"@context": "https://schema.org", "@graph": markup.get("graph", [])}),
        "diagnostics": {
            "normalizedProduct": input_.get("normalizedProduct", {}),
            "validationWarnings": input_.get("validationWarnings", []),
            "validationRepairs": input_.get("validationRepairs", []),
            "ragUsage": input_.get("ragUsage", []),
            "evidence": input_.get("evidence", []),
            "evidenceLedger": input_.get("evidenceLedger", []),
            "contentPlan": input_.get("contentPlan"),
        },
    }


def evaluate_pdp_geo_artifact_quality(input_: Mapping[str, Any]) -> Any:
    return evaluate_geo_quality(create_quality_eval_input(input_), "ko" if input_.get("locale") == "ko-KR" else "en")


def quality_gate_scores(evaluation: Any) -> dict[str, int]:
    wire = to_wire(evaluation)
    dimensions = {
        str(item.get("id")): int(item.get("score", 0))
        for raw in as_list(as_dict(wire).get("dimensions"))
        if isinstance(raw, Mapping)
        for item in (cast(Mapping[str, Any], raw),)
    }
    return {
        "overall": int(as_dict(wire).get("overallScore", 0)),
        "geo": dimensions.get("geo", 0),
        "cep": dimensions.get("cep", 0),
        "eeat": dimensions.get("eeat", 0),
    }


def collect_quality_gate_shortfalls(
    scores: Mapping[str, int],
    thresholds: Mapping[str, int],
    unresolved_warning_count: int,
    unresolved_public_copy_count: int = 0,
) -> list[str]:
    shortfalls = [
        f"{label} {scores.get(key, 0)} < {thresholds.get(key, default)}"
        for key, label, default in (("geo", "GEO", 90), ("cep", "CEP", 95), ("eeat", "E-E-A-T", 90))
        if scores.get(key, 0) < thresholds.get(key, default)
    ]
    public_copy_count = max(0, unresolved_public_copy_count)
    if public_copy_count:
        shortfalls.append(f"{public_copy_count} unresolved public-copy provenance warning(s)")
    remaining_warning_count = max(0, unresolved_warning_count - public_copy_count)
    if remaining_warning_count > 0:
        shortfalls.append(f"{remaining_warning_count} unresolved validation warning(s)")
    return shortfalls


def count_unresolved_public_copy_findings(findings: Sequence[object]) -> int:
    """Count final-copy binding defects so gate feedback names their source."""

    return sum(as_dict(raw).get("source") == "public-copy-provenance" for raw in findings)


def create_quality_gate_feedback(
    evaluation: Any, scores: Mapping[str, int], thresholds: Mapping[str, int], validation_warnings: Sequence[str]
) -> list[dict[str, str]]:
    wire = as_dict(to_wire(evaluation))
    feedback: list[dict[str, str]] = []
    for warning in validation_warnings:
        before, separator, _ = warning.partition(":")
        feedback.append({"field": before.strip() if separator else "validation", "reason": warning})
    for dimension in as_list(wire.get("dimensions")):
        item = as_dict(dimension)
        dimension_id = str(item.get("id", ""))
        if scores.get(dimension_id, 0) < thresholds.get(dimension_id, 0):
            feedback.extend(
                {"field": f"quality-gate:{dimension_id}", "reason": str(reason)}
                for reason in as_list(item.get("improvements"))
                if isinstance(reason, str)
            )
    unique: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in feedback:
        key = item["field"], item["reason"]
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique[:12]


def should_adopt_corrected_artifacts(initial: Mapping[str, Any], corrected: Mapping[str, Any]) -> bool:
    """Strict improvement/rollback rule shared with the TypeScript pipeline."""
    before_scores, after_scores = as_dict(initial.get("scores")), as_dict(corrected.get("scores"))
    before_warnings, after_warnings = int(initial.get("warningCount", 0)), int(corrected.get("warningCount", 0))
    before, after = float(before_scores.get("overall", 0)), float(after_scores.get("overall", 0))
    if after_warnings > before_warnings:
        return False
    if after > before:
        return True
    if after < before:
        return False
    if after_warnings < before_warnings:
        return True
    before_concept, after_concept = initial.get("conceptScore"), corrected.get("conceptScore")
    return (
        isinstance(before_concept, int | float)
        and isinstance(after_concept, int | float)
        and after_concept > before_concept
    )


async def judge_concept_embodiment_safely(
    eval_input: Mapping[str, Any], config: Mapping[str, Any], locale: str
) -> dict[str, Any]:
    try:
        value = judge_concept_embodiment(eval_input, config, "ko" if locale == "ko-KR" else "en")
        if inspect.isawaitable(value):
            value = await value
        return {"assessment": value}
    except Exception as error:  # an optional judge must never break generation
        return {"error": str(error)}


def to_concept_assessment_diagnostics(assessment: Any) -> dict[str, Any]:
    wire = as_dict(to_wire(assessment))
    return {
        "overallScore": wire.get("overallScore", 0),
        "dimensions": [
            {
                "id": item.get("id"),
                "score": item.get("score"),
                "embodied": item.get("embodied", []),
                "missing": item.get("missing", []),
                "improvements": item.get("improvements", []),
            }
            for raw in as_list(wire.get("dimensions"))
            if (item := as_dict(raw))
        ],
        "summary": wire.get("summary", ""),
    }


def collect_concept_shortfalls(assessment: Any, thresholds: Mapping[str, int]) -> list[str]:
    return [
        f"concept {str(item.get('id')).upper()} {item.get('score')} < {thresholds.get(str(item.get('id')), 0)}"
        for raw in as_list(as_dict(to_wire(assessment)).get("dimensions"))
        if (item := as_dict(raw)) and float(item.get("score", 0)) < float(thresholds.get(str(item.get("id")), 0))
    ]


def create_concept_gate_feedback(assessment: Any, thresholds: Mapping[str, int]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for raw in as_list(as_dict(to_wire(assessment)).get("dimensions")):
        item, dimension = as_dict(raw), ""
        dimension = str(item.get("id", ""))
        if float(item.get("score", 0)) < float(thresholds.get(dimension, 0)):
            result.extend(
                {"field": f"concept:{dimension}", "reason": f"Missing embodiment: {reason}"}
                for reason in as_list(item.get("missing"))
                if isinstance(reason, str)
            )
            result.extend(
                {"field": f"concept:{dimension}", "reason": reason}
                for reason in as_list(item.get("improvements"))
                if isinstance(reason, str)
            )
    return result[:8]


resolveQualityGateSettings = resolve_quality_gate_settings
createQualityEvalInput = create_quality_eval_input
evaluatePdpGeoArtifactQuality = evaluate_pdp_geo_artifact_quality
qualityGateScores = quality_gate_scores
collectQualityGateShortfalls = collect_quality_gate_shortfalls
countUnresolvedPublicCopyFindings = count_unresolved_public_copy_findings
createQualityGateFeedback = create_quality_gate_feedback
shouldAdoptCorrectedArtifacts = should_adopt_corrected_artifacts
judgeConceptEmbodimentSafely = judge_concept_embodiment_safely
toConceptAssessmentDiagnostics = to_concept_assessment_diagnostics
collectConceptShortfalls = collect_concept_shortfalls
createConceptGateFeedback = create_concept_gate_feedback

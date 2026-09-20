"""Behavioral port of claim-modality and realization-defect lint tests."""

from __future__ import annotations

import importlib

UPGRADED_SENTENCE = (
    "In a self-assessment from clinical of 31 women who used the product daily, 96% of participants "
    "showed improvement in skin After 6 weeks of use."
)
PRESERVED_SENTENCE = "In a self-assessment with 31 women, 96% agreed skin felt smoother after 6 weeks."
NESTED_STEM_SENTENCE = (
    "In an instrumental assessment of 30 subjects, 100% of participants showed improvement in Visible improvement "
    "in fine lines After one bottle of daily use."
)
REPAIRED_SENTENCE = (
    "In an instrumental assessment of 30 subjects, 100% of participants showed visible improvement in fine lines "
    "after one bottle of daily use."
)


def _internal():
    return importlib.import_module("pdp_geo_eval_agent.quality.internal")


def _evaluate():
    return importlib.import_module("pdp_geo_eval_agent.quality.evaluate")


def test_detects_self_assessment_upgraded_to_objective_improvement_and_clinical_status() -> None:
    issues = _internal().collect_metric_integrity_issues(UPGRADED_SENTENCE, "en")
    text = " ".join(issues).lower()
    assert "upgrades a self-assessment" in text
    assert "attributes clinical status to a self-assessment" in text


def test_detects_korean_self_assessment_upgrade() -> None:
    issues = _internal().collect_metric_integrity_issues("자가 평가에서 96%의 참여자가 피부 개선을 확인했습니다.", "ko")
    assert "자가 평가" in " ".join(issues)


def test_preserved_self_assessment_modality_stays_clean() -> None:
    assert _internal().collect_metric_integrity_issues(PRESERVED_SENTENCE, "en") == []


def test_detects_nested_direction_stem() -> None:
    issues = _internal().collect_metric_integrity_issues(NESTED_STEM_SENTENCE, "en")
    text = " ".join(issues).lower()
    assert "repeats its direction stem" in text


def test_detects_capitalized_spliced_time_clause() -> None:
    issues = _internal().collect_metric_integrity_issues(NESTED_STEM_SENTENCE, "en")
    text = " ".join(issues).lower()
    assert "spliced mid-sentence" in text


def test_renders_korean_copy_for_both_realization_defects() -> None:
    issues = _internal().collect_metric_integrity_issues(NESTED_STEM_SENTENCE, "ko")
    text = " ".join(issues)
    assert "개선/감소 표현이 중첩" in text
    assert "문장 중간에 대문자" in text


def test_repaired_sentence_stays_clean() -> None:
    internal = _internal()
    assert internal.collect_metric_integrity_issues(REPAIRED_SENTENCE, "en") == []


def test_legitimate_enumerations_stay_clean() -> None:
    internal = _internal()
    assert internal.collect_metric_integrity_issues(
        "After 4 weeks of use, participants reported an improvement in hydration and an improvement in texture. Fine lines look reduced.",
        "en",
    ) == []


def test_reported_sample_scope_regex_does_not_cross_a_newline() -> None:
    """JavaScript's regexes do not use the dotAll flag in this detector."""
    internal = _internal()

    assert internal.has_reported_sample_scope_disclosure("sample\nnot disclosed") is False
    assert internal.has_reported_sample_scope_disclosure("sample not disclosed") is True
    assert internal.has_reported_sample_scope_disclosure("public source\nsample not disclosed") is True
    assert internal.has_reported_sample_scope_disclosure("public source sample\nnot disclosed") is False
    assert internal.has_reported_sample_scope_disclosure("public source sample not disclosed") is True


def test_quality_rubric_penalizes_upgraded_claim_relative_to_preserved_claim() -> None:
    def graph(description: str):
        return {
            "@context": "https://schema.org",
            "@graph": [
                {"@type": "WebPage", "@id": "https://example.com/p#webpage", "name": "Test Cream", "description": "Test Cream product page."},
                {"@type": "Product", "@id": "https://example.com/p#product", "name": "Test Cream", "description": description},
            ],
        }

    evaluate = _evaluate()
    upgraded = evaluate.evaluate_geo_quality(
        {"jsonLd": graph(f"Test Cream is a moisturizer. {UPGRADED_SENTENCE}"), "diagnostics": {"normalizedProduct": {}, "validationWarnings": []}},
        "en",
    )
    preserved = evaluate.evaluate_geo_quality(
        {"jsonLd": graph(f"Test Cream is a moisturizer. {PRESERVED_SENTENCE}"), "diagnostics": {"normalizedProduct": {}, "validationWarnings": []}},
        "en",
    )
    upgraded_eeat = next(dimension for dimension in upgraded.dimensions if dimension.id == "eeat")
    preserved_eeat = next(dimension for dimension in preserved.dimensions if dimension.id == "eeat")
    assert upgraded_eeat.score < preserved_eeat.score
    assert "self-assessment" in " ".join(improvement for dimension in upgraded.dimensions for improvement in dimension.improvements).lower()

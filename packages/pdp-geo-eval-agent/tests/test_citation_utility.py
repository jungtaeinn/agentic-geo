"""Behavioral port of the legacy citation utility and utility-gate suite."""

from __future__ import annotations

import importlib

import pytest


def _utility():
    return importlib.import_module("pdp_geo_eval_agent.citation.utility")


def test_parses_valid_keypoint_judgments_inside_fenced_json() -> None:
    utility = _utility()

    judgments = utility.parse_keypoint_judgments(
        "```json\n"
        '{"ev-1":{"label":"Supported","justification":"Matches the ceramide claim."},'
        '"ev-2":{"label":"Contradicted","justification":"Document says 8 weeks, evidence says 6 weeks."}}'
        "\n```",
        ["ev-1", "ev-2"],
    )

    assert judgments["ev-1"].label == "Supported"
    assert judgments["ev-2"].label == "Contradicted"


def test_rejects_missing_expected_keypoint_id() -> None:
    utility = _utility()

    with pytest.raises(ValueError, match='missing evidence id "ev-2"'):
        utility.parse_keypoint_judgments('{"ev-1":{"label":"Supported","justification":"ok"}}', ["ev-1", "ev-2"])


def test_rejects_invalid_keypoint_label_and_empty_justification() -> None:
    utility = _utility()

    with pytest.raises(ValueError, match="invalid label"):
        utility.parse_keypoint_judgments('{"ev-1":{"label":"Maybe","justification":"?"}}', ["ev-1"])
    with pytest.raises(ValueError, match="no justification"):
        utility.parse_keypoint_judgments('{"ev-1":{"label":"Supported","justification":""}}', ["ev-1"])


def test_computes_keypoint_recall_contradiction_rate_and_details() -> None:
    utility = _utility()

    score = utility.score_keypoint_coverage(
        {
            "ev-1": {"label": "Supported", "justification": "a"},
            "ev-2": {"label": "Supported", "justification": "b"},
            "ev-3": {"label": "Omitted", "justification": "c"},
            "ev-4": {"label": "Contradicted", "justification": "unit changed from ml to oz"},
        }
    )

    assert score.kpr == pytest.approx(0.5)
    assert score.kpc == pytest.approx(0.25)
    assert [(item.evidence_id, item.justification) for item in score.contradictions] == [
        ("ev-4", "unit changed from ml to oz")
    ]


def test_parses_claims_and_defaults_missing_id_or_invalid_indices() -> None:
    utility = _utility()

    claims = utility.parse_extracted_claims(
        '{"claims":[{"claimId":1,"claim":"The toner contains ceramide capsules.","sourceIndices":[2]},'
        '{"claim":"It is a bestseller.","sourceIndices":"not-a-list"}]}'
    )

    assert len(claims) == 2
    assert claims[0].source_indices == [2]
    assert claims[1].claim_id == 2
    assert claims[1].source_indices == []


def test_rejects_claim_response_without_claims_array() -> None:
    utility = _utility()

    with pytest.raises(ValueError, match='no "claims" array'):
        utility.parse_extracted_claims('{"items":[]}')


def test_parses_valid_citation_support() -> None:
    utility = _utility()

    assert utility.parse_citation_support('{"support":"partial_support","justification":"Only volume matches."}').support == "partial_support"


def test_rejects_invalid_citation_support_level() -> None:
    utility = _utility()

    with pytest.raises(ValueError, match="invalid level"):
        utility.parse_citation_support('{"support":"kinda","justification":"x"}')


def test_uses_max_support_across_cited_sources_for_precision() -> None:
    utility = _utility()
    claims: list[dict[str, object]] = [
        {"claimId": 1, "claim": "Claim with two sources.", "sourceIndices": [0, 1]},
        {"claimId": 2, "claim": "Claim with one weak source.", "sourceIndices": [2]},
        {"claimId": 3, "claim": "Uncited claim.", "sourceIndices": []},
    ]
    supports: dict[int, list[dict[str, object]]] = {
        1: [
            {"support": "partial_support", "justification": "half"},
            {"support": "full_support", "justification": "full"},
        ],
        2: [{"support": "partial_support", "justification": "weak"}],
    }

    score = utility.score_citation_quality(claims, supports)

    assert score.precision == pytest.approx(0.75)
    assert score.recall == pytest.approx(2 / 3)
    assert len(score.weak_claims) == 1
    assert score.weak_claims[0].best_support == "partial_support"


def test_returns_null_like_precision_and_recall_when_no_claims_exist() -> None:
    utility = _utility()

    score = utility.score_citation_quality([], {})

    assert score.precision is None
    assert score.recall is None


def test_scores_all_hallucinated_citations_as_no_support() -> None:
    utility = _utility()

    score = utility.score_citation_quality(
        [{"claimId": 1, "claim": "Backed only by a nonexistent source.", "sourceIndices": [7]}], {}
    )

    assert score.precision == 0
    assert score.recall == 1
    assert len(score.weak_claims) == 1
    assert score.weak_claims[0].best_support == "no_support"


def _clean_coverage() -> dict[str, object]:
    return {
        "kpr": 0.9,
        "kpc": 0,
        "supported": 9,
        "omitted": 1,
        "contradicted": 0,
        "total": 10,
        "contradictions": [],
    }


def test_utility_gate_passes_with_visibility_improvement_and_intact_utility() -> None:
    utility = _utility()

    result = utility.evaluate_utility_gate(
        {
            "visibilityDelta": 0.05,
            "keypointCoverage": _clean_coverage(),
            "citationQuality": {"precision": 0.9, "recall": 0.8, "citedClaims": 8, "totalClaims": 10, "weakClaims": []},
        }
    )

    assert result.pass_ is True
    assert result.failures == []
    assert result.skipped_checks == []


def test_utility_gate_fails_on_any_keypoint_contradiction() -> None:
    utility = _utility()
    coverage = _clean_coverage() | {
        "kpc": 0.1,
        "contradicted": 1,
        "contradictions": [{"evidenceId": "ev-9", "justification": "claim strength inflated"}],
    }

    result = utility.evaluate_utility_gate({"visibilityDelta": 0.1, "keypointCoverage": coverage})

    assert result.pass_ is False
    assert any("KPC" in failure for failure in result.failures)


def test_utility_gate_fails_visibility_regression_and_low_precision() -> None:
    utility = _utility()

    result = utility.evaluate_utility_gate(
        {
            "visibilityDelta": -0.02,
            "keypointCoverage": _clean_coverage(),
            "citationQuality": {"precision": 0.5, "recall": 0.9, "citedClaims": 9, "totalClaims": 10, "weakClaims": []},
        }
    )

    assert result.pass_ is False
    assert len(result.failures) == 2


def test_utility_gate_reports_skipped_checks_explicitly() -> None:
    utility = _utility()

    result = utility.evaluate_utility_gate({"visibilityDelta": 0.01})

    assert result.pass_ is True
    assert result.skipped_checks == ["keypointCoverage", "citationQuality"]


def test_utility_gate_fails_hallucinated_citation_quality_instead_of_skipping() -> None:
    utility = _utility()
    score = utility.score_citation_quality(
        [{"claimId": 1, "claim": "Fabricated citation.", "sourceIndices": [9]}], {}
    )

    result = utility.evaluate_utility_gate({"visibilityDelta": 0.05, "citationQuality": score})

    assert result.pass_ is False
    assert "citationQuality" not in result.skipped_checks
    assert any("citation precision" in failure for failure in result.failures)


def test_exposes_autogeo_derived_default_thresholds() -> None:
    utility = _utility()

    assert utility.DEFAULT_UTILITY_GATE_THRESHOLDS.max_kpc == 0
    assert utility.DEFAULT_UTILITY_GATE_THRESHOLDS.min_kpr == 0.8

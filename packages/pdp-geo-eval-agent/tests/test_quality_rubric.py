"""Behavioral port of ``quality-rubric.test.ts``."""

from __future__ import annotations

import importlib
from collections.abc import Mapping
from typing import cast

from pdp_geo_eval_agent.models import GeoQualityDimension, GeoQualityEvaluation

PAGE_ID = "https://example.com/p#webpage"
PRODUCT_ID = "https://example.com/p#product"


def _evaluate():
    return importlib.import_module("pdp_geo_eval_agent.quality.evaluate")


def _copy():
    return importlib.import_module("pdp_geo_eval_agent.quality.copy")


def _dimension(evaluation: GeoQualityEvaluation, identifier: str) -> GeoQualityDimension:
    return next(item for item in evaluation.dimensions if item.id == identifier)


def make_json_ld(*, with_price: bool = True, with_freshness: bool = True, product_description: str | None = None) -> dict[str, object]:
    webpage: dict[str, object] = {
        "@type": "WebPage",
        "@id": PAGE_ID,
        "name": "Renewal Serum",
        "description": "Product page for Renewal Serum with formula and usage details.",
    }
    if with_freshness:
        webpage["dateModified"] = "2026-08-01"
    product: dict[str, object] = {
        "@type": "Product",
        "@id": PRODUCT_ID,
        "name": "Renewal Serum",
        "description": product_description
        or "Renewal Serum is a firming serum formulated with ceramide capsules that help support elasticity for dry skin types choosing barrier care. In an instrumental result, 100% of 32 women showed improvement after 6 weeks of daily use.",
    }
    if with_price:
        product["offers"] = {"@type": "Offer", "price": 42, "priceCurrency": "USD"}
    return {"@context": "https://schema.org", "@graph": [webpage, product]}


def make_diagnostics(**overrides: object) -> dict[str, object]:
    result: dict[str, object] = {
        "normalizedProduct": {
            "name": "Renewal Serum",
            "images": [],
            "breadcrumbs": [],
            "ingredients": ["Ceramide"],
            "benefits": ["Firming"],
            "effects": [],
        },
        "validationWarnings": [],
        "validationRepairs": [],
        "evidence": [
            {"field": "product.name", "source": "input", "value": "Renewal Serum"},
            {"field": "content.description", "source": "rag", "value": "grounded"},
        ],
        "ragUsage": [
            {
                "principle": "evidence-backed claims",
                "enabled": True,
                "references": [{"kind": "eeat", "fieldTargets": ["Product.description"]}],
            },
            {
                "principle": "target customer context",
                "enabled": True,
                "references": [{"kind": "cep", "fieldTargets": ["Product.additionalProperty"]}],
            },
        ],
        "evidenceLedger": [
            {"id": "ev-1", "role": "benefit", "text": "Firming"},
            {"id": "ev-2", "role": "ingredient", "text": "Ceramide"},
        ],
        "contentPlan": {
            "mode": "model",
            "productDescription": {"include": True, "evidenceIds": ["ev-1", "ev-2"]},
            "webPageDescription": {"include": False, "evidenceIds": []},
            "faq": [],
            "howTo": {"eligible": False, "steps": []},
            "cep": [{"situation": "dry skin", "need": "barrier care", "evidenceIds": ["ev-2"]}],
        },
    }
    return result | overrides


def make_input(*, json_ld: object | None = None, diagnostics: Mapping[str, object] | None = None) -> dict[str, object]:
    return {"jsonLd": json_ld or make_json_ld(), "diagnostics": make_diagnostics(**dict(diagnostics or {}))}


def test_validation_warnings_and_repairs_penalize_geo_only() -> None:
    evaluate = _evaluate()
    clean = evaluate.evaluate_geo_quality(make_input(), "ko")
    warned = evaluate.evaluate_geo_quality(
        make_input(
            diagnostics={
                "validationWarnings": [
                    "Product.additionalProperty.Usage: duplicated step text.",
                    "FAQ wording upgraded a result.",
                ],
                "validationRepairs": [{"field": "Product.name", "issue": "trimmed"}],
            }
        ),
        "ko",
    )

    assert _dimension(warned, "geo").score < _dimension(clean, "geo").score
    assert _dimension(warned, "cep").score == _dimension(clean, "cep").score
    assert _dimension(warned, "eeat").score == _dimension(clean, "eeat").score


def test_geo_reaches_100_with_clean_graph_explicit_price_and_freshness() -> None:
    evaluation = _evaluate().evaluate_geo_quality(make_input(), "en")
    assert _dimension(evaluation, "geo").score == 100


def test_geo_drops_gatekeeper_bonuses_when_price_and_freshness_are_absent() -> None:
    evaluation = _evaluate().evaluate_geo_quality(make_input(json_ld=make_json_ld(with_price=False, with_freshness=False)), "en")
    geo = _dimension(evaluation, "geo")
    assert geo.score == 90
    assert "date" in "\n".join(geo.improvements).lower()


def test_eeat_reaches_100_with_grounded_coverage_and_scoped_metrics() -> None:
    evaluation = _evaluate().evaluate_geo_quality(make_input(), "en")
    assert _dimension(evaluation, "eeat").score == 100


def test_grounded_cep_plan_prevents_regex_cue_miss_from_cratering_score() -> None:
    evaluate = _evaluate()
    neutral_description = "Renewal Serum is a daily formula. It absorbs quickly."
    with_plan = evaluate.evaluate_geo_quality(make_input(json_ld=make_json_ld(product_description=neutral_description)), "en")
    without_plan = evaluate.evaluate_geo_quality(
        make_input(json_ld=make_json_ld(product_description=neutral_description), diagnostics={"contentPlan": None}), "en"
    )

    difference = _dimension(with_plan, "cep").score - _dimension(without_plan, "cep").score
    assert difference >= 20


def test_geo_summary_counts_missing_gatekeepers_as_issues() -> None:
    evaluation = _evaluate().evaluate_geo_quality(make_input(json_ld=make_json_ld(with_price=False, with_freshness=False)), "en")
    geo = _dimension(evaluation, "geo")
    assert geo.summary == _copy().get_geo_quality_copy("en").score_summary(90, 2)


def test_unmatched_validation_warning_remains_scored_and_reported() -> None:
    evaluation = _evaluate().evaluate_geo_quality(
        make_input(
            diagnostics={
                "validationWarnings": ["FAQ acceptedAnswer upgraded a claim beyond the source."],
                "validationRepairs": [
                    {"field": "Product.name", "issue": "trimmed"},
                    {"field": "Product.image", "issue": "deduplicated"},
                ],
            }
        ),
        "en",
    )

    assert "acceptedAnswer" in "\n".join(evaluation.validation_details)
    assert evaluation.validation_improvements


def test_warning_for_repaired_field_is_resolved() -> None:
    evaluation = _evaluate().evaluate_geo_quality(
        make_input(
            diagnostics={
                "validationWarnings": ["Product.name had trailing whitespace and was trimmed."],
                "validationRepairs": [{"field": "Product.name", "issue": "trimmed"}],
            }
        ),
        "en",
    )

    assert evaluation.validation_improvements == []


def test_korean_natural_sample_and_time_scope_is_recognized() -> None:
    evaluation = _evaluate().evaluate_geo_quality(
        make_input(
            json_ld=make_json_ld(
                product_description=(
                    "일반 성인 32명을 대상으로 2022년 12월 19일부터 22일까지 48시간 패치로 자극 여부를 확인한 피부과 테스트와, "
                    "53명을 대상으로 2018년 4월 13일부터 6월 1일까지 진행한 하이포알러제닉 테스트를 완료했습니다. "
                    "사용 후 피부 자극감이 94% 개선되었습니다."
                )
            )
        ),
        "ko",
    )
    eeat = _dimension(evaluation, "eeat")
    improvements = "\n".join(eeat.improvements)

    assert "대상으로" not in improvements or "확인했는지" not in improvements
    assert "사용 기간" not in improvements
    assert eeat.score == 100


def test_korean_participant_phrasings_are_recognized() -> None:
    evaluation = _evaluate().evaluate_geo_quality(
        make_input(
            json_ld=make_json_ld(
                product_description="120명이 참여한 사용성 조사와 53명 대상 하이포알러제닉 테스트에서 6주 후 92% 개선을 확인했습니다."
            )
        ),
        "ko",
    )
    eeat = _dimension(evaluation, "eeat")
    assert "대상으로" not in "\n".join(eeat.improvements) or "확인했는지" not in "\n".join(eeat.improvements)
    assert eeat.score == 100


def test_percentage_claim_without_sample_or_time_scope_is_penalized() -> None:
    evaluation = _evaluate().evaluate_geo_quality(
        make_input(
            json_ld=make_json_ld(
                product_description="Renewal Serum improved skin hydration by 45% overall, according to internal testing."
            )
        ),
        "en",
    )
    eeat = _dimension(evaluation, "eeat")
    improvements = "\n".join(eeat.improvements).lower()
    assert "how many people they were tested on" in improvements
    assert "usage period" in improvements
    assert eeat.score <= 78


def test_valid_single_step_howto_does_not_penalize_geo() -> None:
    json_ld = make_json_ld()
    graph = cast(list[dict[str, object]], json_ld["@graph"])
    graph.append(
        {
            "@type": "HowTo",
            "@id": f"{PRODUCT_ID}-howto",
            "name": "How to use Renewal Serum",
            "step": [{"@type": "HowToStep", "name": "Apply", "text": "Apply a pump to clean, dry skin each evening."}],
        }
    )
    diagnostics = make_diagnostics()
    content_plan = cast(dict[str, object], diagnostics["contentPlan"])
    diagnostics["contentPlan"] = content_plan | {"howTo": {"eligible": True, "steps": [{"evidenceIds": []}]}}
    evaluation = _evaluate().evaluate_geo_quality({"jsonLd": json_ld, "diagnostics": diagnostics}, "en")
    geo = _dimension(evaluation, "geo")
    assert "how-to" not in "\n".join(geo.improvements).lower()
    assert geo.score == 100


def test_claim_distortion_lints_reduce_eeat_and_explain_all_defects() -> None:
    evaluation = _evaluate().evaluate_geo_quality(
        make_input(
            json_ld=make_json_ld(
                product_description=(
                    "Ginseng Peptide supports supports elasticity. Fine lines and wrinkles decreased by 100% after 4 weeks. "
                    "100%% of women agreed."
                )
            )
        ),
        "en",
    )
    eeat = _dimension(evaluation, "eeat")
    improvements = "\n".join(eeat.improvements).lower()
    assert "duplicated unit" in improvements or "100%%" in improvements
    assert "repeats the same word" in improvements or "supports supports" in improvements
    assert "overstatement" in improvements or "participants" in improvements
    assert eeat.score < 80

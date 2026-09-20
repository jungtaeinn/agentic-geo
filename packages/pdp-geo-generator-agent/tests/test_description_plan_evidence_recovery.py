"""Regression coverage for safe model-description evidence recovery."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, cast

import pdp_geo_generator_agent.content_planning as content_planning
from pdp_geo_generator_agent.content_planning import create_conservative_content_plan, create_pdp_geo_evidence_ledger
from pdp_geo_generator_agent.final_proofreader import select_rendered_sentence_evidence

_admit_model_plan = cast(
    Callable[[Mapping[str, Any], Mapping[str, Any]], tuple[dict[str, Any] | None, list[str]]],
    getattr(content_planning, "_admit_model_plan"),
)


def _request() -> dict[str, Any]:
    product: dict[str, Any] = {
        "name": "SampleDerma BarrierCare365 캡슐 토너",
        "brand": "SampleDerma",
        "category": "toner",
        "description": "SampleDerma BarrierCare365 캡슐 토너는 세안 후 약해진 피부장벽을 케어하는 보습 토너입니다.",
        "ingredients": ["PHA 워터", "고밀도 세라마이드 캡슐"],
        "benefits": ["세안 후 약해진 피부장벽과 건조함을 케어합니다."],
        "effects": [],
        "usage": ["세안 후 적당량을 덜어 피부결을 따라 펴 바릅니다."],
        "metrics": ["사용 직후 피부 수분량이 1.3배 증가했습니다."],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [
            "건조 피부 또는 민감 피부에 추천됩니다.",
            "HYPERSENSITIVE SKIN TESTED SENSITIVE SKIN PANEL TESTED DERMATOLOGIST TESTED "
            "ALLERGY TESTED NON-COMEDOGENIC TESTED 2022 dermatest EXCELLENT 등급",
        ],
        "semanticFacts": {"skinTypes": ["건조 피부", "민감 피부"]},
    }
    return {
        "product": product,
        "locale": "ko-KR",
        "evidenceLedger": create_pdp_geo_evidence_ledger(product, "ko-KR"),
    }


def _wire_plan(request: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in create_conservative_content_plan(request).items()
        if key not in {"mode", "faqRelationshipCards"}
    }


def _partial_model_ids(request: Mapping[str, Any]) -> list[str]:
    """Mirror a planner that cites identity/audience/usage/metric but misses formula/effect IDs."""

    return [
        str(item["id"])
        for item in cast(list[Mapping[str, Any]], request["evidenceLedger"])
        if item["role"] in {"identity", "audience", "usage", "metric"}
    ]


def _field(*, text: str, intent: str, evidence_ids: list[str]) -> dict[str, Any]:
    return {
        "include": True,
        "text": text,
        "intent": intent,
        "evidenceIds": evidence_ids,
        "confidence": 0.9,
        "omitReason": "",
    }


def test_admission_recovers_complete_korean_descriptions_when_model_omits_some_relevant_ids() -> None:
    """A valid model narrative must not fall back merely because its own ID list is incomplete.

    The production regression this catches is field-wide rejection when an
    otherwise grounded Korean description cites identity/audience/usage/metric
    IDs but forgets the separately available formula and benefit atoms.
    """

    request = _request()
    plan = _wire_plan(request)
    product_text = (
        "SampleDerma의 SampleDerma BarrierCare365 캡슐 토너는 세안 후 약해진 피부장벽을 케어하는 보습 토너입니다. "
        "SampleDerma의 SampleDerma BarrierCare365 캡슐 토너는 건조 피부 또는 민감 피부에 추천됩니다. "
        "SampleDerma BarrierCare365 캡슐 토너는 PHA 워터와 고밀도 세라마이드 캡슐을 포함합니다. "
        "세안 후 약해진 피부장벽과 건조함을 케어합니다. "
        "사용 직후 피부 수분량이 1.3배 증가했습니다."
    )
    page_text = (
        "SampleDerma의 SampleDerma BarrierCare365 캡슐 토너 상품 페이지는 대상 고객, 성분·포뮬러, 효능·효과, 사용법, 근거 지표를 "
        "바탕으로 제품의 특징을 소개합니다. "
        "SampleDerma BarrierCare365 캡슐 토너는 PHA 워터와 고밀도 세라마이드 캡슐을 포함합니다. "
        "세안 후 약해진 피부장벽과 건조함을 케어합니다. "
        "사용 직후 피부 수분량이 1.3배 증가했습니다."
    )
    partial_ids = _partial_model_ids(request)
    plan["productDescription"] = _field(
        text=product_text,
        intent="product-entity-summary",
        evidence_ids=partial_ids,
    )
    plan["webPageDescription"] = _field(
        text=page_text,
        intent="page-coverage-summary",
        evidence_ids=partial_ids,
    )

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["productDescription"]["text"] == product_text
    assert admitted["webPageDescription"]["text"] == page_text
    for field in ("productDescription", "webPageDescription"):
        selected_ids = set(cast(list[str], admitted[field]["evidenceIds"]))
        selected_roles = {
            str(item["role"])
            for item in cast(list[Mapping[str, Any]], request["evidenceLedger"])
            if str(item["id"]) in selected_ids
        }
        assert {"ingredient", "benefit"} <= selected_roles
        assert not any(
            "HYPERSENSITIVE SKIN TESTED" in str(item["text"])
            for item in cast(list[Mapping[str, Any]], request["evidenceLedger"])
            if str(item["id"]) in selected_ids
        )


def test_admission_does_not_rebind_a_raw_ocr_safety_panel_as_public_description() -> None:
    """A recovery scan remains a public-copy boundary, not a way to publish OCR dumps."""

    request = _request()
    plan = _wire_plan(request)
    raw_panel = next(
        str(item["text"])
        for item in cast(list[Mapping[str, Any]], request["evidenceLedger"])
        if "HYPERSENSITIVE SKIN TESTED" in str(item["text"])
    )
    raw_id = next(
        str(item["id"])
        for item in cast(list[Mapping[str, Any]], request["evidenceLedger"])
        if str(item["text"]) == raw_panel
    )
    plan["productDescription"] = _field(
        text=raw_panel,
        intent="product-entity-summary",
        evidence_ids=[raw_id],
    )

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None
    assert admitted["productDescription"]["include"] is False
    assert admitted["productDescription"]["text"] == ""
    assert any("public-copy-eligible" in warning for warning in warnings)


def test_final_proofreader_binds_natural_korean_page_usage_summary_to_canonical_usage() -> None:
    """A natural page-level usage lead must retain identity and source procedure evidence.

    The page sentence deliberately describes coverage rather than repeating a
    HowTo step; this keeps WebPage narrative and the canonical procedure in
    their separate schema roles.
    """

    request = _request()
    sentence = "SampleDerma의 SampleDerma BarrierCare365 캡슐 토너의 사용 단계도 함께 다룹니다."
    evidence = cast(list[Mapping[str, Any]], request["evidenceLedger"])

    selected = select_rendered_sentence_evidence(sentence, evidence, [str(item["role"]) for item in evidence])

    assert len(selected["sentenceEvidenceIds"]) == 1
    selected_ids = set(selected["sentenceEvidenceIds"][0])
    selected_roles = {
        str(item["role"])
        for item in evidence
        if str(item["id"]) in selected_ids
    }
    assert {"identity", "usage"} <= selected_roles

    overview = (
        "SampleDerma의 SampleDerma BarrierCare365 캡슐 토너 상품 페이지는 제품의 특징과 "
        "성분·포뮬러, 효능·효과, 사용법, 근거 지표를 함께 다룹니다."
    )
    overview_selected = select_rendered_sentence_evidence(
        overview, evidence, [str(item["role"]) for item in evidence]
    )
    overview_ids = set(overview_selected["sentenceEvidenceIds"][0])
    overview_roles = {
        str(item["role"])
        for item in evidence
        if str(item["id"]) in overview_ids
    }
    assert {"identity", "ingredient", "benefit", "usage", "metric"} <= overview_roles

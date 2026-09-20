"""Regression coverage for sanitized public-copy provenance decisions."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Mapping
from typing import Any, cast

import pytest

import pdp_geo_generator_agent.final_proofreader as final_proofreader
import pdp_geo_generator_agent.service as service


def _unsupported_model_description_input() -> dict[str, Any]:
    source_text = "Glow Serum is a serum for dry skin."
    rendered_text = "Glow Serum supports hydration."
    return {
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [
                    {"@type": "Product", "name": "Glow Serum", "description": rendered_text},
                    {"@type": "WebPage", "description": rendered_text},
                ],
            }
        },
        "contentPlan": {
            "mode": "model",
            "productDescription": {
                "include": True,
                "text": source_text,
                "evidenceIds": ["ev-description"],
            },
            "webPageDescription": {
                "include": True,
                "text": source_text,
                "evidenceIds": ["ev-description"],
            },
        },
        "evidenceLedger": [
            {
                "id": "ev-description",
                "role": "description",
                "text": source_text,
                "sourcePath": "product.description",
                "sourceUrl": "https://private.example.test/source",
                "apiKey": "credential-must-not-appear",
            }
        ],
    }


def _bound_model_description_input() -> dict[str, Any]:
    """A description the binder can prove, so only the entry decides the outcome."""

    text = "Glow Serum is a serum for dry skin."
    payload = _unsupported_model_description_input()
    for node in payload["schemaMarkup"]["jsonLd"]["@graph"]:
        node["description"] = text
    return payload


def test_a_field_with_no_provenance_entry_is_not_reported_as_bound() -> None:
    """엔트리가 쓰이지 않은 필드는 선택이 무엇을 내놓았든 결속으로 읽히지 않는다.

    선택이 내놓은 것은 후보이고 결속을 기록하는 것은 엔트리다.  답변과 절차
    단계는 한 단위라 문장 하나가 증명되지 않으면 엔트리가 통째로 쓰이지 않는데,
    그 상태를 결속으로 읽으면 누락 단계가 지목할 문장도 사유도 없어 원인을
    가리는 기본값만 남는다.
    """

    payload = _bound_model_description_input()
    provenance = final_proofreader.create_pdp_geo_public_copy_provenance(payload)
    assert any(entry["fieldPath"] == "Product.description" for entry in provenance)

    recorded = final_proofreader.create_pdp_geo_public_copy_provenance_decision_diagnostics(
        {**payload, "publicCopyProvenance": provenance}, phase="initial"
    )
    unwritten = final_proofreader.create_pdp_geo_public_copy_provenance_decision_diagnostics(
        {
            **payload,
            "publicCopyProvenance": [
                entry for entry in provenance if entry["fieldPath"] != "Product.description"
            ],
        },
        phase="initial",
    )

    bound = next(item for item in recorded if item["fieldPath"] == "Product.description")
    assert (bound["outcome"], bound["reason"]) == ("bound", "directSupportAccepted")

    missing = next(item for item in unwritten if item["fieldPath"] == "Product.description")
    assert (missing["outcome"], missing["reason"]) == ("unrecorded", "noProvenanceEntry")
    # 같은 입력의 다른 필드는 엔트리가 있으므로 그대로 결속이다.
    other = next(item for item in unwritten if item["fieldPath"] == "WebPage.description")
    assert other["outcome"] == "bound"
    # 누락 사유는 이제 원인을 말한다.
    assert service._public_copy_omission_reason(
        service._current_provenance_decisions(unwritten, "initial", "Product.description")
    ) == "noProvenanceEntry"
    # 증명되지 않은 문장을 지목하는 신호는 건드리지 않는다: 격리가 뺄 문장을
    # 고르는 것은 ``unsupported``뿐이다.
    assert service._unsupported_sentence_indexes(
        service._current_provenance_decisions(unwritten, "initial", "Product.description")
    ) == set()


def test_decisions_without_supplied_provenance_still_report_the_selector_view() -> None:
    """바인더 출력을 받지 않은 호출은 읽을 엔트리가 없을 뿐, 미기록이 아니다."""

    payload = _bound_model_description_input()
    decisions = final_proofreader.create_pdp_geo_public_copy_provenance_decision_diagnostics(
        payload, phase="initial"
    )
    product = next(item for item in decisions if item["fieldPath"] == "Product.description")
    assert product["outcome"] == "bound"


def test_provenance_decisions_distinguish_plan_mismatch_from_renderer_semantic_rejection() -> None:
    """An unbound rendered claim exposes safe causes without exposing either text."""

    factory = cast(
        Callable[..., list[dict[str, Any]]] | None,
        getattr(final_proofreader, "create_pdp_geo_public_copy_provenance_decision_diagnostics", None),
    )
    assert callable(factory), "provenance-decision diagnostics are not exposed"
    decisions = factory(
        _unsupported_model_description_input(), phase="initial"
    )
    product = next(item for item in decisions if item["fieldPath"] == "Product.description")
    webpage = next(item for item in decisions if item["fieldPath"] == "WebPage.description")

    for item in (product, webpage):
        assert item["phase"] == "initial"
        assert item["sentenceIndex"] == 0
        assert item["outcome"] == "unsupported"
        assert item["reason"] == "assertionFrameRejected"
        assert item["plan"] == {"mode": "model", "fieldIncluded": True, "textHashMatch": False}
        assert item["eligibleEvidenceCount"] == 1
        assert item["eligibleRoleCounts"] == {"description": 1}
        assert item["selectedEvidenceCount"] == 0

    serialized = json.dumps(decisions)
    assert "Glow Serum supports hydration." not in serialized
    assert "Glow Serum is a serum for dry skin." not in serialized
    assert "private.example.test" not in serialized
    assert "credential-must-not-appear" not in serialized
    assert "sourceHash" not in serialized
    assert "evidenceIds" not in serialized


class _ConfiguredCopyRefiner:
    """Marks the corrective runtime as available for the service flow."""

    def refine_copy(self, request: Mapping[str, Any]) -> dict[str, Any]:
        if "refinementFeedback" not in request:
            return {}
        return {"schemaDescriptions": {"product": "Glow Serum is suitable for dry skin."}}


def _grounded_product() -> dict[str, Any]:
    return {
        "name": "Glow Serum",
        "brand": "Example Lab",
        "description": "Glow Serum is a serum for dry skin.",
        "ingredients": ["Ceramide"],
        "benefits": ["supports hydration"],
        "usage": ["Apply after cleansing."],
    }


def test_quality_gate_exposes_safe_corrective_provenance_summary(monkeypatch: pytest.MonkeyPatch) -> None:
    """A rejected candidate reports safe path/count metadata and leaves copy out of it."""

    async def controlled_refinement(request: Mapping[str, Any], _runtime: Mapping[str, Any]) -> dict[str, Any]:
        if "refinementFeedback" not in request:
            return {
                "schemaMarkup": request["schemaMarkup"],
                "content": request["content"],
                "evidence": [],
                "warnings": [],
                "called": True,
                "applied": False,
                "rejections": [],
            }
        schema_markup = cast(dict[str, Any], request["schemaMarkup"])
        graph = cast(list[dict[str, Any]], cast(dict[str, Any], schema_markup["jsonLd"])["@graph"])
        next(item for item in graph if item.get("@type") == "Product")["description"] = "Glow Serum is suitable for dry skin."
        content = cast(dict[str, Any], request["content"])
        cast(dict[str, Any], content["sections"])["description"] = "Glow Serum is suitable for dry skin."
        return {
            "schemaMarkup": schema_markup,
            "content": content,
            "evidence": [],
            "warnings": [],
            "called": True,
            "applied": True,
            "rejections": [],
        }

    monkeypatch.setattr(service, "refine_pdp_geo_copy", controlled_refinement)
    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": _grounded_product(), "hints": {"locale": "en-US"}},
            {
                "customCopyRefiner": _ConfiguredCopyRefiner(),
                "copyRefinement": {"enabled": True},
                "qualityGate": {"enabled": True, "thresholds": {"geo": 101, "cep": 0, "eeat": 0}},
            },
        )
    )

    diagnostics = cast(dict[str, Any], run["diagnostics"])
    decisions = cast(list[dict[str, Any]], diagnostics["publicCopyProvenanceDecisionDiagnostics"])
    corrective = cast(dict[str, Any], diagnostics["qualityGate"])["correctiveDiagnostics"]

    assert {item["phase"] for item in decisions} >= {"initial", "afterProofreader", "afterSafeRepair", "correctedCandidate"}
    assert corrective == {
        "correctiveApplied": True,
        "correctedMissingPaths": ["Product.description"],
        "adoptionReason": "provenanceRegression",
        "structuralShortfallCount": 0,
        "provenanceRegressionDelta": 1,
    }
    safe_payload = json.dumps({"decisions": decisions, "corrective": corrective})
    assert "Glow Serum is suitable for dry skin." not in safe_payload
    assert "Glow Serum is a serum for dry skin." not in safe_payload
    assert "evidenceIds" not in safe_payload
    assert "sourceHash" not in safe_payload


def test_a_plain_preposition_is_not_a_term_the_source_has_to_carry() -> None:
    """관계만 맺고 아무것도 주장하지 않는 전치사 하나로 전부 출처를 둔 문장이 기각됐다.

    면제는 FAQ 답변 경로에만 준다. 다른 발행 표면이 같은 공유 판독기로 결정하므로
    그쪽 답은 바뀌지 않아야 한다.
    """

    evidence = [
        {
            "id": "ev-metric",
            "role": "metric",
            "text": (
                "After 6 weeks of use, 100% showed improvement in fine lines, wrinkles, "
                "elasticity, firmness (instrumental result, 32 women, with daily use)."
            ),
            "sourcePath": "product.semanticFacts.metrics[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        }
    ]
    sentence = (
        "In an instrumental result with daily use among 32 women, 100% showed improvement "
        "in fine lines, wrinkles, elasticity, and firmness after 6 weeks of use."
    )

    # The FAQ answer reader sets the placing preposition aside; the shared
    # reader other surfaces decide with is unchanged and still charges it.
    assert final_proofreader._faq_answer_assertion_frame_is_supported(sentence, evidence) is True
    assert final_proofreader._sentence_assertion_frame_is_supported(sentence, evidence) is False


def test_a_bound_the_source_never_wrote_still_rejects_the_frame() -> None:
    """한계를 말하는 낱말은 기능어가 아니다. 출처에 없는 한계는 여전히 기각된다."""

    evidence = [
        {
            "id": "ev-metric",
            "role": "metric",
            "text": (
                "After 6 weeks of use, 100% showed improvement in fine lines, wrinkles, "
                "elasticity, firmness (instrumental result, 32 women, with daily use)."
            ),
            "sourcePath": "product.semanticFacts.metrics[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        }
    ]
    sentence = (
        "In an instrumental result with daily use, 100% showed improvement in fine lines, "
        "wrinkles, elasticity, and firmness within 6 weeks of use."
    )

    assert final_proofreader._sentence_assertion_frame_is_supported(sentence, evidence) is False

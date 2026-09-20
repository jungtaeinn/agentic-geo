"""Service-level regression coverage for isolated FAQ planning diagnostics."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from typing import Any

from pdp_geo_generator_agent._json import as_dict, as_list
from pdp_geo_generator_agent.content_planning import create_conservative_content_plan
from pdp_geo_generator_agent.service import generate_pdp_geo

_VALID_QUESTION = "What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?"
_VALID_ANSWER = "Northstar Lab's Dew Barrier Serum works best for dry and sensitive skin. Ceramide Matrix supports hydration."
_REJECTED_QUESTION = "Which ingredients are listed for Dew Barrier Serum?"


class _PartialFaqPlanner:
    """Return one publishable row and one locally rejected sibling on purpose."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        self.calls.append(dict(payload))
        if payload.get("faqRecoveryOnly") is True:
            # Model recovery was attempted but produced no usable plan.  The
            # service must preserve the admitted first-pass row instead of
            # promoting this partial outcome to a quality-gate failure.
            return {"plan": {}}

        cards = [
            card
            for raw in as_list(payload.get("faqRelationshipCards"))
            if (card := as_dict(raw))
        ]
        buyer = next(card for card in cards if card["intent"] == "buyer-decision")
        rejected = next(card for card in cards if card["id"] != buyer["id"])
        plan = {
            key: value
            for key, value in create_conservative_content_plan(payload).items()
            if key not in {"mode", "faqRelationshipCards"}
        }
        plan["faq"] = [
            {
                "id": buyer["id"],
                "include": True,
                "question": _VALID_QUESTION,
                "answer": _VALID_ANSWER,
                "intent": buyer["intent"],
                "cep": "dryness and tightness",
                "evidenceIds": buyer["evidenceIds"],
                "confidence": 0.95,
                "omitReason": "",
            },
            {
                "id": rejected["id"],
                "include": True,
                "question": _REJECTED_QUESTION,
                "answer": "Dew Barrier Serum lists Ceramide Matrix.",
                "intent": rejected["intent"],
                "cep": "",
                "evidenceIds": rejected["evidenceIds"],
                "confidence": 0.95,
                "omitReason": "",
            },
        ]
        return {"plan": plan, "usage": {"inputTokens": 11, "outputTokens": 7, "totalTokens": 18}}


def _product() -> dict[str, Any]:
    return {
        "name": "Dew Barrier Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "Dew Barrier Serum is a serum for dry and sensitive skin.",
        "ingredients": ["Ceramide Matrix"],
        "benefits": ["Supports hydration"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [
            "A solution for dryness and tightness.",
            "Northstar Lab's Dew Barrier Serum works best for dry and sensitive skin.",
            "Ceramide Matrix supports hydration.",
        ],
        "semanticFacts": {
            "skinTypes": ["dry skin", "sensitive skin"],
            "evidenceSentences": [
                "A solution for dryness and tightness.",
                "Northstar Lab's Dew Barrier Serum works best for dry and sensitive skin.",
            ],
            "ingredientBenefitLinks": [
                {
                    "ingredient": "Ceramide Matrix",
                    "benefit": "hydration",
                    "sourceText": "Ceramide Matrix supports hydration.",
                }
            ],
        },
    }


def _run_partial_faq_plan() -> tuple[dict[str, Any], _PartialFaqPlanner]:
    planner = _PartialFaqPlanner()
    run = asyncio.run(
        generate_pdp_geo(
            {"product": _product(), "hints": {"locale": "en-US"}},
            {
                "provider": "mock",
                "apiKey": "private-faq-planner-key",
                "endpoint": "https://internal.example.test/faq-planner",
                "customContentPlanner": planner,
                "qualityGate": {"enabled": True, "thresholds": {"geo": 0, "cep": 0, "eeat": 0}},
            },
        )
    )
    return run, planner


def _rendered_faq_questions(run: Mapping[str, Any]) -> list[str]:
    graph = run["result"]["schemaMarkup"]["jsonLd"]["@graph"]
    faq_page = next(node for node in graph if node.get("@type") == "FAQPage")
    return [item["name"] for item in faq_page["mainEntity"]]


def test_rejected_faq_row_keeps_an_admitted_sibling_out_of_quality_gate_failure() -> None:
    """A field-local rejection is diagnostic-only when the rest of the artifact is valid."""

    run, planner = _run_partial_faq_plan()

    assert len(planner.calls) == 2
    assert planner.calls[1]["faqRecoveryOnly"] is True
    assert _rendered_faq_questions(run) == [_VALID_QUESTION]
    assert _REJECTED_QUESTION not in run["result"]["content"]["sections"]["faq"]
    assert run["diagnostics"]["qualityGate"]["reason"] == "Quality gate passed without correction."
    assert next(step for step in run["process"] if step["id"] == "quality-gate")["status"] == "done"

    admission = run["diagnostics"]["contentPlan"]["admissionDiagnostics"]
    assert any(
        field["field"] == "FAQ[1]" and field["outcome"] == "rejected"
        for field in admission["fields"]
    )
    assert admission["faqModelRecovery"] == {
        "called": True,
        "outcome": "unavailable",
        "requestedCardIds": [field["rowId"] for field in admission["fields"] if field["field"] == "FAQ[1]"],
    }


def test_content_planning_diagnostics_report_safe_model_and_faq_recovery_outcomes() -> None:
    """The runtime summary reveals partial recovery without mirroring public copy or secrets."""

    run, _ = _run_partial_faq_plan()

    summary = run["diagnostics"]["contentPlanning"]
    assert summary["modelCall"] == {"called": True, "outcome": "admitted"}
    assert summary["faqModelRecovery"]["called"] is True
    assert summary["faqModelRecovery"]["outcome"] == "unavailable"
    assert summary["faqRelationshipCards"]["cardIds"]
    assert summary["faqInitialPlan"]["candidateCount"] == 2
    assert summary["faqAdmission"]["acceptedCount"] == 1
    assert summary["faqAdmission"]["rejectedCount"] == 1
    assert len(summary["faqAdmission"]["acceptedRowIds"]) == 1
    assert len(summary["faqAdmission"]["rejectedRowIds"]) == 1
    assert summary["faqAdmission"]["acceptedRowIds"] != summary["faqAdmission"]["rejectedRowIds"]
    assert set(summary["faqInitialPlan"]["candidateRowIds"]) == {
        *summary["faqAdmission"]["acceptedRowIds"],
        *summary["faqAdmission"]["rejectedRowIds"],
    }
    assert summary["faqModelRecovery"]["requestedCardIds"] == summary["faqAdmission"]["rejectedRowIds"]
    assert summary["faqMembership"]["count"] == 1
    assert summary["faqMembership"]["rowIds"] == summary["faqAdmission"]["acceptedRowIds"]
    assert summary["faqSafeDegradation"] == {
        "active": True,
        "omittedRowCount": 1,
        "omittedRowIds": summary["faqAdmission"]["rejectedRowIds"],
    }

    runtime_step = next(
        step for step in run["diagnostics"]["runtimeUsage"]["steps"] if step["stage"] == "content-planning"
    )
    assert runtime_step["called"] is True
    serialized = json.dumps(summary)
    for private_value in (
        _VALID_QUESTION,
        _VALID_ANSWER,
        _REJECTED_QUESTION,
        "Dew Barrier Serum lists Ceramide Matrix.",
        "private-faq-planner-key",
        "internal.example.test",
    ):
        assert private_value not in serialized

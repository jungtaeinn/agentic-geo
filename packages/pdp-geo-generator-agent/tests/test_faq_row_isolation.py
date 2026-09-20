"""한 FAQ 행의 결함이 나머지 계획을 죽이지 않는다 — 폭발 반경 계약."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from pdp_geo_generator_agent._json import as_dict, as_list
from pdp_geo_generator_agent.content_planning import create_conservative_content_plan
from pdp_geo_generator_agent.service import generate_pdp_geo

_VALID_QUESTION = "What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?"
_VALID_ANSWER = (
    "Northstar Lab's Dew Barrier Serum works best for dry and sensitive skin. Ceramide Matrix supports hydration."
)
_UNUSABLE_QUESTION = "How does Northstar Lab's Dew Barrier Serum support hydration for dry and sensitive skin?"
_CEP_SITUATION = "dryness and tightness"


def _public_plan(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Return the provider-owned wire plan the planner would have authored."""

    return {
        key: value
        for key, value in create_conservative_content_plan(payload).items()
        if key not in {"mode", "faqRelationshipCards"}
    }


def _buyer_card(payload: Mapping[str, Any]) -> dict[str, Any]:
    return next(
        card
        for raw in as_list(payload.get("faqRelationshipCards"))
        if (card := as_dict(raw)) and card["intent"] == "buyer-decision"
    )


class _RowSchemaBreakingPlanner:
    """Author one wire-invalid FAQ row beside one fully publishable row."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        self.calls.append(dict(payload))
        if payload.get("faqRecoveryOnly") is True:
            return {"plan": {}}

        card = _buyer_card(payload)
        plan = _public_plan(payload)
        plan["faq"] = [
            {
                # No "id": the row misses a required wire key and can never be admitted.
                "include": True,
                "question": _UNUSABLE_QUESTION,
                "answer": "Ceramide Matrix supports hydration.",
                "intent": card["intent"],
                "cep": "",
                "evidenceIds": card["evidenceIds"],
                "confidence": 0.9,
                "omitReason": "",
            },
            {
                "id": card["id"],
                "include": True,
                "question": _VALID_QUESTION,
                "answer": _VALID_ANSWER,
                "intent": card["intent"],
                "cep": _CEP_SITUATION,
                "evidenceIds": card["evidenceIds"],
                "confidence": 0.95,
                "omitReason": "",
            },
        ]
        # A second model-authored field, so the test can tell a surviving plan
        # apart from a deterministic fallback that merely looks similar.
        plan["cep"] = [
            {
                "situation": _CEP_SITUATION,
                "need": "",
                "constraint": "",
                "evidenceIds": card["evidenceIds"],
                "confidence": 0.9,
            }
        ]
        return {"plan": plan}


class _PlanSchemaBreakingPlanner:
    """Drop a required top-level key so the whole plan stays untrustworthy."""

    def __call__(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        plan = _public_plan(payload)
        plan.pop("cep")
        return {"plan": plan}


def _run(product: Mapping[str, Any], planner: object) -> dict[str, Any]:
    return asyncio.run(
        generate_pdp_geo(
            {"product": dict(product), "hints": {"locale": "en-US"}},
            {
                "provider": "mock",
                "apiKey": "row-isolation-key",
                "endpoint": "https://internal.example.test/faq-planner",
                "customContentPlanner": planner,
                "qualityGate": {"enabled": True, "thresholds": {"geo": 0, "cep": 0, "eeat": 0}},
            },
        )
    )


def test_one_invalid_faq_row_does_not_discard_the_whole_plan(
    source_backed_product: dict[str, Any],
) -> None:
    """A row that fails the wire schema costs that row only, never the plan."""

    run = _run(source_backed_product, _RowSchemaBreakingPlanner())
    plan = run["diagnostics"]["contentPlan"]

    assert plan["admissionDiagnostics"]["modelCall"]["outcome"] == "admitted"
    assert [row["question"] for row in plan["faq"]] == [_VALID_QUESTION]
    rejected = [field for field in plan["admissionDiagnostics"]["fields"] if field["outcome"] == "rejected"]
    assert [field["field"] for field in rejected] == ["FAQ[0]"]
    # Naming the cause is what makes this a wire-schema test.  The row also
    # trips later gates, so without this the assertion above passes even when
    # the wire check is gone entirely.
    assert rejected[0]["reason"] == "strictFieldSchemaValidationFailed"
    assert rejected[0]["predicate"] == "wireSchema"


def test_an_invalid_faq_row_keeps_the_other_admitted_plan_fields(
    source_backed_product: dict[str, Any],
) -> None:
    """A malformed FAQ row costs neither a sibling field nor the published FAQ page."""

    run = _run(source_backed_product, _RowSchemaBreakingPlanner())
    plan = run["diagnostics"]["contentPlan"]

    assert plan["mode"] == "model"
    assert [row["situation"] for row in plan["cep"]] == [_CEP_SITUATION]
    graph = run["result"]["schemaMarkup"]["jsonLd"]["@graph"]
    faq_page = next(node for node in graph if node.get("@type") == "FAQPage")
    assert [item["name"] for item in faq_page["mainEntity"]] == [_VALID_QUESTION]


def test_plan_level_schema_error_still_discards_the_plan(
    source_backed_product: dict[str, Any],
) -> None:
    """Row isolation must not loosen the top-level plan contract."""

    run = _run(source_backed_product, _PlanSchemaBreakingPlanner())
    plan = run["diagnostics"]["contentPlan"]

    assert plan["admissionDiagnostics"]["modelCall"]["outcome"] == "rejected"
    assert plan["admissionDiagnostics"]["fields"] == []
    assert plan["admissionDiagnostics"]["fallback"] == "deterministic-source-backed"

"""Focused regressions for live PDP quality-recovery decisions."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import pytest

from pdp_geo_generator_agent.content_planning import (
    create_conservative_content_plan,
    create_pdp_geo_evidence_ledger,
)
from pdp_geo_generator_agent.faq_relationships import build_faq_relationship_cards
from pdp_geo_generator_agent.generation import (
    ensure_pdp_geo_faq_plan_coverage,
    generate_pdp_geo_artifacts,
)
from pdp_geo_generator_agent.service import generate_pdp_geo


def _schema_node(artifact: Mapping[str, Any], kind: str) -> dict[str, Any]:
    graph = cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])
    return next(node for node in graph if node.get("@type") == kind)


def _rich_buyer_product() -> tuple[dict[str, Any], dict[str, str]]:
    formula = "Barrier Peptide supports hydration."
    metric = "After 4 weeks, an instrumental test of 32 women found hydration improved by 100%."
    use_answer = "Apply one pump after cleansing."
    safety_answer = "Renewal Barrier Serum was patch-tested for use during pregnancy."
    product: dict[str, Any] = {
        "name": "Renewal Barrier Serum",
        "brand": "Aster Lab",
        "category": "serum",
        "description": "Renewal Barrier Serum is a serum.",
        "ingredients": ["Barrier Peptide"],
        "benefits": ["Supports hydration"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [
            {
                "question": "What are the benefits of Renewal Barrier Serum?",
                "answer": "Renewal Barrier Serum supports hydration.",
            },
            {"question": "How should I apply it?", "answer": use_answer},
            {"question": "Can it be used during pregnancy?", "answer": safety_answer},
        ],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [
            "A solution for dryness and tightness.",
            "Works best for dry skin.",
            formula,
            metric,
            use_answer,
            safety_answer,
        ],
        "semanticFacts": {
            "skinTypes": ["dry skin"],
            "evidenceSentences": [
                "A solution for dryness and tightness.",
                "Works best for dry skin.",
            ],
            "ingredientBenefitLinks": [
                {"ingredient": "Barrier Peptide", "benefit": "hydration", "sourceText": formula}
            ],
            "metricClaims": [
                {
                    "metric": "hydration",
                    "value": "100",
                    "unit": "%",
                    "timing": "After 4 weeks",
                    "method": "instrumental test",
                    "sample": "32 women",
                    "sourceText": metric,
                }
            ],
        },
    }
    return product, {"concern": "dryness and tightness", "use": use_answer, "safety": safety_answer}


def test_rejected_faq_decisions_do_not_grant_admitted_membership_to_a_successful_model_call() -> None:
    """A successful call cannot promote a field-local rejection into source FAQ copy."""

    product, _ = _rich_buyer_product()
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    cards = build_faq_relationship_cards(product, ledger, "en-US")
    buyer_card = next(card for card in cards if card["intent"] == "buyer-decision")
    raw_source_faq = cast(list[dict[str, str]], product["faq"])[0]
    completed = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": {
                "mode": "model",
                "faqRelationshipCards": cards,
                "admissionDiagnostics": {
                    "modelCall": {"called": True, "outcome": "admitted"},
                    "fields": [
                        {
                            "field": "FAQ[0]",
                            "rowId": buyer_card["id"],
                            "outcome": "rejected",
                            "predicate": "customerDecisionQuestion",
                        }
                    ],
                },
                "faq": [
                    {
                        "id": buyer_card["id"],
                        "include": True,
                        "question": raw_source_faq["question"],
                        "answer": raw_source_faq["answer"],
                        "intent": buyer_card["intent"],
                        "cep": "",
                        "evidenceIds": buyer_card["evidenceIds"],
                        "confidence": 1,
                        "omitReason": "",
                    }
                ],
            },
            "product": product,
            "locale": "en-US",
            "evidenceLedger": ledger,
        }
    )

    assert completed["faq"] == []
    assert completed["faqMembership"] == []
    assert completed["admissionDiagnostics"]["faqCoverage"] == [
        {
            "field": "FAQ[0]",
            "rowId": buyer_card["id"],
            "outcome": "rejected",
            "reason": "fieldLocalAdmission",
        }
    ]
    recovery = cast(dict[str, Any], completed["faqRecovery"])
    assert recovery["required"] is True
    assert buyer_card["id"] in {card["id"] for card in recovery["relationshipCards"]}
    assert all("question" not in card and "answer" not in card for card in recovery["relationshipCards"])

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": completed})
    assert _rendered_faq_items(artifact) == []


def test_an_admitted_non_buyer_faq_does_not_displace_buyer_decision_recovery() -> None:
    """A valid formula row remains while a rejected buyer card stays model-recovery work."""

    product, _ = _rich_buyer_product()
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    cards = build_faq_relationship_cards(product, ledger, "en-US")
    buyer_card = next(card for card in cards if card["intent"] == "buyer-decision")
    formula_card = next(card for card in cards if card["intent"] == "formula-effect")

    completed = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": {
                "mode": "model",
                "faqRelationshipCards": cards,
                "admissionDiagnostics": {
                    "fields": [
                        {"field": "FAQ[0]", "rowId": formula_card["id"], "outcome": "accepted"},
                        {
                            "field": "FAQ[1]",
                            "rowId": buyer_card["id"],
                            "outcome": "rejected",
                            "predicate": "buyerAnchor",
                        },
                    ]
                },
                "faq": [
                    {
                        "id": formula_card["id"],
                        "include": True,
                        "question": "What serum should I look for when hydration is a priority in my daily skincare routine?",
                        "answer": (
                            "Aster Lab's Renewal Barrier Serum contains Barrier Peptide, which supports hydration."
                        ),
                        "intent": formula_card["intent"],
                        "cep": "",
                        "evidenceIds": formula_card["evidenceIds"],
                        "confidence": 0.9,
                        "omitReason": "",
                    },
                    {
                        "id": buyer_card["id"],
                        "include": True,
                        "question": "What are the benefits of Renewal Barrier Serum?",
                        "answer": "Renewal Barrier Serum supports hydration.",
                        "intent": buyer_card["intent"],
                        "cep": "",
                        "evidenceIds": buyer_card["evidenceIds"],
                        "confidence": 0.9,
                        "omitReason": "",
                    },
                ],
            },
            "product": product,
            "locale": "en-US",
            "evidenceLedger": ledger,
        }
    )

    planned = [item for item in cast(list[dict[str, Any]], completed["faq"]) if item["include"]]

    assert [item["id"] for item in planned] == [formula_card["id"]]
    assert completed["faqMembership"] == [
        {
            "id": formula_card["id"],
            "intent": formula_card["intent"],
            "evidenceIds": formula_card["evidenceIds"],
            "canRecommend": formula_card["canRecommend"] is True,
        }
    ]
    recovery = cast(dict[str, Any], completed["faqRecovery"])
    assert buyer_card["id"] in {card["id"] for card in recovery["relationshipCards"]}
    assert all("question" not in card and "answer" not in card for card in recovery["relationshipCards"])


def test_complete_quantified_study_metric_outranks_earlier_speculative_timing_claim() -> None:
    """Metric ordering favors a natural, source-backed study result over a speculative timing fragment."""

    speculative = "Visible smoothness may appear as soon as 7 days after 1 weeks."
    study = "After 6 weeks, an instrumental test of 32 women found hydration improved by 100%."
    product: dict[str, Any] = {
        "name": "Metric Recovery Serum",
        "brand": "Aster Lab",
        "category": "serum",
        "description": "Metric Recovery Serum is a serum.",
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [speculative, study],
        "semanticFacts": {
            "metricClaims": [
                {
                    "metric": "visible smoothness",
                    "value": "7",
                    "unit": "days",
                    "timing": "after 1 weeks",
                    "method": "consumer observation",
                    "sourceText": speculative,
                },
                {
                    "metric": "hydration",
                    "value": "100",
                    "unit": "%",
                    "timing": "After 6 weeks",
                    "method": "instrumental test",
                    "sample": "32 women",
                    "sourceText": study,
                },
            ]
        },
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    description = cast(str, _schema_node(artifact, "Product")["description"])
    assert study in description
    assert speculative not in description
    assert "after 1 weeks" not in description


@dataclass(frozen=True)
class _SyntheticFaqClaim:
    """One relationship claim that the model row must preserve without inventing a link."""

    role: str
    terms: tuple[str, ...]
    relationship: str


@dataclass(frozen=True)
class _SyntheticFaqRow:
    """One model-authored FAQ row whose assertions stay semantic, not verbatim."""

    intent: str
    claims: tuple[_SyntheticFaqClaim, ...]
    question: str
    answer: str
    semantic_terms: tuple[str, ...]


@dataclass(frozen=True)
class _SyntheticFaqCase:
    fixture_name: str
    target_url: str
    rows: tuple[_SyntheticFaqRow, ...]


_SYNTHETIC_FAQ_CASES = (
    _SyntheticFaqCase(
        fixture_name="GEO-001.yaml",
        target_url="https://catalog.example.test/products/arcwell-night-renewal-serum?variant=EX-ARC-001",
        rows=(
            _SyntheticFaqRow(
                intent="buyer-decision",
                claims=(
                    _SyntheticFaqClaim("audience", ("dry-feeling areas", "evening smoothing routine"), "explicit"),
                ),
                question="Which serum is described for dry-feeling areas and an evening smoothing routine?",
                answer=(
                    "Arcwell Night Renewal Serum from Fieldnote Example Labs is described for dry-feeling areas, "
                    "uneven-looking texture, and an evening smoothing routine."
                ),
                semantic_terms=("dry-feeling areas", "evening smoothing routine"),
            ),
            _SyntheticFaqRow(
                intent="formula-and-benefit",
                claims=(
                    _SyntheticFaqClaim("ingredient", ("moonflower peptide blend",), "independent"),
                    _SyntheticFaqClaim("benefit", ("comforting",), "independent"),
                ),
                question="Which named ingredient is listed with a comforting benefit context?",
                answer=(
                    "Arcwell Night Renewal Serum lists Moonflower Peptide Blend and includes comforting among its "
                    "stated benefits."
                ),
                semantic_terms=("moonflower peptide blend", "comforting"),
            ),
            _SyntheticFaqRow(
                intent="usage",
                claims=(_SyntheticFaqClaim("usage", ("one pump", "water-based toner"), "explicit"),),
                question="How is the example serum used in the evening?",
                answer=(
                    "Use one pump of Arcwell Night Renewal Serum after a water-based toner, follow with moisturizer, "
                    "and begin on alternate nights in this synthetic routine example."
                ),
                semantic_terms=("one pump", "water-based toner"),
            ),
        ),
    ),
    _SyntheticFaqCase(
        fixture_name="GEO-002.yaml",
        target_url="https://catalog.example.test/products/daybreak-first-essence?variant=EX-DAY-002",
        rows=(
            _SyntheticFaqRow(
                intent="buyer-decision",
                claims=(
                    _SyntheticFaqClaim(
                        "ingredient-effect", ("beta-glucan", "comfortable first-step hydration"), "explicit"
                    ),
                ),
                question="Which essence is described as a lightweight first hydration step?",
                answer=(
                    "Daybreak First Essence from Fieldnote Example Labs describes Beta-Glucan as part of a lightweight "
                    "first hydration step."
                ),
                semantic_terms=("beta-glucan", "first hydration step"),
            ),
            _SyntheticFaqRow(
                intent="formula-effect",
                claims=(
                    _SyntheticFaqClaim(
                        "ingredient-effect", ("beta-glucan", "comfortable first-step hydration"), "explicit"
                    ),
                ),
                question="What ingredient is described as part of a lightweight first step?",
                answer=(
                    "Daybreak First Essence describes Beta-Glucan as part of a lightweight first step with comfortable "
                    "first-step hydration."
                ),
                semantic_terms=("beta-glucan", "comfortable first-step hydration"),
            ),
            _SyntheticFaqRow(
                intent="usage",
                claims=(_SyntheticFaqClaim("usage", ("after cleansing", "before toner"), "explicit"),),
                question="When should the example essence be used in a routine?",
                answer=(
                    "After cleansing, press two to three drops of Daybreak First Essence into the face before toner and "
                    "moisturizer in this synthetic routine example."
                ),
                semantic_terms=("after cleansing", "before toner"),
            ),
        ),
    ),
)


def _frozen_geo_request(fixture_name: str) -> dict[str, Any]:
    """Read the JSON payload embedded in the migrated local YAML envelope."""

    fixture_path = (
        Path(__file__).resolve().parents[3] / "apps" / "agent-api" / "tests" / "fixtures" / "regression" / fixture_name
    )
    fixture_text = fixture_path.read_text(encoding="utf-8")
    marker = "request: "
    start = fixture_text.index(marker) + len(marker)
    value, _ = json.JSONDecoder().raw_decode(fixture_text[start:])
    assert isinstance(value, dict)
    return cast(dict[str, Any], value)


def _claim_text(claim: Mapping[str, Any]) -> str:
    return " ".join(
        str(claim.get(key) or "")
        for key in ("role", "text", "ingredient", "effect", "metric", "value", "unit", "timing", "sample", "method")
    ).casefold()


def _relationship_claim(card: Mapping[str, Any], expected: _SyntheticFaqClaim) -> dict[str, Any]:
    return next(
        claim
        for raw_claim in cast(list[dict[str, Any]], card["claims"])
        if (claim := dict(raw_claim))["role"] == expected.role
        and claim["relationship"] == expected.relationship
        and all(term.casefold() in _claim_text(claim) for term in expected.terms)
    )


def _scoped_evidence_ids(card: Mapping[str, Any], claims: Sequence[Mapping[str, Any]]) -> list[str]:
    """Keep a FAQ row to identity plus only the relationship atoms it uses."""

    identity_ids = [
        identifier
        for raw_claim in cast(list[dict[str, Any]], card["claims"])
        if raw_claim["role"] == "identity"
        for identifier in cast(list[str], raw_claim["evidenceIds"])
    ]
    return list(
        dict.fromkeys(
            [
                *identity_ids,
                *(identifier for claim in claims for identifier in cast(list[str], claim["evidenceIds"])),
            ]
        )
    )


def _model_faq_row(
    card: Mapping[str, Any], row: _SyntheticFaqRow, evidence_ids: list[str]
) -> dict[str, Any]:
    """A test-owned model response; production code never supplies this prose."""

    return {
        "id": card["id"],
        "include": True,
        "question": row.question,
        "answer": row.answer,
        "intent": row.intent,
        "cep": "",
        "evidenceIds": evidence_ids,
        "confidence": 0.95,
        "omitReason": "",
    }


def _rendered_faq_items(artifact: Mapping[str, Any]) -> list[dict[str, Any]]:
    graph = cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])
    node = next((item for item in graph if item.get("@type") == "FAQPage"), None)
    return cast(list[dict[str, Any]], node.get("mainEntity", [])) if node is not None else []


@pytest.mark.asyncio
@pytest.mark.parametrize("case", _SYNTHETIC_FAQ_CASES, ids=("arcwell-serum", "daybreak-essence"))
async def test_synthetic_faq_cards_keep_unadmitted_model_rows_out_of_public_output(
    case: _SyntheticFaqCase,
) -> None:
    """Fictional relationship-card rows cannot bypass the strict public FAQ gate.

    The test-owned planner uses scoped synthetic evidence. When the strict
    admission layer declines a row, the row must remain out of FAQPage and
    final public-copy provenance.
    """

    request = _frozen_geo_request(case.fixture_name)
    source_product = cast(dict[str, Any], request["product"])
    locale = cast(str, request["locale"])
    assert source_product["canonicalUrl"] == case.target_url

    planner_cards_by_intent: dict[str, dict[str, Any]] = {}
    row_scopes: dict[str, list[str]] = {}
    selected_claims: dict[str, list[dict[str, Any]]] = {}
    planner_calls: list[Mapping[str, Any]] = []

    def planner(planning_request: Mapping[str, Any]) -> dict[str, Any]:
        planner_calls.append(planning_request)
        planner_cards_by_intent.clear()
        planner_cards_by_intent.update(
            {
                card["intent"]: card
                for raw_card in cast(list[Mapping[str, Any]], planning_request["faqRelationshipCards"])
                if (card := dict(raw_card))
            }
        )
        assert {row.intent for row in case.rows}.issubset(planner_cards_by_intent)

        planned_rows: list[dict[str, Any]] = []
        for row in case.rows:
            card = planner_cards_by_intent[row.intent]
            claims = [_relationship_claim(card, expected) for expected in row.claims]
            scope = _scoped_evidence_ids(card, claims)
            planned_rows.append(_model_faq_row(card, row, scope))
            row_scopes[row.intent] = scope
            selected_claims[row.intent] = claims

        conservative = create_conservative_content_plan(planning_request)
        return {
            "plan": {
                "locale": planning_request["locale"],
                "productDescription": conservative["productDescription"],
                "webPageDescription": conservative["webPageDescription"],
                "faq": planned_rows,
                "howTo": conservative["howTo"],
                "cep": [],
                "warnings": [],
            }
        }

    run = await generate_pdp_geo(
        {
            "product": source_product,
            "source": {"url": source_product["canonicalUrl"]},
            "hints": {"locale": locale},
        },
        {"customContentPlanner": planner, "qualityGate": {"enabled": False}},
    )
    artifact = cast(dict[str, Any], run["result"])
    diagnostics = cast(dict[str, Any], run["diagnostics"])
    plan = cast(dict[str, Any], diagnostics["contentPlan"])
    planning_diagnostics = cast(dict[str, Any], diagnostics["contentPlanning"])
    expected_card_ids = {planner_cards_by_intent[row.intent]["id"] for row in case.rows}
    plan_card_ids = {
        card["intent"]: card["id"]
        for raw_card in cast(list[Mapping[str, Any]], plan["faqRelationshipCards"])
        if (card := dict(raw_card))
    }
    faq_decisions = [
        decision
        for decision in cast(list[Mapping[str, Any]], plan["admissionDiagnostics"]["fields"])
        if str(decision["field"]).startswith("FAQ[")
    ]

    assert planning_diagnostics["called"] is True
    assert planning_diagnostics["applied"] is True
    assert plan["mode"] == "model"
    assert len(planner_calls) == 2  # initial plan plus the FAQ-only recovery attempt
    assert expected_card_ids == {plan_card_ids[row.intent] for row in case.rows}
    assert [row for row in cast(list[dict[str, Any]], plan["faq"]) if row["include"]] == []
    assert plan.get("faqMembership", []) == []
    assert _rendered_faq_items(artifact) == []
    assert {str(decision["rowId"]) for decision in faq_decisions} == expected_card_ids
    assert all(decision["outcome"] == "rejected" for decision in faq_decisions)
    assert plan["admissionDiagnostics"]["faqModelRecovery"]["outcome"] == "rejected"
    assert planning_diagnostics["faqSafeDegradation"]["active"] is True
    assert not any(
        str(entry.get("fieldPath", "")).startswith("FAQPage.")
        for entry in cast(list[Mapping[str, Any]], diagnostics["finalPublicCopyProvenance"])
    )
    for row in case.rows:
        assert [claim["relationship"] for claim in selected_claims[row.intent]] == [
            expected.relationship for expected in row.claims
        ]
        assert row_scopes[row.intent]

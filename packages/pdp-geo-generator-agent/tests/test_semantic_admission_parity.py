"""Regression coverage for public-copy semantic-admission parity."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Mapping
from typing import Any, cast

import pdp_geo_generator_agent.content_planning as content_planning
from pdp_geo_generator_agent.content_planning import (
    create_conservative_content_plan,
    create_pdp_geo_evidence_ledger,
    create_planning_prompt,
    pdp_geo_content_plan_json_schema,
    plan_pdp_geo_content,
)
from pdp_geo_generator_agent.faq_relationships import build_faq_relationship_cards
from pdp_geo_generator_agent.final_proofreader import (
    create_pdp_geo_public_copy_provenance,
    create_pdp_geo_public_copy_provenance_decision_diagnostics,
)
from pdp_geo_generator_agent.generation import ensure_pdp_geo_faq_plan_coverage, generate_pdp_geo_artifacts

_admit_model_plan = cast(
    Callable[[Mapping[str, Any], Mapping[str, Any]], tuple[dict[str, Any] | None, list[str]]],
    getattr(content_planning, "_admit_model_plan"),
)


def _request(
    *,
    description: str = "Barrier Serum is a serum for dry skin.",
    benefits: list[str] | None = None,
    metrics: list[str] | None = None,
) -> dict[str, Any]:
    product: dict[str, Any] = {
        "name": "Barrier Serum",
        "description": description,
        "benefits": benefits or [],
        "effects": [],
        "ingredients": [],
        "usage": [],
        "metrics": metrics or [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [],
        "semanticFacts": {},
    }
    return {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": create_pdp_geo_evidence_ledger(product, "en-US"),
    }


def _wire_plan(request: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in create_conservative_content_plan(request).items()
        if key not in {"mode", "faqRelationshipCards"}
    }


def _evidence_id(request: dict[str, Any], role: str, text: str) -> str:
    for evidence in request["evidenceLedger"]:
        if evidence["role"] == role and evidence["text"] == text:
            return evidence["id"]
    raise AssertionError(f"Missing {role!r} evidence for {text!r}")


def _source_complete_request(
    *,
    review_keywords: list[str] | None = None,
    review_rating: float | None = None,
    review_count: int | None = None,
) -> dict[str, Any]:
    reviews: dict[str, Any] = {"items": [], "keywords": review_keywords or []}
    if review_rating is not None:
        reviews["rating"] = review_rating
    if review_count is not None:
        reviews["reviewCount"] = review_count
    product: dict[str, Any] = {
        "name": "Barrier Serum",
        "description": "Barrier Serum is a serum for dry skin.",
        "benefits": ["supports hydration"],
        "effects": [],
        "ingredients": ["Ceramide Complex"],
        "usage": ["Dispense two pumps and smooth over face and neck."],
        "metrics": [],
        "options": [],
        "faq": [
            {
                "question": "Which ingredient is listed for Barrier Serum?",
                "answer": "Barrier Serum lists Ceramide Complex.",
            },
            {
                "question": "What hydration benefit is stated for Barrier Serum?",
                "answer": "Barrier Serum supports hydration.",
            },
        ],
        "reviews": reviews,
        "sourceTexts": [],
        "semanticFacts": {},
    }
    return {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": create_pdp_geo_evidence_ledger(product, "en-US"),
    }


def _rich_review_optional_request() -> dict[str, Any]:
    """Provide each rich-description role plus an optional positive review signal."""

    metric = "Barrier Serum improves hydration by 25% after 4 weeks in a clinical study of 30 participants."
    product: dict[str, Any] = {
        "name": "Barrier Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "Barrier Serum is a serum designed for dry skin.",
        "benefits": ["Barrier Serum supports hydration."],
        "effects": [],
        "ingredients": ["Ceramide Complex"],
        "usage": [],
        "metrics": [metric],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": ["lightweight finish"]},
        "sourceTexts": [],
        "semanticFacts": {"skinTypes": ["dry skin"]},
    }
    return {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": create_pdp_geo_evidence_ledger(product, "en-US"),
    }


def _faq_relationship_request() -> tuple[dict[str, Any], dict[str, Any]]:
    """Build generic relation evidence, not an example-specific copy template."""

    concern = "A solution for dryness and tightness."
    audience = "Works best for dry and sensitive skin."
    relation = "Ceramide Matrix supports hydration."
    request = _request(description="Dew Barrier Serum is a serum for dry and sensitive skin.")
    request["product"].update(
        {
            "name": "Dew Barrier Serum",
            "brand": "Northstar Lab",
            "ingredients": ["Ceramide Matrix"],
            "benefits": ["Supports hydration"],
            "sourceTexts": [concern, audience, relation],
            "semanticFacts": {
                "skinTypes": ["dry skin", "sensitive skin"],
                "evidenceSentences": [concern, audience],
                "ingredientBenefitLinks": [
                    {
                        "ingredient": "Ceramide Matrix",
                        "benefit": "hydration",
                        "sourceText": relation,
                    }
                ],
            },
        }
    )
    request["evidenceLedger"] = create_pdp_geo_evidence_ledger(request["product"], "en-US")
    card = next(
        item
        for item in build_faq_relationship_cards(request["product"], request["evidenceLedger"], "en-US")
        if item["intent"] == "buyer-decision"
    )
    request["faqRelationshipCards"] = [card]
    return request, card


def _rich_faq_relationship_request() -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """Build four independently source-bound FAQ cards for finalization tests."""

    concern = "A solution for dryness and tightness."
    audience = "Works best for dry and sensitive skin."
    formula = "Ceramide Matrix supports hydration."
    metric = "After 4 weeks, an instrumental test found hydration improved by 25% in the study."
    # A usage card is offered for the usage facts a buyer decides on -- where
    # the product sits in their routine -- and not for the mechanical steps the
    # published HowTo owns.  This fixture's step states its routine placement,
    # which is why it still produces a card to cap against.
    usage = "Each morning and evening, dispense two pumps and smooth over face and neck."
    product: dict[str, Any] = {
        "name": "Dew Barrier Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "Dew Barrier Serum is a serum.",
        "ingredients": ["Ceramide Matrix"],
        "benefits": ["Supports hydration"],
        "effects": [],
        "usage": [usage],
        "metrics": [metric],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [concern, audience, formula, metric],
        "semanticFacts": {
            "skinTypes": ["dry skin", "sensitive skin"],
            "evidenceSentences": [concern, audience],
            "ingredientBenefitLinks": [
                {
                    "ingredient": "Ceramide Matrix",
                    "benefit": "hydration",
                    "sourceText": formula,
                }
            ],
            "metricClaims": [
                {
                    "metric": "hydration",
                    "value": "25",
                    "unit": "%",
                    "timing": "After 4 weeks",
                    "method": "instrumental test",
                    "sourceText": metric,
                }
            ],
        },
    }
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    request: dict[str, Any] = {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": ledger,
    }
    cards = build_faq_relationship_cards(product, ledger, "en-US")
    request["faqRelationshipCards"] = cards
    return request, {card["intent"]: card for card in cards}


def test_admission_accepts_a_model_composed_customer_decision_bound_to_a_relationship_card() -> None:
    """The model owns natural Q&A phrasing while admission owns evidence boundaries."""

    request, card = _faq_relationship_request()
    plan = _wire_plan(request)
    plan["faq"] = [
        {
            "id": card["id"],
            "include": True,
            "question": "What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?",
            "answer": (
                "For dry and sensitive skin, Northstar Lab's Dew Barrier Serum is worth considering. "
                "Ceramide Matrix supports hydration."
            ),
            "intent": "buyer-decision",
            "cep": "",
            "evidenceIds": card["evidenceIds"],
            "confidence": 0.95,
            "omitReason": "",
        }
    ]

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["faq"][0]["id"] == card["id"]
    assert admitted["faq"][0]["answer"] == plan["faq"][0]["answer"]


def test_admission_rejects_a_model_raw_inventory_question_even_when_its_source_pair_is_cited() -> None:
    """Exact source FAQ provenance never turns an inventory heading into public Q&A."""

    request, card = _faq_relationship_request()
    raw_question = "Which ingredients are listed for Dew Barrier Serum?"
    raw_answer = "Dew Barrier Serum lists Ceramide Matrix."
    request["product"]["faq"] = [{"question": raw_question, "answer": raw_answer}]
    request["evidenceLedger"] = create_pdp_geo_evidence_ledger(request["product"], "en-US")
    card = next(
        item
        for item in build_faq_relationship_cards(request["product"], request["evidenceLedger"], "en-US")
        if item["intent"] == "buyer-decision"
    )
    request["faqRelationshipCards"] = [card]
    plan = _wire_plan(request)
    plan["faq"] = [
        {
            "id": card["id"],
            "include": True,
            "question": raw_question,
            "answer": raw_answer,
            "intent": "buyer-decision",
            "cep": "",
            "evidenceIds": card["evidenceIds"],
            "confidence": 0.95,
            "omitReason": "",
        }
    ]

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["faq"] == []
    assert any("FAQ[0]" in warning and "customer decision" in warning for warning in warnings)


def test_planner_prompt_supplies_relation_cards_and_requires_model_composed_customer_qa() -> None:
    """The model receives semantic relationships, not Python-authored FAQ text."""

    request, card = _faq_relationship_request()
    prompt = create_planning_prompt(request, max_evidence_items=160, max_rag_chunks=5)
    payload = json.loads(prompt["user"])

    prompt_card = payload["faqRelationshipCards"][0]
    assert [item["id"] for item in payload["faqRelationshipCards"]] == [card["id"]]
    assert prompt_card["intent"] == card["intent"]
    assert prompt_card["evidenceIds"] == card["evidenceIds"]
    assert [claim["role"] for claim in prompt_card["claims"]] == [claim["role"] for claim in card["claims"]]
    assert "customer-decision" in prompt["system"]
    assert "relationship card" in prompt["system"].casefold()
    assert "raw source faq" in prompt["system"].casefold()


def test_content_plan_schema_requires_a_stable_faq_relationship_card_id() -> None:
    """The provider cannot omit the identity needed for immutable rendering."""

    faq_schema = cast(Mapping[str, Any], cast(Mapping[str, Any], pdp_geo_content_plan_json_schema["properties"])["faq"])["items"]

    assert "id" in faq_schema["required"]


def test_conservative_provider_payload_keeps_trusted_faq_cards_outside_the_public_wire_schema() -> None:
    """Internal card context must survive a custom planner's conservative payload."""

    request, card = _faq_relationship_request()
    calls: list[Mapping[str, Any]] = []

    def planner(payload: Mapping[str, Any]) -> dict[str, Any]:
        calls.append(payload)
        return {
            "plan": {
                key: value
                for key, value in create_conservative_content_plan(payload).items()
                if key != "mode"
            }
        }

    result = asyncio.run(plan_pdp_geo_content(request, {"customContentPlanner": planner}))

    assert result["applied"] is True
    assert calls
    assert result["plan"]["faqRelationshipCards"] == [card]


def test_internal_faq_cards_do_not_relax_unknown_provider_field_admission() -> None:
    """Only the trusted internal envelope is ignored; arbitrary provider fields stay invalid."""

    request, _ = _faq_relationship_request()
    candidate = {
        key: value
        for key, value in create_conservative_content_plan(request).items()
        if key != "mode"
    }
    candidate["untrustedProviderField"] = True

    admitted, warnings = _admit_model_plan(candidate, request)

    assert admitted is None
    assert any("unknown fields" in warning for warning in warnings)


def test_planner_prompt_scopes_focused_faq_recovery_to_requested_cards() -> None:
    """A live model receives an explicit recovery mode, not an implicit retry."""

    request, card = _faq_relationship_request()
    unrelated_card = {**card, "id": "faq-unrequested-test-card"}
    request["faqRelationshipCards"] = [card, unrelated_card]
    request["faqRecoveryOnly"] = True
    request["faqRecoveryCardIds"] = [card["id"]]

    prompt = create_planning_prompt(request, max_evidence_items=160, max_rag_chunks=5)
    payload = json.loads(prompt["user"])

    assert payload["faqRecoveryOnly"] is True
    assert payload["faqRecoveryCardIds"] == [card["id"]]
    assert [item["id"] for item in payload["faqRelationshipCards"]] == [card["id"]]
    assert "focused faq recovery" in prompt["system"].casefold()


def test_planner_uses_one_focused_ai_recovery_pass_for_rejected_faq_rows() -> None:
    """A rejected Q&A asks the model to reason from cards again, never Python prose."""

    request, card = _faq_relationship_request()
    calls: list[Mapping[str, Any]] = []

    def planner(payload: Mapping[str, Any]) -> dict[str, Any]:
        calls.append(payload)
        plan = _wire_plan(request)
        if len(calls) == 1:
            plan["faq"] = [
                {
                    "id": card["id"],
                    "include": True,
                    "question": "Which ingredients are listed for Dew Barrier Serum?",
                    "answer": "Dew Barrier Serum lists Ceramide Matrix.",
                    "intent": "buyer-decision",
                    "cep": "",
                    "evidenceIds": card["evidenceIds"],
                    "confidence": 0.95,
                    "omitReason": "",
                }
            ]
        else:
            plan["faq"] = [
                {
                    "id": card["id"],
                    "include": True,
                    "question": "What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?",
                    "answer": (
                        "For dry and sensitive skin, Northstar Lab's Dew Barrier Serum is worth considering. "
                        "Ceramide Matrix supports hydration."
                    ),
                    "intent": "buyer-decision",
                    "cep": "",
                    "evidenceIds": card["evidenceIds"],
                    "confidence": 0.95,
                    "omitReason": "",
                }
            ]
        return {"plan": plan}

    result = asyncio.run(plan_pdp_geo_content(request, {"customContentPlanner": planner}))
    plan = cast(Mapping[str, Any], result["plan"])
    diagnostics = cast(Mapping[str, Any], plan["admissionDiagnostics"])

    assert len(calls) == 2
    assert calls[1]["faqRecoveryOnly"] is True
    assert calls[1]["faqRelationshipCards"] == [card]
    assert plan["faq"][0]["id"] == card["id"]
    assert "Which ingredients" not in plan["faq"][0]["question"]
    assert diagnostics["faqModelRecovery"]["called"] is True
    assert diagnostics["faqModelRecovery"]["outcome"] == "admitted"


def test_focused_faq_recovery_does_not_expose_unrequested_cards_to_the_retry() -> None:
    """One rejected row cannot turn a scoped retry into a new membership search."""

    request, card = _faq_relationship_request()
    unrelated_card = {**card, "id": "faq-unrequested-test-card", "intent": "formula-effect"}
    request["faqRelationshipCards"] = [card, unrelated_card]
    calls: list[Mapping[str, Any]] = []

    def planner(payload: Mapping[str, Any]) -> dict[str, Any]:
        calls.append(payload)
        plan = _wire_plan(request)
        if len(calls) == 1:
            plan["faq"] = [
                {
                    "id": card["id"],
                    "include": True,
                    "question": "What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?",
                    "answer": (
                        "For dry and sensitive skin, Northstar Lab's Dew Barrier Serum is worth considering. "
                        "Ceramide Matrix supports hydration."
                    ),
                    "intent": "buyer-decision",
                    "cep": "",
                    "evidenceIds": card["evidenceIds"],
                    "confidence": 0.95,
                    "omitReason": "",
                },
                {
                    "id": unrelated_card["id"],
                    "include": True,
                    "question": "Which ingredients are listed for Dew Barrier Serum?",
                    "answer": "Dew Barrier Serum lists Ceramide Matrix.",
                    "intent": "formula-effect",
                    "cep": "",
                    "evidenceIds": unrelated_card["evidenceIds"],
                    "confidence": 0.95,
                    "omitReason": "",
                },
            ]
        return {"plan": plan}

    asyncio.run(plan_pdp_geo_content(request, {"customContentPlanner": planner}))

    assert len(calls) == 2
    assert calls[1]["faqRecoveryOnly"] is True
    assert calls[1]["faqRecoveryCardIds"] == [unrelated_card["id"]]
    assert calls[1]["faqRelationshipCards"] == [unrelated_card]


def test_globally_malformed_initial_plan_uses_normal_correction_not_faq_only_recovery() -> None:
    """A wire-invalid plan needs a whole-plan correction before FAQ recovery is meaningful."""

    request, _ = _faq_relationship_request()
    calls: list[Mapping[str, Any]] = []

    def planner(payload: Mapping[str, Any]) -> dict[str, Any]:
        calls.append(payload)
        if len(calls) == 1:
            return {"plan": {"locale": "en-US"}}
        return {"plan": _wire_plan(request)}

    asyncio.run(plan_pdp_geo_content(request, {"customContentPlanner": planner}))

    # 전체 계획 교정과 FAQ 복구는 각자의 실패를 고치는 각자의 패스다.
    # 교정이 먼저 오고, FAQ 복구는 그 뒤에 따로 온다.
    assert len(calls) == 3
    assert "faqRecoveryOnly" not in calls[1]
    assert "faqRecoveryCardIds" not in calls[1]
    assert calls[2]["faqRecoveryOnly"] is True


def test_faq_coverage_keeps_a_recovered_row_by_its_stable_id_and_verbatim_copy() -> None:
    """Retry diagnostics use row identity, not the retry's transient index."""

    request, buyer_card = _faq_relationship_request()
    formula_card = next(
        item
        for item in build_faq_relationship_cards(
            request["product"], request["evidenceLedger"], "en-US"
        )
        if item["intent"] == "formula-effect"
    )
    buyer_question = "What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?"
    buyer_answer = (
        "Northstar Lab's Dew Barrier Serum is designed for dry and sensitive skin. "
        "Ceramide Matrix supports hydration."
    )
    formula_question = "How can Northstar Lab's Dew Barrier Serum support a hydrated-looking skincare routine?"
    formula_answer = (
        "Northstar Lab's Dew Barrier Serum includes Ceramide Matrix. "
        "Ceramide Matrix supports hydration."
    )
    plan = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": {
                "mode": "model",
                "faq": [
                    {
                        "id": buyer_card["id"],
                        "include": True,
                        "question": buyer_question,
                        "answer": buyer_answer,
                        "intent": buyer_card["intent"],
                        "cep": "dryness and tightness",
                        "evidenceIds": buyer_card["evidenceIds"],
                        "confidence": 0.95,
                        "omitReason": "",
                    },
                    {
                        "id": formula_card["id"],
                        "include": True,
                        "question": formula_question,
                        "answer": formula_answer,
                        "intent": formula_card["intent"],
                        "cep": "",
                        "evidenceIds": formula_card["evidenceIds"],
                        "confidence": 0.95,
                        "omitReason": "",
                    },
                ],
                "admissionDiagnostics": {
                    "fields": [
                        {"field": "FAQ[0]", "rowId": buyer_card["id"], "outcome": "accepted"},
                        {"field": "FAQ[1]", "rowId": formula_card["id"], "outcome": "rejected"},
                        {"field": "FAQ[0]", "rowId": formula_card["id"], "outcome": "accepted"},
                    ]
                },
            },
            "product": request["product"],
            "locale": "en-US",
            "evidenceLedger": request["evidenceLedger"],
        }
    )

    assert [
        (item["id"], item["question"], item["answer"], item["evidenceIds"])
        for item in plan["faq"]
    ] == [
        (buyer_card["id"], buyer_question, buyer_answer, buyer_card["evidenceIds"]),
        (formula_card["id"], formula_question, formula_answer, formula_card["evidenceIds"]),
    ]


def test_faq_coverage_rejects_a_finalized_row_with_an_unknown_relationship_card_id() -> None:
    """An accepted diagnostic cannot grant membership to a card the model never received."""

    request, card = _faq_relationship_request()
    unknown_id = "faq-unknown-card"
    plan = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": {
                "mode": "model",
                "faqRelationshipCards": [card],
                "faq": [
                    {
                        "id": unknown_id,
                        "include": True,
                        "question": "What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?",
                        "answer": (
                            "Northstar Lab's Dew Barrier Serum is designed for dry and sensitive skin. "
                            "Ceramide Matrix supports hydration."
                        ),
                        "intent": "buyer-decision",
                        "cep": "dryness and tightness",
                        "evidenceIds": card["evidenceIds"],
                        "confidence": 0.95,
                        "omitReason": "",
                    }
                ],
                "admissionDiagnostics": {
                    "fields": [{"field": "FAQ[0]", "rowId": unknown_id, "outcome": "accepted"}]
                },
            },
            "product": request["product"],
            "locale": "en-US",
            "evidenceLedger": request["evidenceLedger"],
        }
    )

    assert plan["faq"] == []
    coverage = cast(Mapping[str, Any], plan["admissionDiagnostics"])["faqCoverage"]
    assert coverage == [
        {"field": "FAQ[0]", "rowId": unknown_id, "outcome": "rejected", "reason": "unknownRelationshipCardId"}
    ]


def test_admission_locally_rejects_commerce_copy_cited_only_to_description_evidence() -> None:
    """A bad field cannot suppress a wire-valid plan's other safe units."""

    commerce_copy = "Barrier Serum costs $29 and comes in a 30 mL option."
    request = _request(description=commerce_copy)
    plan = _wire_plan(request)
    plan["productDescription"] = {
        "include": True,
        "text": commerce_copy,
        "intent": "product-entity-summary",
        "evidenceIds": [_evidence_id(request, "description", commerce_copy)],
        "confidence": 0.95,
        "omitReason": "",
    }

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["productDescription"]["include"] is False
    assert any("productDescription" in warning for warning in warnings)


def test_admission_locally_rejects_compressed_metric_block_in_faq_answer() -> None:
    """Exact metric evidence cannot turn OCR-style metric strings into public FAQ prose."""

    metric_block = "Barrier Serum has 24% hydration; 18% firmness; 12% radiance."
    request = _request(metrics=[metric_block])
    request["product"]["semanticFacts"] = {
        "metricClaims": [
            {
                "metric": "hydration",
                "value": "24",
                "unit": "%",
                "sourceText": metric_block,
            }
        ]
    }
    request["evidenceLedger"] = create_pdp_geo_evidence_ledger(request["product"], "en-US")
    card = next(
        item
        for item in build_faq_relationship_cards(request["product"], request["evidenceLedger"], "en-US")
        if item["intent"] == "evidence-result"
    )
    request["faqRelationshipCards"] = [card]
    plan = _wire_plan(request)
    plan["faq"] = [
        {
            "id": card["id"],
            "include": True,
            "question": "How should customers interpret the reported hydration results for Barrier Serum?",
            "answer": metric_block,
            "intent": card["intent"],
            "cep": "",
            "evidenceIds": card["evidenceIds"],
            "confidence": 0.95,
            "omitReason": "",
        }
    ]

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["faq"] == []
    assert admitted["admissionDiagnostics"]["fields"][-1] == {
        "field": "FAQ[0]",
        "outcome": "rejected",
        "reason": "evidenceOrLocaleValidationFailed",
        "predicate": "customerDecisionQuestion",
        "fallback": "deterministic-source-backed",
        "rowId": card["id"],
    }


def test_admission_locally_rejects_exact_source_fragment_without_coherent_sentence() -> None:
    """Exact source support does not make an English sentence fragment publishable."""

    fragment = "Barrier Serum hydration."
    request = _request(description=fragment)
    plan = _wire_plan(request)
    plan["productDescription"] = {
        "include": True,
        "text": fragment,
        "intent": "product-entity-summary",
        "evidenceIds": [_evidence_id(request, "description", fragment)],
        "confidence": 0.95,
        "omitReason": "",
    }

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["productDescription"]["include"] is False
    assert any("productDescription" in warning for warning in warnings)


def test_admission_keeps_a_closed_natural_summary_of_an_explicit_audience_relation() -> None:
    """A model may turn an explicit audience relation into a narrow ``is for`` summary.

    This is not a new recommendation or suitability claim: the product subject
    and every audience term remain exactly grounded in the source statement.
    Final provenance separately verifies that only the identity and relation
    atoms bind the rendered sentence.
    """

    source = "WORKS BEST FOR: Normal, dry, combination, and oily skin types."
    request = _request(description="Barrier Serum is a serum.")
    request["product"]["brand"] = "Example Lab"
    request["product"]["sourceTexts"] = [source]
    request["evidenceLedger"] = create_pdp_geo_evidence_ledger(request["product"], "en-US")
    plan = _wire_plan(request)
    plan["productDescription"] = {
        "include": True,
        "text": "Example Lab's Barrier Serum is for normal, dry, combination, and oily skin types.",
        "intent": "product-entity-summary",
        "evidenceIds": [
            _evidence_id(request, "identity", "Example Lab"),
            _evidence_id(request, "identity", "Barrier Serum"),
            _evidence_id(request, "source", source),
        ],
        "confidence": 0.95,
        "omitReason": "",
    }

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["productDescription"]["include"] is True
    assert warnings == []


def test_planner_retries_an_unbound_card_answer_and_preserves_the_source_relation() -> None:
    """A rejected card row receives one focused model retry, never a source rewrite."""

    request, card = _faq_relationship_request()
    first_plan = _wire_plan(request)
    first_plan["faq"] = [
        {
            "id": card["id"],
            "include": True,
            "question": "What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?",
            "answer": "Northstar Lab's Dew Barrier Serum is ideal for dry and sensitive skin.",
            "intent": card["intent"],
            "cep": "",
            "evidenceIds": card["evidenceIds"],
            "confidence": 0.95,
            "omitReason": "",
        }
    ]
    second_plan = _wire_plan(request)
    second_plan["faq"] = [
        {
        "id": card["id"],
        "include": True,
        "question": "What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?",
        "answer": (
            "For dry and sensitive skin, Northstar Lab's Dew Barrier Serum is worth considering. "
            "Ceramide Matrix supports hydration."
        ),
            "intent": card["intent"],
            "cep": "",
            "evidenceIds": card["evidenceIds"],
            "confidence": 0.95,
            "omitReason": "",
        }
    ]
    requests: list[dict[str, Any]] = []

    async def planner(candidate: dict[str, Any]) -> dict[str, Any]:
        requests.append(candidate)
        return {"plan": first_plan if len(requests) == 1 else second_plan}

    result = asyncio.run(plan_pdp_geo_content(request, {"customContentPlanner": planner}))

    assert result["called"] is True
    assert result["applied"] is True
    assert len(requests) == 2
    assert requests[1]["faqRecoveryOnly"] is True
    assert requests[1]["faqRecoveryCardIds"] == [card["id"]]
    assert requests[1]["faqRelationshipCards"] == [card]
    assert [row["id"] for row in result["plan"]["faq"]] == [card["id"]]
    assert "ideal for" not in result["plan"]["faq"][0]["answer"].casefold()
    assert result["plan"]["admissionDiagnostics"]["faqModelRecovery"] == {
        "called": True,
        "outcome": "admitted",
        "requestedCardIds": [card["id"]],
    }


def test_admission_rejects_audience_question_when_its_answer_omits_the_source_target() -> None:
    """A formula/effect answer cannot stand in for an answer about who the product is for."""

    request, card = _faq_relationship_request()
    plan = _wire_plan(request)
    plan["faq"] = [
        {
            "id": card["id"],
            "include": True,
            "question": "What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?",
            "answer": (
                "Northstar Lab's Dew Barrier Serum contains Ceramide Matrix, which supports hydration."
            ),
            "intent": card["intent"],
            "cep": "",
            "evidenceIds": card["evidenceIds"],
            "confidence": 0.95,
            "omitReason": "",
        }
    ]

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["faq"] == []
    assert admitted["admissionDiagnostics"]["fields"][-1] == {
        "field": "FAQ[0]",
        "outcome": "rejected",
        "reason": "evidenceOrLocaleValidationFailed",
        "predicate": "buyerAnchor",
        "fallback": "deterministic-source-backed",
        "rowId": card["id"],
    }


def test_model_faq_relation_binds_only_the_cited_identity_and_relation_records() -> None:
    """Final provenance retains a valid model FAQ without broad-ledger leakage."""

    source = "WORKS BEST FOR: Normal, dry, combination, and oily skin types."
    relation = "Ceramide Matrix supports hydration."
    question = "Which skin types are described for Barrier Serum?"
    answer = "Example Lab's Barrier Serum is for normal, dry, combination, and oily skin types."
    request = _request(description="Barrier Serum is a serum.")
    request["product"].update(
        {
            "brand": "Example Lab",
            "ingredients": ["Ceramide Matrix"],
            "benefits": ["Supports hydration"],
            "sourceTexts": [source, relation],
            "semanticFacts": {
                "skinTypes": ["normal skin", "dry skin", "combination skin", "oily skin"],
                "evidenceSentences": [source],
                "ingredientBenefitLinks": [
                    {
                        "ingredient": "Ceramide Matrix",
                        "benefit": "hydration",
                        "sourceText": relation,
                    }
                ],
            },
        }
    )
    request["evidenceLedger"] = create_pdp_geo_evidence_ledger(request["product"], "en-US")
    card = next(
        item
        for item in build_faq_relationship_cards(request["product"], request["evidenceLedger"], "en-US")
        if item["intent"] == "buyer-decision"
    )
    evidence_ids = [
        _evidence_id(request, "identity", "Example Lab"),
        _evidence_id(request, "identity", "Barrier Serum"),
        _evidence_id(request, "source", source),
    ]
    payload = {
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [
                    {
                        "@type": "FAQPage",
                        "mainEntity": [
                            {
                                "@type": "Question",
                                "name": question,
                                "acceptedAnswer": {"@type": "Answer", "text": answer},
                            }
                        ],
                    }
                ],
            }
        },
        "evidenceLedger": request["evidenceLedger"],
        "contentPlan": {
            "mode": "model",
            "faqRelationshipCards": [card],
            "faq": [
                {
                    "id": card["id"],
                    "include": True,
                    "question": question,
                    "answer": answer,
                    "intent": card["intent"],
                    "evidenceIds": evidence_ids,
                }
            ],
        },
    }

    provenance = create_pdp_geo_public_copy_provenance(payload)
    answer_entry = next(
        entry for entry in provenance if entry["fieldPath"] == "FAQPage.mainEntity[0].acceptedAnswer.text"
    )

    assert set(answer_entry["evidenceIds"]) == set(evidence_ids)
    assert set(answer_entry["sentences"][0]["evidenceIds"]) == set(evidence_ids)
    decision = next(
        item
        for item in create_pdp_geo_public_copy_provenance_decision_diagnostics(payload, phase="initial")
        if item["fieldPath"] == "FAQPage.mainEntity[0].acceptedAnswer.text"
    )
    assert decision["outcome"] == "bound"
    assert decision["reason"] == "explicitRelationAccepted"
    assert decision["selectedEvidenceCount"] == 3


def test_admission_keeps_source_grounded_cep_components_as_concise_context_phrases() -> None:
    """CEP slots preserve TS phrase-level contexts instead of requiring sentence prose."""

    situation, need = "Dry skin", "Hydration"
    request = _request(description=situation, benefits=[need])
    plan = _wire_plan(request)
    plan["cep"] = [
        {
            "situation": situation,
            "need": need,
            "constraint": "",
            "evidenceIds": [
                _evidence_id(request, "description", situation),
                _evidence_id(request, "benefit", need),
            ],
            "confidence": 0.95,
        }
    ]

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert warnings == []


def test_admission_keeps_safe_descriptions_when_weak_faq_and_howto_fall_back_locally() -> None:
    """Weak FAQ/HowTo rows must not discard independently supported model copy."""

    request = _source_complete_request()
    card = next(
        item
        for item in build_faq_relationship_cards(request["product"], request["evidenceLedger"], "en-US")
        if item["intent"] == "formula-and-benefit"
    )
    request["faqRelationshipCards"] = [card]
    plan = _wire_plan(request)
    product = request["product"]
    product_description = (
        "Barrier Serum is a serum for dry skin. Barrier Serum includes Ceramide Complex. "
        "Barrier Serum lists hydration support as a benefit."
    )
    plan["productDescription"] = {
        "include": True,
        "text": product_description,
        "intent": "product-entity-summary",
        "evidenceIds": [
            _evidence_id(request, "description", product["description"]),
            _evidence_id(request, "ingredient", "Ceramide Complex"),
            _evidence_id(request, "benefit", "supports hydration"),
        ],
        "confidence": 0.95,
        "omitReason": "",
    }
    plan["faq"] = [
        {
            "id": card["id"],
            "include": True,
            "question": "How should customers assess Ceramide Complex and hydration support in Barrier Serum?",
            "answer": "Barrier Serum includes Ceramide Complex. Barrier Serum lists hydration support as a benefit.",
            "intent": card["intent"],
            "cep": "",
            "evidenceIds": card["evidenceIds"],
            "confidence": 0.95,
            "omitReason": "",
        }
    ]
    plan["howTo"] = {
        **plan["howTo"],
        "eligible": True,
        "steps": [
            {
                "position": 1,
                "name": "",
                "text": "Use Barrier Serum during pregnancy.",
                "evidenceIds": [_evidence_id(request, "usage", product["usage"][0])],
            }
        ],
        "evidenceIds": [_evidence_id(request, "usage", product["usage"][0])],
    }

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["productDescription"]["text"] == product_description
    assert admitted["faq"] == []
    assert admitted["howTo"] == create_conservative_content_plan(request)["howTo"]
    assert any("FAQ[0]" in warning for warning in warnings)
    assert any("howTo" in warning for warning in warnings)


def test_admission_retains_safe_description_sentences_when_one_sentence_fails() -> None:
    """An unsafe clause must not erase independently supported natural model prose."""

    request = _source_complete_request()
    plan = _wire_plan(request)
    safe_text = (
        "Barrier Serum is a serum for dry skin. Barrier Serum includes Ceramide Complex. "
        "Barrier Serum lists hydration support as a benefit."
    )
    plan["productDescription"] = {
        "include": True,
        "text": f"{safe_text} Barrier Serum is recommended during pregnancy.",
        "intent": "product-entity-summary",
        "evidenceIds": [
            _evidence_id(request, "description", request["product"]["description"]),
            _evidence_id(request, "ingredient", "Ceramide Complex"),
            _evidence_id(request, "benefit", "supports hydration"),
        ],
        "confidence": 0.95,
        "omitReason": "",
    }

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["productDescription"]["include"] is True
    assert admitted["productDescription"]["text"] == safe_text
    assert any("removed unsupported claim sentence" in warning for warning in warnings)


def test_admission_keeps_positive_keyword_review_attribution_in_description_without_cardless_faq() -> None:
    """A review may enrich a description but cannot bypass relationship-card FAQ membership."""

    request = _source_complete_request(review_keywords=["lightweight finish"])
    card = next(
        item
        for item in build_faq_relationship_cards(request["product"], request["evidenceLedger"], "en-US")
        if item["intent"] == "formula-and-benefit"
    )
    request["faqRelationshipCards"] = [card]
    plan = _wire_plan(request)
    source_backed_text = (
        "Barrier Serum is a serum for dry skin. Barrier Serum includes Ceramide Complex. "
        "Barrier Serum lists hydration support as a benefit."
    )
    review_feedback = "Customers who reviewed Barrier Serum positively noted lightweight finish."
    identity_id = _evidence_id(request, "identity", "Barrier Serum")
    plan["productDescription"] = {
        "include": True,
        "text": f"{source_backed_text} {review_feedback}",
        "intent": "product-entity-summary",
        "evidenceIds": [
            identity_id,
            _evidence_id(request, "description", request["product"]["description"]),
            _evidence_id(request, "ingredient", "Ceramide Complex"),
            _evidence_id(request, "benefit", "supports hydration"),
            _evidence_id(request, "review", "lightweight finish"),
        ],
        "confidence": 0.95,
        "omitReason": "",
    }
    plan["faq"] = [
        {
            "id": card["id"],
            "include": True,
            "question": "What do reviews note about Barrier Serum?",
            "answer": review_feedback,
            "intent": card["intent"],
            "cep": "",
            "evidenceIds": [identity_id, _evidence_id(request, "review", "lightweight finish")],
            "confidence": 0.95,
            "omitReason": "",
        }
    ]

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["productDescription"]["include"] is True
    assert admitted["productDescription"]["text"] == f"{source_backed_text} {review_feedback}"
    assert admitted["faq"] == []
    assert admitted["admissionDiagnostics"]["fields"][-1]["predicate"] == "relationshipCardEvidence"


def test_admission_keeps_positive_aggregate_rating_attribution_in_description_without_cardless_faq() -> None:
    """A valid rating may enrich a description but cannot create an uncarded FAQ intent."""

    request = _source_complete_request(review_rating=4.8, review_count=120)
    card = next(
        item
        for item in build_faq_relationship_cards(request["product"], request["evidenceLedger"], "en-US")
        if item["intent"] == "formula-and-benefit"
    )
    request["faqRelationshipCards"] = [card]
    plan = _wire_plan(request)
    source_backed_text = (
        "Barrier Serum is a serum for dry skin. Barrier Serum includes Ceramide Complex. "
        "Barrier Serum lists hydration support as a benefit."
    )
    rating_feedback = "Barrier Serum received 4.8 out of 5 from 120 customer ratings."
    identity_id = _evidence_id(request, "identity", "Barrier Serum")
    summary_id = _evidence_id(request, "review", "rating=4.8; reviewCount=120")
    plan["productDescription"] = {
        "include": True,
        "text": f"{source_backed_text} {rating_feedback}",
        "intent": "product-entity-summary",
        "evidenceIds": [
            identity_id,
            _evidence_id(request, "description", request["product"]["description"]),
            _evidence_id(request, "ingredient", "Ceramide Complex"),
            _evidence_id(request, "benefit", "supports hydration"),
            summary_id,
        ],
        "confidence": 0.95,
        "omitReason": "",
    }
    plan["faq"] = [
        {
            "id": card["id"],
            "include": True,
            "question": "What rating do reviews give Barrier Serum?",
            "answer": rating_feedback,
            "intent": card["intent"],
            "cep": "",
            "evidenceIds": [identity_id, summary_id],
            "confidence": 0.95,
            "omitReason": "",
        }
    ]

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["productDescription"]["include"] is True
    assert admitted["productDescription"]["text"] == f"{source_backed_text} {rating_feedback}"
    assert admitted["faq"] == []
    assert admitted["admissionDiagnostics"]["fields"][-1]["predicate"] == "relationshipCardEvidence"


def test_admission_omits_negative_keyword_from_public_review_copy() -> None:
    """A negative keyword stays diagnostic even when a model tries to call it positive feedback."""

    request = _source_complete_request(review_keywords=["too sticky"])
    card = next(
        item
        for item in build_faq_relationship_cards(request["product"], request["evidenceLedger"], "en-US")
        if item["intent"] == "formula-and-benefit"
    )
    request["faqRelationshipCards"] = [card]
    plan = _wire_plan(request)
    source_backed_text = (
        "Barrier Serum is a serum for dry skin. Barrier Serum includes Ceramide Complex. "
        "Barrier Serum lists hydration support as a benefit."
    )
    unsupported_feedback = "Customers who reviewed Barrier Serum positively noted too sticky."
    identity_id = _evidence_id(request, "identity", "Barrier Serum")
    plan["productDescription"] = {
        "include": True,
        "text": f"{source_backed_text} {unsupported_feedback}",
        "intent": "product-entity-summary",
        "evidenceIds": [
            identity_id,
            _evidence_id(request, "description", request["product"]["description"]),
            _evidence_id(request, "ingredient", "Ceramide Complex"),
            _evidence_id(request, "benefit", "supports hydration"),
            _evidence_id(request, "review", "too sticky"),
        ],
        "confidence": 0.95,
        "omitReason": "",
    }
    plan["faq"] = [
        {
            "id": card["id"],
            "include": True,
            "question": "What do reviews note about Barrier Serum?",
            "answer": unsupported_feedback,
            "intent": card["intent"],
            "cep": "",
            "evidenceIds": [identity_id, _evidence_id(request, "review", "too sticky")],
            "confidence": 0.95,
            "omitReason": "",
        }
    ]

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["productDescription"]["include"] is True
    assert admitted["productDescription"]["text"] == source_backed_text
    assert admitted["faq"] == []


def test_admission_keeps_rich_product_and_page_descriptions_when_review_coverage_is_omitted() -> None:
    """Positive review evidence is optional coverage, not a rich-description quota."""

    request = _rich_review_optional_request()
    plan = _wire_plan(request)
    metric = "Barrier Serum improves hydration by 25% after 4 weeks in a clinical study of 30 participants."
    product_text = (
        "Barrier Serum is a serum designed for dry skin. Barrier Serum includes Ceramide Complex. "
        "Barrier Serum supports hydration. "
        f"{metric}"
    )
    webpage_text = (
        "The product page for Barrier Serum from Northstar Lab covers who it is for, formula details, "
        "stated benefits, and reported results. "
        f"{metric}"
    )
    evidence_ids = [
        _evidence_id(request, "identity", "Barrier Serum"),
        _evidence_id(request, "identity", "Northstar Lab"),
        _evidence_id(request, "description", request["product"]["description"]),
        _evidence_id(request, "audience", "dry skin"),
        _evidence_id(request, "ingredient", "Ceramide Complex"),
        _evidence_id(request, "benefit", "Barrier Serum supports hydration."),
        _evidence_id(request, "metric", metric),
    ]
    plan["productDescription"] = {
        "include": True,
        "text": product_text,
        "intent": "product-entity-summary",
        "evidenceIds": evidence_ids,
        "confidence": 0.95,
        "omitReason": "",
    }
    plan["webPageDescription"] = {
        "include": True,
        "text": webpage_text,
        "intent": "page-coverage-summary",
        "evidenceIds": evidence_ids,
        "confidence": 0.95,
        "omitReason": "",
    }

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["productDescription"]["include"] is True
    assert admitted["productDescription"]["text"] == product_text
    assert admitted["webPageDescription"]["include"] is True
    assert admitted["webPageDescription"]["text"] == webpage_text
    assert _evidence_id(request, "review", "lightweight finish") not in evidence_ids
    assert "lightweight finish" not in f"{product_text} {webpage_text}"
    assert admitted["admissionDiagnostics"]["fields"] == [
        {"field": "productDescription", "outcome": "accepted"},
        {"field": "webPageDescription", "outcome": "accepted"},
    ]


def test_admission_strips_fabricated_review_prose_despite_positive_review_evidence() -> None:
    """Attribution cannot turn a different customer claim into a source-backed review sentence."""

    request = _rich_review_optional_request()
    plan = _wire_plan(request)
    metric = "Barrier Serum improves hydration by 25% after 4 weeks in a clinical study of 30 participants."
    source_backed_text = (
        "Barrier Serum is a serum designed for dry skin. Barrier Serum includes Ceramide Complex. "
        "Barrier Serum supports hydration. "
        f"{metric}"
    )
    fabricated_review = "Customers who reviewed Barrier Serum positively mentioned a glass-skin finish."
    plan["productDescription"] = {
        "include": True,
        "text": f"{source_backed_text} {fabricated_review}",
        "intent": "product-entity-summary",
        "evidenceIds": [
            _evidence_id(request, "identity", "Barrier Serum"),
            _evidence_id(request, "description", request["product"]["description"]),
            _evidence_id(request, "audience", "dry skin"),
            _evidence_id(request, "ingredient", "Ceramide Complex"),
            _evidence_id(request, "benefit", "Barrier Serum supports hydration."),
            _evidence_id(request, "metric", metric),
            _evidence_id(request, "review", "lightweight finish"),
        ],
        "confidence": 0.95,
        "omitReason": "",
    }

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["productDescription"]["include"] is True
    assert admitted["productDescription"]["text"] == source_backed_text
    assert "glass-skin finish" not in admitted["productDescription"]["text"]
    assert any("removed unsupported claim sentence" in warning for warning in warnings)


def test_admission_rejects_a_rich_description_that_omits_an_available_formula_role() -> None:
    """A rich narrative cannot quietly drop a trustworthy source role it claims to cover."""

    request = _source_complete_request()
    plan = _wire_plan(request)
    incomplete = "Barrier Serum is a serum for dry skin. Barrier Serum lists hydration support as a benefit."
    plan["productDescription"] = {
        "include": True,
        "text": incomplete,
        "intent": "product-entity-summary",
        "evidenceIds": [
            _evidence_id(request, "description", request["product"]["description"]),
            _evidence_id(request, "benefit", "supports hydration"),
        ],
        "confidence": 0.95,
        "omitReason": "",
    }

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["productDescription"]["include"] is False
    assert any("source-role coverage" in warning for warning in warnings)


def test_admission_treats_formula_evidence_as_a_required_formula_role() -> None:
    """Formula is a source-role alias, not a loophole around completeness."""

    request = _source_complete_request()
    for evidence in request["evidenceLedger"]:
        if evidence["role"] == "ingredient":
            evidence["role"] = "formula"
    plan = _wire_plan(request)
    plan["productDescription"] = {
        "include": True,
        "text": "Barrier Serum is a serum for dry skin. Barrier Serum lists hydration support as a benefit.",
        "intent": "product-entity-summary",
        "evidenceIds": [
            _evidence_id(request, "description", request["product"]["description"]),
            _evidence_id(request, "benefit", "supports hydration"),
        ],
        "confidence": 0.95,
        "omitReason": "",
    }

    admitted, warnings = _admit_model_plan(plan, request)

    assert admitted is not None, warnings
    assert admitted["productDescription"]["include"] is False
    assert any("ingredient-or-formula" in warning for warning in warnings)


def test_admission_does_not_require_missing_roles_or_negative_review_copy() -> None:
    """Completeness uses only available positive/neutral roles; negative review text stays optional."""

    for review_keywords in ([], ["too sticky"]):
        request = _source_complete_request(review_keywords=review_keywords)
        plan = _wire_plan(request)
        complete_without_review = (
            "Barrier Serum is a serum for dry skin. Barrier Serum includes Ceramide Complex. "
            "Barrier Serum lists hydration support as a benefit."
        )
        plan["productDescription"] = {
            "include": True,
            "text": complete_without_review,
            "intent": "product-entity-summary",
            "evidenceIds": [
                _evidence_id(request, "description", request["product"]["description"]),
                _evidence_id(request, "ingredient", "Ceramide Complex"),
                _evidence_id(request, "benefit", "supports hydration"),
            ],
            "confidence": 0.95,
            "omitReason": "",
        }

        admitted, warnings = _admit_model_plan(plan, request)

        assert admitted is not None, warnings
        assert admitted["productDescription"]["include"] is True


def test_model_admission_keeps_review_optional_and_reports_a_field_local_source_fallback() -> None:
    """A reviewless model summary remains usable when another model field is rejected.

    A positive keyword is deliberately present without a review body: it may
    support attributed review prose when the model elects to write it, but it
    is not a completeness quota.  The test also distinguishes a completed
    model call, one field-level admission decision, and the renderer's
    deterministic fallback without making the whole artifact ineligible.
    """

    request = _source_complete_request(review_keywords=["lightweight finish"])
    plan = _wire_plan(request)
    source_backed_text = (
        "Barrier Serum is a serum for dry skin. Barrier Serum includes Ceramide Complex. "
        "Barrier Serum lists hydration support as a benefit."
    )
    plan["productDescription"] = {
        "include": True,
        "text": source_backed_text,
        "intent": "product-entity-summary",
        "evidenceIds": [
            _evidence_id(request, "description", request["product"]["description"]),
            _evidence_id(request, "ingredient", "Ceramide Complex"),
            _evidence_id(request, "benefit", "supports hydration"),
        ],
        "confidence": 0.95,
        "omitReason": "",
    }
    plan["webPageDescription"] = {
        "include": True,
        "text": "This product page provides a serum overview.",
        "intent": "page-coverage-summary",
        "evidenceIds": [_evidence_id(request, "description", request["product"]["description"])],
        "confidence": 0.95,
        "omitReason": "",
    }

    async def planner(_request: Mapping[str, Any]) -> dict[str, Any]:
        return {"plan": plan}

    completed = asyncio.run(plan_pdp_geo_content(request, {"customContentPlanner": planner}))
    admitted = cast(dict[str, Any], completed["plan"])
    decisions = cast(dict[str, Any], admitted["admissionDiagnostics"])
    web_page = next(item for item in decisions["fields"] if item["field"] == "webPageDescription")

    assert completed["called"] is True
    assert completed["applied"] is True
    assert admitted["productDescription"]["include"] is True
    assert admitted["productDescription"]["text"] == source_backed_text
    assert admitted["webPageDescription"]["include"] is False
    assert decisions["modelCall"] == {"called": True, "outcome": "admitted"}
    assert web_page == {
        "field": "webPageDescription",
        "outcome": "rejected",
        "reason": "evidenceOrLocaleValidationFailed",
        "predicate": "sourceSupport",
        "fallback": "deterministic-source-backed",
    }
    assert not any("positive-or-neutral-review" in warning for warning in completed["warnings"])

    artifact = generate_pdp_geo_artifacts(
        {"product": request["product"], "locale": "en-US", "contentPlan": admitted}
    )
    graph = cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])
    web_page_node = next(
        node
        for node in graph
        if "WebPage" in (node["@type"] if isinstance(node.get("@type"), list) else [node.get("@type")])
    )
    assert "Barrier Serum" in str(web_page_node.get("description"))


def test_faq_coverage_rejects_raw_inventory_rows_without_synthesizing_source_fallback() -> None:
    """A rejected source heading stays out of FAQPage and returns only recovery cards."""

    request, card = _faq_relationship_request()
    raw_question = "Which ingredients are listed for Dew Barrier Serum?"
    raw_answer = "Dew Barrier Serum lists Ceramide Matrix."
    completed = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": {
                "mode": "model",
                "faqRelationshipCards": [card],
                "faq": [
                    {
                        "id": card["id"],
                        "include": True,
                        "question": raw_question,
                        "answer": raw_answer,
                        "intent": card["intent"],
                        "cep": "",
                        "evidenceIds": card["evidenceIds"],
                        "confidence": 0.95,
                        "omitReason": "",
                    }
                ],
                "admissionDiagnostics": {
                    "fields": [
                        {
                            "field": "FAQ[0]",
                            "rowId": card["id"],
                            "outcome": "rejected",
                            "predicate": "customerDecisionQuestion",
                        }
                    ]
                },
            },
            "product": request["product"],
            "locale": "en-US",
            "evidenceLedger": request["evidenceLedger"],
        }
    )

    assert completed["faq"] == []
    assert completed["faqMembership"] == []
    assert completed["admissionDiagnostics"]["faqCoverage"] == [
        {
            "field": "FAQ[0]",
            "rowId": card["id"],
            "outcome": "rejected",
            "reason": "fieldLocalAdmission",
        }
    ]
    recovery = completed["faqRecovery"]
    assert recovery["required"] is True
    assert [item["id"] for item in recovery["relationshipCards"]] == [card["id"]]
    assert all("question" not in item and "answer" not in item for item in recovery["relationshipCards"])


def test_faq_coverage_rejects_unknown_evidence_without_raw_source_replenishment() -> None:
    """A stable card ID does not let an unbound model row become public copy."""

    request, card = _faq_relationship_request()
    completed = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": {
                "mode": "model",
                "faqRelationshipCards": [card],
                "faq": [
                    {
                        "id": card["id"],
                        "include": True,
                        "question": "What makes Northstar Lab's Dew Barrier Serum worth considering for dry skin?",
                        "answer": "Northstar Lab's Dew Barrier Serum is designed for dry skin.",
                        "intent": card["intent"],
                        "cep": "",
                        "evidenceIds": ["not-in-the-ledger"],
                        "confidence": 0.95,
                        "omitReason": "",
                    }
                ],
                "admissionDiagnostics": {
                    "fields": [{"field": "FAQ[0]", "rowId": card["id"], "outcome": "accepted"}]
                },
            },
            "product": request["product"],
            "locale": "en-US",
            "evidenceLedger": request["evidenceLedger"],
        }
    )

    assert completed["faq"] == []
    assert completed["faqMembership"] == []
    assert completed["admissionDiagnostics"]["faqCoverage"] == [
        {
            "field": "FAQ[0]",
            "rowId": card["id"],
            "outcome": "rejected",
            "reason": "incompleteModelRow",
        }
    ]
    assert completed["faqRecovery"]["required"] is True
    assert all("question" not in item and "answer" not in item for item in completed["faqRecovery"]["relationshipCards"])


def test_faq_coverage_caps_admitted_relationship_card_rows_at_three() -> None:
    """At most three separately model-authored card rows may become FAQ membership."""

    request, cards = _rich_faq_relationship_request()
    rows = [
        {
            "id": cards["buyer-decision"]["id"],
            "include": True,
            "question": "What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?",
            "answer": (
                "Northstar Lab's Dew Barrier Serum is designed for dry and sensitive skin. "
                "Ceramide Matrix supports hydration."
            ),
            "intent": cards["buyer-decision"]["intent"],
            "cep": "",
            "evidenceIds": cards["buyer-decision"]["evidenceIds"],
            "confidence": 0.95,
            "omitReason": "",
        },
        {
            "id": cards["formula-effect"]["id"],
            "include": True,
            "question": "How does the Ceramide Matrix in Northstar Lab's Dew Barrier Serum support hydration for customers?",
            "answer": "Northstar Lab's Dew Barrier Serum contains Ceramide Matrix, which supports hydration.",
            "intent": cards["formula-effect"]["intent"],
            "cep": "",
            "evidenceIds": cards["formula-effect"]["evidenceIds"],
            "confidence": 0.95,
            "omitReason": "",
        },
        {
            "id": cards["evidence-result"]["id"],
            "include": True,
            "question": "What should customers know about the four-week hydration result for Northstar Lab's Dew Barrier Serum?",
            "answer": (
                "In an instrumental test after four weeks, Northstar Lab's Dew Barrier Serum improved hydration by 25%."
            ),
            "intent": cards["evidence-result"]["intent"],
            "cep": "",
            "evidenceIds": cards["evidence-result"]["evidenceIds"],
            "confidence": 0.95,
            "omitReason": "",
        },
        {
            "id": cards["usage"]["id"],
            "include": True,
            "question": "How should customers use Northstar Lab's Dew Barrier Serum in a skincare routine?",
            "answer": (
                "Northstar Lab's Dew Barrier Serum is applied by dispensing two pumps and smoothing over the face and neck."
            ),
            "intent": cards["usage"]["intent"],
            "cep": "",
            "evidenceIds": cards["usage"]["evidenceIds"],
            "confidence": 0.95,
            "omitReason": "",
        },
    ]
    completed = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": {
                "mode": "model",
                "faqRelationshipCards": list(cards.values()),
                "faq": rows,
                "admissionDiagnostics": {
                    "fields": [
                        {"field": f"FAQ[{index}]", "rowId": row["id"], "outcome": "accepted"}
                        for index, row in enumerate(rows)
                    ]
                },
            },
            "product": request["product"],
            "locale": "en-US",
            "evidenceLedger": request["evidenceLedger"],
        }
    )

    assert [row["id"] for row in completed["faq"]] == [row["id"] for row in rows[:3]]
    assert [row["id"] for row in completed["faqMembership"]] == [row["id"] for row in rows[:3]]
    assert all(
        row["id"] in {card["id"] for card in cards.values()}
        for row in completed["faqMembership"]
    )


def test_faq_coverage_rejects_duplicate_relationship_card_membership() -> None:
    """Different model prose cannot occupy two FAQ slots through one stable card."""

    request, card = _faq_relationship_request()
    rows = [
        {
            "id": card["id"],
            "include": True,
            "question": "What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?",
            "answer": (
                "Northstar Lab's Dew Barrier Serum is designed for dry and sensitive skin. "
                "Ceramide Matrix supports hydration."
            ),
            "intent": card["intent"],
            "cep": "",
            "evidenceIds": card["evidenceIds"],
            "confidence": 0.95,
            "omitReason": "",
        },
        {
            "id": card["id"],
            "include": True,
            "question": "How can Northstar Lab's Dew Barrier Serum support hydration for customers?",
            "answer": (
                "Northstar Lab's Dew Barrier Serum includes Ceramide Matrix, which supports hydration."
            ),
            "intent": card["intent"],
            "cep": "",
            "evidenceIds": card["evidenceIds"],
            "confidence": 0.95,
            "omitReason": "",
        },
    ]
    completed = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": {
                "mode": "model",
                "faqRelationshipCards": [card],
                "faq": rows,
                "admissionDiagnostics": {
                    "fields": [
                        {"field": f"FAQ[{index}]", "rowId": card["id"], "outcome": "accepted"}
                        for index in range(len(rows))
                    ]
                },
            },
            "product": request["product"],
            "locale": "en-US",
            "evidenceLedger": request["evidenceLedger"],
        }
    )

    assert [row["id"] for row in completed["faq"]] == [card["id"]]
    assert completed["admissionDiagnostics"]["faqCoverage"][-1] == {
        "field": "FAQ[1]",
        "rowId": card["id"],
        "outcome": "rejected",
        "reason": "duplicateRelationshipCardId",
    }

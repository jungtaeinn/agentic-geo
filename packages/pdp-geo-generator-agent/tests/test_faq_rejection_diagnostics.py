"""Contracts for what a rejected FAQ row tells the people reading a run.

Admission is a conjunction, and for a long time it reported one predicate name
for nearly every way a row could fail: anything outside the four named
decision, identity, anchor, and reason branches came back as ``sourceSupport``,
the name of the answer-to-claim check alone.  Live runs therefore could not
tell an answer that outran its evidence from a question in the wrong language
or a CEP that named an unstated situation, and the refused sentences were gone
from the plan entirely.  These tests fix both: each term reports the function
it demands, and a rejected row keeps its own copy in diagnostics without that
copy ever reaching a published surface.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any, cast

import pytest

import pdp_geo_generator_agent.content_planning as content_planning
from pdp_geo_generator_agent.content_planning import (
    create_conservative_content_plan,
    create_pdp_geo_evidence_ledger,
)
from pdp_geo_generator_agent.faq_relationships import build_faq_relationship_cards
from pdp_geo_generator_agent.generation import ensure_pdp_geo_faq_plan_coverage, generate_pdp_geo_artifacts

_admit_model_plan = cast(
    Callable[[Mapping[str, Any], Mapping[str, Any]], tuple[dict[str, Any] | None, list[str]]],
    getattr(content_planning, "_admit_model_plan"),
)

_CONCERN = "A solution for dryness and tightness."
_AUDIENCE = "Works best for dry and sensitive skin."
_FORMULA = "Ceramide Matrix supports hydration."

_FORMULA_QUESTION = "For dry and sensitive skin seeking hydration, which serum can customers consider as part of their routine?"
_FORMULA_ANSWER = "Northstar Lab's Dew Barrier Serum contains Ceramide Matrix, which supports hydration."
_BUYER_QUESTION = "What makes Northstar Lab's Dew Barrier Serum worth considering for dry and sensitive skin?"
_BUYER_ANSWER = (
    "Northstar Lab's Dew Barrier Serum works best for dry and sensitive skin. Its Ceramide Matrix supports hydration."
)


def _product() -> dict[str, Any]:
    return {
        "name": "Dew Barrier Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "Dew Barrier Serum is a serum.",
        "ingredients": ["Ceramide Matrix"],
        "benefits": ["Supports hydration"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [_CONCERN, _AUDIENCE, _FORMULA],
        "semanticFacts": {
            "skinTypes": ["dry skin", "sensitive skin"],
            "evidenceSentences": [_CONCERN, _AUDIENCE],
            "ingredientBenefitLinks": [
                {"ingredient": "Ceramide Matrix", "benefit": "hydration", "sourceText": _FORMULA}
            ],
        },
    }


def _request(intents: tuple[str, ...]) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    product = _product()
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    cards = {
        card["intent"]: card
        for card in build_faq_relationship_cards(product, ledger, "en-US")
        if card["intent"] in intents
    }
    request = {
        "product": product,
        "locale": "en-US",
        "evidenceLedger": ledger,
        "faqRelationshipCards": [cards[intent] for intent in intents],
    }
    return request, cards


def _model_row(card: Mapping[str, Any], *, question: str, answer: str, cep: str) -> dict[str, Any]:
    """Represent model output; the test never asks Python to write this copy."""

    return {
        "id": card["id"],
        "include": True,
        "question": question,
        "answer": answer,
        "intent": card["intent"],
        "cep": cep,
        "evidenceIds": card["evidenceIds"],
        "confidence": 0.95,
        "omitReason": "",
    }


def _admit(request: Mapping[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    candidate = {
        key: value
        for key, value in create_conservative_content_plan(request).items()
        if key not in {"mode", "faqRelationshipCards"}
    }
    candidate["faq"] = rows
    admitted, warnings = _admit_model_plan(candidate, request)
    assert admitted is not None, warnings
    return admitted


@pytest.mark.parametrize(
    ("answer", "cep", "predicate"),
    [
        (_FORMULA_ANSWER, "hydration", ""),
        (_FORMULA_ANSWER[:-1] + " and calms redness.", "hydration", "sourceSupport"),
        (_FORMULA_ANSWER, "the ingredient list printed on the page", "cepSupport"),
        (_FORMULA_ANSWER, "for skin needing a 40% firmness gain", "cepSupport"),
        (
            "Northstar Lab's Dew Barrier Serum은 세라마이드 매트릭스를 담고 있어 수분 유지에 도움을 줍니다.",
            "hydration",
            "answerLocale",
        ),
    ],
    ids=[
        "admitted",
        "answer outran its evidence",
        "cep named the source instead of the reader",
        "cep concluded past its evidence",
        "answer left the locale",
    ],
)
def test_each_admission_term_reports_the_function_it_demands(answer: str, cep: str, predicate: str) -> None:
    """One label for a whole conjunction hides the gate that refused the row.

    Every rejection here used to be reported as ``sourceSupport``, so a live
    run could not tell an unsupported claim from a customer situation the row
    never stated or an answer written in another language.  ``sourceSupport``
    keeps naming the answer-to-claim check, and each other failure carries the
    name of the term it actually broke.

    ``cepSupport`` names what the entry point has to be, which is not what it
    used to demand.  The label is never published, so asking it to bind to a
    cited claim only asked it to reuse the evidence's own words -- a row died
    over the wording of a field no engine reads.  It now has to be the
    reader's situation in the locale being published (``post-procedure acne
    care`` is one, and was refused), and it still may not conclude past the
    record: a source field in place of a situation and a figure no record
    filed are the two ways it fails.
    """

    request, cards = _request(("formula-effect",))
    row = _model_row(cards["formula-effect"], question=_FORMULA_QUESTION, answer=answer, cep=cep)
    admitted = _admit(request, [row])

    decision = admitted["admissionDiagnostics"]["fields"][-1]
    assert decision["outcome"] == ("rejected" if predicate else "accepted")
    assert decision.get("predicate", "") == predicate


def test_a_rejected_faq_row_keeps_the_sentences_its_gate_refused() -> None:
    """A predicate with no sentence attached cannot be traced back to the copy.

    A rejected row never enters ``faq``, so its question, answer, and CEP are
    the one part of a run that cannot be recovered afterwards.  They ride in a
    FAQ-only diagnostics channel instead, and the shared field decisions stay
    copy-free because every public surface records into them.
    """

    request, cards = _request(("formula-effect",))
    rejected_answer = _FORMULA_ANSWER[:-1] + " and calms redness."
    admitted = _admit(
        request,
        [_model_row(cards["formula-effect"], question=_FORMULA_QUESTION, answer=rejected_answer, cep="hydration")],
    )

    diagnostics = admitted["admissionDiagnostics"]
    assert diagnostics["faqRejectedRows"] == [
        {
            "field": "FAQ[0]",
            "rowId": cards["formula-effect"]["id"],
            "predicate": "sourceSupport",
            "question": _FORMULA_QUESTION,
            "answer": rejected_answer,
            "cep": "hydration",
        }
    ]
    assert all(
        {"question", "answer", "cep"}.isdisjoint(field) for field in diagnostics["fields"]
    )


def test_an_admitted_plan_reports_no_rejected_rows() -> None:
    """The channel exists for rejections, so a clean plan does not carry it."""

    request, cards = _request(("formula-effect",))
    admitted = _admit(
        request,
        [_model_row(cards["formula-effect"], question=_FORMULA_QUESTION, answer=_FORMULA_ANSWER, cep="hydration")],
    )

    assert admitted["admissionDiagnostics"]["fields"][-1]["outcome"] == "accepted"
    assert "faqRejectedRows" not in admitted["admissionDiagnostics"]


def test_retained_rejection_copy_never_reaches_a_published_surface() -> None:
    """Diagnostics keep the refused sentences; the renderer publishes admitted rows.

    FAQPage is composed from the plan's admitted ``faq`` rows, so retaining a
    rejected row's copy for diagnosis must leave the artifact untouched.  The
    whole artifact is searched rather than just FAQPage, because a leak into
    any other node would be the same defect.
    """

    request, cards = _request(("buyer-decision", "formula-effect"))
    rejected_answer = _FORMULA_ANSWER[:-1] + " and calms redness."
    admitted = _admit(
        request,
        [
            _model_row(
                cards["buyer-decision"],
                question=_BUYER_QUESTION,
                answer=_BUYER_ANSWER,
                cep="dryness and tightness",
            ),
            _model_row(
                cards["formula-effect"], question=_FORMULA_QUESTION, answer=rejected_answer, cep="hydration"
            ),
        ],
    )
    finalized = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": {**admitted, "mode": "model", "_admittedContentPlan": True},
            "product": request["product"],
            "locale": "en-US",
            "evidenceLedger": request["evidenceLedger"],
        }
    )
    artifact = generate_pdp_geo_artifacts(
        {"product": request["product"], "locale": "en-US", "contentPlan": finalized}
    )

    assert [row["answer"] for row in finalized["faq"]] == [_BUYER_ANSWER]
    assert finalized["admissionDiagnostics"]["faqRejectedRows"][0]["answer"] == rejected_answer
    published = json.dumps(artifact, ensure_ascii=False)
    assert _BUYER_ANSWER in published
    assert rejected_answer not in published
    assert "calms redness" not in published

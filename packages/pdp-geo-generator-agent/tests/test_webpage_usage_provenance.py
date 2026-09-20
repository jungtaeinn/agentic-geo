"""Regression coverage for source-backed WebPage usage copy."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from pdp_geo_generator_agent.content_planning import create_conservative_content_plan, create_pdp_geo_evidence_ledger
from pdp_geo_generator_agent.final_proofreader import create_pdp_geo_public_copy_provenance
from pdp_geo_generator_agent.generation import generate_pdp_geo_artifacts
from pdp_geo_generator_agent.validation import validate_pdp_geo_artifacts


def _node(schema_markup: Mapping[str, Any], kind: str) -> dict[str, Any]:
    graph = cast(list[dict[str, Any]], cast(Mapping[str, Any], schema_markup["jsonLd"])["@graph"])
    return next(
        item for item in graph if kind in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]])
    )


def test_explicit_ritual_usage_keeps_a_bound_page_level_summary_without_copying_howto() -> None:
    """A page overview may cover usage without appending a raw procedure row."""

    source_steps = [
        "1. After serum, warm a pearl-sized amount between your palms.",
        "2. Press the cream gently over the face and neck.",
        (
            "Experience the age-old benefits of this rich cream ritual. "
            "Step 1: After serum, warm a pearl-sized amount between your palms. "
            "Step 2: Press the cream gently over the face and neck."
        ),
    ]
    product: dict[str, Any] = {
        "name": "Concentrated Botanical Renewing Cream Rich",
        "category": "cream",
        "description": "Concentrated Botanical Renewing Cream Rich is a cream.",
        "usage": source_steps,
        "semanticFacts": {"usageSteps": source_steps},
        "sourceTexts": ["Concentrated Botanical Renewing Cream Rich is a cream.", *source_steps],
        "benefits": [],
        "effects": [],
        "ingredients": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
    }
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    webpage_description = cast(str, _node(artifact["schemaMarkup"], "WebPage")["description"])
    how_to = _node(artifact["schemaMarkup"], "HowTo")
    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": artifact["schemaMarkup"], "evidenceLedger": ledger, "contentPlan": plan}
    )
    report = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": artifact["schemaMarkup"],
            "content": artifact["content"],
            "evidenceLedger": ledger,
            "publicCopyProvenance": provenance,
        }
    )

    assert [step["text"] for step in cast(list[dict[str, str]], how_to["step"])] == [
        "After serum, warm a pearl-sized amount between your palms.",
        "Press the cream gently over the face and neck.",
    ]
    assert "how to use" not in webpage_description.casefold()
    assert all(step["text"] not in webpage_description for step in cast(list[dict[str, str]], how_to["step"]))
    assert "Directions for" not in webpage_description
    webpage_provenance = next(item for item in provenance if item["fieldPath"] == "WebPage.description")
    assert webpage_provenance["text"] == webpage_description
    assert all(sentence["evidenceIds"] for sentence in webpage_provenance["sentences"])
    assert not any(
        finding["source"] == "public-copy-provenance" and finding["field"] == "WebPage.description"
        for finding in cast(list[dict[str, Any]], report["validationFindings"])
    )


def test_admitted_model_plan_cannot_copy_a_howto_step_into_webpage_description() -> None:
    """The final renderer keeps its field contract even after model admission."""

    usage = "After serum, apply a pea-sized amount evenly over the face and neck."
    product: dict[str, Any] = {
        "name": "Barrier Cream",
        "description": "Barrier Cream is a cream.",
        "usage": [usage],
        "semanticFacts": {"usageSteps": [usage]},
        "sourceTexts": ["Barrier Cream is a cream.", usage],
        "benefits": [],
        "effects": [],
        "ingredients": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
    }
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    conservative = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    plan = {
        **conservative,
        "mode": "model",
        "_admittedContentPlan": True,
        "webPageDescription": {
            "include": True,
            "text": usage,
            "intent": "page-coverage-summary",
            "evidenceIds": [item["id"] for item in ledger if item["role"] == "usage"],
            "confidence": 1,
            "omitReason": "",
        },
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    webpage_description = cast(str, _node(artifact["schemaMarkup"], "WebPage")["description"])

    assert usage not in webpage_description
    assert "how to use" not in webpage_description.casefold()

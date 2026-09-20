"""Contract tests for the optional public-copy model gates.

These use deterministic duck-typed providers so the tests exercise the
invariant gates without credentials or a network.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from copy import deepcopy
from typing import Any, cast
from unittest.mock import patch

import httpx

from pdp_geo_generator_agent.copy_refiner import (
    ModelBackedCopyRefiner,
    _is_source_supported,
    refine_pdp_geo_copy,
    resolve_copy_refiner,
)
from pdp_geo_generator_agent.final_proofreader import (
    create_pdp_geo_public_copy_provenance,
    final_proofread_pdp_geo_artifacts,
    stable_text_hash,
)
from pdp_geo_generator_agent.providers import AistudioProvider
from pdp_geo_generator_agent.quality_gate import collect_quality_gate_shortfalls
from pdp_geo_generator_agent.service import generate_pdp_geo
from pdp_geo_generator_agent.validation import apply_safe_public_copy_repairs, validate_pdp_geo_artifacts


def _input() -> dict[str, Any]:
    product_description = "Glow Serum is a serum for dry skin. Glow Serum is a serum for dry skin."
    faq_question = "Is Glow Serum suitable for dry skin?"
    faq_answer = "Glow Serum is intended for dry skin."
    graph = [
        {"@type": ["WebPage", "ItemPage"], "description": "This product page presents Glow Serum."},
        {
            "@type": "Product",
            "name": "Glow Serum",
            "description": product_description,
            "additionalProperty": [{"@type": "PropertyValue", "name": "Texture", "value": "lightweight.."}],
        },
        {
            "@type": "FAQPage",
            "mainEntity": [
                {"@type": "Question", "name": faq_question, "acceptedAnswer": {"@type": "Answer", "text": faq_answer}}
            ],
        },
        {"@type": "HowTo", "step": [{"@type": "HowToStep", "text": "Apply Glow Serum to clean skin."}]},
    ]
    return {
        "product": {
            "name": "Glow Serum",
            "description": product_description,
            "ingredients": ["Niacinamide"],
            "usage": ["Apply Glow Serum to clean skin."],
            "faq": [{"question": faq_question, "answer": faq_answer}],
        },
        "locale": "en-US",
        "schemaMarkup": {"jsonLd": {"@context": "https://schema.org", "@graph": graph}},
        "content": {
            "html": "",
            "sections": {
                "productName": "Glow Serum",
                "description": product_description,
                "quickFacts": "Texture: lightweight..",
                "benefits": "",
                "ingredients": "Niacinamide",
                "howToUse": "Apply Glow Serum to clean skin.",
                "faq": f"Q. {faq_question}\nA. {faq_answer}",
            },
        },
        "evidenceLedger": [
            {
                "id": "ev-description",
                "role": "description",
                "text": product_description,
                "sourcePath": "product.description",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
            {
                "id": "ev-faq",
                "role": "faq",
                "text": f"{faq_question}\n{faq_answer}",
                "sourcePath": "product.faq[0]",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
            {
                "id": "ev-usage",
                "role": "usage",
                "text": "Apply Glow Serum to clean skin.",
                "sourcePath": "product.usage[0]",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
        ],
    }


def _node(markup: Mapping[str, Any], kind: str) -> dict[str, Any]:
    json_ld = cast(Mapping[str, Any], markup["jsonLd"])
    graph = cast(list[dict[str, Any]], json_ld["@graph"])
    return next(item for item in graph if kind in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]]))


def test_safe_repair_mutates_nested_graph_text_and_reserializes() -> None:
    payload = _input()
    repaired = apply_safe_public_copy_repairs(payload)
    assert _node(repaired["schemaMarkup"], "Product")["additionalProperty"][0]["value"] == "lightweight."
    assert "lightweight.." not in repaired["schemaMarkup"]["scriptTag"]


def test_public_copy_provenance_matches_evidence_when_the_field_contains_an_evidence_phrase() -> None:
    payload = _input()
    payload["evidenceLedger"] = [
        {
            "id": "ev-contained",
            "role": "description",
            "text": "Glow Serum is a serum for dry skin.",
            "sourcePath": "product.description",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        }
    ]

    provenance = create_pdp_geo_public_copy_provenance(payload)

    product = next(item for item in provenance if item["fieldPath"] == "Product.description")
    assert product["evidenceIds"] == ["ev-contained"]


def test_public_copy_provenance_matches_faq_pair_identity_after_rendered_reordering() -> None:
    """Plan evidence follows a rendered FAQ pair, never the display index."""

    first_question = "Can Glow Serum support dry skin?"
    first_answer = "Glow Serum is intended for dry skin."
    second_question = "Does Glow Serum include Niacinamide?"
    second_answer = "Glow Serum includes Niacinamide."
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
                                "name": second_question,
                                "acceptedAnswer": {"@type": "Answer", "text": second_answer},
                            },
                            {
                                "@type": "Question",
                                "name": first_question,
                                "acceptedAnswer": {"@type": "Answer", "text": first_answer},
                            },
                        ],
                    }
                ],
            }
        },
        "contentPlan": {
            "mode": "model",
            "faq": [
                {"include": True, "question": first_question, "answer": first_answer, "evidenceIds": ["ev-first"]},
                {"include": True, "question": second_question, "answer": second_answer, "evidenceIds": ["ev-second"]},
            ],
        },
        "evidenceLedger": [
            {
                "id": "ev-first",
                "role": "faq",
                "text": f"{first_question}\n{first_answer}",
                "sourcePath": "product.faq[0]",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
            {
                "id": "ev-second",
                "role": "faq",
                "text": f"{second_question}\n{second_answer}",
                "sourcePath": "product.faq[1]",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
        ],
    }

    provenance = create_pdp_geo_public_copy_provenance(payload)
    by_path = {item["fieldPath"]: item for item in provenance}

    assert by_path["FAQPage.mainEntity[0].name"]["origin"] == "model-plan"
    assert by_path["FAQPage.mainEntity[0].name"]["evidenceIds"] == ["ev-second"]
    assert by_path["FAQPage.mainEntity[0].acceptedAnswer.text"]["evidenceIds"] == ["ev-second"]
    assert by_path["FAQPage.mainEntity[1].name"]["origin"] == "model-plan"
    assert by_path["FAQPage.mainEntity[1].name"]["evidenceIds"] == ["ev-first"]
    assert by_path["FAQPage.mainEntity[1].acceptedAnswer.text"]["evidenceIds"] == ["ev-first"]


def test_copy_refiner_preserves_stable_faq_membership_during_a_fluency_edit() -> None:
    """A model may improve copy but cannot replace the FAQ evidence membership."""

    first_question = "Can Glow Serum support dry skin?"
    first_answer = "Glow Serum is intended for dry skin."
    second_question = "Which formula component does Glow Serum feature?"
    second_answer = "Glow Serum features Niacinamide."
    payload = _input()
    faq = _node(payload["schemaMarkup"], "FAQPage")
    faq["mainEntity"] = [
        {"@type": "Question", "name": first_question, "acceptedAnswer": {"@type": "Answer", "text": first_answer}},
        {"@type": "Question", "name": second_question, "acceptedAnswer": {"@type": "Answer", "text": second_answer}},
    ]
    payload["content"]["sections"]["faq"] = (
        f"Q. {first_question}\nA. {first_answer}\n\nQ. {second_question}\nA. {second_answer}"
    )
    payload["product"].update(
        {
            "brand": "Example Lab",
            "benefits": ["Glow Serum supports dry skin."],
            "faq": [],
            "sourceTexts": [first_answer, second_answer],
        }
    )
    payload["evidenceLedger"].extend(
        [
            {
                "id": "ev-identity",
                "role": "identity",
                "text": "Glow Serum",
                "sourcePath": "product.name",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
            {
                "id": "ev-brand",
                "role": "identity",
                "text": "Example Lab",
                "sourcePath": "product.brand",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
            {
                "id": "ev-dry-skin",
                "role": "audience",
                "text": "Glow Serum is intended for dry skin.",
                "sourcePath": "product.description",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
            {
                "id": "ev-niacinamide",
                "role": "ingredient",
                "text": "Glow Serum features Niacinamide.",
                "sourcePath": "product.ingredients[0]",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
        ]
    )
    membership = [
        {
            "id": "faq-dry-skin",
            "intent": "buyer-decision",
            "evidenceIds": ["ev-identity", "ev-brand", "ev-dry-skin"],
        },
        {
            "id": "faq-formula",
            "intent": "formula-effect",
            "evidenceIds": ["ev-identity", "ev-brand", "ev-niacinamide"],
        },
    ]
    payload["faqMembership"] = membership

    requests: list[dict[str, object]] = []

    class Refiner:
        def refine_copy(self, request: dict[str, object]) -> dict[str, object]:
            requests.append(request)
            return {
                "faqAnswers": [
                    {
                        "id": "faq-dry-skin",
                        "question": "Which Glow Serum care option is relevant for dry skin?",
                        "answer": "Example Lab's Glow Serum is intended for dry skin.",
                    },
                    {
                        "id": "faq-formula",
                        "question": second_question,
                        "answer": "Example Lab's Glow Serum features Niacinamide.",
                    },
                ]
            }

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))

    assert requests[0]["faqMembership"] == membership
    rendered = _node(result["schemaMarkup"], "FAQPage")["mainEntity"]
    assert result["faqMembership"] == membership
    assert [item["name"] for item in rendered] == [
        "Which Glow Serum care option is relevant for dry skin?",
        second_question,
    ]
    assert rendered[0]["acceptedAnswer"]["text"] == "Example Lab's Glow Serum is intended for dry skin."
    assert rendered[1]["acceptedAnswer"]["text"] == "Example Lab's Glow Serum features Niacinamide."
    assert result["content"]["sections"]["faq"] == (
        "Q. Which Glow Serum care option is relevant for dry skin?\n"
        "A. Example Lab's Glow Serum is intended for dry skin.\n\n"
        f"Q. {second_question}\nA. Example Lab's Glow Serum features Niacinamide."
    )


def test_copy_refiner_rejects_reordered_immutable_faq_membership() -> None:
    """A response cannot repurpose membership IDs to move FAQ rows."""

    payload = _input()
    first = _node(payload["schemaMarkup"], "FAQPage")["mainEntity"][0]
    second_question = "How should Glow Serum be applied?"
    second_answer = "Apply Glow Serum to clean skin."
    _node(payload["schemaMarkup"], "FAQPage")["mainEntity"] = [
        first,
        {"@type": "Question", "name": second_question, "acceptedAnswer": {"@type": "Answer", "text": second_answer}},
    ]
    payload["content"]["sections"]["faq"] = (
        f"Q. {first['name']}\nA. {first['acceptedAnswer']['text']}\n\nQ. {second_question}\nA. {second_answer}"
    )
    membership = [
        {"id": "faq-dry-skin", "intent": "buyer-decision", "evidenceIds": ["ev-faq"]},
        {"id": "faq-usage", "intent": "usage", "evidenceIds": ["ev-usage"]},
    ]
    payload["faqMembership"] = membership

    class ReorderingRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "faqAnswers": [
                    {"id": "faq-usage", "question": second_question, "answer": second_answer},
                    {
                        "id": "faq-dry-skin",
                        "question": first["name"],
                        "answer": first["acceptedAnswer"]["text"],
                    },
                ]
            }

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": ReorderingRefiner()}))

    rendered = _node(result["schemaMarkup"], "FAQPage")["mainEntity"]
    assert [item["name"] for item in rendered] == [first["name"], second_question]
    assert result["faqMembership"] == membership
    assert any("complete immutable FAQ membership" in warning for warning in result["warnings"])


def test_copy_refiner_rejects_unsupported_analysis_label_then_uses_one_corrective_pass() -> None:
    payload = _input()
    calls: list[dict[str, Any]] = []

    class Refiner:
        def refine_copy(self, request: dict[str, Any]) -> dict[str, Any]:
            calls.append(request)
            return (
                {"schemaDescriptions": {"product": "Evaluation metric: Glow Serum is proven to cure acne."}}
                if len(calls) == 1
                else {"schemaDescriptions": {"product": "Glow Serum is a serum for dry skin."}}
            )

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))
    assert len(calls) == 2
    assert _node(result["schemaMarkup"], "Product")["description"] == "Glow Serum is a serum for dry skin."
    assert result["called"] is True
    assert result["applied"] is True


def test_copy_refiner_uses_reduced_retry_payload_and_merges_canonical_token_usage() -> None:
    payload = _input()
    payload["hydratedRagDocuments"] = [{"name": "large.md", "content": "x" * 1000}]
    calls: list[dict[str, Any]] = []

    class Refiner:
        def refine_copy(self, request: dict[str, Any]) -> dict[str, Any]:
            calls.append(request)
            if len(calls) == 1:
                return {
                    "schemaDescriptions": {"product": "Evaluation metric: Glow Serum cures acne."},
                    "usage": {"inputTokens": 3, "outputTokens": 5, "totalTokens": 8},
                }
            return {
                "schemaDescriptions": {"product": "Glow Serum is a serum for dry skin."},
                "usage": {"inputTokens": 7, "outputTokens": 11, "totalTokens": 18},
            }

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))

    assert len(calls) == 2
    assert "hydratedRagDocuments" not in calls[1]
    assert result["usage"] == {"inputTokens": 10, "outputTokens": 16, "totalTokens": 26}


def test_copy_refiner_retries_when_unedited_adopted_copy_still_exposes_an_analysis_label() -> None:
    payload = _input()
    unsafe = "Glow Serum is a serum for dry skin. Evaluation metric: Glow Serum is a serum for dry skin."
    product = _node(payload["schemaMarkup"], "Product")
    product["description"] = unsafe
    payload["content"]["sections"]["description"] = unsafe
    payload["product"]["description"] = unsafe
    calls: list[dict[str, Any]] = []

    class Refiner:
        def refine_copy(self, request: dict[str, Any]) -> dict[str, Any]:
            calls.append(request)
            return (
                {}
                if len(calls) == 1
                else {"schemaDescriptions": {"product": "Glow Serum is a serum for dry skin."}}
            )

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))

    assert len(calls) == 2
    assert any(item["field"] == "Product.description" for item in calls[1]["refinementFeedback"])
    assert _node(result["schemaMarkup"], "Product")["description"] == "Glow Serum is a serum for dry skin."


def test_copy_refiner_records_rag_strategy_policy_and_reported_policy_violation() -> None:
    payload = _input()
    payload["ragChunks"] = [
        {"kind": "geo-research", "source": "GEO Research Paper"},
        {"kind": "cep", "title": "Customer Entry Point Guide"},
    ]
    payload["policyRules"] = [
        {"id": "critical-source", "severity": "critical"},
        {"id": "copy-tone", "severity": "warning"},
    ]

    class Refiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "ruleCompliance": {"violatedRuleIds": ["critical-source"], "notes": ["needs a citation"]},
                "warnings": ["provider note"],
            }

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))

    evidence = result["evidence"]
    assert any(item["field"] == "copy.refinement.strategy" for item in evidence)
    assert any(item["field"] == "copy.refinement.policy" for item in evidence)
    assert any("critical-source" in warning for warning in result["warnings"])
    assert any(item["field"] == "copy.refinement.warning" for item in evidence)


def test_copy_refiner_does_not_mutate_non_refinable_schema_property() -> None:
    payload = _input()

    class Refiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {"schemaProperties": {"Texture": "lightweight."}}

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))

    properties = _node(result["schemaMarkup"], "Product")["additionalProperty"]
    assert properties[0]["value"] == "lightweight.."


def test_copy_refiner_noop_preserves_existing_schema_and_html_artifacts() -> None:
    payload = _input()
    payload["schemaMarkup"]["scriptTag"] = '<script type="application/ld+json">{"preserve":true}</script>'
    payload["content"]["html"] = "<article>preserve this rendered artifact</article>"

    class Refiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {}

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))

    assert result["schemaMarkup"] == payload["schemaMarkup"]
    assert result["content"] == payload["content"]


def test_copy_refiner_retries_a_rejected_recognized_schema_property() -> None:
    payload = _input()
    properties = _node(payload["schemaMarkup"], "Product")["additionalProperty"]
    properties.append({"@type": "PropertyValue", "name": "Usage", "value": "Apply Glow Serum to clean skin."})
    calls: list[dict[str, Any]] = []

    class Refiner:
        def refine_copy(self, request: dict[str, Any]) -> dict[str, Any]:
            calls.append(request)
            return (
                {"schemaProperties": {"Usage": "Glow Serum contains Niacinamide."}}
                if len(calls) == 1
                else {"schemaProperties": {"Usage": "Apply Glow Serum to clean skin."}}
            )

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))

    assert len(calls) == 2
    assert any(item["field"] == "Product.additionalProperty.Usage" for item in calls[1]["refinementFeedback"])
    refined = _node(result["schemaMarkup"], "Product")["additionalProperty"]
    assert next(item["value"] for item in refined if item["name"] == "Usage") == "Apply Glow Serum to clean skin."


def test_copy_refiner_rejects_an_unsupported_ingredient_benefit_property_rewrite() -> None:
    """Separate formula and benefit facts cannot become an ingredient-effect claim."""

    payload = _input()
    payload["product"].update(
        {
            "ingredients": ["Ceramide"],
            "benefits": ["supports hydration"],
            "description": "Glow Serum includes Ceramide. Glow Serum supports hydration.",
        }
    )
    properties = _node(payload["schemaMarkup"], "Product")["additionalProperty"]
    before = "Ceramide is included in the formula, while product information identifies hydration support."
    properties.append({"@type": "PropertyValue", "name": "Key ingredients and technologies", "value": before})

    class Refiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {"schemaProperties": {"Key ingredients and technologies": "Ceramide supports hydration."}}

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))

    refined = _node(result["schemaMarkup"], "Product")["additionalProperty"]
    assert next(item["value"] for item in refined if item["name"] == "Key ingredients and technologies") == before
    assert any("ingredient-benefit" in warning for warning in result["warnings"])


def test_copy_refiner_rejects_an_unsupported_routine_context_property_rewrite() -> None:
    """A source action does not establish a routine context unless the source says so."""

    payload = _input()
    payload["product"]["description"] = "Glow Serum has a makeup-friendly texture."
    properties = _node(payload["schemaMarkup"], "Product")["additionalProperty"]
    before = "Apply Glow Serum to clean skin."
    properties.append({"@type": "PropertyValue", "name": "Usage", "value": before})

    class Refiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {"schemaProperties": {"Usage": "Apply Glow Serum before makeup."}}

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))

    refined = _node(result["schemaMarkup"], "Product")["additionalProperty"]
    assert next(item["value"] for item in refined if item["name"] == "Usage") == before
    assert any("unsupported routine, timing" in warning for warning in result["warnings"])


def test_copy_refiner_rejects_a_question_only_faq_refinement_as_an_atomic_pair() -> None:
    payload = _input()
    original = "Is Glow Serum suitable for dry skin?"

    class Refiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "faqAnswers": [
                    {
                        "sourceQuestion": original,
                        "question": "Is Glow Serum for dry skin?",
                    }
                ]
            }

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))

    faq = _node(result["schemaMarkup"], "FAQPage")["mainEntity"]
    assert faq[0]["name"] == original
    assert original in result["content"]["sections"]["faq"]
    assert result["applied"] is False
    assert any("question and answer together" in warning for warning in result["warnings"])


def test_copy_refiner_rejects_product_page_language_and_concrete_usage_in_product_copy() -> None:
    payload = _input()
    original = _node(payload["schemaMarkup"], "Product")["description"]

    class Refiner:
        def __init__(self, candidate: str) -> None:
            self.candidate = candidate

        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {"schemaDescriptions": {"product": self.candidate}}

    page_result = asyncio.run(
        refine_pdp_geo_copy(
            payload,
            {"customCopyRefiner": Refiner("This Glow Serum product page presents Glow Serum for dry skin.")},
        )
    )
    usage_result = asyncio.run(
        refine_pdp_geo_copy(
            payload,
            {
                "customCopyRefiner": Refiner(
                    "Glow Serum is a serum for dry skin. Apply Glow Serum to clean skin."
                )
            },
        )
    )

    assert _node(page_result["schemaMarkup"], "Product")["description"] == original
    assert _node(usage_result["schemaMarkup"], "Product")["description"] == original
    assert any("product page" in warning for warning in page_result["warnings"])
    assert any("usage" in warning for warning in usage_result["warnings"])


def test_copy_refiner_rejects_concrete_usage_in_webpage_copy() -> None:
    """WebPage can cover usage at a high level but must not copy a HowTo action."""

    payload = _input()
    original = _node(payload["schemaMarkup"], "WebPage")["description"]

    class Refiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "schemaDescriptions": {
                    "webPage": "This product page presents Glow Serum. Apply Glow Serum to clean skin."
                }
            }

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))

    assert _node(result["schemaMarkup"], "WebPage")["description"] == original
    assert any("usage directions" in warning for warning in result["warnings"])


def test_copy_refiner_rejects_webpage_product_clone_and_unsupported_ingredient_causality() -> None:
    payload = _input()
    product_description = _node(payload["schemaMarkup"], "Product")["description"]
    original_webpage = _node(payload["schemaMarkup"], "WebPage")["description"]

    class CloneRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {"schemaDescriptions": {"webPage": product_description}}

    clone_result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": CloneRefiner()}))
    assert _node(clone_result["schemaMarkup"], "WebPage")["description"] == original_webpage
    assert any("repeats Product.description" in warning for warning in clone_result["warnings"])

    payload["product"]["benefits"] = ["Glow Serum helps soothe dry skin."]

    class CausalityRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "schemaDescriptions": {
                    "product": "Glow Serum contains Niacinamide. Niacinamide helps soothe dry skin."
                }
            }

    causality_result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": CausalityRefiner()}))
    assert _node(causality_result["schemaMarkup"], "Product")["description"] == product_description
    assert any("ingredient-benefit" in warning for warning in causality_result["warnings"])


def test_copy_refiner_rejects_misplaced_webpage_volume_but_accepts_option_offer_context() -> None:
    payload = _input()
    original = _node(payload["schemaMarkup"], "WebPage")["description"]
    unsafe = "This product page offers Glow Serum in 30 mL."
    payload["product"]["sourceTexts"] = [unsafe]

    class UnsafeRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {"schemaDescriptions": {"webPage": unsafe}}

    rejected = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": UnsafeRefiner()}))
    assert _node(rejected["schemaMarkup"], "WebPage")["description"] == original
    assert any("raw volume" in warning for warning in rejected["warnings"])

    allowed = "This product page offers a 30 mL size option available for purchase."
    payload["product"]["sourceTexts"] = [allowed]

    class AllowedRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {"schemaDescriptions": {"webPage": allowed}}

    accepted = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": AllowedRefiner()}))
    assert _node(accepted["schemaMarkup"], "WebPage")["description"] == allowed


def test_model_backed_copy_refiner_sends_field_separated_evidence_and_rag_policy_context() -> None:
    payload = _input()
    payload.update(
        {
            "market": "US",
            "ragChunks": [
                {"kind": "geo-research", "source": "GEO research", "text": "Answer-ready copy guidance."},
                {"kind": "cep", "source": "CEP guide", "text": "Customer context guidance."},
            ],
            "policyRules": [{"id": "critical-source", "severity": "critical", "text": "Preserve evidence."}],
            "refinementFeedback": [{"field": "Product.description", "reason": "analysis label"}],
        }
    )
    captured: dict[str, Any] = {}

    class Provider:
        async def generate_json(self, **kwargs: Any) -> dict[str, Any]:
            captured.update(kwargs)
            return {}

    with patch("pdp_geo_generator_agent.providers.create_provider", return_value=Provider()):
        asyncio.run(ModelBackedCopyRefiner({"provider": "openai", "apiKey": "test", "model": "test"}).refine_copy(payload))

    request = cast(dict[str, Any], json.loads(cast(str, captured["user"])))
    assert "currentCopy" in request
    assert "productEvidence" in request
    assert "fieldSeparatedEvidence" in request
    assert "strategicExposureGuidance" in request
    assert "policyChecklist" in request
    assert request["refinementFeedback"] == payload["refinementFeedback"]
    assert "productEvidence" in captured["system"]


def test_model_backed_copy_refiner_uses_prompt_json_without_aistudio_response_format() -> None:
    """Copy refinement matches TS: prompt JSON plus deterministic post-parse gates."""

    payload = _input()
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": '{"schemaDescriptions":{"product":"Glow Serum is a serum for dry skin."}}'
                        }
                    }
                ]
            },
        )

    provider = AistudioProvider(
        api_key="test-key",
        endpoint="https://studio.example/agent",
        deployment="reasoning",
        transport=httpx.MockTransport(handler),
    )
    with patch("pdp_geo_generator_agent.providers.create_provider", return_value=provider):
        result = asyncio.run(ModelBackedCopyRefiner({"provider": "aistudio"}).refine_copy(payload))

    body = seen["body"]
    prompt_payload = json.loads(body["messages"][1]["content"])
    assert "response_format" not in body
    assert "Return strict JSON only" in body["messages"][0]["content"]
    assert prompt_payload["currentCopy"]["schemaDescriptions"]["product"] == payload["product"]["description"]
    assert prompt_payload["productEvidence"]["name"] == "Glow Serum"
    assert result["schemaDescriptions"] == {"product": "Glow Serum is a serum for dry skin."}


def test_copy_refiner_preserves_product_role_order_and_rejects_unsourced_context_associations() -> None:
    payload = _input()
    approved = "Glow Serum is a serum. It is for dry skin. It contains Niacinamide. It helps calm redness."
    _node(payload["schemaMarkup"], "Product")["description"] = approved
    payload["content"]["sections"]["description"] = approved
    payload["product"].update(
        {
            "description": approved,
            "benefits": ["Glow Serum helps calm redness."],
            "semanticFacts": {"skinTypes": ["dry skin"]},
        }
    )

    class ReorderedRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "schemaDescriptions": {
                    "product": "Glow Serum is a serum. It helps calm redness. It contains Niacinamide. It is for dry skin."
                }
            }

    reordered = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": ReorderedRefiner()}))
    assert _node(reordered["schemaMarkup"], "Product")["description"] == approved
    assert any("approved" in warning and "role" in warning for warning in reordered["warnings"])

    class WinterRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "schemaDescriptions": {
                    "product": "Glow Serum is a serum for dry skin in winter. It contains Niacinamide. It helps calm redness."
                }
            }

    winter = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": WinterRefiner()}))
    assert _node(winter["schemaMarkup"], "Product")["description"] == approved
    assert any("context association" in warning for warning in winter["warnings"])

    supported_text = "Glow Serum is a serum for dry skin in winter. It contains Niacinamide. It helps calm redness."
    payload["product"]["sourceTexts"] = [supported_text]
    supported = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": WinterRefiner()}))
    assert _node(supported["schemaMarkup"], "Product")["description"] == supported_text


def test_copy_refiner_rejects_shallow_faq_answer_that_drops_source_backed_roles() -> None:
    """A concise rewrite may not discard the matched FAQ's supported answer roles."""

    payload = _input()
    question = "Is Glow Serum suitable for dry skin?"
    source_answer = "Glow Serum is for dry skin. It contains Niacinamide. It helps calm redness."
    faq = _node(payload["schemaMarkup"], "FAQPage")["mainEntity"][0]
    faq["name"] = question
    faq["acceptedAnswer"]["text"] = source_answer
    payload["product"].update(
        {
            "benefits": ["Glow Serum helps calm redness."],
            "semanticFacts": {"skinTypes": ["dry skin"]},
            "faq": [{"question": question, "answer": source_answer}],
        }
    )
    payload["content"]["sections"]["faq"] = f"Q. {question}\nA. {source_answer}"

    class ShallowRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "faqAnswers": [
                    {
                        "sourceQuestion": question,
                        "question": question,
                        "answer": "Glow Serum is for dry skin.",
                    }
                ]
            }

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": ShallowRefiner()}))

    assert _node(result["schemaMarkup"], "FAQPage")["mainEntity"][0]["acceptedAnswer"]["text"] == source_answer
    assert any("source-backed ingredient/formula" in warning for warning in result["warnings"])


def test_copy_refiner_rejects_faq_answer_that_abandons_the_matched_question_topic() -> None:
    payload = _input()
    question = "What finish does Glow Serum have?"
    source_answer = "Glow Serum leaves a lightweight finish."
    faq = _node(payload["schemaMarkup"], "FAQPage")["mainEntity"][0]
    faq["name"] = question
    faq["acceptedAnswer"]["text"] = source_answer
    payload["product"].update(
        {
            "faq": [{"question": question, "answer": source_answer}],
            "sourceTexts": [source_answer],
        }
    )
    payload["content"]["sections"]["faq"] = f"Q. {question}\nA. {source_answer}"

    class TopicChangingRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "faqAnswers": [
                    {
                        "sourceQuestion": question,
                        "question": question,
                        "answer": "Glow Serum is suitable for dry skin.",
                    }
                ]
            }

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": TopicChangingRefiner()}))

    assert _node(result["schemaMarkup"], "FAQPage")["mainEntity"][0]["acceptedAnswer"]["text"] == source_answer
    assert any("no longer covers the topic" in warning for warning in result["warnings"])


def test_copy_refiner_rejects_faq_answer_that_changes_an_ingredient_benefit_relation() -> None:
    """A separately supported finished-product result cannot be assigned to an ingredient."""

    payload = _input()
    question = "What does Niacinamide do in Glow Serum?"
    source_answer = "Glow Serum contains Niacinamide. Niacinamide helps hydrate dry skin."
    changed_answer = "Glow Serum contains Niacinamide. Niacinamide helps calm redness."
    faq = _node(payload["schemaMarkup"], "FAQPage")["mainEntity"][0]
    faq["name"] = question
    faq["acceptedAnswer"]["text"] = source_answer
    payload["product"].update(
        {
            "benefits": ["Glow Serum helps calm redness."],
            "faq": [{"question": question, "answer": source_answer}],
            "semanticFacts": {
                "ingredientBenefitLinks": [
                    {
                        "ingredient": "Niacinamide",
                        "benefit": "hydrates dry skin",
                        "sentence": "Niacinamide helps hydrate dry skin.",
                    }
                ]
            },
        }
    )
    payload["content"]["sections"]["faq"] = f"Q. {question}\nA. {source_answer}"

    class ChangedRelationRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "faqAnswers": [
                    {"sourceQuestion": question, "question": question, "answer": changed_answer}
                ]
            }

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": ChangedRelationRefiner()}))

    assert _node(result["schemaMarkup"], "FAQPage")["mainEntity"][0]["acceptedAnswer"]["text"] == source_answer
    assert any("ingredient-to-benefit relation" in warning for warning in result["warnings"])


def test_copy_refiner_rejects_faq_recommendation_created_from_adjacent_source_facts() -> None:
    """An audience atom and an ingredient link cannot become a recommendation."""

    payload = _input()
    question = "Is Calm Formula suitable for sensitive skin?"
    source_answer = "Calm Formula is for sensitive skin. Ceramide NP supports barrier recovery."
    invented_recommendation = (
        "Example Brand recommends Calm Formula treatment for sensitive skin because Ceramide NP supports barrier recovery."
    )
    faq = _node(payload["schemaMarkup"], "FAQPage")["mainEntity"][0]
    faq["name"] = question
    faq["acceptedAnswer"]["text"] = source_answer
    product_node = _node(payload["schemaMarkup"], "Product")
    product_node["name"] = "Calm Formula"
    product_node["description"] = "Calm Formula is for sensitive skin."
    payload["product"].update(
        {
            "name": "Calm Formula",
            "brand": "Example Brand",
            "description": "Calm Formula is for sensitive skin.",
            "ingredients": ["Ceramide NP"],
            "faq": [{"question": question, "answer": source_answer}],
            "sourceTexts": ["Calm Formula is for sensitive skin.", "Ceramide NP supports barrier recovery."],
            "semanticFacts": {
                "skinTypes": ["sensitive skin"],
                "ingredientBenefitLinks": [
                    {
                        "ingredient": "Ceramide NP",
                        "benefit": "barrier recovery",
                        "sourceText": "Ceramide NP supports barrier recovery.",
                    }
                ],
            },
        }
    )
    payload["content"]["sections"]["faq"] = f"Q. {question}\nA. {source_answer}"

    class RecommendationRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "faqAnswers": [
                    {"sourceQuestion": question, "question": question, "answer": invented_recommendation}
                ]
            }

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": RecommendationRefiner()}))

    assert _node(result["schemaMarkup"], "FAQPage")["mainEntity"][0]["acceptedAnswer"]["text"] == source_answer
    assert any("factual tokens were not supported" in warning for warning in result["warnings"])


def test_copy_refiner_keeps_a_source_backed_product_review_attributed_and_last() -> None:
    payload = _input()
    source_description = (
        "Glow Serum is a serum for dry skin. It contains Niacinamide. It helps calm redness. "
        "Customer reviews mention a lightweight finish."
    )
    reordered_description = (
        "Glow Serum is a serum for dry skin. It contains Niacinamide. It helps calm redness. "
        "Customer reviews mention a lightweight finish. Glow Serum is a serum."
    )
    _node(payload["schemaMarkup"], "Product")["description"] = source_description
    payload["content"]["sections"]["description"] = source_description
    payload["product"].update(
        {
            "description": source_description,
            "benefits": ["Glow Serum helps calm redness."],
            "reviews": {"keywords": ["lightweight finish"]},
            "semanticFacts": {"skinTypes": ["dry skin"]},
        }
    )

    class ReorderedReviewRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {"schemaDescriptions": {"product": reordered_description}}

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": ReorderedReviewRefiner()}))

    assert _node(result["schemaMarkup"], "Product")["description"] == source_description
    assert any("customer-review summary is not the final" in warning for warning in result["warnings"])


def test_copy_refiner_keeps_a_source_backed_product_review_attributed() -> None:
    payload = _input()
    source_description = (
        "Glow Serum is a serum for dry skin. It contains Niacinamide. It helps calm redness. "
        "Customer reviews mention a lightweight finish."
    )
    unattributed_description = (
        "Glow Serum is a serum for dry skin. It contains Niacinamide. It helps calm redness. "
        "Its lightweight finish is notable."
    )
    _node(payload["schemaMarkup"], "Product")["description"] = source_description
    payload["content"]["sections"]["description"] = source_description
    payload["product"].update(
        {
            "description": source_description,
            "benefits": ["Glow Serum helps calm redness."],
            "reviews": {"keywords": ["lightweight finish"]},
            "semanticFacts": {"skinTypes": ["dry skin"]},
            "sourceTexts": [unattributed_description],
        }
    )

    class UnattributedReviewRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {"schemaDescriptions": {"product": unattributed_description}}

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": UnattributedReviewRefiner()}))

    assert _node(result["schemaMarkup"], "Product")["description"] == source_description
    assert any("attributed review role" in warning for warning in result["warnings"])


def test_copy_refiner_preserves_webpage_viewpoint_without_requiring_canned_wording() -> None:
    payload = _input()
    page_description = "On this page, Glow Serum details and FAQ guidance are available."
    product = _node(payload["schemaMarkup"], "Product")
    webpage = _node(payload["schemaMarkup"], "WebPage")
    webpage["description"] = page_description
    payload["product"]["sourceTexts"] = [
        page_description,
        "Glow Serum contains Niacinamide for dry skin.",
        "Glow Serum details, FAQs, and use guidance are available on this page.",
    ]
    product["description"] = "Glow Serum is a serum for dry skin."
    payload["product"]["description"] = product["description"]

    class ProductOnlyRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {"schemaDescriptions": {"webPage": "Glow Serum contains Niacinamide for dry skin."}}

    rejected = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": ProductOnlyRefiner()}))
    assert _node(rejected["schemaMarkup"], "WebPage")["description"] == page_description
    assert any("page-level" in warning for warning in rejected["warnings"])

    class NaturalPageRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "schemaDescriptions": {
                    "webPage": "Glow Serum details, FAQs, and use guidance are available on this page."
                }
            }

    accepted = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": NaturalPageRefiner()}))
    assert _node(accepted["schemaMarkup"], "WebPage")["description"] == (
        "Glow Serum details, FAQs, and use guidance are available on this page."
    )


def test_copy_refiner_provider_settings_inherit_top_level_credentials_only_for_the_same_provider() -> None:
    inherited, inherited_warning = resolve_copy_refiner(
        {
            "provider": "openai",
            "apiKey": "top-level-key",
            "model": "top-level-model",
            "copyRefinement": {"enabled": True},
        }
    )
    assert inherited_warning is None
    assert isinstance(inherited, ModelBackedCopyRefiner)
    assert inherited.config["apiKey"] == "top-level-key"
    assert inherited.config["model"] == "top-level-model"

    isolated, isolated_warning = resolve_copy_refiner(
        {
            "provider": "openai",
            "apiKey": "top-level-key",
            "model": "top-level-model",
            "copyRefinement": {"enabled": True, "provider": "gemini"},
        }
    )
    assert isolated_warning is None
    assert isinstance(isolated, ModelBackedCopyRefiner)
    assert isolated.config["apiKey"] is None
    assert isolated.config["model"] is None

    disabled, disabled_warning = resolve_copy_refiner(
        {"provider": "openai", "apiKey": "top-level-key", "copyRefinement": {"provider": "gemini"}}
    )
    assert disabled is None
    assert disabled_warning is None


def test_copy_refiner_keeps_schema_and_visible_description_candidates_independent() -> None:
    payload = _input()
    payload["content"]["sections"]["description"] = "Glow Serum is a serum for dry skin."

    class Refiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "schemaDescriptions": {"product": "Glow Serum is a serum for dry skin."},
                "contentSections": {"description": "Glow Serum is a serum for dry skin. Glow Serum is a serum for dry skin."},
            }

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))

    assert _node(result["schemaMarkup"], "Product")["description"] == "Glow Serum is a serum for dry skin."
    assert result["content"]["sections"]["description"] == "Glow Serum is a serum for dry skin. Glow Serum is a serum for dry skin."


def test_final_proofreader_requires_hashes_and_immutable_tokens_but_accepts_duplicate_cleanup() -> None:
    payload = _input()
    provenance = create_pdp_geo_public_copy_provenance(payload)
    payload["publicCopyProvenance"] = provenance

    class Proofreader:
        def proofread(self, request: dict[str, Any]) -> dict[str, Any]:
            edits: list[dict[str, Any]] = []
            for field in request["fields"]:
                candidate = field["text"]
                action = "keep"
                issues: list[str] = []
                if field["fieldPath"] == "Product.description":
                    candidate = "Glow Serum is a serum for dry skin."
                    action = "revise"
                    issues = ["duplicate-sentence"]
                edits.append(
                    {
                        "fieldPath": field["fieldPath"],
                        "sourceHash": field["sourceHash"],
                        "action": action,
                        "revisedText": candidate,
                        "issueCodes": issues,
                    }
                )
            return {"edits": edits, "warnings": []}

    result = asyncio.run(final_proofread_pdp_geo_artifacts(payload, {"customFinalProofreader": Proofreader()}))
    assert result["diagnostics"]["applied"] is True
    assert _node(result["schemaMarkup"], "Product")["description"] == "Glow Serum is a serum for dry skin."
    accepted = result["diagnostics"]["acceptedEdits"][0]
    assert accepted["sourceHash"] == stable_text_hash(
        "Product.description\nGlow Serum is a serum for dry skin. Glow Serum is a serum for dry skin."
    )

    class UnsafeProofreader:
        def proofread(self, request: dict[str, Any]) -> dict[str, Any]:
            edits: list[dict[str, Any]] = []
            for field in request["fields"]:
                candidate = (
                    "Glow Serum is a serum for oily skin."
                    if field["fieldPath"] == "Product.description"
                    else field["text"]
                )
                edits.append(
                    {
                        "fieldPath": field["fieldPath"],
                        "sourceHash": field["sourceHash"],
                        "action": "revise" if candidate != field["text"] else "keep",
                        "revisedText": candidate,
                        "issueCodes": ["grammar"] if candidate != field["text"] else [],
                    }
                )
            return {"edits": edits, "warnings": []}

    unsafe = asyncio.run(final_proofread_pdp_geo_artifacts(payload, {"customFinalProofreader": UnsafeProofreader()}))
    assert _node(unsafe["schemaMarkup"], "Product")["description"] != "Glow Serum is a serum for oily skin."
    assert unsafe["diagnostics"]["rejectedEdits"]


def test_source_preserving_protected_sentence_keeps_field_provenance_but_unresolved_text_still_shortfalls() -> None:
    """Only a verbatim protected source span may coexist with an evidence-bound sentence."""

    grounded = "Glow Serum is a serum for dry skin."
    protected = "Keep this source wording exactly: use only as directed."
    unresolved = "Glow Serum erases signs of aging overnight."
    path = "Product.description"

    def provenance_for(text: str, protected_sentence: str) -> dict[str, Any]:
        return {
            "fieldPath": path,
            "text": text,
            "sourceHash": stable_text_hash(f"{path}\n{text}"),
            "origin": "deterministic-renderer",
            "evidenceIds": ["ev-grounded"],
            "sentences": [
                {
                    "text": grounded,
                    "sourceHash": stable_text_hash(f"{path}#sentence[0]\n{grounded}"),
                    "evidenceIds": ["ev-grounded"],
                },
                {
                    "text": protected_sentence,
                    "sourceHash": stable_text_hash(f"{path}#sentence[1]\n{protected_sentence}"),
                    "evidenceIds": [],
                    "protected": True,
                },
            ],
        }

    payload = _input()
    protected_text = f"{grounded} {protected}"
    _node(payload["schemaMarkup"], "Product")["description"] = protected_text
    payload["product"]["description"] = protected_text
    payload["content"]["sections"]["description"] = protected_text
    payload["evidenceLedger"] = [
        {
            "id": "ev-grounded",
            "role": "description",
            "text": grounded,
            "sourcePath": "product.description",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "ev-protected-source",
            "role": "source",
            "text": protected,
            "sourcePath": "product.sourceTexts[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
    ]
    payload["publicCopyProvenance"] = [provenance_for(protected_text, protected)]
    proofreader_requests: list[dict[str, Any]] = []

    class ProtectedSentenceEditingProofreader:
        def proofread(self, request: dict[str, Any]) -> dict[str, Any]:
            proofreader_requests.append(request)
            return {
                "edits": [
                    {
                        "fieldPath": field["fieldPath"],
                        "sourceHash": field["sourceHash"],
                        "action": "revise" if field["fieldPath"] == path else "keep",
                        "revisedText": (
                            f"{grounded} Keep this source wording exactly: use only as directed!"
                            if field["fieldPath"] == path
                            else field["text"]
                        ),
                        "issueCodes": ["punctuation"] if field["fieldPath"] == path else [],
                    }
                    for field in request["fields"]
                ],
                "warnings": [],
            }

    protected_result = asyncio.run(
        final_proofread_pdp_geo_artifacts(
            payload,
            {"customFinalProofreader": ProtectedSentenceEditingProofreader()},
        )
    )
    protected_report = validate_pdp_geo_artifacts(payload)

    assert [field["fieldPath"] for field in proofreader_requests[0]["fields"]] == [path]
    assert _node(protected_result["schemaMarkup"], "Product")["description"] == protected_text
    retained = next(item for item in protected_result["finalPublicCopyProvenance"] if item["fieldPath"] == path)
    assert retained["sentences"][1]["protected"] is True
    assert any(item["fieldPath"] == path for item in protected_result["diagnostics"]["rejectedEdits"])
    assert not any(
        item["field"] == path and item["source"] == "public-copy-provenance"
        for item in protected_report["validationFindings"]
    )

    unresolved_payload = deepcopy(payload)
    unresolved_text = f"{grounded} {unresolved}"
    _node(unresolved_payload["schemaMarkup"], "Product")["description"] = unresolved_text
    unresolved_payload["product"]["description"] = unresolved_text
    unresolved_payload["content"]["sections"]["description"] = unresolved_text
    unresolved_payload["publicCopyProvenance"] = [provenance_for(unresolved_text, unresolved)]
    unresolved_report = validate_pdp_geo_artifacts(unresolved_payload)
    unresolved_findings = [
        item
        for item in unresolved_report["validationFindings"]
        if item["field"] == path and item["source"] == "public-copy-provenance"
    ]

    assert unresolved_findings
    assert collect_quality_gate_shortfalls(
        {"geo": 100, "cep": 100, "eeat": 100},
        {"geo": 90, "cep": 95, "eeat": 90},
        len(unresolved_findings),
        len(unresolved_findings),
    ) == ["1 unresolved public-copy provenance warning(s)"]


def test_final_proofreader_all_keep_is_a_true_artifact_noop() -> None:
    payload = _input()
    payload["content"]["html"] = "<article>preserve me</article>"
    payload["publicCopyProvenance"] = create_pdp_geo_public_copy_provenance(payload)

    class KeepProofreader:
        def proofread(self, request: dict[str, Any]) -> dict[str, Any]:
            return {
                "edits": [
                    {
                        "fieldPath": field["fieldPath"],
                        "sourceHash": field["sourceHash"],
                        "action": "keep",
                        "revisedText": field["text"],
                        "issueCodes": [],
                    }
                    for field in request["fields"]
                ],
                "warnings": [],
            }

    result = asyncio.run(final_proofread_pdp_geo_artifacts(payload, {"customFinalProofreader": KeepProofreader()}))

    assert result["diagnostics"]["applied"] is False
    assert result["content"] == payload["content"]
    assert result["schemaMarkup"] == payload["schemaMarkup"]


def test_final_proofreader_keeps_faq_membership_as_an_immutable_row_constraint() -> None:
    """Proofreading sees an FAQ row ID but cannot replace its membership sidecar."""

    payload = _input()
    question = _node(payload["schemaMarkup"], "FAQPage")["mainEntity"][0]["name"]
    answer = _node(payload["schemaMarkup"], "FAQPage")["mainEntity"][0]["acceptedAnswer"]["text"]
    membership = [{"id": "faq-dry-skin", "intent": "buyer-decision", "evidenceIds": ["ev-faq"]}]
    payload["contentPlan"] = {
        "mode": "model",
        "faq": [
            {
                "id": "faq-dry-skin",
                "include": True,
                "question": question,
                "answer": answer,
                "evidenceIds": ["ev-faq"],
            }
        ],
    }
    payload["faqMembership"] = membership
    payload["publicCopyProvenance"] = create_pdp_geo_public_copy_provenance(payload)
    requests: list[dict[str, Any]] = []

    class KeepProofreader:
        def proofread(self, request: dict[str, Any]) -> dict[str, Any]:
            requests.append(request)
            return {
                "edits": [
                    {
                        "fieldPath": field["fieldPath"],
                        "sourceHash": field["sourceHash"],
                        "action": "keep",
                        "revisedText": field["text"],
                        "issueCodes": [],
                    }
                    for field in request["fields"]
                ],
                "warnings": [],
            }

    result = asyncio.run(final_proofread_pdp_geo_artifacts(payload, {"customFinalProofreader": KeepProofreader()}))

    faq_fields = [field for field in requests[0]["fields"] if field["fieldPath"].startswith("FAQPage.mainEntity")]
    assert faq_fields and {field["faqRowId"] for field in faq_fields} == {"faq-dry-skin"}
    assert result["faqMembership"] == membership


def test_final_proofreader_retry_merges_canonical_token_usage() -> None:
    payload = _input()
    payload["publicCopyProvenance"] = create_pdp_geo_public_copy_provenance(payload)
    calls: list[dict[str, Any]] = []

    class RetryingProofreader:
        def proofread(self, request: dict[str, Any]) -> dict[str, Any]:
            calls.append(request)
            edits: list[dict[str, Any]] = []
            for field in request["fields"]:
                product = field["fieldPath"] == "Product.description"
                edits.append(
                    {
                        "fieldPath": field["fieldPath"],
                        "sourceHash": field["sourceHash"],
                        "action": "revise" if product else "keep",
                        "revisedText": (
                            "Glow Serum is a serum for oily skin."
                            if product and len(calls) == 1
                            else "Glow Serum is a serum for dry skin."
                            if product
                            else field["text"]
                        ),
                        "issueCodes": ["duplicate-sentence"] if product else [],
                    }
                )
            usage = {"inputTokens": 3, "outputTokens": 5, "totalTokens": 8} if len(calls) == 1 else {
                "inputTokens": 7,
                "outputTokens": 11,
                "totalTokens": 18,
            }
            return {"edits": edits, "warnings": [], "usage": usage}

    result = asyncio.run(final_proofread_pdp_geo_artifacts(payload, {"customFinalProofreader": RetryingProofreader()}))

    assert len(calls) == 2
    assert result["usage"] == {"inputTokens": 10, "outputTokens": 16, "totalTokens": 26}
    assert result["diagnostics"]["applied"] is True


def test_orchestrator_runs_optional_refiner_then_proofreader_without_breaking_progress_contract() -> None:
    calls: list[str] = []

    class Refiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            calls.append("refiner")
            return {"warnings": []}

    class Proofreader:
        def proofread(self, request: dict[str, Any]) -> dict[str, Any]:
            calls.append("proofreader")
            return {
                "edits": [
                    {
                        "fieldPath": field["fieldPath"],
                        "sourceHash": field["sourceHash"],
                        "action": "keep",
                        "revisedText": field["text"],
                        "issueCodes": [],
                    }
                    for field in request["fields"]
                ],
                "warnings": [],
            }

    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "name": "Glow Serum",
                    "description": "Glow Serum is a serum for dry skin.",
                    "usage": ["Apply Glow Serum to clean skin."],
                    "faq": [
                        {"question": "Is it suitable for dry skin?", "answer": "Glow Serum is intended for dry skin."}
                    ],
                }
            },
            {"customCopyRefiner": Refiner(), "customFinalProofreader": Proofreader()},
        )
    )
    assert calls[:2] == ["refiner", "proofreader"]
    assert [step["id"] for step in run["process"]] == [
        "input",
        "normalize",
        "rag-load",
        "chunk",
        "embed",
        "retrieve",
        "rerank",
        "generate",
        "validate",
        "repair",
        "quality-gate",
        "artifact",
    ]
    assert all(step["status"] == "done" for step in run["process"])
    assert run["diagnostics"]["finalProofreading"]["called"] is True


def _korean_source_backed_input() -> dict[str, Any]:
    """A Korean product whose page states its audience, formula, result, and footnote."""

    description = "아미노산 유래 세정 성분을 담은 약산성 포뮬라로 일상 속 노폐물을 말끔하게 세정하는 클렌징폼입니다."
    published = (
        "장벽 클렌징폼은 건조 피부 또는 민감 피부에 추천되며, 일상 속 노폐물부터 가벼운 메이크업까지 "
        "세정하는 제품으로 안내됩니다. 장벽 클렌징폼은 아미노산 유래 세정 성분, 판테놀 등을 주요 성분·기술로 "
        "함유하고 있습니다. 만 20~39세의 성인 여성 30명을 대상으로 한 시험에서 색조 메이크업 97.1% 세정 "
        "결과가 제시되었습니다. 개인차 있음."
    )
    graph = [
        {"@type": ["WebPage", "ItemPage"], "description": published},
        {"@type": "Product", "name": "장벽 클렌징폼", "description": published, "additionalProperty": []},
    ]
    return {
        "product": {
            "name": "장벽 클렌징폼",
            "brand": "예시 브랜드",
            "description": description,
            "ingredients": ["아미노산 유래 세정 성분", "판테놀"],
            "benefits": ["일상 속 노폐물부터 가벼운 메이크업까지 세정", "클렌징 과정에도 장벽 보호"],
            "usage": ["클렌징 단계에서 젖은 손에 적당량을 덜어 충분히 거품을 내주세요."],
            "sourceTexts": [
                description,
                "이 제품은 건조 피부 또는 민감 피부에 추천되며, 일상 속 노폐물부터 가벼운 메이크업까지 세정하는 제품으로 안내됩니다.",
                "색조 메이크업 97.1% 세정 / 만 20~39세의 성인 여성 30명 대상 / 개인차 있음",
            ],
            "faq": [],
        },
        "locale": "ko-KR",
        "schemaMarkup": {"jsonLd": {"@context": "https://schema.org", "@graph": graph}},
        "content": {"html": "", "sections": {}},
    }, published


def _refined_description(published: str, replacement: tuple[str, str]) -> str:
    return published.replace(*replacement)


def test_source_support_accepts_a_refinement_that_only_inflects_the_same_words() -> None:
    """Korean grammar is not a fact, so re-stating the same words must not be rejected.

    A noun cannot be restated without a particle nor a predicate without an
    ending, so a support judgment that compares spellings rejects every natural
    Korean sentence.  This is the gate that blocked the proofreader from
    closing a footnote into a sentence and from dropping a reporting frame the
    brand overlay forbids.
    """

    payload, published = _korean_source_backed_input()
    request = {"product": payload["product"], "locale": "ko-KR"}
    refined = (
        published.replace("개인차 있음.", "")
        .replace("결과가 제시되었습니다.", "결과가 제시되었습니다(단, 개인차가 있을 수 있습니다).")
        .replace("세정하는 제품으로 안내됩니다", "세정하는 제품입니다")
        .replace("  ", " ")
        .strip()
    )

    assert _is_source_supported(refined, request, published)


def test_source_support_still_rejects_words_neither_the_source_nor_the_copy_holds() -> None:
    """Two unsupported words in one stated fact are a claim the page does not have."""

    payload, published = _korean_source_backed_input()
    request = {"product": payload["product"], "locale": "ko-KR"}

    for replacement in (
        ("세정하는 제품으로 안내됩니다", "주름 개선과 미백 효과를 제공합니다"),
        ("아미노산 유래 세정 성분, 판테놀", "레티놀, 나이아신아마이드"),
        ("건조 피부 또는 민감 피부에 추천되며", "아토피 피부염 치료에 적합하며"),
    ):
        candidate = _refined_description(published, replacement)
        assert candidate != published
        assert not _is_source_supported(candidate, request, published), replacement


def test_source_support_reads_one_stated_fact_at_a_time() -> None:
    """A long description must not dilute an unsupported claim below a proportion.

    Measured over a whole description, a fixed share of unsupported words grows
    with the text: the same invented efficacy that a sentence rejects would
    ride along in a paragraph.  The unit is therefore one clause.
    """

    payload, published = _korean_source_backed_input()
    request = {"product": payload["product"], "locale": "ko-KR"}
    invented = "장벽 클렌징폼은 주름 개선과 미백 효과를 제공합니다."

    assert not _is_source_supported(invented, request, published)
    assert not _is_source_supported(f"{published} {invented}", request, published)

"""Public artifact regressions for source-grounded generator copy."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from typing import Any, cast

import pytest

from pdp_geo_generator_agent.content_planning import create_conservative_content_plan, create_pdp_geo_evidence_ledger
from pdp_geo_generator_agent.final_proofreader import (
    create_pdp_geo_public_copy_provenance,
    final_proofread_pdp_geo_artifacts,
    reconcile_pdp_geo_public_copy_provenance,
    stable_text_hash,
)
from pdp_geo_generator_agent.generation import ensure_pdp_geo_faq_plan_coverage, generate_pdp_geo_artifacts
from pdp_geo_generator_agent.normalization import infer_pdp_evidence_roles, normalize_pdp_product
from pdp_geo_generator_agent.quality_gate import collect_quality_gate_shortfalls
from pdp_geo_generator_agent.service import generate_pdp_geo
from pdp_geo_generator_agent.validation import serialize_schema_markup, validate_pdp_geo_artifacts


def _source_product() -> dict[str, Any]:
    return {
        "name": "Barrier Serum",
        "brand": "Example Lab",
        "category": "serum",
        "description": "Barrier Serum is a serum for dry skin.",
        "ingredients": ["Ceramide Complex"],
        "benefits": ["supports hydration"],
        "effects": ["helps soothe dry skin"],
        "usage": [
            "Dispense two pumps and smooth over face and neck.",
            "Press gently to absorb.",
        ],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": ["lightweight finish"]},
        "sourceTexts": [
            "Barrier Serum is a serum for dry skin.",
            "Ceramide Complex supports hydration.",
            "Instrumental testing found 1.3x hydration after 2 weeks. Individual results may vary.",
        ],
        "semanticFacts": {
            "skinTypes": ["dry skin"],
            "usageSteps": [
                "Dispense two pumps and smooth over face and neck.",
                "Press gently to absorb.",
            ],
            "metricClaims": [
                {
                    "metric": "hydration",
                    "value": "1.3",
                    "unit": "x",
                    "timing": "after 2 weeks",
                    "caveat": "Individual results may vary.",
                    "sourceText": "Instrumental testing found 1.3x hydration after 2 weeks. Individual results may vary.",
                }
            ],
        },
    }


def _node(schema_markup: Mapping[str, Any], kind: str) -> dict[str, Any]:
    graph = cast(list[dict[str, Any]], cast(Mapping[str, Any], schema_markup["jsonLd"])["@graph"])
    return next(
        item
        for item in graph
        if kind in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]])
    )


def _model_plan(product: Mapping[str, Any]) -> dict[str, Any]:
    usage = cast(list[str], product["usage"])
    return {
        "mode": "model",
        "productDescription": {
            "include": False,
            "text": "",
            "intent": "product-entity-summary",
            "evidenceIds": [],
            "confidence": 0,
            "omitReason": "Use deterministic product rendering.",
        },
        "webPageDescription": {
            "include": False,
            "text": "",
            "intent": "page-coverage-summary",
            "evidenceIds": [],
            "confidence": 0,
            "omitReason": "The planner did not approve page copy.",
        },
        "faq": [],
        "howTo": {
            "eligible": True,
            "ordered": True,
            "goal": "How to use Barrier Serum",
            "steps": [
                {"position": index + 1, "name": "", "text": text, "evidenceIds": [f"usage-{index}"]}
                for index, text in enumerate(usage)
            ],
            "evidenceIds": ["usage-0", "usage-1"],
            "confidence": 1,
            "omitReason": "",
        },
    }


def _approved_copy_plan(product: Mapping[str, Any]) -> dict[str, Any]:
    plan = _model_plan(product)
    plan["productDescription"] = {
        "include": True,
        "text": "The planner approved source-backed product copy.",
        "intent": "product-entity-summary",
        "evidenceIds": ["identity", "description", "formula", "benefit", "metric", "review"],
        "confidence": 1,
        "omitReason": "",
    }
    plan["webPageDescription"] = {
        "include": True,
        "text": "The planner approved source-backed page copy.",
        "intent": "page-coverage-summary",
        "evidenceIds": ["identity", "description", "formula", "benefit", "usage", "metric", "review"],
        "confidence": 1,
        "omitReason": "",
    }
    return plan


def _korean_source_product() -> dict[str, Any]:
    return {
        "name": "배리어 세럼",
        "brand": "예시 랩",
        "category": "세럼",
        "description": "배리어 세럼은 건조한 피부를 위한 세럼입니다.",
        "ingredients": ["세라마이드 콤플렉스"],
        "benefits": ["수분 케어"],
        "effects": ["건조함 완화"],
        "usage": ["두 펌프를 덜어 얼굴과 목에 부드럽게 펴 바릅니다."],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": ["촉촉한 사용감"]},
        "sourceTexts": [
            "배리어 세럼은 건조한 피부를 위한 세럼입니다.",
            "세라마이드 콤플렉스를 포함합니다.",
            "2주 후 수분량이 1.3배로 측정됐으며 개인차가 있을 수 있습니다.",
        ],
        "semanticFacts": {
            "skinTypes": ["건조한 피부"],
            "usageSteps": ["두 펌프를 덜어 얼굴과 목에 부드럽게 펴 바릅니다."],
            "metricClaims": [
                {
                    "metric": "수분량",
                    "value": "1.3",
                    "unit": "배",
                    "timing": "2주 후",
                    "caveat": "개인차가 있을 수 있습니다.",
                    "sourceText": "2주 후 수분량이 1.3배로 측정됐으며 개인차가 있을 수 있습니다.",
                }
            ],
        },
    }


def test_planner_refusal_uses_the_safe_webpage_source_fallback() -> None:
    """A rejected page field cannot erase deterministic source-backed page coverage."""

    artifact = generate_pdp_geo_artifacts(
        {"product": _source_product(), "locale": "en-US", "contentPlan": _model_plan(_source_product())}
    )

    webpage_description = _node(artifact["schemaMarkup"], "WebPage").get("description")

    assert webpage_description
    assert "Barrier Serum" in webpage_description
    assert "Ceramide Complex" in webpage_description


def test_service_keeps_webpage_source_fallback_after_a_locally_rejected_model_field() -> None:
    """Service assembly may not erase the renderer's safe WebPage fallback."""

    async def planner(request: Mapping[str, Any]) -> dict[str, Any]:
        return {"plan": {key: value for key, value in create_conservative_content_plan(request).items() if key != "mode"}}

    run = asyncio.run(
        generate_pdp_geo(
            {"product": _source_product(), "hints": {"locale": "en-US"}},
            {"customContentPlanner": planner, "qualityGate": {"enabled": False}},
        )
    )

    webpage_description = _node(run["result"]["schemaMarkup"], "WebPage").get("description")

    assert webpage_description
    assert "Barrier Serum" in webpage_description


def test_service_keeps_a_direct_safety_faq_after_identity_only_question_framing() -> None:
    """A named question must retain its exact direct source safety answer end-to-end."""

    product: dict[str, Any] = {
        "name": "Barrier Serum",
        "brand": "Example Lab",
        "category": "serum",
        "description": "Barrier Serum is a serum.",
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [{"question": "Can it be used by newborns?", "answer": "Barrier Serum is safe for newborns."}],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["Barrier Serum is safe for newborns."],
    }

    async def planner(request: Mapping[str, Any]) -> dict[str, Any]:
        plan = create_conservative_content_plan(request)
        evidence_ids = [
            str(item["id"])
            for item in cast(list[dict[str, Any]], request["evidenceLedger"])
            if item["role"] == "faq"
        ]
        plan["faq"] = [
            {
                "include": True,
                "question": "Can it be used by newborns?",
                "answer": "Barrier Serum is safe for newborns.",
                "intent": "safety",
                "cep": "",
                "evidenceIds": evidence_ids,
                "confidence": 1,
                "omitReason": "",
            }
        ]
        return {"plan": {key: value for key, value in plan.items() if key != "mode"}}

    run = asyncio.run(
        generate_pdp_geo(
            {"product": product, "hints": {"locale": "en-US"}},
            {"customContentPlanner": planner, "qualityGate": {"enabled": False}},
        )
    )
    graph = cast(list[dict[str, Any]], run["result"]["schemaMarkup"]["jsonLd"]["@graph"])
    faq_page = next(
        (
            item
            for item in graph
            if "FAQPage" in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]])
        ),
        cast(dict[str, Any], {}),
    )
    expected_pair = ("Can Example Lab's Barrier Serum be used by newborns?", "Barrier Serum is safe for newborns.")
    rendered_pairs = [
        (item["name"], cast(dict[str, str], item["acceptedAnswer"])["text"])
        for item in cast(list[dict[str, Any]], faq_page.get("mainEntity") or [])
    ]

    assert expected_pair in rendered_pairs
    provenance = [
        item
        for item in run["diagnostics"]["finalPublicCopyProvenance"]
        if item["fieldPath"].startswith("FAQPage.mainEntity")
    ]
    assert {item["text"] for item in provenance} >= set(expected_pair)
    assert not any(
        item["fieldPath"].startswith("FAQPage.mainEntity")
        for item in run["diagnostics"].get("publicCopyOmissions", [])
    )


def test_direct_safety_faqs_keep_a_bare_product_demonstrative() -> None:
    """A direct source safety answer survives when its question says ``this`` rather than a SKU."""

    product: dict[str, Any] = {
        "name": "Ocean Shampoo",
        "brand": "North Coast",
        "category": "shampoo",
        "description": "Ocean Shampoo cleanses hair.",
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["No. This product has not been evaluated for use during pregnancy."],
    }

    for question, expected_question in (
        ("Can pregnant people use this?", "Can pregnant people use North Coast's Ocean Shampoo?"),
        ("Is this safe during pregnancy?", "Is North Coast's Ocean Shampoo safe during pregnancy?"),
    ):
        product["faq"] = [{"question": question, "answer": "No. This product has not been evaluated for use during pregnancy."}]
        artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
        faq = _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"]

        assert faq == [
            {
                "@type": "Question",
                "name": expected_question,
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "No. This product has not been evaluated for use during pregnancy.",
                },
            }
        ]


def test_final_provenance_matches_post_correction_public_copy() -> None:
    """Safe post-refinement repair must not leave a pre-repair provenance hash."""

    class PunctuationRefiner:
        def refine_copy(self, request: Mapping[str, Any]) -> dict[str, Any]:
            description = _node(cast(Mapping[str, Any], request["schemaMarkup"]), "Product")["description"]
            return {"schemaDescriptions": {"product": f"{description}.."}}

    run = asyncio.run(
        generate_pdp_geo(
            {"product": _source_product(), "hints": {"locale": "en-US"}},
            {"customCopyRefiner": PunctuationRefiner(), "qualityGate": {"enabled": False}},
        )
    )
    product_text = _node(run["result"]["schemaMarkup"], "Product")["description"]
    provenance = next(
        item
        for item in run["diagnostics"]["finalPublicCopyProvenance"]
        if item["fieldPath"] == "Product.description"
    )

    assert product_text.endswith(".")
    assert provenance["text"] == product_text
    assert provenance["sourceHash"] == stable_text_hash(f"Product.description\n{product_text}")


def test_faq_binds_by_question_identity_after_reordering() -> None:
    """Reordering rendered FAQ rows cannot make plan evidence follow array index."""

    infant_question = "Is Barrier Serum appropriate for infant skin?"
    infant_answer = "Barrier Serum is described for adult dry skin."
    acne_question = "Can Barrier Serum support acne-prone dry skin?"
    acne_answer = "Barrier Serum documents hydration support for dry skin."
    ledger: list[dict[str, Any]] = [
        {
            "id": "ev-infant",
            "role": "faq",
            "text": f"{infant_question}\n{infant_answer}",
            "sourcePath": "product.faq[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "ev-acne",
            "role": "faq",
            "text": f"{acne_question}\n{acne_answer}",
            "sourcePath": "product.faq[1]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
    ]
    graph = [
        {
            "@type": "FAQPage",
            "mainEntity": [
                {"@type": "Question", "name": acne_question, "acceptedAnswer": {"@type": "Answer", "text": acne_answer}},
                {"@type": "Question", "name": infant_question, "acceptedAnswer": {"@type": "Answer", "text": infant_answer}},
            ],
        }
    ]
    plan = {
        "mode": "model",
        "faq": [
            {"include": True, "question": infant_question, "answer": infant_answer, "evidenceIds": ["ev-infant"]},
            {"include": True, "question": acne_question, "answer": acne_answer, "evidenceIds": ["ev-acne"]},
        ],
    }

    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": {"jsonLd": {"@context": "https://schema.org", "@graph": graph}}, "contentPlan": plan, "evidenceLedger": ledger}
    )
    by_path = {item["fieldPath"]: item for item in provenance}

    assert by_path["FAQPage.mainEntity[0].name"]["origin"] == "model-plan"
    assert by_path["FAQPage.mainEntity[0].name"]["evidenceIds"] == ["ev-acne"]
    assert by_path["FAQPage.mainEntity[0].acceptedAnswer.text"]["evidenceIds"] == ["ev-acne"]
    assert by_path["FAQPage.mainEntity[1].name"]["origin"] == "model-plan"
    assert by_path["FAQPage.mainEntity[1].name"]["evidenceIds"] == ["ev-infant"]
    assert by_path["FAQPage.mainEntity[1].acceptedAnswer.text"]["evidenceIds"] == ["ev-infant"]


def test_faq_provenance_keeps_stable_membership_after_a_fluency_rewrite() -> None:
    """A valid fluent rewrite stays bound to its original FAQ relation card."""

    original_question = "Who is Glow Serum designed for?"
    original_answer = "Glow Serum is designed for dry skin."
    rewritten_question = "Is Glow Serum suitable for dry skin?"
    rewritten_answer = "Glow Serum is intended for dry skin."
    membership = [
        {
            "id": "faq-dry-skin",
            "intent": "buyer-decision",
            "evidenceIds": ["ev-identity", "ev-audience"],
        }
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
                                "name": rewritten_question,
                                "acceptedAnswer": {"@type": "Answer", "text": rewritten_answer},
                            }
                        ],
                    }
                ],
            }
        },
        "contentPlan": {
            "mode": "model",
            "faq": [
                {
                    "id": "faq-dry-skin",
                    "include": True,
                    "question": original_question,
                    "answer": original_answer,
                    "evidenceIds": ["ev-identity", "ev-audience"],
                }
            ],
        },
        "faqMembership": membership,
        "evidenceLedger": [
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
                "id": "ev-audience",
                "role": "audience",
                "text": "Glow Serum is intended for dry skin.",
                "sourcePath": "product.description",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
            {
                "id": "ev-unrelated",
                "role": "ingredient",
                "text": "Glow Serum contains Niacinamide.",
                "sourcePath": "product.ingredients[0]",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
        ],
    }

    provenance = create_pdp_geo_public_copy_provenance(payload)
    by_path = {item["fieldPath"]: item for item in provenance}

    assert by_path["FAQPage.mainEntity[0].name"]["origin"] == "model-plan"
    assert by_path["FAQPage.mainEntity[0].acceptedAnswer.text"]["origin"] == "model-plan"
    assert by_path["FAQPage.mainEntity[0].name"]["faqRowId"] == "faq-dry-skin"
    assert by_path["FAQPage.mainEntity[0].acceptedAnswer.text"]["faqRowId"] == "faq-dry-skin"
    assert set(by_path["FAQPage.mainEntity[0].name"]["evidenceIds"]).issubset({"ev-identity", "ev-audience"})
    assert set(by_path["FAQPage.mainEntity[0].acceptedAnswer.text"]["evidenceIds"]).issubset(
        {"ev-identity", "ev-audience"}
    )


def test_model_faq_membership_binds_identity_scaffolded_direct_answer_claims_only() -> None:
    """A stable model row may add its named product around one direct source claim per sentence."""

    brand = "Example Lab"
    product = "Glow Serum"
    question = f"What does {brand}'s {product} offer for hydration?"
    answer = (
        f"{brand}'s {product} features Ceramide Complex, which supports hydration. "
        f"After 4 weeks of instrumental testing with 32 women, 100% showed improved hydration for {brand}'s {product}."
    )
    membership_ids = ["ev-brand", "ev-product", "ev-link", "ev-metric"]
    ledger = [
        {
            "id": "ev-brand",
            "role": "identity",
            "text": brand,
            "sourcePath": "product.brand",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "ev-product",
            "role": "identity",
            "text": product,
            "sourcePath": "product.name",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "ev-link",
            "role": "source",
            "text": "This serum features Ceramide Complex, which supports hydration.",
            "sourcePath": "product.sourceTexts[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "ev-metric",
            "role": "metric",
            "text": "After 4 weeks of instrumental testing with 32 women, 100% showed improved hydration.",
            "sourcePath": "product.sourceTexts[1]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
    ]

    def payload_for(answer_text: str) -> dict[str, Any]:
        return {
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
                                    "acceptedAnswer": {"@type": "Answer", "text": answer_text},
                                }
                            ],
                        }
                    ],
                }
            },
            "contentPlan": {
                "mode": "model",
                "faq": [
                    {
                        "id": "faq-hydration",
                        "include": True,
                        "question": question,
                        "answer": answer_text,
                        "evidenceIds": membership_ids,
                    }
                ],
            },
            "faqMembership": [
                {"id": "faq-hydration", "intent": "buyer-decision", "evidenceIds": membership_ids}
            ],
            "evidenceLedger": ledger,
        }

    provenance = create_pdp_geo_public_copy_provenance(payload_for(answer))
    by_path = {item["fieldPath"]: item for item in provenance}
    question_provenance = by_path["FAQPage.mainEntity[0].name"]
    answer_provenance = by_path["FAQPage.mainEntity[0].acceptedAnswer.text"]

    assert question_provenance["faqRowId"] == "faq-hydration"
    assert answer_provenance["faqRowId"] == "faq-hydration"
    assert {tuple(sentence["evidenceIds"]) for sentence in answer_provenance["sentences"]} == {
        ("ev-brand", "ev-product", "ev-link"),
        ("ev-brand", "ev-product", "ev-metric"),
    }
    assert set(answer_provenance["evidenceIds"]) <= set(membership_ids)

    legacy_payload = payload_for(answer)
    del legacy_payload["faqMembership"]
    legacy_paths = {item["fieldPath"] for item in create_pdp_geo_public_copy_provenance(legacy_payload)}

    assert "FAQPage.mainEntity[0].acceptedAnswer.text" not in legacy_paths

    fabricated = (
        f"{brand}'s {product} features Ceramide Complex, which caused 200% improved hydration after 4 weeks."
    )
    fabricated_paths = {
        item["fieldPath"] for item in create_pdp_geo_public_copy_provenance(payload_for(fabricated))
    }

    assert "FAQPage.mainEntity[0].acceptedAnswer.text" not in fabricated_paths


def test_invalid_faq_membership_never_falls_back_to_pair_text_or_global_ledger() -> None:
    """A supplied bad sidecar is a diagnostic gap, not permission to rebind a FAQ."""

    question = "Can Glow Serum support dry skin?"
    answer = "Glow Serum is intended for dry skin."
    payload = {
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [
                    {
                        "@type": "FAQPage",
                        "mainEntity": [
                            {"@type": "Question", "name": question, "acceptedAnswer": {"@type": "Answer", "text": answer}}
                        ],
                    }
                ],
            }
        },
        "contentPlan": {
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
        },
        "faqMembership": [{"id": "unknown-card", "intent": "buyer-decision", "evidenceIds": ["ev-faq"]}],
        "evidenceLedger": [
            {
                "id": "ev-faq",
                "role": "faq",
                "text": f"{question}\n{answer}",
                "sourcePath": "product.faq[0]",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            }
        ],
    }

    assert create_pdp_geo_public_copy_provenance(payload) == []


def test_product_description_keeps_connected_source_role_order() -> None:
    """A model-approved description cannot reverse the source narrative roles."""

    product = _source_product()
    plan = _model_plan(product)
    plan["productDescription"] = {
        "include": True,
        "text": (
            "Customers mention lightweight finish. Individual results may vary after 2 weeks at 1.3x hydration. "
            "Barrier Serum supports hydration. Ceramide Complex is included. Barrier Serum is for dry skin."
        ),
        "intent": "product-entity-summary",
        "evidenceIds": ["identity", "audience", "formula", "benefit", "metric", "review"],
        "confidence": 1,
        "omitReason": "",
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    description = _node(artifact["schemaMarkup"], "Product")["description"]
    anchors = ["Barrier Serum", "dry skin", "Ceramide Complex", "supports hydration", "1.3x", "lightweight finish"]

    assert [description.index(anchor) for anchor in anchors] == sorted(description.index(anchor) for anchor in anchors)
    assert "Individual results may vary." in description


def test_approved_english_page_and_product_descriptions_are_rich_but_have_distinct_roles() -> None:
    """An approved page overview covers source facts without becoming Product copy."""

    product = _source_product()
    artifact = generate_pdp_geo_artifacts(
        {"product": product, "locale": "en-US", "contentPlan": _approved_copy_plan(product)}
    )
    page = _node(artifact["schemaMarkup"], "WebPage")["description"]
    description = _node(artifact["schemaMarkup"], "Product")["description"]

    assert page != description
    assert "Barrier Serum from Example Lab" in page
    assert page.startswith("The product page for Barrier Serum from Example Lab introduces a serum for dry skin.")
    assert "is presented with product details" not in page.lower()
    for anchor in ("Barrier Serum", "dry skin", "Ceramide Complex", "supports hydration", "1.3x", "lightweight finish"):
        assert anchor in page
    assert "how to use" not in page.casefold()
    assert "Dispense two pumps" not in page
    assert [page.index(anchor) for anchor in ("Barrier Serum", "dry skin", "Ceramide Complex", "supports hydration", "1.3x", "lightweight finish")] == sorted(
        page.index(anchor)
        for anchor in ("Barrier Serum", "dry skin", "Ceramide Complex", "supports hydration", "1.3x", "lightweight finish")
    )
    for anchor in ("Barrier Serum", "dry skin", "Ceramide Complex", "supports hydration", "1.3x", "lightweight finish"):
        assert anchor in description


def test_accepted_natural_model_descriptions_win_over_deterministic_fallback_by_role() -> None:
    """Admitted source-bound page and Product prose must survive rendering verbatim."""

    product = _source_product()
    product_copy = (
        "Barrier Serum from Example Lab is a serum for dry skin. The formula includes Ceramide Complex. "
        "Barrier Serum supports hydration. Instrumental testing found 1.3x hydration after 2 weeks; individual "
        "results may vary. Customers mention a lightweight finish."
    )
    webpage_copy = (
        "Barrier Serum from Example Lab is a serum for dry skin. This page covers its Ceramide Complex formula, "
        "hydration support, and two-pump application over the face and neck before gently pressing to absorb. It "
        "also reports 1.3x hydration after 2 weeks; individual results may vary, alongside customer mentions of a "
        "lightweight finish."
    )
    plan = _approved_copy_plan(product)
    plan["productDescription"] = {
        "include": True,
        "text": product_copy,
        "intent": "product-entity-summary",
        "evidenceIds": ["identity", "description", "formula", "benefit", "metric", "review"],
        "confidence": 1,
        "omitReason": "",
    }
    plan["webPageDescription"] = {
        "include": True,
        "text": webpage_copy,
        "intent": "page-coverage-summary",
        "evidenceIds": ["identity", "description", "formula", "benefit", "usage", "metric", "review"],
        "confidence": 1,
        "omitReason": "",
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})

    assert _node(artifact["schemaMarkup"], "Product")["description"] == product_copy
    assert _node(artifact["schemaMarkup"], "WebPage")["description"] == webpage_copy
    assert product_copy != webpage_copy


def test_accepted_natural_faq_pairs_survive_schema_visible_copy_and_provenance() -> None:
    """Natural evidence-bound FAQ pairs must not be dropped by lexical rendering."""

    product = _source_product()
    formula_question = "Which formula component does Barrier Serum feature?"
    formula_answer = "Barrier Serum's formula features Ceramide Complex."
    benefit_question = "What care benefit does Barrier Serum identify?"
    benefit_answer = "Barrier Serum identifies hydration support as a care benefit."
    expected_pairs = [
        ("Which formula component does Example Lab's Barrier Serum feature?", formula_answer),
        ("What care benefit does Example Lab's Barrier Serum identify?", benefit_answer),
    ]
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    formula_ids = [
        item["id"]
        for item in ledger
        if item["role"] == "ingredient" and item["text"] == "Ceramide Complex"
    ]
    benefit_ids = [
        item["id"]
        for item in ledger
        if item["role"] == "benefit" and item["text"] == "supports hydration"
    ]
    assert formula_ids and benefit_ids
    plan = _approved_copy_plan(product)
    plan["faq"] = [
        {
            "include": True,
            "question": formula_question,
            "answer": formula_answer,
            "intent": "formula",
            "cep": "",
            "evidenceIds": formula_ids,
            "confidence": 1,
            "omitReason": "",
        },
        {
            "include": True,
            "question": benefit_question,
            "answer": benefit_answer,
            "intent": "benefit",
            "cep": "",
            "evidenceIds": benefit_ids,
            "confidence": 1,
            "omitReason": "",
        },
    ]

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    faq = _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"]
    rendered_pairs = [
        (item["name"], cast(dict[str, str], item["acceptedAnswer"])["text"])
        for item in faq
    ]
    provenance = create_pdp_geo_public_copy_provenance(
        {
            "schemaMarkup": artifact["schemaMarkup"],
            "contentPlan": plan,
            "evidenceLedger": ledger,
        }
    )
    provenance_by_path = {item["fieldPath"]: item for item in provenance}

    assert rendered_pairs == expected_pairs
    for index, (question, answer) in enumerate(expected_pairs):
        assert f"Q. {question}\nA. {answer}" in artifact["content"]["sections"]["faq"]
        assert provenance_by_path[f"FAQPage.mainEntity[{index}].name"]["text"] == question
        assert provenance_by_path[f"FAQPage.mainEntity[{index}].acceptedAnswer.text"]["text"] == answer


def test_approved_korean_page_and_product_descriptions_preserve_available_source_roles() -> None:
    """Korean approved copy has the same source-role coverage as English copy."""

    product = _korean_source_product()
    artifact = generate_pdp_geo_artifacts(
        {"product": product, "locale": "ko-KR", "contentPlan": _approved_copy_plan(product)}
    )
    page = _node(artifact["schemaMarkup"], "WebPage")["description"]
    description = _node(artifact["schemaMarkup"], "Product")["description"]

    assert page != description
    assert "예시 랩의 배리어 세럼" in page
    assert "상품 페이지" not in page
    for anchor in ("배리어 세럼", "건조한 피부", "세라마이드 콤플렉스", "수분 케어", "1.3배", "촉촉한 사용감"):
        assert anchor in page
    assert "예시 랩의 배리어 세럼의 사용 순서도 함께 확인할 수 있습니다." in page
    assert "두 펌프" not in page
    assert [page.index(anchor) for anchor in ("예시 랩의 배리어 세럼", "건조한 피부", "세라마이드 콤플렉스", "수분 케어", "1.3배", "촉촉한 사용감")] == sorted(
        page.index(anchor)
        for anchor in ("예시 랩의 배리어 세럼", "건조한 피부", "세라마이드 콤플렉스", "수분 케어", "1.3배", "촉촉한 사용감")
    )
    for anchor in ("배리어 세럼", "건조한 피부", "세라마이드 콤플렉스", "수분 케어", "1.3배", "촉촉한 사용감"):
        assert anchor in description


def test_sparse_approved_or_conservative_source_keeps_basic_product_and_page_facts_in_english_and_korean() -> None:
    """Missing optional roles cannot collapse an otherwise valid source record.

    ``include: false`` is fail-closed for an actual model planner refusal. A
    conservative no-model-plan fallback is not that refusal: its planner
    explicitly records that the source-backed renderer remains available.
    """

    cases: list[tuple[str, dict[str, Any], tuple[str, str, str]]] = [
        (
            "en-US",
            {
                "name": "Simple Cleanser",
                "brand": "Example Lab",
                "category": "cleanser",
                "description": "Simple Cleanser is a gentle cleanser.",
                "ingredients": [],
                "benefits": [],
                "effects": [],
                "usage": [],
                "metrics": [],
                "options": [],
                "faq": [],
                "reviews": {"items": [], "keywords": []},
                "sourceTexts": ["Simple Cleanser is a gentle cleanser."],
                "semanticFacts": {},
            },
                ("Simple Cleanser", "cleanser", "Example Lab"),
        ),
        (
            "ko-KR",
            {
                "name": "순한 클렌저",
                "brand": "예시 랩",
                "category": "클렌저",
                "description": "순한 클렌저는 순한 세정 제품입니다.",
                "ingredients": [],
                "benefits": [],
                "effects": [],
                "usage": [],
                "metrics": [],
                "options": [],
                "faq": [],
                "reviews": {"items": [], "keywords": []},
                "sourceTexts": ["순한 클렌저는 순한 세정 제품입니다."],
                "semanticFacts": {},
            },
                ("순한 클렌저", "세정 제품", "예시 랩"),
        ),
    ]

    for locale, product, anchors in cases:
        for content_plan in (_approved_copy_plan(product), None):
            request: dict[str, Any] = {"product": product, "locale": locale}
            if content_plan is not None:
                request["contentPlan"] = content_plan
            artifact = generate_pdp_geo_artifacts(request)
            page = _node(artifact["schemaMarkup"], "WebPage")["description"]
            description = _node(artifact["schemaMarkup"], "Product")["description"]

            assert page and description
            assert anchors[0] in page and anchors[0] in description
            assert anchors[1] in page and anchors[1] in description
            if content_plan is not None:
                assert anchors[2] in page
                if locale == "en-US":
                    assert page.startswith(
                        f"The product page for {anchors[0]} from {anchors[2]} offers an overview."
                    )
                    assert "is presented with product details" not in page.casefold()
                assert "상품 페이지" not in page


def test_howto_preserves_full_source_steps_without_duplicate_substep() -> None:
    """An unadmitted model plan cannot turn a canonical source instruction into extra rows."""

    product = _source_product()
    plan = _model_plan(product)
    plan["howTo"]["steps"] = [
        {"position": 1, "name": "", "text": product["usage"][0], "evidenceIds": ["usage-0"]},
        {"position": 2, "name": "", "text": "Smooth over face and neck.", "evidenceIds": ["usage-0"]},
        {"position": 3, "name": "", "text": product["usage"][1], "evidenceIds": ["usage-1"]},
    ]

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    how_to = _node(artifact["schemaMarkup"], "HowTo")
    source_plan = create_conservative_content_plan(
        {"product": product, "locale": "en-US", "evidenceLedger": create_pdp_geo_evidence_ledger(product, "en-US")}
    )
    expected = [step["text"] for step in source_plan["howTo"]["steps"]]

    assert [step["text"] for step in how_to["step"]] == expected
    assert artifact["content"]["sections"]["howToUse"].splitlines() == expected


def test_faq_rejects_duplicate_or_generic_unanswered_intents() -> None:
    """Only distinct, product-evidence-backed buyer questions may be published."""

    product = _source_product()
    plan = _model_plan(product)
    valid_question = "What makes Barrier Serum different for dry skin?"
    valid_answer = "Barrier Serum includes Ceramide Complex. Barrier Serum supports hydration."
    plan["faq"] = [
        {
            "include": True,
            "question": valid_question,
            "answer": valid_answer,
            "intent": "formula",
            "cep": "",
            "evidenceIds": ["formula"],
            "confidence": 1,
            "omitReason": "",
        },
        {
            "include": True,
            "question": "What makes Barrier Serum different for dry skin ?",
            "answer": valid_answer,
            "intent": "formula",
            "cep": "",
            "evidenceIds": ["formula"],
            "confidence": 1,
            "omitReason": "",
        },
        {
            "include": True,
            "question": "What is the difference?",
            "answer": "It depends on your preference.",
            "intent": "comparison",
            "cep": "",
            "evidenceIds": ["generic"],
            "confidence": 1,
            "omitReason": "",
        },
    ]

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    faq = _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"]

    assert [(item["name"], item["acceptedAnswer"]["text"]) for item in faq] == [
        ("What makes Example Lab's Barrier Serum different for dry skin?", valid_answer)
    ]


def test_safety_test_and_pregnancy_evidence_do_not_become_recommendations() -> None:
    """A completed safety test cannot support pregnancy recommendations in either locale."""

    product = _source_product()
    product["semanticFacts"]["safetyTests"] = ["A skin irritation test was completed."]
    plan = _model_plan(product)
    plan["faq"] = [
        {
            "include": True,
            "question": "Is Barrier Serum recommended during pregnancy?",
            "answer": "Yes, Barrier Serum is recommended during pregnancy.",
            "intent": "safety",
            "cep": "",
            "evidenceIds": ["safety-test"],
            "confidence": 1,
            "omitReason": "",
        },
        {
            "include": True,
            "question": "임신 중 사용해도 되나요?",
            "answer": "네, 임신 중 사용을 권장합니다.",
            "intent": "safety",
            "cep": "",
            "evidenceIds": ["safety-test"],
            "confidence": 1,
            "omitReason": "",
        },
    ]

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    graph = cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])

    assert not any("FAQPage" in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]]) for item in graph)


def test_quality_shortfall_counts_stale_or_skipped_public_copy() -> None:
    """A stale public-copy binding must become a validation warning and gate shortfall."""

    description = "Barrier Serum is a serum for dry skin."
    graph = [{"@type": "Product", "name": "Barrier Serum", "description": description}]
    ledger = [
        {
            "id": "ev-description",
            "role": "description",
            "text": description,
            "sourcePath": "product.description",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        }
    ]
    report = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": serialize_schema_markup({"@context": "https://schema.org", "@graph": graph}),
            "content": {"html": "", "sections": {"description": description}},
            "evidenceLedger": ledger,
            "publicCopyProvenance": [
                {
                    "fieldPath": "Product.description",
                    "text": "Barrier Serum is a serum for oily skin.",
                    "sourceHash": "fnv1a-stale",
                    "evidenceIds": ["ev-description"],
                    "sentences": [],
                }
            ],
        }
    )
    shortfalls = collect_quality_gate_shortfalls(
        {"geo": 100, "cep": 100, "eeat": 100},
        {"geo": 90, "cep": 95, "eeat": 90},
        len(report["validationWarnings"]),
    )

    assert any(finding["source"] == "public-copy-provenance" for finding in report["validationFindings"])
    assert "1 unresolved validation warning(s)" in shortfalls


def test_mixed_source_faq_cannot_add_unsupported_life_stage_or_pregnancy_suitability() -> None:
    """A supported benefit sentence cannot carry an unrelated safety conclusion."""

    product = _source_product()
    plan = _model_plan(product)
    plan["faq"] = [
        {
            "include": True,
            "question": "Who can use Barrier Serum?",
            "answer": "Barrier Serum supports hydration. It is suitable for infants and during pregnancy.",
            "intent": "safety",
            "cep": "",
            "evidenceIds": ["benefit"],
            "confidence": 1,
            "omitReason": "",
        }
    ]

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    graph = cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])

    assert not any("FAQPage" in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]]) for item in graph)


def test_korean_rich_faq_preserves_only_explicit_infant_source_wording() -> None:
    """An irritation-test source FAQ may not grow fixed child or pregnancy advice."""

    source_question = "영유아도 사용할 수 있나요?"
    source_answer = "피부 자극 테스트를 완료했습니다."
    product: dict[str, Any] = {
        "name": "진정 세럼",
        "brand": "",
        "category": "세럼",
        "description": "진정 세럼은 가벼운 제형의 세럼입니다.",
        "ingredients": ["세라마이드", "판테놀"],
        "benefits": ["수분 케어"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [{"question": source_question, "answer": source_answer}],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["전성분: 세라마이드, 판테놀"],
        "semanticFacts": {"safetyTests": [source_answer]},
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "ko-KR"})
    faq = _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"]
    rendered = " ".join(
        f"{item['name']} {cast(dict[str, str], item['acceptedAnswer'])['text']}" for item in faq
    )

    assert ("진정 세럼은 영유아도 사용할 수 있나요?", source_answer) in [
        (item["name"], cast(dict[str, str], item["acceptedAnswer"])["text"]) for item in faq
    ]
    for unsupported in ("어린이", "임산부", "추천", "권장", "전문가", "상담", "작은 부위"):
        assert unsupported not in rendered


def test_rich_descriptions_retain_basic_and_generic_source_facts_without_empty_korean_phrases() -> None:
    """Rich templates keep source description and non-taxonomy benefits in both locales."""

    english: dict[str, Any] = {
        "name": "Source Serum",
        "brand": "",
        "category": "serum",
        "description": "Source Serum has a lightweight gel texture.",
        "ingredients": ["Ceramide", "Panthenol", "Squalane"],
        "benefits": ["calms temporary redness"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["Key Ingredients: Ceramide, Panthenol, Squalane"],
        "semanticFacts": {},
    }
    korean: dict[str, Any] = {
        "name": "원문 세럼",
        "brand": "",
        "category": "세럼",
        "description": "원문 세럼은 가벼운 젤 제형입니다.",
        "ingredients": ["세라마이드", "판테놀", "스쿠알란"],
        "benefits": ["편안한 피부 컨디션 케어"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["전성분: 세라마이드, 판테놀, 스쿠알란"],
        "semanticFacts": {},
    }

    description_cases: list[tuple[str, Mapping[str, Any], str, str]] = [
        ("en-US", english, "Source Serum has a lightweight gel texture.", "calms temporary redness"),
        ("ko-KR", korean, "원문 세럼은 가벼운 젤 제형입니다.", "편안한 피부 컨디션 케어"),
    ]
    for locale, product, source_description, generic_fact in description_cases:
        artifact = generate_pdp_geo_artifacts({"product": product, "locale": locale})
        page = _node(artifact["schemaMarkup"], "WebPage")["description"]
        description = _node(artifact["schemaMarkup"], "Product")["description"]

        assert source_description in page and source_description in description
        assert generic_fact in page and generic_fact in description

    korean_page = _node(generate_pdp_geo_artifacts({"product": korean, "locale": "ko-KR"})["schemaMarkup"], "WebPage")[
        "description"
    ]
    assert "가 선보이는" not in korean_page
    assert "포함하고 를" not in korean_page


def test_qualified_metric_keeps_source_wording_when_it_omits_structured_qualifiers() -> None:
    """A renderer cannot reconstruct missing timing or caveats into a stronger metric frame."""

    product = _source_product()
    product["semanticFacts"]["metricClaims"] = [
        {
            "metric": "hydration",
            "value": "50",
            "unit": "%",
            "timing": "after 4 weeks",
            "caveat": "Individual results may vary.",
            "sourceText": "Hydration increased by 50%.",
        }
    ]
    artifact = generate_pdp_geo_artifacts(
        {"product": product, "locale": "en-US", "contentPlan": _approved_copy_plan(product)}
    )
    description = _node(artifact["schemaMarkup"], "Product")["description"]

    assert "Hydration increased by 50%." in description
    assert "Reported hydration" not in description
    assert "after 4 weeks" not in description
    assert "Individual results may vary." not in description


def test_explicit_source_action_cardinality_and_complete_short_instruction_survive_howto_rendering() -> None:
    """An explicitly ordered source keeps each action, including concise directions."""

    product = _source_product()
    product["usage"] = ["1. Apply two pumps to clean skin.", "2. Press gently to absorb."]
    plan = create_conservative_content_plan(
        {"product": product, "locale": "en-US", "evidenceLedger": create_pdp_geo_evidence_ledger(product, "en-US")}
    )
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})

    expected_steps = ["Apply two pumps to clean skin.", "Press gently to absorb."]
    assert plan["howTo"]["ordered"] is True
    assert [step["text"] for step in plan["howTo"]["steps"]] == expected_steps
    assert [step["text"] for step in _node(artifact["schemaMarkup"], "HowTo")["step"]] == expected_steps
    assert artifact["content"]["sections"]["howToUse"].splitlines() == expected_steps

    short_product = _source_product()
    short_product["usage"] = ["Apply after serum."]
    short_plan = create_conservative_content_plan(
        {
            "product": short_product,
            "locale": "en-US",
            "evidenceLedger": create_pdp_geo_evidence_ledger(short_product, "en-US"),
        }
    )
    short_artifact = generate_pdp_geo_artifacts(
        {"product": short_product, "locale": "en-US", "contentPlan": short_plan}
    )

    assert [step["text"] for step in _node(short_artifact["schemaMarkup"], "HowTo")["step"]] == [
        "Apply after serum."
    ]


def test_empty_or_unresolved_sentence_provenance_binding_creates_a_quality_shortfall() -> None:
    """Each finalized public sentence needs non-empty, ledger-resolving evidence IDs."""

    description = "Barrier Serum is a serum for dry skin."
    graph = [{"@type": "Product", "name": "Barrier Serum", "description": description}]
    ledger = [
        {
            "id": "ev-description",
            "role": "description",
            "text": description,
            "sourcePath": "product.description",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        }
    ]

    for sentence_ids in ([], ["missing-evidence"]):
        report = validate_pdp_geo_artifacts(
            {
                "schemaMarkup": serialize_schema_markup({"@context": "https://schema.org", "@graph": graph}),
                "content": {"html": "", "sections": {"description": description}},
                "evidenceLedger": ledger,
                "publicCopyProvenance": [
                    {
                        "fieldPath": "Product.description",
                        "text": description,
                        "sourceHash": stable_text_hash(f"Product.description\n{description}"),
                        "evidenceIds": ["ev-description"],
                        "sentences": [
                            {
                                "text": description,
                                "sourceHash": stable_text_hash(
                                    f"Product.description#sentence[0]\n{description}"
                                ),
                                "evidenceIds": sentence_ids,
                            }
                        ],
                    }
                ],
            }
        )
        shortfalls = collect_quality_gate_shortfalls(
            {"geo": 100, "cep": 100, "eeat": 100},
            {"geo": 90, "cep": 95, "eeat": 90},
            len(report["validationWarnings"]),
        )

        assert any(finding["source"] == "public-copy-provenance" for finding in report["validationFindings"])
        assert "1 unresolved validation warning(s)" in shortfalls


def test_korean_rich_query_generation_handles_zero_one_and_two_ingredients() -> None:
    """Source-backed query diagnostics must never index absent Korean ingredients."""

    cases: list[tuple[list[str], int]] = [([], 0), (["세라마이드"], 1), (["세라마이드", "판테놀"], 1)]
    for ingredients, expected_count in cases:
        product: dict[str, Any] = {
            "name": "성분 세럼",
            "brand": "",
            "category": "세럼",
            "description": "성분 세럼은 원문 성분 정보를 안내합니다.",
            "ingredients": ingredients,
            "benefits": [],
            "effects": [],
            "usage": [],
            "metrics": [],
            "options": [],
            "faq": [],
            "reviews": {"items": [], "keywords": []},
            "sourceTexts": [f"전성분: {', '.join(ingredients)}"],
            "semanticFacts": {},
        }

        queries = generate_pdp_geo_artifacts({"product": product, "locale": "ko-KR"})["inferredSearchQueries"]

        assert len(queries) == expected_count
        if ingredients:
            assert all(ingredient in queries[0]["answer"] for ingredient in ingredients)
            assert "None" not in queries[0]["answer"]


def test_round2_sensitive_faq_clauses_and_benefitless_korean_fallback_are_omitted() -> None:
    """Source-backed hydration may not authorize life-stage or invented efficacy claims."""

    for sensitive_clause in ("It is appropriate for newborns.", "It can be used by toddlers."):
        product = _source_product()
        plan = _model_plan(product)
        plan["faq"] = [
            {
                "include": True,
                "question": "Who can use Barrier Serum?",
                "answer": f"Barrier Serum supports hydration. {sensitive_clause}",
                "intent": "safety",
                "cep": "",
                "evidenceIds": ["benefit"],
                "confidence": 1,
                "omitReason": "",
            }
        ]
        artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
        graph = cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])

        assert not any("FAQPage" in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]]) for item in graph)

    korean_product: dict[str, Any] = {
        "name": "성분 세럼",
        "brand": "",
        "category": "세럼",
        "description": "성분 세럼은 단일 성분 정보를 안내합니다.",
        "ingredients": ["세라마이드"],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["전성분: 세라마이드"],
        "semanticFacts": {},
    }
    artifact = generate_pdp_geo_artifacts({"product": korean_product, "locale": "ko-KR"})
    graph = cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])
    rendered_faq = " ".join(
        f"{item['name']} {item['acceptedAnswer']['text']}"
        for node in graph
        if "FAQPage" in (node["@type"] if isinstance(node["@type"], list) else [node["@type"]])
        for item in node.get("mainEntity", [])
    )

    assert "피부 장벽" not in rendered_faq
    assert "수분 케어" not in rendered_faq


def test_round2_korean_rich_description_uses_natural_topic_and_object_particles() -> None:
    """A single sourced Korean ingredient remains grammatical without brand or benefits."""

    product: dict[str, Any] = {
        "name": "성분 세럼",
        "brand": "",
        "category": "세럼",
        "description": "성분 세럼은 단일 성분 정보를 안내합니다.",
        "ingredients": ["세라마이드"],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["전성분: 세라마이드"],
        "semanticFacts": {},
    }
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "ko-KR"})
    page = _node(artifact["schemaMarkup"], "WebPage")["description"]
    description = _node(artifact["schemaMarkup"], "Product")["description"]
    rendered = f"{page} {description}"

    assert "성분 세럼은" in rendered
    assert "세라마이드를 주요 성분·기술로 포함합니다." in rendered
    assert "성분 세럼는" not in rendered
    assert "세라마이드을" not in rendered


def test_round2_unlinked_korean_facts_remain_product_and_brand_centered() -> None:
    """Unlinked source facts stay quoted as parallel product facts, not page boilerplate."""

    product: dict[str, Any] = {
        "name": "보습 세럼",
        "brand": "라온랩",
        "category": "세럼",
        "description": "보습 세럼은 산뜻한 제형입니다.",
        "ingredients": ["세라마이드"],
        "benefits": ["수분 케어"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["전성분: 세라마이드"],
        "semanticFacts": {},
    }
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "ko-KR"})
    page = _node(artifact["schemaMarkup"], "WebPage")["description"]
    description = _node(artifact["schemaMarkup"], "Product")["description"]
    rendered = f"{page} {description}"

    assert "라온랩의 보습 세럼은 산뜻한 제형입니다." in rendered
    assert "라온랩의 보습 세럼은 세럼입니다." not in rendered
    assert "보습 세럼은 세라마이드를 주요 성분·기술로 포함합니다." in rendered
    assert "라온랩의 보습 세럼에는 수분 케어 관련 효능·효과가 표기되어 있습니다." in rendered
    assert "수분 케어 관련 효능·효과도 별도로" not in rendered
    assert "상품 페이지는" not in rendered
    assert "제품 정보에는" not in rendered
    assert "세라마이드을" not in rendered
    assert "세라마이드가 수분 케어" not in rendered


def test_round2_rich_entity_fallback_keeps_source_roles_in_order_across_locales() -> None:
    """Entity-centric fallback prose keeps the product narrative backbone in each locale."""

    english: dict[str, Any] = {
        "name": "Source Serum",
        "brand": "Example Lab",
        "category": "serum",
        "description": "Source Serum is a serum for dry skin.",
        "ingredients": ["Ceramide"],
        "benefits": ["supports hydration"],
        "effects": [],
        "usage": ["Apply to clean skin."],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": ["lightweight finish"]},
        "sourceTexts": ["Key Ingredients: Ceramide"],
        "semanticFacts": {
            "metricClaims": [
                {
                    "metric": "hydration",
                    "value": "1.3",
                    "unit": "x",
                    "timing": "after 2 weeks",
                    "caveat": "Individual results may vary.",
                    "sourceText": "Hydration measured 1.3x after 2 weeks. Individual results may vary.",
                }
            ]
        },
    }
    korean: dict[str, Any] = {
        "name": "배리어 세럼",
        "brand": "라온랩",
        "category": "세럼",
        "description": "배리어 세럼은 건조한 피부를 위한 세럼입니다.",
        "ingredients": ["세라마이드"],
        "benefits": ["수분 케어"],
        "effects": [],
        "usage": ["세안 후 얼굴에 펴 바릅니다."],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": ["촉촉한 사용감"]},
        "sourceTexts": ["전성분: 세라마이드"],
        "semanticFacts": {
            "metricClaims": [
                {
                    "metric": "수분량",
                    "value": "1.3",
                    "unit": "배",
                    "timing": "2주 후",
                    "caveat": "개인차가 있을 수 있습니다.",
                    "sourceText": "2주 후 수분량이 1.3배로 측정됐으며 개인차가 있을 수 있습니다.",
                }
            ]
        },
    }
    cases: list[tuple[str, Mapping[str, Any], list[str], str]] = [
        (
            "en-US",
            english,
            ["Source Serum", "dry skin", "Ceramide", "supports hydration", "1.3x", "lightweight finish"],
            "Example Lab",
        ),
        (
            "ko-KR",
            korean,
            ["라온랩의 배리어 세럼", "건조한 피부", "세라마이드", "수분 케어", "1.3배", "촉촉한 사용감"],
            "라온랩",
        ),
    ]

    for locale, product, anchors, brand in cases:
        artifact = generate_pdp_geo_artifacts({"product": product, "locale": locale})
        for text in (
            _node(artifact["schemaMarkup"], "Product")["description"],
            _node(artifact["schemaMarkup"], "WebPage")["description"],
        ):
            assert brand in text
            assert [text.index(anchor) for anchor in anchors] == sorted(text.index(anchor) for anchor in anchors)


def test_round2_metric_source_requires_the_explicit_unit() -> None:
    """A bare numeric source value cannot justify a reconstructed unit-qualified claim."""

    product = _source_product()
    raw_source = "Hydration increased by 50 after 4 weeks. Individual results may vary."
    product["semanticFacts"]["metricClaims"] = [
        {
            "metric": "hydration",
            "value": "50",
            "unit": "%",
            "timing": "after 4 weeks",
            "caveat": "Individual results may vary.",
            "sourceText": raw_source,
        }
    ]
    artifact = generate_pdp_geo_artifacts(
        {"product": product, "locale": "en-US", "contentPlan": _approved_copy_plan(product)}
    )
    description = _node(artifact["schemaMarkup"], "Product")["description"]

    assert raw_source not in description
    assert "Reported hydration" not in description
    assert "50%" not in description


def test_round2_conservative_howto_preserves_all_seven_explicitly_ordered_actions() -> None:
    """An explicit source procedure has no arbitrary public HowTo cardinality cap."""

    product = _source_product()
    product["usage"] = [f"{index}. Apply layer {index} to clean skin." for index in range(1, 8)]
    product["semanticFacts"]["usageSteps"] = list(product["usage"])
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})

    expected_steps = [f"Apply layer {index} to clean skin." for index in range(1, 8)]
    assert plan["howTo"]["ordered"] is True
    assert [step["text"] for step in plan["howTo"]["steps"]] == expected_steps
    assert [step["text"] for step in _node(artifact["schemaMarkup"], "HowTo")["step"]] == expected_steps
    assert artifact["content"]["sections"]["howToUse"].splitlines() == expected_steps


def test_round2_every_provenance_path_rejects_empty_or_unrelated_safety_evidence() -> None:
    """Disabled proofreading and final validation cannot launder sentence-level safety claims."""

    safety_answer = "Barrier Serum is appropriate for newborns."
    graph = [
        {
            "@type": "FAQPage",
            "mainEntity": [
                {
                    "@type": "Question",
                    "name": "Can newborns use Barrier Serum?",
                    "acceptedAnswer": {"@type": "Answer", "text": safety_answer},
                }
            ],
        }
    ]
    ledger = [
        {
            "id": "identity-only",
            "role": "identity",
            "text": "Barrier Serum",
            "sourcePath": "product.name",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        }
    ]
    path = "FAQPage.mainEntity[0].acceptedAnswer.text"

    def payload(sentence_ids: list[str]) -> dict[str, Any]:
        return {
            "schemaMarkup": serialize_schema_markup({"@context": "https://schema.org", "@graph": graph}),
            "content": {"html": "", "sections": {}},
            "evidenceLedger": ledger,
            "publicCopyProvenance": [
                {
                    "fieldPath": path,
                    "text": safety_answer,
                    "sourceHash": stable_text_hash(f"{path}\n{safety_answer}"),
                    "evidenceIds": ["identity-only"],
                    "sentences": [
                        {
                            "text": safety_answer,
                            "sourceHash": stable_text_hash(f"{path}#sentence[0]\n{safety_answer}"),
                            "evidenceIds": sentence_ids,
                        }
                    ],
                }
            ],
        }

    for sentence_ids in ([], ["identity-only"]):
        current = asyncio.run(final_proofread_pdp_geo_artifacts(payload(sentence_ids), {"finalProofreading": {"enabled": False}}))
        report = validate_pdp_geo_artifacts(payload(sentence_ids))

        assert current["finalPublicCopyProvenance"] == []
        assert any(
            finding["field"] == path and finding["source"] == "public-copy-provenance"
            for finding in report["validationFindings"]
        )


def test_round3_model_faq_requires_evidence_for_each_unseen_suitability_clause() -> None:
    """A sourced hydration clause cannot admit arbitrary group-suitability copy."""

    for suitability_clause in (
        "Barrier Serum is appropriate for expectant mothers.",
        "Barrier Serum is appropriate for preschoolers.",
    ):
        product = _source_product()
        plan = _model_plan(product)
        plan["faq"] = [
            {
                "include": True,
                "question": "Who can use Barrier Serum?",
                "answer": f"Barrier Serum supports hydration. {suitability_clause}",
                "intent": "safety",
                "cep": "",
                "evidenceIds": ["benefit"],
                "confidence": 1,
                "omitReason": "",
            }
        ]

        artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
        graph = cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])

        assert not any("FAQPage" in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]]) for item in graph)


def test_round3_model_faq_rejects_affirmative_suitability_against_negative_source() -> None:
    """Negative group guidance cannot support the opposite public conclusion."""

    product = _source_product()
    product["sourceTexts"].append("Barrier Serum is not appropriate for expectant mothers.")
    plan = _model_plan(product)
    plan["faq"] = [
        {
            "include": True,
            "question": "Who can use Barrier Serum?",
            "answer": "Barrier Serum supports hydration. Barrier Serum is appropriate for expectant mothers.",
            "intent": "safety",
            "cep": "",
            "evidenceIds": ["benefit"],
            "confidence": 1,
            "omitReason": "",
        }
    ]

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    graph = cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])

    assert not any("FAQPage" in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]]) for item in graph)


def test_round3_model_faq_preserves_direct_safety_audience_and_benefit_source_facts() -> None:
    """Direct source statements remain publishable without invented causal links."""

    product = _source_product()
    direct_facts = [
        "Barrier Serum is appropriate for expectant mothers.",
        "Barrier Serum is intended for customers with dry skin.",
        "Barrier Serum supports hydration.",
    ]
    direct_safety = "If concerned, patch test and consult a professional."
    product["sourceTexts"].append(
        " ".join(["Barrier Serum contains no concerning ingredients.", direct_safety, *direct_facts])
    )
    plan = _model_plan(product)
    answer = " ".join([direct_safety, *direct_facts])
    plan["faq"] = [
        {
            "include": True,
            "question": "What does Barrier Serum state about use and hydration?",
            "answer": answer,
            "intent": "safety",
            "cep": "",
            "evidenceIds": ["source"],
            "confidence": 1,
            "omitReason": "",
        }
    ]

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    faq = _node(artifact["schemaMarkup"], "FAQPage")
    rendered = cast(list[dict[str, Any]], faq["mainEntity"])[0]["acceptedAnswer"]["text"]

    assert rendered == answer


def test_direct_negative_efficacy_faq_and_description_keep_source_meaning_once() -> None:
    """A direct negative efficacy fact is answerable evidence, not a fatal public-copy failure."""

    faq_product = {
        "name": "Calm Serum",
        "brand": "Acme",
        "description": "A facial serum.",
        "faq": [{"question": "Does this reduce redness?", "answer": "This does not reduce redness."}],
    }
    faq_artifact = generate_pdp_geo_artifacts({"product": faq_product, "locale": "en-US", "contentPlan": {}})
    faq_node = _node(faq_artifact["schemaMarkup"], "FAQPage")
    faq_item = cast(list[dict[str, Any]], faq_node["mainEntity"])[0]

    assert faq_item["name"] == "Does Acme's Calm Serum reduce redness?"
    assert faq_item["acceptedAnswer"]["text"] == "This does not reduce redness."

    ledger = create_pdp_geo_evidence_ledger(faq_product, "en-US")
    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": faq_artifact["schemaMarkup"], "contentPlan": {}, "evidenceLedger": ledger}
    )
    validation = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": faq_artifact["schemaMarkup"],
            "content": faq_artifact["content"],
            "locale": "en-US",
            "sourceProduct": faq_product,
            "evidenceLedger": ledger,
            "publicCopyProvenance": provenance,
        }
    )
    assert not [finding for finding in validation["validationFindings"] if finding["source"] == "public-copy-provenance"]

    description_product = {
        "name": "Calm Serum",
        "brand": "Acme",
        "description": "Calm Serum does not reduce redness.",
        "benefits": ["Calm Serum does not reduce redness."],
    }
    description_artifact = generate_pdp_geo_artifacts(
        {"product": description_product, "locale": "en-US", "contentPlan": {}}
    )
    description = _node(description_artifact["schemaMarkup"], "Product")["description"]
    assert description == "Calm Serum from Acme does not reduce redness."


def test_round3_provenance_rejects_negative_suitability_and_identity_only_efficacy() -> None:
    """Every path requires sentence-relevant evidence with matching claim polarity."""

    safety_sentence = "Barrier Serum is appropriate for expectant mothers."
    efficacy_sentence = "Barrier Serum supports hydration."
    cases: list[tuple[str, list[dict[str, Any]], list[dict[str, Any]], str, str]] = [
        (
            "FAQPage.mainEntity[0].acceptedAnswer.text",
            [
                {
                    "@type": "FAQPage",
                    "mainEntity": [
                        {
                            "@type": "Question",
                            "name": "Can expectant mothers use Barrier Serum?",
                            "acceptedAnswer": {"@type": "Answer", "text": safety_sentence},
                        }
                    ],
                }
            ],
            [
                {
                    "id": "negative-suitability",
                    "role": "source",
                    "text": "Barrier Serum is not appropriate for expectant mothers.",
                    "sourcePath": "product.sourceTexts[0]",
                    "locale": "en-US",
                    "productScope": "product",
                    "confidence": 1,
                }
            ],
            safety_sentence,
            "negative-suitability",
        ),
        (
            "Product.description",
            [{"@type": "Product", "name": "Barrier Serum", "description": efficacy_sentence}],
            [
                {
                    "id": "identity-only",
                    "role": "identity",
                    "text": "Barrier Serum",
                    "sourcePath": "product.name",
                    "locale": "en-US",
                    "productScope": "product",
                    "confidence": 1,
                }
            ],
            efficacy_sentence,
            "identity-only",
        ),
    ]

    for path, graph, ledger, sentence, evidence_id in cases:
        payload: dict[str, Any] = {
            "schemaMarkup": serialize_schema_markup({"@context": "https://schema.org", "@graph": graph}),
            "content": {"html": "", "sections": {"description": sentence}},
            "evidenceLedger": ledger,
            "publicCopyProvenance": [
                {
                    "fieldPath": path,
                    "text": sentence,
                    "sourceHash": stable_text_hash(f"{path}\n{sentence}"),
                    "evidenceIds": [evidence_id],
                    "sentences": [
                        {
                            "text": sentence,
                            "sourceHash": stable_text_hash(f"{path}#sentence[0]\n{sentence}"),
                            "evidenceIds": [evidence_id],
                        }
                    ],
                }
            ],
        }

        current = asyncio.run(final_proofread_pdp_geo_artifacts(payload, {"finalProofreading": {"enabled": False}}))
        report = validate_pdp_geo_artifacts(payload)

        assert current["finalPublicCopyProvenance"] == []
        assert any(
            finding["field"] == path and finding["source"] == "public-copy-provenance"
            for finding in report["validationFindings"]
        )


def test_round3_model_plan_descriptions_are_entity_centric_and_role_ordered_across_locales() -> None:
    """Approved model paths reuse the natural source-role narrative renderers."""

    cases: list[tuple[str, dict[str, Any], list[str], str, tuple[str, ...]]] = [
        (
            "en-US",
            _source_product(),
            ["Barrier Serum from Example Lab", "dry skin", "Ceramide Complex", "supports hydration", "1.3x", "lightweight finish"],
            "is presented with product details",
            ("This Barrier Serum",),
        ),
        (
            "ko-KR",
            _korean_source_product(),
            ["예시 랩의 배리어 세럼", "건조한 피부", "세라마이드 콤플렉스", "수분 케어", "1.3배", "촉촉한 사용감"],
            "상품 페이지는",
            ("제품 정보에는", "배리어 세럼는", "세라마이드 콤플렉스을"),
        ),
    ]

    for locale, product, anchors, forbidden_page_phrase, malformed in cases:
        artifact = generate_pdp_geo_artifacts(
            {"product": product, "locale": locale, "contentPlan": _approved_copy_plan(product)}
        )
        product_description = _node(artifact["schemaMarkup"], "Product")["description"]
        webpage_description = _node(artifact["schemaMarkup"], "WebPage")["description"]

        for text in (product_description, webpage_description):
            assert [text.index(anchor) for anchor in anchors] == sorted(text.index(anchor) for anchor in anchors)
            assert all(phrase not in text for phrase in malformed)
        assert forbidden_page_phrase not in webpage_description


def test_source_grounded_faqs_cover_distinct_product_roles_with_direct_provenance() -> None:
    """Deterministic FAQs retain rich source roles without recommendation copy."""

    run = asyncio.run(
        generate_pdp_geo(
            {"product": _source_product(), "hints": {"locale": "en-US"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    graph = cast(list[dict[str, Any]], run["result"]["schemaMarkup"]["jsonLd"]["@graph"])
    faq = _node({"jsonLd": {"@graph": graph}}, "FAQPage")["mainEntity"]
    rendered = "\n".join(
        f"{item['name']}\n{cast(dict[str, str], item['acceptedAnswer'])['text']}" for item in faq
    )
    rendered_pairs = [
        (item["name"], cast(dict[str, str], item["acceptedAnswer"])["text"])
        for item in faq
    ]
    answers = "\n".join(cast(dict[str, str], item["acceptedAnswer"])["text"] for item in faq)
    questions = [item["name"] for item in faq]

    expected_buyer_pair = (
        "What should people with dry skin know about Example Lab's Barrier Serum?",
        "Example Lab's Barrier Serum is a serum for dry skin. Example Lab's Barrier Serum includes Ceramide Complex. "
        "Example Lab's Barrier Serum supports hydration. Example Lab's Barrier Serum helps soothe dry skin. "
        "Instrumental testing found 1.3x hydration after 2 weeks. Individual results may vary.",
    )
    assert 2 <= len(faq) <= 3
    assert expected_buyer_pair in rendered_pairs
    assert len(set(questions)) == len(questions)
    for direct_fact in (
        "Ceramide Complex",
        "supports hydration",
        "Dispense two pumps and smooth over face and neck.",
        "1.3x hydration after 2 weeks",
        "lightweight finish",
    ):
        assert direct_fact in rendered
    assert all("Barrier Serum" in question for question in questions)
    assert not any(token in answers.casefold() for token in ("best suited", "recommend"))

    provenance = run["diagnostics"]["finalPublicCopyProvenance"]
    faq_provenance = [item for item in provenance if item["fieldPath"].startswith("FAQPage.mainEntity")]
    assert faq_provenance
    assert all(sentence["evidenceIds"] for item in faq_provenance for sentence in item["sentences"])
    buyer_question_provenance = next(
        item
        for item in faq_provenance
        if item["text"] == expected_buyer_pair[0]
    )
    evidence_by_id = {item["id"]: item for item in run["diagnostics"]["evidenceLedger"]}
    assert any(
        evidence_by_id[evidence_id]["role"] in {"audience", "description"}
        for evidence_id in buyer_question_provenance["evidenceIds"]
    )
    assert not any(
        evidence_by_id[evidence_id]["role"] == "metric"
        for evidence_id in buyer_question_provenance["evidenceIds"]
    )
    assert not any(
        finding["source"] == "public-copy-provenance"
        for finding in run["diagnostics"].get("validationFindings", [])
    )


def test_model_faq_coverage_replenishes_a_source_grounded_buyer_concern_answer_with_provenance() -> None:
    """A sparse approved plan still restores one buyer-ready concern answer from direct source facts."""

    product = _source_product()
    product["description"] = "Barrier Serum is suitable for dry skin."
    product["sourceTexts"] = [
        "Barrier Serum is suitable for dry skin.",
        "Ceramide Complex supports hydration.",
        "Instrumental testing found 1.3x hydration after 2 weeks. Individual results may vary.",
    ]
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": _model_plan(product),
            "product": product,
            "locale": "en-US",
            "evidenceLedger": ledger,
        }
    )
    expected = (
        "Who is Example Lab's Barrier Serum suitable for?",
        "Example Lab's Barrier Serum is suitable for dry skin. Example Lab's Barrier Serum includes Ceramide Complex. "
        "Example Lab's Barrier Serum supports hydration. Example Lab's Barrier Serum helps soothe dry skin. "
        "Instrumental testing found 1.3x hydration after 2 weeks. "
        "Individual results may vary.",
    )

    planned = next(
        item
        for item in plan["faq"]
        if (item["question"], item["answer"]) == expected
    )
    assert planned["evidenceIds"]

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    faq = _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"]
    rendered_pairs = [
        (item["name"], cast(dict[str, str], item["acceptedAnswer"])["text"])
        for item in faq
    ]
    assert expected in rendered_pairs
    assert f"Q. {expected[0]}\nA. {expected[1]}" in artifact["content"]["sections"]["faq"]

    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": artifact["schemaMarkup"], "contentPlan": plan, "evidenceLedger": ledger}
    )
    buyer_paths = {
        item["fieldPath"]
        for item in provenance
        if item["fieldPath"].startswith("FAQPage.mainEntity") and item["text"] in expected
    }
    assert len(buyer_paths) == 2


def test_korean_source_fallback_adds_a_natural_buyer_concern_faq_without_recommendation_copy() -> None:
    """Korean fallback answers a supported skin concern before separate formula, effect, and metric facts."""

    product = _korean_source_product()
    product["description"] = "배리어 세럼은 건조한 피부에 적합합니다."
    product["sourceTexts"] = [
        "배리어 세럼은 건조한 피부에 적합합니다.",
        "세라마이드 콤플렉스가 수분 케어를 돕습니다.",
        "2주 후 수분량이 1.3배로 측정됐으며 개인차가 있을 수 있습니다.",
    ]
    expected = (
        "건조한 피부를 위한 예시 랩의 배리어 세럼은 어떤 성분과 효능을 제시하나요?",
        "배리어 세럼은 건조한 피부에 적합합니다. 예시 랩의 배리어 세럼은 세라마이드 콤플렉스를 주요 성분·기술로 포함합니다. "
        "예시 랩의 배리어 세럼에는 수분 케어 관련 효능·효과가 표기되어 있습니다. "
        "2주 후 수분량이 1.3배로 측정됐으며 개인차가 있을 수 있습니다.",
    )

    run = asyncio.run(
        generate_pdp_geo(
            {"product": product, "hints": {"locale": "ko-KR"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    faq = _node(run["result"]["schemaMarkup"], "FAQPage")["mainEntity"]
    rendered_pairs = [
        (item["name"], cast(dict[str, str], item["acceptedAnswer"])["text"])
        for item in faq
    ]

    assert expected in rendered_pairs
    assert f"Q. {expected[0]}\nA. {expected[1]}" in run["result"]["content"]["sections"]["faq"]
    assert "추천" not in expected[0] + expected[1]
    buyer_provenance = [
        item
        for item in run["diagnostics"]["finalPublicCopyProvenance"]
        if item["fieldPath"].startswith("FAQPage.mainEntity") and item["text"] in expected
    ]
    assert len(buyer_provenance) == 2
    assert all(sentence["evidenceIds"] for item in buyer_provenance for sentence in item["sentences"])


def test_source_grounded_korean_faqs_keep_entity_centric_natural_particles() -> None:
    """Korean role questions must keep the product entity and its actual particle."""

    product = _korean_source_product()
    product["name"] = "수분 토너"
    product["category"] = "토너"
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "ko-KR"})
    faq = _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"]
    questions = [item["name"] for item in faq]

    assert "예시 랩의 수분 토너는 어떻게 사용하나요?" in questions
    assert "수분 토너은 어떻게 사용하나요?" not in questions


def test_positive_review_question_uses_branded_attribution_and_binds_its_answer() -> None:
    """A positive keyword may support natural branded public review copy without an audience claim."""

    product = _source_product()
    product["description"] = "Barrier Serum is a serum."
    product["benefits"] = ["supports hydration"]
    product["effects"] = []
    product["sourceTexts"] = ["Barrier Serum is a serum."]
    product["semanticFacts"]["skinTypes"] = []
    run = asyncio.run(
        generate_pdp_geo(
            {"product": product, "hints": {"locale": "en-US"}},
            {"qualityGate": {"enabled": False}},
        )
    )

    review_question = "What do customers positively note about Example Lab's Barrier Serum?"
    review_answer = "Customers who reviewed Example Lab's Barrier Serum positively noted lightweight finish."
    question_provenance = next(
        item
        for item in run["diagnostics"]["finalPublicCopyProvenance"]
        if item["fieldPath"].endswith(".name") and item["text"] == review_question
    )
    answer_provenance = next(
        item
        for item in run["diagnostics"]["finalPublicCopyProvenance"]
        if item["fieldPath"].endswith(".acceptedAnswer.text") and item["text"] == review_answer
    )

    assert all(sentence["evidenceIds"] for sentence in question_provenance["sentences"])
    assert all(sentence["evidenceIds"] for sentence in answer_provenance["sentences"])
    evidence_by_id = {item["id"]: item for item in run["diagnostics"]["evidenceLedger"]}
    assert any(
        evidence_by_id[evidence_id]["sourcePath"].startswith("product.reviews.")
        for evidence_id in answer_provenance["evidenceIds"]
    )
    assert not any(
        finding["source"] == "public-copy-provenance"
        for finding in run["diagnostics"].get("validationFindings", [])
    )


def test_round4_sensitive_assertion_frames_require_the_same_direct_target_source_sentence() -> None:
    """A direct fact cannot be widened from adults or hydration to newborns."""

    cases: list[tuple[str, str, str, str, bool]] = [
        (
            "en-US",
            "Barrier Serum supports hydration.",
            "Barrier Serum supports hydration for newborns.",
            "Can newborns use Barrier Serum?",
            False,
        ),
        (
            "en-US",
            "Barrier Serum is safe for adults.",
            "Barrier Serum is safe for newborns.",
            "Can newborns use Barrier Serum?",
            False,
        ),
        (
            "en-US",
            "Barrier Serum is safe for newborns.",
            "Barrier Serum is safe for newborns.",
            "Can newborns use Barrier Serum?",
            True,
        ),
        (
            "en-US",
            "Barrier Serum supports hydration for newborns.",
            "Barrier Serum supports hydration for newborns.",
            "Can newborns use Barrier Serum?",
            True,
        ),
        (
            "ko-KR",
            "배리어 세럼은 수분 케어를 지원합니다.",
            "배리어 세럼은 신생아를 위한 수분 케어를 지원합니다.",
            "신생아도 배리어 세럼을 사용할 수 있나요?",
            False,
        ),
        (
            "ko-KR",
            "배리어 세럼은 성인에게 안전합니다.",
            "배리어 세럼은 신생아에게 안전합니다.",
            "신생아도 배리어 세럼을 사용할 수 있나요?",
            False,
        ),
        (
            "ko-KR",
            "배리어 세럼은 신생아에게 안전합니다.",
            "배리어 세럼은 신생아에게 안전합니다.",
            "신생아도 배리어 세럼을 사용할 수 있나요?",
            True,
        ),
        (
            "ko-KR",
            "배리어 세럼은 신생아를 위한 수분 케어를 지원합니다.",
            "배리어 세럼은 신생아를 위한 수분 케어를 지원합니다.",
            "신생아도 배리어 세럼을 사용할 수 있나요?",
            True,
        ),
    ]

    for locale, source, answer, question, expected in cases:
        product = _source_product() if locale == "en-US" else _korean_source_product()
        product["benefits"] = []
        product["effects"] = []
        product["sourceTexts"] = [source]
        product["semanticFacts"] = {}
        plan = _model_plan(product)
        plan["faq"] = [
            {
                "include": True,
                "question": question,
                "answer": answer,
                "intent": "safety",
                "cep": "",
                "evidenceIds": ["source"],
                "confidence": 1,
                "omitReason": "",
            }
        ]

        artifact = generate_pdp_geo_artifacts({"product": product, "locale": locale, "contentPlan": plan})
        answers = [
            cast(dict[str, str], item["acceptedAnswer"])["text"]
            for node in cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])
            if "FAQPage" in (node["@type"] if isinstance(node["@type"], list) else [node["@type"]])
            for item in cast(list[dict[str, Any]], node.get("mainEntity", []))
        ]

        assert (answer in answers) is expected


def test_round4_sentence_provenance_requires_every_id_and_the_exact_field_union() -> None:
    """A sentence cannot carry an unrelated record, even beside a relevant one."""

    description = "Barrier Serum supports hydration."
    path = "Product.description"
    ledger: list[dict[str, Any]] = [
        {
            "id": "ev-benefit",
            "role": "benefit",
            "text": description,
            "sourcePath": "product.benefits[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "ev-unrelated",
            "role": "ingredient",
            "text": "Ceramide Complex",
            "sourcePath": "product.ingredients[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
    ]

    def payload(field_ids: list[str], sentence_ids: list[str]) -> dict[str, Any]:
        return {
            "schemaMarkup": serialize_schema_markup(
                {"@context": "https://schema.org", "@graph": [{"@type": "Product", "name": "Barrier Serum", "description": description}]}
            ),
            "content": {"html": "", "sections": {"description": description}},
            "evidenceLedger": ledger,
            "publicCopyProvenance": [
                {
                    "fieldPath": path,
                    "text": description,
                    "sourceHash": stable_text_hash(f"{path}\n{description}"),
                    "evidenceIds": field_ids,
                    "sentences": [
                        {
                            "text": description,
                            "sourceHash": stable_text_hash(f"{path}#sentence[0]\n{description}"),
                            "evidenceIds": sentence_ids,
                        }
                    ],
                }
            ],
        }

    invalid_cases = [
        payload(["ev-benefit", "ev-unrelated"], ["ev-benefit", "ev-unrelated"]),
        payload(["ev-benefit", "ev-unrelated"], ["ev-benefit"]),
    ]
    for invalid in invalid_cases:
        report = validate_pdp_geo_artifacts(invalid)
        disabled = asyncio.run(final_proofread_pdp_geo_artifacts(invalid, {"finalProofreading": {"enabled": False}}))

        assert any(finding["source"] == "public-copy-provenance" for finding in report["validationFindings"])
        assert disabled["finalPublicCopyProvenance"] == []

    valid = payload(["ev-benefit"], ["ev-benefit"])
    valid_report = validate_pdp_geo_artifacts(valid)
    valid_disabled = asyncio.run(final_proofread_pdp_geo_artifacts(valid, {"finalProofreading": {"enabled": False}}))

    assert not any(finding["source"] == "public-copy-provenance" for finding in valid_report["validationFindings"])
    assert valid_disabled["finalPublicCopyProvenance"] == valid["publicCopyProvenance"]


def test_round4_model_description_provenance_discovers_relevant_ledger_evidence_beyond_plan_ids() -> None:
    """A model plan's stale selection cannot leave rendered sentence bindings empty."""

    product = _source_product()
    product["benefits"] = ["supports hydration"]
    product["sourceTexts"] = [
        "Barrier Serum is a serum for dry skin.",
        "Barrier Serum supports hydration.",
    ]
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    identity_id = cast(str, ledger[0]["id"])
    plan = _approved_copy_plan(product)
    plan["productDescription"]["evidenceIds"] = [identity_id]
    plan["webPageDescription"]["evidenceIds"] = [identity_id]
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": artifact["schemaMarkup"], "evidenceLedger": ledger, "contentPlan": plan}
    )
    descriptions = [
        item for item in provenance if item["fieldPath"] in {"Product.description", "WebPage.description"}
    ]

    assert len(descriptions) == 2
    for entry in descriptions:
        sentence_ids = [
            identifier
            for sentence in cast(list[dict[str, Any]], entry["sentences"])
            for identifier in cast(list[str], sentence["evidenceIds"])
        ]
        assert all(cast(list[str], sentence["evidenceIds"]) for sentence in cast(list[dict[str, Any]], entry["sentences"]))
        assert entry["evidenceIds"] == list(dict.fromkeys(sentence_ids))
        assert any(identifier != identity_id for identifier in sentence_ids)


def test_round4_korean_model_descriptions_are_locale_correct_and_distinct_when_sparse() -> None:
    """Model-approved Korean copy stays source-grounded without English metric or page templates."""

    product = _korean_source_product()
    product["name"] = "수분 세럼"
    product["description"] = "수분 세럼은 가벼운 제형입니다."
    product["ingredients"] = []
    product["benefits"] = []
    product["effects"] = []
    product["usage"] = []
    product["reviews"] = {"items": [], "keywords": []}
    product["sourceTexts"] = ["수분 세럼은 가벼운 제형입니다."]
    product["semanticFacts"] = {
        "metricClaims": [
            {
                "metric": "수분량",
                "value": "1.3",
                "unit": "배",
                "timing": "2주 후",
                "caveat": "개인차가 있을 수 있습니다.",
                "sourceText": "수분량이 1.3배로 측정됐습니다.",
            }
        ]
    }
    plan = _approved_copy_plan(product)
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "ko-KR", "contentPlan": plan})
    product_description = _node(artifact["schemaMarkup"], "Product")["description"]
    webpage_description = _node(artifact["schemaMarkup"], "WebPage")["description"]

    for description in (product_description, webpage_description):
        assert "Reported" not in description
        assert "수분량이 1.3배로 측정됐습니다." in description
        assert "예시 랩의 수분 세럼" in description
        assert "수분 세럼은 가벼운 제형입니다." in description
        assert "상품 페이지" not in description
    assert product_description != webpage_description
    assert [product_description.index(anchor) for anchor in ("수분 세럼은 가벼운 제형입니다.", "수분량이 1.3배로 측정됐습니다.")] == sorted(
        product_description.index(anchor) for anchor in ("수분 세럼은 가벼운 제형입니다.", "수분량이 1.3배로 측정됐습니다.")
    )


def test_round4_positive_review_keyword_uses_natural_branded_attribution() -> None:
    """A positive keyword becomes one branded, attributed public-review sentence."""

    product = _source_product()
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    description = _node(artifact["schemaMarkup"], "Product")["description"]
    assert "Customers who reviewed Example Lab's Barrier Serum positively noted lightweight finish." in description


def test_positive_keyword_and_rating_without_a_review_body_use_neutral_public_attribution() -> None:
    """A positive source keyword/rating can inform copy without being presented as a quote."""

    product = _source_product()
    product["reviews"] = {
        "items": [],
        "keywords": ["lightweight finish"],
        "rating": 4.8,
        "reviewCount": 120,
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    rendered_product = _node(artifact["schemaMarkup"], "Product")
    descriptions = [
        cast(str, _node(artifact["schemaMarkup"], kind)["description"])
        for kind in ("Product", "WebPage")
    ]
    faq = _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"]

    expected = "Customers who reviewed Example Lab's Barrier Serum positively noted lightweight finish."
    assert all(expected in description for description in descriptions)
    assert any(cast(dict[str, str], item["acceptedAnswer"])["text"] == expected for item in faq)
    assert rendered_product["aggregateRating"] == {"@type": "AggregateRating", "ratingValue": 4.8, "reviewCount": 120}

    rating_only: dict[str, Any] = {
        **product,
        "reviews": {"items": [], "keywords": [], "rating": 4.8, "reviewCount": 120},
    }
    rating_artifact = generate_pdp_geo_artifacts({"product": rating_only, "locale": "en-US"})
    rating_description = cast(str, _node(rating_artifact["schemaMarkup"], "Product")["description"])
    rating_faq = _node(rating_artifact["schemaMarkup"], "FAQPage")["mainEntity"]
    expected_rating = "Example Lab's Barrier Serum received 4.8 out of 5 from 120 customer ratings."

    assert expected_rating in rating_description
    assert any(cast(dict[str, str], item["acceptedAnswer"])["text"] == expected_rating for item in rating_faq)


def test_negative_keyword_only_review_stays_diagnostic_and_never_enters_public_copy() -> None:
    """A mixed or negative review signal remains visible to diagnostics but not public output."""

    direct_review_signal = "촉촉하지 않음, 산뜻한 마무리"
    product = _korean_source_product()
    product.update(
        {
            "name": "리뷰 세럼",
            "brand": "",
            "ingredients": ["세라마이드", "판테놀", "스쿠알란"],
            "benefits": ["보습", "피부 장벽"],
            "effects": [],
            "usage": [],
            "reviews": {"items": [], "keywords": [direct_review_signal], "rating": 3.0, "reviewCount": 12},
            "sourceTexts": ["전성분: 세라마이드, 판테놀, 스쿠알란"],
            "semanticFacts": {"skinTypes": ["건조한 피부"]},
        }
    )

    run = asyncio.run(
        generate_pdp_geo(
            {"product": product, "hints": {"locale": "ko-KR"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    public_output = json.dumps(
        {"schemaMarkup": run["result"]["schemaMarkup"], "content": run["result"]["content"]},
        ensure_ascii=False,
    )
    diagnostics = cast(dict[str, Any], run["diagnostics"])
    review_queries = [
        item
        for item in cast(list[dict[str, Any]], diagnostics["inferredSearchQueries"])
        if item["source"] == "review-signal"
    ]
    review_notes = [
        item
        for item in cast(list[dict[str, Any]], diagnostics["recommendations"])
        if item["field"] == "review"
    ]

    faq_questions = [
        cast(str, item["name"])
        for node in cast(list[dict[str, Any]], run["result"]["schemaMarkup"]["jsonLd"]["@graph"])
        if "FAQPage" in (node["@type"] if isinstance(node["@type"], list) else [node["@type"]])
        for item in cast(list[dict[str, Any]], node["mainEntity"])
    ]

    assert direct_review_signal not in public_output
    assert not any("고객 리뷰" in question for question in faq_questions)
    assert review_queries == [
        {
            "kind": "diagnostic",
            "question": "리뷰 세럼 고객 리뷰에서 어떤 표현이 언급되나요?",
            "keywords": [direct_review_signal],
            "answer": direct_review_signal,
            "source": "review-signal",
            "mentionsProductOrBrand": True,
        }
    ]
    assert review_notes == [
        {
            "field": "review",
            "message": direct_review_signal,
            "reason": "Direct review phrases were retained as search-ready product signals without inferred sentiment.",
        }
    ]


def test_negative_review_body_is_not_emitted_as_a_public_schema_review() -> None:
    """The renderer does not intentionally publish a complaint as Product.review copy."""

    for locale, complaint, rating in (
        ("en-US", "The texture felt sticky and caused irritation.", 1),
        ("en-US", "I would never buy this product again and regret the purchase.", 1),
        ("en-US", "Terrible product. I hate it.", None),
        ("en-US", "Poor quality and completely useless.", None),
        ("ko-KR", "최악의 제품입니다. 다시는 구매하지 않을 거예요.", None),
        ("ko-KR", "돈이 아깝고 품질이 나쁩니다.", None),
        ("ko-KR", "이 제품이 정말 싫어요.", None),
    ):
        product = _source_product()
        product["reviews"] = {
            "items": [{"body": complaint, "author": "A", **({"rating": rating} if rating is not None else {})}],
            "keywords": [],
        }

        artifact = generate_pdp_geo_artifacts({"product": product, "locale": locale})
        rendered_product = _node(artifact["schemaMarkup"], "Product")
        public_output = json.dumps({"schemaMarkup": artifact["schemaMarkup"], "content": artifact["content"]})

        assert complaint not in public_output
        assert "review" not in rendered_product


def test_round4_faq_answer_provenance_excludes_a_question_only_record() -> None:
    """One FAQ answer keeps only records that support that answer sentence."""

    question = "What is stated about Barrier Serum?"
    answer = "Barrier Serum supports hydration."
    graph = [
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
    ]
    ledger: list[dict[str, Any]] = [
        {
            "id": "faq-full",
            "role": "faq",
            "text": f"{question}\n{answer}",
            "sourcePath": "product.faq[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "faq-question-only",
            "role": "faq",
            "text": question,
            "sourcePath": "product.faq[1].question",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
    ]
    provenance = create_pdp_geo_public_copy_provenance(
        {
            "schemaMarkup": serialize_schema_markup({"@context": "https://schema.org", "@graph": graph}),
            "evidenceLedger": ledger,
            "contentPlan": {"mode": "conservative"},
        }
    )
    answer_entry = next(
        item for item in provenance if item["fieldPath"] == "FAQPage.mainEntity[0].acceptedAnswer.text"
    )

    assert answer_entry["evidenceIds"] == ["faq-full"]
    assert answer_entry["sentences"][0]["evidenceIds"] == ["faq-full"]


def test_round4_source_role_narratives_keep_noun_benefits_and_korean_review_provenance() -> None:
    """A branded positive Korean review frame keeps both final descriptions fully bound."""

    english = _source_product()
    english["benefits"] = ["firming"]
    english["effects"] = []
    english_artifact = generate_pdp_geo_artifacts({"product": english, "locale": "en-US"})
    english_provenance = create_pdp_geo_public_copy_provenance(
        {
            "schemaMarkup": english_artifact["schemaMarkup"],
            "evidenceLedger": create_pdp_geo_evidence_ledger(english, "en-US"),
            "contentPlan": {"mode": "conservative"},
        }
    )

    korean = _korean_source_product()
    korean["benefits"] = []
    korean["effects"] = []
    korean["usage"] = ["세안 후 스킨케어 첫 단계에 사용해 피부결을 정돈하고 수분을 공급합니다."]
    korean_artifact = generate_pdp_geo_artifacts({"product": korean, "locale": "ko-KR"})
    korean_provenance = create_pdp_geo_public_copy_provenance(
        {
            "schemaMarkup": korean_artifact["schemaMarkup"],
            "evidenceLedger": create_pdp_geo_evidence_ledger(korean, "ko-KR"),
            "contentPlan": {"mode": "conservative"},
        }
    )

    assert any(item["fieldPath"] == "Product.description" for item in english_provenance)
    korean_descriptions = {
        kind: cast(str, _node(korean_artifact["schemaMarkup"], kind)["description"])
        for kind in ("Product", "WebPage")
    }
    korean_by_path = {item["fieldPath"]: item for item in korean_provenance}
    for kind, description in korean_descriptions.items():
        assert "예시 랩의 배리어 세럼" in description
        assert "촉촉한 사용감" in description
        entry = korean_by_path[f"{kind}.description"]
        assert entry["text"] == description
        assert all(sentence["evidenceIds"] for sentence in entry["sentences"])

    korean_validation = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": korean_artifact["schemaMarkup"],
            "content": korean_artifact["content"],
            "locale": "ko-KR",
            "sourceProduct": korean,
            "evidenceLedger": create_pdp_geo_evidence_ledger(korean, "ko-KR"),
            "publicCopyProvenance": korean_provenance,
        }
    )
    assert not [
        finding
        for finding in korean_validation["validationFindings"]
        if finding["source"] == "public-copy-provenance"
        and finding["field"] in {"Product.description", "WebPage.description"}
    ]


def test_round5_sensitive_target_frames_block_generic_lexical_fallback() -> None:
    """An unmentioned population, body site, or life stage cannot ride on hydration overlap."""

    cases: list[tuple[str, str, str, str, bool]] = [
        (
            "en-US",
            "Barrier Serum supports hydration.",
            "Barrier Serum supports hydration in newborns.",
            "What does Barrier Serum state about newborns?",
            False,
        ),
        (
            "en-US",
            "Barrier Serum supports hydration.",
            "Barrier Serum supports hydration on infant skin.",
            "What does Barrier Serum state about infant skin?",
            False,
        ),
        (
            "en-US",
            "Barrier Serum supports hydration.",
            "Barrier Serum supports hydration during pregnancy.",
            "What does Barrier Serum state about pregnancy?",
            False,
        ),
        (
            "ko-KR",
            "배리어 세럼은 수분 케어를 지원합니다.",
            "배리어 세럼은 신생아용으로 수분 케어를 지원합니다.",
            "배리어 세럼은 신생아용으로 무엇을 지원하나요?",
            False,
        ),
        (
            "ko-KR",
            "배리어 세럼은 수분 케어를 지원합니다.",
            "배리어 세럼은 영유아도 수분 케어를 지원합니다.",
            "배리어 세럼은 영유아도 무엇을 지원하나요?",
            False,
        ),
        (
            "ko-KR",
            "배리어 세럼은 수분 케어를 지원합니다.",
            "배리어 세럼은 신생아 피부에 수분 케어를 지원합니다.",
            "배리어 세럼은 신생아 피부에 무엇을 지원하나요?",
            False,
        ),
        (
            "en-US",
            "Barrier Serum supports hydration in newborns.",
            "Barrier Serum supports hydration in newborns.",
            "What does Barrier Serum state about newborns?",
            True,
        ),
        (
            "ko-KR",
            "배리어 세럼은 신생아 피부에 수분 케어를 지원합니다.",
            "배리어 세럼은 신생아 피부에 수분 케어를 지원합니다.",
            "배리어 세럼은 신생아 피부에 무엇을 지원하나요?",
            True,
        ),
    ]

    for locale, source, answer, question, expected in cases:
        product = _source_product() if locale == "en-US" else _korean_source_product()
        product["benefits"] = []
        product["effects"] = []
        product["sourceTexts"] = [source]
        product["semanticFacts"] = {}
        plan = _model_plan(product)
        plan["faq"] = [
            {
                "include": True,
                "question": question,
                "answer": answer,
                "intent": "benefit",
                "cep": "",
                "evidenceIds": ["source"],
                "confidence": 1,
                "omitReason": "",
            }
        ]

        artifact = generate_pdp_geo_artifacts({"product": product, "locale": locale, "contentPlan": plan})
        answers = [
            cast(dict[str, str], item["acceptedAnswer"])["text"]
            for node in cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])
            if "FAQPage" in (node["@type"] if isinstance(node["@type"], list) else [node["@type"]])
            for item in cast(list[dict[str, Any]], node.get("mainEntity", []))
        ]

        assert (answer in answers) is expected


def test_round5_identity_only_efficacy_fails_every_public_provenance_path() -> None:
    """A product name alone cannot substantiate a copular efficacy complement."""

    description = "Barrier Serum is effective for eczema."
    path = "Product.description"
    ledger: list[dict[str, Any]] = [
        {
            "id": "identity-only",
            "role": "identity",
            "text": "Barrier Serum",
            "sourcePath": "product.name",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        }
    ]
    markup = serialize_schema_markup(
        {"@context": "https://schema.org", "@graph": [{"@type": "Product", "name": "Barrier Serum", "description": description}]}
    )
    provenance: list[dict[str, Any]] = [
        {
            "fieldPath": path,
            "text": description,
            "sourceHash": stable_text_hash(f"{path}\n{description}"),
            "evidenceIds": ["identity-only"],
            "sentences": [
                {
                    "text": description,
                    "sourceHash": stable_text_hash(f"{path}#sentence[0]\n{description}"),
                    "evidenceIds": ["identity-only"],
                }
            ],
        }
    ]
    payload: dict[str, Any] = {
        "schemaMarkup": markup,
        "content": {"html": "", "sections": {"description": description}},
        "evidenceLedger": ledger,
        "publicCopyProvenance": provenance,
    }

    generated = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": markup, "evidenceLedger": ledger, "contentPlan": {"mode": "conservative"}}
    )
    disabled = asyncio.run(final_proofread_pdp_geo_artifacts(payload, {"finalProofreading": {"enabled": False}}))
    report = validate_pdp_geo_artifacts(payload)

    assert generated == []
    assert disabled["finalPublicCopyProvenance"] == []
    assert any(finding["field"] == path and finding["source"] == "public-copy-provenance" for finding in report["validationFindings"])

    identity_description = "Barrier Serum is a serum."
    identity_ledger = [{**ledger[0], "text": identity_description}]
    identity_markup = serialize_schema_markup(
        {
            "@context": "https://schema.org",
            "@graph": [{"@type": "Product", "name": "Barrier Serum", "description": identity_description}],
        }
    )
    identity_provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": identity_markup, "evidenceLedger": identity_ledger, "contentPlan": {"mode": "conservative"}}
    )

    assert [item["fieldPath"] for item in identity_provenance] == [path]


def test_round5_sparse_korean_model_webpage_copy_is_entity_centric_and_distinct() -> None:
    """Every sparse Korean model shape needs its own product-centered page overview."""

    cases: list[tuple[str, str, str, str]] = [
        ("", "수분 세럼은 가벼운 제형입니다.", "수분 세럼", "가벼운 제형"),
        ("라온랩", "가벼운 제형의 보습 세럼입니다.", "라온랩의 수분 세럼", "가벼운 제형의 보습 세럼"),
    ]
    for brand, source_description, entity, source_phrase in cases:
        product = _korean_source_product()
        product.update(
            {
                "name": "수분 세럼",
                "brand": brand,
                "category": "세럼",
                "description": source_description,
                "ingredients": [],
                "benefits": [],
                "effects": [],
                "usage": [],
                "reviews": {"items": [], "keywords": []},
                "sourceTexts": [source_description],
                "semanticFacts": {},
            }
        )
        artifact = generate_pdp_geo_artifacts(
            {"product": product, "locale": "ko-KR", "contentPlan": _approved_copy_plan(product)}
        )
        product_description = _node(artifact["schemaMarkup"], "Product")["description"]
        webpage_description = _node(artifact["schemaMarkup"], "WebPage")["description"]
        provenance = create_pdp_geo_public_copy_provenance(
            {
                "schemaMarkup": artifact["schemaMarkup"],
                "evidenceLedger": create_pdp_geo_evidence_ledger(product, "ko-KR"),
                "contentPlan": _approved_copy_plan(product),
            }
        )
        webpage_provenance = next(item for item in provenance if item["fieldPath"] == "WebPage.description")

        assert webpage_description.startswith(entity)
        assert source_phrase in product_description and source_phrase in webpage_description
        assert webpage_description != product_description
        assert "상품 페이지" not in webpage_description
        assert "Reported" not in webpage_description
        assert all(sentence["evidenceIds"] for sentence in webpage_provenance["sentences"])


def test_round5_negative_korean_review_signal_is_omitted_from_public_schema_surfaces() -> None:
    """A negative or mixed keyword stays out of descriptions, properties, and schema Review nodes."""

    direct_review_signal = "촉촉하지 않음, 산뜻한 마무리"
    product = _korean_source_product()
    product.update(
        {
            "name": "리뷰 세럼",
            "brand": "",
            "description": "리뷰 세럼은 가벼운 제형입니다.",
            "ingredients": ["세라마이드", "판테놀", "스쿠알란"],
            "benefits": [],
            "effects": [],
            "usage": [],
            "reviews": {"items": [], "keywords": [direct_review_signal]},
            "sourceTexts": ["전성분: 세라마이드, 판테놀, 스쿠알란"],
            "semanticFacts": {},
        }
    )

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "ko-KR"})
    rendered_product = _node(artifact["schemaMarkup"], "Product")
    description = cast(str, rendered_product["description"])
    properties = cast(list[dict[str, Any]], rendered_product["additionalProperty"])
    review_properties = [item for item in properties if item["name"] == "Customer review signal"]
    all_public_values = "\n".join([description, *(cast(str, item["value"]) for item in properties)])

    assert direct_review_signal not in all_public_values
    assert review_properties == []
    assert "review" not in rendered_product
    assert "Review-derived recommendation context" not in [item["name"] for item in properties]
    assert "Customer review context" not in [item["name"] for item in properties]
    assert "Consumer satisfaction" not in [item["name"] for item in properties]
    for unsupported_interpretation in ("촉촉한 사용감", "긍정적으로 평가했습니다", "참고할 수 있습니다", "민감한 피부 고객", "추천"):
        assert unsupported_interpretation not in all_public_values


def test_round5_negative_review_signal_is_diagnostic_only_without_public_recasting() -> None:
    """Diagnostics retain the raw signal while public output omits it and adds no praise."""

    direct_review_signal = "촉촉하지 않음, 산뜻한 마무리"
    product = _korean_source_product()
    product.update(
        {
            "name": "리뷰 세럼",
            "brand": "",
            "description": "리뷰 세럼은 건조한 피부를 위한 세럼입니다.",
            "ingredients": ["세라마이드", "판테놀", "스쿠알란"],
            "benefits": ["보습", "피부 장벽"],
            "effects": [],
            "usage": [],
            "reviews": {"items": [], "keywords": [direct_review_signal]},
            "sourceTexts": ["전성분: 세라마이드, 판테놀, 스쿠알란"],
            "semanticFacts": {"skinTypes": ["건조한 피부"]},
        }
    )

    run = asyncio.run(
        generate_pdp_geo(
            {"product": product, "hints": {"locale": "ko-KR"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    review_queries = [
        item
        for item in cast(list[dict[str, Any]], run["diagnostics"]["inferredSearchQueries"])
        if direct_review_signal in json.dumps(item, ensure_ascii=False)
    ]
    review_recommendations = [
        item
        for item in cast(list[dict[str, Any]], run["diagnostics"]["recommendations"])
        if direct_review_signal in json.dumps(item, ensure_ascii=False)
    ]
    public_output = json.dumps(
        {"schemaMarkup": run["result"]["schemaMarkup"], "content": run["result"]["content"]},
        ensure_ascii=False,
    )

    assert direct_review_signal not in public_output
    assert len(review_queries) == 1
    assert review_queries[0]["answer"] == direct_review_signal
    assert len(review_recommendations) == 1
    assert review_recommendations[0]["field"] == "review"
    assert review_recommendations[0]["message"] == direct_review_signal
    assert all("긍정" not in value and "positive" not in value.casefold() for value in (json.dumps(item, ensure_ascii=False) for item in review_recommendations))
    for unsupported_interpretation in (
        "긍정",
        "positive",
        "평가했습니다",
        "건조하고 민감한 피부 고객",
        "사용감 판단에 도움",
    ):
        assert unsupported_interpretation not in public_output


def test_round6_fronted_sensitive_targets_fail_publication_and_provenance() -> None:
    """A target placed before the entity cannot evade direct source-frame checks."""

    cases: list[tuple[str, str, str, str, bool]] = [
        (
            "en-US",
            "Barrier Serum supports hydration.",
            "In newborns, Barrier Serum supports hydration.",
            "What does Barrier Serum state about newborns?",
            False,
        ),
        (
            "en-US",
            "Barrier Serum supports hydration.",
            "On infant skin, Barrier Serum supports hydration.",
            "What does Barrier Serum state about infant skin?",
            False,
        ),
        (
            "en-US",
            "Barrier Serum supports hydration.",
            "During pregnancy, Barrier Serum supports hydration.",
            "What does Barrier Serum state about pregnancy?",
            False,
        ),
        (
            "ko-KR",
            "배리어 세럼은 수분 케어를 지원합니다.",
            "신생아용으로 배리어 세럼은 수분 케어를 지원합니다.",
            "배리어 세럼은 신생아용으로 무엇을 지원하나요?",
            False,
        ),
        (
            "ko-KR",
            "배리어 세럼은 수분 케어를 지원합니다.",
            "영유아도 배리어 세럼은 수분 케어를 지원합니다.",
            "배리어 세럼은 영유아도 무엇을 지원하나요?",
            False,
        ),
        (
            "ko-KR",
            "배리어 세럼은 수분 케어를 지원합니다.",
            "신생아 피부에 배리어 세럼은 수분 케어를 지원합니다.",
            "배리어 세럼은 신생아 피부에 무엇을 지원하나요?",
            False,
        ),
        (
            "en-US",
            "In newborns, Barrier Serum supports hydration.",
            "In newborns, Barrier Serum supports hydration.",
            "What does Barrier Serum state about newborns?",
            True,
        ),
        (
            "en-US",
            "On infant skin, Barrier Serum supports hydration.",
            "On infant skin, Barrier Serum supports hydration.",
            "What does Barrier Serum state about infant skin?",
            True,
        ),
        (
            "en-US",
            "During pregnancy, Barrier Serum supports hydration.",
            "During pregnancy, Barrier Serum supports hydration.",
            "What does Barrier Serum state about pregnancy?",
            True,
        ),
        (
            "ko-KR",
            "신생아용으로 배리어 세럼은 수분 케어를 지원합니다.",
            "신생아용으로 배리어 세럼은 수분 케어를 지원합니다.",
            "배리어 세럼은 신생아용으로 무엇을 지원하나요?",
            True,
        ),
        (
            "ko-KR",
            "영유아도 배리어 세럼은 수분 케어를 지원합니다.",
            "영유아도 배리어 세럼은 수분 케어를 지원합니다.",
            "배리어 세럼은 영유아도 무엇을 지원하나요?",
            True,
        ),
        (
            "ko-KR",
            "신생아 피부에 배리어 세럼은 수분 케어를 지원합니다.",
            "신생아 피부에 배리어 세럼은 수분 케어를 지원합니다.",
            "배리어 세럼은 신생아 피부에 무엇을 지원하나요?",
            True,
        ),
    ]

    for locale, source, claim, question, expected in cases:
        product = _source_product() if locale == "en-US" else _korean_source_product()
        product.update({"description": source, "benefits": [], "effects": [], "sourceTexts": [source], "semanticFacts": {}})
        plan = _model_plan(product)
        plan["faq"] = [
            {
                "include": True,
                "question": question,
                "answer": claim,
                "intent": "benefit",
                "cep": "",
                "evidenceIds": ["direct-source"],
                "confidence": 1,
                "omitReason": "",
            }
        ]
        artifact = generate_pdp_geo_artifacts({"product": product, "locale": locale, "contentPlan": plan})
        published_answers = [
            cast(dict[str, str], item["acceptedAnswer"])["text"]
            for node in cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])
            if "FAQPage" in (node["@type"] if isinstance(node["@type"], list) else [node["@type"]])
            for item in cast(list[dict[str, Any]], node.get("mainEntity", []))
        ]

        path = "Product.description"
        ledger: list[dict[str, Any]] = [
            {
                "id": "direct-source",
                "role": "source",
                "text": source,
                "sourcePath": "product.sourceTexts[0]",
                "locale": locale,
                "productScope": "product",
                "confidence": 1,
            }
        ]
        markup = serialize_schema_markup(
            {"@context": "https://schema.org", "@graph": [{"@type": "Product", "name": product["name"], "description": claim}]}
        )
        supplied_provenance = [
            {
                "fieldPath": path,
                "text": claim,
                "sourceHash": stable_text_hash(f"{path}\n{claim}"),
                "evidenceIds": ["direct-source"],
                "sentences": [
                    {
                        "text": claim,
                        "sourceHash": stable_text_hash(f"{path}#sentence[0]\n{claim}"),
                        "evidenceIds": ["direct-source"],
                    }
                ],
            }
        ]
        payload = {
            "schemaMarkup": markup,
            "content": {"html": "", "sections": {"description": claim}},
            "evidenceLedger": ledger,
            "publicCopyProvenance": supplied_provenance,
        }
        generated = create_pdp_geo_public_copy_provenance(
            {"schemaMarkup": markup, "evidenceLedger": ledger, "contentPlan": {"mode": "conservative"}}
        )
        disabled = asyncio.run(final_proofread_pdp_geo_artifacts(payload, {"finalProofreading": {"enabled": False}}))
        validation = validate_pdp_geo_artifacts(payload)
        provenance_findings = [
            finding
            for finding in validation["validationFindings"]
            if finding["field"] == path and finding["source"] == "public-copy-provenance"
        ]

        assert (claim in published_answers) is expected
        assert (any(item["fieldPath"] == path for item in generated)) is expected
        assert (any(item["fieldPath"] == path for item in disabled["finalPublicCopyProvenance"])) is expected
        assert bool(provenance_findings) is not expected


def test_round6_sparse_non_copular_korean_webpage_description_keeps_direct_provenance() -> None:
    """An entity-prefixed Korean page lead may retain a direct non-copular suffix."""

    cases = [
        ("", "피부에 빠르게 흡수됩니다.", "수분 세럼", "피부에 빠르게 흡수됩니다."),
        ("라온랩", "산뜻하게 마무리됩니다.", "라온랩의 수분 세럼", "산뜻하게 마무리됩니다."),
    ]
    for brand, source_description, entity, source_suffix in cases:
        product = _korean_source_product()
        product.update(
            {
                "name": "수분 세럼",
                "brand": brand,
                "category": "세럼",
                "description": source_description,
                "ingredients": [],
                "benefits": [],
                "effects": [],
                "usage": [],
                "reviews": {"items": [], "keywords": []},
                "sourceTexts": [source_description],
                "semanticFacts": {},
            }
        )
        plan = _approved_copy_plan(product)
        artifact = generate_pdp_geo_artifacts({"product": product, "locale": "ko-KR", "contentPlan": plan})
        product_description = cast(str, _node(artifact["schemaMarkup"], "Product")["description"])
        webpage_description = cast(str, _node(artifact["schemaMarkup"], "WebPage")["description"])
        ledger = create_pdp_geo_evidence_ledger(product, "ko-KR")
        provenance = create_pdp_geo_public_copy_provenance(
            {"schemaMarkup": artifact["schemaMarkup"], "evidenceLedger": ledger, "contentPlan": plan}
        )
        webpage_entries = [item for item in provenance if item["fieldPath"] == "WebPage.description"]
        validation = validate_pdp_geo_artifacts(
            {
                "schemaMarkup": artifact["schemaMarkup"],
                "content": artifact["content"],
                "evidenceLedger": ledger,
                "publicCopyProvenance": provenance,
            }
        )

        assert product_description.startswith(entity)
        assert webpage_description.startswith(entity)
        assert source_suffix in product_description and source_suffix in webpage_description
        assert product_description != webpage_description
        assert "상품 페이지" not in webpage_description
        assert len(webpage_entries) == 1
        assert all(sentence["evidenceIds"] for sentence in webpage_entries[0]["sentences"])
        assert not any(
            finding["field"] == "WebPage.description" and finding["source"] == "public-copy-provenance"
            for finding in validation["validationFindings"]
        )


def test_round6_review_diagnostics_and_queries_keep_review_role_isolated() -> None:
    """A mixed review signal cannot be filed or searched as a product benefit."""

    direct_review_signal = "촉촉하지 않음, 산뜻한 마무리"
    product = _korean_source_product()
    product.update(
        {
            "name": "리뷰 세럼",
            "brand": "",
            "description": "리뷰 세럼은 건조한 피부를 위한 세럼입니다.",
            "ingredients": ["세라마이드", "판테놀", "스쿠알란"],
            "benefits": ["보습", "피부 장벽"],
            "effects": [],
            "usage": [],
            "reviews": {"items": [], "keywords": [direct_review_signal]},
            "sourceTexts": ["전성분: 세라마이드, 판테놀, 스쿠알란"],
            "semanticFacts": {"skinTypes": ["건조한 피부"]},
        }
    )

    run = asyncio.run(
        generate_pdp_geo(
            {"product": product, "hints": {"locale": "ko-KR"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    review_queries = [
        item
        for item in cast(list[dict[str, Any]], run["diagnostics"]["inferredSearchQueries"])
        if item["source"] == "review-signal"
    ]
    review_signal_diagnostics = [
        item
        for item in cast(list[dict[str, Any]], run["diagnostics"]["recommendations"])
        if direct_review_signal in json.dumps(item, ensure_ascii=False)
    ]
    review_recommendations = [item for item in review_signal_diagnostics if item["field"] == "review"]

    assert len(review_queries) == 1
    assert review_queries[0]["keywords"] == [direct_review_signal]
    assert review_queries[0]["answer"] == direct_review_signal
    assert all(item["field"] != "benefits" for item in review_signal_diagnostics)
    assert len(review_recommendations) == 1
    assert review_recommendations[0]["field"] == "review"
    assert review_recommendations[0]["message"] == direct_review_signal
    for surface in [*review_queries, *review_recommendations]:
        serialized = json.dumps(surface, ensure_ascii=False)
        for unrelated_role_or_linkage in ("보습", "피부 장벽", "세라마이드", "판테놀", "스쿠알란", "효능", "추천", "적합"):
            assert unrelated_role_or_linkage not in serialized


def test_formula_faq_stays_category_neutral_for_a_source_grounded_hair_product() -> None:
    """A formula FAQ must not inject a skin premise into a shampoo's source facts."""

    source = "Betaine helps maintain hair softness."
    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "name": "Ocean Mineral Shampoo",
                    "brand": "Example Brand",
                    "category": "shampoo",
                    "description": "Ocean Mineral Shampoo is a shampoo.",
                    "ingredients": ["Betaine"],
                    "benefits": [],
                    "effects": [],
                    "usage": [],
                    "metrics": [],
                    "options": [],
                    "faq": [],
                    "reviews": {"items": [], "keywords": []},
                    "sourceTexts": [source],
                    "semanticFacts": {
                        "ingredientBenefitLinks": [
                            {
                                "ingredient": "Betaine",
                                "benefit": "maintain hair softness",
                                "sourceText": source,
                            }
                        ]
                    },
                },
                "hints": {"locale": "en-US"},
            },
            {"qualityGate": {"enabled": False}},
        )
    )

    faq = _node(run["result"]["schemaMarkup"], "FAQPage")["mainEntity"]
    assert len(faq) == 1
    assert "Ocean Mineral Shampoo" in faq[0]["name"]
    assert "skin" not in faq[0]["name"].casefold()
    assert "Example Brand's Ocean Mineral Shampoo" in faq[0]["acceptedAnswer"]["text"]
    assert source in faq[0]["acceptedAnswer"]["text"]
    assert not any(
        item["field"] == "FAQPage.mainEntity[0].name"
        for item in run["diagnostics"].get("publicCopyOmissions", [])
    )


def test_buyer_faq_preserves_an_explicit_non_skin_audience_and_formula_relation() -> None:
    """A direct audience sentence can lead a buyer FAQ without a skin-only premise."""

    audience = "Ocean Mineral Shampoo is designed for color-treated hair."
    formula = "Betaine helps maintain hair softness."
    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "name": "Ocean Mineral Shampoo",
                    "brand": "Example Brand",
                    "category": "shampoo",
                    "description": audience,
                    "ingredients": ["Betaine"],
                    "sourceTexts": [formula],
                    "semanticFacts": {
                        "ingredientBenefitLinks": [
                            {"ingredient": "Betaine", "benefit": "maintain hair softness", "sourceText": formula}
                        ]
                    },
                },
                "hints": {"locale": "en-US"},
            },
            {"qualityGate": {"enabled": False}},
        )
    )

    faq = _node(run["result"]["schemaMarkup"], "FAQPage")["mainEntity"]
    assert len(faq) == 1
    assert faq[0]["name"] == "Who is Example Brand's Ocean Mineral Shampoo designed for?"
    assert "designed for color-treated hair" in faq[0]["acceptedAnswer"]["text"]
    assert formula in faq[0]["acceptedAnswer"]["text"]
    assert "recommend" not in faq[0]["acceptedAnswer"]["text"].casefold()


def test_direct_benefit_predicates_reject_commerce_usage_review_and_suitability_context() -> None:
    """Predicate verbs are not benefits when their source role says otherwise."""

    rejected = [
        "Offers free shipping.",
        "Helps with returns.",
        "Provides a 30-day refund.",
        "Offers shoppers a coupon.",
        "Apply daily to help remove buildup.",
        "Use after shampoo to help maintain softness.",
        "Customers say it helps detangle hair.",
        "Helps determine whether the product is right for you.",
        "무료 배송에 도움을 줍니다.",
        "반품 처리를 돕습니다.",
        "매일 사용하면 노폐물 제거에 도움을 줍니다.",
    ]
    retained = ["Supports hair softness.", "모발의 부드러움 유지에 도움을 줍니다."]

    for statement in rejected:
        roles = infer_pdp_evidence_roles(statement)["roles"]
        normalized = normalize_pdp_product(
            {"name": "Example Product", "benefits": [statement], "sourceTexts": [statement]},
            {"hints": {"locale": "ko-KR" if any("가" <= char <= "힣" for char in statement) else "en-US"}},
        )
        assert "benefit" not in roles
        assert normalized["product"]["benefits"] == []

    for statement in retained:
        normalized = normalize_pdp_product(
            {"name": "Example Product", "benefits": [statement], "sourceTexts": [statement]},
            {"hints": {"locale": "ko-KR" if any("가" <= char <= "힣" for char in statement) else "en-US"}},
        )
        assert statement in normalized["product"]["benefits"]


def test_effect_admission_rejects_non_product_context_but_keeps_direct_outcomes() -> None:
    """Effects use the same role boundary as benefits instead of bypassing it."""

    rejected = [
        "Supports free shipping.",
        "Supports easy returns.",
        "Customers report improved softness.",
        "Clinically tested for sensitive skin.",
        "Apply daily to improve softness.",
    ]

    for statement in rejected:
        normalized = normalize_pdp_product(
            {"name": "Ocean Shampoo", "effects": [statement], "sourceTexts": [statement]},
            {"hints": {"locale": "en-US"}},
        )
        assert "effect" not in infer_pdp_evidence_roles(statement)["roles"]
        assert normalized["product"]["effects"] == []

    retained = "Supports hair softness."
    normalized = normalize_pdp_product(
        {"name": "Ocean Shampoo", "effects": [retained], "sourceTexts": [retained]},
        {"hints": {"locale": "en-US"}},
    )
    assert normalized["product"]["effects"] == [retained]


def test_safety_and_negative_audience_text_never_becomes_a_recommended_skin_type() -> None:
    """Cautions stay source/safety evidence, while an explicit positive audience remains usable."""

    rejected = [
        "Not recommended for sensitive skin.",
        "Patch test before use on sensitive skin.",
        "Avoid use on dry skin.",
    ]
    for statement in rejected:
        run = asyncio.run(
            generate_pdp_geo(
                {
                    "product": {
                        "name": "Ocean Shampoo",
                        "brand": "North Coast",
                        "category": "shampoo",
                        "ingredients": ["Betaine"],
                        "semanticFacts": {"skinTypes": [statement], "evidenceSentences": [statement]},
                        "sourceTexts": [statement],
                    },
                    "hints": {"locale": "en-US"},
                },
                {"provider": "mock", "qualityGate": {"enabled": False}},
            )
        )
        properties = _node(run["result"]["schemaMarkup"], "Product")["additionalProperty"]
        derived = [
            str(item["value"])
            for item in run["diagnostics"]["evidence"]
            if str(item["field"]).startswith("diagnostics.productAttribute.")
        ]
        rendered = "\n".join(
            [run["result"]["content"]["sections"]["quickFacts"], *(item["value"] for item in properties), *derived]
        )
        # Safety and negative-audience text is never a recommended skin type.
        # Only keyword attributes are published now, so the statement is
        # retained where it belongs -- the derived safety attribute and the
        # description -- rather than under a recommendation label.
        assert "Recommended skin type" not in rendered
        assert not any(item["name"] == "Recommended skin type" for item in properties)
        assert statement in rendered
        assert statement in " ".join(derived)

    positive = "Suitable for sensitive skin."
    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "name": "Ocean Shampoo",
                    "brand": "North Coast",
                    "category": "shampoo",
                    "ingredients": ["Betaine"],
                    "semanticFacts": {"skinTypes": [positive], "evidenceSentences": [positive]},
                    "sourceTexts": [positive],
                },
                "hints": {"locale": "en-US"},
            },
            {"provider": "mock", "qualityGate": {"enabled": False}},
        )
    )
    properties = _node(run["result"]["schemaMarkup"], "Product")["additionalProperty"]
    # A positive audience statement still becomes the audience attribute; only
    # its label changed, because the published set names the customer once.
    assert any(item["name"] == "Target customer" and item["value"] == "sensitive skin" for item in properties)


def test_negative_audience_and_safety_evidence_are_not_recast_as_public_customer_targeting() -> None:
    """Safety wording remains source evidence without becoming a recommendation or skin-type field."""

    cases = [
        {
            "locale": "en-US",
            "product": {
                "name": "Ocean Shampoo",
                "brand": "North Coast",
                "category": "shampoo",
                "description": "Not recommended for sensitive skin.",
                "ingredients": ["Betaine"],
                "sourceTexts": ["Not recommended for sensitive skin."],
            },
            "forbidden": ("customers with sensitive skin",),
        },
        {
            "locale": "ko-KR",
            "product": {
                "name": "바다 샴푸",
                "brand": "노스코스트",
                "category": "샴푸",
                "description": "바다 샴푸는 모발을 세정합니다.",
                "ingredients": ["베타인", "바다 소금", "글리세린"],
                "benefits": ["모발 부드러움에 도움을 줍니다."],
                "sourceTexts": ["민감 피부 대상 피부 자극 테스트를 완료했습니다."],
                "semanticFacts": {"safetyTests": ["민감 피부 대상 피부 자극 테스트를 완료했습니다."]},
            },
            "forbidden": ("민감 피부 고객",),
        },
    ]
    for case in cases:
        run = asyncio.run(
            generate_pdp_geo(
                {"product": case["product"], "hints": {"locale": case["locale"]}},
                {"provider": "mock", "qualityGate": {"enabled": False}},
            )
        )
        product = _node(run["result"]["schemaMarkup"], "Product")
        properties = product.get("additionalProperty", [])
        public_values = "\n".join(
            [product.get("description", ""), *(str(item.get("value", "")) for item in properties)]
        )

        assert not any(item.get("name") == "Recommended skin type" for item in properties)
        assert all(value not in public_values.casefold() for value in case["forbidden"])


def test_direct_safety_text_is_retained_without_becoming_a_customer_target() -> None:
    """A direct safety statement is meaningful product information, not an optional review or audience clue."""

    safety = "For external use only."
    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "name": "Ocean Shampoo",
                    "brand": "North Coast",
                    "category": "shampoo",
                    "description": "Ocean Shampoo cleanses hair.",
                    "ingredients": ["Betaine", "Sea Salt", "Glycerin"],
                    "benefits": ["Supports hair softness."],
                    "sourceTexts": ["Ocean Shampoo cleanses hair.", safety],
                    "semanticFacts": {"safetyTests": [safety]},
                },
                "hints": {"locale": "en-US"},
            },
            {"provider": "mock", "qualityGate": {"enabled": False}},
        )
    )
    product = _node(run["result"]["schemaMarkup"], "Product")
    public_values = "\n".join(
        [product.get("description", ""), *(str(item.get("value", "")) for item in product.get("additionalProperty", []))]
    )

    assert safety in public_values
    assert "Recommended skin type" not in public_values


def test_direct_safety_guidance_survives_in_english_and_korean() -> None:
    """Safety-role evidence is preserved verbatim without recasting it as targeting."""

    cases = [
        (
            "en-US",
            "Ocean Shampoo",
            "North Coast",
            ["Keep out of reach of children.", "Avoid contact with eyes.", "Do not swallow."],
        ),
        (
            "ko-KR",
            "바다 샴푸",
            "노스코스트",
            [
                "어린이의 손이 닿지 않는 곳에 보관하십시오.",
                "눈에 들어가지 않도록 주의하십시오.",
                "먹지 마십시오.",
                "이상이 있는 경우 사용을 중지하십시오.",
            ],
        ),
    ]
    for locale, name, brand, safety_values in cases:
        artifact = generate_pdp_geo_artifacts(
            {
                "product": {
                    "name": name,
                    "brand": brand,
                    "category": "shampoo",
                    "description": f"{name} cleanses hair." if locale == "en-US" else f"{name}는 모발을 세정합니다.",
                    "sourceTexts": safety_values,
                    "semanticFacts": {"safetyTests": safety_values},
                },
                "locale": locale,
            }
        )
        product = _node(artifact["schemaMarkup"], "Product")
        public_values = "\n".join(
            [
                product.get("description", ""),
                *(str(item.get("value", "")) for item in product.get("additionalProperty", [])),
            ]
        )
        assert all(value in public_values for value in safety_values)
        assert "Recommended skin type" not in public_values


def test_typed_source_safety_facts_are_preserved_without_lexical_rediscovery() -> None:
    """A source-backed safety role stays public even when its wording is not a known caution cue."""

    cases = [
        (
            "en-US",
            "Ocean Shampoo",
            "North Coast",
            [
                "Do not expose to direct sunlight.",
                "Store in a cool, dry place.",
                "If irritation occurs, stop using the product.",
                "Use only as directed.",
                "Allergy tested.",
                "Ophthalmologist tested.",
                "Keep away from heat and flame.",
            ],
        ),
        (
            "ko-KR",
            "바다 샴푸",
            "노스코스트",
            [
                "직사광선을 피해 보관하십시오.",
                "서늘하고 건조한 곳에 보관하십시오.",
                "이상 증상이 나타나면 사용을 중단하십시오.",
                "화기에서 멀리 보관하십시오.",
            ],
        ),
    ]
    for locale, name, brand, safety_values in cases:
        artifact = generate_pdp_geo_artifacts(
            {
                "product": {
                    "name": name,
                    "brand": brand,
                    "category": "shampoo",
                    "description": f"{name} cleanses hair." if locale == "en-US" else f"{name}는 모발을 세정합니다.",
                    "semanticFacts": {"safetyTests": safety_values},
                },
                "locale": locale,
            }
        )
        properties = _node(artifact["schemaMarkup"], "Product").get("additionalProperty", [])
        safety_values_out = " ".join(
            item["value"] for item in properties if item.get("name") in {"Safety information", "안전성 안내"}
        )

        assert all(value in safety_values_out for value in safety_values)


def test_safety_publication_keeps_only_safety_sentences_from_mixed_source_text() -> None:
    """Safety classification cannot carry adjacent commerce, review, or usage copy into public output."""

    cases = [
        ("en-US", "Ocean Shampoo", "North Coast", "Free shipping is available. Avoid contact with eyes.", "Avoid contact with eyes."),
        ("en-US", "Ocean Shampoo", "North Coast", "Customers hated the scent. Avoid contact with eyes.", "Avoid contact with eyes."),
        ("en-US", "Ocean Shampoo", "North Coast", "Apply daily. Avoid contact with eyes.", "Avoid contact with eyes."),
        ("ko-KR", "바다 샴푸", "노스코스트", "제품 구매 시 무료배송 혜택이 제공됩니다. 눈에 들어가지 않도록 주의하십시오.", "눈에 들어가지 않도록 주의하십시오."),
        ("ko-KR", "바다 샴푸", "노스코스트", "고객들은 향이 별로였다고 말했습니다. 눈에 들어가지 않도록 주의하십시오.", "눈에 들어가지 않도록 주의하십시오."),
    ]
    for locale, name, brand, source, safety in cases:
        artifact = generate_pdp_geo_artifacts(
            {
                "product": {
                    "name": name,
                    "brand": brand,
                    "category": "shampoo",
                    "description": f"{name} cleanses hair." if locale == "en-US" else f"{name}는 모발을 세정합니다.",
                    "sourceTexts": [source],
                    "semanticFacts": {"safetyTests": [source]},
                },
                "locale": locale,
            }
        )
        product = _node(artifact["schemaMarkup"], "Product")
        public_values = "\n".join(
            [
                product.get("description", ""),
                *(str(item.get("value", "")) for item in product.get("additionalProperty", [])),
            ]
        )
        assert safety in public_values
        assert source not in public_values
        assert "shipping" not in public_values.casefold()
        assert "hated" not in public_values.casefold()
        assert "apply daily" not in public_values.casefold()
        assert "무료배송" not in public_values
        assert "향이 별로" not in public_values


def test_direct_safety_faqs_keep_the_safety_clause_without_adjacent_commerce_or_review_copy() -> None:
    """FAQ source pairs are atomized before public rendering, just like descriptions."""

    cases = [
        (
            "en-US",
            "Ocean Shampoo",
            "North Coast",
            "Is this safe around the eyes?",
            "Avoid contact with eyes. Free shipping is available.",
            "Avoid contact with eyes.",
        ),
        (
            "en-US",
            "Ocean Shampoo",
            "North Coast",
            "Can pregnant people use this?",
            "Consult a healthcare professional before use. Customers love it.",
            "Consult a healthcare professional before use.",
        ),
        (
            "ko-KR",
            "바다 샴푸",
            "노스코스트",
            "눈가에 사용해도 되나요?",
            "눈에 들어가지 않도록 주의하십시오. 무료배송 혜택이 제공됩니다.",
            "눈에 들어가지 않도록 주의하십시오.",
        ),
    ]
    for locale, name, brand, question, answer, safety in cases:
        artifact = generate_pdp_geo_artifacts(
            {
                "product": {
                    "name": name,
                    "brand": brand,
                    "category": "shampoo",
                    "description": f"{name} cleanses hair." if locale == "en-US" else f"{name}는 모발을 세정합니다.",
                    "faq": [{"question": question, "answer": answer}],
                },
                "locale": locale,
            }
        )
        faq = _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"]
        rendered = "\n".join(item["acceptedAnswer"]["text"] for item in faq)
        assert safety in rendered
        assert "shipping" not in rendered.casefold()
        assert "Customers love" not in rendered
        assert "무료배송" not in rendered


def test_admitted_model_faq_rows_are_not_silently_truncated_after_planning() -> None:
    """The renderer preserves every already-admitted FAQ row rather than hiding a plan/schema mismatch."""

    product: dict[str, Any] = {
        "name": "Ocean Shampoo",
        "brand": "North Coast",
        "category": "shampoo",
        "description": "Ocean Shampoo cleanses hair.",
        "usage": [],
    }
    plan = _model_plan({**product, "usage": []})
    plan["_admittedContentPlan"] = True
    plan["faq"] = [
        {
            "include": True,
            "question": f"What source fact {index} is stated for North Coast's Ocean Shampoo?",
            "answer": f"North Coast's Ocean Shampoo has source fact {index}.",
        }
        for index in range(1, 5)
    ]
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    faq = _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"]

    assert len(faq) == 4


def test_description_diagnostic_reports_the_renderer_not_unselected_rag_or_missing_roles() -> None:
    """Sparse source data must not leave a diagnostic that invents RAG use or a six-role narrative."""

    artifact = generate_pdp_geo_artifacts(
        {
            "product": {
                "name": "Ocean Shampoo",
                "brand": "North Coast",
                "category": "shampoo",
                "description": "Ocean Shampoo cleanses hair.",
            },
            "locale": "en-US",
            "ragChunks": [],
        }
    )
    description_evidence = next(item for item in artifact["evidence"] if item["field"] == "content.description")

    assert description_evidence == {
        "field": "content.description",
        "source": "renderer",
        "value": "Deterministic source-backed renderer produced the public description from the normalized product record.",
    }


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("This shampoo is designed for swimmers.", "Ocean Wash from Blue Lab is designed for swimmers."),
        ("The shampoo gently detangles wet hair.", "Ocean Wash from Blue Lab gently detangles wet hair."),
        ("Contains panthenol and helps maintain softness.", "Ocean Wash from Blue Lab contains panthenol and helps maintain softness."),
    ],
)
def test_english_source_description_uses_a_named_grammatical_subject(
    source: str, expected: str
) -> None:
    """A concise source clause is named or omitted, never wrapped as an ungrammatical descriptor."""

    artifact = generate_pdp_geo_artifacts(
        {
            "product": {
                "name": "Ocean Wash",
                "brand": "Blue Lab",
                "category": "shampoo",
                "description": source,
                "sourceTexts": [source],
            },
            "locale": "en-US",
        }
    )
    descriptions = [
        _node(artifact["schemaMarkup"], node_kind)["description"] for node_kind in ("Product", "WebPage")
    ]

    assert all(expected in description for description in descriptions)
    assert all("is described with this shampoo" not in description.casefold() for description in descriptions)
    assert all("is described with the shampoo" not in description.casefold() for description in descriptions)
    assert all("is described with contains" not in description.casefold() for description in descriptions)


def test_korean_category_neutral_audience_is_retained_in_product_copy_and_buyer_faq() -> None:
    """An explicit hair audience remains an audience rather than a skin-only fallback."""

    audience = "바다 미네랄 샴푸는 염색 모발을 위한 샴푸입니다."
    relation = "베타인은 모발 부드러움 유지에 도움을 줍니다."
    artifact = generate_pdp_geo_artifacts(
        {
            "product": {
                "name": "바다 미네랄 샴푸",
                "brand": "노스코스트",
                "category": "샴푸",
                "description": audience,
                "ingredients": ["베타인", "바다 소금", "글리세린"],
                "sourceTexts": [audience, relation],
                "semanticFacts": {
                    "evidenceSentences": [audience, relation],
                    "ingredientBenefitLinks": [
                        {"ingredient": "베타인", "benefit": "모발 부드러움 유지", "sourceText": relation}
                    ],
                },
            },
            "locale": "ko-KR",
        }
    )
    product = _node(artifact["schemaMarkup"], "Product")
    faq = _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"]

    assert audience in product["description"]
    buyer_items = [
        item
        for item in faq
        if "염색 모발" in item["name"] or "염색 모발" in item["acceptedAnswer"]["text"]
    ]
    assert buyer_items
    assert "바다 미네랄 샴푸" in buyer_items[0]["name"]
    assert audience in buyer_items[0]["acceptedAnswer"]["text"]
    assert relation in buyer_items[0]["acceptedAnswer"]["text"]
    assert not any(item["name"] == "Recommended skin type" for item in product.get("additionalProperty", []))


def test_english_category_neutral_audience_is_not_mislabeled_as_a_skin_type_property() -> None:
    """Hair, scalp, or other customer contexts stay targets rather than becoming a skin-type label."""

    audience = "Ocean Shampoo is for color-treated hair."
    artifact = generate_pdp_geo_artifacts(
        {
            "product": {
                "name": "Ocean Shampoo",
                "brand": "North Coast",
                "category": "shampoo",
                "description": audience,
                "sourceTexts": [audience],
                "semanticFacts": {"skinTypes": ["color-treated hair"]},
            },
            "locale": "en-US",
        }
    )
    properties = _node(artifact["schemaMarkup"], "Product").get("additionalProperty", [])

    assert any(item["name"] == "Target customer" and item["value"] == "color-treated hair" for item in properties)
    assert not any(item["name"] == "Recommended skin type" for item in properties)


def test_english_category_neutral_audience_phrasings_reach_a_buyer_faq() -> None:
    """Direct hair/product audience wording is not limited to skin or a fixed verb list."""

    relation = "Betaine helps maintain hair softness."
    for audience in (
        "Ocean Mineral Shampoo for color-treated hair.",
        "Ocean Mineral Shampoo is for color-treated hair.",
        "Ocean Mineral Shampoo was created for color-treated hair.",
        "Ocean Mineral Shampoo is developed for color-treated hair.",
    ):
        artifact = generate_pdp_geo_artifacts(
            {
                "product": {
                    "name": "Ocean Mineral Shampoo",
                    "brand": "North Coast",
                    "category": "shampoo",
                    "description": audience,
                    "ingredients": ["Betaine", "Sea Salt", "Glycerin"],
                    "sourceTexts": [audience, relation],
                    "semanticFacts": {
                        "evidenceSentences": [audience, relation],
                        "ingredientBenefitLinks": [
                            {"ingredient": "Betaine", "benefit": "maintain hair softness", "sourceText": relation}
                        ],
                    },
                },
                "locale": "en-US",
            }
        )
        faq = _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"]
        buyer_items = [
            item
            for item in faq
            if "color-treated hair" in item["name"] or "color-treated hair" in item["acceptedAnswer"]["text"]
        ]
        assert buyer_items
        assert "Ocean Mineral Shampoo" in buyer_items[0]["name"]
        assert audience in buyer_items[0]["acceptedAnswer"]["text"]
        assert relation in buyer_items[0]["acceptedAnswer"]["text"]


@pytest.mark.parametrize(
    ("source", "target"),
    [
        ("This peptide shampoo is designed for swimmers.", "swimmers"),
        ("This capsule mist is intended for athletes.", "athletes"),
    ],
)
def test_explicit_audience_relation_survives_incidental_formula_words(source: str, target: str) -> None:
    """Formula vocabulary does not erase a directly stated, category-neutral customer relation."""

    relation = "Betaine helps maintain hair softness."
    artifact = generate_pdp_geo_artifacts(
        {
            "product": {
                "name": "Wave Care",
                "brand": "Blue Lab",
                "category": "shampoo",
                "description": source,
                "ingredients": ["Betaine", "Sea Salt", "Glycerin"],
                "sourceTexts": [source, relation],
                "semanticFacts": {
                    "evidenceSentences": [source, relation],
                    "ingredientBenefitLinks": [
                        {"ingredient": "Betaine", "benefit": "maintain hair softness", "sourceText": relation}
                    ],
                },
            },
            "locale": "en-US",
        }
    )
    product = _node(artifact["schemaMarkup"], "Product")
    faq = _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"]

    assert any(item["name"] == "Target customer" and target in item["value"] for item in product["additionalProperty"])
    assert any(
        target in item["acceptedAnswer"]["text"] and relation in item["acceptedAnswer"]["text"] for item in faq
    )


@pytest.mark.parametrize("concern", ("brittle hair", "uneven makeup wear"))
def test_category_neutral_solution_concern_faq_uses_one_source_sentence_without_skin_relabeling(concern: str) -> None:
    """A direct solution concern is not simultaneously an audience or a skin-type claim."""

    source = f"A solution for {concern}."
    relation = "Betaine helps maintain softness."
    artifact = generate_pdp_geo_artifacts(
        {
            "product": {
                "name": "Repair Shampoo",
                "brand": "Blue Lab",
                "category": "shampoo",
                "description": source,
                "ingredients": ["Betaine", "Sea Salt", "Glycerin"],
                "benefits": ["Maintains softness"],
                "sourceTexts": [source, relation],
                "semanticFacts": {
                    "evidenceSentences": [source, relation],
                    "ingredientBenefitLinks": [
                        {"ingredient": "Betaine", "benefit": "maintain softness", "sourceText": relation}
                    ],
                },
            },
            "locale": "en-US",
        }
    )
    faq = _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"]
    product_description = _node(artifact["schemaMarkup"], "Product")["description"]
    item = next(entry for entry in faq if relation in entry["acceptedAnswer"]["text"])
    answer = item["acceptedAnswer"]["text"]

    assert concern in item["name"]
    assert "skin concern" not in item["name"].casefold()
    assert "skin type" not in item["name"].casefold()
    assert f"Blue Lab's Repair Shampoo is a solution for {concern}." in answer
    assert answer.count(f"Blue Lab's Repair Shampoo is a solution for {concern}.") == 1
    assert relation in answer
    assert "Blue Lab's Repair Shampoo maintains softness." not in answer
    assert "Blue Lab's Repair Shampoo maintains softness." not in product_description


def test_rich_korean_properties_do_not_hardcode_faq_topics_or_particles() -> None:
    """Rich rendering keeps generic source roles and natural Korean particles for every category."""

    artifact = generate_pdp_geo_artifacts(
        {
            "product": {
                "name": "오션 샴푸",
                "brand": "노스코스트",
                "category": "샴푸",
                "description": "오션 샴푸는 모발을 세정합니다.",
                "ingredients": ["베타인", "바다 소금", "글리세린"],
                "benefits": ["모발 부드러움 유지"],
                "faq": [
                    {"question": "두 제품은 동일한 캡슐인가요?", "answer": "서로 다른 구성입니다. 무료배송 혜택이 제공됩니다."}
                ],
            },
            "locale": "ko-KR",
        }
    )
    product = _node(artifact["schemaMarkup"], "Product")
    properties = product.get("additionalProperty", [])
    values = "\n".join(str(item.get("value", "")) for item in properties)
    queries = json.dumps(artifact["inferredSearchQueries"], ensure_ascii=False)

    assert not any(item.get("name") == "Brand science" for item in properties)
    assert "서로 다른 구성" not in values
    assert "모발 부드러움 유지이" not in values
    assert "모발 부드러움 유지은" not in queries


def test_ocr_coupon_relation_is_diagnostic_only_not_a_product_benefit() -> None:
    """OCR semantic fields use the same commerce gate as ordinary source fields."""

    source = "Coupon supports savings."
    normalized = normalize_pdp_product(
        {
            "name": "Ocean Shampoo",
            "sourceTexts": [source],
            "sourceExtraction": {
                "ocr": {
                    "semanticFacts": {
                        "ingredients": ["Coupon"],
                        "benefits": ["savings"],
                        "ingredientBenefitLinks": [
                            {"ingredient": "Coupon", "benefit": "savings", "sourceText": source}
                        ],
                        "evidenceSentences": [source],
                    }
                }
            },
        },
        {"hints": {"locale": "en-US"}},
    )
    facts = normalized["product"]["semanticFacts"]
    assert facts["benefits"] == []
    assert facts["ingredientBenefitLinks"] == []

    run = asyncio.run(
        generate_pdp_geo(
            {"product": normalized["product"], "hints": {"locale": "en-US"}},
            {"provider": "mock", "qualityGate": {"enabled": False}},
        )
    )
    product = _node(run["result"]["schemaMarkup"], "Product")
    public_values = [str(product.get("description", "")), *(str(item.get("value", "")) for item in product.get("additionalProperty", []))]
    assert source not in "\n".join(public_values)


def test_description_omits_commerce_and_review_copy_but_adds_identity_to_direct_descriptors() -> None:
    """A description is public product copy, not a raw merchant or review field."""

    for source in (
        "Free shipping and easy returns.",
        "Easy returns are available within 30 days.",
        "Ships free with every order.",
        "Save 20% on your first order.",
        "Enjoy 20% off your first order.",
        "Subscribe and save 15%.",
        "Limited-time sale: 20% off.",
        "Customers say they love it.",
        "Verified buyers loved the scent.",
        "Rated five stars by purchasers.",
    ):
        artifact = generate_pdp_geo_artifacts(
            {
                "product": {
                    "name": "Ocean Shampoo",
                    "brand": "North Coast",
                    "category": "shampoo",
                    "description": source,
                    "sourceTexts": [source],
                },
                "locale": "en-US",
            }
        )
        for kind in ("Product", "WebPage"):
            assert source not in _node(artifact["schemaMarkup"], kind).get("description", "")
        assert source not in json.dumps({"schemaMarkup": artifact["schemaMarkup"], "content": artifact["content"]}, ensure_ascii=False)

    for source in (
        "첫 구매 시 20% 할인됩니다.",
        "신규 회원 쿠폰을 받으세요.",
        "무료배송 혜택이 제공됩니다.",
        "정기구독 시 15% 할인됩니다.",
        "구매 시 포인트가 적립됩니다.",
    ):
        artifact = generate_pdp_geo_artifacts(
            {
                "product": {
                    "name": "바다 샴푸",
                    "brand": "노스코스트",
                    "category": "샴푸",
                    "description": source,
                    "sourceTexts": [source],
                },
                "locale": "ko-KR",
            }
        )
        for kind in ("Product", "WebPage"):
            assert source not in _node(artifact["schemaMarkup"], kind).get("description", "")

    for locale, source in (
        ("en-US", "Free shipping is available on every order."),
        ("en-US", "Customers say it smells wonderful."),
        ("en-US", "Rated five stars by reviewers."),
        ("en-US", "Save 20% with subscription."),
        ("ko-KR", "무료 배송 혜택이 제공됩니다."),
        ("ko-KR", "고객 리뷰에서 향이 좋다고 말합니다."),
        ("ko-KR", "리뷰에서 별점 5점을 받았습니다."),
    ):
        artifact = generate_pdp_geo_artifacts(
            {
                "product": {
                    "name": "Ocean Shampoo" if locale == "en-US" else "바다 샴푸",
                    "brand": "North Coast" if locale == "en-US" else "노스코스트",
                    "category": "shampoo",
                    "description": "Ocean Shampoo cleanses hair." if locale == "en-US" else "바다 샴푸는 모발을 세정합니다.",
                    "benefits": [source],
                },
                "locale": locale,
            }
        )
        for kind in ("Product", "WebPage"):
            assert source not in _node(artifact["schemaMarkup"], kind).get("description", "")
        assert source not in json.dumps({"schemaMarkup": artifact["schemaMarkup"], "content": artifact["content"]}, ensure_ascii=False)

    for source in ("Supports hair softness.", "Gentle cleansing for dry hair."):
        artifact = generate_pdp_geo_artifacts(
            {
                "product": {
                    "name": "Ocean Shampoo",
                    "brand": "North Coast",
                    "category": "shampoo",
                    "description": source,
                    "sourceTexts": [source],
                },
                "locale": "en-US",
            }
        )
        for kind in ("Product", "WebPage"):
            description = _node(artifact["schemaMarkup"], kind)["description"]
            assert "Ocean Shampoo from North Coast" in description
            assert "hair softness" in description.casefold() or "gentle cleansing for dry hair" in description.casefold()


def test_mixed_description_keeps_the_supported_product_sentence_and_drops_commerce() -> None:
    """One invalid source sentence must not erase an adjacent product descriptor."""

    source = "Ocean Mineral Shampoo cleanses color-treated hair without added fragrance. Free shipping is available on every order."
    normalized = normalize_pdp_product(
        {
            "name": "Ocean Mineral Shampoo",
            "brand": "North Coast",
            "category": "shampoo",
            "description": source,
            "ingredients": ["Betaine"],
        },
        {"hints": {"locale": "en-US"}},
    )
    assert normalized["product"]["description"] == "Ocean Mineral Shampoo cleanses color-treated hair without added fragrance."

    artifact = generate_pdp_geo_artifacts({"product": normalized["product"], "locale": "en-US"})
    for kind in ("Product", "WebPage"):
        description = _node(artifact["schemaMarkup"], kind)["description"]
        assert "cleanses color-treated hair without added fragrance" in description
        assert "Free shipping" not in description


def test_korean_toner_does_not_invent_an_unlisted_oil_control_benefit() -> None:
    """A category must not add efficacy that the supplied toner source never states."""

    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "name": "맑은결 수분 토너",
                    "brand": "샘플랩",
                    "category": "토너",
                    "description": "맑은결 수분 토너는 피부에 수분을 공급하는 워터 토너입니다.",
                    "ingredients": ["히알루론산", "판테놀", "베타인"],
                    "benefits": ["피부 수분 공급에 도움을 줍니다."],
                    "sourceTexts": [
                        "전성분: 히알루론산, 판테놀, 베타인",
                        "맑은결 수분 토너는 피부에 수분을 공급하는 워터 토너입니다.",
                        "피부 수분 공급에 도움을 줍니다.",
                    ],
                },
                "hints": {"locale": "ko-KR"},
            },
            {"provider": "mock", "qualityGate": {"enabled": False}},
        )
    )

    quick_facts = run["result"]["content"]["sections"]["quickFacts"]
    assert "유분 컨트롤" not in quick_facts
    assert "수분" in quick_facts


def test_english_shampoo_keeps_source_stated_hair_benefits_across_public_surfaces() -> None:
    """Direct non-skin benefit predicates remain valid product facts."""

    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "name": "Ocean Mineral Shampoo",
                    "brand": "North Coast",
                    "category": "shampoo",
                    "description": "Ocean Mineral Shampoo cleanses hair without added fragrance.",
                    "ingredients": ["Betaine", "Sea Salt", "Glycerin"],
                    "benefits": ["Supports hair softness.", "Helps remove daily buildup."],
                    "sourceTexts": [
                        "Key ingredients: Betaine, Sea Salt, Glycerin",
                        "Ocean Mineral Shampoo cleanses hair without added fragrance.",
                        "Supports hair softness.",
                        "Helps remove daily buildup.",
                    ],
                },
                "hints": {"locale": "en-US"},
            },
            {"provider": "mock", "qualityGate": {"enabled": False}},
        )
    )

    sections = run["result"]["content"]["sections"]
    product = _node(run["result"]["schemaMarkup"], "Product")
    assert "hair softness" in sections["benefits"].casefold()
    assert "daily buildup" in sections["benefits"].casefold()
    assert "hair softness" in product["description"].casefold()
    assert "daily buildup" in product["description"].casefold()
    assert "does not include enough benefit details" not in sections["benefits"]


def test_stable_faq_membership_keeps_customer_goal_questions_and_row_scoped_formula_metric_answers() -> None:
    """Model FAQ prose may be natural, but every final sentence stays in its card scope.

    The question deliberately uses a customer goal rather than a raw source
    heading or a product-name echo.  The answer, by contrast, must name the
    brand and product while preserving either one source atom or explicitly
    independent source atoms in separate sentences.
    """

    brand = "Example Lab"
    product = "Glow Serum"
    formula_question = "How should customers assess a serum formula and stated hydration benefit?"
    formula_answer = (
        f"{brand}'s {product} lists Ceramide Complex among its ingredients. "
        "Hydration is among the serum's stated benefits."
    )
    metric_question = "How should customers interpret a four-week home-usage hydration result?"
    metric_answer = (
        f"After 4 weeks of use, 92% of 600 women agreed hydration improved in a home usage test survey "
        f"for {brand}'s {product}."
    )
    ledger: list[dict[str, Any]] = [
        {
            "id": "ev-brand",
            "role": "identity",
            "text": brand,
            "sourcePath": "product.brand",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "ev-product",
            "role": "identity",
            "text": product,
            "sourcePath": "product.name",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "ev-ingredient",
            "role": "ingredient",
            "text": "Ceramide Complex",
            "sourcePath": "product.ingredients[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "ev-benefit",
            "role": "benefit",
            "text": "hydration",
            "sourcePath": "product.benefits[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "ev-metric",
            "role": "metric",
            "text": "After 4 weeks of use, 92% of 600 women agreed hydration improved in a home usage test survey.",
            "sourcePath": "product.semanticFacts.metricClaims[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "ev-other-metric",
            "role": "metric",
            "text": "After 8 weeks of instrumental testing with 30 women, 100% reported visible radiance.",
            "sourcePath": "product.semanticFacts.metricClaims[1]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
    ]
    rows = [
        {
            "id": "faq-formula",
            "include": True,
            "question": formula_question,
            "answer": formula_answer,
            "intent": "formula-and-benefit",
            "evidenceIds": ["ev-brand", "ev-product", "ev-ingredient", "ev-benefit"],
        },
        {
            "id": "faq-metric",
            "include": True,
            "question": metric_question,
            "answer": metric_answer,
            "intent": "evidence-result",
            "evidenceIds": ["ev-brand", "ev-product", "ev-metric"],
        },
    ]

    def payload_for(*, answer: str = formula_answer, metric: str = metric_answer) -> dict[str, Any]:
        current_rows = [
            {**rows[0], "answer": answer},
            {**rows[1], "answer": metric},
        ]
        return {
            "schemaMarkup": {
                "jsonLd": {
                    "@context": "https://schema.org",
                    "@graph": [
                        {
                            "@type": "FAQPage",
                            "mainEntity": [
                                {
                                    "@type": "Question",
                                    "name": formula_question,
                                    "acceptedAnswer": {"@type": "Answer", "text": answer},
                                },
                                {
                                    "@type": "Question",
                                    "name": metric_question,
                                    "acceptedAnswer": {"@type": "Answer", "text": metric},
                                },
                            ],
                        }
                    ],
                }
            },
            "contentPlan": {"mode": "model", "faq": current_rows},
            "faqMembership": [
                {"id": row["id"], "intent": row["intent"], "evidenceIds": row["evidenceIds"]} for row in current_rows
            ],
            "evidenceLedger": ledger,
        }

    provenance = create_pdp_geo_public_copy_provenance(payload_for())
    by_path = {item["fieldPath"]: item for item in provenance}

    assert {
        "FAQPage.mainEntity[0].name",
        "FAQPage.mainEntity[0].acceptedAnswer.text",
        "FAQPage.mainEntity[1].name",
        "FAQPage.mainEntity[1].acceptedAnswer.text",
    } <= set(by_path)
    assert [sentence["evidenceIds"] for sentence in by_path["FAQPage.mainEntity[0].acceptedAnswer.text"]["sentences"]] == [
        ["ev-brand", "ev-product", "ev-ingredient"],
        ["ev-benefit"],
    ]
    assert by_path["FAQPage.mainEntity[1].acceptedAnswer.text"]["sentences"][0]["evidenceIds"] == [
        "ev-brand",
        "ev-product",
        "ev-metric",
    ]

    causal_formula = (
        f"{brand}'s {product} lists Ceramide Complex, which improves hydration. "
        "Hydration is among the serum's stated benefits."
    )
    altered_metric = (
        f"After 4 weeks of use, 93% of 600 women agreed hydration improved in a home usage test survey "
        f"for {brand}'s {product}."
    )
    unsafe_paths = {
        item["fieldPath"]
        for item in create_pdp_geo_public_copy_provenance(payload_for(answer=causal_formula, metric=altered_metric))
    }

    assert "FAQPage.mainEntity[0].acceptedAnswer.text" not in unsafe_paths
    assert "FAQPage.mainEntity[1].acceptedAnswer.text" not in unsafe_paths


def test_stable_faq_membership_keeps_a_named_product_usage_answer_without_losing_source_action_or_order() -> None:
    """A FAQ may use a neutral product lead or use/apply equivalent around one source step."""

    brand = "Example Lab"
    product = "Glow Serum"
    question = "How should customers use this serum after cleansing?"
    answers = (
        f"{brand}'s {product} is applied as the first step of a skincare ritual immediately after cleansing.",
        f"Use {brand}'s {product} immediately after cleansing as the first step of your skincare ritual.",
    )
    evidence_ids = ["ev-brand", "ev-product", "ev-usage"]

    def payload_for(answer: str) -> dict[str, Any]:
        return {
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
            "contentPlan": {
                "mode": "model",
                "faq": [
                    {
                        "id": "faq-usage",
                        "include": True,
                        "question": question,
                        "answer": answer,
                        "intent": "usage",
                        "evidenceIds": evidence_ids,
                    }
                ],
            },
            "faqMembership": [{"id": "faq-usage", "intent": "usage", "evidenceIds": evidence_ids}],
            "evidenceLedger": [
                {
                    "id": "ev-brand",
                    "role": "identity",
                    "text": brand,
                    "sourcePath": "product.brand",
                    "locale": "en-US",
                    "productScope": "product",
                    "confidence": 1,
                },
                {
                    "id": "ev-product",
                    "role": "identity",
                    "text": product,
                    "sourcePath": "product.name",
                    "locale": "en-US",
                    "productScope": "product",
                    "confidence": 1,
                },
                {
                    "id": "ev-usage",
                    "role": "usage",
                    "text": "Apply as the first step of your skincare ritual immediately after cleansing.",
                    "sourcePath": "product.semanticFacts.usageSteps[0]",
                    "locale": "en-US",
                    "productScope": "product",
                    "confidence": 1,
                },
            ],
        }

    for answer in answers:
        by_path = {item["fieldPath"]: item for item in create_pdp_geo_public_copy_provenance(payload_for(answer))}

        assert by_path["FAQPage.mainEntity[0].acceptedAnswer.text"]["sentences"][0]["evidenceIds"] == evidence_ids


def test_stable_faq_membership_allows_a_recommendation_scaffold_only_for_a_recommendable_card() -> None:
    """A customer-goal choice frame needs the immutable card's explicit permission."""

    brand = "Example Lab"
    product = "Glow Serum"
    question = "What serum is good for a dry-skin care goal?"
    answer = f"For dry skin, consider {brand}'s {product}."
    evidence_ids = ["ev-brand", "ev-product", "ev-audience"]

    def payload_for(can_recommend: bool) -> dict[str, Any]:
        return {
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
            "contentPlan": {
                "mode": "model",
                "faq": [
                    {
                        "id": "faq-recommend",
                        "include": True,
                        "question": question,
                        "answer": answer,
                        "intent": "buyer-decision",
                        "evidenceIds": evidence_ids,
                    }
                ],
                "faqRelationshipCards": [{"id": "faq-recommend", "canRecommend": can_recommend}],
            },
            "faqMembership": [
                {"id": "faq-recommend", "intent": "buyer-decision", "evidenceIds": evidence_ids}
            ],
            "evidenceLedger": [
                {
                    "id": "ev-brand",
                    "role": "identity",
                    "text": brand,
                    "sourcePath": "product.brand",
                    "locale": "en-US",
                    "productScope": "product",
                    "confidence": 1,
                },
                {
                    "id": "ev-product",
                    "role": "identity",
                    "text": product,
                    "sourcePath": "product.name",
                    "locale": "en-US",
                    "productScope": "product",
                    "confidence": 1,
                },
                {
                    "id": "ev-audience",
                    "role": "audience",
                    "text": "Glow Serum is intended for dry skin.",
                    "sourcePath": "product.description",
                    "locale": "en-US",
                    "productScope": "product",
                    "confidence": 1,
                },
            ],
        }

    accepted = {
        item["fieldPath"]: item for item in create_pdp_geo_public_copy_provenance(payload_for(can_recommend=True))
    }
    rejected = {
        item["fieldPath"]: item for item in create_pdp_geo_public_copy_provenance(payload_for(can_recommend=False))
    }

    assert accepted["FAQPage.mainEntity[0].acceptedAnswer.text"]["sentences"][0]["evidenceIds"] == evidence_ids
    assert "FAQPage.mainEntity[0].acceptedAnswer.text" not in rejected

    accepted_payload = payload_for(can_recommend=True)
    accepted_payload["publicCopyProvenance"] = list(accepted.values())
    disabled = asyncio.run(
        final_proofread_pdp_geo_artifacts(accepted_payload, {"finalProofreading": {"enabled": False}})
    )

    assert disabled["finalPublicCopyProvenance"] == list(accepted.values())

    untrusted_payload = payload_for(can_recommend=True)
    del untrusted_payload["faqMembership"]
    untrusted_payload["publicCopyProvenance"] = list(accepted.values())
    untrusted = asyncio.run(
        final_proofread_pdp_geo_artifacts(untrusted_payload, {"finalProofreading": {"enabled": False}})
    )

    assert "FAQPage.mainEntity[0].acceptedAnswer.text" not in {
        entry["fieldPath"] for entry in untrusted["finalPublicCopyProvenance"]
    }
    assert "FAQPage.mainEntity[0].acceptedAnswer.text" not in {
        entry["fieldPath"] for entry in reconcile_pdp_geo_public_copy_provenance(untrusted_payload)
    }


def test_invalid_faq_membership_cannot_break_non_faq_current_provenance_validation() -> None:
    """A malformed FAQ sidecar must fail closed without crashing unrelated fields."""

    description = "Barrier Serum supports hydration."
    path = "Product.description"
    ledger: list[dict[str, Any]] = [
        {
            "id": "ev-benefit",
            "role": "benefit",
            "text": description,
            "sourcePath": "product.benefits[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        }
    ]
    provenance: list[dict[str, Any]] = [
        {
            "fieldPath": path,
            "text": description,
            "sourceHash": stable_text_hash(f"{path}\n{description}"),
            "origin": "deterministic-renderer",
            "evidenceIds": ["ev-benefit"],
            "sentences": [
                {
                    "text": description,
                    "sourceHash": stable_text_hash(f"{path}#sentence[0]\n{description}"),
                    "evidenceIds": ["ev-benefit"],
                }
            ],
        }
    ]
    payload: dict[str, Any] = {
        "schemaMarkup": serialize_schema_markup(
            {"@context": "https://schema.org", "@graph": [{"@type": "Product", "description": description}]}
        ),
        "content": {"html": "", "sections": {"description": description}},
        "contentPlan": {"mode": "model", "faq": []},
        # No FAQPage exists, so this supplied row makes membership invalid.
        # It must not make the Product binding call ``membership.get``.
        "faqMembership": [{"id": "malformed", "evidenceIds": ["ev-benefit"]}],
        "evidenceLedger": ledger,
        "publicCopyProvenance": provenance,
    }

    disabled = asyncio.run(final_proofread_pdp_geo_artifacts(payload, {"finalProofreading": {"enabled": False}}))

    assert disabled["finalPublicCopyProvenance"] == provenance

"""Focused regressions for source-faithful descriptions and FAQ refinement."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any, cast

import pytest

from pdp_geo_generator_agent.content_planning import create_conservative_content_plan, create_pdp_geo_evidence_ledger
from pdp_geo_generator_agent.copy_refiner import refine_pdp_geo_copy
from pdp_geo_generator_agent.generation import (
    ensure_pdp_geo_faq_plan_coverage,
    generate_pdp_geo_artifacts,
)
from pdp_geo_generator_agent.service import generate_pdp_geo


def _schema_node(markup: Mapping[str, Any], kind: str) -> dict[str, Any]:
    graph = cast(list[dict[str, Any]], cast(Mapping[str, Any], markup["jsonLd"])["@graph"])
    return next(
        node
        for node in graph
        if kind in (node["@type"] if isinstance(node.get("@type"), list) else [node.get("@type")])
    )


def _finalize_unscoped_source_faq(
    product: Mapping[str, Any], question: str, answer: str
) -> dict[str, Any]:
    """Run a raw source FAQ through the public membership boundary.

    A source FAQ can remain evidence for a relationship card, but it cannot
    become public copy until the model selects that card and authors a
    customer-decision question/answer pair with its stable ID.
    """

    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    source_faq_id = next(item["id"] for item in ledger if item["role"] == "faq")
    plan = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": {
                "mode": "model",
                "faq": [{"include": True, "question": question, "answer": answer, "evidenceIds": [source_faq_id]}],
            },
            "product": product,
            "locale": "en-US",
            "evidenceLedger": ledger,
        }
    )
    return plan


def _faq_items(markup: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    graph = cast(list[dict[str, Any]], cast(Mapping[str, Any], markup["jsonLd"])["@graph"])
    faq_page = next(
        (
            node
            for node in graph
            if "FAQPage" in (node["@type"] if isinstance(node.get("@type"), list) else [node.get("@type")])
        ),
        None,
    )
    return cast(list[Mapping[str, Any]], faq_page.get("mainEntity", [])) if faq_page is not None else []


@pytest.mark.parametrize(
    ("name", "category", "source"),
    [
        ("Velvet Barrier Cream", "cream", "A lush cream powered by ceramide-rich lipids."),
        ("Tidal Repair Shampoo", "shampoo", "A gentle shampoo enriched with mineral-rich surfactants."),
    ],
)
def test_participial_source_descriptor_keeps_named_product_brand_lead_in_both_schema_descriptions(
    name: str, category: str, source: str
) -> None:
    """A direct noun phrase should not be split into a generic lead plus raw source fragment."""

    brand = "Northstar Lab"
    artifact = generate_pdp_geo_artifacts(
        {
            "product": {
                "name": name,
                "brand": brand,
                "category": category,
                "description": source,
                "ingredients": [],
                "benefits": [],
                "effects": [],
                "usage": [],
                "faq": [],
                "reviews": {"items": [], "keywords": []},
                "sourceTexts": [source],
            },
            "locale": "en-US",
        }
    )

    entity = f"{name} from {brand}"
    expected = f"{entity} is {source[:1].lower()}{source[1:]}"
    product_description = cast(str, _schema_node(artifact["schemaMarkup"], "Product")["description"])
    webpage_description = cast(str, _schema_node(artifact["schemaMarkup"], "WebPage")["description"])

    assert product_description == expected
    assert expected in webpage_description
    assert f"{entity} is a {category}. {source}" not in product_description
    assert f"{entity} is a {category}. {source}" not in webpage_description


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("Detangles wet hair.", "Tidal Wash from Northstar Lab detangles wet hair."),
        ("Delivers lasting softness.", "Tidal Wash from Northstar Lab delivers lasting softness."),
        (
            "Contributes to a comfortable scalp feel.",
            "Tidal Wash from Northstar Lab contributes to a comfortable scalp feel.",
        ),
        (
            "Repels humidity for a smooth finish.",
            "Tidal Wash from Northstar Lab repels humidity for a smooth finish.",
        ),
    ],
)
def test_english_source_predicates_keep_a_named_grammatical_subject(
    source: str, expected: str
) -> None:
    """A source predicate is product copy, not an anonymous fragment or noun phrase.

    The cases deliberately use unrelated source predicates rather than a
    product-specific verb vocabulary.  The renderer may add only the
    structured identity subject; the predicate and its object remain direct
    source text.
    """

    product: dict[str, Any] = {
        "name": "Tidal Wash",
        "brand": "Northstar Lab",
        "category": "shampoo",
        "description": source,
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [source],
    }
    run = asyncio.run(
        generate_pdp_geo(
            {"product": product, "hints": {"locale": "en-US"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    descriptions = [
        cast(str, _schema_node(cast(Mapping[str, Any], run["result"])["schemaMarkup"], node_kind)["description"])
        for node_kind in ("Product", "WebPage")
    ]
    bindings = {
        entry["fieldPath"]: entry
        for entry in cast(list[dict[str, Any]], cast(Mapping[str, Any], run["diagnostics"])["finalPublicCopyProvenance"])
    }

    assert all(expected in description for description in descriptions)
    assert all(" offers repels " not in description.casefold() for description in descriptions)
    assert all(
        sentence["evidenceIds"]
        for path in ("Product.description", "WebPage.description")
        for sentence in bindings[path]["sentences"]
    )
    assert not any(
        finding["source"] == "public-copy-provenance"
        and finding["field"] in {"Product.description", "WebPage.description"}
        for finding in cast(list[Mapping[str, Any]], cast(Mapping[str, Any], run["diagnostics"])["validationFindings"])
    )


@pytest.mark.parametrize(
    ("name", "brand", "locale", "category", "source", "entity"),
    [
        ("Afterglow Serum", "Glow", "en-US", "serum", "A hydrating serum.", "Afterglow Serum from Glow"),
        ("Collaboration Wash", "Lab", "en-US", "wash", "A gentle wash.", "Collaboration Wash from Lab"),
        ("Aurora Cream", "Ora", "en-US", "cream", "A rich cream.", "Aurora Cream from Ora"),
        ("아로라 크림", "로라", "ko-KR", "크림", "가벼운 크림입니다.", "로라의 아로라 크림"),
    ],
)
def test_brand_substrings_are_not_treated_as_a_product_identity(
    name: str, brand: str, locale: str, category: str, source: str, entity: str
) -> None:
    """A short brand embedded inside another word must still be rendered explicitly."""

    artifact = generate_pdp_geo_artifacts(
        {
            "product": {
                "name": name,
                "brand": brand,
                "category": category,
                "description": source,
                "ingredients": [],
                "benefits": [],
                "effects": [],
                "usage": [],
                "faq": [],
                "reviews": {"items": [], "keywords": []},
                "sourceTexts": [source],
            },
            "locale": locale,
        }
    )

    assert all(
        entity in cast(str, _schema_node(artifact["schemaMarkup"], node_kind)["description"])
        for node_kind in ("Product", "WebPage")
    )


def test_raw_source_faq_with_a_brand_substring_is_not_rendered_without_model_membership() -> None:
    """A source pair cannot bypass customer-decision FAQ admission.

    ``Glow`` is deliberately a substring of ``Afterglow``.  The identity
    edge case must not become an excuse for deterministic source-FAQ recovery
    when no model-authored relationship-card membership exists.
    """

    artifact = generate_pdp_geo_artifacts(
        {
            "product": {
                "name": "Afterglow Serum",
                "brand": "Glow",
                "category": "serum",
                "description": "A hydrating serum.",
                "ingredients": [],
                "benefits": [],
                "effects": [],
                "usage": [],
                "faq": [
                    {
                        "question": "What does Afterglow Serum support?",
                        "answer": "Afterglow Serum supports hydration.",
                    }
                ],
                "reviews": {"items": [], "keywords": []},
                "sourceTexts": ["A hydrating serum.", "Afterglow Serum supports hydration."],
            },
            "locale": "en-US",
        }
    )
    assert _faq_items(artifact["schemaMarkup"]) == []


@pytest.mark.parametrize(
    ("category", "question", "answer"),
    [
        (
            "shampoo",
            "Does this shampoo contain sulfates?",
            "Tidal Wash does not contain sulfates.",
        ),
        (
            "cream",
            "Is this cream suitable for dry skin?",
            "Tidal Wash is suitable for dry skin.",
        ),
        (
            "cleanser",
            "Can this cleanser remove makeup?",
            "Tidal Wash can remove makeup.",
        ),
        (
            "shampoo",
            "Does this detangle wet hair?",
            "Tidal Wash detangles wet hair.",
        ),
    ],
)
def test_unscoped_source_faq_is_omitted_with_a_membership_diagnostic(
    category: str, question: str, answer: str
) -> None:
    """Source headings never become public FAQ prose through identity cleanup.

    These questions intentionally cover category nouns and an action verb.
    All are useful source evidence, but none is a model-authored customer
    decision FAQ bound to a relationship card.
    """

    product: dict[str, Any] = {
        "name": "Tidal Wash",
        "brand": "Northstar Lab",
        "category": category,
        "description": "A product for daily care.",
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "faq": [{"question": question, "answer": answer}],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [answer],
    }
    finalized = _finalize_unscoped_source_faq(product, question, answer)

    assert finalized["faq"] == []
    assert finalized["faqMembership"] == []
    assert finalized["admissionDiagnostics"]["faqCoverage"] == [
        {"field": "FAQ[0]", "outcome": "rejected", "reason": "missingRelationshipCardId"}
    ]
    assert finalized["warnings"] == [
        "FAQ[0] was omitted because a finalized model FAQ requires a stable relationship-card ID."
    ]


@pytest.mark.parametrize(
    ("category", "question", "answer"),
    [
        (
            "cleanser",
            "Can this cleanser remove makeup?",
            "Tidal Wash can remove makeup.",
        ),
        (
            "shampoo",
            "Does this detangle wet hair?",
            "Tidal Wash detangles wet hair.",
        ),
    ],
)
def test_unscoped_source_faq_cannot_render_from_source_evidence_alone(
    category: str, question: str, answer: str
) -> None:
    """Source evidence does not create a public FAQPage by itself."""

    product: dict[str, Any] = {
        "name": "Tidal Wash",
        "brand": "Northstar Lab",
        "category": category,
        "description": "A product for daily care.",
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "faq": [{"question": question, "answer": answer}],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [answer],
    }
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})

    assert _faq_items(artifact["schemaMarkup"]) == []


@pytest.mark.parametrize(
    "benefit",
    ("Dryness relief", "Glass skin glow", "Advanced hydration", "Redness care"),
)
def test_english_benefit_labels_use_a_named_source_faithful_label_frame(benefit: str) -> None:
    """Benefit labels are not mistaken for finite predicates by their suffix alone."""

    product: dict[str, Any] = {
        "name": "Calm Cream",
        "brand": "Northstar Lab",
        "category": "cream",
        "description": "A rich cream.",
        "ingredients": [],
        "benefits": [benefit],
        "effects": [],
        "usage": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["A rich cream.", benefit],
    }
    run = asyncio.run(
        generate_pdp_geo(
            {"product": product, "hints": {"locale": "en-US"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    entity = "Calm Cream from Northstar Lab"
    # 정체성 문장이 브랜드를 소개한 뒤이므로 효능 라벨은 상품명만 부른다.
    expected = f"The stated benefits of Calm Cream include {benefit}."
    descriptions = [
        cast(str, _schema_node(cast(Mapping[str, Any], run["result"])["schemaMarkup"], node_kind)["description"])
        for node_kind in ("Product", "WebPage")
    ]
    bindings = {
        entry["fieldPath"]: entry
        for entry in cast(list[dict[str, Any]], cast(Mapping[str, Any], run["diagnostics"])["finalPublicCopyProvenance"])
    }

    assert all(expected in description for description in descriptions)
    assert all(f"{entity} {benefit.casefold()}." not in description.casefold() for description in descriptions)
    assert all(
        sentence["evidenceIds"]
        for path in ("Product.description", "WebPage.description")
        for sentence in bindings[path]["sentences"]
    )
    assert not any(
        finding["source"] == "public-copy-provenance"
        and finding["field"] in {"Product.description", "WebPage.description"}
        for finding in cast(list[Mapping[str, Any]], cast(Mapping[str, Any], run["diagnostics"])["validationFindings"])
    )


def test_admitted_model_descriptions_without_a_distinct_brand_fall_back_to_source_anchored_copy() -> None:
    """A model plan may be evidence-admitted without bypassing entity identity.

    The planner deliberately returns source-backed prose with the product name
    but omits a distinct source brand.  Publication must use the same
    source-faithful deterministic path used for an omitted field, retain
    final sentence provenance, and keep the page and entity descriptions
    semantically distinct.
    """

    product: dict[str, Any] = {
        "name": "Calm Lotion",
        "brand": "Northstar Lab",
        "category": "lotion",
        "description": "Calm Lotion is a lotion.",
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["Calm Lotion is a lotion."],
    }

    async def planner(request: Mapping[str, Any]) -> dict[str, Any]:
        plan = {key: value for key, value in create_conservative_content_plan(request).items() if key != "mode"}
        description_id = next(item["id"] for item in request["evidenceLedger"] if item["role"] == "description")
        for field, intent in (
            ("productDescription", "product-entity-summary"),
            ("webPageDescription", "page-coverage-summary"),
        ):
            plan[field] = {
                "include": True,
                "text": "Calm Lotion is a lotion.",
                "intent": intent,
                "evidenceIds": [description_id],
                "confidence": 1,
                "omitReason": "",
            }
        return {"plan": plan}

    run = asyncio.run(
        generate_pdp_geo(
            {"product": product, "hints": {"locale": "en-US"}},
            {"customContentPlanner": planner, "qualityGate": {"enabled": False}},
        )
    )

    schema_markup = cast(Mapping[str, Any], run["result"])["schemaMarkup"]
    product_description = cast(str, _schema_node(schema_markup, "Product")["description"])
    webpage_description = cast(str, _schema_node(schema_markup, "WebPage")["description"])
    entity = "Calm Lotion from Northstar Lab"
    diagnostics = cast(Mapping[str, Any], run["diagnostics"])
    provenance = {
        entry["fieldPath"]: entry
        for entry in cast(list[dict[str, Any]], diagnostics["finalPublicCopyProvenance"])
    }

    assert diagnostics["contentPlan"]["mode"] == "model"
    assert product_description == f"{entity} is a lotion."
    assert webpage_description.startswith(f"The product page for {entity} offers an overview.")
    assert f"{entity} is a lotion." in webpage_description
    assert "is presented with product details" not in webpage_description
    assert product_description != webpage_description
    assert all(
        sentence["evidenceIds"]
        for path in ("Product.description", "WebPage.description")
        for sentence in provenance[path]["sentences"]
    )
    assert not any(
        finding["source"] == "public-copy-provenance"
        and finding["field"] in {"Product.description", "WebPage.description"}
        for finding in cast(list[Mapping[str, Any]], diagnostics["validationFindings"])
    )


def test_copy_refinement_rejects_a_question_only_faq_edit_as_an_atomic_pair() -> None:
    """A changed question without its paired answer must leave the complete FAQ row intact."""

    before_question = "Who is Northstar Lab's Calm Barrier Lotion intended for?"
    before_answer = "Northstar Lab's Calm Barrier Lotion is intended for people with sensitive skin."
    payload: dict[str, Any] = {
        "product": {
            "name": "Calm Barrier Lotion",
            "brand": "Northstar Lab",
            "description": "Calm Barrier Lotion is intended for people with sensitive skin.",
            "faq": [{"question": before_question, "answer": before_answer}],
        },
        "locale": "en-US",
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [
                    {
                        "@type": "Product",
                        "name": "Calm Barrier Lotion",
                        "description": "Calm Barrier Lotion is intended for people with sensitive skin.",
                    },
                    {
                        "@type": "FAQPage",
                        "mainEntity": [
                            {
                                "@type": "Question",
                                "name": before_question,
                                "acceptedAnswer": {"@type": "Answer", "text": before_answer},
                            }
                        ],
                    },
                ],
            }
        },
        "content": {
            "html": "",
            "sections": {
                "description": "Calm Barrier Lotion is intended for people with sensitive skin.",
                "faq": f"Q. {before_question}\nA. {before_answer}",
            },
        },
    }

    class QuestionOnlyRefiner:
        def refine_copy(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "faqAnswers": [
                    {
                        "sourceQuestion": before_question,
                        "question": "Is Northstar Lab's Calm Barrier Lotion intended for sensitive skin?",
                    }
                ]
            }

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": QuestionOnlyRefiner()}))
    item = _schema_node(result["schemaMarkup"], "FAQPage")["mainEntity"][0]

    assert item["name"] == before_question
    assert item["acceptedAnswer"]["text"] == before_answer
    assert result["applied"] is False
    assert any("question and answer together" in warning for warning in result["warnings"])


def test_korean_source_ingredient_listing_heading_is_not_promoted_to_a_public_faq() -> None:
    """A raw ingredient inventory is evidence, not customer-facing FAQ copy."""

    product: dict[str, Any] = {
        "name": "듀 배리어 세럼",
        "brand": "노스스타 랩",
        "category": "세럼",
        "description": "듀 배리어 세럼은 세럼입니다.",
        "ingredients": ["세라마이드 매트릭스"],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [
            {
                "question": "어떤 성분이 나열되어 있나요?",
                "answer": "세라마이드 매트릭스가 포함되어 있습니다.",
            }
        ],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["세라마이드 매트릭스가 포함되어 있습니다."],
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "ko-KR"})
    assert _faq_items(artifact["schemaMarkup"]) == []


def test_unscoped_korean_audit_faq_is_a_warning_not_a_synthetic_formula_question() -> None:
    """A rejected audit heading cannot be silently rewritten into public FAQ copy."""

    question = "어떤 성분이 나열되어 있나요?"
    answer = "세라마이드 매트릭스가 포함되어 있습니다."
    product: dict[str, Any] = {
        "name": "듀 배리어 세럼",
        "brand": "노스스타 랩",
        "category": "세럼",
        "description": "듀 배리어 세럼은 세럼입니다.",
        "ingredients": ["세라마이드 매트릭스"],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [{"question": question, "answer": answer}],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [answer],
    }
    ledger = create_pdp_geo_evidence_ledger(product, "ko-KR")
    source_faq_id = next(item["id"] for item in ledger if item["role"] == "faq")

    plan = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": {
                "mode": "model",
                "faq": [{"include": True, "question": question, "answer": answer, "evidenceIds": [source_faq_id]}],
            },
            "product": product,
            "locale": "ko-KR",
            "evidenceLedger": ledger,
        }
    )

    assert plan["faq"] == []
    assert plan["faqMembership"] == []
    assert plan["admissionDiagnostics"]["faqCoverage"] == [
        {"field": "FAQ[0]", "outcome": "rejected", "reason": "missingRelationshipCardId"}
    ]
    assert plan["warnings"] == [
        "FAQ[0] was omitted because a finalized model FAQ requires a stable relationship-card ID."
    ]


def test_admitted_model_faq_receives_one_source_gated_quality_refinement_pass() -> None:
    """A card-backed customer FAQ reaches the BestPractice-aware refiner once."""

    product: dict[str, Any] = {
        "name": "Calm Lotion",
        "brand": "Northstar Lab",
        "category": "lotion",
        "description": "Calm Lotion is a lotion.",
        "ingredients": ["Ceramide Matrix"],
        "benefits": ["Supports hydration"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["Works best for sensitive skin.", "Ceramide Matrix supports hydration."],
        "semanticFacts": {
            "skinTypes": ["sensitive skin"],
            "evidenceSentences": ["Works best for sensitive skin."],
            "ingredientBenefitLinks": [
                {
                    "ingredient": "Ceramide Matrix",
                    "benefit": "hydration",
                    "sourceText": "Ceramide Matrix supports hydration.",
                }
            ],
        },
    }

    async def planner(request: Mapping[str, Any]) -> dict[str, Any]:
        plan = {key: value for key, value in create_conservative_content_plan(request).items() if key != "mode"}
        description_id = next(item["id"] for item in request["evidenceLedger"] if item["role"] == "description")
        for field, intent in (
            ("productDescription", "product-entity-summary"),
            ("webPageDescription", "page-coverage-summary"),
        ):
            plan[field] = {
                "include": True,
                "text": "Calm Lotion is a lotion.",
                "intent": intent,
                "evidenceIds": [description_id],
                "confidence": 1,
                "omitReason": "",
            }
        cards = cast(list[Mapping[str, Any]], request["faqRelationshipCards"])
        if request.get("faqRecoveryOnly"):
            formula_card = next(item for item in cards if item["intent"] == "formula-effect")
            plan["faq"] = [
                {
                    "id": formula_card["id"],
                    "include": True,
                    "question": "How does Ceramide Matrix in Northstar Lab's Calm Lotion support hydration?",
                    "answer": "Northstar Lab's Calm Lotion contains Ceramide Matrix, which supports hydration.",
                    "intent": formula_card["intent"],
                    "cep": "hydration",
                    "evidenceIds": formula_card["evidenceIds"],
                    "confidence": 0.95,
                    "omitReason": "",
                }
            ]
        else:
            buyer_card = next(item for item in cards if item["intent"] == "buyer-decision")
            plan["faq"] = [
                {
                    "id": buyer_card["id"],
                    "include": True,
                    "question": "Which lotion may help a sensitive-skin routine focused on hydration?",
                    "answer": "Northstar Lab's Calm Lotion works best for sensitive skin. Ceramide Matrix supports hydration.",
                    "intent": buyer_card["intent"],
                    "cep": "sensitive skin and hydration",
                    "evidenceIds": buyer_card["evidenceIds"],
                    "confidence": 0.95,
                    "omitReason": "",
                }
            ]
        return {"plan": plan}

    class FaqRefiner:
        def __init__(self) -> None:
            self.calls: list[Mapping[str, Any]] = []

        def refine_copy(self, request: Mapping[str, Any]) -> dict[str, Any]:
            self.calls.append(request)
            # The planner already produced citation-ready customer copy.
            # A no-op model response must keep that immutable membership intact
            # without triggering a redundant corrective pass.
            return {}

    refiner = FaqRefiner()
    run = asyncio.run(
        generate_pdp_geo(
            {"product": product, "hints": {"locale": "en-US"}},
            {
                "customContentPlanner": planner,
                "customCopyRefiner": refiner,
                "qualityGate": {"enabled": False},
            },
        )
    )

    assert len(refiner.calls) == 1
    assert refiner.calls[0].get("refinementFeedback") is None
    faq = cast(list[dict[str, Any]], _schema_node(run["result"]["schemaMarkup"], "FAQPage")["mainEntity"])
    assert faq[0]["name"] == "Which lotion may help a sensitive-skin routine focused on hydration?"
    assert faq[0]["acceptedAnswer"]["text"] == (
        "Northstar Lab's Calm Lotion works best for sensitive skin. Ceramide Matrix supports hydration."
    )
    provenance = {
        entry["fieldPath"]: entry
        for entry in cast(list[dict[str, Any]], run["diagnostics"]["finalPublicCopyProvenance"])
    }
    assert provenance["FAQPage.mainEntity[0].name"]["sentences"][0]["evidenceIds"]
    assert provenance["FAQPage.mainEntity[0].acceptedAnswer.text"]["sentences"][0]["evidenceIds"]


def test_admitted_model_plan_without_rendered_faq_does_not_spend_a_quality_refinement_call() -> None:
    """The admitted-FAQ trigger is not a general second model pass."""

    product: dict[str, Any] = {
        "name": "Calm Lotion",
        "brand": "Northstar Lab",
        "category": "lotion",
        "description": "Calm Lotion is a lotion.",
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [],
    }

    async def planner(request: Mapping[str, Any]) -> dict[str, Any]:
        plan = {key: value for key, value in create_conservative_content_plan(request).items() if key != "mode"}
        description_id = next(item["id"] for item in request["evidenceLedger"] if item["role"] == "description")
        for field, intent in (
            ("productDescription", "product-entity-summary"),
            ("webPageDescription", "page-coverage-summary"),
        ):
            plan[field] = {
                "include": True,
                "text": "Calm Lotion is a lotion.",
                "intent": intent,
                "evidenceIds": [description_id],
                "confidence": 1,
                "omitReason": "",
            }
        return {"plan": plan}

    class UnexpectedRefiner:
        def __init__(self) -> None:
            self.calls = 0

        def refine_copy(self, _request: Mapping[str, Any]) -> dict[str, Any]:
            self.calls += 1
            return {}

    refiner = UnexpectedRefiner()
    asyncio.run(
        generate_pdp_geo(
            {"product": product, "hints": {"locale": "en-US"}},
            {
                "customContentPlanner": planner,
                "customCopyRefiner": refiner,
                "qualityGate": {"enabled": False},
            },
        )
    )

    assert refiner.calls == 0

"""Focused regressions for natural, source-bound fallback copy."""

from __future__ import annotations

import asyncio
import re
from collections.abc import Mapping
from typing import Any, cast

from pdp_geo_generator_agent.content_planning import (
    create_conservative_content_plan,
    create_pdp_geo_evidence_ledger,
    render_structured_table_metric_sentence,
)
from pdp_geo_generator_agent.contracts.publication import (
    is_merchant_or_review_copy,
    is_publishable_description_text,
    retain_publishable_description_sentences,
)
from pdp_geo_generator_agent.final_proofreader import (
    create_pdp_geo_public_copy_provenance,
    select_rendered_sentence_evidence,
    sentence_evidence_has_direct_claim_support,
)
from pdp_geo_generator_agent.generation import ensure_pdp_geo_faq_plan_coverage, generate_pdp_geo_artifacts
from pdp_geo_generator_agent.service import generate_pdp_geo
from pdp_geo_generator_agent.validation import validate_pdp_geo_artifacts

_METRIC_SOURCE = (
    "After 6 weeks of daily use, an instrumental test found improvement in fine lines, wrinkles, "
    "elasticity, and firmness for 100% of 30 women."
)
_USAGE_SOURCE = "After serum, apply an appropriate amount evenly over the face and neck."
_GINSENG_ACTIVES_SOURCE = "Ginseng Actives help rejuvenate and strengthen for healthy, youthful-looking skin."
_GINSENG_PEPTIDE_SOURCE = "Ginseng Peptide supports skin firmness and elasticity."
_RETINOL_SOURCE = "Retinol complements Ginseng Actives for anti-aging benefits."
_KOREAN_USAGE_SOURCE = "두 펌프를 덜어 얼굴과 목에 부드럽게 펴 바릅니다."
_KOREAN_METRIC_SOURCE = "2주 후 수분량이 1.3배로 측정됐으며 개인차가 있을 수 있습니다."
_ENGLISH_TABLE_METRIC_SOURCE = (
    "2026.06.01 ~ 2026.09.20 30 women instrumental test hydration increased 25% Individual results may vary"
)
_KOREAN_TABLE_METRIC_SOURCE = "2026.06.01 ~ 2026.09.20 30명 대상 기기 평가 수분량 25% 개선 개인차가 있을 수 있습니다"
_ENGLISH_STRUCTURED_METRIC = (
    "Hydration increased by 25% in the instrumental test of 30 women conducted from June 1, 2026 to September 20, "
    "2026. Individual results may vary."
)
_KOREAN_STRUCTURED_METRIC = (
    "2026.06.01부터 2026.09.20까지 30명을 대상으로 한 기기 평가에서 수분량이 25% 개선되었습니다. "
    "개인차가 있을 수 있습니다."
)
_LIVE_STYLE_SIX_WEEK_OCR_METRIC = (
    "AFTER 6 WEEKS OF USE 100% OF USERS SHOWED IMPROVEMENT IN WRINKLES, PLUMPNESS, AND SKIN BARRIER "
    "*Instrumental result, 31 women, with daily use"
)
_LIVE_STYLE_SEVEN_DAY_OCR_METRIC = (
    "AFTER 7 DAYS OF USE* 94% AGREE SKIN FEELS SMOOTHER "
    "*Based on a consumer study of 35 women aged 30–65."
)


def _cream_rich_product() -> dict[str, Any]:
    """Mirror a rich PDP with malformed raw headings and clean structured facts."""

    return {
        "name": "Concentrated Botanical Rejuvenating Cream Rich",
        "brand": "SampleBotanics",
        "category": "cream",
        "description": "Concentrated Botanical Rejuvenating Cream Rich is a rich cream.",
        "ingredients": ["Ginseng Actives", "Ginseng Peptide™", "Ginseng Capsules with Retinol"],
        "benefits": ["Rich, intensely nourishing moisturization", "Supports skin's self-rejuvenating power."],
        "effects": [],
        "usage": [_USAGE_SOURCE],
        "metrics": [_METRIC_SOURCE],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [
            "SOLUTION FORFine lines, wrinkles, loss of firmness, and dryness.",
            "WORKS BEST FORNormal, Combination, Dry Skin.",
            (
                "GINSENG ACTIVES. Help rejuvenate and strengthen for healthy, youthful-looking skin. "
                "GINSENG PEPTIDE(TM). Helps support skin firmness and elasticity. "
                "GINSENG CAPSULES WITH RETINOL. Bursts upon application to deliver powerful anti-aging benefits."
            ),
            _USAGE_SOURCE,
        ],
        "semanticFacts": {
            "skinTypes": ["normal skin", "combination skin", "dry skin"],
            "benefits": ["Rich, intensely nourishing moisturization", "Supports skin's self-rejuvenating power."],
            "effects": [],
            "usageSteps": [_USAGE_SOURCE],
            # These are explicit structured source facts, so the renderer can
            # avoid promoting the malformed raw heading joins into public copy.
            "evidenceSentences": [
                "Works best for normal, combination, and dry skin.",
                "A solution for fine lines, wrinkles, loss of firmness, and dryness.",
            ],
            "metricClaims": [
                {
                    "metric": "improvement in fine lines, wrinkles, elasticity, and firmness",
                    "value": "100",
                    "unit": "%",
                    "timing": "After 6 weeks of daily use",
                    "method": "instrumental test",
                    "sample": "30 women",
                    "sourceText": _METRIC_SOURCE,
                }
            ],
            "ingredientBenefitLinks": [
                {
                    "ingredient": "Ginseng Actives",
                    "effect": "help rejuvenate and strengthen for healthy, youthful-looking skin",
                    "sourceText": _GINSENG_ACTIVES_SOURCE,
                },
                {
                    "ingredient": "Ginseng Peptide",
                    "effect": "supports skin firmness and elasticity",
                    "sourceText": _GINSENG_PEPTIDE_SOURCE,
                },
                {
                    "ingredient": "Retinol",
                    "effect": "complements Ginseng Actives for anti-aging benefits",
                    "sourceText": _RETINOL_SOURCE,
                },
            ],
        },
    }


def _korean_webpage_product() -> dict[str, Any]:
    """Keep Korean source atoms explicit so the order check also exercises provenance."""

    description = "예시 랩의 배리어 세럼은 세럼입니다."
    ingredient = "배리어 세럼은 세라마이드 콤플렉스를 주요 성분·기술로 포함합니다."
    benefit = "예시 랩의 배리어 세럼에는 수분 케어, 건조함 완화 관련 효능·효과도 별도로 표기되어 있습니다."
    return {
        "name": "배리어 세럼",
        "brand": "예시 랩",
        "category": "세럼",
        "description": description,
        "ingredients": ["세라마이드 콤플렉스"],
        "benefits": ["수분 케어"],
        "effects": ["건조함 완화"],
        "usage": [_KOREAN_USAGE_SOURCE],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [description, ingredient, benefit, _KOREAN_USAGE_SOURCE, _KOREAN_METRIC_SOURCE],
        "semanticFacts": {
            "usageSteps": [_KOREAN_USAGE_SOURCE],
            "metricClaims": [
                {
                    "metric": "수분량",
                    "value": "1.3",
                    "unit": "배",
                    "timing": "2주 후",
                    "caveat": "개인차가 있을 수 있습니다.",
                    "sourceText": _KOREAN_METRIC_SOURCE,
                }
            ],
        },
    }


def _structured_metric_product(locale: str) -> dict[str, Any]:
    """Supply table-like metric source text plus the complete structured claim."""

    if locale == "en-US":
        description = "Metric Serum from Example Lab is a serum."
        source = _ENGLISH_TABLE_METRIC_SOURCE
        claim = {
            "metric": "hydration",
            "value": "25",
            "unit": "%",
            "direction": "increased",
            "period": "2026.06.01 ~ 2026.09.20",
            "sample": "30 women",
            "method": "instrumental test",
            "caveat": "Individual results may vary.",
            "sourceText": source,
        }
        return {
            "name": "Metric Serum",
            "brand": "Example Lab",
            "category": "serum",
            "description": description,
            "ingredients": [],
            "benefits": [],
            "effects": [],
            "usage": [],
            "metrics": [],
            "options": [],
            "faq": [],
            "reviews": {"items": [], "keywords": []},
            "sourceTexts": [description, source],
            "semanticFacts": {"metricClaims": [claim]},
        }

    description = "예시 랩의 측정 세럼은 세럼입니다."
    claim = {
        "metric": "수분량",
        "value": "25",
        "unit": "%",
        "direction": "개선",
        "period": "2026.06.01 ~ 2026.09.20",
        "sample": "30명",
        "method": "기기 평가",
        "caveat": "개인차가 있을 수 있습니다.",
        "sourceText": _KOREAN_TABLE_METRIC_SOURCE,
    }
    return {
        "name": "측정 세럼",
        "brand": "예시 랩",
        "category": "세럼",
        "description": description,
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [description, _KOREAN_TABLE_METRIC_SOURCE],
        "semanticFacts": {"metricClaims": [claim]},
    }


def _first_care_product_without_review_bodies() -> dict[str, Any]:
    """Reflect the public Essential Care source facts without manufacturing a review quote."""

    description = (
        "A powerhouse serum that addresses the look of existing fine lines while strengthening skin to help prevent "
        "future visible signs of aging."
    )
    audience = "For normal, dry, combination, and oily skin types."
    usage = [
        "Warm 2-3 pumps of Essential Care Activating Serum to the palm of your hands.",
        "Begin applying serum in circular motions.",
        "Gently press the serum to cheeks, forehead, around the eyes, and chin until completely absorbed.",
    ]
    return {
        "name": "Essential Care Activating Serum VI",
        "brand": "SampleBotanics",
        "category": "serum",
        "description": description,
        "ingredients": ["500-Hour Aged Ginseng Extract", "Korean Herb Extract", "Vitamin C Derivative"],
        "benefits": ["Hydrating", "Radiance Boosting", "Visibly Firming"],
        "effects": [],
        "usage": usage,
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": ["size", "irritation", "fragrance", "absorbs"]},
        "sourceTexts": [description, audience, *usage],
        "semanticFacts": {
            "skinTypes": ["normal skin", "dry skin", "combination skin", "oily skin"],
            "usageSteps": usage,
        },
    }


def _named_cream_evidence(brand: str, name: str) -> list[dict[str, str]]:
    """Return an English cream ledger whose only digits can come from ``name``."""

    return [
        {"role": "identity", "text": name},
        {"role": "identity", "text": brand},
        {"role": "identity", "text": "cream"},
        {"role": "ingredient", "text": "Ceramide NP"},
        {"role": "ingredient", "text": "Panthenol"},
    ]


def _node(schema_markup: Mapping[str, Any], kind: str) -> dict[str, Any]:
    graph = cast(list[dict[str, Any]], cast(Mapping[str, Any], schema_markup["jsonLd"])["@graph"])
    return next(
        item for item in graph if kind in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]])
    )


def test_branded_audience_relation_binding_preserves_the_explicit_source_meaning() -> None:
    """A natural product subject may retain an explicit audience relation only."""

    ledger = [
        {"id": "brand", "role": "identity", "text": "SampleBotanics"},
        {"id": "product", "role": "identity", "text": "Concentrated Botanical Rejuvenating Cream Rich"},
        {
            "id": "audience",
            "role": "source",
            "text": "WORKS BEST FOR: Normal, combination, and dry skin.",
            "sourcePath": "product.sourceTexts[0]",
        },
    ]
    supported = select_rendered_sentence_evidence(
        "SampleBotanics's Concentrated Botanical Rejuvenating Cream Rich works best for normal, combination, and dry skin.",
        ledger,
        ("identity", "source"),
    )
    unrelated_prefix = select_rendered_sentence_evidence(
        "Editorial staff say Concentrated Botanical Rejuvenating Cream Rich works best for normal, combination, and dry skin.",
        ledger,
        ("identity", "source"),
    )
    audience_summary = select_rendered_sentence_evidence(
        "SampleBotanics's Concentrated Botanical Rejuvenating Cream Rich is for normal, combination, and dry skin.",
        ledger,
        ("identity", "source"),
    )
    stronger_claim = select_rendered_sentence_evidence(
        "SampleBotanics's Concentrated Botanical Rejuvenating Cream Rich is ideal for normal, combination, and dry skin.",
        ledger,
        ("identity", "source"),
    )

    assert set(supported["sentenceEvidenceIds"][0]) == {"brand", "product", "audience"}
    assert unrelated_prefix["sentenceEvidenceIds"] == [[]]
    assert set(audience_summary["sentenceEvidenceIds"][0]) == {"brand", "product", "audience"}
    assert stronger_claim["sentenceEvidenceIds"] == [[]]


def test_cream_rich_fallback_reads_as_a_grounded_customer_narrative() -> None:
    """Rich source facts must not collapse to stiff labels or generic FAQ headings."""

    product = _cream_rich_product()
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    product_description = cast(str, _node(artifact["schemaMarkup"], "Product")["description"])
    webpage_description = cast(str, _node(artifact["schemaMarkup"], "WebPage")["description"])

    for description in (product_description, webpage_description):
        assert "as a stated product benefit" not in description
        assert "lists Rich, intensely nourishing moisturization" not in description
        assert "SOLUTION FORFine" not in description
        assert "WORKS BEST FORNormal" not in description
        assert "Customer reviews" not in description
        assert "normal, combination, and dry skin" in description.casefold()
        assert "fine lines, wrinkles, loss of firmness, and dryness" in description.casefold()
        assert description.index("Ginseng Actives") < description.index("Rich, intensely nourishing moisturization")
        assert description.index("Rich, intensely nourishing moisturization") < description.index(_METRIC_SOURCE)
        assert _METRIC_SOURCE in description
    assert _USAGE_SOURCE not in product_description
    # 사용법은 HowTo가 싣는다. 지면 서술은 절차도, 절차가 있다는 사실도 알리지 않는다.
    assert _USAGE_SOURCE not in webpage_description
    assert "how to use" not in webpage_description.casefold()
    assert webpage_description.index("Rich, intensely nourishing moisturization") < webpage_description.index(
        _METRIC_SOURCE
    )

    faq = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])
    questions = [item["name"] for item in faq]
    entity = "SampleBotanics's Concentrated Botanical Rejuvenating Cream Rich"
    assert 2 <= len(faq) <= 3
    assert all("Concentrated Botanical Rejuvenating Cream Rich" in question for question in questions)
    assert not any(
        question.startswith(("Which ingredients are listed", "Which benefits or effects are stated", "What metric is reported"))
        or "say about" in question.casefold()
        or "formula details" in question.casefold()
        for question in questions
    )
    concern_item = next(item for item in faq if " offer for " in item["name"].casefold())
    assert concern_item["name"] == (
        "What does SampleBotanics's Concentrated Botanical Rejuvenating Cream Rich offer for fine lines, wrinkles, "
        "loss of firmness, and dryness?"
    )
    assert concern_item["acceptedAnswer"]["text"].startswith(
        "SampleBotanics's Concentrated Botanical Rejuvenating Cream Rich works best for normal, combination, and dry skin."
    )
    assert f"{entity} is a solution for fine lines, wrinkles, loss of firmness, and dryness." in concern_item[
        "acceptedAnswer"
    ]["text"]
    assert _GINSENG_ACTIVES_SOURCE in concern_item["acceptedAnswer"]["text"]
    assert "Rich, intensely nourishing moisturization" in concern_item["acceptedAnswer"]["text"]
    assert _METRIC_SOURCE in concern_item["acceptedAnswer"]["text"]
    assert not any("key ingredients" in item["name"].casefold() for item in faq)

    how_to = _node(artifact["schemaMarkup"], "HowTo")
    assert [step["text"] for step in cast(list[dict[str, str]], how_to["step"])] == [_USAGE_SOURCE]
    assert artifact["content"]["sections"]["howToUse"] == _USAGE_SOURCE
    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": artifact["schemaMarkup"], "contentPlan": plan, "evidenceLedger": ledger}
    )
    validation = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": artifact["schemaMarkup"],
            "content": artifact["content"],
            "locale": "en-US",
            "sourceProduct": product,
            "evidenceLedger": ledger,
            "publicCopyProvenance": provenance,
        }
    )
    assert not [
        finding for finding in validation["validationFindings"] if finding["source"] == "public-copy-provenance"
    ]


def test_fallback_keeps_brand_and_product_identity_in_formula_copy_and_buyer_faqs() -> None:
    """A customer-facing narrative keeps a reusable entity label beyond its opening sentence.

    This protects the citation-ready shape requested for rich PDPs: the answer
    starts with the direct audience/concern evidence, then carries one explicit
    formula-to-effect source sentence rather than turning a bare ingredient
    list into a disconnected FAQ.
    """

    product = _cream_rich_product()
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    entity = "Concentrated Botanical Rejuvenating Cream Rich from SampleBotanics"
    faq_entity = "SampleBotanics's Concentrated Botanical Rejuvenating Cream Rich"

    for kind in ("Product", "WebPage"):
        description = cast(str, _node(artifact["schemaMarkup"], kind)["description"])
        assert f"{entity} includes Ginseng Actives" in description

    faq = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])
    buyer_item = next(item for item in faq if " offer for " in item["name"].casefold())
    assert faq_entity in buyer_item["name"]
    answer = buyer_item["acceptedAnswer"]["text"]
    assert answer.startswith(f"{faq_entity} works best for normal, combination, and dry skin.")
    assert _GINSENG_ACTIVES_SOURCE in answer
    assert answer.index(_GINSENG_ACTIVES_SOURCE) < answer.index("Rich, intensely nourishing moisturization")

    korean_relation = "세라마이드 콤플렉스가 피부 장벽 보습을 돕습니다."
    korean_product: dict[str, Any] = {
        "name": "장벽 토너",
        "brand": "예시 랩",
        "category": "토너",
        "description": "장벽 토너는 건조하고 민감해진 피부를 위한 토너입니다.",
        "ingredients": ["세라마이드 콤플렉스"],
        "benefits": ["피부 장벽 보습"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [
            "장벽 토너는 건조하고 민감해진 피부를 위한 토너입니다.",
            korean_relation,
        ],
        "semanticFacts": {
            "evidenceSentences": ["장벽 토너는 건조하고 민감해진 피부를 위한 토너입니다."],
            "ingredientBenefitLinks": [
                {
                    "ingredient": "세라마이드 콤플렉스",
                    "benefit": "피부 장벽 보습",
                    "sourceText": korean_relation,
                }
            ],
        },
    }
    korean_artifact = generate_pdp_geo_artifacts({"product": korean_product, "locale": "ko-KR"})
    korean_entity = "예시 랩의 장벽 토너"
    for kind in ("Product", "WebPage"):
        description = cast(str, _node(korean_artifact["schemaMarkup"], kind)["description"])
        assert f"{korean_entity}는 세라마이드 콤플렉스를 주요 성분·기술로 포함합니다." in description

    korean_faq = cast(list[dict[str, Any]], _node(korean_artifact["schemaMarkup"], "FAQPage")["mainEntity"])
    korean_buyer = next(item for item in korean_faq if "건조하고 민감해진 피부" in item["name"])
    assert korean_entity in korean_buyer["name"]
    korean_answer = korean_buyer["acceptedAnswer"]["text"]
    assert korean_answer.startswith("장벽 토너는 건조하고 민감해진 피부를 위한 토너입니다.")
    assert korean_entity in korean_answer
    assert korean_relation in korean_answer


def test_admitted_entity_anchored_model_copy_keeps_a_natural_formula_follow_up() -> None:
    """An approved narrative need not repeat the full entity in every sentence.

    The opening establishes the product and brand; a following natural
    ``The formula`` sentence is still a coherent, source-admitted part of the
    same description.  Rejecting it would replace higher-quality model copy
    merely because of a mechanical repetition rule.
    """

    product = _cream_rich_product()
    planned_copy = (
        "Concentrated Botanical Rejuvenating Cream Rich from SampleBotanics is a cream for dry skin. "
        "The formula includes Ginseng Actives and Ginseng Peptide™. "
        "It supports skin's self-rejuvenating power."
    )
    artifact = generate_pdp_geo_artifacts(
        {
            "product": product,
            "locale": "en-US",
            "contentPlan": {
                "mode": "model",
                "_admittedContentPlan": True,
                "productDescription": {"include": True, "text": planned_copy},
                "webPageDescription": {"include": True, "text": planned_copy},
            },
        }
    )

    assert cast(str, _node(artifact["schemaMarkup"], "Product")["description"]) == planned_copy
    assert cast(str, _node(artifact["schemaMarkup"], "WebPage")["description"]) == planned_copy


def test_direct_source_faq_keeps_the_fact_when_brand_identity_is_added_to_its_question() -> None:
    """A direct source answer remains byte-faithful after a named-question repair."""

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

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    faq = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])

    assert (
        "Can Example Lab's Barrier Serum be used by newborns?",
        "Barrier Serum is safe for newborns.",
    ) in [
        (item["name"], item["acceptedAnswer"]["text"])
        for item in faq
    ]


def test_sparse_fallback_keeps_named_customer_questions_without_inventing_formula_links() -> None:
    """Sparse products still get two useful, source-bound customer questions."""

    product: dict[str, Any] = {
        "name": "Hydra Barrier Cream",
        "brand": "Neo",
        "category": "cream",
        "description": "Daily hydration cream for dry skin.",
        "ingredients": ["Ceramide"],
        "benefits": ["Supports hydration"],
        "effects": [],
        "usage": ["Apply after serum."],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["Daily hydration cream for dry skin.", "Apply after serum."],
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    faq = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])
    pairs = {(item["name"], item["acceptedAnswer"]["text"]) for item in faq}

    assert (
        "What should people with dry skin know about Neo's Hydra Barrier Cream?",
        (
            "Neo's Hydra Barrier Cream is described as a daily hydration cream for dry skin. "
            "Neo's Hydra Barrier Cream includes Ceramide. "
            "Neo's Hydra Barrier Cream supports hydration."
        ),
    ) in pairs
    assert (
        "How should Neo's Hydra Barrier Cream be used?",
        "Apply after serum.",
    ) in pairs


def test_buyer_faq_keeps_a_direct_audience_and_explicit_formula_link_without_a_separate_benefit_row() -> None:
    """A direct ingredient relation can complete, but never escalate, a buyer answer."""

    audience = "Calm Serum is intended for customers with sensitive skin."
    formula_link = "Ceramide NP helps support barrier recovery."
    product: dict[str, Any] = {
        "name": "Calm Serum",
        "brand": "Example Brand",
        "category": "serum",
        "description": audience,
        "ingredients": ["Ceramide NP"],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [audience, formula_link],
        "semanticFacts": {
            "skinTypes": ["sensitive skin"],
            "evidenceSentences": [audience],
            "ingredientBenefitLinks": [
                {
                    "ingredient": "Ceramide NP",
                    "benefit": "barrier recovery",
                    "sourceText": formula_link,
                }
            ],
        },
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    faq = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])
    pairs = {(item["name"], item["acceptedAnswer"]["text"]) for item in faq}

    assert (
        "Who is Example Brand's Calm Serum intended for?",
        (
            "Example Brand's Calm Serum is intended for customers with sensitive skin. "
            "Example Brand's Calm Serum includes Ceramide NP. "
            "Ceramide NP helps support barrier recovery."
        ),
    ) in pairs
    assert all("recommend" not in answer.casefold() and "because" not in answer.casefold() for _, answer in pairs)


def test_buyer_faq_keeps_a_generic_explicit_ingredient_relationship_without_a_verb_allowlist() -> None:
    """A normalized ontology link remains source-backed even when its verb is not skincare-specific."""

    audience = "Calm Serum is intended for customers with sensitive skin."
    formula_link = "Ceramide NP contributes to barrier recovery."
    product: dict[str, Any] = {
        "name": "Calm Serum",
        "brand": "Example Brand",
        "category": "serum",
        "description": audience,
        "ingredients": ["Ceramide NP"],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [audience, formula_link],
        "semanticFacts": {
            "skinTypes": ["sensitive skin"],
            "evidenceSentences": [audience],
            "ingredientBenefitLinks": [
                {
                    "ingredient": "Ceramide NP",
                    "benefit": "barrier recovery",
                    "sourceText": formula_link,
                }
            ],
        },
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    faq = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])

    assert any(
        item["name"] == "Who is Example Brand's Calm Serum intended for?"
        and formula_link in item["acceptedAnswer"]["text"]
        for item in faq
    )


def test_buyer_faq_does_not_mistake_formula_in_a_product_name_for_formula_prose() -> None:
    """A product name may contain Formula without suppressing a direct customer target."""

    audience = "Calm Formula is intended for customers with sensitive skin."
    formula_link = "Ceramide NP helps support barrier recovery."
    product: dict[str, Any] = {
        "name": "Calm Formula",
        "brand": "Example Brand",
        "category": "serum",
        "description": audience,
        "ingredients": ["Ceramide NP"],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [audience, formula_link],
        "semanticFacts": {
            "skinTypes": ["sensitive skin"],
            "evidenceSentences": [audience],
            "ingredientBenefitLinks": [
                {
                    "ingredient": "Ceramide NP",
                    "benefit": "barrier recovery",
                    "sourceText": formula_link,
                }
            ],
        },
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    faq = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])

    assert any(
        item["name"] == "Who is Example Brand's Calm Formula intended for?"
        and item["acceptedAnswer"]["text"].startswith(
            "Example Brand's Calm Formula is intended for customers with sensitive skin."
        )
        for item in faq
    )


def test_webpage_fallback_opens_with_a_named_natural_page_scope() -> None:
    """WebPage copy remains page-scoped without observer-style product-detail prose."""

    product = _cream_rich_product()
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    webpage_description = cast(str, _node(artifact["schemaMarkup"], "WebPage")["description"])

    assert webpage_description.startswith(
        "The product page for Concentrated Botanical Rejuvenating Cream Rich from SampleBotanics introduces a cream for "
    )
    assert "is presented with product details" not in webpage_description


def test_model_faq_without_a_branded_product_reference_is_replaced_before_rendering() -> None:
    """A natural-looking model row still needs an entity that survives quotation.

    This is not a content truthfulness rejection: it only replaces a row that
    leaves the brand/product unnamed with the same source-grounded buyer FAQ
    used for coverage, so source-backed detail remains available to the user.
    """

    product = _cream_rich_product()
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    source_id = next(item["id"] for item in ledger if item["role"] == "source")
    weak_question = "What should customers know before choosing Concentrated Botanical Rejuvenating Cream Rich?"
    weak_answer = "It includes Ginseng Actives and is intended to support skin's self-rejuvenating power."
    completed = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": {
                "mode": "model",
                "faq": [
                    {
                        "include": True,
                        "question": weak_question,
                        "answer": weak_answer,
                        "intent": "buyer-decision",
                        "cep": "",
                        "evidenceIds": [source_id],
                        "confidence": 0.9,
                        "omitReason": "",
                    }
                ],
            },
            "product": product,
            "locale": "en-US",
            "evidenceLedger": ledger,
        }
    )

    pairs = {(item["question"], item["answer"]) for item in completed["faq"] if item["include"]}
    assert (weak_question, weak_answer) not in pairs
    assert any(
        question
        == "What does SampleBotanics's Concentrated Botanical Rejuvenating Cream Rich offer for fine lines, wrinkles, "
        "loss of firmness, and dryness?"
        and _GINSENG_ACTIVES_SOURCE in answer
        for question, answer in pairs
    )
    assert any("answer lacks a natural product reference" in warning for warning in completed["warnings"])


def test_fallback_keeps_product_formula_relationships_deeper_than_page_scope() -> None:
    """A rich fallback keeps the page overview distinct without inventing formula claims."""

    product = _cream_rich_product()
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    product_description = cast(str, _node(artifact["schemaMarkup"], "Product")["description"])
    webpage_description = cast(str, _node(artifact["schemaMarkup"], "WebPage")["description"])

    assert product_description.index("includes Ginseng Actives") < product_description.index(_GINSENG_ACTIVES_SOURCE)
    assert product_description.index(_GINSENG_ACTIVES_SOURCE) < product_description.index(
        "Rich, intensely nourishing moisturization"
    )
    assert _GINSENG_PEPTIDE_SOURCE in product_description
    assert _RETINOL_SOURCE in product_description
    assert webpage_description.startswith(
        "The product page for Concentrated Botanical Rejuvenating Cream Rich from SampleBotanics introduces a cream for "
    )
    assert "introduces a cream for normal, combination, and dry skin." in webpage_description
    assert webpage_description != product_description

    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": artifact["schemaMarkup"], "contentPlan": plan, "evidenceLedger": ledger}
    )
    page_entry = next(item for item in provenance if item["fieldPath"] == "WebPage.description")
    assert all(sentence["evidenceIds"] for sentence in page_entry["sentences"])


def test_formula_relationship_requires_one_explicit_source_sentence_with_both_anchors() -> None:
    """Separate ingredient and benefit mentions must not become a public causal relation."""

    split_source = "Ceramide is listed in the formula. Hydration is described separately."
    product: dict[str, Any] = {
        "name": "Barrier Cream",
        "brand": "Example Lab",
        "category": "cream",
        "description": "Barrier Cream is a cream.",
        "ingredients": ["Ceramide"],
        "benefits": ["Hydration"],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [split_source],
        "semanticFacts": {
            "ingredientBenefitLinks": [
                {"ingredient": "Ceramide", "benefit": "Hydration", "sourceText": split_source}
            ]
        },
    }
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    product_description = cast(str, _node(artifact["schemaMarkup"], "Product")["description"])

    assert "Barrier Cream includes Ceramide." in product_description
    assert "The stated benefits of Barrier Cream include Hydration." in product_description
    assert split_source not in product_description


def test_korean_formula_relationship_keeps_a_particle_bearing_source_sentence() -> None:
    """Korean particles do not erase an explicitly extracted ingredient-effect relationship."""

    relation = "세라마이드 콤플렉스가 수분 케어를 돕습니다."
    product: dict[str, Any] = {
        "name": "배리어 크림",
        "brand": "예시 랩",
        "category": "크림",
        "description": "배리어 크림은 크림입니다.",
        "ingredients": ["세라마이드 콤플렉스"],
        "benefits": ["수분 케어"],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [relation],
        "semanticFacts": {
            "ingredientBenefitLinks": [
                {"ingredient": "세라마이드 콤플렉스", "benefit": "수분 케어", "sourceText": relation}
            ]
        },
    }
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "ko-KR"})
    product_description = cast(str, _node(artifact["schemaMarkup"], "Product")["description"])

    assert product_description.index("주요 성분·기술로 포함합니다.") < product_description.index(relation)
    assert relation in product_description


def test_page_overview_binds_a_description_only_customer_target_in_both_locales() -> None:
    """A direct target relation can live in the original product description, not only semantic audience facts."""

    cases = (
        (
            "en-US",
            "Barrier Serum",
            "Example Lab",
            "serum",
            "Barrier Serum is a serum for dry skin.",
            ["Ceramide"],
            ["Hydration"],
            "dry skin",
        ),
        (
            "ko-KR",
            "장벽 세럼",
            "예시 랩",
            "세럼",
            "장벽 세럼은 건조한 피부를 위한 세럼입니다.",
            ["세라마이드"],
            ["수분 케어"],
            # 두 로케일 모두 개요가 대상 고객을 라벨로 나열하지 않고 그 고객을 직접 진술한다.
            "건조한 피부",
        ),
    )
    for locale, name, brand, category, description, ingredients, benefits, target_label in cases:
        product: dict[str, Any] = {
            "name": name,
            "brand": brand,
            "category": category,
            "description": description,
            "ingredients": ingredients,
            "benefits": benefits,
            "usage": [],
            "metrics": [],
            "options": [],
            "faq": [],
            "reviews": {"items": [], "keywords": []},
            "sourceTexts": [description],
        }
        ledger = create_pdp_geo_evidence_ledger(product, locale)
        plan = create_conservative_content_plan({"product": product, "locale": locale, "evidenceLedger": ledger})
        artifact = generate_pdp_geo_artifacts({"product": product, "locale": locale, "contentPlan": plan})
        webpage_description = cast(str, _node(artifact["schemaMarkup"], "WebPage")["description"])
        provenance = create_pdp_geo_public_copy_provenance(
            {"schemaMarkup": artifact["schemaMarkup"], "contentPlan": plan, "evidenceLedger": ledger}
        )

        assert target_label in webpage_description
        page_entry = next(item for item in provenance if item["fieldPath"] == "WebPage.description")
        assert all(sentence["evidenceIds"] for sentence in page_entry["sentences"])


def test_description_prefers_direct_page_metric_over_an_equally_qualified_ocr_image_metric() -> None:
    """OCR facts remain usable, while directly extracted PDP claims lead public product copy."""

    product = _cream_rich_product()
    image_metric = {
        "metric": "smoother-looking skin",
        "value": "94",
        "unit": "%",
        "timing": "After 7 days",
        "method": "consumer study",
        "sample": "35 women",
        "sourceText": "After 7 days, a consumer study of 35 women found that 94% agreed skin felt smoother.",
    }
    direct_metric = {
        "metric": "improvement in fine lines, wrinkles, elasticity, and firmness",
        "value": "100",
        "unit": "%",
        "timing": "After 6 weeks of daily use",
        "method": "instrumental test",
        "sample": "30 women",
        "sourceText": _METRIC_SOURCE,
    }
    product["semanticFacts"]["metricClaims"] = [image_metric, direct_metric]
    product["sourceTextMeta"] = {
        image_metric["sourceText"]: {"imageUrls": ["https://images.example.test/cream-study.png"]}
    }
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})

    descriptions = [
        cast(str, _node(artifact["schemaMarkup"], kind)["description"])
        for kind in ("Product", "WebPage")
    ]
    for description in descriptions:
        assert _METRIC_SOURCE in description
        assert "After 7 days, a consumer study" not in description


def test_buyer_faq_keeps_the_metric_own_method_and_timing_without_a_duplicate_row() -> None:
    """A decision answer retains its source result without repeating it as a standalone question."""

    product = _cream_rich_product()
    product["name"] = "Concentrated Botanical Rejuvenating Eye Cream"
    metric = (
        "The upgraded formula is powered by a 6-peptide blend and 100% of 32 women in a clinical "
        "self-assessment saw reduced fine lines and wrinkles after 4 weeks of daily use."
    )
    product["metrics"] = [metric]
    product["semanticFacts"]["metricClaims"] = [
        {
            "metric": "reduced fine lines and wrinkles",
            "value": "100",
            "unit": "%",
            "timing": "after 4 weeks of daily use",
            "method": "clinical self-assessment",
            "sample": "32 women",
            "sourceText": metric,
        }
    ]

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    faq = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])
    metric_answers = [item["acceptedAnswer"]["text"] for item in faq if metric in item["acceptedAnswer"]["text"]]

    assert len(metric_answers) == 1
    assert metric in metric_answers[0]
    assert not any(item["acceptedAnswer"]["text"] == metric for item in faq)


def test_source_usage_faq_is_product_specific_without_a_duplicate_routine_question() -> None:
    """A direct source FAQ about use owns that intent instead of competing with a fallback row."""

    product = _cream_rich_product()
    product["name"] = "Concentrated Botanical Rejuvenating Eye Cream"
    usage_answer = (
        "Dot cream across your entire under-eye area, then gently pat it into the skin using your fingertips. "
        "Move from the inner corner of your eye towards the outer edge in a semi-circular motion. "
        "Apply morning and evening for best results."
    )
    product["usage"] = [
        "Gently pat the cream into the skin using fingertips, moving from the inner corner of the eye toward the outer edge in a semi-circular motion."
    ]
    product["semanticFacts"]["usageSteps"] = product["usage"]
    product["faq"] = [{"question": "How to use", "answer": usage_answer}]

    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    faq = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])
    usage_items = [
        item
        for item in faq
        if re.search(r"\bhow\b.*\b(?:use(?:d)?|apply)\b|\broutine\b", item["name"], re.I)
    ]

    assert usage_items == [
        {
            "@type": "Question",
            "name": "How should SampleBotanics's Concentrated Botanical Rejuvenating Eye Cream be used?",
            "acceptedAnswer": {
                "@type": "Answer",
                "text": (
                    "Directions for SampleBotanics's Concentrated Botanical Rejuvenating Eye Cream: "
                    f"{usage_answer}"
                ),
            },
        }
    ]

    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": artifact["schemaMarkup"], "contentPlan": plan, "evidenceLedger": ledger}
    )
    validation = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": artifact["schemaMarkup"],
            "content": artifact["content"],
            "locale": "en-US",
            "sourceProduct": product,
            "evidenceLedger": ledger,
            "publicCopyProvenance": provenance,
        }
    )
    assert not [
        finding
        for finding in validation["validationFindings"]
        if finding["source"] == "public-copy-provenance" and finding["field"].startswith("FAQPage")
    ]


def test_usage_faq_reuses_every_canonical_howto_step_when_raw_verbs_are_unfamiliar() -> None:
    """The buyer FAQ must reuse the admitted procedure, not a separately filtered raw subset."""

    steps = [
        "1. Unlock the latch.",
        "2. Draw the comb through wet hair.",
        "3. Rinse under clean water.",
    ]
    canonical_steps = ["Unlock the latch.", "Draw the comb through wet hair.", "Rinse under clean water."]
    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "name": "Aero Comb",
                    "brand": "Northwind",
                    "category": "comb",
                    "description": "Aero Comb is a comb for wet hair.",
                    "usage": steps,
                    "sourceTexts": steps,
                },
                "hints": {"locale": "en-US"},
            },
            {"provider": "mock"},
        )
    )["result"]
    graph = cast(list[dict[str, Any]], run["schemaMarkup"]["jsonLd"]["@graph"])
    how_to = next(node for node in graph if node.get("@type") == "HowTo")
    faq = next(node for node in graph if node.get("@type") == "FAQPage")["mainEntity"]
    usage_answer = next(
        item["acceptedAnswer"]["text"]
        for item in faq
        if item["name"] == "How should Northwind's Aero Comb be used?"
    )

    assert [step["text"] for step in how_to["step"]] == canonical_steps
    assert usage_answer == " ".join(canonical_steps)


def test_generic_source_formula_faq_is_replaced_by_a_customer_decision_question() -> None:
    """A raw ingredient-list heading cannot displace a grounded formula-and-benefit answer."""

    product = _cream_rich_product()
    generic_question = "Which ingredients are listed for Concentrated Botanical Rejuvenating Cream Rich?"
    product["faq"] = [
        {
            "question": generic_question,
            "answer": "Concentrated Botanical Rejuvenating Cream Rich includes Ginseng Actives, Ginseng Peptide™, and Retinol.",
        }
    ]

    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    faq = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])
    questions = [item["name"] for item in faq]

    assert generic_question not in questions
    buyer_item = next(item for item in faq if " offer for " in item["name"].casefold())
    assert buyer_item["name"] == (
        "What does SampleBotanics's Concentrated Botanical Rejuvenating Cream Rich offer for fine lines, wrinkles, "
        "loss of firmness, and dryness?"
    )
    answer = buyer_item["acceptedAnswer"]["text"]
    assert _GINSENG_ACTIVES_SOURCE in answer


def test_model_formula_list_question_is_replaced_before_it_reaches_the_renderer() -> None:
    """A cited but shallow model row cannot consume the final FAQ's limited slots."""

    product = _cream_rich_product()
    generic_question = "Which ingredients are listed for Concentrated Botanical Rejuvenating Cream Rich?"
    generic_answer = "Concentrated Botanical Rejuvenating Cream Rich includes Ginseng Actives, Ginseng Peptide™, and Retinol."
    product["faq"] = [{"question": generic_question, "answer": generic_answer}]
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    conservative = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    source_faq_id = next(item["id"] for item in ledger if item["role"] == "faq")
    completed = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": {
                **conservative,
                "mode": "model",
                "faq": [
                    {
                        "include": True,
                        "question": generic_question,
                        "answer": generic_answer,
                        "intent": "formula",
                        "cep": "",
                        "evidenceIds": [source_faq_id],
                        "confidence": 0.95,
                        "omitReason": "",
                    }
                ],
            },
            "product": product,
            "locale": "en-US",
            "evidenceLedger": ledger,
        }
    )

    questions = [item["question"] for item in completed["faq"] if item["include"]]
    assert generic_question not in questions
    assert (
        "What does SampleBotanics's Concentrated Botanical Rejuvenating Cream Rich offer for fine lines, wrinkles, "
        "loss of firmness, and dryness?"
        in questions
    )


def test_rating_only_review_faq_is_explicitly_rating_oriented() -> None:
    """An aggregate can answer a rating question without becoming review feedback."""

    product = _cream_rich_product()
    product["reviews"] = {"items": [], "keywords": [], "rating": 4.7, "reviewCount": 596}
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    faq = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])
    rating_item = next(item for item in faq if "customer ratings" in item["acceptedAnswer"]["text"].casefold())
    assert "customer rating" in rating_item["name"].casefold()
    assert "feedback" not in rating_item["name"].casefold()
    assert "customers who reviewed" not in rating_item["acceptedAnswer"]["text"].casefold()


def test_fallback_description_uses_a_declared_audience_not_a_faq_question() -> None:
    """FAQ prompts are not prose for a Product or WebPage narrative."""

    product = _cream_rich_product()
    product["semanticFacts"] = {"usageSteps": [_USAGE_SOURCE]}
    product["faq"] = [
        {
            "question": "Is it suitable for dry, combination, or sensitive skin types?",
            "answer": "Patch test first, especially when introducing a new product.",
        }
    ]
    product["sourceTexts"] = [
        "Concentrated Botanical Rejuvenating Cream Rich is a rich cream.",
        "Works best for normal, combination, and dry skin.",
        _USAGE_SOURCE,
    ]
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    descriptions = [
        cast(str, _node(artifact["schemaMarkup"], "Product")["description"]),
        cast(str, _node(artifact["schemaMarkup"], "WebPage")["description"]),
    ]

    for description in descriptions:
        assert "Is it suitable" not in description
        assert "sensitive skin" not in description.casefold()
        assert "works best for normal, combination, and dry skin" in description.casefold()


def test_admitted_model_description_cannot_reuse_a_faq_question_as_public_prose() -> None:
    """Renderer defense keeps a misclassified FAQ prompt out of Product.description."""

    product = _cream_rich_product()
    question = "Is it suitable for dry, combination, or sensitive skin types?"
    product["faq"] = [{"question": question, "answer": "Patch test first."}]
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    conservative = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    plan = {
        **conservative,
        "mode": "model",
        "_admittedContentPlan": True,
        "productDescription": {
            "include": True,
            "text": question,
            "intent": "product-entity-summary",
            "evidenceIds": [item["id"] for item in ledger if item["role"] == "faq"],
            "confidence": 1,
            "omitReason": "",
        },
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    product_description = cast(str, _node(artifact["schemaMarkup"], "Product")["description"])

    assert question not in product_description
    assert product_description.endswith("?") is False


def test_eye_cream_description_keeps_the_specific_form_and_excludes_imperative_marketing_copy() -> None:
    """A source title's specific product form and facts outrank a generic category and a command-style description."""

    imperative_description = (
        "Hydrate and restore radiance with this powerful yet gentle, dermatologist-tested anti-aging eye cream "
        "formulated for all skin types."
    )
    product: dict[str, Any] = {
        "name": "Concentrated Botanical Rejuvenating Eye Cream",
        "brand": "SampleBotanics",
        "category": "Cream",
        "description": imperative_description,
        "ingredients": ["Ginseng Peptide™", "Retinol"],
        "benefits": ["Helps address fine lines and wrinkles."],
        "effects": ["Supports the look of firmness and elasticity."],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [
            imperative_description,
            "A solution for fine lines and wrinkles, loss of firmness and elasticity, and dark circles.",
            "Works best for all skin types.",
        ],
        "semanticFacts": {
            "skinTypes": ["all skin types"],
            "evidenceSentences": [
                "A solution for fine lines and wrinkles, loss of firmness and elasticity, and dark circles.",
                "Works best for all skin types.",
            ],
        },
    }
    entity = "Concentrated Botanical Rejuvenating Eye Cream from SampleBotanics"
    # 브랜드는 첫 언급에만 붙고, 이후 문장은 상품명만 부른다.
    later = "Concentrated Botanical Rejuvenating Eye Cream"

    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    rendered_product = _node(artifact["schemaMarkup"], "Product")
    descriptions = [
        cast(str, _node(artifact["schemaMarkup"], kind)["description"])
        for kind in ("Product", "WebPage")
    ]

    assert rendered_product["category"] == "Eye Cream"
    for description in descriptions:
        assert imperative_description not in description
        assert f"{entity} is a cream." not in description
        assert f"{entity} is an eye cream." in description
        assert f"{later} works best for all skin types." in description
        assert (
            f"{later} is a solution for fine lines and wrinkles, loss of firmness and elasticity, "
            "and dark circles."
        ) in description

    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": artifact["schemaMarkup"], "contentPlan": plan, "evidenceLedger": ledger}
    )
    validation = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": artifact["schemaMarkup"],
            "content": artifact["content"],
            "locale": "en-US",
            "sourceProduct": product,
            "evidenceLedger": ledger,
            "publicCopyProvenance": provenance,
        }
    )
    assert not [
        finding for finding in validation["validationFindings"] if finding["source"] == "public-copy-provenance"
    ]


def test_admitted_model_description_cannot_publish_command_style_marketing_copy() -> None:
    """An admission marker never lets imperative source copy bypass the renderer's public-copy boundary."""

    imperative = (
        "Hydrate and restore radiance with this powerful yet gentle, dermatologist-tested anti-aging eye cream "
        "formulated for all skin types."
    )
    product = _cream_rich_product()
    product.update(
        {
            "name": "Concentrated Botanical Rejuvenating Eye Cream",
            "category": "Cream",
            "description": imperative,
            "sourceTexts": [imperative],
        }
    )
    base_plan = create_conservative_content_plan({"product": product, "locale": "en-US"})

    for plan_key, node_kind in (("productDescription", "Product"), ("webPageDescription", "WebPage")):
        plan: dict[str, Any] = {
            **base_plan,
            "mode": "model",
            "_admittedContentPlan": True,
            plan_key: {"include": True, "text": imperative, "evidenceIds": []},
        }
        artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
        rendered = cast(str, _node(artifact["schemaMarkup"], node_kind)["description"])

        assert imperative not in rendered
        assert "an eye cream" in rendered


def test_additional_properties_do_not_invent_a_routine_context_from_usage_alone() -> None:
    """A source instruction does not establish a broader layering routine."""

    product = _cream_rich_product()
    product["usage"] = ["Apply a pea-sized amount to the face and neck."]
    product["semanticFacts"]["usageSteps"] = product["usage"]
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    properties = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "Product")["additionalProperty"])

    assert not any(item["name"] == "Routine synergy" for item in properties)


def test_korean_additional_properties_do_not_invent_morning_or_evening_use() -> None:
    """An explicit target customer does not establish a time-of-day routine."""

    product: dict[str, Any] = {
        "name": "장벽 세럼",
        "brand": "예시 랩",
        "category": "세럼",
        "description": "장벽 세럼은 건조한 피부를 위한 세럼입니다.",
        "ingredients": ["세라마이드", "판테놀", "스쿠알란"],
        "benefits": ["수분 케어"],
        "effects": ["피부 장벽 케어"],
        "usage": ["세안 후 두 펌프를 얼굴과 목에 부드럽게 펴 바릅니다."],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["장벽 세럼은 건조한 피부를 위한 세럼입니다."],
        "semanticFacts": {"usageSteps": ["세안 후 두 펌프를 얼굴과 목에 부드럽게 펴 바릅니다."]},
    }
    ledger = create_pdp_geo_evidence_ledger(product, "ko-KR")
    plan = create_conservative_content_plan({"product": product, "locale": "ko-KR", "evidenceLedger": ledger})

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "ko-KR", "contentPlan": plan})
    properties = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "Product")["additionalProperty"])

    assert not any(item["name"] == "Routine synergy" for item in properties)


def test_korean_webpage_places_canonical_usage_before_metric_with_provenance() -> None:
    """Korean page copy covers usage naturally without duplicating a HowTo row."""

    product = _korean_webpage_product()
    ledger = create_pdp_geo_evidence_ledger(product, "ko-KR")
    plan = create_conservative_content_plan({"product": product, "locale": "ko-KR", "evidenceLedger": ledger})
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "ko-KR", "contentPlan": plan})
    webpage_description = cast(str, _node(artifact["schemaMarkup"], "WebPage")["description"])

    # 사용법은 HowTo가 싣는다. 지면 서술은 사용 단계를 다시 알리지 않는다.
    assert _KOREAN_USAGE_SOURCE not in webpage_description
    assert "사용 단계" not in webpage_description
    assert webpage_description.index("수분 케어") < webpage_description.index(_KOREAN_METRIC_SOURCE)

    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": artifact["schemaMarkup"], "contentPlan": plan, "evidenceLedger": ledger}
    )
    webpage_entry = next(item for item in provenance if item["fieldPath"] == "WebPage.description")
    assert webpage_entry["text"] == webpage_description
    assert all(sentence["evidenceIds"] for sentence in webpage_entry["sentences"])
    validation = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": artifact["schemaMarkup"],
            "content": artifact["content"],
            "locale": "ko-KR",
            "sourceProduct": product,
            "evidenceLedger": ledger,
            "publicCopyProvenance": provenance,
        }
    )
    assert not [
        finding
        for finding in validation["validationFindings"]
        if finding["source"] == "public-copy-provenance" and finding["field"] == "WebPage.description"
    ]


def test_structured_table_metrics_render_naturally_in_english_and_korean_with_provenance() -> None:
    """Complete semantic metric components replace OCR/table fragments without losing qualifiers."""

    cases = (
        (
            "en-US",
            _ENGLISH_TABLE_METRIC_SOURCE,
            _ENGLISH_STRUCTURED_METRIC,
            (
                "Hydration",
                "25%",
                "instrumental test",
                "30 women",
                "June 1, 2026",
                "September 20, 2026",
                "Individual results may vary.",
            ),
        ),
        (
            "ko-KR",
            _KOREAN_TABLE_METRIC_SOURCE,
            _KOREAN_STRUCTURED_METRIC,
            ("수분량", "25%", "기기 평가", "30명", "2026.06.01", "2026.09.20", "개인차가 있을 수 있습니다."),
        ),
    )
    for locale, raw_metric, expected_metric, qualifiers in cases:
        product = _structured_metric_product(locale)
        ledger = create_pdp_geo_evidence_ledger(product, locale)
        plan = create_conservative_content_plan({"product": product, "locale": locale, "evidenceLedger": ledger})
        artifact = generate_pdp_geo_artifacts({"product": product, "locale": locale, "contentPlan": plan})
        descriptions = [
            cast(str, _node(artifact["schemaMarkup"], kind)["description"]) for kind in ("Product", "WebPage")
        ]
        faq_answers = [
            item["acceptedAnswer"]["text"]
            for item in cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])
        ]

        for description in descriptions:
            assert raw_metric not in description
            assert expected_metric in description
            assert all(qualifier in description for qualifier in qualifiers)
        assert all(raw_metric not in answer for answer in faq_answers)
        assert expected_metric in faq_answers

        provenance = create_pdp_geo_public_copy_provenance(
            {"schemaMarkup": artifact["schemaMarkup"], "contentPlan": plan, "evidenceLedger": ledger}
        )
        provenance_by_path = {item["fieldPath"]: item for item in provenance}
        for path in ("Product.description", "WebPage.description"):
            assert provenance_by_path[path]["text"] in descriptions
            assert all(sentence["evidenceIds"] for sentence in provenance_by_path[path]["sentences"])
        validation = validate_pdp_geo_artifacts(
            {
                "schemaMarkup": artifact["schemaMarkup"],
                "content": artifact["content"],
                "locale": locale,
                "sourceProduct": product,
                "evidenceLedger": ledger,
                "publicCopyProvenance": provenance,
            }
        )
        assert not [
            finding for finding in validation["validationFindings"] if finding["source"] == "public-copy-provenance"
        ]


def test_relative_ocr_metric_uses_a_natural_participant_share_sentence_with_provenance() -> None:
    """A complete OCR result with a relative duration must not fall back to all-caps source copy."""

    six_week_claim = {
        "metric": "Instrumental improvement",
        "label": "Improvement in wrinkles",
        "subject": "Users of Concentrated Botanical Rejuvenating Cream",
        "value": "100",
        "unit": "%",
        "direction": "improvement",
        "timing": "After 6 weeks of daily use",
        "period": "6 weeks",
        "sample": "31 women",
        "method": "Instrumental result",
        "caveat": "With daily use",
        "sourceText": _LIVE_STYLE_SIX_WEEK_OCR_METRIC,
        "imageUrls": ["https://images.example.test/six-week-result.jpg"],
    }
    seven_day_claim = {
        "metric": "Agreement",
        "label": "Skin feels smoother",
        "subject": "Consumer study participants",
        "value": "94",
        "unit": "%",
        "timing": "After 7 days of use",
        "period": "7 days",
        "sample": "35 women aged 30–65",
        "method": "Consumer study",
        "caveat": "Agreement result",
        "sourceText": _LIVE_STYLE_SEVEN_DAY_OCR_METRIC,
        "imageUrls": ["https://images.example.test/seven-day-result.jpg"],
    }
    expected = (
        "In an instrumental result involving 31 women, 100% showed improvement in wrinkles after 6 weeks of daily use."
    )

    assert render_structured_table_metric_sentence(six_week_claim, "en-US") == expected
    assert render_structured_table_metric_sentence(seven_day_claim, "en-US") == (
        "In a consumer study involving 35 women aged 30–65, 94% agreed that skin feels smoother after 7 days of use."
    )
    product = _cream_rich_product()
    product["semanticFacts"]["metricClaims"] = [six_week_claim, seven_day_claim]
    product["sourceTexts"].extend([_LIVE_STYLE_SIX_WEEK_OCR_METRIC, _LIVE_STYLE_SEVEN_DAY_OCR_METRIC])
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    descriptions = [
        cast(str, _node(artifact["schemaMarkup"], kind)["description"])
        for kind in ("Product", "WebPage")
    ]
    faq_answers = [
        item["acceptedAnswer"]["text"]
        for item in cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])
    ]

    assert all(expected in description for description in descriptions)
    assert all(_LIVE_STYLE_SIX_WEEK_OCR_METRIC not in description for description in descriptions)
    assert all(_LIVE_STYLE_SEVEN_DAY_OCR_METRIC not in description for description in descriptions)
    assert sum(expected in answer for answer in faq_answers) == 1
    assert expected not in faq_answers
    assert _LIVE_STYLE_SEVEN_DAY_OCR_METRIC not in faq_answers

    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": artifact["schemaMarkup"], "contentPlan": plan, "evidenceLedger": ledger}
    )
    for path in ("Product.description", "WebPage.description"):
        entry = next(item for item in provenance if item["fieldPath"] == path)
        metric_sentence = next(sentence for sentence in entry["sentences"] if expected in sentence["text"])
        assert metric_sentence["evidenceIds"]
    validation = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": artifact["schemaMarkup"],
            "content": artifact["content"],
            "locale": "en-US",
            "sourceProduct": product,
            "evidenceLedger": ledger,
            "publicCopyProvenance": provenance,
        }
    )
    assert not [
        finding for finding in validation["validationFindings"] if finding["source"] == "public-copy-provenance"
    ]


def test_malformed_self_assessment_footnote_renders_without_false_clinical_attribution() -> None:
    """A split OCR footnote remains source-faithful without becoming awkward prose.

    The source calls the result a self-assessment and separately contains the
    broken connective ``from clinical``. Public copy must retain the stated
    self-assessment modality, fold its same-footnote daily-use qualifier into
    the duration, and never elevate it into a clinical result.
    """

    claim = {
        "metric": "skin feels firmer and more elastic",
        "value": "100",
        "unit": "%",
        "timing": "After 6 weeks of use",
        "period": "6 weeks",
        "sample": "32 women",
        "method": "Self-assessment from clinical",
        "caveat": "With daily use",
        "sourceText": (
            "AFTER 6 WEEKS OF USE 100% AGREED SKIN FEELS FIRMER AND MORE ELASTIC "
            "2 Self-assessment from clinical, 32 women, with daily use"
        ),
    }

    rendered = render_structured_table_metric_sentence(claim, "en-US")

    assert rendered == (
        "In a self-assessment involving 32 women, 100% agreed that skin feels firmer and more elastic "
        "after 6 weeks of daily use."
    )
    assert "from clinical" not in rendered.casefold()
    assert not rendered.endswith(". With daily use.")


def test_ocr_participant_share_requires_its_explicit_source_predicate() -> None:
    """A nominal result is not silently converted into a numeric delta or participant share."""

    claim = {
        "label": "Improvement in wrinkles",
        "value": "100",
        "unit": "%",
        "direction": "improvement",
        "timing": "After 6 weeks of daily use",
        "period": "6 weeks",
        "sample": "31 women",
        "method": "Instrumental result",
        "caveat": "With daily use",
        "sourceText": (
            "AFTER 6 WEEKS OF USE 100% IMPROVEMENT IN WRINKLES "
            "*Instrumental result, 31 women, with daily use"
        ),
    }

    assert render_structured_table_metric_sentence(claim, "en-US") == ""


def test_live_reduced_metric_uses_only_an_explicit_participant_share_relation() -> None:
    """A participial outcome is not recast as a numeric delta or trailing caveat.

    The source relation (the participants ``showed`` the outcome) is what
    licenses the share grammar.  Without it, the metric remains in the
    evidence ledger but does not become public prose.
    """

    supported_claim = {
        "label": "Reduced fine lines and wrinkles",
        "direction": "reduced",
        "value": "100",
        "unit": "%",
        "timing": "After 4 weeks of daily use",
        "period": "4 weeks",
        "sample": "32 women",
        "method": "Instrumental result",
        "caveat": "With daily use",
        "sourceText": (
            "AFTER 4 WEEKS OF USE 100% OF 32 WOMEN SHOWED REDUCED FINE LINES AND WRINKLES "
            "*Instrumental result, 32 women, with daily use"
        ),
    }
    unsupported_claim = {
        **supported_claim,
        "sourceText": (
            "AFTER 4 WEEKS OF USE 100% REDUCED FINE LINES AND WRINKLES "
            "*Instrumental result, 32 women, with daily use"
        ),
    }
    expected = (
        "In an instrumental result involving 32 women, 100% showed reduced fine lines and wrinkles "
        "after 4 weeks of daily use."
    )

    rendered = render_structured_table_metric_sentence(supported_claim, "en-US")

    assert rendered == expected
    assert "Reduced fine lines and wrinkles reduced" not in rendered
    assert "in the Instrumental result" not in rendered
    assert not rendered.endswith(". With daily use.")
    assert render_structured_table_metric_sentence(unsupported_claim, "en-US") == ""

    product: dict[str, Any] = {
        "name": "Line Care Cream",
        "brand": "Northstar Lab",
        "category": "cream",
        "description": "Line Care Cream is a cream.",
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["Line Care Cream is a cream.", unsupported_claim["sourceText"]],
        "semanticFacts": {"metricClaims": [unsupported_claim]},
    }
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    public_copy = " ".join(
        str(node.get("description", ""))
        for node in cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])
        if {"Product", "WebPage"}
        & set(node["@type"] if isinstance(node.get("@type"), list) else [node.get("@type")])
    )

    assert any(item["role"] == "metric" for item in ledger)
    assert "100%" not in public_copy


def test_ocr_participant_share_binds_the_percentage_to_its_own_outcome() -> None:
    """Independent OCR results cannot cross-bind one percentage to a different outcome."""

    claim = {
        "label": "Skin looks more radiant",
        "value": "94",
        "unit": "%",
        "timing": "After 7 days of use",
        "period": "7 days",
        "sample": "35 women aged 30–65",
        "method": "Consumer study",
        "sourceText": (
            "AFTER 7 DAYS OF USE* 94% AGREE SKIN FEELS SMOOTHER; 85% AGREE SKIN LOOKS MORE RADIANT "
            "*Based on a consumer study of 35 women aged 30–65."
        ),
    }

    assert render_structured_table_metric_sentence(claim, "en-US") == ""


def test_ocr_relative_timing_does_not_pull_a_daily_use_note_from_a_later_sentence() -> None:
    """A split timing qualifier remains local to the measured result instead of borrowing a routine note."""

    claim = {
        "label": "Improvement in wrinkles",
        "value": "100",
        "unit": "%",
        "direction": "improvement",
        "timing": "After 6 weeks of daily use",
        "period": "6 weeks",
        "sample": "31 women",
        "method": "Instrumental result",
        "sourceText": (
            "AFTER 6 WEEKS OF USE 100% OF USERS SHOWED IMPROVEMENT IN WRINKLES "
            "*Instrumental result, 31 women. Daily use is recommended as part of a separate routine."
        ),
    }

    assert render_structured_table_metric_sentence(claim, "en-US") == ""


def test_incomplete_table_metric_is_omitted_without_inventing_a_direction() -> None:
    """A raw table fragment remains source evidence when structured facts cannot support prose."""

    product = _structured_metric_product("en-US")
    product["semanticFacts"] = {
        "metricClaims": [
            {
                "metric": "hydration",
                "value": "25",
                "unit": "%",
                "period": "2026.06.01 ~ 2026.09.20",
                "sample": "30 women",
                "sourceText": _ENGLISH_TABLE_METRIC_SOURCE,
            }
        ]
    }
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    rendered = " ".join(
        [cast(str, _node(artifact["schemaMarkup"], kind)["description"]) for kind in ("Product", "WebPage")]
    )

    assert _ENGLISH_TABLE_METRIC_SOURCE not in rendered
    assert "hydration increased by 25%" not in rendered.casefold()


def test_aggregate_only_rating_renders_as_a_factual_rating_not_customer_feedback() -> None:
    """A score/count can be public only as a rating fact, never invented review prose."""

    product = _cream_rich_product()
    product["reviews"] = {
        "items": [],
        "keywords": [],
        "rating": 4.8,
        "reviewCount": 1905,
    }
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    rendered_product = _node(artifact["schemaMarkup"], "Product")
    descriptions = [cast(str, _node(artifact["schemaMarkup"], kind)["description"]) for kind in ("Product", "WebPage")]
    faq = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])
    rating_sentence = (
        "SampleBotanics's Concentrated Botanical Rejuvenating Cream Rich received 4.8 out of 5 from 1905 customer ratings."
    )
    rating_item = next(item for item in faq if item["acceptedAnswer"]["text"] == rating_sentence)
    public_output = "\n".join([*descriptions, *(item["acceptedAnswer"]["text"] for item in faq)])

    assert rendered_product["aggregateRating"] == {"@type": "AggregateRating", "ratingValue": 4.8, "reviewCount": 1905}
    assert all(rating_sentence in description for description in descriptions)
    assert "customer rating" in rating_item["name"].casefold()
    assert "feedback" not in rating_item["name"].casefold()
    assert "customers who reviewed" not in public_output.casefold()
    assert "customer feedback" not in descriptions[1].casefold()

    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": artifact["schemaMarkup"], "contentPlan": plan, "evidenceLedger": ledger}
    )
    validation = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": artifact["schemaMarkup"],
            "content": artifact["content"],
            "locale": "en-US",
            "sourceProduct": product,
            "evidenceLedger": ledger,
            "publicCopyProvenance": provenance,
        }
    )
    assert not [
        finding
        for finding in validation["validationFindings"]
        if finding["source"] == "public-copy-provenance"
        and finding["field"] in {"Product.description", "WebPage.description"}
    ]


def test_first_care_style_fallback_keeps_source_facts_without_provenance_failures() -> None:
    """A no-review PDP can retain its source role flow and still publish safely."""

    product = _first_care_product_without_review_bodies()
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": artifact["schemaMarkup"], "contentPlan": plan, "evidenceLedger": ledger}
    )
    validation = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": artifact["schemaMarkup"],
            "content": artifact["content"],
            "locale": "en-US",
            "sourceProduct": product,
            "evidenceLedger": ledger,
            "publicCopyProvenance": provenance,
        }
    )
    descriptions = [cast(str, _node(artifact["schemaMarkup"], kind)["description"]) for kind in ("Product", "WebPage")]

    assert all("Customer reviews" not in description for description in descriptions)
    assert all("For normal, dry, combination, and oily skin types." in description for description in descriptions)
    assert all("Hydrating" in description for description in descriptions)
    assert not [
        finding for finding in validation["validationFindings"] if finding["source"] == "public-copy-provenance"
    ]


def test_numeric_formula_identifier_does_not_bypass_an_unproven_metric_claim() -> None:
    """A numeric ingredient name is composition; an added result still needs its own source."""

    evidence = [
        {"role": "identity", "text": "Formula Serum"},
        {"role": "ingredient", "text": "500-Hour Aged Ginseng Extract"},
    ]

    assert sentence_evidence_has_direct_claim_support("Formula Serum includes 500-Hour Aged Ginseng Extract.", evidence)
    assert not sentence_evidence_has_direct_claim_support(
        "Formula Serum includes 500-Hour Aged Ginseng Extract and improves hydration by 25%.", evidence
    )


def test_korean_product_name_digits_are_an_identifier_not_a_measurement() -> None:
    """``BarrierCare365`` names the cleanser; only an unsourced value stays a metric claim."""

    evidence = [
        {"role": "identity", "text": "SampleDerma BarrierCare365 젠틀 포밍클렌저"},
        {"role": "identity", "text": "SAMPLE_DERMA"},
        {"role": "identity", "text": "클렌저"},
        {"role": "benefit", "text": "촉촉한 클렌징으로 피부 장벽은 지키고 메이크업 잔여물은 깨끗하게 세정"},
        {"role": "ingredient", "text": "정제수"},
        {"role": "ingredient", "text": "글리세린"},
        {"role": "ingredient", "text": "솔비톨"},
    ]

    assert sentence_evidence_has_direct_claim_support(
        "SAMPLE_DERMA의 SampleDerma BarrierCare365 젠틀 포밍클렌저에는 정제수, 글리세린, 솔비톨 등이 주요 성분·기술로 "
        "포함되어 있습니다.",
        evidence,
    )
    assert sentence_evidence_has_direct_claim_support(
        "SAMPLE_DERMA의 SampleDerma BarrierCare365 젠틀 포밍클렌저에는 촉촉한 클렌징으로 피부 장벽은 지키고 메이크업 "
        "잔여물은 깨끗하게 세정 관련 효능·효과가 표기되어 있습니다.",
        evidence,
    )
    assert not sentence_evidence_has_direct_claim_support(
        "SAMPLE_DERMA의 SampleDerma BarrierCare365 젠틀 포밍클렌저는 초미세먼지를 99.9% 세정합니다.", evidence
    )


def test_shortened_product_name_still_identifies_its_own_digits() -> None:
    """A renderer may drop the volume suffix; the remaining name still owns its number."""

    evidence = [
        {"role": "identity", "text": "SampleDerma BarrierCare365 클렌징폼 200g"},
        {"role": "identity", "text": "SAMPLE_DERMA"},
        {"role": "ingredient", "text": "판테놀"},
        {"role": "ingredient", "text": "베타인"},
        {"role": "ingredient", "text": "더마온"},
    ]

    assert sentence_evidence_has_direct_claim_support(
        "SAMPLE_DERMA의 SampleDerma BarrierCare365 클렌징폼에는 판테놀, 베타인, 더마온 등이 주요 성분·기술로 포함되어 "
        "있습니다.",
        evidence,
    )
    assert not sentence_evidence_has_direct_claim_support(
        "SAMPLE_DERMA의 SampleDerma BarrierCare365 클렌징폼은 초미세먼지를 99.9% 세정합니다.", evidence
    )


def test_english_product_name_digits_are_an_identifier_not_a_measurement() -> None:
    """``BARRIER_CARE365`` names the cream, and a digit-free name is left untouched."""

    evidence = _named_cream_evidence("SAMPLE_DERMA", "BARRIER_CARE365 Cream")

    assert sentence_evidence_has_direct_claim_support(
        "SAMPLE_DERMA's BARRIER_CARE365 Cream contains Ceramide NP and Panthenol as key ingredients.", evidence
    )
    assert not sentence_evidence_has_direct_claim_support(
        "SAMPLE_DERMA's BARRIER_CARE365 Cream removes 99.9% of ultrafine dust.", evidence
    )
    assert sentence_evidence_has_direct_claim_support(
        "SampleBotanics's Concentrated Botanical Rejuvenating Cream Rich contains Ceramide NP and Panthenol as key "
        "ingredients.",
        _named_cream_evidence("SampleBotanics", "Concentrated Botanical Rejuvenating Cream Rich"),
    )


def test_generic_source_subject_survives_final_provenance_isolation() -> None:
    """Replacing only ``This shampoo`` with the named entity must remain publishable."""

    product: dict[str, Any] = {
        "name": "Ocean Wash",
        "brand": "Blue Lab",
        "category": "shampoo",
        "description": "This shampoo is designed for swimmers.",
        "sourceTexts": ["This shampoo is designed for swimmers."],
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
    }

    run = asyncio.run(generate_pdp_geo({"product": product, "hints": {"locale": "en-US"}}))["result"]
    graph = cast(list[dict[str, Any]], run["schemaMarkup"]["jsonLd"]["@graph"])
    product_node = next(node for node in graph if node.get("@type") == "Product")
    webpage_node = next(node for node in graph if "WebPage" in cast(list[str], node.get("@type", [])))

    assert product_node["description"] == "Ocean Wash from Blue Lab is designed for swimmers."
    assert webpage_node["description"].endswith("Ocean Wash from Blue Lab is designed for swimmers.")
    assert run["content"]["sections"]["description"] == product_node["description"]
    assert not [
        finding
        for finding in run["diagnostics"]["validationFindings"]
        if finding["source"] == "public-copy-provenance"
    ]


def test_generic_formula_subject_survives_final_provenance_isolation() -> None:
    """A named rewrite of ``This powerful formula`` keeps its exact source predicate."""

    source = "This powerful formula is enhanced with advanced capsule technology for optimal absorption."
    product: dict[str, Any] = {
        "name": "Renewal Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": source,
        "sourceTexts": [source],
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
    }

    run = asyncio.run(generate_pdp_geo({"product": product, "hints": {"locale": "en-US"}}))["result"]
    graph = cast(list[dict[str, Any]], run["schemaMarkup"]["jsonLd"]["@graph"])
    product_node = next(node for node in graph if node.get("@type") == "Product")
    webpage_node = next(node for node in graph if "WebPage" in cast(list[str], node.get("@type", [])))

    named_source = "Renewal Serum from Northstar Lab is enhanced with advanced capsule technology for optimal absorption."
    assert product_node["description"] == named_source
    assert named_source in webpage_node["description"]
    assert not [
        finding
        for finding in run["diagnostics"]["validationFindings"]
        if finding["source"] == "public-copy-provenance"
        and finding["field"] in {"Product.description", "WebPage.description"}
    ]


def test_bare_formula_effect_does_not_become_a_buyer_audience_faq() -> None:
    """An efficacy sentence mentioning wrinkles is not itself a customer target."""

    formula = "The serum uses Retinol to visibly improve wrinkles."
    product: dict[str, Any] = {
        "name": "Renewal Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "Renewal Serum is a fast-absorbing serum.",
        "sourceTexts": [formula],
        "ingredients": ["Retinol"],
        "benefits": ["Visibly improves wrinkles"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "semanticFacts": {
            "ingredientBenefitLinks": [
                {"ingredient": "Retinol", "benefit": "wrinkles", "sourceText": formula}
            ]
        },
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    faq = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])

    assert not any("who is" in item["name"].casefold() or " offer for " in item["name"].casefold() for item in faq)


def test_generic_source_audience_starts_buyer_faq_with_named_product_identity() -> None:
    """A source audience relation from OCR/semantic evidence keeps its named subject."""

    audience = "This serum works best for dry skin."
    formula = "Retinol helps improve the look of fine lines."
    product: dict[str, Any] = {
        "name": "Renewal Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "Renewal Serum is a fast-absorbing serum.",
        "sourceTexts": [audience, formula],
        "ingredients": ["Retinol"],
        "benefits": ["Improves the look of fine lines"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "semanticFacts": {
            "skinTypes": ["dry skin"],
            "evidenceSentences": [audience],
            "ingredientBenefitLinks": [
                {"ingredient": "Retinol", "benefit": "fine lines", "sourceText": formula}
            ],
        },
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    faq = cast(list[dict[str, Any]], _node(artifact["schemaMarkup"], "FAQPage")["mainEntity"])
    buyer = next(item for item in faq if " best for?" in item["name"].casefold())

    assert buyer["acceptedAnswer"]["text"].startswith(
        "Northstar Lab's Renewal Serum works best for dry skin."
    )


def test_all_caps_ocr_formula_link_is_rendered_as_natural_sentence_case() -> None:
    """A trustworthy OCR relation keeps its meaning without publishing image-style all caps."""

    source = "NIACINAMIDE HELPS IMPROVE SKIN RADIANCE."
    product: dict[str, Any] = {
        "name": "Radiance Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "Radiance Serum is a serum.",
        "sourceTexts": [source],
        "ingredients": ["Niacinamide"],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "semanticFacts": {
            "ingredientBenefitLinks": [
                {"ingredient": "Niacinamide", "benefit": "skin radiance", "sourceText": source}
            ]
        },
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    description = cast(str, _node(artifact["schemaMarkup"], "Product")["description"])

    assert "Niacinamide helps improve skin radiance." in description
    assert source not in description

    run = asyncio.run(generate_pdp_geo({"product": product, "hints": {"locale": "en-US"}}))["result"]
    graph = cast(list[dict[str, Any]], run["schemaMarkup"]["jsonLd"]["@graph"])
    published = next(node for node in graph if node.get("@type") == "Product")
    assert "Niacinamide helps improve skin radiance." in published["description"]
    assert not [
        finding
        for finding in run["diagnostics"]["validationFindings"]
        if finding["source"] == "public-copy-provenance"
    ]


def test_sentence_like_benefit_properties_keep_complete_facts_as_sentences() -> None:
    """PropertyValue facts should not join two complete claims with a dangling ``and``."""

    product: dict[str, Any] = {
        "name": "Cloud Firm Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "Cloud Firm Serum is a serum.",
        "sourceTexts": [
            "Cloud Firm Serum is a serum.",
            "Improves the look of skin firmness.",
            "Visibly improves skin elasticity.",
        ],
        "ingredients": ["Peptide", "Niacinamide", "Vitamin E"],
        "benefits": ["Improves the look of skin firmness", "Visibly improves skin elasticity"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    properties = {
        item["name"]: item["value"]
        for item in cast(list[dict[str, str]], _node(artifact["schemaMarkup"], "Product")["additionalProperty"])
    }

    assert properties["Key efficacy"] == (
        "Cloud Firm Serum from Northstar Lab improves the look of skin firmness. "
        "Cloud Firm Serum from Northstar Lab visibly improves skin elasticity."
    )


def test_nominal_source_descriptor_gets_a_natural_named_subject_with_provenance() -> None:
    """A terse descriptor keeps its source phrase while gaining a citation-ready identity."""

    product: dict[str, Any] = {
        "name": "Ocean Shampoo",
        "brand": "North Coast",
        "category": "shampoo",
        "description": "Gentle cleansing for dry hair.",
        "sourceTexts": ["Gentle cleansing for dry hair."],
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
    }

    run = asyncio.run(generate_pdp_geo({"product": product, "hints": {"locale": "en-US"}}))["result"]
    graph = cast(list[dict[str, Any]], run["schemaMarkup"]["jsonLd"]["@graph"])
    product_node = next(node for node in graph if node.get("@type") == "Product")
    webpage_node = next(node for node in graph if "WebPage" in cast(list[str], node.get("@type", [])))

    expected = "Ocean Shampoo from North Coast offers gentle cleansing for dry hair."
    assert product_node["description"] == expected
    assert webpage_node["description"].endswith(expected)
    assert "is described as" not in product_node["description"].casefold()
    assert not [
        finding
        for finding in run["diagnostics"]["validationFindings"]
        if finding["source"] == "public-copy-provenance"
    ]


def test_rich_arbitrary_category_clauses_remain_clauses_not_customer_targets() -> None:
    """Full source predicates stay readable across categories and locales."""

    english: dict[str, Any] = {
        "name": "Volume Wash",
        "brand": "Blue Lab",
        "category": "shampoo",
        "description": "This shampoo cleanses fine hair.",
        "ingredients": ["Betaine", "Sea silk", "Panthenol"],
        "benefits": ["Adds lightweight volume for fine strands all day.", "Controls shine for a balanced finish."],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [
            "This shampoo cleanses fine hair.",
            "Adds lightweight volume for fine strands all day.",
            "Controls shine for a balanced finish.",
        ],
        "semanticFacts": {"ingredients": ["Betaine", "Sea silk", "Panthenol"]},
    }
    korean: dict[str, Any] = {
        "name": "컬러 케어 샴푸",
        "brand": "예시 랩",
        "category": "샴푸",
        "description": "컬러 케어 샴푸는 염색 모발을 위한 샴푸입니다.",
        "ingredients": ["베타인", "씨 실크", "판테놀"],
        "benefits": ["젖은 모발을 부드럽게 풀어줍니다.", "모발에 가벼운 볼륨을 더합니다."],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [
            "컬러 케어 샴푸는 염색 모발을 위한 샴푸입니다.",
            "젖은 모발을 부드럽게 풀어줍니다.",
            "모발에 가벼운 볼륨을 더합니다.",
        ],
        "semanticFacts": {"ingredients": ["베타인", "씨 실크", "판테놀"], "skinTypes": ["염색 모발"]},
    }

    english_artifact = generate_pdp_geo_artifacts({"product": english, "locale": "en-US"})
    english_product = _node(english_artifact["schemaMarkup"], "Product")
    english_description = cast(str, english_product["description"])
    english_faq_node = next(
        (
            node
            for node in cast(list[dict[str, Any]], english_artifact["schemaMarkup"]["jsonLd"]["@graph"])
            if "FAQPage" in cast(list[str], node.get("@type", []))
        ),
        cast(dict[str, Any], {}),
    )
    english_faq = cast(list[dict[str, Any]], english_faq_node.get("mainEntity", []))
    english_properties = cast(list[dict[str, str]], english_product["additionalProperty"])
    english_property_values = " ".join(property_["value"] for property_ in english_properties)

    assert "Volume Wash adds lightweight volume for fine strands all day." in english_description
    assert "Volume Wash controls shine for a balanced finish." in english_description
    assert not any(question["name"].startswith("Who is ") for question in english_faq)
    assert "identifies Adds" not in english_property_values
    assert "include Adds" not in english_property_values

    korean_artifact = generate_pdp_geo_artifacts({"product": korean, "locale": "ko-KR"})
    korean_product = _node(korean_artifact["schemaMarkup"], "Product")
    korean_description = cast(str, korean_product["description"])
    korean_properties = cast(list[dict[str, str]], korean_product["additionalProperty"])
    korean_by_name = {property_["name"]: property_["value"] for property_ in korean_properties}

    assert "컬러 케어 샴푸는 젖은 모발을 부드럽게 풀어줍니다." in korean_description
    assert "풀어줍니다. 관련 효능·효과" not in korean_description
    assert korean_by_name["Target customer"] == "염색 모발"
    assert "Recommended skin type" not in korean_by_name
    assert "더합니다.이 확인됩니다" not in " ".join(korean_by_name.values())


def test_service_retains_source_backed_benefit_predicates_without_a_fixed_verb_list() -> None:
    """Final provenance keeps arbitrary, source-backed benefit grammar intact.

    The normalization and deterministic renderer both preserve direct benefit
    clauses.  Exercise the service boundary too: otherwise a narrower
    proofreader predicate list can quietly remove good public copy after
    generation has already accepted it.
    """

    # 정체성 문장이 브랜드를 소개한 뒤이므로 효능 절은 상품명만 부른다.
    cases = {
        "Adds lightweight volume.": "Aero Comb adds lightweight volume.",
        "Repels dust from the screen.": "Aero Comb repels dust from the screen.",
        "Delivers visible radiance.": "Aero Comb delivers visible radiance.",
        "Contributes to hair softness.": "Aero Comb contributes to hair softness.",
        "The flexible teeth gently detangle wet hair.": "The flexible teeth gently detangle wet hair.",
    }
    for source_benefit, expected in cases.items():
        product: dict[str, Any] = {
            "name": "Aero Comb",
            "brand": "Neo",
            "category": "comb",
            "description": "A comb.",
            "ingredients": [],
            "benefits": [source_benefit],
            "effects": [],
            "usage": [],
            "metrics": [],
            "options": [],
            "faq": [],
            "reviews": {"items": [], "keywords": []},
            "sourceTexts": ["A comb.", source_benefit],
        }

        run = asyncio.run(generate_pdp_geo({"product": product, "hints": {"locale": "en-US"}}))["result"]
        product_node = _node(cast(dict[str, Any], run["schemaMarkup"]), "Product")
        webpage_node = next(
            node
            for node in cast(list[dict[str, Any]], run["schemaMarkup"]["jsonLd"]["@graph"])
            if "WebPage" in cast(list[str], node.get("@type", []))
        )

        assert expected in cast(str, product_node["description"])
        assert expected in cast(str, webpage_node["description"])
        assert "The stated benefits of Aero Comb from Neo include The flexible teeth" not in cast(
            str, product_node["description"]
        )
        assert not [
            finding
            for finding in run["diagnostics"]["validationFindings"]
            if finding["source"] == "public-copy-provenance"
        ]


def test_service_keeps_direct_source_faq_identity_framing_for_arbitrary_predicates() -> None:
    """A direct ``Does this …?`` source FAQ remains a branded customer question.

    The identity rewrite changes only the source question's visible subject;
    it must not rely on a closed efficacy-verb vocabulary or drop the exact
    source answer after final provenance reconciliation.
    """

    product: dict[str, Any] = {
        "name": "Aero Comb",
        "brand": "Neo",
        "category": "comb",
        "description": "A comb.",
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [
            {
                "question": "Does this detangle wet hair?",
                "answer": "Yes, this detangles wet hair.",
            }
        ],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["A comb.", "Does this detangle wet hair?", "Yes, this detangles wet hair."],
    }

    run = asyncio.run(generate_pdp_geo({"product": product, "hints": {"locale": "en-US"}}))["result"]
    faq_node = next(
        node
        for node in cast(list[dict[str, Any]], run["schemaMarkup"]["jsonLd"]["@graph"])
        if node.get("@type") == "FAQPage"
    )
    item = cast(list[dict[str, Any]], faq_node["mainEntity"])[0]

    assert item["name"] == "Does Neo's Aero Comb detangle wet hair?"
    assert item["acceptedAnswer"]["text"] == "Yes, this detangles wet hair."
    assert not [
        finding
        for finding in run["diagnostics"]["validationFindings"]
        if finding["source"] == "public-copy-provenance"
    ]


def test_publication_gate_keeps_product_language_that_overlaps_commerce_tokens() -> None:
    """Commerce screening must be phrase-aware instead of suppressing product facts."""

    facts = [
        "This wash-off mask hydrates dry skin.",
        "This rinse-off conditioner detangles wet hair.",
        "A targeted delivery system helps release niacinamide.",
        "This point treatment visibly calms blemishes.",
        "The serum is rated for sensitive skin.",
    ]
    commerce = ["Free shipping on orders over $50.", "Save 20% off today.", "Customer rated this 5 stars."]

    assert all(is_publishable_description_text(value, "en-US") for value in facts)
    assert all(not is_merchant_or_review_copy(value) for value in facts)
    assert retain_publishable_description_sentences(" ".join(facts), "en-US") == " ".join(facts)
    assert all(is_merchant_or_review_copy(value) for value in commerce)
    assert all(not is_publishable_description_text(value, "en-US") for value in commerce)


def test_generic_formula_source_opener_gets_a_named_product_lead() -> None:
    """A demonstrative formula clause needs a prior brand/product antecedent."""

    source = "This powerful formula is enhanced with advanced capsule technology for optimal absorption."
    product: dict[str, Any] = {
        "name": "Renewal Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": source,
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [source],
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    description = cast(str, _node(artifact["schemaMarkup"], "Product")["description"])

    assert description.startswith("Renewal Serum from Northstar Lab is enhanced with advanced capsule technology")
    assert "is a serum" not in description


def test_webpage_fallback_uses_a_natural_product_page_scope_opener() -> None:
    """Page copy identifies its product page without an observer-style wrapper."""

    source = "This powerful formula is enhanced with advanced capsule technology for optimal absorption."
    product: dict[str, Any] = {
        "name": "Renewal Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": source,
        "ingredients": ["Advanced Capsule Technology"],
        "benefits": ["Supports a smoother-looking texture"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [source, "Supports a smoother-looking texture."],
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    description = cast(str, _node(artifact["schemaMarkup"], "WebPage")["description"])

    assert description.startswith("The product page for Renewal Serum from Northstar Lab covers ")
    assert "is presented with product details" not in description
    assert "Renewal Serum from Northstar Lab is enhanced with advanced capsule technology" in description
    assert source not in description


def test_natural_webpage_overview_keeps_closed_source_coverage_bindings() -> None:
    """An audience-led page opener binds exactly the page and the customer it names."""

    product = _cream_rich_product()
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": artifact["schemaMarkup"], "contentPlan": plan, "evidenceLedger": ledger}
    )
    evidence_by_id = {item["id"]: item for item in ledger}
    page_entries = [item for item in provenance if item["fieldPath"] == "WebPage.description"]

    assert len(page_entries) == 1
    page_entry = page_entries[0]
    overview = page_entry["sentences"][0]

    assert overview["text"].startswith(
        "The product page for Concentrated Botanical Rejuvenating Cream Rich from SampleBotanics introduces a cream for "
    )
    # The opener states the page's identity and its customer, so those are the
    # only roles it may claim: a coverage label bound the roles it listed, and
    # an audience lead must not keep those bindings once it stops listing them.
    assert {evidence_by_id[evidence_id]["role"] for evidence_id in overview["evidenceIds"]} == {
        "identity",
        "audience",
    }


def test_product_descriptor_in_benefits_is_not_rendered_as_a_stated_benefit() -> None:
    """A leaked product-form descriptor is not a finished-product outcome."""

    descriptor = "Lightweight, fast-absorbing firming serum."
    product: dict[str, Any] = {
        "name": "Cloud Firm Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "Cloud Firm Serum is a serum.",
        "ingredients": [],
        "benefits": [descriptor, "Supports skin firmness."],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["Cloud Firm Serum is a serum.", "Supports skin firmness."],
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    description = cast(str, _node(artifact["schemaMarkup"], "Product")["description"])

    assert descriptor not in description
    assert "supports skin firmness" in description.casefold()


def test_rich_product_descriptor_is_not_published_in_benefit_properties() -> None:
    """A rich source may retain a product-form descriptor in extraction, not as a stated efficacy property."""

    descriptor = "Lightweight, fast-absorbing firming serum."
    effect = "Improves the look of skin firmness."
    product: dict[str, Any] = {
        "name": "Cloud Firm Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "Cloud Firm Serum is a serum.",
        "ingredients": ["Peptide Complex", "Niacinamide", "Vitamin B5"],
        "benefits": [descriptor, effect],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["Cloud Firm Serum is a serum.", effect],
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    properties = cast(list[dict[str, str]], _node(artifact["schemaMarkup"], "Product")["additionalProperty"])
    properties_by_name = {item["name"]: item["value"] for item in properties}

    # A published attribute names a thing in keywords, so a composed benefit
    # sentence is published in the description that owns it.  What this test
    # guards is unchanged: a product-form descriptor is never published as a
    # stated efficacy, under any attribute name.
    assert "Cloud Firm Serum improves the look of skin firmness." in cast(
        str, _node(artifact["schemaMarkup"], "Product")["description"]
    )
    assert descriptor not in "\n".join(properties_by_name.values())
    assert descriptor not in cast(str, _node(artifact["schemaMarkup"], "Product")["description"])


def test_rich_generic_product_subject_benefit_uses_the_named_entity() -> None:
    """A generic product subject in a source benefit remains factual but citation-ready."""

    generic_subject_benefit = (
        "The serum is a ginseng anti-aging serum designed to visibly improve wrinkles, firmness, and elasticity."
    )
    product: dict[str, Any] = {
        "name": "Renewal Ginseng Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "This formula is enhanced with a peptide complex.",
        "ingredients": ["Ginseng Extract", "Peptide Complex", "Niacinamide"],
        "benefits": [generic_subject_benefit],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["This formula is enhanced with a peptide complex.", generic_subject_benefit],
    }

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    product_description = cast(str, _node(artifact["schemaMarkup"], "Product")["description"])
    webpage_description = cast(str, _node(artifact["schemaMarkup"], "WebPage")["description"])
    properties = cast(list[dict[str, str]], _node(artifact["schemaMarkup"], "Product")["additionalProperty"])
    properties_by_name = {item["name"]: item["value"] for item in properties}

    expected = (
        "Renewal Ginseng Serum from Northstar Lab is a ginseng anti-aging serum designed to visibly improve "
        "wrinkles, firmness, and elasticity."
    )
    # 설명문에서는 앞 문장이 이미 브랜드를 소개했으므로 상품명만 남는다.
    expected_in_description = expected.replace(" from Northstar Lab", "", 1)
    assert expected_in_description in product_description
    assert expected_in_description in webpage_description
    assert generic_subject_benefit not in product_description
    assert generic_subject_benefit not in webpage_description
    # The entity-named benefit is published in the description; an attribute
    # publishes keywords, so it is not restated there under a label.
    assert generic_subject_benefit not in "\n".join(properties_by_name.values())

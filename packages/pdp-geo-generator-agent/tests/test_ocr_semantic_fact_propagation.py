"""OCR semantic evidence must survive the extractor-to-generator boundary."""

from __future__ import annotations

from typing import Any, NotRequired, TypedDict

import pytest

from pdp_geo_generator_agent.content_planning import create_pdp_geo_evidence_ledger
from pdp_geo_generator_agent.generation import _naturalize_ocr_formula_sentence
from pdp_geo_generator_agent.normalization import normalize_pdp_product

IMAGE_URL = "https://images.example.test/clinical-panel.png"
FORMULA_SOURCE = "The ceramide formula supports hydration."
METRIC_SOURCE = "Hydration improved by 50% after 4 weeks in an instrumental assessment. Individual results may vary."
USAGE_STEPS = [
    "1. After cleansing, apply one pump over the face and neck.",
    "2. Press gently until absorbed.",
]


class _IngredientBenefitLink(TypedDict):
    ingredient: str
    sourceText: str
    benefit: NotRequired[str]
    effect: NotRequired[str]
    imageUrls: NotRequired[list[str]]


def _extractor_envelope() -> dict[str, Any]:
    """Use the published extractor envelope, not a hand-flattened product."""

    return {
        "geoProduct": {
            "name": "Evidence Serum",
            "sourceExtraction": {
                "ocr": {
                    "imageTexts": [
                        {
                            "imageUrl": IMAGE_URL,
                            "confidence": 0.82,
                            "text": "\n".join([FORMULA_SOURCE, METRIC_SOURCE, *USAGE_STEPS]),
                        }
                    ],
                    "textBlocks": [FORMULA_SOURCE, METRIC_SOURCE, *USAGE_STEPS],
                    "sentenceInsights": [
                        {
                            "text": FORMULA_SOURCE,
                            "category": "ingredient",
                            "keywords": ["ceramide formula"],
                            "imageUrls": [IMAGE_URL],
                        },
                        {
                            "text": METRIC_SOURCE,
                            "category": "metric",
                            "imageUrls": [IMAGE_URL],
                        },
                        *[
                            {
                                "text": step,
                                "category": "usage",
                                "imageUrls": [IMAGE_URL],
                            }
                            for step in USAGE_STEPS
                        ],
                    ],
                    "semanticFacts": {
                        "ingredients": ["ceramide formula"],
                        "benefits": ["hydration"],
                        "effects": [],
                        "usageSteps": USAGE_STEPS,
                        "metricClaims": [
                            {
                                "metric": "hydration",
                                "value": "50",
                                "unit": "%",
                                "timing": "after 4 weeks",
                                "method": "instrumental assessment",
                                "caveat": "Individual results may vary.",
                                "sourceText": METRIC_SOURCE,
                                "imageUrls": [IMAGE_URL],
                            }
                        ],
                        "ingredientBenefitLinks": [
                            {
                                "ingredient": "ceramide formula",
                                "benefit": "hydration",
                                "sourceText": FORMULA_SOURCE,
                                "imageUrls": [IMAGE_URL],
                            }
                        ],
                    },
                }
            },
        }
    }


def test_normalizer_promotes_wrapped_ocr_semantic_relationships_and_qualifiers() -> None:
    result = normalize_pdp_product(_extractor_envelope())

    product = result["product"]
    facts = product["semanticFacts"]
    assert facts["ingredients"] == ["ceramide formula"]
    assert facts["benefits"] == ["hydration"]
    assert facts["usageSteps"] == USAGE_STEPS
    assert product["ingredients"] == ["ceramide formula"]
    assert product["benefits"] == ["hydration"]

    metric = facts["metricClaims"][0]
    assert metric["metric"] == "hydration"
    assert metric["timing"] == "after 4 weeks"
    assert metric["method"] == "instrumental assessment"
    assert metric["caveat"] == "Individual results may vary."
    assert metric["imageUrls"] == [IMAGE_URL]

    link = facts["ingredientBenefitLinks"][0]
    assert link["ingredient"] == "ceramide formula"
    assert link["benefit"] == "hydration"
    assert link["sourceText"] == FORMULA_SOURCE
    assert link["imageUrls"] == [IMAGE_URL]


def test_normalizer_keeps_ocr_sentence_lineage_for_diagnostics_and_ledger() -> None:
    result = normalize_pdp_product(_extractor_envelope())

    product = result["product"]
    assert product["sourceTextMeta"][FORMULA_SOURCE] == {
        "imageUrls": [IMAGE_URL],
        "ocrConfidence": 0.82,
    }
    diagnostic = next(item for item in result["ocrSentences"] if item["text"] == FORMULA_SOURCE)
    assert diagnostic["imageUrls"] == [IMAGE_URL]
    assert "ingredient" in diagnostic["intents"]
    assert "Product.description" in diagnostic["schemaFields"]

    ledger = create_pdp_geo_evidence_ledger(product, result["locale"])
    evidence = next(
        item for item in ledger if item["text"] == FORMULA_SOURCE and item.get("ocrConfidence") == 0.82
    )
    assert evidence["imageUrls"] == [IMAGE_URL]
    assert evidence["ocrConfidence"] == 0.82


def test_normalizer_rejects_unqualified_ocr_metric_and_unlinked_co_mentions() -> None:
    payload = _extractor_envelope()
    ocr = payload["geoProduct"]["sourceExtraction"]["ocr"]
    unqualified_metric = "Hydration 50%"
    unlinked_co_mention = "The ceramide formula is present. Hydration is discussed separately."
    ocr["imageTexts"][0]["text"] = "\n".join([unqualified_metric, unlinked_co_mention])
    ocr["textBlocks"] = [unqualified_metric, unlinked_co_mention]
    ocr["sentenceInsights"] = [
        {"text": unqualified_metric, "category": "metric", "imageUrls": [IMAGE_URL]},
        {
            "text": unlinked_co_mention,
            "category": "ingredient",
            "keywords": ["ceramide formula"],
            "imageUrls": [IMAGE_URL],
        },
    ]
    facts = ocr["semanticFacts"]
    facts["metricClaims"] = [
        {
            "metric": "hydration",
            "value": "50",
            "unit": "%",
            "sourceText": unqualified_metric,
            "imageUrls": [IMAGE_URL],
        }
    ]
    facts["ingredientBenefitLinks"] = [
        {
            "ingredient": "ceramide formula",
            "benefit": "hydration",
            "sourceText": unlinked_co_mention,
            "imageUrls": [IMAGE_URL],
        }
    ]

    result = normalize_pdp_product(payload)
    normalized = result["product"]["semanticFacts"]

    assert normalized["metricClaims"] == []
    assert normalized["ingredientBenefitLinks"] == []
    assert normalized["ingredients"] == ["ceramide formula"]
    assert normalized["benefits"] == ["hydration"]
    assert any(
        item["field"] == "product.semanticFacts.ingredientBenefitLinks"
        and item["source"] == "normalizer"
        and "rejected" in item["value"].casefold()
        and "did not establish" in item["value"].casefold()
        for item in result["evidence"]
    )


@pytest.mark.parametrize(
    "benefit",
    [
        "The flexible teeth gently detangle wet hair.",
        "Adds lightweight volume.",
        "Repels dust from the screen.",
        "Keeps strands smooth.",
        "Delivers visible radiance.",
        "Contributes to hair softness.",
        "모발에 가벼운 볼륨을 더합니다.",
    ],
)
def test_normalizer_keeps_source_backed_top_level_declarative_benefits_without_a_fixed_predicate_list(
    benefit: str,
) -> None:
    product = normalize_pdp_product(
        {
            "name": "Example Product",
            "benefits": [benefit],
            "sourceTexts": [benefit],
        }
    )["product"]

    assert product["benefits"] == [benefit]
    assert product["effects"] == []
    assert product["semanticFacts"]["ingredientBenefitLinks"] == []
    assert benefit in product["sourceTexts"]


def test_normalizer_requires_source_backing_and_preserves_non_benefit_role_guards() -> None:
    unbacked = "Repels dust from the screen."
    rejected = [
        "Apply daily to improve softness.",
        "Free shipping.",
        "Customers say it detangles hair.",
        "Patch test before use.",
        "Helps determine whether the product is right for you.",
        "Customers love the smooth finish.",
        "Not tested on animals.",
    ]
    product = normalize_pdp_product(
        {
            "name": "Example Product",
            "benefits": [unbacked, *rejected],
            "sourceTexts": rejected,
        }
    )["product"]

    assert product["benefits"] == []
    assert product["semanticFacts"]["ingredientBenefitLinks"] == []


@pytest.mark.parametrize(
    ("ingredient", "benefit", "source"),
    [
        ("Betaine", "hair softness", "Betaine contributes to hair softness."),
        ("Sea silk", "wet hair", "Sea silk detangles wet hair."),
        ("Vitamin C", "visible radiance", "Vitamin C delivers visible radiance."),
        ("Panthenol", "strands smooth", "Panthenol keeps strands smooth."),
    ],
)
def test_normalizer_preserves_explicit_ocr_relations_without_a_fixed_benefit_verb_list(
    ingredient: str, benefit: str, source: str
) -> None:
    """A relation record is enough to recover its explicit ingredient and outcome atoms."""

    relation = {"ingredient": ingredient, "benefit": benefit, "sourceText": source, "imageUrls": [IMAGE_URL]}
    result = normalize_pdp_product(
        {
            "name": "Arbitrary Formula",
            "sourceExtraction": {
                "ocr": {
                    "semanticFacts": {
                        "ingredients": [source],
                        "benefits": [source],
                        "ingredientBenefitLinks": [relation],
                    }
                }
            },
        }
    )

    product = result["product"]
    facts = product["semanticFacts"]
    assert facts["ingredients"] == [ingredient]
    # An ingredient-specific outcome remains on the relation. It is not a
    # finished-product benefit unless a separate source assertion says so.
    assert facts["benefits"] == []
    assert facts["ingredientBenefitLinks"] == [relation]
    assert product["ingredients"] == [ingredient]
    assert product["benefits"] == []


def test_normalizer_does_not_promote_a_link_only_effect_to_a_finished_product_effect() -> None:
    relation = {
        "ingredient": "Panthenol",
        "effect": "strands smooth",
        "sourceText": "Panthenol keeps strands smooth.",
    }
    product = normalize_pdp_product(
        {
            "name": "Arbitrary Formula",
            "sourceExtraction": {"ocr": {"semanticFacts": {"ingredientBenefitLinks": [relation]}}},
        }
    )["product"]

    assert product["semanticFacts"]["ingredients"] == ["Panthenol"]
    assert product["semanticFacts"]["effects"] == []
    assert product["semanticFacts"]["ingredientBenefitLinks"] == [relation]
    assert product["ingredients"] == ["Panthenol"]
    assert product["effects"] == []


def test_normalizer_drops_an_unstated_outcome_from_an_otherwise_valid_relation() -> None:
    relation = {
        "ingredient": "Ceramide",
        "benefit": "hydration",
        "effect": "dark circles",
        "sourceText": "Ceramide supports hydration.",
    }
    result = normalize_pdp_product(
        {
            "name": "Ceramide Formula",
            "sourceExtraction": {"ocr": {"semanticFacts": {"ingredientBenefitLinks": [relation]}}},
        }
    )

    link = result["product"]["semanticFacts"]["ingredientBenefitLinks"]
    assert link == [{"ingredient": "Ceramide", "benefit": "hydration", "sourceText": relation["sourceText"]}]
    assert any(
        item["field"] == "product.semanticFacts.ingredientBenefitLinks"
        and "dark circles" in item["value"].casefold()
        for item in result["evidence"]
    )


def test_normalizer_keeps_distinct_explicit_relations_from_one_ocr_source() -> None:
    source = "Betaine contributes to hair softness. Panthenol keeps strands smooth."
    links: list[_IngredientBenefitLink] = [
        {"ingredient": "Betaine", "benefit": "hair softness", "sourceText": source},
        {"ingredient": "Panthenol", "effect": "strands smooth", "sourceText": source},
    ]
    product = normalize_pdp_product(
        {
            "name": "Arbitrary Formula",
            "sourceExtraction": {"ocr": {"semanticFacts": {"ingredientBenefitLinks": links}}},
        }
    )["product"]

    assert product["semanticFacts"]["ingredientBenefitLinks"] == links
    assert product["ingredients"] == ["Betaine", "Panthenol"]


def test_normalizer_preserves_a_korean_ocr_relation_without_misreading_a_deficiency_as_negative() -> None:
    relation = {
        "ingredient": "Panthenol",
        "benefit": "수분 부족",
        "sourceText": "Panthenol은 수분 부족을 개선하는 데 도움을 줍니다.",
    }
    product = normalize_pdp_product(
        {
            "name": "예시 포뮬러",
            "sourceExtraction": {"ocr": {"semanticFacts": {"ingredientBenefitLinks": [relation]}}},
        }
    )["product"]

    assert product["semanticFacts"]["ingredientBenefitLinks"] == [relation]
    assert product["ingredients"] == ["Panthenol"]
    assert product["benefits"] == []


@pytest.mark.parametrize(
    ("ingredient", "benefit", "source"),
    [
        ("Ocean Wash", "visible radiance", "Ocean Wash delivers visible radiance."),
        ("This shampoo", "visible radiance", "This shampoo delivers visible radiance."),
        ("The serum", "calm redness", "The serum helps calm redness."),
        ("Ceramide cream", "dry skin", "Ceramide cream supports dry skin."),
    ],
)
def test_normalizer_rejects_finished_product_subjects_as_ocr_ingredients(
    ingredient: str, benefit: str, source: str
) -> None:
    """A product-benefit clause is not evidence that the product name is an ingredient."""

    result = normalize_pdp_product(
        {
            "name": "Ocean Wash",
            "sourceExtraction": {
                "ocr": {
                    "semanticFacts": {
                        "ingredientBenefitLinks": [
                            {"ingredient": ingredient, "benefit": benefit, "sourceText": source}
                        ]
                    }
                }
            },
        }
    )

    product = result["product"]
    assert product["semanticFacts"]["ingredientBenefitLinks"] == []
    assert product["semanticFacts"]["ingredients"] == []
    assert product["ingredients"] == []
    assert any(
        item["field"] == "product.semanticFacts.ingredientBenefitLinks"
        and item["source"] == "normalizer"
        and "rejected" in item["value"].casefold()
        and "finished product" in item["value"].casefold()
        for item in result["evidence"]
    )


@pytest.mark.parametrize(
    ("ingredient", "benefit", "source"),
    [
        ("Ceramide", "hydration", "Ceramide does not improve hydration."),
        ("Ceramide", "hydration", "Ceramide lacks hydration support."),
        ("Ceramide", "irritation", "Ceramide causes irritation."),
        ("Ceramide", "hydration", "Ceramide doesn't improve hydration."),
        ("세라마이드", "자극", "세라마이드가 자극을 유발합니다."),
    ],
)
def test_normalizer_keeps_negative_or_adverse_ocr_relations_out_of_positive_benefits(
    ingredient: str, benefit: str, source: str
) -> None:
    """A relation must be affirmative before it can supply public efficacy atoms."""

    result = normalize_pdp_product(
        {
            "name": "Ceramide Formula",
            "sourceExtraction": {
                "ocr": {
                    "semanticFacts": {
                        "ingredients": [ingredient],
                        "benefits": [benefit],
                        "ingredientBenefitLinks": [
                            {"ingredient": ingredient, "benefit": benefit, "sourceText": source}
                        ],
                    }
                }
            },
        }
    )

    product = result["product"]
    facts = product["semanticFacts"]
    assert facts["ingredients"] == [ingredient]
    assert facts["benefits"] == []
    assert facts["ingredientBenefitLinks"] == []
    assert product["benefits"] == []
    assert any(
        item["field"] == "product.semanticFacts.ingredientBenefitLinks"
        and item["source"] == "normalizer"
        and "rejected" in item["value"].casefold()
        and "negates the outcome" in item["value"].casefold()
        for item in result["evidence"]
    )


def test_normalizer_keeps_an_independently_asserted_product_benefit_after_rejecting_a_negative_relation() -> None:
    negative_source = "Ceramide does not improve hydration."
    product_source = "The formula provides hydration."
    product = normalize_pdp_product(
        {
            "name": "Ceramide Formula",
            "sourceExtraction": {
                "ocr": {
                    "semanticFacts": {
                        "ingredients": ["Ceramide"],
                        "benefits": ["hydration"],
                        "evidenceSentences": [negative_source, product_source],
                        "ingredientBenefitLinks": [
                            {"ingredient": "Ceramide", "benefit": "hydration", "sourceText": negative_source}
                        ],
                    }
                }
            },
        }
    )["product"]

    assert product["semanticFacts"]["ingredientBenefitLinks"] == []
    assert product["semanticFacts"]["benefits"] == ["hydration"]
    assert product["benefits"] == ["hydration"]


def test_normalizer_keeps_independent_ocr_roles_and_qualified_metric_without_a_relation() -> None:
    payload = _extractor_envelope()
    ocr = payload["geoProduct"]["sourceExtraction"]["ocr"]
    co_mentioned_only = "The ceramide formula is present. Hydration is discussed separately."
    direct_benefit = "Hydration and a comfortable finish are described for dry skin throughout the day after regular use."
    ocr["imageTexts"][0]["text"] = "\n".join([co_mentioned_only, direct_benefit, METRIC_SOURCE])
    ocr["textBlocks"] = [co_mentioned_only, direct_benefit, METRIC_SOURCE]
    ocr["sentenceInsights"] = [
        {
            "text": co_mentioned_only,
            "category": "ingredient",
            "keywords": ["ceramide formula"],
            "imageUrls": [IMAGE_URL],
        },
        {"text": direct_benefit, "category": "benefit", "imageUrls": [IMAGE_URL]},
        {"text": METRIC_SOURCE, "category": "metric", "imageUrls": [IMAGE_URL]},
    ]
    ocr["semanticFacts"]["benefits"] = [direct_benefit]
    ocr["semanticFacts"]["ingredientBenefitLinks"] = [
        {
            "ingredient": "ceramide formula",
            "benefit": "hydration",
            "sourceText": co_mentioned_only,
            "imageUrls": [IMAGE_URL],
        }
    ]

    result = normalize_pdp_product(payload)
    facts = result["product"]["semanticFacts"]

    assert facts["ingredients"] == ["ceramide formula"]
    assert facts["benefits"] == [direct_benefit]
    assert facts["ingredientBenefitLinks"] == []
    assert facts["metricClaims"][0]["timing"] == "after 4 weeks"
    assert facts["metricClaims"][0]["method"] == "instrumental assessment"
    assert result["product"]["sourceTextMeta"][co_mentioned_only]["imageUrls"] == [IMAGE_URL]


def test_normalizer_preserves_ordered_korean_ocr_usage_steps() -> None:
    steps = [
        "1. 세안 후 적당량을 덜어 얼굴과 목에 펴 바릅니다.",
        "2. 가볍게 눌러 흡수시킵니다.",
    ]
    payload = {
        "geoProduct": {
            "name": "에비던스 세럼",
            "sourceExtraction": {
                "ocr": {
                    "imageTexts": [{"imageUrl": IMAGE_URL, "confidence": 0.91, "text": "\n".join(steps)}],
                    "sentenceInsights": [
                        {"text": step, "category": "usage", "imageUrls": [IMAGE_URL]} for step in steps
                    ],
                    "semanticFacts": {"usageSteps": steps},
                }
            },
        }
    }

    result = normalize_pdp_product(payload)

    assert result["locale"] == "ko-KR"
    assert result["product"]["usage"] == steps
    assert result["product"]["semanticFacts"]["usageSteps"] == steps
    assert [item["text"] for item in result["ocrSentences"]] == steps
    assert result["product"]["sourceTextMeta"][steps[0]]["ocrConfidence"] == 0.91


def test_normalizer_preserves_the_complete_explicit_ocr_procedure_before_action_filtering() -> None:
    """Numbered OCR source steps remain atomic even when the first verb is uncommon."""

    steps = [
        "1. Dot cream across your entire under-eye area.",
        "2. Gently pat cream into the skin using your fingertips, moving from the inner corner of your eye towards the outer edge in a semi-circular motion.",
        "3. Gaze upwards and gently massage the under eye area with your middle three fingers to enhance blood circulation.",
    ]
    payload = {
        "geoProduct": {
            "name": "Example Eye Cream",
            "sourceExtraction": {
                "ocr": {
                    "imageTexts": [{"imageUrl": IMAGE_URL, "confidence": 0.91, "text": "\n".join(steps)}],
                    "sentenceInsights": [
                        {"text": step, "category": "usage", "imageUrls": [IMAGE_URL]} for step in steps
                    ],
                    "semanticFacts": {"usageSteps": steps},
                }
            },
        }
    }

    product = normalize_pdp_product(payload)["product"]

    assert product["usage"] == steps
    assert product["semanticFacts"]["usageSteps"] == steps
    assert product["sourceTextMeta"][steps[0]]["imageUrls"] == [IMAGE_URL]


def test_normalizer_does_not_cap_a_complete_explicit_ocr_procedure() -> None:
    """An OCR procedure keeps its source cardinality rather than the generic usage-list cap."""

    steps = [f"{position}. Apply layer {position} across the face with one pump." for position in range(1, 10)]
    payload = {
        "geoProduct": {
            "name": "Example Serum",
            "sourceExtraction": {
                "ocr": {
                    "imageTexts": [{"imageUrl": IMAGE_URL, "confidence": 0.91, "text": "\n".join(steps)}],
                    "sentenceInsights": [
                        {"text": step, "category": "usage", "imageUrls": [IMAGE_URL]} for step in steps
                    ],
                    "semanticFacts": {"usageSteps": steps},
                }
            },
        }
    }

    product = normalize_pdp_product(payload)["product"]

    assert product["usage"] == steps
    assert product["semanticFacts"]["usageSteps"] == steps


def test_normalizer_keeps_all_source_backed_ocr_formula_relations() -> None:
    """Each explicit OCR formula-to-benefit link remains available to the ledger."""

    payload = _extractor_envelope()
    ocr = payload["geoProduct"]["sourceExtraction"]["ocr"]
    links: list[_IngredientBenefitLink] = [
        {
            "ingredient": f"Ingredient {number}",
            "benefit": f"Benefit {number}",
            "sourceText": f"Ingredient {number} supports Benefit {number}.",
            "imageUrls": [IMAGE_URL],
        }
        for number in range(1, 26)
    ]
    source_texts = [link["sourceText"] for link in links]
    ocr["imageTexts"] = [{"imageUrl": IMAGE_URL, "confidence": 0.91, "text": "\n".join(source_texts)}]
    ocr["textBlocks"] = source_texts
    ocr["sentenceInsights"] = [
        {
            "text": link["sourceText"],
            "category": "ingredient",
            "keywords": [link["ingredient"]],
            "imageUrls": [IMAGE_URL],
        }
        for link in links
    ]
    ocr["semanticFacts"] = {"ingredientBenefitLinks": links}

    facts = normalize_pdp_product(payload)["product"]["semanticFacts"]

    assert facts["ingredientBenefitLinks"] == links


def test_normalizer_does_not_turn_numbered_ocr_results_into_usage_steps() -> None:
    """OCR metrics may be numbered, but they are not a customer routine."""

    metrics = [
        "1. 95% of users saw smoother-looking skin.",
        "2. 90% of users saw brighter-looking skin.",
    ]
    payload = {
        "geoProduct": {
            "name": "Example Serum",
            "sourceExtraction": {
                "ocr": {
                    "imageTexts": [{"imageUrl": IMAGE_URL, "confidence": 0.91, "text": "\n".join(metrics)}],
                    "sentenceInsights": [
                        {"text": metric, "category": "usage", "imageUrls": [IMAGE_URL]} for metric in metrics
                    ],
                    "semanticFacts": {"usageSteps": metrics},
                }
            },
        }
    }

    product = normalize_pdp_product(payload)["product"]

    assert product["usage"] == []
    assert product["semanticFacts"]["usageSteps"] == []


@pytest.mark.parametrize(
    ("sentence", "ingredient", "expected"),
    [
        (
            "500-HOUR AGED GINSENG Supports the skin barrier, helping improve visible fine lines",
            "500-Hour Aged Ginseng",
            "500-Hour Aged Ginseng supports the skin barrier, helping improve visible fine lines",
        ),
        (
            "KOREAN HERB EXTRACT Improves hydration, visibly firms, and addresses visible signs of aging",
            "Korean Herb Extract",
            "Korean Herb Extract improves hydration, visibly firms, and addresses visible signs of aging",
        ),
    ],
)
def test_a_banner_label_and_its_statement_are_told_apart(sentence: str, ingredient: str, expected: str) -> None:
    """배너가 대문자로 적은 성분명은 라벨이고, 뒤에 붙은 것은 그 성분의 서술이다.

    추출이 둘을 한 줄로 이어 붙이면 문장 한가운데에서 고함치는 문구가 된다.
    바뀌는 것은 성분명과 바로 뒤 낱말의 대소문자뿐이고, 낱말은 하나도 바뀌지 않는다.
    원장에 적힌 성분명의 표기와 배너의 표기가 달라도 배너 쪽 표기로 판단한다.
    """

    assert _naturalize_ocr_formula_sentence(sentence, ingredient) == expected


def test_a_sentence_written_entirely_in_capitals_keeps_its_acronym_ingredient() -> None:
    """대문자 일색인 문장은 문장 전체를 낮추고 성분명 표기는 원문대로 되살린다."""

    assert (
        _naturalize_ocr_formula_sentence("PDRN SUPPORTS SKIN RECOVERY AFTER USE", "PDRN")
        == "PDRN supports skin recovery after use"
    )

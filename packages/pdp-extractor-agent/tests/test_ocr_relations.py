"""OCR candidate/relation reconciliation contracts (14 legacy counterparts)."""

from __future__ import annotations

import pytest

from pdp_extractor_agent.ocr.pipeline import combine_ocr_candidates, relation_backed_lines
from pdp_extractor_agent.service import extract_product_from_html


@pytest.mark.parametrize(
    ("text", "groups", "expected"),
    [
        ("Benefit\\nBarrier support", [{"id": "g", "lines": [{"text": "Benefit", "role": "title"}]}], ["Benefit"]),
        (
            "Apply after toner",
            [{"id": "g", "lines": [{"text": "Apply after toner", "role": "body"}]}],
            ["Apply after toner"],
        ),
        ("+84.3%", [{"id": "g", "lines": [{"text": "+84.3%", "role": "value"}]}], ["+84.3%"]),
        (
            "Footnote test result",
            [{"id": "g", "lines": [{"text": "Footnote test result", "role": "footnote"}]}],
            ["Footnote test result"],
        ),
        ("A\nB", [{"id": "g", "lines": [{"text": "A B", "role": "body"}]}], ["A B"]),
        (
            "Skin barrier defense",
            [{"id": "g", "lines": [{"text": "Skin barrier defense", "role": "body"}]}],
            ["Skin barrier defense"],
        ),
    ],
)
def test_retains_only_relation_lines_backed_by_transcription(
    text: str, groups: list[dict[str, object]], expected: list[str]
) -> None:
    assert relation_backed_lines(text, groups) == expected


@pytest.mark.parametrize(
    ("first", "second", "expected"),
    [
        ("same", "same", "same"),
        ("stronger", "weaker", "stronger"),
        ("one", "two", "one"),
        ("alpha", "alpha", "alpha"),
        ("한국어", "한국어", "한국어"),
        ("small text", "small text", "small text"),
        ("first source", "second source", "first source"),
        ("high confidence", "low confidence", "high confidence"),
    ],
)
def test_keeps_the_first_record_order_for_distinct_images(first: str, second: str, expected: str) -> None:
    combined = combine_ocr_candidates(
        [
            {"imageUrl": "https://img/one.png", "text": first, "confidence": 0.8},
            {"imageUrl": "https://img/two.png", "text": second, "confidence": 0.7},
        ]
    )
    assert combined[0]["text"] == expected


@pytest.mark.asyncio
async def test_local_ocr_keeps_packaging_formula_context_as_evidence_not_an_ingredient_or_usage() -> None:
    formula = "The airless pump protects the ceramide formula."
    instruction = "Dispense two pumps, smooth over face and neck, then press to absorb."

    run = await extract_product_from_html(
        f'<main><h1>Evidence Serum</h1><img src="https://images.example.test/formula.png" '
        f'data-ocr-text="{formula}\n{instruction}" /></main>',
        "https://example.test/products/evidence-serum",
        {"provider": "mock"},
    )

    product = run.result["geoProduct"]
    facts = product["sourceExtraction"]["ocr"]["semanticFacts"]
    assert formula not in facts["usageSteps"]
    assert formula not in facts["ingredients"]
    assert formula not in facts["benefits"]
    assert formula not in facts["effects"]
    assert facts["usageSteps"] == [instruction]
    assert formula in facts["evidenceSentences"]
    assert all(insight["text"] != formula for insight in product["sourceExtraction"]["ocr"]["sentenceInsights"])

    # The public top-level projection is the generator's input contract too.
    assert formula not in product["ingredients"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("source", "ingredient", "outcome"),
    (
        ("Betaine contributes to hair softness.", "Betaine", "hair softness"),
        ("Sea silk detangles wet hair.", "Sea silk", "wet hair"),
        ("Vitamin C delivers visible radiance.", "Vitamin C", "visible radiance"),
        ("Panthenol keeps strands smooth.", "Panthenol", "strands smooth"),
    ),
)
async def test_local_ocr_preserves_generic_ingredient_outcome_predicates(
    source: str, ingredient: str, outcome: str
) -> None:
    """Retain arbitrary source predicates without treating the whole sentence as an ingredient."""

    run = await extract_product_from_html(
        f'<main><h1>Relation Shampoo</h1><img src="https://images.example.test/relation.png" '
        f'data-ocr-text="{source}" /></main>',
        "https://example.test/products/relation-shampoo",
        {"provider": "mock"},
    )

    product = run.result["geoProduct"]
    facts = product["sourceExtraction"]["ocr"]["semanticFacts"]
    assert ingredient in facts["ingredients"]
    assert source not in facts["ingredients"]
    assert source not in facts["effects"]
    assert source not in facts["usageSteps"]
    assert source in facts["evidenceSentences"]
    assert any(
        link.get("ingredient") == ingredient
        and link.get("benefit") == outcome
        and link.get("sentence") == source
        and link.get("sourceText") == source
        for link in facts["ingredientBenefitLinks"]
    )
    assert source not in product["ingredients"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("source", "product_name"),
    (
        ("This shampoo delivers visible radiance.", "Relation Shampoo"),
        ("Ocean Wash delivers visible radiance.", "Relation Shampoo"),
        ("The serum helps calm redness.", "Relation Shampoo"),
        ("Ceramide cream supports dry skin.", "Relation Shampoo"),
        ("Relation Shampoo delivers visible radiance.", "Relation Shampoo"),
        ("Radiance Booster delivers visible radiance.", "Radiance Booster"),
    ),
)
async def test_local_ocr_does_not_promote_a_product_subject_to_an_ingredient_relation(
    source: str, product_name: str
) -> None:
    """A product claim may be evidence, but its grammatical subject is not an ingredient."""

    run = await extract_product_from_html(
        f'<main><h1>{product_name}</h1><img src="https://images.example.test/product-claim.png" '
        f'data-ocr-text="{source}" /></main>',
        "https://example.test/products/relation-shampoo",
        {"provider": "mock"},
    )

    product = run.result["geoProduct"]
    facts = product["sourceExtraction"]["ocr"]["semanticFacts"]
    assert source not in facts["ingredients"]
    assert source not in product["ingredients"]
    assert source in facts["evidenceSentences"]
    assert not any(link.get("sourceText") == source or link.get("sentence") == source for link in facts["ingredientBenefitLinks"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "source",
    (
        "Aero Comb boosts shine.",
        "Aero Comb repels dust from the screen.",
        "Aero Comb adds lightweight volume.",
        "Aero Comb nourishes dry strands.",
        "Repels dust from the screen.",
        "Adds lightweight volume.",
        "Nourishes dry strands.",
    ),
)
async def test_mock_ocr_keeps_generic_declarative_product_benefits(source: str) -> None:
    """A source-backed product clause is a benefit without inventing an ingredient relation."""

    run = await extract_product_from_html(
        f'<main><h1>Aero Comb</h1><img src="https://images.example.test/aero-comb.png" '
        f'data-ocr-text="{source}" /></main>',
        "https://example.test/products/aero-comb",
        {"provider": "mock"},
    )

    product = run.result["geoProduct"]
    ocr = product["sourceExtraction"]["ocr"]
    facts = ocr["semanticFacts"]
    assert source in ocr["textBlocks"]
    assert source in facts["benefits"]
    assert source not in facts["effects"]
    assert source in facts["evidenceSentences"]
    assert any(insight["text"] == source and insight["category"] == "benefit" for insight in ocr["sentenceInsights"])
    assert source in product["benefits"]
    assert source not in facts["ingredients"]
    assert not any(link.get("sourceText") == source or link.get("sentence") == source for link in facts["ingredientBenefitLinks"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "source",
    (
        "Aero Comb adds free shipping.",
        "Customers say Aero Comb boosts hydration.",
        "Apply Aero Comb to boost shine.",
        "Aero Comb is dermatologist-tested.",
        "Aero Comb causes irritation.",
        "Aero Comb helps determine whether the product is right for you.",
    ),
)
async def test_mock_ocr_does_not_turn_commerce_review_safety_or_usage_copy_into_a_benefit(source: str) -> None:
    """The generic clause path keeps existing non-efficacy guards intact."""

    run = await extract_product_from_html(
        f'<main><h1>Aero Comb</h1><img src="https://images.example.test/aero-comb-guard.png" '
        f'data-ocr-text="{source}" /></main>',
        "https://example.test/products/aero-comb",
        {"provider": "mock"},
    )

    product = run.result["geoProduct"]
    facts = product["sourceExtraction"]["ocr"]["semanticFacts"]
    assert source not in facts["benefits"]
    assert source not in facts["effects"]
    assert source not in product["benefits"]


@pytest.mark.asyncio
async def test_local_ocr_keeps_korean_explicit_ingredient_benefit_link_with_its_declared_role() -> None:
    """A source predicate keeps its relation even when the sentence is an ingredient fact."""

    source = "프로바이오틱스 유래 성분이 피부 장벽 강화에 도움을 줍니다."
    run = await extract_product_from_html(
        f'<main><h1>Barrier Essence</h1><img src="https://images.example.test/korean-formula.png" '
        f'data-ocr-text="{source}" /></main>',
        "https://example.test/products/barrier-essence",
    )

    ocr = run.result["geoProduct"]["sourceExtraction"]["ocr"]
    facts = ocr["semanticFacts"]
    assert facts["ingredients"] == ["프로바이오틱스 유래 성분"]
    assert any(
        link.get("ingredient") == "프로바이오틱스 유래 성분"
        and link.get("benefit") == "피부 장벽 강화"
        and link.get("sentence") == source
        and link.get("sourceText") == source
        for link in facts["ingredientBenefitLinks"]
    )
    assert any(insight["text"] == source and insight["category"] == "ingredient" for insight in ocr["sentenceInsights"])

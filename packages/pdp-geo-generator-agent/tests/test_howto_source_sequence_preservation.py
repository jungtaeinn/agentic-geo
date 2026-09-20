"""End-to-end regressions for source-owned HowTo sequences."""

from __future__ import annotations

from typing import Any, cast

import pytest
from pdp_extractor_agent.service import extract_product_from_html

from pdp_geo_generator_agent.content_planning import create_conservative_content_plan, create_pdp_geo_evidence_ledger
from pdp_geo_generator_agent.generation import generate_pdp_geo_artifacts
from pdp_geo_generator_agent.normalization import normalize_pdp_product


def _how_to(artifact: dict[str, Any]) -> dict[str, Any] | None:
    return next(
        (
            node
            for node in cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])
            if node.get("@type") == "HowTo"
        ),
        None,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("source_steps", "expected"),
    [
        (
            [
                "Step 1: Circle the balm along the cheekbones.",
            ],
            ["Circle the balm along the cheekbones."],
        ),
        (
            [
                "Step 1: Circle the balm along the cheekbones.",
                "Step 2: Cradle the face until the finish settles.",
            ],
            [
                "Circle the balm along the cheekbones.",
                "Cradle the face until the finish settles.",
            ],
        ),
        (
            [
                "Step 1: Glide the balm outward from the center.",
                "Step 2: Cup the face with both hands.",
                "Step 3: Pause until the finish settles.",
            ],
            [
                "Glide the balm outward from the center.",
                "Cup the face with both hands.",
                "Pause until the finish settles.",
            ],
        ),
        (
            [
                f"Step {number}: Circle layer {number} along the cheekbones."
                for number in range(1, 22)
            ],
            [
                f"Circle layer {number} along the cheekbones."
                for number in range(1, 22)
            ],
        ),
    ],
    ids=("one-step", "two-step", "three-step", "long-ritual"),
)
async def test_source_ordinals_survive_extraction_planning_and_both_howto_surfaces(
    source_steps: list[str], expected: list[str]
) -> None:
    markup = "".join(f"<p>{step}</p>" for step in source_steps)
    extracted = await extract_product_from_html(
        f"<main><h1>Fixture Balm</h1><section><h2>RITUAL</h2>{markup}</section></main>",
        "https://fixture.test/products/howto-sequence",
        {"provider": "mock"},
    )
    product = extracted.result["geoProduct"]
    plan = create_conservative_content_plan(
        {
            "product": product,
            "locale": "en-US",
            "evidenceLedger": create_pdp_geo_evidence_ledger(product, "en-US"),
        }
    )
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    how_to = _how_to(artifact)

    assert [step["text"] for step in plan["howTo"]["steps"]] == expected
    assert [step["position"] for step in plan["howTo"]["steps"]] == list(range(1, len(expected) + 1))
    assert how_to is not None
    assert [step["text"] for step in how_to["step"]] == expected
    assert artifact["content"]["sections"]["howToUse"].splitlines() == expected


@pytest.mark.asyncio
async def test_source_owned_ritual_cards_keep_a_repeated_token_step_in_the_complete_howto() -> None:
    expected = [
        "Warm three pumps of serum between fingers and apply to your face and neck with upward motions.",
        "Gently cup your face with your palms to help the serum absorb into your skin.",
    ]
    extracted = await extract_product_from_html(
        """
        <main><h1>Fixture Serum</h1>
          <div class="content-cards">
            <div class="content-cards__header"><h2>RITUAL</h2><p>A two-step daily ritual.</p></div>
            <div class="content-cards__card" aria-label="Step 1">
              <p>Warm three pumps of serum between fingers and apply to your face and neck with upward motions.</p>
            </div>
            <div class="content-cards__card" aria-label="Step 2">
              <p>Gently cup your face with your palms to help the serum absorb into your skin.</p>
            </div>
          </div>
          <section><h2>Frequently Asked Questions</h2>
            <p>How should I use this serum?</p><p>Use morning and night, after applying toner.</p>
          </section>
          <img src="https://cdn.fixture.test/ritual.png" data-ocr-text="Use morning and night after toner." />
        </main>
        """,
        "https://fixture.test/products/source-owned-ritual-cards",
        {"provider": "mock"},
    )
    extracted_product = extracted.result["geoProduct"]
    product = normalize_pdp_product(extracted_product)["product"]
    plan = create_conservative_content_plan(
        {
            "product": product,
            "locale": "en-US",
            "evidenceLedger": create_pdp_geo_evidence_ledger(product, "en-US"),
        }
    )
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    how_to = _how_to(artifact)

    assert extracted_product["usage"] == [f"{position}. {step}" for position, step in enumerate(expected, start=1)]
    assert extracted_product["semanticFacts"]["usageSteps"] == [
        f"{position}. {step}" for position, step in enumerate(expected, start=1)
    ]
    assert [step["text"] for step in plan["howTo"]["steps"]] == expected
    assert [step["position"] for step in plan["howTo"]["steps"]] == [1, 2]
    assert product["usage"] == [f"{position}. {step}" for position, step in enumerate(expected, start=1)]
    assert product["semanticFacts"]["usageSteps"] == [
        f"{position}. {step}" for position, step in enumerate(expected, start=1)
    ]
    assert how_to is not None
    assert [step["text"] for step in how_to["step"]] == expected
    assert artifact["content"]["sections"]["howToUse"].splitlines() == expected


@pytest.mark.asyncio
async def test_separate_ritual_sections_do_not_cap_a_twenty_five_step_source_procedure() -> None:
    expected = [f"Circle layer {number} along the cheekbones." for number in range(1, 26)]
    markup = "".join(
        f"<section><h2>RITUAL</h2><p>Step {number}: {step}</p></section>"
        for number, step in enumerate(expected, start=1)
    )
    extracted = await extract_product_from_html(
        f"<main><h1>Fixture Balm</h1>{markup}</main>",
        "https://fixture.test/products/separate-ritual-sections",
        {"provider": "mock"},
    )
    product = extracted.result["geoProduct"]
    plan = create_conservative_content_plan(
        {
            "product": product,
            "locale": "en-US",
            "evidenceLedger": create_pdp_geo_evidence_ledger(product, "en-US"),
        }
    )
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    how_to = _how_to(artifact)

    assert product["usage"] == [f"{number}. {step}" for number, step in enumerate(expected, start=1)]
    assert product["semanticFacts"]["usageSteps"] == [
        f"{number}. {step}" for number, step in enumerate(expected, start=1)
    ]
    assert [step["position"] for step in plan["howTo"]["steps"]] == list(range(1, 26))
    assert how_to is not None
    assert [step["position"] for step in how_to["step"]] == list(range(1, 26))
    assert [step["text"] for step in how_to["step"]] == expected


@pytest.mark.asyncio
async def test_source_step_text_keeps_all_sentences_after_the_display_label_is_removed() -> None:
    expected = [
        "Circle the balm along the cheekbones. Keep both hands warm.",
        "Cradle the face until the finish settles. Release slowly.",
    ]
    extracted = await extract_product_from_html(
        """
        <main><h1>Fixture Balm</h1><section><h2>RITUAL</h2>
          <p>Step 1: Circle the balm along the cheekbones. Keep both hands warm.</p>
          <p>Step 2: Cradle the face until the finish settles. Release slowly.</p>
        </section></main>
        """,
        "https://fixture.test/products/multisentence-ritual",
        {"provider": "mock"},
    )
    product = extracted.result["geoProduct"]
    plan = create_conservative_content_plan(
        {
            "product": product,
            "locale": "en-US",
            "evidenceLedger": create_pdp_geo_evidence_ledger(product, "en-US"),
        }
    )
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    how_to = _how_to(artifact)

    assert product["usage"] == [f"{index + 1}. {step}" for index, step in enumerate(expected)]
    assert [step["text"] for step in plan["howTo"]["steps"]] == expected
    assert how_to is not None
    assert [step["text"] for step in how_to["step"]] == expected
    assert artifact["content"]["sections"]["howToUse"].splitlines() == expected


@pytest.mark.asyncio
async def test_orphan_step_two_is_not_renumbered_into_a_one_step_howto() -> None:
    extracted = await extract_product_from_html(
        """
        <main><h1>Fixture Balm</h1><section><h2>RITUAL</h2>
          <p>Step 2: Apply one drop to the face.</p>
        </section></main>
        """,
        "https://fixture.test/products/orphan-step",
        {"provider": "mock"},
    )
    product = extracted.result["geoProduct"]
    plan = create_conservative_content_plan(
        {
            "product": product,
            "locale": "en-US",
            "evidenceLedger": create_pdp_geo_evidence_ledger(product, "en-US"),
        }
    )
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})

    assert plan["howTo"]["eligible"] is False
    assert plan["howTo"]["steps"] == []
    assert _how_to(artifact) is None

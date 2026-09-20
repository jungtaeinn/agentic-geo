"""Source-structure regressions for explicit customer usage procedures."""

from __future__ import annotations

import pytest

from pdp_extractor_agent.ocr.pipeline import extract_numbered_usage_steps
from pdp_extractor_agent.service import extract_product_from_api_payload, extract_product_from_html

_THREE_STEP_RITUAL = [
    "1. Glide the balm outward from the center.",
    "2. Cup the face with both hands.",
    "3. Pause until the finish settles.",
]
_TWO_STEP_RITUAL = [
    "1. Circle the balm along the cheekbones.",
    "2. Cradle the face until the finish settles.",
]


def test_later_explicit_ritual_heading_wins_over_a_compressed_how_to_heading() -> None:
    source = "\n".join(
        [
            "HOW TO USE",
            "Use once after cleansing.",
            "RESTORATIVE RITUAL",
            "Step 1: Glide the balm outward from the center.",
            "Step 2: Cup the face with both hands.",
            "Step 3: Pause until the finish settles.",
        ]
    )

    assert extract_numbered_usage_steps(source) == _THREE_STEP_RITUAL


def test_title_case_ritual_heading_is_a_semantic_usage_heading() -> None:
    source = "\n".join(
        [
            "How to use",
            "Use once after cleansing.",
            "Renewal Ritual",
            "Step 1: Circle the balm along the cheekbones.",
            "Step 2: Cradle the face until the finish settles.",
        ]
    )

    assert extract_numbered_usage_steps(source) == _TWO_STEP_RITUAL


def test_routed_routine_heading_with_modifier_and_hyphenated_count_is_not_product_usage() -> None:
    source = "\n".join(
        [
            "YOUR COMPLETE 4-STEP ROUTINE",
            "Step 1: Cleanse with the starter gel.",
            "Step 2: Layer the prep lotion.",
            "Step 3: Follow with the booster serum.",
            "Step 4: Finish with the companion cream.",
        ]
    )

    assert extract_numbered_usage_steps(source) == []


@pytest.mark.parametrize(
    "heading",
    (
        "BUILD YOUR RITUAL",
        "COMPLETE YOUR RITUAL",
        "YOUR RITUAL",
        "RITUAL",
        "THE RITUAL",
        "DISCOVER OUR RITUAL",
    ),
)
@pytest.mark.asyncio
async def test_commerce_ritual_heading_is_rejected_while_a_true_ritual_on_the_same_source_survives(heading: str) -> None:
    source = "\n".join(
        [
            heading,
            "Step 1: Shop the companion item.",
            "Step 2: Add the matching item to your bag.",
            "Step 3: Finish with the matching companion.",
            "RITUAL",
            "Step 1: Circle the balm along the cheekbones.",
            "Step 2: Cradle the face until the finish settles.",
        ]
    )
    run = await extract_product_from_html(
        f'<main><h1>Fixture Balm</h1><img src="https://cdn.fixture.test/ritual.png" data-ocr-text="{source}" /></main>',
        "https://fixture.test/products/ocr-cross-sell-ritual",
        {"provider": "mock"},
    )
    product = run.result["geoProduct"]
    decisions = run.diagnostics["ocr"]["usageSequences"]

    assert product["usage"] == _TWO_STEP_RITUAL
    assert product["semanticFacts"]["usageSteps"] == _TWO_STEP_RITUAL
    assert decisions["acceptedCount"] == 1
    assert decisions["accepted"][0]["heading"] == "RITUAL"
    assert any(
        item["heading"] == heading
        and item["reason"] == "commerce-cross-sell-sequence"
        and item["ordinals"] == [1, 2, 3]
        for item in decisions["rejected"]
    )


@pytest.mark.parametrize(
    "steps",
    (
        ("Select the matching shade.", "Blend it evenly."),
        ("Open the companion app.", "Tap Pair to continue."),
        ("Use the matching attachment.", "Glide it along the surface."),
        ("Add another layer across the cheekbones.", "Press until it settles."),
    ),
    ids=("matching-shade", "companion-app", "matching-attachment", "another-layer"),
)
def test_relational_words_do_not_turn_an_explicit_ritual_into_cross_sell(steps: tuple[str, str]) -> None:
    source = "\n".join(
        [
            "RITUAL",
            *(f"Step {position}: {step}" for position, step in enumerate(steps, start=1)),
        ]
    )

    assert extract_numbered_usage_steps(source) == [
        f"{position}. {step}" for position, step in enumerate(steps, start=1)
    ]


def test_visual_ordinal_rows_do_not_cap_a_valid_long_ritual() -> None:
    source = "\n".join(
        [
            "RITUAL",
            *(
                part
                for number in range(1, 22)
                for part in (str(number), f"Circle layer {number} along the cheekbones.")
            ),
        ]
    )

    assert extract_numbered_usage_steps(source) == [
        f"{number}. Circle layer {number} along the cheekbones." for number in range(1, 22)
    ]


@pytest.mark.asyncio
async def test_extraction_keeps_the_explicit_product_ritual_and_rejects_a_routed_four_step_routine() -> None:
    run = await extract_product_from_html(
        """
        <main>
          <h1>Fixture Balm</h1>
          <section>
            <h2>How to use</h2>
            <p>Use once after cleansing.</p>
          </section>
          <section>
            <h2>RESTORATIVE RITUAL</h2>
            <p>Step 1: Glide the balm outward from the center.</p>
            <p>Step 2: Cup the face with both hands.</p>
            <p>Step 3: Pause until the finish settles.</p>
          </section>
          <section data-section="cross-sell">
            <h2>YOUR 4 STEP ROUTINE</h2>
            <p>Step 1: Cleanse with the starter gel.</p>
            <p>Step 2: Layer the prep lotion.</p>
            <p>Step 3: Follow with the booster serum.</p>
            <p>Step 4: Finish with the companion cream.</p>
          </section>
        </main>
        """,
        "https://fixture.test/products/balm",
        {"provider": "mock"},
    )
    product = run.result["geoProduct"]

    assert product["usage"] == _THREE_STEP_RITUAL
    assert product["semanticFacts"]["usageSteps"] == _THREE_STEP_RITUAL
    decisions = run.diagnostics["ocr"]["usageSequences"]
    assert decisions["acceptedCount"] == 1
    assert decisions["accepted"][0]["heading"] == "RESTORATIVE RITUAL"
    assert decisions["accepted"][0]["ordinals"] == [1, 2, 3]


@pytest.mark.asyncio
async def test_api_usage_field_keeps_a_complete_sequence_when_ocr_repeats_it_without_a_heading() -> None:
    run = await extract_product_from_api_payload(
        {
            "name": "Fixture Balm",
            "usage": [
                "Step 1: Circle the balm along the cheekbones.",
                "Step 2: Cradle the face until the finish settles.",
            ],
        },
        "https://fixture.test/products/api-usage",
        {"provider": "mock"},
    )
    product = run.result["geoProduct"]

    assert product["usage"] == _TWO_STEP_RITUAL
    assert product["semanticFacts"]["usageSteps"] == _TWO_STEP_RITUAL
    decisions = run.diagnostics["ocr"]["usageSequences"]
    assert decisions["acceptedCount"] == 1
    assert decisions["accepted"][0]["heading"] == "How to use"
    assert decisions["accepted"][0]["ordinals"] == [1, 2]


@pytest.mark.asyncio
async def test_routed_aria_controls_routine_cannot_reenter_html_sections_as_usage() -> None:
    run = await extract_product_from_html(
        """
        <main><h1>Fixture Balm</h1>
          <section data-section="cross-sell">
            <button aria-controls="routine-steps">Build Your Routine</button>
            <div id="routine-steps">
              Step 1: Cleanse with the starter gel.
              Step 2: Layer the prep lotion.
              Step 3: Follow with the booster serum.
              Step 4: Finish with the companion cream.
            </div>
          </section>
        </main>
        """,
        "https://fixture.test/products/aria-controls-routine",
        {"provider": "mock"},
    )
    product = run.result["geoProduct"]

    assert product["usage"] == []
    assert product["semanticFacts"]["usageSteps"] == []
    assert product["sourceExtraction"]["html"]["sections"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("markup", "expected"),
    [
        (
            """
            <section><h2>RITUAL</h2>
              <p>Step 1: Circle the balm along the cheekbones.</p>
            </section>
            """,
            ["1. Circle the balm along the cheekbones."],
        ),
        (
            """
            <section><h2>RITUAL</h2>
              <p>Step 1: Circle the balm along the cheekbones.</p>
              <p>Step 2: Cradle the face until the finish settles.</p>
            </section>
            """,
            _TWO_STEP_RITUAL,
        ),
        (
            """
            <section><h2>RITUAL</h2>
              <p>Step 2: Apply one drop to the face.</p>
            </section>
            """,
            [],
        ),
    ],
    ids=("single-step-one", "two-step-ritual", "orphan-step-two"),
)
async def test_extraction_preserves_complete_ordinal_starts_without_a_verb_allowlist(
    markup: str, expected: list[str]
) -> None:
    run = await extract_product_from_html(
        f"<main><h1>Fixture Balm</h1>{markup}</main>",
        "https://fixture.test/products/ordinal-start",
        {"provider": "mock"},
    )
    product = run.result["geoProduct"]

    assert product["usage"] == expected
    assert product["semanticFacts"]["usageSteps"] == expected
    decisions = run.diagnostics["ocr"]["usageSequences"]
    if expected:
        assert decisions["acceptedCount"] == 1
    else:
        assert decisions["acceptedCount"] == 0
        assert any(item["reason"] == "orphan-ordinal-start" for item in decisions["rejected"])


@pytest.mark.asyncio
async def test_extraction_rejects_a_non_contiguous_numbered_ritual_without_renumbering_it() -> None:
    run = await extract_product_from_html(
        """
        <main><h1>Fixture Balm</h1><section><h2>RITUAL</h2>
          <p>Step 1: Circle the balm along the cheekbones.</p>
          <p>Step 3: Cradle the face until the finish settles.</p>
        </section></main>
        """,
        "https://fixture.test/products/non-contiguous-ritual",
        {"provider": "mock"},
    )
    product = run.result["geoProduct"]

    assert product["usage"] == []
    assert product["semanticFacts"]["usageSteps"] == []
    decisions = run.diagnostics["ocr"]["usageSequences"]
    assert decisions["acceptedCount"] == 0
    assert any(item["reason"] == "non-contiguous-ordinals" for item in decisions["rejected"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "step_markup",
    [
        """
        <p>Step 1: Apply the label to the carton.</p>
        <p>Step 2: Recycle the carton after use.</p>
        """,
        """
        <p>Step 1: 92% of participants saw smoother-looking skin.</p>
        <p>Step 2: 86% of participants reported a softer feel.</p>
        """,
    ],
    ids=("packaging", "measurement"),
)
async def test_extraction_does_not_promote_numbered_non_product_rows_to_usage(step_markup: str) -> None:
    run = await extract_product_from_html(
        f"<main><h1>Fixture Balm</h1><section><h2>RITUAL</h2>{step_markup}</section></main>",
        "https://fixture.test/products/non-product-rows",
        {"provider": "mock"},
    )
    product = run.result["geoProduct"]

    assert product["usage"] == []
    assert product["semanticFacts"]["usageSteps"] == []


@pytest.mark.asyncio
async def test_dom_aria_step_cards_remain_the_canonical_procedure_over_faq_and_ocr_usage() -> None:
    run = await extract_product_from_html(
        """
        <main>
          <h1>Fixture Cream</h1>
          <div class="content-cards">
            <div class="content-cards__header"><h2>RITUAL</h2></div>
            <div class="content-cards__body">
              <article aria-label="Step 1"><p>Warm a pearl-sized amount between your palms.</p></article>
              <article aria-label="Step 2"><p>Press it gently over the face and neck.</p></article>
            </div>
          </div>
          <details>
            <summary>How much should I use?</summary>
            <p>Use a pea-sized amount whenever skin feels dry.</p>
          </details>
          <img
            src="https://cdn.fixture.test/detail-usage.png"
            data-ocr-text="How to use&#10;Step 1: Glide the serum outward from the center.&#10;Step 2: Pat until absorbed.&#10;Step 3: Finish with sunscreen."
          />
        </main>
        """,
        "https://fixture.test/products/cream",
        {"provider": "mock"},
    )
    product = run.result["geoProduct"]
    expected = [
        "1. Warm a pearl-sized amount between your palms.",
        "2. Press it gently over the face and neck.",
    ]

    assert product["usage"] == expected
    assert product["semanticFacts"]["usageSteps"] == expected


@pytest.mark.asyncio
async def test_nested_usage_card_header_owns_its_source_order_over_faq_and_ocr_distractors() -> None:
    """A semantic card header is product content even when its class contains ``header``.

    The regression catches both halves of the source-ownership contract: the
    cleanup pass must retain the card header, and the declared card procedure
    must beat unrelated action-like FAQ/OCR wording without merging either
    source into the public HowTo sequence.
    """

    run = await extract_product_from_html(
        """
        <main>
          <h1>Fixture Renewal Cream</h1>
          <section class="pdp-card-grid">
            <div class="pdp-card-grid__header"><span>RITUAL</span></div>
            <div class="pdp-card-grid__content">
              <article aria-label="Step 1"><p>Warm a pearl-sized amount between your fingertips.</p></article>
              <article aria-label="Step 2"><p>Press the cream over the face and neck.</p></article>
            </div>
          </section>
          <details>
            <summary>How should I layer the full routine?</summary>
            <p>Step 1: Apply the companion essence. Step 2: Follow with the matching eye cream.</p>
          </details>
          <img
            src="https://cdn.fixture.test/ocr-distractor.png"
            data-ocr-text="RITUAL&#10;Step 1: Sweep the serum across the cheeks.&#10;Step 2: Pat until absorbed.&#10;Step 3: Finish with sunscreen."
          />
        </main>
        """,
        "https://fixture.test/products/renewal-cream",
        {"provider": "mock"},
    )
    product = run.result["geoProduct"]

    assert product["usage"] == [
        "1. Warm a pearl-sized amount between your fingertips.",
        "2. Press the cream over the face and neck.",
    ]
    assert product["semanticFacts"]["usageSteps"] == product["usage"]
    assert "Sweep the serum" not in " ".join(product["usage"])
    assert "companion essence" not in " ".join(product["usage"])
    assert any(
        section["text"].startswith("RITUAL Warm a pearl-sized amount")
        for section in product["sourceExtraction"]["html"]["sections"]
    )
    assert any(
        "Sweep the serum across the cheeks." in item["text"]
        for item in product["sourceExtraction"]["ocr"]["imageTexts"]
    )


@pytest.mark.asyncio
async def test_semantic_directions_card_header_keeps_declared_order_over_faq_and_ocr_distractors() -> None:
    """A non-RITUAL semantic usage heading uses the same structural path."""

    run = await extract_product_from_html(
        """
        <main>
          <h1>Fixture Hydrating Lotion</h1>
          <section class="application-card-stack">
            <div class="application-card-stack__header"><span>Directions</span></div>
            <div class="application-card-stack__content">
              <article aria-label="Step 1"><p>Dispense the lotion into clean palms.</p></article>
              <article aria-label="Step 2"><p>Smooth it evenly across the face.</p></article>
            </div>
          </section>
          <details>
            <summary>How should I build a wider routine?</summary>
            <p>Step 1: Apply the companion toner. Step 2: Layer the matching serum.</p>
          </details>
          <img
            src="https://cdn.fixture.test/directions-ocr-distractor.png"
            data-ocr-text="HOW TO USE&#10;Step 1: Apply the cleanser.&#10;Step 2: Rinse with water.&#10;Step 3: Finish with the matching moisturizer."
          />
        </main>
        """,
        "https://fixture.test/products/hydrating-lotion",
        {"provider": "mock"},
    )
    product = run.result["geoProduct"]

    assert product["usage"] == [
        "1. Dispense the lotion into clean palms.",
        "2. Smooth it evenly across the face.",
    ]
    assert product["semanticFacts"]["usageSteps"] == product["usage"]
    assert "Apply the cleanser" not in " ".join(product["usage"])
    assert "companion toner" not in " ".join(product["usage"])
    assert any(
        "Apply the cleanser." in item["text"] for item in product["sourceExtraction"]["ocr"]["imageTexts"]
    )


@pytest.mark.asyncio
async def test_dom_usage_sequence_combines_accessible_and_textual_step_labels() -> None:
    """A card collection may expose its ordinal through more than one channel."""

    run = await extract_product_from_html(
        """
        <main>
          <h1>Fixture Hydrating Lotion</h1>
          <section class="application-card-stack">
            <div class="application-card-stack__header"><span>Directions</span></div>
            <div class="application-card-stack__content">
              <article aria-label="Step 1"><p>Dispense the lotion into clean palms.</p></article>
              <article><p>Step 2: Smooth it evenly across the face.</p></article>
            </div>
          </section>
        </main>
        """,
        "https://fixture.test/products/mixed-step-labels",
        {"provider": "mock"},
    )

    assert run.result["geoProduct"]["usage"] == [
        "1. Dispense the lotion into clean palms.",
        "2. Smooth it evenly across the face.",
    ]


@pytest.mark.asyncio
async def test_dom_usage_sequence_stops_before_a_later_faq_card_in_the_same_main() -> None:
    """A FAQ's aria-labelled row cannot join the preceding Directions cards."""

    run = await extract_product_from_html(
        """
        <main>
          <h1>Fixture Hydrating Lotion</h1>
          <div class="directions-header">Directions</div>
          <div class="directions-card-list">
            <article aria-label="Step 1"><p>Dispense the lotion into clean palms.</p></article>
            <article aria-label="Step 2"><p>Smooth it evenly across the face.</p></article>
          </div>
          <details>
            <summary>Can I use this with a companion serum?</summary>
            <article aria-label="Step 1"><p>Apply the companion serum before this lotion.</p></article>
          </details>
        </main>
        """,
        "https://fixture.test/products/directions-before-faq",
        {"provider": "mock"},
    )

    product = run.result["geoProduct"]
    assert product["usage"] == [
        "1. Dispense the lotion into clean palms.",
        "2. Smooth it evenly across the face.",
    ]
    assert "companion serum" not in " ".join(product["usage"])


@pytest.mark.asyncio
async def test_first_declared_source_procedure_wins_without_a_ritual_title_bonus() -> None:
    """DOM order, not a particular heading word, owns competing source procedures."""

    run = await extract_product_from_html(
        """
        <main>
          <h1>Fixture Hydrating Lotion</h1>
          <section class="directions-card-stack">
            <div class="directions-card-stack__header"><span>Directions</span></div>
            <div class="directions-card-stack__content">
              <article aria-label="Step 1"><p>Dispense the lotion into clean palms.</p></article>
              <article aria-label="Step 2"><p>Smooth it evenly across the face.</p></article>
            </div>
          </section>
          <section class="ritual-card-stack">
            <div class="ritual-card-stack__header"><span>Ritual</span></div>
            <div class="ritual-card-stack__content">
              <article aria-label="Step 1"><p>Warm the companion balm between your palms.</p></article>
              <article aria-label="Step 2"><p>Press the companion balm over the face.</p></article>
            </div>
          </section>
        </main>
        """,
        "https://fixture.test/products/ordered-procedures",
        {"provider": "mock"},
    )

    product = run.result["geoProduct"]
    assert product["usage"] == [
        "1. Dispense the lotion into clean palms.",
        "2. Smooth it evenly across the face.",
    ]
    assert "companion balm" not in " ".join(product["usage"])


def test_flattened_visual_lines_keep_a_later_ordinal_and_its_step() -> None:
    """A step printed after an unpunctuated OCR line is still the page's step two.

    A long PDP image flattens to one line, so an ordinal can follow package
    copy that ends on a volume rather than on punctuation.  Read as prose that
    ordinal disappears, and the first step swallows the rest of the section --
    the second instruction, the name plate, and the badge panel with it.
    """

    source = (
        "사용법 1 클렌징 단계에서 젖은 손에 적당량을 덜어 충분히 "
        "SAMPLEDERMA BARRIERCARE365 CLEANSING FOAM "
        "1 클렌징 단계에서 젖은 손에 적당량을 덜어 충분히 거품을 내주세요. "
        "SAMPLEDERMA BARRIERCARE365 CLEANSING FOAM Barrier-Protective Formula "
        "AM/PM cleansing, while protecting skin barrier For dry & sensitive skin 7.05 oz. / 200 g "
        "2 얼굴에 부드럽게 롤링하여 노폐물을 녹여낸 후 미온수로 깨끗이 씻어줍니다. "
        "SAMPLEDERMA BARRIERCARE365 CLEANSING FOAM Barrier-Protective Formula "
        "AM/PM cleansing, while protecting skin barrier For dry & sensitive skin 7.05 oz. / 200 g "
        "아침 저녁으로 적합한 데일리 클렌저! "
        "극민감 테스트 완료 DERMATOLOGIST TESTED 피부과 테스트 완료"
    )

    assert extract_numbered_usage_steps(source) == [
        "1. 클렌징 단계에서 젖은 손에 적당량을 덜어 충분히 거품을 내주세요.",
        "2. 얼굴에 부드럽게 롤링하여 노폐물을 녹여낸 후 미온수로 깨끗이 씻어줍니다.",
    ]


def test_a_quantity_inside_an_unfinished_step_is_not_read_as_the_next_position() -> None:
    """A number the instruction measures with is not the list's next position.

    The relaxation that recovers an unpunctuated ordinal must not promote a
    dose.  A position can only open once the position now open has closed, and
    a quantity stands mid-clause where nothing has closed yet.
    """

    source = "How to use: 1. Warm 2 pumps between clean palms. 2. Press it over the face and neck."

    assert extract_numbered_usage_steps(source) == [
        "1. Warm 2 pumps between clean palms.",
        "2. Press it over the face and neck.",
    ]


def test_a_number_inside_a_step_is_not_read_as_a_repeated_position() -> None:
    """A step that numbers its own subject is one step, not two readings of one.

    A repeated position is the same instruction transcribed again, so it opens
    on the same words.  A number inside a step's wording reads on into
    different words and belongs to the step that prints it.
    """

    source = "How to use: 1. Apply layer 1 after toner. 2. Apply layer 2 after toner."

    assert extract_numbered_usage_steps(source) == [
        "1. Apply layer 1 after toner.",
        "2. Apply layer 2 after toner.",
    ]

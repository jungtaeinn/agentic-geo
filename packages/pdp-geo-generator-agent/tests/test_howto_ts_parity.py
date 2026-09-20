"""Regression coverage for the retained TypeScript HowTo procedure contract."""

from __future__ import annotations

from typing import Any, cast

import pytest

from pdp_geo_generator_agent.content_planning import create_conservative_content_plan, create_pdp_geo_evidence_ledger
from pdp_geo_generator_agent.generation import collect_pdp_geo_plan_render_shortfalls, generate_pdp_geo_artifacts
from pdp_geo_generator_agent.validation import validate_and_repair_pdp_geo_artifacts


def _how_to(artifact: dict[str, Any]) -> dict[str, Any]:
    return next(
        node
        for node in cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])
        if node.get("@type") == "HowTo"
    )


def _plan(product: dict[str, Any]) -> dict[str, Any]:
    return create_conservative_content_plan(
        {"product": product, "locale": "en-US", "evidenceLedger": create_pdp_geo_evidence_ledger(product, "en-US")}
    )


def test_mixed_numbered_routine_and_fragment_share_one_canonical_procedure() -> None:
    """An embedded 1/2 routine plus a separate 3 fragment remains a three-step source procedure."""

    product = {
        "name": "Barrier Serum",
        "usage": [
            "1. Dispense one pump into clean palms. 2. Apply it over the face and neck.",
            "3. Press gently until absorbed.",
        ],
    }
    plan = _plan(product)
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    expected = [
        "Dispense one pump into clean palms.",
        "Apply it over the face and neck.",
        "Press gently until absorbed.",
    ]

    assert plan["howTo"]["ordered"] is True
    assert [step["text"] for step in plan["howTo"]["steps"]] == expected
    assert [step["position"] for step in plan["howTo"]["steps"]] == [1, 2, 3]
    assert [step["text"] for step in _how_to(artifact)["step"]] == expected
    assert artifact["content"]["sections"]["howToUse"].splitlines() == expected
    assert collect_pdp_geo_plan_render_shortfalls(plan, artifact["schemaMarkup"], artifact["content"]) == []


def test_explicit_numbered_eye_area_procedure_preserves_an_uncommon_first_action() -> None:
    """A source-owned sequence keeps every numbered action, not only familiar verbs."""

    source_steps = [
        "1. Dot cream across your entire under-eye area.",
        "2. Gently pat cream into the skin using your fingertips, moving from the inner corner of your eye towards the outer edge in a semi-circular motion.",
        "3. Gaze upwards and gently massage the under eye area with your middle three fingers to enhance blood circulation.",
    ]
    product = {
        "name": "Example Eye Cream",
        "usage": source_steps,
        "semanticFacts": {"usageSteps": source_steps},
    }
    plan = _plan(product)
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    expected = [
        "Dot cream across your entire under-eye area.",
        "Gently pat cream into the skin using your fingertips, moving from the inner corner of your eye towards the outer edge in a semi-circular motion.",
        "Gaze upwards and gently massage the under eye area with your middle three fingers to enhance blood circulation.",
    ]

    assert plan["howTo"]["ordered"] is True
    assert [step["position"] for step in plan["howTo"]["steps"]] == [1, 2, 3]
    assert [step["text"] for step in plan["howTo"]["steps"]] == expected
    assert [step["text"] for step in _how_to(artifact)["step"]] == expected
    assert artifact["content"]["sections"]["howToUse"].splitlines() == expected
    assert collect_pdp_geo_plan_render_shortfalls(plan, artifact["schemaMarkup"], artifact["content"]) == []
    repaired = validate_and_repair_pdp_geo_artifacts(
        {
            "schemaMarkup": artifact["schemaMarkup"],
            "content": artifact["content"],
            "locale": "en-US",
            "fallbackProductName": "Example Eye Cream",
            "fallbackDescription": "Example Eye Cream.",
        }
    )
    repaired_how_to = next(
        node
        for node in cast(list[dict[str, Any]], repaired["schemaMarkup"]["jsonLd"]["@graph"])
        if node.get("@type") == "HowTo"
    )
    assert [step["text"] for step in repaired_how_to["step"]] == expected
    assert not [repair for repair in repaired["validationRepairs"] if repair["field"] == "HowTo.step.text"]


@pytest.mark.parametrize(
    ("locale", "source_steps", "expected"),
    [
        (
            "en-US",
            ["1. Shake the bottle well.", "2. Wait 30 seconds.", "3. Style as desired."],
            ["Shake the bottle well.", "Wait 30 seconds.", "Style as desired."],
        ),
        (
            "ko-KR",
            ["1. 병을 충분히 흔듭니다.", "2. 30초 기다립니다.", "3. 원하는 대로 스타일링합니다."],
            ["병을 충분히 흔듭니다.", "30초 기다립니다.", "원하는 대로 스타일링합니다."],
        ),
    ],
)
def test_complete_numbered_source_procedure_preserves_category_neutral_actions(
    locale: str, source_steps: list[str], expected: list[str]
) -> None:
    """Contiguous source numbering, not a skincare-verb allowlist, proves an ordered procedure."""

    product = {"name": "Wave Mist", "usage": source_steps, "semanticFacts": {"usageSteps": source_steps}}
    plan = create_conservative_content_plan(
        {"product": product, "locale": locale, "evidenceLedger": create_pdp_geo_evidence_ledger(product, locale)}
    )
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": locale, "contentPlan": plan})

    assert plan["howTo"]["ordered"] is True
    assert [step["text"] for step in plan["howTo"]["steps"]] == expected
    assert [step["text"] for step in _how_to(artifact)["step"]] == expected
    assert artifact["content"]["sections"]["howToUse"].splitlines() == expected


def test_explicit_ritual_steps_keep_the_source_sequence_when_a_raw_ritual_block_is_also_present() -> None:
    """Rejecting ``warm`` as non-actionable would drop step 1 and merge the raw ritual block."""

    source_steps = [
        "1. After serum, warm a pearl-sized amount between your palms.",
        "2. Press the cream gently over the face and neck.",
        "Experience the age-old benefits of this rich cream ritual. Step 1: After serum, warm a pearl-sized amount "
        "between your palms. Step 2: Press the cream gently over the face and neck.",
    ]
    product = {
        "name": "Ritual Cream",
        "usage": source_steps,
        "semanticFacts": {"usageSteps": source_steps},
    }
    plan = _plan(product)
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    expected = [
        "After serum, warm a pearl-sized amount between your palms.",
        "Press the cream gently over the face and neck.",
    ]

    assert plan["howTo"]["ordered"] is True
    assert [step["text"] for step in plan["howTo"]["steps"]] == expected
    assert [step["position"] for step in plan["howTo"]["steps"]] == [1, 2]
    assert [step["text"] for step in _how_to(artifact)["step"]] == expected
    assert artifact["content"]["sections"]["howToUse"].splitlines() == expected
    assert "Experience the age-old benefits" not in artifact["content"]["sections"]["howToUse"]


def test_numbered_packaging_copy_does_not_become_a_source_procedure() -> None:
    """Ordinal markers alone cannot promote carton or recycling instructions into HowTo."""

    product = {
        "name": "Example Eye Cream",
        "usage": ["1. Keep the carton upright.", "2. Recycle the carton after use."],
    }

    plan = _plan(product)

    assert plan["howTo"]["eligible"] is False
    assert plan["howTo"]["steps"] == []


def test_numbered_product_packaging_copy_does_not_bypass_the_source_procedure_gate() -> None:
    """The generic word ``product`` cannot turn disposal instructions into HowTo."""

    product = {
        "name": "Example Gel",
        "usage": [
            "1. Keep the product packaging upright during storage.",
            "2. Recycle the product packaging after use.",
        ],
    }

    plan = _plan(product)

    assert plan["howTo"]["eligible"] is False
    assert plan["howTo"]["steps"] == []


def test_numbered_measurement_copy_does_not_become_a_source_procedure() -> None:
    """Numbered study results are evidence, not product-application instructions."""

    product = {
        "name": "Example Serum",
        "usage": [
            "1. 95% of users saw smoother-looking skin.",
            "2. 90% of users saw brighter-looking skin.",
        ],
    }

    plan = _plan(product)

    assert plan["howTo"]["eligible"] is False
    assert plan["howTo"]["steps"] == []


def test_full_validator_preserves_a_complete_explicit_source_procedure_with_unfamiliar_actions() -> None:
    """Validation honors an already admitted source procedure instead of re-filtering its verbs."""

    source_steps = [
        "1. Glide the cream from the centre of the face outward.",
        "2. Cup the face gently with both hands until the cream is absorbed.",
    ]
    product = {"name": "Example Cream", "usage": source_steps}
    plan = _plan(product)
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    expected = [
        "Glide the cream from the centre of the face outward.",
        "Cup the face gently with both hands until the cream is absorbed.",
    ]

    repaired = validate_and_repair_pdp_geo_artifacts(
        {
            "schemaMarkup": artifact["schemaMarkup"],
            "content": artifact["content"],
            "locale": "en-US",
            "sourceProduct": product,
            "fallbackProductName": "Example Cream",
            "fallbackDescription": "Example Cream.",
        }
    )
    repaired_how_to = next(
        node
        for node in cast(list[dict[str, Any]], repaired["schemaMarkup"]["jsonLd"]["@graph"])
        if node.get("@type") == "HowTo"
    )

    assert plan["howTo"]["ordered"] is True
    assert [step["text"] for step in repaired_how_to["step"]] == expected
    assert not [repair for repair in repaired["validationRepairs"] if repair["field"] == "HowTo.step.text"]


def test_unordered_actions_do_not_become_an_ordered_multi_step_procedure() -> None:
    """Independent actions remain visible but do not become schema HowTo steps."""

    product = {
        "name": "Barrier Serum",
        "usage": ["Apply one pump to clean skin.", "Press gently until absorbed."],
    }
    plan = _plan(product)
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    expected = ["Apply one pump to clean skin.", "Press gently until absorbed."]

    assert plan["howTo"]["ordered"] is False
    assert [step["text"] for step in plan["howTo"]["steps"]] == expected
    assert not any(node.get("@type") == "HowTo" for node in artifact["schemaMarkup"]["jsonLd"]["@graph"])
    assert artifact["content"]["sections"]["howToUse"].splitlines() == expected
    assert collect_pdp_geo_plan_render_shortfalls(plan, artifact["schemaMarkup"], artifact["content"]) == []


def test_structured_semantic_usage_sequence_preserves_source_step_boundaries_without_ordinals() -> None:
    """A normalized source relationship retains its order after display labels are removed.

    The extractor may intentionally remove ``Step 1`` / ``Step 2`` labels while
    keeping the ordered source actions in both ``usage`` and
    ``semanticFacts.usageSteps``.  That relationship is different from an
    arbitrary list of independent directions and must survive into both public
    HowTo representations.
    """

    source_steps = [
        "After serum, warm a pea-sized amount between your fingertips.",
        "Apply the cream evenly over the face and neck, then press lightly to aid absorption.",
    ]
    product = {
        "name": "Ritual Cream",
        "usage": source_steps,
        "semanticFacts": {"usageSteps": source_steps},
    }
    plan = _plan(product)
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})

    assert plan["howTo"]["ordered"] is True
    assert [step["position"] for step in plan["howTo"]["steps"]] == [1, 2]
    assert [step["text"] for step in plan["howTo"]["steps"]] == source_steps
    assert [step["text"] for step in _how_to(artifact)["step"]] == source_steps
    assert artifact["content"]["sections"]["howToUse"].splitlines() == source_steps


def test_semantic_usage_prefix_preserves_the_direct_sequence_without_ancillary_step() -> None:
    """A semantic routine note corroborates, but does not extend, direct source steps."""

    source_steps = [
        "After cleansing, dispense one pump into your palm.",
        "Press it gently over the face and neck.",
    ]
    product = {
        "name": "Barrier Serum",
        "usage": source_steps,
        "semanticFacts": {
            "usageSteps": [
                *source_steps,
                "Apply morning and night as the final step of your skincare routine.",
            ]
        },
    }
    plan = _plan(product)
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})

    assert plan["howTo"]["ordered"] is True
    assert [step["position"] for step in plan["howTo"]["steps"]] == [1, 2]
    assert [step["text"] for step in plan["howTo"]["steps"]] == source_steps
    assert [step["text"] for step in _how_to(artifact)["step"]] == source_steps
    assert artifact["content"]["sections"]["howToUse"].splitlines() == source_steps
    assert collect_pdp_geo_plan_render_shortfalls(plan, artifact["schemaMarkup"], artifact["content"]) == []


def test_explicit_numbered_procedure_has_no_renderer_or_planner_step_cap() -> None:
    """Every explicitly numbered source step survives the canonical plan and both public surfaces."""

    source_steps = [f"{position}. Apply layer {position} with one pump." for position in range(1, 10)]
    product = {"name": "Barrier Serum", "usage": source_steps}
    plan = _plan(product)
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    expected = [f"Apply layer {position} with one pump." for position in range(1, 10)]

    assert [step["text"] for step in plan["howTo"]["steps"]] == expected
    assert [step["text"] for step in _how_to(artifact)["step"]] == expected
    assert artifact["content"]["sections"]["howToUse"].splitlines() == expected


def test_structural_gate_accepts_canonical_source_step_when_planner_wording_differs() -> None:
    """The renderer may retain a source instruction instead of a plan paraphrase."""

    plan = {
        "howTo": {
            "eligible": True,
            "steps": [{"position": 1, "text": "Use the serum after cleansing."}],
        }
    }
    schema_markup = {
        "jsonLd": {
            "@graph": [
                {
                    "@type": "HowTo",
                    "step": [
                        {
                            "@type": "HowToStep",
                            "position": 1,
                            "text": "After cleansing, dispense one pump and smooth it over the face.",
                        }
                    ],
                }
            ]
        }
    }
    content = {"sections": {"howToUse": "After cleansing, dispense one pump and smooth it over the face."}}

    assert collect_pdp_geo_plan_render_shortfalls(plan, schema_markup, content) == []


@pytest.mark.parametrize(
    ("plan_steps", "schema_steps", "visible_steps"),
    [
        (
            [
                {"position": 1, "text": "Plan first step."},
                {"position": 2, "text": "Plan second step."},
            ],
            [{"position": 1, "text": "Canonical first step."}],
            ["Canonical first step."],
        ),
        (
            [
                {"position": 1, "text": "Plan first step."},
                {"position": 2, "text": "Plan second step."},
            ],
            [
                {"position": 2, "text": "Canonical second step."},
                {"position": 1, "text": "Canonical first step."},
            ],
            ["Canonical second step.", "Canonical first step."],
        ),
        (
            [
                {"position": 1, "text": "Plan first step."},
                {"position": 2, "text": "Plan second step."},
            ],
            [
                {"position": 1, "text": "Canonical first step."},
                {"position": 2, "text": "Canonical second step."},
            ],
            ["Canonical second step.", "Canonical first step."],
        ),
        (
            [{"position": 1, "text": "Plan only step."}],
            [
                {"position": 1, "text": "Canonical first step."},
                {"position": 2, "text": "Unexpected second step."},
            ],
            ["Canonical first step.", "Unexpected second step."],
        ),
    ],
    ids=("missing", "schema-position-reordered", "visible-reordered", "extra"),
)
def test_structural_gate_rejects_missing_reordered_or_extra_howto_rows(
    plan_steps: list[dict[str, Any]], schema_steps: list[dict[str, Any]], visible_steps: list[str]
) -> None:
    """Counts, schema positions, and visible order remain structural invariants."""

    plan = {"howTo": {"eligible": True, "steps": plan_steps}}
    schema_markup = {"jsonLd": {"@graph": [{"@type": "HowTo", "step": schema_steps}]}}
    content = {"sections": {"howToUse": "\n".join(visible_steps)}}

    shortfalls = collect_pdp_geo_plan_render_shortfalls(plan, schema_markup, content)

    assert any("HowTo plan/render structural coverage shortfall" in shortfall for shortfall in shortfalls)

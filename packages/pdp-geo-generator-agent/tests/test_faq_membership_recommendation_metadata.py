"""Regression coverage for immutable FAQ-card recommendation metadata."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

from pdp_geo_generator_agent.generation import ensure_pdp_geo_faq_plan_coverage, generate_pdp_geo_artifacts


def _product() -> dict[str, Any]:
    return {
        "name": "Glow Serum",
        "brand": "Example Lab",
        "category": "serum",
        "description": "Glow Serum is intended for dry skin.",
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["Glow Serum is intended for dry skin."],
    }


def _plan(cards: list[Mapping[str, Any]]) -> dict[str, Any]:
    # The row deliberately forges canRecommend=True.  Only the matching
    # relationship-card value is allowed to reach finalized membership.
    return {
        "mode": "model",
        "_admittedContentPlan": True,
        "faqRelationshipCards": [dict(card) for card in cards],
        "faq": [
            {
                "id": "faq-dry-skin",
                "include": True,
                "question": "What serum is good for a dry-skin care goal?",
                "answer": "For dry skin, consider Example Lab's Glow Serum.",
                "intent": "buyer-decision",
                "evidenceIds": ["ev-audience"],
                "canRecommend": True,
            }
        ],
        "howTo": {"eligible": False, "steps": []},
    }


@pytest.mark.parametrize(
    ("cards", "expected", "coverage_expected"),
    [
        ([{"id": "faq-dry-skin", "canRecommend": True}], True, True),
        ([{"id": "faq-dry-skin", "canRecommend": False}], False, False),
        ([{"id": "faq-dry-skin"}], False, False),
        ([{"id": "faq-other", "canRecommend": True}], False, None),
    ],
)
def test_faq_membership_resolves_recommendation_only_from_the_matching_card(
    cards: list[Mapping[str, Any]], expected: bool, coverage_expected: bool | None
) -> None:
    """Renderer and coverage membership never trust a model row's flag."""

    product = _product()
    plan = _plan(cards)
    artifact = generate_pdp_geo_artifacts(
        {"product": product, "locale": "en-US", "contentPlan": plan}
    )

    assert artifact["faqMembership"] == [
        {
            "id": "faq-dry-skin",
            "intent": "buyer-decision",
            "evidenceIds": ["ev-audience"],
            "canRecommend": expected,
        }
    ]

    finalized = ensure_pdp_geo_faq_plan_coverage(
        {
            "plan": plan,
            "product": product,
            "locale": "en-US",
            "evidenceLedger": [{"id": "ev-audience"}],
        }
    )
    membership = finalized["faqMembership"]
    if coverage_expected is None:
        assert membership == []
    else:
        assert membership == [
            {
                "id": "faq-dry-skin",
                "intent": "buyer-decision",
                "evidenceIds": ["ev-audience"],
                "canRecommend": coverage_expected,
            }
        ]

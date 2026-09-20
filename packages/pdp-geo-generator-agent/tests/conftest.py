"""Shared product fixtures for the PDP GEO generator test suite."""

from __future__ import annotations

from typing import Any

import pytest


@pytest.fixture
def source_backed_product() -> dict[str, Any]:
    """Return a small product whose every publishable claim has a source sentence.

    Admission tests need a product that clears the evidence gate on its own, so
    that a failure observed in a test is attributable to the behaviour under
    test rather than to thin source material.
    """

    return {
        "name": "Dew Barrier Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "Dew Barrier Serum is a serum for dry and sensitive skin.",
        "ingredients": ["Ceramide Matrix"],
        "benefits": ["Supports hydration"],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [
            "A solution for dryness and tightness.",
            "Northstar Lab's Dew Barrier Serum works best for dry and sensitive skin.",
            "Ceramide Matrix supports hydration.",
        ],
        "semanticFacts": {
            "skinTypes": ["dry skin", "sensitive skin"],
            "evidenceSentences": [
                "A solution for dryness and tightness.",
                "Northstar Lab's Dew Barrier Serum works best for dry and sensitive skin.",
            ],
            "ingredientBenefitLinks": [
                {
                    "ingredient": "Ceramide Matrix",
                    "benefit": "hydration",
                    "sourceText": "Ceramide Matrix supports hydration.",
                }
            ],
        },
    }

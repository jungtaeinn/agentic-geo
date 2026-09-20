"""A page states its offer as one sentence, and that sentence proves its figures.

Price and options are one offer, so the renderer writes one sentence in each
locale.  A frame that only knew the older two-sentence shape could not prove the
merged one, and an unprovable sentence used to cost the whole description, so
these keep the renderer and its provenance frame on the same sentence.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, cast

import pytest

from pdp_geo_generator_agent.final_proofreader import create_pdp_geo_public_copy_provenance
from pdp_geo_generator_agent.generation import generate_pdp_geo_artifacts


def _node(artifact: Mapping[str, Any], kind: str) -> dict[str, Any]:
    graph = cast(list[dict[str, Any]], cast(Mapping[str, Any], artifact["schemaMarkup"])["jsonLd"]["@graph"])
    return next(
        item
        for item in graph
        if kind in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]])
    )


def _english_serum() -> dict[str, Any]:
    review = "The finish stays lightweight all day."
    return {
        "name": "Barrier Serum",
        "brand": "Example Lab",
        "category": "serum",
        "description": "Barrier Serum is a serum for dry skin.",
        "ingredients": ["Ceramide Complex"],
        "benefits": ["supports hydration"],
        "effects": [],
        "usage": ["Apply to clean skin morning and evening."],
        "metrics": [],
        "options": ["30ml", "50ml"],
        "price": {"raw": "48.00", "amount": 48, "currency": "USD"},
        "faq": [],
        "reviews": {"items": [{"body": review}], "keywords": ["lightweight finish"]},
        "sourceTexts": ["Barrier Serum is a serum for dry skin."],
        "semanticFacts": {
            "skinTypes": ["dry skin"],
            "usageSteps": ["Apply to clean skin morning and evening."],
            "safetyTests": [],
            "evidenceSentences": ["Barrier Serum is a serum for dry skin."],
            "ingredientBenefitLinks": [],
            "citations": [],
            "metricClaims": [],
        },
    }


def test_the_english_page_states_its_price_and_option_as_one_offer_before_the_reviews() -> None:
    """The English page carries the same single offer sentence the Korean page does."""

    webpage = cast(
        str, _node(generate_pdp_geo_artifacts({"product": _english_serum(), "locale": "en-US"}), "WebPage")["description"]
    )
    offer = "Barrier Serum is listed at $48 and offered in 30ml and 50ml."

    assert offer in webpage
    assert "is offered in 30ml and 50ml." not in webpage.replace(offer, "")
    assert webpage.index(offer) < webpage.index("Customers who reviewed")


@pytest.mark.parametrize(
    ("locale", "sentence", "price_text", "options"),
    [
        (
            "en-US",
            "Barrier Serum is listed at $48 and offered in 30ml and 50ml.",
            "48.00",
            ["30ml", "50ml"],
        ),
        (
            "ko-KR",
            "장벽 세럼은 22,000원에 판매되며, 30ml 옵션으로 구성되어 있습니다.",
            "22000.0",
            ["30ml"],
        ),
    ],
    ids=("en-US", "ko-KR"),
)
def test_a_merged_offer_sentence_binds_to_the_recorded_price_and_options(
    locale: str, sentence: str, price_text: str, options: list[str]
) -> None:
    """One sentence naming both facts cites both commerce atoms, and nothing else."""

    name = "Barrier Serum" if locale == "en-US" else "장벽 세럼"
    ledger = [
        {
            "id": "ev-identity",
            "role": "identity",
            "text": name,
            "sourcePath": "product.name",
            "locale": locale,
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "ev-price",
            "role": "commerce",
            "text": price_text,
            "sourcePath": "product.price.raw",
            "locale": locale,
            "productScope": "product",
            "confidence": 1,
        },
        *[
            {
                "id": f"ev-option-{index}",
                "role": "commerce",
                "text": option,
                "sourcePath": f"product.options[{index}]",
                "locale": locale,
                "productScope": "product",
                "confidence": 1,
            }
            for index, option in enumerate(options)
        ],
    ]
    payload = {
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [{"@type": ["WebPage", "ItemPage"], "description": sentence}],
            }
        },
        "contentPlan": {"mode": "conservative"},
        "evidenceLedger": ledger,
    }

    entry = next(
        item
        for item in create_pdp_geo_public_copy_provenance(payload)
        if item["fieldPath"] == "WebPage.description"
    )

    assert set(entry["evidenceIds"]) == {"ev-identity", "ev-price", *[f"ev-option-{i}" for i in range(len(options))]}

    # A figure the page never recorded is not the page's offer.
    wrong = re.sub(r"\d[\d,]*", "99", sentence, count=1)
    assert all(
        item["fieldPath"] != "WebPage.description"
        for item in create_pdp_geo_public_copy_provenance(
            {
                **payload,
                "schemaMarkup": {
                    "jsonLd": {
                        "@context": "https://schema.org",
                        "@graph": [{"@type": ["WebPage", "ItemPage"], "description": wrong}],
                    }
                },
            }
        )
    )

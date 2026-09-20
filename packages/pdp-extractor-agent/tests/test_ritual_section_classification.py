"""Regression coverage for source-heading section classification."""

from __future__ import annotations

import pytest

from pdp_extractor_agent.service import extract_product_from_html

_RITUAL_TEXT = (
    "Discover the benefits of this rich cream ritual. "
    "Step 1: After serum, warm a pearl-sized amount between your palms. "
    "Step 2: Press the cream gently over the face and neck."
)
_BENEFIT_TEXT = "Helps visibly improve skin firmness and radiance."


@pytest.mark.asyncio
async def test_html_extraction_routes_a_ritual_step_sequence_to_usage() -> None:
    run = await extract_product_from_html(
        f"""
        <main>
          <h1>Concentrated Botanical Renewing Cream Rich</h1>
          <section>
            <h2>RITUAL</h2>
            <p>Discover the benefits of this rich cream ritual.</p>
            <p>Step 1: After serum, warm a pearl-sized amount between your palms.</p>
            <p>Step 2: Press the cream gently over the face and neck.</p>
          </section>
          <section>
            <h2>BENEFITS</h2>
            <p>{_BENEFIT_TEXT}</p>
          </section>
        </main>
        """,
        "https://example.test/products/concentrated-ginseng-renewing-cream-rich",
        {"provider": "mock"},
    )
    product = run.result["geoProduct"]

    assert product["sourceExtraction"]["html"]["sections"] == [
        {
            "title": "RITUAL",
            "category": "usage",
            "text": _RITUAL_TEXT,
            "bullets": [
                "Discover the benefits of this rich cream ritual",
                "Step 1: After serum, warm a pearl-sized amount between your palms",
                "Step 2: Press the cream gently over the face and neck.",
            ],
        },
        {"title": "BENEFITS", "category": "benefit", "text": _BENEFIT_TEXT, "bullets": [_BENEFIT_TEXT]},
    ]

"""Review aggregate evidence and body-only keyword contracts (4 counterparts)."""

from __future__ import annotations

import pytest

from pdp_extractor_agent.service import extract_product_from_html

BASE = """
<html><head><script type="application/ld+json">{"@type":"Product","name":"Ginseng Serum","aggregateRating":{"ratingValue":"4.8","reviewCount":"854"}}</script></head>
<body><h1>Ginseng Serum</h1><img src="/clinical.jpg" data-ocr-text="After 6 weeks, ginseng peptide improves firmness and elasticity."><section class="reviews-section"><h2>Reviews</h2><button>Write a Review</button><div class="yotpo-widget-instance"></div></section></body></html>
"""


@pytest.mark.asyncio
async def test_records_aggregate_evidence_and_warns_when_review_bodies_are_unavailable() -> None:
    run = await extract_product_from_html(BASE, "https://brand.example/products/ginseng")
    assert run.result["geoProduct"]["reviews"] == {"rating": 4.8, "reviewCount": 854, "items": [], "keywords": []}
    assert {item["field"] for item in run.diagnostics["evidence"]} >= {
        "product.reviews.rating",
        "product.reviews.reviewCount",
    }
    assert {warning["code"] for warning in run.diagnostics["warnings"]} >= {"REVIEW_BODIES_UNAVAILABLE"}


@pytest.mark.asyncio
async def test_attributes_dom_review_count_when_json_ld_only_has_rating() -> None:
    html = BASE.replace(',"reviewCount":"854"', "").replace(
        "<button>Write a Review</button>",
        '<button>Write a Review</button><div aria-label="854 reviews">854 reviews</div>',
    )
    run = await extract_product_from_html(html, "https://brand.example/products/ginseng")
    evidence = {
        item["field"]: item["source"]
        for item in run.diagnostics["evidence"]
        if item["field"].startswith("product.reviews")
    }
    assert run.result["geoProduct"]["reviews"]["reviewCount"] == 854 and evidence == {
        "product.reviews.rating": "jsonLd",
        "product.reviews.reviewCount": "dom",
    }


@pytest.mark.asyncio
async def test_does_not_turn_product_copy_or_widget_chrome_into_review_keywords() -> None:
    run = await extract_product_from_html(BASE, "https://brand.example/products/ginseng")
    keywords = [item.casefold() for item in run.result["geoProduct"]["reviews"]["keywords"]]
    assert not set(keywords) & {"firmness", "elasticity", "ginseng", "review", "reviews", "rating", "customer", "stars"}


@pytest.mark.asyncio
async def test_derives_keywords_from_an_actual_review_body() -> None:
    html = BASE.replace(
        '<div class="yotpo-widget-instance"></div>',
        '<div itemprop="review"><p>Absorbs fast and leaves my skin smooth; I will repurchase.</p></div>',
    )
    run = await extract_product_from_html(html, "https://brand.example/products/ginseng")
    assert len(run.result["geoProduct"]["reviews"]["items"]) == 1
    assert "smooth" in [item.casefold() for item in run.result["geoProduct"]["reviews"]["keywords"]]
    assert "REVIEW_BODIES_UNAVAILABLE" not in {warning["code"] for warning in run.diagnostics["warnings"]}

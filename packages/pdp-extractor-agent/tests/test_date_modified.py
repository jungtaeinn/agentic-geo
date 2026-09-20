"""Source-provided modified-date contracts (3 legacy counterparts)."""

from __future__ import annotations

import pytest

from pdp_extractor_agent.service import extract_product_from_html


def _html(head: str, body: str = "") -> str:
    return f"<html><head><title>Test Cream</title>{head}</head><body><h1>Test Cream</h1>{body}</body></html>"


@pytest.mark.asyncio
async def test_reads_article_modified_time_meta_tag_and_records_evidence() -> None:
    run = await extract_product_from_html(
        _html('<meta property="article:modified_time" content="2026-08-01T09:30:00Z">'),
        "https://example.com/products/test",
    )
    assert run.result["geoProduct"]["dateModified"] == "2026-08-01T09:30:00Z"
    assert any(item["field"] == "product.dateModified" for item in run.diagnostics["evidence"])


@pytest.mark.asyncio
async def test_reads_embedded_shopify_updated_at() -> None:
    run = await extract_product_from_html(
        _html("", '<script type="application/json">{"product":{"updated_at":"2026-07-30T11:00:00-04:00"}}</script>'),
        "https://example.com/products/test",
    )
    assert run.result["geoProduct"]["dateModified"] == "2026-07-30T11:00:00-04:00"


@pytest.mark.asyncio
async def test_omits_invalid_date_value() -> None:
    run = await extract_product_from_html(
        _html('<meta property="og:updated_time" content="yesterday">'), "https://example.com/products/test"
    )
    assert "dateModified" not in run.result["geoProduct"]

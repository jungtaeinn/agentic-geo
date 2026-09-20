"""Commerce-trust JSON-LD extraction contracts (2 legacy counterparts)."""

from __future__ import annotations

import pytest

from pdp_extractor_agent.service import extract_product_from_html

GRAPH_HTML = """
<html><head><script type="application/ld+json">{
  "@context":"https://schema.org", "@graph":[
    {"@type":"MerchantReturnPolicy","@id":"#returns","returnPolicyCategory":"MerchantReturnFiniteReturnWindow","merchantReturnDays":"45","returnMethod":"ReturnByMail","returnFees":"ReturnFeesCustomerResponsibility","applicableCountry":"US","merchantReturnLink":"/pages/shipping-return-policy"},
    {"@type":"Product","@id":"#product","name":"Ginseng Firming Serum","itemCondition":"https://schema.org/NewCondition","offers":{"@id":"#offer"}},
    {"@type":"Offer","@id":"#offer","price":"215.00","priceCurrency":"USD","availability":"OutOfStock","priceValidUntil":"2027-08-13","hasMerchantReturnPolicy":{"@id":"#returns"}}
  ]
}</script></head><body><h1>Ginseng Firming Serum</h1></body></html>
"""


@pytest.mark.asyncio
async def test_resolves_referenced_offer_and_merchant_return_policy() -> None:
    run = await extract_product_from_html(GRAPH_HTML, "https://brand.example.com/products/ginseng-firming-serum")
    product = run.result["geoProduct"]
    assert product["price"] == {"raw": "215.00", "amount": 215, "currency": "USD"}
    assert product["availability"] == "OutOfStock" and product["priceValidUntil"] == "2027-08-13"
    assert product["itemCondition"].endswith("NewCondition")
    assert product["returnPolicy"] == {
        "category": "MerchantReturnFiniteReturnWindow",
        "merchantReturnDays": 45,
        "returnMethod": "ReturnByMail",
        "returnFees": "ReturnFeesCustomerResponsibility",
        "applicableCountry": "US",
        "url": "https://brand.example.com/pages/shipping-return-policy",
    }


@pytest.mark.asyncio
async def test_omits_unprovided_commerce_trust_fields() -> None:
    run = await extract_product_from_html(
        '<script type="application/ld+json">{"@type":"Product","name":"Plain Cream","offers":{"@type":"Offer","price":"32000","priceCurrency":"KRW"}}</script><h1>Plain Cream</h1>',
        "https://example.com/products/plain",
    )
    product = run.result["geoProduct"]
    assert "availability" not in product and "priceValidUntil" not in product and "returnPolicy" not in product

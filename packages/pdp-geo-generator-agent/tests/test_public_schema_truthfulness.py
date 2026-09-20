"""Public JSON-LD regressions for source-truthful commerce and reviews."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from pdp_geo_generator_agent.content_planning import create_conservative_content_plan, create_pdp_geo_evidence_ledger
from pdp_geo_generator_agent.generation import generate_pdp_geo_artifacts


def _product(**overrides: object) -> dict[str, Any]:
    product: dict[str, Any] = {
        "name": "Barrier Serum",
        "brand": "Example Lab",
        "category": "serum",
        "description": "Barrier Serum is a lightweight serum.",
        "ingredients": ["Ceramide"],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "reviews": {"items": [], "keywords": []},
    }
    product.update(overrides)
    return product


def _records(value: object) -> list[Mapping[str, Any]]:
    assert isinstance(value, list)
    records: list[Mapping[str, Any]] = []
    for item in cast(list[object], value):
        assert isinstance(item, Mapping)
        records.append(cast(Mapping[str, Any], item))
    return records


def _reported_details(artifact: Mapping[str, Any]) -> str:
    """Read the measured-result attribute the renderer derives.

    Only keyword attributes are published, so a measured result is published
    in the descriptions that own it and kept here as a diagnostic.  These
    tests are about what the renderer may state as a measured result, which
    that diagnostic records exactly as before.
    """

    return next(
        (
            str(item["value"])
            for item in cast(list[dict[str, Any]], artifact["evidence"])
            if str(item["field"]) == "diagnostics.productAttribute.Reported details"
        ),
        "",
    )


def _product_node(artifact: Mapping[str, Any]) -> dict[str, Any]:
    return _node(artifact, "Product")


def _node(artifact: Mapping[str, Any], kind: str) -> dict[str, Any]:
    markup = cast(Mapping[str, Any], artifact["schemaMarkup"])
    json_ld = cast(Mapping[str, Any], markup["jsonLd"])
    node = next(
        item
        for item in _records(json_ld["@graph"])
        if kind in (item["@type"] if isinstance(item.get("@type"), list) else [item.get("@type")])
    )
    return dict(node)


def test_public_offer_normalizes_a_dollar_currency_symbol_to_iso_currency() -> None:
    """A currency glyph cannot be emitted as Offer.priceCurrency."""

    artifact = generate_pdp_geo_artifacts(
        {
            "product": _product(price={"raw": "$29.00", "currency": "$", "amount": 29}),
            "locale": "en-US",
            "market": "US",
            "sourceUrl": "https://shop.example.test/products/barrier-serum",
        }
    )

    offer = cast(dict[str, Any], _product_node(artifact)["offers"])

    assert offer["price"] == 29
    assert offer["priceCurrency"] == "USD"


def test_public_variant_offers_normalize_currency_symbols_to_iso_currency() -> None:
    """Variant Offer values use the same ISO currency contract as the current offer."""

    artifact = generate_pdp_geo_artifacts(
        {
            "product": _product(
                variants=[
                    {"title": "30 ml", "price": "$29", "currency": "$", "sku": "SERUM-30"},
                    {"title": "50 ml", "price": "$39", "currency": "$", "sku": "SERUM-50"},
                ]
            ),
            "locale": "en-US",
            "market": "US",
        }
    )

    offers = cast(list[dict[str, Any]], _product_node(artifact)["offers"])

    assert [offer["priceCurrency"] for offer in offers] == ["USD", "USD"]


def test_public_product_omits_an_ambiguous_ten_point_aggregate_rating() -> None:
    """A score above schema's implicit five-point scale needs an explicit scale, so omit it."""

    artifact = generate_pdp_geo_artifacts(
        {
            "product": _product(reviews={"rating": 10, "reviewCount": 8, "items": [], "keywords": []}),
            "locale": "en-US",
        }
    )

    assert "aggregateRating" not in _product_node(artifact)


def test_public_reviews_retain_only_meaningful_nonconflicting_positive_bodies() -> None:
    """Public Review nodes must not attach generic or cleanser-specific praise to a serum."""

    meaningful_serum_review = "This serum feels lightweight, absorbs quickly, and leaves my skin comfortable."
    artifact = generate_pdp_geo_artifacts(
        {
            "product": _product(
                reviews={
                    "items": [
                        {"body": "Great", "rating": 5},
                        {"body": "클렌저 거품을 내고 메이크업 세정이 잘 됩니다. 피부가 편안해요.", "rating": 5},
                        {"body": "Wonderful", "rating": 5},
                        {"body": meaningful_serum_review, "rating": 5},
                    ],
                    "keywords": [],
                }
            ),
            "locale": "en-US",
        }
    )

    reviews = cast(list[dict[str, Any]], _product_node(artifact)["review"])

    assert [review["reviewBody"] for review in reviews] == [meaningful_serum_review]


def test_public_schema_uses_the_source_backed_canonical_entity_name_without_category_stuffing() -> None:
    """Bracketed commerce labels and a source size do not fragment the Product/WebPage entity name."""

    artifact = generate_pdp_geo_artifacts(
        {
            "product": _product(
                name="[Example Lab][Limited] Barrier Serum 50ml",
                brand="Example Lab",
                category="cream",
                options=["50ml"],
            ),
            "locale": "en-US",
            "hints": {"category": "lotion"},
        }
    )

    product = _product_node(artifact)
    webpage = _node(artifact, "WebPage")

    assert product["name"] == "Example Lab Barrier Serum"
    assert webpage["name"] == "Example Lab Barrier Serum"
    assert product["category"] == "Cream"


def test_generic_category_labels_do_not_leak_into_named_english_or_korean_descriptions() -> None:
    """A generic source category cannot displace the richer named source description."""

    english = generate_pdp_geo_artifacts(
        {
            "product": _product(name="Barrier Serum", category="Reviews"),
            "locale": "en-US",
        }
    )
    korean = generate_pdp_geo_artifacts(
        {
            "product": _product(
                name="수분 세럼",
                brand="예시 랩",
                category="Reviews",
                description="수분 세럼은 건조한 피부를 위한 제품입니다.",
            ),
            "locale": "ko-KR",
        }
    )

    assert "Barrier Serum from Example Lab is a lightweight serum." in cast(str, _product_node(english)["description"])
    assert "reviews" not in cast(str, _product_node(english)["description"]).casefold()
    assert _product_node(korean)["category"] == "세럼"
    assert "예시 랩의 수분 세럼은 건조한 피부를 위한 제품입니다." in cast(
        str, _node(korean, "Product")["description"]
    )
    assert "예시 랩의 수분 세럼은 세럼입니다." not in cast(str, _node(korean, "Product")["description"])
    assert all("Reviews" not in cast(str, _node(korean, kind)["description"]) for kind in ("Product", "WebPage"))


def test_public_shipping_rate_normalizes_iso_currency_and_omits_invalid_rate_values() -> None:
    """Shipping monetary values must use the same complete ISO amount contract as Offer prices."""

    valid = generate_pdp_geo_artifacts(
        {
            "product": _product(
                price={"raw": "$29.00", "amount": 29, "currency": "$"},
                shipping={"destinationCountry": "US", "rate": {"amount": 4.5, "currency": "$"}},
            ),
            "locale": "en-US",
        }
    )
    invalid = generate_pdp_geo_artifacts(
        {
            "product": _product(
                price={"raw": "$29.00", "amount": 29, "currency": "$"},
                shipping={"destinationCountry": "US", "rate": {"amount": "not-a-number", "currency": "dollars"}},
            ),
            "locale": "en-US",
        }
    )

    assert _product_node(valid)["offers"]["shippingDetails"]["shippingRate"] == {
        "@type": "MonetaryAmount",
        "value": 4.5,
        "currency": "USD",
    }
    assert "shippingRate" not in _product_node(invalid)["offers"]["shippingDetails"]


def test_public_korean_review_copy_uses_object_particles_for_the_entity_and_keyword() -> None:
    """Positive Korean review narration inflects the actual entity and review phrase rather than hard-coding 을."""

    artifact = generate_pdp_geo_artifacts(
        {
            "product": _product(
                name="수분 에센스",
                brand="예시 랩",
                category="에센스",
                description="수분 에센스는 건조한 피부를 위한 제품입니다.",
                reviews={"items": [], "keywords": ["산뜻한 마무리"]},
            ),
            "locale": "ko-KR",
        }
    )

    description = cast(str, _product_node(artifact)["description"])

    # 브랜드는 첫 문장에서 소개했으므로 뒤 문장은 상품명만 부른다. 조사(를/을)의
    # 정확성이 이 검사의 요지다.
    assert "수분 에센스를 사용한 고객들은 산뜻한 마무리를 긍정적으로 평가했습니다." in description


def test_korean_webpage_keeps_page_level_usage_coverage_without_copying_the_canonical_howto_step() -> None:
    """WebPage stays narrative while HowTo remains the sole raw procedure source."""

    source_description = "수분 에센스는 건조한 피부에 적합합니다."
    usage = "아침과 저녁에 적당량을 얼굴에 펴 바릅니다."
    product = _product(
        name="수분 에센스",
        brand="예시 랩",
        category="에센스",
        description=source_description,
        usage=[usage],
        sourceTexts=[source_description, usage],
    )
    ledger = create_pdp_geo_evidence_ledger(product, "ko-KR")
    plan = create_conservative_content_plan({"product": product, "locale": "ko-KR", "evidenceLedger": ledger})

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "ko-KR", "contentPlan": plan})
    webpage_description = cast(str, _node(artifact, "WebPage")["description"])
    how_to = _node(artifact, "HowTo")

    assert webpage_description.count(source_description) == 1
    assert "예시 랩의 수분 에센스의 사용 순서도 함께 확인할 수 있습니다." in webpage_description
    assert usage not in webpage_description
    assert "Ceramide를 주요 성분·기술로 포함합니다." in webpage_description
    assert [step["text"] for step in cast(list[dict[str, str]], how_to["step"])] == [usage]


def test_public_review_nodes_omit_nonfinite_boolean_and_out_of_range_ratings() -> None:
    """A valid public review body may remain visible while only its invalid rating field is withheld."""

    bodies = [
        "This serum absorbs quickly and leaves my skin comfortable throughout the day.",
        "The serum feels lightweight and keeps my skin comfortable after application.",
        "This serum layers smoothly and leaves a comfortable finish for daily use.",
    ]
    artifact = generate_pdp_geo_artifacts(
        {
            "product": _product(
                reviews={
                    "items": [
                        {"body": bodies[0], "rating": True},
                        {"body": bodies[1], "rating": 6},
                        {"body": bodies[2], "rating": 4.5},
                    ],
                    "keywords": [],
                }
            ),
            "locale": "en-US",
        }
    )

    reviews = cast(list[dict[str, Any]], _product_node(artifact)["review"])

    assert [review["reviewBody"] for review in reviews] == bodies
    assert [review.get("reviewRating", {}).get("ratingValue") for review in reviews] == [None, None, 4.5]


def test_public_korean_reported_details_render_complete_table_metrics_and_omit_incomplete_rows() -> None:
    """Raw OCR/table rows need a complete structured claim before they become an additional-property sentence."""

    complete_source = "수분량 | 1.3배 | 증가 | 2주 후 | 20명 | 임상 시험"
    incomplete_source = "피부결 | 12% | 개선 | 2주 후"
    product = _product(
        name="수분 세럼",
        brand="예시 랩",
        category="세럼",
        description="수분 세럼은 건조한 피부를 위한 제품입니다.",
        metrics=[complete_source, incomplete_source, "2주 후 수분량이 1.3배로 측정됐습니다."],
        semanticFacts={
            "metricClaims": [
                {
                    "metric": "수분량",
                    "value": "1.3",
                    "unit": "배",
                    "direction": "증가",
                    "timing": "2주 후",
                    "sample": "20명",
                    "method": "임상 시험",
                    "sourceText": complete_source,
                }
            ]
        },
    )

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "ko-KR"})
    reported = _reported_details(artifact)

    assert reported == "2주 후, 20명을 대상으로 한 임상 시험에서 수분량이 1.3배 증가했습니다. 2주 후 수분량이 1.3배로 측정됐습니다."
    assert complete_source not in reported
    assert incomplete_source not in reported


def test_rich_english_reported_details_render_complete_table_metrics_and_omit_incomplete_rows() -> None:
    """The rich English property path applies the same table-source gate as the Korean sparse path."""

    complete_source = "INSTRUMENTAL TEST RESULTS | after 2 weeks | hydration | 20% | increased | 20 users"
    incomplete_source = "INSTRUMENTAL TEST RESULTS | after 2 weeks | radiance | 12% | increased"
    common = {
        "name": "Barrier Serum",
        "ingredients": ["Ceramide", "Niacinamide", "Squalane"],
        "benefits": ["hydration"],
    }
    complete = generate_pdp_geo_artifacts(
        {
            "product": _product(
                **common,
                metrics=[complete_source],
                semanticFacts={
                    "metricClaims": [
                        {
                            "metric": "hydration",
                            "value": "20",
                            "unit": "%",
                            "direction": "increased",
                            "timing": "after 2 weeks",
                            "sample": "20 users",
                            "method": "instrumental test",
                            "sourceText": complete_source,
                        }
                    ]
                },
            ),
            "locale": "en-US",
        }
    )
    incomplete = generate_pdp_geo_artifacts(
        {
            "product": _product(**common, metrics=[incomplete_source]),
            "locale": "en-US",
        }
    )
    ordinary_source = "Instrumental test results after 4 weeks showed hydration improvement."
    ordinary = generate_pdp_geo_artifacts(
        {
            "product": _product(**common, metrics=[ordinary_source]),
            "locale": "en-US",
        }
    )

    assert _reported_details(complete) == (
        "After 2 weeks, Hydration increased by 20% in the instrumental test of 20 users."
    )
    assert _reported_details(incomplete) == ""
    assert _reported_details(ordinary) == ordinary_source


def test_rich_english_reported_details_include_each_structured_source_metric_without_fixture_words() -> None:
    """Rich reports retain valid consumer and clinical evidence from arbitrary product categories."""

    consumer_source = "Consumer test: 90% agreed hair felt softer after 2 weeks."
    clinical_source = "Clinical study found hydration increased 35% after 7 days."
    artifact = generate_pdp_geo_artifacts(
        {
            "product": _product(
                name="Softness Shampoo",
                ingredients=["Panthenol", "Betaine", "Ceramide"],
                benefits=["hair softness", "hydration"],
                metrics=[],
                semanticFacts={
                    "metricClaims": [
                        {
                            "metric": "hair softness",
                            "value": "90",
                            "unit": "%",
                            "timing": "after 2 weeks",
                            "method": "consumer test",
                            "sourceText": consumer_source,
                        },
                        {
                            "metric": "hydration",
                            "value": "35",
                            "unit": "%",
                            "timing": "after 7 days",
                            "method": "clinical study",
                            "sourceText": clinical_source,
                        },
                    ]
                },
            ),
            "locale": "en-US",
        }
    )

    reported = _reported_details(artifact)
    assert consumer_source in reported
    assert clinical_source in reported

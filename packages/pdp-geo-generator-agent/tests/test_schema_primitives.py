from __future__ import annotations

import asyncio
import math
from collections.abc import Mapping
from typing import Any, cast

from pdp_geo_generator_agent.generation import select_schema_images
from pdp_geo_generator_agent.graph_integrity import (
    capture_structured_content_snapshot,
    repair_pdp_schema_graph_integrity,
    synchronize_structured_content_with_graph,
)
from pdp_geo_generator_agent.product_scope import (
    filter_current_product_usage_instructions,
    is_conflicting_product_usage_instruction,
)
from pdp_geo_generator_agent.review_cep import (
    derive_cep_candidates,
    extract_review_situation_signals,
    names_use_situation,
)
from pdp_geo_generator_agent.review_sentiment import (
    is_negative_review_signal_text,
    is_positive_review_body,
    is_positive_review_item,
)
from pdp_geo_generator_agent.schema_graph import (
    create_schema_markup,
    resolve_primary_product_node,
    resolve_product_group_node,
    schema_node_has_type,
)
from pdp_geo_generator_agent.schema_values import (
    gtin_property_name,
    normalize_availability_token,
    normalize_monetary_amount_for_currency,
    normalize_return_method_token,
    sanitize_day_count_value,
    sanitize_gtin_value,
    sanitize_sku_value,
)
from pdp_geo_generator_agent.service import generate_pdp_geo
from pdp_geo_generator_agent.validation import serialize_schema_markup


def _record(value: object) -> dict[str, Any]:
    assert isinstance(value, Mapping)
    return dict(cast(Mapping[str, Any], value))


def _records(value: object) -> list[dict[str, Any]]:
    assert isinstance(value, list)
    items = cast(list[object], value)
    return [_record(item) for item in items]


def _product(**overrides: object) -> dict[str, Any]:
    product: dict[str, Any] = {
        "name": "BarrierCare365 크림",
        "originalName": "BarrierCare 365 Cream",
        "brand": "SAMPLE_DERMA",
        "category": "크림",
        "description": "건조할 때 수시로 사용할 수 있는 보습 크림입니다.",
        "benefits": ["피부장벽 강화"],
        "effects": [],
        "ingredients": ["세라마이드"],
        "usage": [],
        "metrics": [],
        "sourceTexts": [],
        "reviews": {"items": [], "keywords": []},
    }
    product.update(overrides)
    return product


def test_schema_values_normalize_commerce_inputs_fail_closed() -> None:
    """A vague merchant status or invalid check digit must never become public markup."""
    assert normalize_availability_token("일시 품절 (재입고 예정)") == "BackOrder"
    assert normalize_availability_token("currently not available") == "OutOfStock"
    assert normalize_availability_token("special order maybe") is None
    assert sanitize_gtin_value("880-1234-56789-3") == "8801234567893"
    assert sanitize_gtin_value("8801234567890") is None
    assert gtin_property_name("8801234567893") == "gtin13"
    assert sanitize_sku_value(" 11 0770 0524 ") == "1107700524"
    assert sanitize_sku_value("product") is None
    assert normalize_return_method_token("https://schema.org/ReturnByMail") == "ReturnByMail"
    assert sanitize_day_count_value("01") == 1
    assert normalize_monetary_amount_for_currency("21500", 21500, "USD") == 215.0
    assert normalize_monetary_amount_for_currency("21,500원", 21500, "KRW") == 21500


def test_schema_graph_follows_linkage_not_array_order() -> None:
    product = {"@type": "Product", "@id": "https://example.test/p#product", "name": "linked"}
    graph: list[dict[str, object]] = [
        {"@type": "Product", "@id": "https://example.test/p#other", "name": "wrong"},
        {"@type": "ProductGroup", "@id": "https://example.test/p#group"},
        {"@type": ["WebPage", "ItemPage"], "mainEntity": {"@id": product["@id"]}},
        {**product, "isVariantOf": {"@id": "https://example.test/p#group"}},
    ]
    assert schema_node_has_type(graph[2], "WebPage")
    assert resolve_primary_product_node(graph) == graph[3]
    assert resolve_product_group_node(graph) == graph[1]


def test_schema_markup_orders_webpage_first_and_escapes_script_payload() -> None:
    markup = create_schema_markup(
        [
            {"@type": "Product", "name": "<unsafe>"},
            {"@type": ["WebPage", "ItemPage"], "name": "Product page"},
        ]
    )
    markup_graph = _records(markup["graph"])
    script = cast(str, markup["script"])
    assert markup_graph[0]["@type"] == ["WebPage", "ItemPage"]
    assert script.startswith('<script type="application/ld+json">{')
    assert "\\u003cunsafe>" in script


def test_schema_script_tags_use_pinned_node24_pretty_json_stringify() -> None:
    """Both public script boundaries retain JavaScript property and number semantics.

    This literal was captured with Node v24.11.0 ``JSON.stringify(value, null,
    2)`` from the retained generator source baseline (origin/main,
    6702158280ec7de675594af93c7c381eb2feae38).
    """

    graph = [
        {
            "@type": "Product",
            "10": "ten",
            "2": "two",
            "zero": -0.0,
            "nan": math.nan,
            "lone": "x\ud800",
            "integral": 4.0,
            "name": "<unsafe>",
        }
    ]
    expected = '''<script type="application/ld+json">{
  "@context": "https://schema.org",
  "@graph": [
    {
      "2": "two",
      "10": "ten",
      "@type": "Product",
      "zero": 0,
      "nan": null,
      "lone": "x\\ud800",
      "integral": 4,
      "name": "\\u003cunsafe>"
    }
  ]
}</script>'''

    assert create_schema_markup(graph)["script"] == expected
    assert serialize_schema_markup({"@context": "https://schema.org", "@graph": graph})["scriptTag"] == expected


def test_schema_prices_use_number_to_fixed_then_number_for_decimal_and_js_round_for_zero_decimal() -> None:
    """Decimal prices must match ``Number(amount.toFixed(2))`` at binary boundaries."""

    assert {
        value: normalize_monetary_amount_for_currency(f"${value}", value, "USD")
        for value in (1.005, 1.015, 2.675, 10.075)
    } == {1.005: 1, 1.015: 1.01, 2.675: 2.67, 10.075: 10.07}
    assert normalize_monetary_amount_for_currency("¥1.5", 1.5, "JPY") == 2


def test_brand_same_as_uses_a_verified_canonical_brand_origin() -> None:
    """Port the three source-URL fixtures from ``schema-policy-p0.test.ts``.

    A first-party host may ground ``Brand.sameAs`` at its canonical origin;
    a retailer must not become the brand identity, and an explicit caller hint
    remains authoritative.
    """

    product = {
        "name": "Waterfold Cream",
        "brand": "Demo Derma",
        "description": "Barrier cream for dry, sensitive skin.",
        "ingredients": ["Ceramide"],
    }

    def same_as(source_url: str, hints: dict[str, object] | None = None) -> object:
        run = asyncio.run(
            generate_pdp_geo(
                {
                    "product": product,
                    "source": {"type": "pdp-extractor", "url": source_url},
                    "hints": {"locale": "ko-KR", "market": "KR", **(hints or {})},
                }
            )
        )
        graph = _records(run["result"]["schemaMarkup"]["jsonLd"]["@graph"])
        brand = _record(next(node for node in graph if node["@type"] == "Product")["brand"])
        return brand.get("sameAs")

    assert same_as("https://demo-derma.example.test/kr/products/waterfold-toner") == ["https://demo-derma.example.test/"]
    assert same_as("https://marketplace.example.test/products/example-item") is None
    assert same_as(
        "https://demo-derma.example.test/kr/products/waterfold-toner",
        {"brandSameAs": ["https://www.wikidata.org/wiki/Q1"]},
    ) == ["https://www.wikidata.org/wiki/Q1"]


def test_schema_images_prioritize_cited_evidence_and_canonicalize_publishable_urls() -> None:
    """Port ``schema-image-evidence.test.ts`` plus its canonical URL boundary.

    Evidence changes the rank of already eligible gallery images only.  It must
    not make a UI/data/SVG artifact publishable, and the public markup uses a
    stable canonical image URL rather than responsive/transient variants.
    """

    product_name, source_url = "BarrierCare 365 크림", "https://example.com/p/1"
    source_text = "세라마이드 10,000ppm이 피부 장벽을 강화합니다"
    meta_backed = select_schema_images(
        {
            "images": ["https://cdn.example.com/gallery-1.jpg", "https://cdn.example.com/ingredient.png"],
            "sourceTexts": [source_text],
            "sourceTextMeta": {source_text: {"imageUrls": ["https://cdn.example.com/ingredient.png"], "ocrConfidence": 0.9}},
        },
        product_name,
        source_url,
    )
    assert meta_backed == ["https://cdn.example.com/ingredient.png", "https://cdn.example.com/gallery-1.jpg"]

    semantic_backed = select_schema_images(
        {
            "images": ["https://cdn.example.com/gallery-2.jpg", "https://cdn.example.com/clinical.png"],
            "semanticFacts": {
                "metricClaims": [{"sentence": "테스트", "imageUrls": ["https://cdn.example.com/clinical.png"]}],
                "ingredientBenefitLinks": [],
                "citations": [],
            },
        },
        product_name,
        source_url,
    )
    assert semantic_backed == ["https://cdn.example.com/clinical.png", "https://cdn.example.com/gallery-2.jpg"]

    images = ["https://cdn.example.com/gallery-1.jpg", "https://cdn.example.com/ingredient.png"]
    assert select_schema_images({"images": images}, product_name, source_url) == images
    assert select_schema_images({"images": images, "sourceTextMeta": {}}, product_name, source_url) == images

    canonical = select_schema_images(
        {
            "images": [
                "/assets/ingredient.png?width=640&fit=cover&campaign=fall#caption",
                "http://cdn.example.com/gallery.jpg?w=96&format=webp",
                "data:image/png;base64,not-publishable",
                "https://cdn.example.com/logo.svg",
            ],
            "sourceTextMeta": {
                "cited evidence": {"imageUrls": ["/assets/ingredient.png?width=640&fit=cover&campaign=fall"]}
            },
        },
        product_name,
        source_url,
    )
    assert canonical == [
        "https://example.com/assets/ingredient.png?campaign=fall",
        "https://cdn.example.com/gallery.jpg",
    ]


def test_review_sentiment_handles_negated_korean_complaints_and_ratings() -> None:
    """A positive absence phrase must not be rejected as a complaint."""
    assert not is_negative_review_signal_text("끈적임이 적은 마무리")
    assert is_negative_review_signal_text("향이 너무 강해서 불편해요")
    assert is_positive_review_body("세안 후에도 건조하지 않고 자극이나 트러블 없이 촉촉해요")
    assert not is_positive_review_body("아이와 함께 썼는데 자극이 있어서 아쉬웠어요")
    assert not is_positive_review_item({"body": "향은 아쉬워요", "rating": 5})
    assert not is_positive_review_item({"body": "좋아요", "rating": 7})
    for complaint in (
        "I would never buy this product again and regret the purchase.",
        "Terrible product. I hate it.",
        "Poor quality and completely useless.",
        "최악의 제품입니다. 다시는 구매하지 않을 거예요.",
        "돈이 아깝고 품질이 나쁩니다.",
        "이 제품이 정말 싫어요.",
    ):
        assert not is_positive_review_body(complaint)


def test_review_cep_extracts_korean_context_and_pairs_only_official_need() -> None:
    product = _product(
        description="피부 보습을 돕는 크림입니다.",
        reviews={
            "items": [
                {"body": "아이들과 함께 쓰기 좋아요. 향도 순하고 자극이 없어서 계속 쓰고 있습니다."},
                {"body": "아이와 함께 사용하고 있어요. 자극이 적어서 매일 저녁 발라요."},
                {"body": "겨울에 사용하기 좋네요."},
            ],
            "keywords": [],
        },
    )
    signals = extract_review_situation_signals(product, "ko-KR")
    assert signals[0]["key"] == "아이"
    assert signals[0]["support"] == 2
    assert signals[0]["reviewIndexes"] == [0, 1]
    assert names_use_situation("BarrierCare365 크림은 아이들과 함께 사용하기에 적합한가요?", "ko-KR")
    assert not names_use_situation("건조하고 민감한 피부 고객에게 적합한가요?", "ko-KR")
    candidates = derive_cep_candidates({"product": product, "locale": "ko-KR", "needs": ["피부장벽 강화"]})
    assert candidates[0]["need"] == "피부장벽 강화"
    assert candidates[0]["origin"] == "review"


def test_product_scope_removes_foreign_usage_without_losing_current_instruction() -> None:
    product = _product(
        name="BarrierCare 365 Cream",
        category="Cream",
        usage=["Apply BarrierCare 365 Cream to clean skin. Then apply Hydro Essence Toner to damp skin."],
        benefits=["Apply Hydro Essence Toner to damp skin before the next step.", "Supports hydration."],
        sourceTexts=["Apply Hydro Essence Toner to damp skin before the next step."],
    )
    filtered = filter_current_product_usage_instructions(product)
    assert filtered["usage"] == ["Apply BarrierCare 365 Cream to clean skin"]
    assert filtered["benefits"] == ["Supports hydration."]
    assert filtered["sourceTexts"] == []
    assert is_conflicting_product_usage_instruction("Apply Hydro Essence Toner to damp skin.", product)


def test_graph_integrity_prunes_invalid_nodes_and_local_references_in_order() -> None:
    base = "https://example.test/products/barrier-serum"
    graph = [
        {
            "@type": ["WebPage", "ItemPage"],
            "@id": f"{base}#webpage",
            "hasPart": [
                {"@id": f"{base}#faq"},
                {"@id": f"{base}#missing"},
                {"@id": "https://support.example.test/guide#usage"},
            ],
        },
        {"@type": "FAQPage", "@id": f"{base}#faq", "mainEntity": [{"name": "Broken", "acceptedAnswer": {"text": ""}}]},
        {"@type": "Product", "@id": f"{base}#product"},
    ]
    repaired = repair_pdp_schema_graph_integrity(graph, "ko-KR")
    repaired_graph = _records(repaired["graph"])
    repairs = _records(repaired["repairs"])
    assert [node["@type"] for node in repaired_graph] == [["WebPage", "ItemPage"], "Product"]
    assert repaired_graph[0]["inLanguage"] == "ko-KR"
    assert repaired_graph[0]["hasPart"] == [{"@id": "https://support.example.test/guide#usage"}]
    assert [repair["field"] for repair in repairs] == ["FAQPage", "WebPage.inLanguage", "WebPage.hasPart"]
    assert "before" not in repairs[1]
    assert list(repairs[1]) == ["field", "source", "issue", "action", "after", "evidence"]


def test_graph_integrity_rebuilds_visible_faq_and_numbered_howto() -> None:
    graph = [
        {
            "@type": "FAQPage",
            "mainEntity": [{"name": "What does it support?", "acceptedAnswer": {"text": "Hydration."}}],
        },
        {
            "@type": "HowTo",
            "name": "How to use it",
            "step": [
                {"position": 1, "text": "Apply one pump."},
                {"position": 2, "text": "Press until absorbed."},
            ],
        },
    ]
    snapshot = capture_structured_content_snapshot(graph)
    result = synchronize_structured_content_with_graph(
        {"sections": {"faq": "stale", "howToUse": "stale", "productName": "x"}, "graph": graph, "snapshot": snapshot}
    )
    sections = _record(result["sections"])
    repairs = _records(result["repairs"])
    assert sections["faq"] == "Q. What does it support?\nA. Hydration."
    assert sections["howToUse"] == "1. Apply one pump.\n2. Press until absorbed."
    assert [repair["field"] for repair in repairs] == ["content.sections.faq", "content.sections.howToUse"]

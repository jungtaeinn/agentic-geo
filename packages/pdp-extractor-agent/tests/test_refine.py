"""GEO artifact refinement contracts (2 legacy counterparts)."""

from __future__ import annotations

from typing import Any

from pdp_extractor_agent.refinement import refine_geo_product_result

BASE: dict[str, Any] = {
    "source": "https://example.com/products/serum",
    "sourceType": "url",
    "geoProduct": {
        "name": "Ginseng Serum",
        "price": {"raw": "215.00", "amount": 215, "currency": "USD"},
        "description": "A serum with ginseng.",
        "images": [],
        "options": [],
        "benefits": ["radiance"],
        "effects": [],
        "ingredients": ["ginseng"],
        "usage": [],
        "metrics": [],
        "faq": [],
        "reviews": {"rating": 4.8, "reviewCount": 418, "items": [], "keywords": []},
        "ocr": {
            "textBlocks": [],
            "keywords": {
                "product": [],
                "price": [],
                "benefit": ["radiance"],
                "effect": [],
                "ingredient": ["ginseng"],
                "usage": [],
                "faq": [],
                "review": [],
                "metric": [],
                "trend": [],
                "unknown": [],
            },
            "sentenceInsights": [],
        },
        "rag": {"chunks": []},
    },
}


def test_applies_natural_language_metric_and_ingredient_additions_without_evidence_internals() -> None:
    refined = refine_geo_product_result(
        {"result": BASE, "instruction": "metrics에 6 weeks와 100%를 추가하고 성분에 peptide도 넣어줘"}
    )
    assert refined["changes"] == ["metrics", "ingredients"]
    assert refined["result"]["geoProduct"]["metrics"] == ["6 weeks", "100%"]
    assert refined["result"]["geoProduct"]["ingredients"] == ["ginseng", "성분", "peptide", "peptide도 줘"]
    assert refined["result"]["geoProduct"]["ocr"]["keywords"]["metric"] == ["6 weeks", "100%"]
    assert "confidence" not in str(refined["result"]) and "imageUrl" not in str(refined["result"])


def test_refinement_preserves_public_ocr_image_lineage_and_confidence() -> None:
    """The TS JSON clone keeps valid public OCR evidence during an unrelated edit."""

    result = {
        **BASE,
        "geoProduct": {
            **BASE["geoProduct"],
            "sourceExtraction": {
                "ocr": {
                    "imageTexts": [
                        {
                            "imageUrl": "https://img.example.com/claim.png",
                            "imageUrls": ["https://img.example.com/claim.png"],
                            "text": "84% firmness improvement",
                            "confidence": 0.88,
                        }
                    ]
                }
            },
        },
    }
    refined = refine_geo_product_result({"result": result, "instruction": "benefit에 firming 추가"})
    image = refined["result"]["geoProduct"]["sourceExtraction"]["ocr"]["imageTexts"][0]

    assert image["imageUrl"] == "https://img.example.com/claim.png"
    assert image["imageUrls"] == ["https://img.example.com/claim.png"]
    assert image["confidence"] == 0.88


def test_merges_inline_json_geo_product_patch_without_discarding_existing_values() -> None:
    refined = refine_geo_product_result(
        {
            "result": BASE,
            "instruction": '다음 JSON 반영 {"geoProduct":{"benefits":["firming"],"reviews":{"keywords":["repurchase"]}}}',
        }
    )
    product = refined["result"]["geoProduct"]
    assert "firming" in product["benefits"] and "repurchase" in product["reviews"]["keywords"]


def test_refinement_merges_the_full_public_geo_patch_and_returns_the_ui_summary() -> None:
    refined = refine_geo_product_result(
        {
            "result": BASE,
            "instruction": (
                '다음 JSON 반영 {"geoProduct":{"name":"Renewed Serum","description":"A renewed nightly serum.",'
                '"price":{"raw":"$19.50","currency":"USD"},"images":["https://img.test/renewed.png"],'
                '"options":["30ml"],"benefits":["firming"],"effects":["smoothing"],'
                '"ingredients":["peptide"],"usage":["apply nightly"],"metrics":["94%"],'
                '"faq":[{"question":"When?","answer":"Nightly."}],'
                '"reviews":{"rating":4.9,"reviewCount":9,"items":[{"body":"Would repurchase","rating":5}],'
                '"keywords":["repurchase"]},"ocr":{"textBlocks":["Clinical claim"],'
                '"keywords":{"benefit":["firming"],"review":["repurchase"]}},'
                '"rag":{"chunks":[{"id":"manual-1","kind":"source","text":"Manual source"}]}}}'
            ),
        }
    )

    product = refined["result"]["geoProduct"]
    # The legacy refiner intentionally applies its natural-language parser
    # after an inline JSON patch.  This captures its observable field-name
    # token behavior rather than silently improving it in the Python port.
    assert product["name"] == "geoProduct"
    assert product["description"] == "geoProduct"
    assert product["price"] == {"raw": ",", "currency": "USD"}
    assert product["images"] == ["https://img.test/renewed.png"] and product["options"] == ["30ml"]
    assert "firming" in product["benefits"] and "smoothing" in product["effects"]
    assert "peptide" in product["ingredients"] and "apply nightly" in product["usage"]
    assert product["metrics"] == ["94%", "30ml"]
    assert product["faq"] == [{"question": "When?", "answer": "Nightly"}]
    assert product["reviews"]["items"] == [{"body": "Would repurchase", "rating": 5}]
    assert product["reviews"]["rating"] == 4.9 and product["reviews"]["reviewCount"] == 9
    assert "repurchase" in product["reviews"]["keywords"]
    assert product["ocr"]["textBlocks"][:2] == ["Clinical claim", "geoProduct"]
    assert "firming" in product["ocr"]["keywords"]["benefit"]
    assert "repurchase" in product["ocr"]["keywords"]["review"]
    assert product["rag"]["chunks"] == [{"id": "manual-1", "kind": "source", "text": "Manual source"}]
    assert refined["changes"] == [
        "name",
        "description",
        "price",
        "images",
        "options",
        "benefits",
        "effects",
        "ingredients",
        "usage",
        "metrics",
        "faq",
        "reviews",
        "ocr",
        "rag.chunks",
        "reviews.keywords",
        "ocr.textBlocks",
    ]
    assert refined["summary"] == (
        "16개 GEO RAW JSON 필드를 수정했습니다: name, description, price, images, options, benefits, effects, "
        "ingredients, usage, metrics, faq, reviews, ocr, rag.chunks, reviews.keywords, ocr.textBlocks."
    )


def test_refinement_applies_natural_language_name_description_price_and_evidence_categories() -> None:
    cases: list[tuple[str, str, Any]] = [
        ("상품명: 'Night Serum'", "name", "Night Serum"),
        ("설명: 'A nightly serum'", "description", "A nightly serum"),
        ("가격 $19.50", "price", {"raw": "$19.50", "amount": 19.5}),
        ("benefit에 hydration 추가", "benefits", "hydration"),
        ("effect에 improve 추가", "effects", "improve"),
        ("usage에 apply nightly 추가", "usage", "apply"),
        ("review에 repurchase 추가", "reviews.keywords", "repurchase"),
        ('ocr text blocks "Clinical proof"', "ocr.textBlocks", "Clinical proof"),
    ]

    for instruction, field, expected in cases:
        refined = refine_geo_product_result({"result": BASE, "instruction": instruction})
        product = refined["result"]["geoProduct"]
        if field == "name" or field == "description":
            assert product[field] == expected
        elif field == "price":
            assert all(product[field][key] == value for key, value in expected.items())
        elif field == "reviews.keywords":
            assert expected in product["reviews"]["keywords"]
        elif field == "ocr.textBlocks":
            assert expected in product["ocr"]["textBlocks"]
        else:
            assert expected in product[field]
        assert field in refined["changes"]

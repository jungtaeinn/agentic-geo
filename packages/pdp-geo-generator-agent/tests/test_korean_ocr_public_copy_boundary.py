"""Regressions for Korean OCR evidence crossing into public schema copy."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from pdp_geo_generator_agent.generation import generate_pdp_geo_artifacts


def _diagnostic_attributes(artifact: Mapping[str, Any]) -> dict[str, str]:
    """Read the derived attributes that stay out of the published markup.

    Only the keyword attributes a structured-data consumer can act on -- the
    customer, the ingredients, and the efficacy -- are published.  Everything
    else the renderer derived is available here, which is where an audit of
    those facts belongs now that the fields owning them publish them.
    """

    return {
        str(item["field"]).rsplit(".", 1)[-1]: str(item["value"])
        for item in cast(list[dict[str, Any]], artifact["evidence"])
        if str(item["field"]).startswith("diagnostics.productAttribute.")
    }


def _node(artifact: Mapping[str, Any], kind: str) -> dict[str, Any]:
    graph = cast(list[dict[str, Any]], cast(Mapping[str, Any], artifact["schemaMarkup"])["jsonLd"]["@graph"])
    return next(
        item
        for item in graph
        if kind in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]])
    )


def _ocr_mixed_korean_product() -> dict[str, Any]:
    raw_safety_dump = (
        "/ 300 mL 철저히 검증한 피부 안전성 테스트 HYPERSENSITIVE SKIN TESTED 테스트 완료 "
        "SENSITIVE SKIN PANEL TESTED 민감 피부 자극 테스트 완료 DERMATOLOGIST TESTED 피부과 테스트 완료 "
        "ALLERGY TESTED 알러지 테스트 완료 NON-COMEDOGENIC TESTED 여드름성 피부 사용 적합 테스트 완료 "
        "ORIGINAL EXCELLENT 2022 dermatest 독일 더마 테스트 EXCELLENT 등급 2022 EXCELLENT dermatest 독일 더마 테스트 EXCELLENT 등급"
    )
    raw_metric_row = "사용 직후 수분량 1.3배 증가; 사용 전 54.6, 사용 직후 72.8; *피부 수분량 인덱스"
    return {
        "name": "장벽 캡슐 토너",
        "brand": "예시 브랜드",
        "category": "토너",
        "description": "장벽 캡슐 토너는 세안 후 약해진 피부장벽을 강화하고 피부결을 정돈하는 장벽 보습 토너입니다.",
        "ingredients": ["PHA", "PHA 워터", "고밀도 세라마이드 캡슐"],
        "benefits": ["세안 후 약해진 피부장벽과 건조함을 즉시 케어합니다."],
        "effects": [],
        "usage": ["아침과 저녁 세안 후 적당량을 덜어 부드럽게 펴 바릅니다."],
        "metrics": [raw_metric_row],
        "options": ["300 mL"],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [
            "장벽 캡슐 토너는 세안 후 약해진 피부장벽을 강화하고 피부결을 정돈하는 장벽 보습 토너입니다.",
            "건조 피부 또는 민감 피부에 추천됩니다.",
            "여드름성 피부 사용적합 테스트인 논코메도제닉 테스트를 완료했습니다.",
            raw_metric_row,
            raw_safety_dump,
        ],
        "semanticFacts": {
            "skinTypes": ["건조 피부", "민감 피부"],
            "usageSteps": ["아침과 저녁 세안 후 적당량을 덜어 부드럽게 펴 바릅니다."],
            "safetyTests": [
                "HYPERSENSITIVE SKIN TESTED",
                "SENSITIVE SKIN PANEL TESTED",
                "DERMATOLOGIST TESTED",
                "ALLERGY TESTED",
                "NON-COMEDOGENIC TESTED",
            ],
            "metricClaims": [
                {
                    "label": "피부 수분량 인덱스",
                    "subject": "피부 수분량",
                    "value": "1.3",
                    "unit": "배",
                    "direction": "증가",
                    "timing": "사용 직후",
                    "baseline": "사용 전 54.6",
                    "method": "피부 수분량 인덱스",
                    "sourceText": raw_metric_row,
                }
            ],
        },
    }


def _omitted_model_description_plan() -> dict[str, Any]:
    return {
        "mode": "model",
        "productDescription": {"include": False, "text": "", "evidenceIds": [], "confidence": 0, "omitReason": ""},
        "webPageDescription": {"include": False, "text": "", "evidenceIds": [], "confidence": 0, "omitReason": ""},
        "faq": [],
        "howTo": {"eligible": False, "ordered": True, "goal": "", "steps": [], "evidenceIds": [], "confidence": 0, "omitReason": ""},
    }


def test_korean_ocr_page_dump_stays_diagnostic_while_public_copy_uses_atomic_semantic_facts() -> None:
    """A raw OCR test/table block must not become either description or PropertyValue prose.

    This fails if the renderer treats any safety cue in a stitched OCR block as
    permission to publish the entire block, or emits its semicolon table row
    verbatim instead of rendering its structured metric claim.
    """

    artifact = generate_pdp_geo_artifacts(
        {
            "product": _ocr_mixed_korean_product(),
            "locale": "ko-KR",
            "contentPlan": _omitted_model_description_plan(),
        }
    )
    product = _node(artifact, "Product")
    webpage = _node(artifact, "WebPage")
    descriptions = [cast(str, product["description"]), cast(str, webpage["description"])]
    properties = {
        cast(str, property_["name"]): cast(str, property_["value"])
        for property_ in cast(list[dict[str, Any]], product.get("additionalProperty", []))
    }

    for text in descriptions:
        assert "HYPERSENSITIVE SKIN TESTED" not in text
        assert "ORIGINAL EXCELLENT" not in text
        assert "/ 300 mL 철저히 검증한" not in text
        assert "사용 직후 수분량 1.3배 증가;" not in text
        assert "사용 순서도 함께 확인할 수 있습니다" not in text
        assert "예시 브랜드의 장벽 캡슐 토너" in text
        assert "세안 후 약해진 피부장벽과 건조함을 즉시 케어합니다." in text
        assert "건조 피부 또는 민감 피부에 추천됩니다." in text

    diagnostics = _diagnostic_attributes(artifact)
    assert diagnostics["안전성 안내"] == "여드름성 피부 사용적합 테스트인 논코메도제닉 테스트를 완료했습니다."
    assert "HYPERSENSITIVE SKIN TESTED" not in diagnostics["안전성 안내"]
    assert "ORIGINAL EXCELLENT" not in diagnostics["안전성 안내"]
    assert "사용 직후 수분량 1.3배 증가;" not in " ".join([*properties.values(), *diagnostics.values()])
    assert "사용 전 54.6에서 72.8로" in " ".join(descriptions)


def test_korean_additional_properties_keep_distinct_atomic_facts_without_parallel_field_dumps() -> None:
    """Rich Korean Product properties must not restate one fact in three incompatible fields."""

    artifact = generate_pdp_geo_artifacts(
        {
            "product": _ocr_mixed_korean_product(),
            "locale": "ko-KR",
            "contentPlan": _omitted_model_description_plan(),
        }
    )
    product = _node(artifact, "Product")
    webpage = _node(artifact, "WebPage")
    properties = {
        cast(str, property_["name"]): cast(str, property_["value"])
        for property_ in cast(list[dict[str, Any]], product.get("additionalProperty", []))
    }

    diagnostics = _diagnostic_attributes(artifact)
    # A published attribute names a thing a structured-data consumer can act
    # on, and it names it in keywords.  A composed sentence, a measured result,
    # a usage step, and a safety statement each belong to the field that owns
    # them, so they are derived and kept as diagnostics rather than restated
    # under an attribute name.
    assert properties["Target customer"] == "건조 피부 또는 민감 피부 고객"
    assert properties["Key ingredients"] == "PHA, PHA 워터, 고밀도 세라마이드 캡슐"
    assert set(properties) <= {"Target customer", "Key ingredients", "Key benefit", "Key efficacy"}
    assert "Recommended skin type" not in properties
    assert "Key ingredients and technologies" not in properties
    assert "Ingredient/effect detail" not in properties
    assert "Reported details" not in properties
    assert diagnostics["Recommended skin type"] == "건조 피부 또는 민감 피부"
    assert diagnostics["Reported details"] == "사용 직후 피부 수분량 인덱스가 사용 전 54.6에서 72.8로, 1.3배 증가한 것으로 제시됩니다."
    # 개요가 대상 고객을 직접 진술할 때는 커버리지 라벨을 나열하지 않는다.
    # 근거 지표는 라벨이 아니라 측정 문장 자체로 지면에 남는다.
    assert "근거 지표을" not in cast(str, webpage["description"])
    assert "사용 직후 피부 수분량 인덱스가 사용 전 54.6에서 72.8로" in cast(str, webpage["description"])
    assert "바탕으로 제품의 특징을 소개합니다" not in cast(str, webpage["description"])


def test_korean_rich_fallback_prefers_clean_target_and_safety_atoms_over_ocr_labels() -> None:
    """A dense OCR product still renders a readable, non-repetitive Korean narrative.

    The source may contain both a labelled OCR row and a normalized sentence
    for the same audience or safety fact.  The public renderer must choose
    the sentence-shaped atom, retain a source-derived product lead, and avoid
    repeating the primary benefit across parallel PropertyValues.
    """

    product = _ocr_mixed_korean_product()
    product.update(
        {
            "brand": "SAMPLE_DERMA",
            "description": "장벽 캡슐 토너는 세안 후 약해진 피부장벽을 강화하는 장벽 보습 토너",
            "benefits": [
                "세안 후 약해진 피부장벽과 건조함을 즉시 케어합니다.",
                "캡슐로 더 오래 지속되는 토너의 보습력을 제시합니다.",
                "세안 후 첫 단계 민감 건조 피부에 수분을 충전하는 효능을 제시합니다.",
            ],
            "sourceTexts": [
                "장벽 캡슐 토너는 세안 후 약해진 피부장벽을 강화하는 장벽 보습 토너입니다.",
                "건조 피부 또는 민감 피부에 추천되며, 세안 후 약해진 피부장벽과 건조함을 즉시 케어하는 효능을 제시합니다.",
                "여드름성 피부 사용 적합 테스트 완료",
                "여드름성 피부 사용적합 테스트인 논코메도제닉 테스트를 완료했습니다.",
                "사용 직후 수분량 1.3배 증가; 사용 전 54.6, 사용 직후 72.8; *피부 수분량 인덱스",
            ],
        }
    )
    semantic = cast(dict[str, Any], product["semanticFacts"])
    semantic["evidenceSentences"] = [
        "장벽 캡슐 토너는 세안 후 약해진 피부장벽을 강화하는 장벽 보습 토너입니다.",
        "건조 피부 또는 민감 피부에 추천됩니다.",
        "세안 후 약해진 피부장벽과 건조함을 즉시 케어합니다.",
    ]
    semantic["benefits"] = [
        "세안 후 약해진 피부장벽과 건조함 즉시 케어",
        "캡슐로 더 오래 지속되는 토너의 보습력",
        "세안 후 첫 단계 민감 건조 피부 수분 충전",
    ]

    artifact = generate_pdp_geo_artifacts(
        {
            "product": product,
            "locale": "ko-KR",
            "contentPlan": _omitted_model_description_plan(),
        }
    )
    product_node = _node(artifact, "Product")
    webpage = _node(artifact, "WebPage")
    descriptions = [cast(str, product_node["description"]), cast(str, webpage["description"])]
    properties = {
        cast(str, property_["name"]): cast(str, property_["value"])
        for property_ in cast(list[dict[str, Any]], product_node.get("additionalProperty", []))
    }

    for description in descriptions:
        assert "SAMPLE_DERMA의 장벽 캡슐 토너" in description
        assert "장벽 보습 토너입니다." in description
        assert "건조 피부 또는 민감 피부에 추천됩니다." in description
        assert "추천되며, 세안 후 약해진 피부장벽" not in description
        assert "여드름성 피부 사용 적합 테스트 완료" not in description

    # 성분 문장의 주어는 제품이다. 처소 주어(``…에는``)는 지면이 무엇을 적어
    # 두었는지를 말하고, 주제 주어는 제품이 무엇을 품었는지를 말한다.  브랜드는
    # 앞 문장에서 이미 소개했으므로 여기서는 상품명만 부른다.
    assert "장벽 캡슐 토너는 PHA, PHA 워터, 고밀도 세라마이드 캡슐 등을 주요 성분·기술로 함유하고 있습니다." in descriptions[0]
    assert "장벽 캡슐 토너에는 PHA" not in descriptions[0]
    # A buyer weighing a product for sensitive skin decides on the completed
    # tests, so the clean statement is published in the description that owns
    # it -- the product's own voice, not the page reporting about the product.
    # The raw OCR label stays out of both descriptions, asserted above.
    assert "여드름성 피부 사용적합 테스트인 논코메도제닉 테스트를 완료했습니다." in descriptions[0]
    assert "논코메도제닉" not in descriptions[1]
    assert _diagnostic_attributes(artifact)["안전성 안내"] == (
        "여드름성 피부 사용적합 테스트인 논코메도제닉 테스트를 완료했습니다."
    )
    assert properties["Key benefit"] == "세안 후 약해진 피부장벽과 건조함 즉시 케어"
    assert properties["Key efficacy"] == "캡슐로 더 오래 지속되는 토너의 보습력, 세안 후 첫 단계 민감 건조 피부 수분 충전"

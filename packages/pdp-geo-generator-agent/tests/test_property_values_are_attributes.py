"""additionalProperty carries attribute values, not sentences and not duplicates.

The atom lists the renderer reads hold whole sentences, benefits, audiences and
measured figures alongside real atoms.  A property value built from them becomes
a paragraph, and two properties fed from one source become byte-identical.  An
attribute value names a thing: it is not an assertion, not prose, and not a
reported figure.
"""

from __future__ import annotations

from typing import Any

import pytest

from pdp_geo_generator_agent.generation import _attribute_atoms, _rich_additional_properties

_NAMING = ["Essential Care Activating Serum VI", "BarrierCare365 Cleansing Foam 200g"]

_MIXED: dict[str, list[str]] = {
    "ko-KR": [
        "피부 장벽 보호",
        "가벼운 메이크업 세정",
        "BarrierCare365 클렌징 폼은 아미노산 유래 세정 성분을 담은 약산성 포뮬라로, 일상 속 노폐물을 말끔하게 세정하도록 설계된 데일리 클렌저입니다.",
        "97.1%",
    ],
    "en-US": [
        "skin barrier protection",
        "lightweight makeup cleansing",
        "The stated benefits of Essential Care Activating Serum VI from SampleBotanics include a lightweight, "
        "fast-absorbing formula designed to prevent visible signs of aging over time.",
        "+5.9%",
    ],
}


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_prose_and_reported_figures_are_not_attribute_values(locale: str) -> None:
    atoms = _attribute_atoms(_MIXED[locale], _NAMING)

    assert atoms == _MIXED[locale][:2]


def test_a_products_own_name_digits_remain_attribute_values() -> None:
    """이름이 지닌 숫자는 측정치가 아니므로 속성값으로 남는다."""

    assert _attribute_atoms(["BarrierCare365 Cleansing Foam 200g"], _NAMING) == [
        "BarrierCare365 Cleansing Foam 200g"
    ]


def _product() -> dict[str, Any]:
    review = "와 SampleDerma 클렌징 온가족용으로 정말 좋습니다. 순하고 촉촉해서 겨울철에 특히 만족 할 듯 합니다."
    return {
        "name": "SampleDerma BarrierCare365 클렌징폼 200g",
        "brand": "SAMPLE_DERMA",
        "description": "건조 피부 또는 민감 피부를 위한 약산성 데일리 클렌저입니다.",
        "benefits": ["일상 속 노폐물 세정", "피부 장벽 보호"],
        "effects": ["피부 장벽 개선"],
        "ingredients": ["판테놀", "베타인"],
        "reviews": {"items": [{"body": review, "rating": 5}], "keywords": ["촉촉해서"]},
        "semanticFacts": {"ingredients": ["판테놀", "베타인"], "benefits": ["일상 속 노폐물 세정"]},
    }


def test_no_two_properties_publish_the_same_value() -> None:
    """한 산출물에서 두 속성이 같은 문자열이면 결함이다."""

    props = _rich_additional_properties(_product(), ["젖은 손에 거품을 내어 세안합니다"], "ko-KR")
    values = [property_["value"] for property_ in props]

    assert len(values) == len(set(values))


def test_a_review_paragraph_is_not_published_as_a_texture_attribute() -> None:
    """리뷰 문단은 `Customer review signal`의 것이지 속성어가 아니다."""

    props = _rich_additional_properties(_product(), ["젖은 손에 거품을 내어 세안합니다"], "ko-KR")
    by_name = {property_["name"]: property_["value"] for property_ in props}

    assert "순하고 촉촉해서" not in by_name.get("Texture and finish", "")

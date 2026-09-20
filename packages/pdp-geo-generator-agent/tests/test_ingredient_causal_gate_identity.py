"""The ingredient-benefit causal gate reads only ledger-confirmed ingredient atoms.

Extraction leaks benefits, audiences, modifiers and whole sentences into the
ingredient lists.  The gate must survive that pollution without demanding an
ingredient-benefit link for something that was never an ingredient, while still
rejecting a benefit attached to a declared ingredient the ledger never linked.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from pdp_geo_generator_agent.copy_refiner import refine_pdp_geo_copy

_RELATION_WARNING = "ingredient-to-benefit relation"

_LEDGERS: dict[str, dict[str, Any]] = {
    "ko-KR": {
        "name": "BarrierCare365 클렌징폼",
        "identity": "BarrierCare365 클렌징폼은 건조하고 민감한 피부를 위한 데일리 클렌저입니다.",
        "ingredients": ["아미노산 유래 세정 성분", "판테놀", "더마온", "세라마이드", "콜레스테롤"],
        "benefits": ["피부 장벽 보호", "세안 중 발생하는 장벽 손상 감소", "건조하고 민감한 피부 보습"],
        "effects": ["피부 장벽 개선"],
        "skinTypes": ["건조 피부", "민감 피부"],
        # 추출이 성분 목록에 흘려 넣은 것들: 효능, 대상, 수식어, 문장 통째.
        "pollution": [
            "피부 장벽 보호",
            "건조하고 민감한 피부",
            "비타민 B5 유도체",
            "세안 중에도 피부를 보호해주는 포뮬라에는 판테놀, 베타인, 더마온의 3종 장벽 보호 성분이 함유되어 있습니다.",
        ],
        "links": [
            {
                "ingredient": "아미노산 유래 세정 포뮬라",
                "benefit": "세안 중 발생하는 장벽 손상 감소",
                "sentence": "아미노산 유래 세정 포뮬라는 세안 중 발생하는 장벽 손상을 줄이도록 돕습니다.",
            },
            {
                "ingredient": "더마온",
                "benefit": "건조하고 민감한 피부 보습",
                "sentence": (
                    "더마온 캡슐 속 세라마이드, 지방산, 콜레스테롤로 구성된 피부 장벽 핵심 성분이 "
                    "건조하고 민감한 피부에 효과적인 보습을 전달합니다."
                ),
            },
        ],
        "cases": {
            "leaked benefit": "피부 장벽 보호를 돕는 데일리 클렌저입니다.",
            "notation variant": "아미노산 유래 세정 성분이 세안 중 발생하는 장벽 손상을 줄이도록 돕습니다.",
            "linked constituent": (
                "더마온 캡슐 속 세라마이드, 지방산, 콜레스테롤이 건조하고 민감한 피부에 보습을 전달합니다."
            ),
        },
        "unlinked": "판테놀이 피부 장벽을 개선합니다.",
    },
    "en-US": {
        "name": "BarrierCare365 Cleansing Foam",
        "identity": "BarrierCare365 Cleansing Foam is a daily cleanser for dry and sensitive skin.",
        "ingredients": ["amino acid derived cleansing ingredient", "Panthenol", "Dermaon", "Ceramide", "Cholesterol"],
        "benefits": [
            "skin barrier protection",
            "reduced barrier damage during cleansing",
            "moisture for dry and sensitive skin",
        ],
        "effects": ["skin barrier improvement"],
        "skinTypes": ["dry skin", "sensitive skin"],
        "pollution": [
            "skin barrier protection",
            "dry and sensitive skin",
            "vitamin B5 derivative",
            "The barrier protective formula that shields skin during cleansing contains Panthenol, Betaine and Dermaon.",
        ],
        "links": [
            {
                "ingredient": "amino acid derived cleansing formula",
                "benefit": "reduced barrier damage during cleansing",
                "sentence": "The amino acid derived cleansing formula helps reduce barrier damage during cleansing.",
            },
            {
                "ingredient": "Dermaon",
                "benefit": "moisture for dry and sensitive skin",
                "sentence": (
                    "Dermaon capsules are built from Ceramide, fatty acid and Cholesterol, a core skin barrier "
                    "complex that delivers effective moisture to dry and sensitive skin."
                ),
            },
        ],
        "cases": {
            "leaked benefit": "Skin barrier protection helps reduce barrier damage during cleansing.",
            "notation variant": (
                "The amino acid derived cleansing ingredient helps reduce barrier damage during cleansing."
            ),
            "linked constituent": "Ceramide, fatty acid and Cholesterol deliver moisture to dry and sensitive skin.",
        },
        "unlinked": "Panthenol improves the skin barrier.",
    },
}


def _payload(locale: str) -> dict[str, Any]:
    ledger = _LEDGERS[locale]
    description = f"{ledger['identity']} {ledger['links'][0]['sentence']}"
    source_texts = [ledger["identity"], *(link["sentence"] for link in ledger["links"])]
    graph = [
        {"@type": ["WebPage", "ItemPage"], "description": description},
        {"@type": "Product", "name": ledger["name"], "description": description},
    ]
    return {
        "product": {
            "name": ledger["name"],
            "description": description,
            "ingredients": ledger["ingredients"],
            "benefits": ledger["benefits"],
            "effects": ledger["effects"],
            "sourceTexts": source_texts,
            "semanticFacts": {
                "ingredients": [*ledger["ingredients"], *ledger["pollution"]],
                "benefits": ledger["benefits"],
                "effects": ledger["effects"],
                "skinTypes": ledger["skinTypes"],
                "evidenceSentences": source_texts,
                "ingredientBenefitLinks": ledger["links"],
            },
        },
        "locale": locale,
        "schemaMarkup": {"jsonLd": {"@context": "https://schema.org", "@graph": graph}},
        "content": {"html": "", "sections": {"productName": ledger["name"], "description": description}},
    }


def _refine_description(locale: str, sentence: str) -> tuple[str, str, list[str]]:
    payload = _payload(locale)
    refined = f"{_LEDGERS[locale]['identity']} {sentence}"

    class DescriptionRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "schemaDescriptions": {"product": refined, "webPage": refined},
                "contentSections": {"description": refined},
            }

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": DescriptionRefiner()}))
    graph = result["schemaMarkup"]["jsonLd"]["@graph"]
    product = next(node for node in graph if node["@type"] == "Product")
    return refined, product["description"], [w for w in result["warnings"] if _RELATION_WARNING in w]


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
@pytest.mark.parametrize("case", ["leaked benefit", "notation variant", "linked constituent"])
def test_causal_gate_keeps_copy_when_the_ingredient_side_is_ledger_confirmed(locale: str, case: str) -> None:
    refined, adopted, warnings = _refine_description(locale, _LEDGERS[locale]["cases"][case])

    assert warnings == []
    assert adopted == refined


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_causal_gate_still_rejects_a_benefit_attached_to_an_unlinked_ingredient(locale: str) -> None:
    refined, adopted, warnings = _refine_description(locale, _LEDGERS[locale]["unlinked"])

    assert warnings
    assert adopted != refined


# --- 경계: 이름이 다른 이름의 조각일 때 -------------------------------------

_BOUNDARY: dict[str, dict[str, Any]] = {
    "ko-KR": {
        "name": "BarrierCare365 클렌징폼",
        "identity": "BarrierCare365 클렌징폼은 데일리 클렌저입니다.",
        # 추출이 효능을 `[성분명][효능]`으로 붙여 내보낸 모양. 판테놀에는 링크가 없다.
        "prefixed outcome": {
            "ingredients": ["판테놀"],
            "effects": ["판테놀 피부장벽강화"],
            "claim": "판테놀이 피부 장벽을 강화합니다.",
        },
        # 베타에는 링크가 없고, 링크를 가진 것은 그것을 품은 다른 이름(베타인)이다.
        "linked sibling name": {
            "ingredients": ["베타", "베타인"],
            "links": [
                {
                    "ingredient": "베타인",
                    "benefit": "보습",
                    "sentence": "베타인은 피부에 보습을 전달합니다.",
                }
            ],
            "claim": "베타가 피부에 보습을 전달합니다.",
        },
        # 베타에는 링크가 없고, 더마온 링크의 근거 문장은 다른 이름(베타인)을 부른다.
        "fragment name": {
            "ingredients": ["베타", "더마온"],
            "links": [
                {
                    "ingredient": "더마온",
                    "benefit": "보습",
                    "sentence": "더마온은 세라마이드와 베타인으로 구성되어 피부에 보습을 전달합니다.",
                }
            ],
            "claim": "베타가 피부에 보습을 전달합니다.",
        },
    },
    "en-US": {
        "name": "BarrierCare365 Cleansing Foam",
        "identity": "BarrierCare365 Cleansing Foam is a daily cleanser.",
        "prefixed outcome": {
            "ingredients": ["Panthenol"],
            "effects": ["Panthenol skin barrier strengthening"],
            "claim": "Panthenol strengthens the skin barrier effectively.",
        },
        "linked sibling name": {
            "ingredients": ["Beta", "Betaine"],
            "links": [
                {
                    "ingredient": "Betaine",
                    "benefit": "moisture",
                    "sentence": "Betaine delivers moisture to skin.",
                }
            ],
            "claim": "Beta delivers moisture to skin.",
        },
        "fragment name": {
            "ingredients": ["Beta", "Dermaon"],
            "links": [
                {
                    "ingredient": "Dermaon",
                    "benefit": "moisture",
                    "sentence": "Dermaon is built from Ceramide and Betaine and delivers moisture to skin.",
                }
            ],
            "claim": "Beta delivers moisture to skin.",
        },
    },
}


def _boundary_warnings(locale: str, case: str) -> list[str]:
    boundary = _BOUNDARY[locale]
    ledger = boundary[case]
    identity = boundary["identity"]
    description = f"{identity} {ledger['claim']}"
    graph = [
        {"@type": ["WebPage", "ItemPage"], "description": identity},
        {"@type": "Product", "name": boundary["name"], "description": identity},
    ]
    payload = {
        "product": {
            "name": boundary["name"],
            "description": identity,
            "ingredients": ledger["ingredients"],
            "effects": ledger.get("effects", []),
            "sourceTexts": [identity, *(link["sentence"] for link in ledger.get("links", []))],
            "semanticFacts": {
                "ingredients": ledger["ingredients"],
                "effects": ledger.get("effects", []),
                "ingredientBenefitLinks": ledger.get("links", []),
            },
        },
        "locale": locale,
        "schemaMarkup": {"jsonLd": {"@context": "https://schema.org", "@graph": graph}},
        "content": {"html": "", "sections": {"productName": boundary["name"], "description": identity}},
    }

    class Refiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return {
                "schemaDescriptions": {"product": description, "webPage": description},
                "contentSections": {"description": description},
            }

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))
    return [warning for warning in result["warnings"] if _RELATION_WARNING in warning]


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_an_outcome_entry_that_merely_starts_with_an_ingredient_name_does_not_excuse_it(locale: str) -> None:
    """`[성분명][효능]`으로 붙어 나온 효능은 그 성분을 인과 검사에서 빼주지 않는다."""

    assert _boundary_warnings(locale, "prefixed outcome")


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_an_ingredient_that_is_only_a_fragment_of_a_linked_name_borrows_no_support(locale: str) -> None:
    """근거 문장이 부른 것은 더 긴 다른 이름이다. 그 조각은 링크를 빌릴 수 없다."""

    assert _boundary_warnings(locale, "fragment name")


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_a_link_belongs_to_the_name_it_states_not_to_a_name_inside_it(locale: str) -> None:
    """링크가 가진 이름은 `베타인`이다. 그것을 품은 `베타`가 그 링크를 가져갈 수 없다."""

    assert _boundary_warnings(locale, "linked sibling name")

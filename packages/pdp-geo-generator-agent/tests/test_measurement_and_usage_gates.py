"""The refinement gates bind claims, not token counts.

A product's own registered name carries digits that identify it; repeating that
name a different number of times changes no measurement.  A usage instruction is
recognised by its grammar, not by a vocabulary of verbs.  What must still be
refused is a measurement the approved copy published and the refinement lost, a
measurement the product's evidence never published, a volume the product is not
sold in, and copy that stops directing the reader.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from pdp_geo_generator_agent.copy_refiner import refine_pdp_geo_copy

_LEDGERS: dict[str, dict[str, Any]] = {
    "ko-KR": {
        "name": "SampleDerma BarrierCare365 클렌징폼 200g",
        "brand": "SAMPLE_DERMA",
        "identity": "SampleDerma BarrierCare365 클렌징폼은 건조 피부 또는 민감 피부를 위한 약산성 데일리 클렌저입니다.",
        "plain": "이 제품은 일상 속 노폐물과 가벼운 메이크업을 세정하도록 안내합니다.",
        "repeat": "SampleDerma BarrierCare365 클렌징폼은 일상 속 노폐물과 가벼운 메이크업을 세정하도록 안내합니다.",
        "measured": "색조 메이크업 세정력은 97.1%, 모공 속 노폐물 세정력은 97.6%로 제시됩니다.",
        "signed": "세정력은 +5.9% 개선으로 제시됩니다.",
        "unsigned rewrite": "세정력은 5.9% 개선된 것으로 제시됩니다.",
        "reversed sign": "세정력은 -5.9% 변화로 제시됩니다.",
        "invented": "색조 메이크업 세정력은 98.1%로 제시됩니다.",
        "metrics": [
            "색조 메이크업 세정력은 97.1%, 모공 속 노폐물 세정력은 97.6%로 제시되며, "
            "만 20~39세 성인 여성 30명을 대상으로 시험한 결과입니다.",
            "97.1%",
            "97.6%",
            "세정력 +5.9% 개선",
        ],
        "own volume": "SampleDerma BarrierCare365 클렌징폼 200g 제품으로 안내됩니다.",
        "foreign volume": "이 제품은 50ml 용기로도 제공된다고 안내됩니다.",
        "usage base": "클렌징 단계에서 젖은 손에 적당량을 덜어 충분히 거품을 내주세요; 얼굴에 부드럽게 롤링하여 노폐물을 녹여낸 후 미온수로 깨끗이 씻어줍니다",
        "usage reworded": "클렌징 단계에서 젖은 손에 적당량을 덜어 충분히 거품을 냅니다. 얼굴에 부드럽게 롤링하여 노폐물을 녹여낸 후 미온수로 깨끗이 씻어냅니다.",
        "usage without action": "건조 피부 또는 민감 피부를 위한 약산성 데일리 클렌저입니다.",
    },
    "en-US": {
        "name": "BarrierCare365 Cleansing Foam 200g",
        "brand": "SAMPLE_DERMA",
        "identity": "BarrierCare365 Cleansing Foam is a low-pH daily cleanser for dry or sensitive skin.",
        "plain": "The product is described as cleansing daily residue and light makeup.",
        "repeat": "BarrierCare365 Cleansing Foam is described as cleansing daily residue and light makeup.",
        "measured": "Makeup cleansing power is presented as 97.1% and pore residue cleansing power as 97.6%.",
        "signed": "Testing showed a +5.9% improvement in cleansing power.",
        "unsigned rewrite": "Testing showed cleansing power improved by 5.9%.",
        "reversed sign": "Testing showed cleansing power changed by -5.9%.",
        "invented": "Makeup cleansing power is presented as 98.1%.",
        "metrics": [
            "Makeup cleansing power is presented as 97.1% and pore residue cleansing power as 97.6%, "
            "measured on 30 women aged 20 to 39.",
            "97.1%",
            "97.6%",
            "cleansing power +5.9% improvement",
        ],
        "own volume": "BarrierCare365 Cleansing Foam 200g is described as a daily cleanser.",
        "foreign volume": "The product is described as also offered in a 50ml container.",
        "usage base": "Dispense an appropriate amount onto wet hands and lather; massage gently over the face, then rinse with lukewarm water",
        "usage reworded": "Take an appropriate amount onto wet hands and work into a lather. Roll gently over the face and wash off with lukewarm water.",
        "usage without action": "A low-pH daily foam for dry or sensitive skin.",
    },
}


def _payload(locale: str, description: str, usage: str) -> dict[str, Any]:
    ledger = _LEDGERS[locale]
    corpus = [
        ledger["identity"],
        ledger["plain"],
        ledger["repeat"],
        ledger["measured"],
        ledger["signed"],
        ledger["unsigned rewrite"],
        ledger["reversed sign"],
        ledger["own volume"],
        ledger["foreign volume"],
        ledger["usage base"],
        ledger["usage reworded"],
        ledger["usage without action"],
        usage,
        *ledger["metrics"],
    ]
    graph = [
        {"@type": ["WebPage", "ItemPage"], "description": description},
        {
            "@type": "Product",
            "name": ledger["name"],
            "description": description,
            "additionalProperty": [{"@type": "PropertyValue", "name": "Usage", "value": usage}],
        },
    ]
    return {
        "product": {
            "name": ledger["name"],
            "originalName": ledger["name"],
            "brand": ledger["brand"],
            "description": description,
            "metrics": ledger["metrics"],
            "usage": [usage],
            "sourceTexts": corpus,
        },
        "locale": locale,
        "schemaMarkup": {"jsonLd": {"@context": "https://schema.org", "@graph": graph}},
        "content": {"html": "", "sections": {"productName": ledger["name"], "description": description}},
    }


def _refine(locale: str, *, base: str, refined: str, field: str = "description") -> list[str]:
    ledger = _LEDGERS[locale]
    if field == "description":
        payload = _payload(locale, base, ledger["usage base"])
        response: dict[str, Any] = {
            "schemaDescriptions": {"product": refined, "webPage": refined},
            "contentSections": {"description": refined},
        }
    else:
        payload = _payload(locale, ledger["identity"], base)
        response = {"schemaProperties": {"Usage": refined}}

    class Refiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            return response

    result = asyncio.run(refine_pdp_geo_copy(payload, {"customCopyRefiner": Refiner()}))
    return list(result["warnings"])


def _reasons(warnings: list[str], needle: str) -> list[str]:
    return [warning for warning in warnings if needle in warning]


# --- ① 측정 주장을 구속한다 (토큰 수가 아니라) -------------------------------


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_repeating_the_product_name_is_not_dropping_a_measurement(locale: str) -> None:
    ledger = _LEDGERS[locale]
    warnings = _refine(
        locale,
        base=f"{ledger['identity']} {ledger['repeat']}",
        refined=f"{ledger['identity']} {ledger['plain']}",
    )

    assert _reasons(warnings, "drops a published measurement") == []


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_adding_a_published_measurement_is_not_dropping_one(locale: str) -> None:
    ledger = _LEDGERS[locale]
    warnings = _refine(
        locale,
        base=f"{ledger['identity']} {ledger['plain']}",
        refined=f"{ledger['identity']} {ledger['plain']} {ledger['measured']}",
    )

    assert _reasons(warnings, "drops a published measurement") == []


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_losing_a_measurement_the_approved_copy_published_is_still_refused(locale: str) -> None:
    ledger = _LEDGERS[locale]
    warnings = _refine(
        locale,
        base=f"{ledger['identity']} {ledger['measured']}",
        refined=f"{ledger['identity']} {ledger['plain']}",
    )

    assert _reasons(warnings, "drops a published measurement")


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_stating_a_measurement_the_evidence_never_published_is_refused(locale: str) -> None:
    ledger = _LEDGERS[locale]
    warnings = _refine(
        locale,
        base=f"{ledger['identity']} {ledger['plain']}",
        refined=f"{ledger['identity']} {ledger['invented']}",
    )

    assert _reasons(warnings, "measurement the product evidence does not publish")


# --- ② 제 이름의 용량 표기 ---------------------------------------------------


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_the_products_own_registered_volume_is_not_a_raw_volume_string(locale: str) -> None:
    ledger = _LEDGERS[locale]
    warnings = _refine(
        locale,
        base=f"{ledger['identity']} {ledger['plain']}",
        refined=f"{ledger['identity']} {ledger['own volume']}",
    )

    assert _reasons(warnings, "raw volume string") == []


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_a_volume_the_product_is_not_sold_in_is_still_refused(locale: str) -> None:
    ledger = _LEDGERS[locale]
    warnings = _refine(
        locale,
        base=f"{ledger['identity']} {ledger['plain']}",
        refined=f"{ledger['identity']} {ledger['foreign volume']}",
    )

    assert _reasons(warnings, "raw volume string")


# --- ③ 사용법은 문법으로 읽는다 ----------------------------------------------


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_rewording_a_usage_instruction_keeps_its_usage_action(locale: str) -> None:
    ledger = _LEDGERS[locale]
    warnings = _refine(locale, base=ledger["usage base"], refined=ledger["usage reworded"], field="Usage")

    assert _reasons(warnings, "no longer contains a usage action") == []


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_usage_copy_that_stops_directing_the_reader_is_still_refused(locale: str) -> None:
    ledger = _LEDGERS[locale]
    warnings = _refine(locale, base=ledger["usage base"], refined=ledger["usage without action"], field="Usage")

    assert _reasons(warnings, "no longer contains a usage action")


# --- ①'' 같은 측정치를 부호 표기로 다르게 세지 않는다 ------------------------


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_moving_a_measurements_direction_from_the_sign_into_the_verb_keeps_it(locale: str) -> None:
    """`+5.9%` -> `improved by 5.9%`는 평범한 리라이트이지 측정치 누락이 아니다."""
    ledger = _LEDGERS[locale]
    warnings = _refine(
        locale,
        base=f"{ledger['identity']} {ledger['signed']}",
        refined=f"{ledger['identity']} {ledger['unsigned rewrite']}",
    )

    assert _reasons(warnings, "drops a published measurement") == []
    assert _reasons(warnings, "measurement the product evidence does not publish") == []


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_reversing_a_measurements_direction_is_not_the_same_measurement(locale: str) -> None:
    """부호를 뒤집는 것은 표기 차이가 아니라 다른 주장이다."""
    ledger = _LEDGERS[locale]
    warnings = _refine(
        locale,
        base=f"{ledger['identity']} {ledger['signed']}",
        refined=f"{ledger['identity']} {ledger['reversed sign']}",
    )

    assert _reasons(warnings, "drops a published measurement")

"""A failure must not be filed as a content decision.

The refinement boundary turns one field's trouble into a warning so the rest of
the pipeline still runs.  That is right, but it also used to absorb quota
failures and bugs in this code, so a run where the model was never reached read
exactly like a run where every proposal was refused.  Diagnostics must answer
whether the model actually ran, and a defect in this code must surface.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from pdp_geo_generator_agent.copy_refiner import refine_pdp_geo_copy
from pdp_geo_generator_agent.providers.transport import ProviderTransportError

_IDENTITY = {
    "ko-KR": ("BarrierCare365 클렌징폼", "BarrierCare365 클렌징폼은 데일리 클렌저입니다."),
    "en-US": ("BarrierCare365 Cleansing Foam", "BarrierCare365 Cleansing Foam is a daily cleanser."),
}


def _payload(locale: str) -> dict[str, Any]:
    name, description = _IDENTITY[locale]
    graph = [
        {"@type": ["WebPage", "ItemPage"], "description": description},
        {"@type": "Product", "name": name, "description": description},
    ]
    return {
        "product": {"name": name, "description": description, "sourceTexts": [description]},
        "locale": locale,
        "schemaMarkup": {"jsonLd": {"@context": "https://schema.org", "@graph": graph}},
        "content": {"html": "", "sections": {"productName": name, "description": description}},
    }


def _refine_with(locale: str, refiner: object) -> dict[str, Any]:
    return asyncio.run(refine_pdp_geo_copy(_payload(locale), {"customCopyRefiner": refiner}))


class _RaisingRefiner:
    def __init__(self, error: BaseException) -> None:
        self.error = error

    def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
        raise self.error


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_a_quota_failure_is_reported_as_the_model_being_unavailable(locale: str) -> None:
    """403(AE901)이 "모델 문구 거부 0건"으로 위장되면 측정 전체가 무의미해진다."""

    quota = ProviderTransportError("copy refinement failed: 403 Project LLM quota exceeded (AE901)")
    result = _refine_with(locale, _RaisingRefiner(quota))

    assert result["modelCall"] == {"called": True, "outcome": "unavailable"}
    assert any(item["field"] == "copy.refinement.unavailable" for item in result["evidence"])
    assert result["applied"] is False


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_a_quota_failure_is_not_filed_as_a_copy_rejection(locale: str) -> None:
    """전송 실패는 게이트가 문구를 물리친 것과 같은 통에 담기면 안 된다."""

    quota = ProviderTransportError("copy refinement failed: 403 Project LLM quota exceeded (AE901)")
    result = _refine_with(locale, _RaisingRefiner(quota))

    assert result["rejections"] == []
    assert not any("refinement rejected" in str(item.get("value")) for item in result["evidence"])


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_a_defect_in_this_code_surfaces_instead_of_becoming_a_warning(locale: str) -> None:
    """NameError·AttributeError 따위는 콘텐츠 판정이 아니라 버그다."""

    with pytest.raises(AttributeError):
        _refine_with(locale, _RaisingRefiner(AttributeError("'NoneType' object has no attribute 'get'")))

    with pytest.raises(NameError):
        _refine_with(locale, _RaisingRefiner(NameError("name 'is_korean_complete_sentence' is not defined")))


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_a_refiner_that_breaks_its_contract_is_unavailable_not_a_defect(locale: str) -> None:
    """계약을 어긴 응답은 버그가 아니라 "쓸 수 있는 출력이 없음"이다."""

    class NotAMapping:
        def refine_copy(self, _request: dict[str, object]) -> object:
            return "not a mapping"

    result = _refine_with(locale, NotAMapping())

    assert result["modelCall"] == {"called": True, "outcome": "unavailable"}

    class NoMethod:
        pass

    assert _refine_with(locale, NoMethod())["modelCall"] == {"called": True, "outcome": "unavailable"}


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_a_refusal_of_model_copy_is_still_a_rejection_not_a_failure(locale: str) -> None:
    """게이트가 문구를 물리치는 것은 지금처럼 도메인 판정으로 남는다."""

    identity = _IDENTITY[locale][1]

    class RejectedRefiner:
        def refine_copy(self, _request: dict[str, object]) -> dict[str, object]:
            invented = f"{identity} It cleanses 98.1% of residue."
            return {
                "schemaDescriptions": {"product": invented, "webPage": invented},
                "contentSections": {"description": invented},
            }

    result = _refine_with(locale, RejectedRefiner())

    assert result["modelCall"] == {"called": True, "outcome": "rejected"}
    assert result["rejections"]
    assert not any(item["field"] == "copy.refinement.unavailable" for item in result["evidence"])


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_no_refiner_at_all_is_reported_as_the_model_not_being_called(locale: str) -> None:
    result = asyncio.run(refine_pdp_geo_copy(_payload(locale), {"copyRefinement": {"enabled": False}}))

    assert result["modelCall"] == {"called": False, "outcome": "notCalled"}

"""A dosage is not a measured result, and must not create a coverage requirement.

`qualified-metric` is a conditional role: the description has to cover a metric
only when the ledger holds a qualified one.  Asking the output-side check about
a record with that same record as its own evidence compares a text with itself,
which holds for any text — so every numeric record counted as qualified and the
requirement was manufactured from `2 pumps`.
"""

from __future__ import annotations

import pytest

from pdp_geo_generator_agent.content_planning import _admission_evidence_states_qualified_metric

_NAME = {"ko-KR": "SampleDerma BarrierCare365 클렌징폼 200g", "en-US": "Dewdrop Renewal Serum VII"}

_QUALIFIED = {
    "ko-KR": "색조 메이크업 세정력은 97.1%로 제시되며, 만 20~39세 성인 여성 30명을 대상으로 시험한 결과입니다.",
    "en-US": "+5.9% improves the look of skin elasticity after 4 weeks in an instrumental study.",
}
_BARE_FIGURE = {"ko-KR": "97.1%", "en-US": "92%"}
_DOSAGE = {"ko-KR": "2회 펌핑", "en-US": "2 pumps"}


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_a_measured_result_with_its_qualification_is_a_qualified_metric(locale: str) -> None:
    item = {"role": "metric", "text": _QUALIFIED[locale]}

    assert _admission_evidence_states_qualified_metric(item, _NAME[locale]) is True


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_a_bare_figure_does_not_qualify_itself(locale: str) -> None:
    item = {"role": "metric", "text": _BARE_FIGURE[locale]}

    assert _admission_evidence_states_qualified_metric(item, _NAME[locale]) is False


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_a_dosage_is_not_a_measured_result(locale: str) -> None:
    item = {"role": "metric", "text": _DOSAGE[locale]}

    assert _admission_evidence_states_qualified_metric(item, _NAME[locale]) is False


def test_a_products_own_name_digits_do_not_make_a_metric() -> None:
    item = {"role": "metric", "text": "SampleDerma BarrierCare365 클렌징폼 200g"}

    assert _admission_evidence_states_qualified_metric(item, _NAME["ko-KR"]) is False

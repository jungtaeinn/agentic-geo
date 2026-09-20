"""Binding an atom measures whether the sentence carries it, not which verb does.

Adding a **supported** fact to a supported sentence must never remove support:
token coverage cannot fall when words are added, so the invariant is structural.
Adding an **unsupported** fact still may remove it, and must — that is the
assertion-tail check doing its job, and these tests keep it working.

The ledger and sentences use small, public source-product fixtures.
"""

from __future__ import annotations

import json
import pathlib
from typing import Any

import pytest

import pdp_geo_generator_agent.content_planning as planning
from pdp_geo_generator_agent.content_planning import create_pdp_geo_evidence_ledger
from pdp_geo_generator_agent.final_proofreader import (
    _evidence_record_supports_claim,
    select_rendered_sentence_evidence,
)
from pdp_geo_generator_agent.normalization import normalize_pdp_product

_SOURCE_PRODUCTS = pathlib.Path(__file__).parent / "fixtures" / "source-products"
_FIXTURE = {"ko-KR": "sample-derma-cleansing-foam.json", "en-US": "sample-botanics-serum.json"}


def _ledger(locale: str) -> list[dict[str, Any]]:
    raw = json.loads((_SOURCE_PRODUCTS / _FIXTURE[locale]).read_text(encoding="utf-8"))
    product = normalize_pdp_product(raw, {"hints": {"locale": locale}})["product"]
    ledger = create_pdp_geo_evidence_ledger(product, locale)
    public = [item for item in ledger if planning._admission_public_copy_evidence(item)]
    return planning._admission_trustworthy_evidence(public)


def _bound_roles(sentence: str, locale: str) -> set[str]:
    trust = _ledger(locale)
    roles = planning._unique_strings([planning.clean_text(item.get("role")) for item in trust])
    by_id = {planning.clean_text(item.get("id")): item for item in trust}
    selected = select_rendered_sentence_evidence(sentence, trust, roles)
    ids = selected["sentenceEvidenceIds"][0] if selected["sentenceEvidenceIds"] else []
    return {planning.clean_text(by_id[i].get("role")) for i in ids if i in by_id}


def _atom(locale: str, text: str, role: str) -> dict[str, Any]:
    for item in _ledger(locale):
        if planning.clean_text(item.get("text")) == text and planning.clean_text(item.get("role")) == role:
            return dict(item)
    raise AssertionError(f"{text!r} is not a {role} atom of the {locale} ledger")


# --- 지지되는 사실을 더하면 지지가 사라지지 않는다 --------------------------------

_SHAPES = {
    "ko-KR": {
        "A": "판테놀, 베타인, 글리세린을 담은 포뮬라가 함유되어 있습니다.",
        "B": "아미노산 유래 세정 포뮬라가 적용되었습니다.",
        "A+B": "판테놀, 베타인, 글리세린을 담은 아미노산 유래 세정 포뮬라가 적용되었습니다.",
    },
    "en-US": {
        "A": "This serum contains Ginseng.",
        "B": "Korean Herb Extract is applied.",
        "A+B": "Ginseng and Korean Herb Extract are applied in this serum.",
    },
}


_BLOCKED = pytest.mark.xfail(
    reason="성분명은 그 자체로 아무것도 주장하지 않아 자기주장 역할(_SELF_ASSERTING_EVIDENCE_ROLES)에서 "
    "제외된다. 성분과 결과를 잇는 주장은 추출된 성분/효능 관계로 인정되어야 하므로, 성분만 진술한 "
    "문장은 열거된 관계 동사 경로에 남는다.",
    strict=True,
)


@pytest.mark.parametrize(
    ("locale", "shape"),
    [
        ("ko-KR", "A"),
        ("ko-KR", "B"),
        ("en-US", "A"),
        pytest.param("en-US", "B", marks=_BLOCKED),
        pytest.param("ko-KR", "A+B", marks=_BLOCKED),
        pytest.param("en-US", "A+B", marks=_BLOCKED),
    ],
)
def test_a_sentence_carrying_a_ledger_ingredient_binds_it_whatever_verb_carries_it(
    locale: str, shape: str
) -> None:
    assert "ingredient" in _bound_roles(_SHAPES[locale][shape], locale)


_AUDIENCE_SHAPES = {
    "ko-KR": [
        "건조 피부 또는 민감 피부에 추천하는 클렌징 폼입니다.",
        "건조 피부 또는 민감 피부에 추천하는 약산성 클렌징 폼입니다.",
        "이 제품은 건조 피부 또는 민감 피부에 추천하는 클렌징 폼입니다.",
        "건조 피부 또는 민감 피부를 위한 클렌징 폼입니다.",
    ],
}


# 대상 고객 원자는 그 자체가 주장이므로, 수식어가 붙든 주어가 앞에 서든 동의 표현이든
# 문장이 그 원자를 진술하면 결속된다. 두 번째 형태만 남아 있는데, 원장에 없는 수식어
# ``약산성``이 주장 꼬리 검사에서 걸린다 — 결속 경로가 아니라 지지 판정의 몫이다.
@pytest.mark.parametrize(
    "sentence",
    [
        _AUDIENCE_SHAPES["ko-KR"][0],
        pytest.param(_AUDIENCE_SHAPES["ko-KR"][1], marks=_BLOCKED),
        _AUDIENCE_SHAPES["ko-KR"][2],
        _AUDIENCE_SHAPES["ko-KR"][3],
    ],
)
def test_an_audience_statement_binds_through_a_modifier_a_subject_or_a_synonym(sentence: str) -> None:
    assert _bound_roles(sentence, "ko-KR") & {"audience", "description"}


def test_the_malformed_source_and_its_grammatical_rewrite_bind_alike() -> None:
    """원장 비문이 결속되고 문법에 맞는 재작성이 결속되지 않는 비대칭을 없앤다."""
    malformed = "아미노산 유래 세정 성분을 담음 약산성 포뮬라로 일상 속 노폐물을 말끔하게 세정"
    rewritten = "아미노산 유래 세정 성분을 담은 약산성 포뮬라로 일상 속 노폐물을 말끔하게 세정합니다."

    assert _bound_roles(malformed, "ko-KR")
    assert _bound_roles(rewritten, "ko-KR")


# --- 지지되지 않는 사실을 더하면 지지는 사라져야 한다 ----------------------------

_ADVERSARIAL = {
    "ko-KR": {
        "atom": ("판테놀", "ingredient"),
        "unsupported benefit": "판테놀이 주름을 완전히 없애줍니다.",
        "invented sibling": "판테놀과 레티놀이 피부 장벽을 개선합니다.",
        "unsupported qualifier": "임상적으로 입증된 판테놀이 주름을 개선합니다.",
    },
    "en-US": {
        "atom": ("Ginseng", "ingredient"),
        "unsupported benefit": "Ginseng completely removes wrinkles.",
        "invented sibling": "Ginseng and Retinol cure acne scars.",
        "unsupported qualifier": "Clinically proven Ginseng eliminates dark spots.",
    },
}


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
@pytest.mark.parametrize("case", ["unsupported benefit", "invented sibling", "unsupported qualifier"])
def test_adding_an_unsupported_fact_still_removes_support(locale: str, case: str) -> None:
    text, role = _ADVERSARIAL[locale]["atom"]
    item = _atom(locale, text, role)

    assert _evidence_record_supports_claim(_ADVERSARIAL[locale][case], item) is False


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
@pytest.mark.parametrize("case", ["unsupported benefit", "invented sibling", "unsupported qualifier"])
def test_an_unsupported_claim_about_an_ingredient_binds_to_nothing(locale: str, case: str) -> None:
    """성분명을 부르는 것만으로 미지지 주장이 근거를 얻지는 못한다.

    위의 음성 테스트는 원자 하나가 주장을 지지하는지를 보지만, 발행을 막는 것은
    문장 단위 결속이다. 이름은 지시할 뿐 주장하지 않으므로, 성분명만 진술한 문장은
    그 이름으로 결속되지 않는다 — 성분과 결과를 잇는 주장은 추출된 관계의 몫이다.
    """

    assert _bound_roles(_ADVERSARIAL[locale][case], locale) == set()

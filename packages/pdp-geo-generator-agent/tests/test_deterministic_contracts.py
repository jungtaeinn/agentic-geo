"""Behavioral parity tests for the deterministic generator contracts."""

from __future__ import annotations

import importlib
from types import ModuleType

import pytest


def _contract_module(name: str) -> ModuleType:
    """Load a contract at test time so a missing port is a RED assertion."""
    try:
        return importlib.import_module(f"pdp_geo_generator_agent.contracts.{name}")
    except ModuleNotFoundError:
        pytest.fail(f"The {name} contract must provide its deterministic Python behavior.")


def test_analysis_labels_distinguish_internal_artifacts_from_publishable_result_phrase() -> None:
    """Removing ``시험 결과`` from internal matching would let field dumps leak."""
    contract = _contract_module("analysis_label")

    assert contract.is_analysis_label_prefixed("확인 지표: 84.3% 증가")
    assert not contract.is_analysis_label_prefixed("시험 결과: 84.3% 증가")
    assert contract.has_analysis_label_artifact("확인 지표는 다음과 같습니다.")
    assert not contract.has_analysis_label_artifact("시험 결과는 다음과 같습니다.")
    assert contract.leading_label_field_pattern.sub("", "시험 결과: 84.3% 증가") == "84.3% 증가"
    adverbial = "시험 결과 보습량이 2배 증가했습니다."
    assert contract.leading_label_field_pattern.sub("", adverbial) == adverbial

    match = contract.match_assessment_context_label("인체 적용 시험 기준 확인 지표: 84.3% 증가")
    assert match is not None
    assert match.group(1) == "인체 적용 시험"
    assert match.group(2) == "84.3% 증가"


def test_certification_contract_keeps_completed_facts_and_drops_metrics_or_raw_restatements() -> None:
    """Dropping the atomic/clinical boundary would publish evidence as certification."""
    contract = _contract_module("certification")

    assert contract.select_atomic_functional_certification_values(
        "피부과 테스트 완료 및 하이포알러제닉 테스트 완료를 마친 저자극 포뮬러", "ko-KR"
    ) == ["피부과 테스트 완료", "하이포알러제닉 테스트 완료"]
    assert contract.select_atomic_functional_certification_values(
        "Ectoin WORKS BEST FOR All skin types - Dermatologically and hypoallergenic tested", "en-US"
    ) == ["Dermatologically and hypoallergenic tested"]
    assert (
        contract.select_atomic_functional_certification_values(
            "Clinical study: 32% improvement after 4 weeks.", "en-US"
        )
        == []
    )
    assert contract.restates_typed_field_as_raw_transcription(
        "피부과 테스트 완료를 통해 민감 피부 사용 적합성을 확인했습니다.", ["피부과 테스트 완료"]
    )
    assert not contract.restates_typed_field_as_raw_transcription(
        "임상 시험에서 32% 개선되었습니다.", ["피부과 테스트 완료"]
    )


def test_enumeration_contract_identifies_only_unroled_prose_lists() -> None:
    """A missing grammar guard would either miss bare lists or reject measured endpoints."""
    contract = _contract_module("enumeration")

    korean = "판테놀, 베타인, 세라마이드를 돕습니다."
    english = "This formula includes ceramide, panthenol, and betaine."
    measured = "100% of participants reported smoother skin, firmer texture, and improved elasticity."

    assert contract.unpredicated_enumeration_sentence(korean) == korean
    assert contract.has_unpredicated_enumeration(english)
    assert not contract.has_unpredicated_enumeration(measured)

    def exempt_first_sentence(sentence: str, index: int) -> bool:
        del sentence
        return index == 0

    assert not contract.has_unpredicated_enumeration(english, exempt_first_sentence)


def test_ingredient_vocabulary_preserves_brand_precedence_and_shared_substances() -> None:
    """Changing rule order or substance normalization would split or flatten ingredients."""
    contract = _contract_module("ingredient_vocabulary")

    assert contract.canonical_ingredient_surface("Contains Panthenol to soothe") == "Panthenol"
    assert contract.canonical_ingredient_surface("진생 펩타이드") == "진생펩타이드"
    assert contract.ingredient_surfaces_present_in("Panthenol and ceramide") == ["Ceramide", "Panthenol"]
    assert contract.ingredient_substance_key("Ceramide (10,000ppm)") == "ceramide"
    assert contract.ingredient_substance_key("세라마이드") == "ceramide"
    assert contract.ingredient_substance_key("고밀도 세라마이드 캡슐") is None


def test_product_type_contract_inferrs_form_then_uses_requested_market_wording() -> None:
    """Incorrect precedence would turn a cream mist into a generic mist or cream."""
    contract = _contract_module("product_type")

    assert contract.product_type_from_name("BarrierCare 365 크림 미스트") == "Cream Mist"
    assert contract.product_type_from_name("Daily Body Lotion") == "Body Lotion"
    assert contract.product_type_from_name("Concentrated Botanical Rejuvenating Eye Cream") == "Eye Cream"
    assert contract.product_type_from_name("Any Brand Eye-Cream") == "Eye Cream"
    assert contract.localize_product_type_for_locale("Cream Mist", "ko-KR") == "크림 미스트"
    assert contract.localize_product_type_for_locale("Eye Cream", "en-US") == "Eye Cream"
    assert contract.localize_product_type_for_locale("美容液", "en-US") == "Serum"
    assert contract.localize_product_type_for_locale("  Specialty  ,  ", "en-US") == "Specialty,"


def test_usage_contract_accepts_actions_but_rejects_marketing_and_detects_page_dumps() -> None:
    """A divergent action vocabulary would reject real mist/wash directions or admit marketing."""
    contract = _contract_module("usage")

    assert contract.clean_usage_text("```json\n1. 얼굴에 분사합니다 \x00") == "얼굴에 분사합니다"
    assert contract.has_procedure_action_cue("피부에 건조함이 느껴질 때 수시로 뿌려줍니다")
    assert contract.has_actionable_application_verb("미온수로 깨끗이 씻어냅니다")
    assert contract.is_procedural_usage_instruction("Spray evenly onto the face after cleansing.")
    assert contract.is_procedural_usage_instruction("Dispense one pump, then smooth over the face.")
    assert contract.is_concrete_usage_action("미온수로 깨끗이 씻어냅니다")
    assert not contract.is_procedural_usage_instruction("촉촉한 사용감과 산뜻한 마무리감이 느껴지는 미스트")
    assert not contract.is_procedural_usage_instruction("Daily hydration cream for dry skin.")
    assert not contract.is_procedural_usage_instruction("Contains panthenol and helps keep strands smooth.")
    assert not contract.is_concrete_usage_action("임상 테스트 결과 보습 효과가 32% 개선되었습니다.")
    assert contract.is_safety_or_test_claim_usage("Dermatologist-tested for sensitive skin")
    assert contract.has_context_free_figure_run("+63.6% +84.3% +84.3%")
    assert contract.is_stitched_marketing_page_dump("Step 1 Cleanse. Step 2 Tone. Step 3 Moisturize.")
    assert contract.is_raw_page_text_block("2020 2021 2022 GLOWPICK AWARDS WINNER SAMPLE_DERMA")


def test_contract_package_reexports_ported_helpers() -> None:
    """Omitting re-exports would make completed ports unreachable to Python callers."""
    contracts = importlib.import_module("pdp_geo_generator_agent.contracts")

    assert contracts.product_type_from_name("Hydra Cream Mist") == "Cream Mist"
    assert contracts.is_procedural_usage_instruction("Apply an appropriate amount to the face.")
    assert contracts.canonical_ingredient_surface("판테놀 함유") == "판테놀"


def test_sentence_form_reads_an_assertion_as_a_sentence_in_any_locale() -> None:
    """A Korean-only sentence test leaves English prose indistinguishable from a name.

    Ledger role lists carry both catalog names and whole extracted sentences.
    Telling them apart decides what may stand on the ingredient side of a causal
    claim, so the judgment cannot hold for one locale only.
    """
    contract = _contract_module("sentence_form")

    assert contract.is_complete_sentence("판테놀은 피부 장벽 개선을 돕습니다.")
    assert contract.is_complete_sentence("Panthenol strengthens the skin barrier.")
    assert contract.is_complete_sentence("보습 복합체는 보습을 전달합니다")
    assert not contract.is_complete_sentence("아미노산 유래 세정 성분")
    assert not contract.is_complete_sentence("amino acid derived cleansing ingredient")
    assert not contract.is_complete_sentence("피부 장벽 보호")


def test_sentence_form_bounds_one_catalog_phrase_against_prose() -> None:
    """The size bound that separates a phrase from prose has one definition."""
    contract = _contract_module("sentence_form")
    certification = _contract_module("certification")

    assert contract.is_atomic_fact_phrase("아미노산 유래 세정 성분")
    assert contract.is_atomic_fact_phrase("피부과 테스트 완료")
    assert not contract.is_atomic_fact_phrase(
        "세안 중에도 피부를 보호해주는 포뮬라에는 판테놀, 베타인, 보습 복합체의 3종 장벽 보호 성분이 함유되어 있습니다."
    )
    assert not contract.is_atomic_fact_phrase(
        "The barrier protective formula that shields skin during cleansing contains Panthenol, Betaine and Moisture Complex."
    )
    # 인증 계약이 같은 상수를 따로 들고 있으면 둘이 조용히 갈라진다.
    assert certification.is_atomic_fact_phrase is contract.is_atomic_fact_phrase


def test_metric_statement_reads_a_called_name_without_lending_it_to_a_fragment() -> None:
    """A sentence keeps the identity it calls, and only the one it calls.

    Per-sentence evidence narrowing asks this contract which identity atom a
    sentence brought with it.  Answering by substring would let a name borrow
    the ledger links of the longer name that contains it, so the judgment is
    made word by word, allowing the grammar a locale attaches to a word.
    """
    contract = _contract_module("metric_statement")
    sentence_form = _contract_module("sentence_form")
    copy_refiner = importlib.import_module("pdp_geo_generator_agent.copy_refiner")

    assert contract.states_naming_surface(
        "SAMPLE_DERMA의 SampleDerma BarrierCare365 클렌징폼에는 판테놀이 있습니다.", "SampleDerma BarrierCare365 클렌징폼"
    )
    assert contract.states_naming_surface(
        "SampleBotanics's Dewdrop Renewal Serum VII keeps its core ingredients.", "Dewdrop Renewal Serum VII"
    )
    assert not contract.states_naming_surface("베타인이 들어 있습니다.", "베타")
    assert not contract.states_naming_surface("Vitamin C brightens skin.", "VI")
    assert contract.states_naming_surface(
        "SAMPLE_DERMA의 SampleDerma BarrierCare365 클렌징폼은 순합니다.", "SampleDerma BarrierCare365 클렌징폼 200g"
    )
    assert not contract.states_naming_surface("BarrierCare365 클렌징폼은 순합니다.", "SampleDerma BarrierCare365 클렌징폼 200g")
    assert not contract.states_naming_surface("이 제품은 200g입니다.", "SampleDerma BarrierCare365 클렌징폼 200g")
    # 조사를 떼는 규정이 둘로 갈라지면 같은 이름이 모듈마다 다르게 불린다.
    assert copy_refiner.strip_korean_particle is sentence_form.strip_korean_particle


def test_korean_inflection_is_stripped_so_one_fact_has_one_stem() -> None:
    """한국어는 낱말에 역할을 표시한다. 조사·어미를 남기면 같은 사실이 두 낱말이 된다."""
    sentence_form = _contract_module("sentence_form")
    strip = sentence_form.strip_korean_inflection

    # 명사는 격조사를, 서술어는 어미를 달고 나온다. 원문의 어구와 그것을 진술한
    # 문장은 그래서 표면형이 절대 같지 않다.
    assert strip("장벽을") == "장벽"
    assert strip("성분이") == "성분"
    assert strip("클렌징폼은") == "클렌징폼"
    assert strip("피부에") == "피부"
    assert strip("세정합니다") == "세정"
    assert strip("개선합니다") == "개선"
    assert strip("추천하는") == "추천"
    assert strip("폼입니다") == "폼"
    # 어간만 남은 낱말은 그대로 둔다. 남길 게 없으면 원형을 돌려준다.
    assert strip("아미노산") == "아미노산"
    assert strip("비타민") == "비타민"
    assert strip("합니다") == "합니다"
    # 라틴 문자는 이 규정의 대상이 아니다.
    assert strip("ginseng") == "ginseng"


def test_korean_content_stem_counts_one_word_once_without_breaking_a_noun() -> None:
    """같은 낱말을 한 낱말로 세는 질문과 명사가 끝나는 지점을 찾는 질문은 다르다."""
    sentence_form = _contract_module("sentence_form")
    stem = sentence_form.korean_content_stem

    # 조사와 종결 어미는 공유 규정과 같은 어간에 이른다.
    assert stem("장벽을") == "장벽"
    assert stem("유도체로") == "유도체"
    assert stem("개선합니다") == "개선"
    assert stem("있습니다") == "있"
    # 조사가 겹쳐 붙어도 맨 명사와 같은 어간에 이른다.
    assert stem("피부에서는") == "피부"
    # 프롬프트가 요구한 연결·구성 어미는 문장을 잇는 문법이고 사실이 아니다.
    assert stem("개선해") == "개선"
    assert stem("활용할") == "활용"
    assert stem("사용하실") == "사용"
    assert stem("개선될") == "개선"
    # 조사와 같은 글자로 끝나는 명사는 무너지지 않는다. 열린 음절 뒤의 ``과``가
    # 조사라면 ``와``로 적혔을 것이고, 한 음절만 남는 ``결과``는 명사다.
    assert stem("효과") == "효과"
    assert stem("피부과") == "피부과"
    assert stem("결과") == "결과"
    assert stem("판테놀과") == "판테놀"
    # 같은 글자로 끝나도 어간이 한 음절만 남으면 명사를 자른 것이다. ``과``만의 규칙이
    # 아니라 명사가 마지막 음절을 적는 모든 조사에 같은 바닥이 필요하다. 안전
    # 경고 ``주의``가 보조용언의 어간 ``주``로 줄어 비교에서 지워졌던 것이
    # 그 자리다.
    assert stem("이해") == "이해"
    assert stem("역할") == "역할"
    assert stem("주의") == "주의"
    assert stem("회의") == "회의"
    assert stem("용도") == "용도"
    # 명사를 살리는 바닥은 조사를 무디게 하지 않는다. 두 음절짜리 명사는
    # 여전히 어떤 격에서도 같은 어간에 이른다.
    assert stem("피부에") == "피부"
    assert stem("효과가") == "효과"
    assert stem("제품도") == "제품"
    assert stem("베타인의") == "베타인"
    # 라틴 어간에는 음절 동의를 읽을 수 없으니 적힌 대로 받는다.
    assert stem("panthenol은") == "panthenol"
    assert stem("ginseng") == "ginseng"
    # 어간을 다시 줄이면 그 어간이다. 이것이 면제 목록을 정규형으로 등록할 수
    # 있게 하는 성질이다.
    for word in (
        "효과",
        "효과를",
        "피부과",
        "결과",
        "판테놀과",
        "개선해",
        "활용할",
        "사용하실",
        "있습니다",
        "또한",
        "담은",
        "함유된",
        "장벽을",
        "피부에서는",
        "후에도",
        "합니다",
        "하는",
        "추가",
        "길이",
    ):
        assert stem(stem(word)) == stem(word), word

    # 공유 규정의 답은 그대로다 — 다른 소비자가 읽는 경계는 바뀌지 않는다.
    assert sentence_form.strip_korean_inflection("효과") == "효"
    assert sentence_form.strip_korean_inflection("개선해") == "개선해"
    assert sentence_form.strip_korean_particle("효과") == "효"


def test_a_clause_is_the_unit_of_one_stated_fact() -> None:
    """접속사로 이은 두 사실은 절이 둘이다. 한 술어짜리 재조합은 절이 하나다."""
    sentence_form = _contract_module("sentence_form")
    split = sentence_form.split_into_clauses

    assert split("판테놀은 피부 장벽을 개선하고, 베타인은 피부 장벽을 더욱 견고하게 합니다.") == [
        "판테놀은 피부 장벽을 개선하고,",
        "베타인은 피부 장벽을 더욱 견고하게 합니다.",
    ]
    assert split("X supports the skin barrier; Y improves hydration.") == [
        "X supports the skin barrier",
        "Y improves hydration.",
    ]
    # 한 술어로 두 주장의 조각을 이어 붙인 문장은 쪼개지지 않는다 — 그래서 결속기가
    # 계속 한 주장 안에 들어오라고 요구할 수 있다.
    assert split("아미노산 유래 세정 성분이 일상 속 노폐물을 세정합니다.") == [
        "아미노산 유래 세정 성분이 일상 속 노폐물을 세정합니다."
    ]
    # 절 어미 집합은 한 곳에서만 정의된다.
    assert sentence_form.KOREAN_CLAUSE_BOUNDARY.pattern.startswith(sentence_form._KOREAN_CLAUSE_ENDING)


def test_a_sentence_splitter_has_one_definition() -> None:
    """문장 경계를 모듈마다 따로 정하면 같은 블록이 계약마다 다르게 쪼개진다."""
    sentence_form = _contract_module("sentence_form")
    for name in ("suitability", "usage", "enumeration"):
        module = _contract_module(name)
        assert getattr(module, "split_into_sentences") is sentence_form.split_into_sentences, name
    assert sentence_form.split_into_sentences("A. B\nC") == ["A.", "B", "C"]

"""절차는 지시이고 적합성은 대상 진술이다. 둘을 구조로 가른다.

두 로케일을 함께 고정한다. 같은 결함이 ko-KR에서는 한 구절이 두 번 집계되는
형태로, en-US에서는 루틴 단서와 어울려 점수를 채우는 형태로 나타났다.

이 파일은 결과만이 아니라 **기전**도 고정한다. 규칙을 우회하는 변형이 스위트를
통과하면 그 규칙은 문서일 뿐이므로, 각 기전마다 그것이 사라지면 깨지는 단정을 둔다.
"""

from __future__ import annotations

import pytest

from pdp_geo_generator_agent.contracts.suitability import audience_designations, is_suitability_statement
from pdp_geo_generator_agent.contracts.usage import (
    has_procedure_action_cue,
    is_procedural_usage_instruction,
    usage_procedure_signal_score,
)

# 아래 문장은 모두 변경 전 판정기가 **절차라고 답하던** 것들이다(빈 단정 방지).
KOREAN_AUDIENCE_STATEMENT = [
    "정상, 건성, 복합성 피부에 사용할 수 있습니다.",
    "모든 피부 타입에 사용할 수 있습니다.",
    "건성 피부에도 매일 사용 가능합니다.",
    "신생아에게도 사용할 수 있습니다.",
    "이 제품은 피부에 사용할 수 있습니다.",
]
ENGLISH_AUDIENCE_STATEMENT = [
    "Can be used daily on dry skin.",
    "Can be used twice daily on dry skin.",
    "Can be used every morning on sensitive skin.",
    "Leave-on cream is suitable for dry skin.",
    "Warm tones are suitable for mature skin.",
]
KOREAN_PROCEDURE = [
    "적당량을 손에 덜어 얼굴에 펴 바릅니다.",
    "세안 후 마지막 단계에 사용합니다.",
    "아침저녁으로 적당량을 얼굴에 펴 발라줍니다.",
    # 대상을 부르면서도 무엇을 하라고 말하는 문장은 여전히 절차다.
    "민감성 피부에 펴 바릅니다.",
    "모든 피부 타입에 사용 가능한 젤 크림을 적당량 덜어 얼굴에 펴 발라줍니다.",
    "눈가에도 사용 가능하므로 적당량을 덜어 부드럽게 두드려 흡수시킵니다.",
    "화장솜에 적셔 얼굴에 사용할 수 있습니다.",
]
ENGLISH_PROCEDURE = [
    "Apply an appropriate amount to the face.",
    "Spray evenly onto the face after cleansing.",
    "Dispense one pump, then smooth over the face.",
    "Can be used on the face and neck after cleansing.",
    "Apply to dry skin every morning.",
]


@pytest.mark.parametrize("text", KOREAN_AUDIENCE_STATEMENT + ENGLISH_AUDIENCE_STATEMENT)
def test_naming_an_audience_is_not_a_procedure(text: str) -> None:
    assert is_procedural_usage_instruction(text) is False


@pytest.mark.parametrize("text", KOREAN_PROCEDURE + ENGLISH_PROCEDURE)
def test_real_procedures_survive_the_change(text: str) -> None:
    assert is_procedural_usage_instruction(text) is True


def test_the_two_korean_wordings_of_one_meaning_agree() -> None:
    """어형만 다른 같은 뜻이 반대로 판정되던 자기모순을 고정한다.

    같다는 것만 단정하면 둘 다 참으로 붕괴해도 통과하므로 판정값까지 못박는다.
    """
    a = is_procedural_usage_instruction("정상, 건성, 복합성 피부에 사용할 수 있습니다.")
    b = is_procedural_usage_instruction("민감성 피부에도 사용 가능합니다.")
    assert (a, b) == (False, False)


def test_the_two_english_wordings_of_one_meaning_agree() -> None:
    """영어도 같은 뜻의 두 어형이 같은 판정을 받아야 한다."""
    a = is_procedural_usage_instruction("Can be used daily on dry skin.")
    b = is_procedural_usage_instruction("Suitable for dry skin.")
    assert (a, b) == (False, False)


@pytest.mark.parametrize(
    "text",
    [
        # 서술어 어휘가 아니라 자리가 적합성을 만든다.
        "민감성 피부에 적합합니다.",
        "민감성 피부에 알맞습니다.",
        "민감성 피부에 잘 맞습니다.",
        "건성 피부에 좋습니다.",
        "모든 피부 타입에 사용할 수 있습니다.",
        "민감성 피부에도 사용 가능합니다.",
        "신생아에게도 사용할 수 있습니다.",
        # N1. 피동은 추측이 아니다 — 사용될 수 있다는 사용할 수 있다와 같은 말이다.
        "민감성 피부에도 사용될 수 있습니다.",
        "아기에게도 사용될 수 있습니다.",
        "건성 피부에 적용될 수 있습니다.",
        "아기의 피부에도 사용할 수 있습니다.",
        # NEW-2. 사용자 부류도 기질과 똑같이 한정어를 받는다.
        "Barrier Serum is appropriate for expectant mothers.",
        "Barrier Serum is appropriate for preschoolers.",
        "Barrier Serum is appropriate for newborns.",
        "Barrier Serum is intended for customers with dry skin.",
        "Suitable for seniors.",
        "Suitable for pregnant women.",
        "Gentle enough for eyelashes.",
        "Can be used every morning on sensitive skin.",
        "수유부에게도 사용할 수 있습니다.",
        "노년층에게도 적합합니다.",
        "민감한 부위에도 사용할 수 있습니다.",
        "속눈썹에도 사용할 수 있습니다.",
        "Suitable for normal, dry and combination skin.",
        "Ideal for dry skin.",
        "Safe for sensitive skin.",
        "Gentle enough for sensitive skin.",
        "Recommended for sensitive skin.",
        "This cream is appropriate for sensitive skin.",
        "It is gentle enough for sensitive skin.",
        "Can be used on sensitive skin.",
        "Can be used daily on dry skin.",
        "Can be applied on sensitive skin.",
        # N2. 극성은 for를 취하는 서술 핵에서 읽는다. 옆에 선 긍정 주장이 적합성을 지우면 안 된다.
        "This is non-comedogenic and suitable for oily skin.",
        "Suitable for all skin types. It is non-greasy.",
        "Suitable for sensitive skin; it is unscented.",
        "This is non-drying and suitable for dry skin.",
        # N3. 현재분사 구성은 극성을 나르지 않는다.
        "Can be hydrating for dry skin.",
        "This is soothing for sensitive skin.",
        "It is calming for sensitive skin.",
        "This is nourishing for dry hair.",
        "This is long-lasting for oily skin.",
        # 극성은 서술 핵에서 읽는다 — 다른 문장·다른 절의 낱말이 적합성을 지우면 안 된다.
        "Suitable for sensitive skin. It is unsuitable for wounds.",
        "This is unscented. Suitable for sensitive skin.",
        "민감성 피부에 적합합니다. 상처 부위에는 부적합합니다.",
        "이 제품은 부적합합니다. 민감성 피부에 적합합니다.",
        # 뒤따르는 병렬 절이 말하는 것은 그 절의 것이다.
        "민감성 피부에 적합하며 향료는 넣지 않았습니다.",
        "민감성 피부에 적합하며 인공 향료는 사용하지 않습니다.",
        "민감성 피부에 적합하고 자극은 없습니다.",
        "민감성 피부에 적합하고 인공 향료는 넣지 않았습니다.",
    ],
)
def test_a_named_audience_in_fitness_position_is_a_suitability_statement(text: str) -> None:
    assert is_suitability_statement(text) is True


@pytest.mark.parametrize(
    "text",
    [
        # 시점은 대상이 아니다. 어느 시점 명사냐를 묻지 않고 대상인지를 묻는다.
        "세안 후에도 사용할 수 있습니다.",
        "세안후에도 사용할 수 있습니다.",
        "취침 직전에도 사용할 수 있습니다.",
        "외출 무렵에도 사용할 수 있습니다.",
        "샤워 직후에도 사용할 수 있습니다.",
        "Can be used after cleansing.",
        # 도구·장소·추상 명사도 대상이 아니다.
        "화장솜에 적셔 사용할 수 있습니다.",
        "제품 선택에 참고할 수 있습니다.",
        "개인차가 있을 수 있습니다.",
        "Can be used on the face and neck after cleansing.",
        # 맨 기질은 어디를 말할 뿐 누구를 말하지 않는다.
        "이 제품은 피부에 사용할 수 있습니다.",
        "피부에 사용할 수 있습니다.",
        "Can be used on skin.",
        # 지시문과 질문은 단정이 아니다.
        "민감성 피부에 펴 바르세요.",
        "영유아도 사용할 수 있나요?",
        "민감성 피부에 사용할 수 있나요?",
        "민감성 피부에 사용할 수 있나요",
        "Can it be used by newborns?",
        "Is this suitable for sensitive skin?",
        # 명사구 조각은 단정하지 않는다.
        "민감성 피부에 적합한 성분",
        # 양태와 대상이 다른 문장/절에 있으면 그 대상을 한정한 것이 아니다.
        "건조함과 당김이 고민이라면 세럼을 고려할 수 있습니다. 세라마이드는 수분량 개선에 도움을 줍니다.",
    ],
)
def test_statements_that_name_no_audience_are_not_suitability(text: str) -> None:
    assert is_suitability_statement(text) is False


@pytest.mark.parametrize(
    "text",
    [
        # 주의는 권장이 아니다. 이것을 적합성으로 읽으면 대상이 뒤집힌다.
        "민감성 피부에는 자극이 있을 수 있습니다.",
        # 형태적 부정 — 부/불/비/무/미가 붙은 하다 서술어
        "민감성 피부에는 부적합합니다.",
        "민감성 피부에 부적합합니다.",
        "건성 피부에는 부족할 수 있습니다.",
        "건성 피부에 부족할 수 있습니다.",
        "민감성 피부에 불충분합니다.",
        "민감성 피부에 미흡합니다.",
        # 서술형 양태 — 계사·피동·ㅂ불규칙 어간 위의 -ㄹ 수 있다는 추측이다
        "민감성 피부에 자극적일 수 있습니다.",
        "민감성 피부에는 자극될 수 있습니다.",
        # 부정적 되다 서술어는 제 피해자를 주어로 데려간다 — 여기엔 대상 보어가 없다.
        "민감성 피부는 자극될 수 있습니다.",
        "민감성 피부에 자극을 줄 수 있습니다.",
        "민감성 피부에는 따가울 수 있습니다.",
        "민감성 피부에 따가울 수 있습니다.",
        # 대조 화제 — 대상을 한정이 아니라 배제 쪽으로 갈라놓는다
        "아토피 피부에는 위험합니다.",
        "민감성 피부에는 자극이 나타납니다.",
        "민감성 피부에 붉어짐이 나타날 수 있습니다.",
        "민감성 피부에 트러블이 생길 수 있습니다.",
        "민감성 피부에 부작용이 나타날 수 있습니다.",
        "건성 피부에 자극이 나타날 수 있습니다.",
        "지성 피부에 트러블이 발생할 수 있습니다.",
        "복합성 피부에 따가움이 느껴질 수 있습니다.",
        # 부정은 양태가 지배하는 어간 안으로 들어와도 부정이다.
        "민감성 피부에 적합하지 않을 수 있습니다.",
        "민감성 피부에 권장하지 않을 수 있습니다.",
        "민감성 피부에 사용을 피할 수 있습니다.",
        "민감성 피부에 사용하지 않을 수 있습니다.",
        "민감성 피부에는 사용할 수 없습니다.",
        "민감성 피부에 적합하지 않습니다.",
        "민감성 피부에 가능하지 않습니다.",
        # 대상 자신의 절 안에 있는 부정은 그대로 막힌다.
        "민감성 피부에 부적합하며 향료도 들었습니다.",
        "민감성 피부에 자극이 나타나고 붉어질 수 있습니다.",
        "This is unsuitable for wounds.",
        # N4. 법조동사 피동 가지에도 서술 핵이 있다 — 분사가 그 핵이다.
        "Can be unsuited for sensitive skin.",
        "Can be unsuited on sensitive skin.",
        "May be unsuited for dry skin.",
        "May be avoided by people with sensitive skin.",
        "This is not suitable for sensitive skin.",
        "Not recommended for sensitive skin.",
        "It is never suitable for dry skin.",
        "Cannot be used on sensitive skin.",
        "May not be used on sensitive skin.",
        "Should not be used on damaged skin.",
        # 형태적 부정·정도 초과·현재분사 서술어
        "Unsuitable for sensitive skin.",
        "Too rich for oily skin.",
        "Non-comedogenic for oily skin.",
    ],
)
def test_a_caution_is_never_read_as_a_fitness_claim(text: str) -> None:
    assert is_suitability_statement(text) is False


def test_possibility_modality_is_not_an_application_action() -> None:
    """이중 등재 제거의 절반. 이 단정이 없으면 행위 목록에 되돌려도 아무도 모른다."""
    assert has_procedure_action_cue("정상, 건성, 복합성 피부에 사용할 수 있습니다.") is False
    assert has_procedure_action_cue("모든 피부 타입에 사용할 수 있습니다.") is False


def test_possibility_modality_is_not_an_imperative_ending() -> None:
    """이중 등재 제거의 나머지 절반. 어느 쪽을 되돌려도 이 점수가 2가 된다."""
    assert usage_procedure_signal_score("세안 후 사용할 수 있습니다.") == 1
    assert is_procedural_usage_instruction("세안 후 사용할 수 있습니다.") is False


def test_the_audience_gate_is_read_before_the_concise_imperative_shortcut() -> None:
    """행위 어휘로 시작하는 적합성 문장이 순서 때문에 절차가 되면 안 된다."""
    assert is_procedural_usage_instruction("Leave-on cream is suitable for dry skin.") is False


def test_an_application_action_keeps_the_audience_gate_out() -> None:
    """대상을 부르는 문장이라도 무엇을 하라고 말하면 절차 판정을 잃지 않는다."""
    assert is_suitability_statement("민감성 피부에 펴 바릅니다.") is True
    assert is_procedural_usage_instruction("민감성 피부에 펴 바릅니다.") is True


# Fictional mixed-content fixture: only the final sentence is an instruction.
# The neighboring suitability cues must not make the entire block procedural.
_LIVE_MIXED_BLOCK = (
    "Considered one of the best Korean essence serums, Dewdrop Renewal Serum VII is "
    "suitable for dry, oily and combination skin. The lightweight, fast-absorbing texture "
    "layers easily without heaviness. Sensitive skin users should patch test before daily use."
)
_LIVE_INSTRUCTION = "Sensitive skin users should patch test before daily use."
_KOREAN_MIXED_BLOCK = "민감성 피부에 사용할 수 있습니다. 적당량을 손에 덜어 얼굴에 펴 바릅니다."
_KOREAN_INSTRUCTION = "적당량을 손에 덜어 얼굴에 펴 바릅니다."


def test_a_block_mixing_copy_with_one_instruction_is_not_itself_an_instruction() -> None:
    """절차의 근거는 문장 안에 있다. 이웃 문장에서 빌려오면 안 된다."""
    assert is_procedural_usage_instruction(_LIVE_MIXED_BLOCK) is False
    assert is_suitability_statement(_LIVE_MIXED_BLOCK) is True
    assert is_procedural_usage_instruction(_KOREAN_MIXED_BLOCK) is False


def test_the_instruction_inside_a_mixed_block_survives_on_its_own() -> None:
    """블록이 절차가 아니게 됐다고 해서 그 안의 지시문이 지시문이 아니게 되지는 않는다."""
    assert is_procedural_usage_instruction(_LIVE_INSTRUCTION) is True
    assert is_procedural_usage_instruction(_KOREAN_INSTRUCTION) is True


def test_a_block_whose_sentences_are_all_instructions_stays_a_procedure() -> None:
    """문장 단위 판정이 진짜 다문장 절차를 깨뜨리지 않는다."""
    assert (
        is_procedural_usage_instruction("Apply an appropriate amount to the face. Rinse thoroughly with water.") is True
    )
    assert (
        is_procedural_usage_instruction("적당량을 손에 덜어 얼굴에 펴 바릅니다. 세안 후 마지막 단계에 사용합니다.")
        is True
    )


def test_a_block_of_directions_survives_a_sentence_outside_the_action_vocabulary() -> None:
    """대상을 부르지 않는 블록은 이웃 문장이 어휘 밖이어도 여전히 절차다.

    문장 단위 판정이 '모든 문장이 절차여야 한다'로 굳으면 진짜 다문장 절차를 잃는다.
    """
    assert is_procedural_usage_instruction("Apply daily. Avoid contact with eyes.") is True
    assert (
        is_procedural_usage_instruction(
            "Dot cream across your entire under-eye area, then gently pat it into the skin using your "
            "fingertips. Move from the inner corner outward."
        )
        is True
    )


def test_a_sentence_that_both_names_an_audience_and_directs_keeps_its_block_procedural() -> None:
    """대상을 부르는 문장이라도 그 자신이 지시문이면 블록을 끌어내리지 않는다."""
    assert is_procedural_usage_instruction("민감성 피부에 펴 바릅니다. 적당량을 덜어 부드럽게 바릅니다.") is True


def test_cues_scattered_over_a_block_are_not_a_procedure() -> None:
    """어느 문장도 지시하지 않는데 단서만 흩어져 있으면 절차가 아니다.

    합산만 보면 분량·순서·어미가 임계값을 채운다. 지시하는 문장이 하나도 없으므로
    그 블록은 지시가 아니다.
    """
    assert is_procedural_usage_instruction("One pump is enough. The next step layers easily.") is False
    assert is_procedural_usage_instruction("적당량이 손에 남습니다. 세안 후 마지막 단계의 느낌이 좋습니다.") is False


def test_the_fail_closed_ruling_costs_these_positives() -> None:
    """극성을 구조로 읽을 수 없으면 적합성을 주지 않는다 — 참인 문장을 잃더라도.

    주의를 권장 대상으로 발행하는 쪽이 대상 사실 하나를 잃는 쪽보다 비싸다.
    여기 적힌 문장은 실제로 적합성 진술이지만 그 형태만으로는 극성을 알 수 없다.
    """
    # 무방하다 = 무(無) + 방(妨). 부정 접두사가 부정적 어근에 붙어 긍정이 되는데,
    # 어근의 극성은 형태에 없다. 같은 자리의 무의미·미흡은 부정이다.
    assert is_suitability_statement("민감성 피부에도 무방합니다.") is False
    # 대조 화제로 쓴 긍정 진술. -는은 대상을 갈라놓는 표지라 주의문과 구별되지 않는다.
    assert is_suitability_statement("민감성 피부에는 사용 가능합니다.") is False
    # 서술 핵 자체가 형태적 부정을 쓴 긍정 주장. 어근의 극성은 형태에 없다.
    # 옆에 선 경우(``non-comedogenic and suitable for``)는 핵이 suitable이라 살아남는다.
    assert is_suitability_statement("Non-comedogenic for oily skin.") is False


def test_a_for_adjunct_inside_a_direction_is_not_a_predicative_slot() -> None:
    """NEW-4. 한정어 구간이 전치사를 넘지 못한다 — 앞선 보고의 근거가 틀렸던 자리."""
    assert is_suitability_statement("Leave on for 10 minutes for sensitive skin.") is False
    assert is_suitability_statement("Massage into the skin for 30 seconds.") is False
    # 하이픈은 낱말을 잇는다. customer-decision은 고객을 부르는 것이 아니다.
    assert is_suitability_statement("Regression contracts for evidence-first customer-decision FAQ rows.") is False
    # 계사 뒤에서만 서술 병렬이다. 문두의 같은 꼴은 동사 병렬이고 목적을 말한다.
    assert is_suitability_statement("help rejuvenate and strengthen for healthy, youthful-looking skin") is False


def test_unmarked_lexical_adversity_is_the_recorded_open_class() -> None:
    """이 계약이 닫지 못한다고 기록된 부류를 그대로 고정한다.

    형태에 표지가 없는 어휘적 부정은 I3가 지키라고 한 문장과 형태가 같다 —
    ``위험합니다``와 ``적합합니다``는 둘 다 맨 하다 서술어이고, ``is harsh for``와
    ``is gentle for``는 둘 다 계사+형용사다. 이 부류를 배제하려면 맨 서술어 전체를
    배제해야 하고 그러면 양 로케일의 적합성 판정이 사라진다.

    지시대로 열어 두고 Task 3의 대상 배선이 독립적으로 거부한다. 원하는 동작이 아니라
    **알려진 한계**를 적은 것이므로, 누군가 이 부류를 닫으면 이 테스트가 먼저 알린다.
    """
    assert is_suitability_statement("아토피 피부에 위험합니다.") is True
    assert is_suitability_statement("This is harsh for sensitive skin.") is True
    # N3으로 여기 합류했다. be irritating과 be hydrating은 한 구성이라 극성이 없다.
    assert is_suitability_statement("Can be irritating for sensitive skin.") is True


def test_an_avoidance_or_caution_directive_cannot_be_a_fitness_statement() -> None:
    """피하라고·조심하라고 이르는 문장이 같은 대상에게 권할 수는 없다.

    이 검사만 문장 전체를 읽는다. 지시가 어느 절에 있든 권고를 취소하기 때문이며,
    단정 검사를 문장 전체에 둔 것과 같은 이유다. 어휘 목록이 아니라 지시의 문법으로
    읽는다 — 한국어는 의무 ``-야 하/되``, 금지 ``-지 마``, 필요 ``필요하-``,
    영어는 의무 법조동사와 부정 명령, 그리고 이 계약이 규정하는 행위인 ``use``를
    목적어로 삼는 절머리 낱말이다.
    """
    for text in (
        "아토피 피부에 위험하며 사용을 피해야 합니다.",
        "민감성 피부에 해로우며 주의가 필요합니다.",
        "민감성 피부에 자극적이며 사용을 피해야 합니다.",
        "민감성 피부에 적합하지만 사용을 중단해야 합니다.",
        "민감성 피부에 사용하지 마세요.",
        "Harsh for sensitive skin; discontinue use.",
        "Suitable for sensitive skin; do not use on wounds.",
        "Gentle for sensitive skin; avoid use around the eyes.",
        "Sensitive skin users should patch test before daily use.",
    ):
        assert is_suitability_statement(text) is False, text


def test_the_avoidance_veto_does_not_reach_ordinary_positives() -> None:
    """지시가 없는 문장은 제 값으로 판정된다 — 거부권이 넓어지지 않았다는 증거."""
    for text in (
        "민감성 피부에 적합합니다.",
        "민감성 피부에 적합하며 향료는 넣지 않았습니다.",
        "모든 피부 타입에 사용할 수 있습니다.",
        "민감성 피부에도 사용될 수 있습니다.",
        "This is gentle for sensitive skin.",
        "This is non-comedogenic and suitable for oily skin.",
        "Suitable for sensitive skin; it is unscented.",
        "Can be used daily on dry skin.",
        # 하이픈은 의무 법조동사를 낱말 안에 가둔다.
        "A must-have for dry skin.",
    ):
        assert is_suitability_statement(text) is True, text


def test_a_directive_coordinated_by_a_comma_is_still_a_directive() -> None:
    """쉼표 하나로 판정이 갈리면 그것은 규정이 아니다 — 이 태스크가 없애려는 결함 그 자체다."""
    for text in (
        "Suitable for sensitive skin; discontinue use.",
        "Suitable for sensitive skin, discontinue use.",
        "Gentle for dry skin; stop use if irritation occurs.",
        "Gentle for dry skin, stop use if irritation occurs.",
        # 한국어는 종결 서법이 문장 끝에 오고 적합성 주장은 앞 절에 남는다.
        "민감성 피부에 적합하며 눈에 들어가지 않도록 주의하세요.",
        "민감성 피부에 적합하며 사용 전 전문의와 상담하십시오.",
    ):
        assert is_suitability_statement(text) is False, text


def test_the_avoidance_veto_reads_position_not_vocabulary() -> None:
    """거부권이 낱말의 존재가 아니라 그 낱말이 선 자리에 걸린다."""
    # 필요 서술어는 주어를 본다. 근거를 말하는 문장은 지시가 아니다.
    assert is_suitability_statement("민감성 피부에 적합하며 보습이 필요합니다.") is True
    assert is_suitability_statement("건성 피부에 적합하며 수분 공급이 필요합니다.") is True
    assert is_suitability_statement("민감성 피부에 적합하며 꾸준한 사용이 필요합니다.") is True
    assert is_suitability_statement("민감성 피부에 해로우며 주의가 필요합니다.") is False
    # use가 제 서술을 이끌면 지시받는 대상이 아니라 주어다.
    assert is_suitability_statement("Regular use is suitable for dry skin.") is True
    assert is_suitability_statement("Daily use is suitable for all skin types.") is True
    assert is_suitability_statement("Daily use is enough. Suitable for dry skin.") is True
    # 의무 법조동사는 주어가 독자일 때만 지시한다.
    assert is_suitability_statement("It must be suitable for sensitive skin.") is True
    assert is_suitability_statement("This should be suitable for sensitive skin.") is True
    assert is_suitability_statement("Sensitive skin users should patch test before daily use.") is False
    assert is_suitability_statement("You should avoid use on wounds.") is False


def test_an_obligation_whose_affected_group_trails_by_is_still_a_directive() -> None:
    """수동태는 영향을 받는 부류를 `by`로 뒤에 둔다. 앞자리만 보면 주의가 추천으로 읽힌다."""
    # 임산부가 피해야 한다는 주의가 "적합합니다"로 발행되면 안 된다.
    assert is_suitability_statement("This is suitable for dry skin but should be avoided by pregnant women.") is False
    assert is_suitability_statement("It is suitable for dry skin but must not be used by children.") is False
    assert is_suitability_statement("Gentle for sensitive skin, but should be avoided by pregnant women.") is False
    # 능동태 지시는 종전대로 걸린다.
    assert is_suitability_statement("Sensitive skin users should patch test before daily use.") is False
    # `by`가 영향받는 부류를 데려오지 않으면 의무 법조동사는 제품의 적합을 예측할 뿐이다.
    assert is_suitability_statement("It must be suitable for sensitive skin.") is True
    assert is_suitability_statement("This should be suitable for sensitive skin.") is True


def test_use_as_a_subject_survives_an_appositive_between_it_and_its_predicate() -> None:
    """구두점 하나가 판정을 가르면 그 규칙은 주장이 아니라 어휘를 구속하는 것이다."""
    assert is_suitability_statement("Daily use is suitable for all skin types.") is True
    assert is_suitability_statement("Daily use, twice a day, is suitable for all skin types.") is True
    assert is_suitability_statement("Regular use, morning and night, is suitable for dry skin.") is True
    # 그래도 `use`를 지배하는 동사로 열리는 절은 계속 지시다.
    assert is_suitability_statement("Discontinue use, and rinse with water.") is False
    assert is_suitability_statement("Avoid use on broken skin, then consult a doctor.") is False


def test_a_by_phrase_directs_only_when_it_is_the_agent_of_what_the_modal_governs() -> None:
    """수동태 주의만 지시다. 모달이 명사구를 지배하면 뒤따르는 `by`는 그 행위자가 아니다."""
    # 사회적 증거 문구가 앞선 진짜 적합 진술을 거부하면 안 된다.
    assert (
        is_suitability_statement("This is gentle for sensitive skin and must be the top pick, loved by mothers.")
        is True
    )
    assert (
        is_suitability_statement("This is suitable for dry skin and must be a favorite, recommended by dermatologists.")
        is True
    )
    # 수동태 주의는 계속 거부된다 — 거리가 아니라 문법으로 판정한다.
    assert is_suitability_statement("This is suitable for dry skin but should be avoided by pregnant women.") is False
    assert is_suitability_statement("It is suitable for dry skin but must not be used by children.") is False
    assert (
        is_suitability_statement("This is suitable for dry skin, but it should certainly be avoided by pregnant women.")
        is False
    )


def test_the_use_subject_exception_does_not_stop_at_a_character_count() -> None:
    """동격이 길다고 판정이 뒤집히면 그 규칙은 문법이 아니라 길이를 재는 것이다."""
    assert is_suitability_statement("Daily use, twice a day, is suitable for all skin types.") is True
    assert (
        is_suitability_statement(
            "Daily use, in the morning and at night for best results, is suitable for all skin types."
        )
        is True
    )
    # `use`를 지배하는 동사로 열리는 절은 계속 지시다.
    assert is_suitability_statement("Discontinue use, and rinse with water.") is False


def test_the_by_agent_must_belong_to_the_participle_the_modal_governs() -> None:
    """분사가 있고 뒤 어딘가에 `by`가 있다고 해서 그 둘이 이어진 것은 아니다."""
    # `shaken`은 평범한 사용 지시 분사이고, `loved by mothers`는 무관한 동격이다.
    assert (
        is_suitability_statement(
            "This must be shaken well before use, a cult favorite loved by mothers everywhere, "
            "and is suitable for dry skin."
        )
        is True
    )
    # 행위자가 그 분사에 바로 이어질 때만 지시다.
    assert is_suitability_statement("This is suitable for dry skin but should be avoided by pregnant women.") is False
    assert (
        is_suitability_statement("This is suitable for dry skin, but it should certainly be avoided by pregnant women.")
        is False
    )


def test_a_caution_block_is_not_swept_into_a_procedure_through_this_gate() -> None:
    """이 술어가 절차/적합을 가르므로, 거짓 음성은 주의 문장을 HowTo로 보낸다."""
    assert (
        is_procedural_usage_instruction(
            "Apply a small amount to face and pat gently. This is suitable for dry skin, "
            "but it must be reformulated, a favorite recommended by mothers."
        )
        is False
    )


def test_the_use_subject_exception_survives_a_list_of_appositives() -> None:
    """동격이 하나일 때만 통하면 그것은 여전히 구두점을 세는 규칙이다."""
    assert (
        is_suitability_statement("Daily use, in the morning, in the evening, is suitable for all skin types.") is True
    )
    assert is_suitability_statement("Regular use, morning, noon, and night, is suitable for dry skin.") is True
    assert is_suitability_statement("Daily use, twice a day, is suitable for all skin types.") is True
    assert is_suitability_statement("Discontinue use, and rinse with water.") is False


def test_a_modal_governs_the_participles_coordinated_with_its_own() -> None:
    """쉼표는 지배 관계를 가르지 못한다. 모달이 지배하는 분사인지가 가른다."""
    # 조정된 분사는 모두 모달이 지배한다.
    assert (
        is_suitability_statement(
            "This must be washed, rinsed, and avoided by pregnant women, but is suitable for oily skin."
        )
        is False
    )
    # 삽입구가 사이에 들어와도 행위자는 그 분사의 것이다.
    assert (
        is_suitability_statement(
            "This should be avoided, at least for now, by pregnant women, but is suitable for dry skin."
        )
        is False
    )
    # 모달이 지배하지 않는 분사의 행위자는 지시가 아니다.
    assert (
        is_suitability_statement(
            "This must be shaken well before use, a cult favorite loved by mothers everywhere, "
            "and is suitable for dry skin."
        )
        is True
    )
    assert (
        is_suitability_statement("This is gentle for sensitive skin and must be the top pick, loved by mothers.")
        is True
    )


def test_a_negation_that_denies_fitness_is_read_even_past_a_false_boundary() -> None:
    """부정이 적합 술어를 부정하면 절 경계 탐지가 어긋나도 보여야 한다."""
    # `언제든지`가 연결어미와 같은 음절로 끝나 절이 거기서 끊겼고, 뒤따르는 부정이 가려졌다.
    assert is_suitability_statement("민감성 피부에 언제든지 적합하지 않습니다.") is False
    assert is_suitability_statement("민감성 피부에 잘 맞지 않습니다.") is False
    assert is_suitability_statement("민감성 피부에 적합하지 않을 수 있습니다.") is False
    assert is_suitability_statement("This is not suitable for sensitive skin.") is False


def test_a_topic_standing_before_the_predicate_does_not_hand_the_negation_away() -> None:
    """주제어는 자기 술어를 데려오지 않는다. 대상과 술어 사이에 서도 부정은 적합을 부정한다."""
    # 한국어는 `-에` 대상을 주제어 앞으로 보낼 수 있고, 그때 `이 제품은`은 바로 그
    # 적합 술어의 주어다. 이를 다른 절로 읽으면 배제 대상이 추천으로 발행된다.
    assert is_suitability_statement("민감성 피부에 이 제품은 언제든지 적합하지 않습니다.") is False
    assert is_suitability_statement("건조 피부에 이 제품은 잘 맞지 않습니다.") is False
    # 격조사가 붙은 논항은 자기 술어를 데려오므로 부정은 그쪽에 붙는다.
    assert is_suitability_statement("건조 피부에 적합하며 자극이 발생하지 않습니다.") is True
    assert is_suitability_statement("민감성 피부에 적합하며 인공향을 넣지 않았습니다.") is True
    # 주제어가 서 있어도 긍정 적합은 그대로 산다.
    assert is_suitability_statement("민감성 피부에 이 제품은 적합합니다.") is True


def test_a_negation_about_something_other_than_fitness_leaves_it_standing() -> None:
    """부정이 다른 술어에 붙으면 적합 진술은 그대로다. 문장 전체를 훑으면 이쪽이 깨진다."""
    assert is_suitability_statement("민감성 피부에 적합하며 인공향을 넣지 않았습니다.") is True
    assert is_suitability_statement("민감성 피부에 적합하고 무겁지 않습니다.") is True
    assert is_suitability_statement("건조 피부에 적합하며 자극이 발생하지 않습니다.") is True
    assert is_suitability_statement("This is suitable for dry skin but does not contain fragrance.") is True
    # 긍정 적합은 계속 산다.
    assert is_suitability_statement("민감성 피부에 적합합니다.") is True
    assert is_suitability_statement("This is gentle for sensitive skin.") is True


def test_an_audience_is_named_apart_from_the_predicate_that_judges_it() -> None:
    """누구를 가리키는지와 그가 적합한지는 다른 물음이다. 추천을 원문과 대조하려면 앞의 것이 필요하다."""
    assert audience_designations("건조 피부 또는 민감 피부에 추천하는 클렌징 폼입니다.") == ["건조 피부", "민감 피부"]
    assert audience_designations("민감한 피부라면 고려할 수 있습니다.") == ["민감한 피부"]
    # 대상 없이 표면만 말한 문장에서는 아무도 지목되지 않는다. 격조사를 단 앞말은
    # 제 구를 닫으므로 수식어가 아니다.
    assert audience_designations("이 제품은 피부에 순합니다.") == []
    assert audience_designations("Apply three pumps with your fingertips.") == []
    # 수식어를 단 표면은 그대로 돌려준다. 그것이 대상인지 자리인지는 적합 술어가
    # 정하고, 이 함수는 그 앞에서 멈춘다.
    assert audience_designations("Apply three pumps to damp skin.") == ["damp skin"]
    assert audience_designations("It is suitable for dry skin.") == ["dry skin"]
    # 접속된 수식어는 뒤따르는 머리명사를 함께 받는다. 이 패키지에는 그 접속을
    # 가를 형태소 분석이 없어 인접한 것만 돌려준다 — 확인 범위를 좁힐 뿐,
    # 없는 대상을 지어내지는 않는다.
    assert audience_designations("지성이거나 민감한 피부라면") == ["민감한 피부"]

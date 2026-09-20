"""Whose voice a FAQ question is in, read by what the question does.

A question is the customer's when it states the reader's own situation.  That
used to be recognized only by a list of concern nouns, so a question that
stated its purpose in any other words read as an analyst's.  A measured subject
is exactly that case: a page measures what the product removes or protects, a
buyer searches for it, and none of it is a concern noun.  The same list problem
returned one ending lower down -- an occasion was recognized by the verbs
written in front of ``때``, so ``고를 때`` was not one.

The analyst's question is the other half, and it was read by where its words
stood rather than by what they asked about: the guard was anchored to the start
of a sentence, so putting a customer in front of a source heading made it a
customer's question.  It was then read by its predicate alone, which is the
same list problem once more and failing in both directions at once: an ordinary
product question became the analyst's whenever its verb happened to be on the
list, and an analyst's question bound as a customer's whenever its verb was
not.  These keep the two voices apart by what the text does -- name the reader,
state a purpose, condition, wish or occasion, or ask after a record somebody
kept -- and not by which words it chose or where it put them.
"""

from __future__ import annotations

import pytest

from pdp_geo_generator_agent.content_planning import _admission_is_customer_decision_question
from pdp_geo_generator_agent.contracts.customer_situation import (
    asks_what_the_source_recorded,
    states_a_customer_situation,
)
from pdp_geo_generator_agent.final_proofreader import _faq_membership_question_evidence

_PRODUCT = {"name": "SampleDerma BarrierCare365 클렌징폼 200g", "brand": "SAMPLE_DERMA"}
_EN_PRODUCT = {"name": "SAMPLE_DERMA BarrierCare365 Cleansing Foam 200g", "brand": "SAMPLE_DERMA"}


@pytest.mark.parametrize(
    ("locale", "text"),
    [
        ("ko-KR", "색조 메이크업을 세정하기 좋은 제품이 있을까요?"),
        ("ko-KR", "미세먼지를 씻어내기 편한 클렌저를 찾고 있어요."),
        ("ko-KR", "장기적인 탄력 관리가 목표라면"),
        ("ko-KR", "아침 세안을 간단히 하려면 어떤 제품이 좋을까요?"),
        ("ko-KR", "짙은 화장을 지우고 싶을 때 쓸 제품"),
        ("ko-KR", "건조한 피부에 맞는 제품"),
        ("en-US", "Which cleanser is best for removing long-wear makeup?"),
        ("en-US", "If I wear heavy makeup all day, what should I cleanse with?"),
        ("en-US", "for dry skin"),
    ],
)
def test_a_stated_purpose_or_reader_is_a_customer_situation(locale: str, text: str) -> None:
    """독자를 가리키거나 목적·조건·바람·상황을 서술하면 고객의 상황이다."""

    assert states_a_customer_situation(text, locale) is True


@pytest.mark.parametrize(
    ("locale", "text"),
    [
        ("ko-KR", "전성분이 나열되어 있나요?"),
        ("ko-KR", "이 제품의 평점은 몇 점인가요?"),
        ("ko-KR", "용량은 몇 g인가요?"),
        ("ko-KR", "제조국은 어디인가요?"),
        ("en-US", "What is the net weight?"),
        ("en-US", "Which ingredients are listed?"),
        ("en-US", "What does the page state about the study?"),
    ],
)
def test_a_source_field_question_states_no_customer_situation(locale: str, text: str) -> None:
    """원문 항목을 묻는 질문에는 독자의 상황이 없다."""

    assert states_a_customer_situation(text, locale) is False


@pytest.mark.parametrize(
    ("locale", "product", "question"),
    [
        ("ko-KR", _PRODUCT, "색조 메이크업을 세정하기 좋은 추천 제품이 있을까요?"),
        (
            "en-US",
            _EN_PRODUCT,
            "Which cleanser would you recommend for removing long-wear makeup?",
        ),
    ],
    ids=("ko-KR", "en-US"),
)
def test_a_measured_subject_may_be_the_situation_a_question_starts_from(
    locale: str, product: dict[str, str], question: str
) -> None:
    """측정 대상으로 시작한 질문도 고객 결정 질문으로 수락된다."""

    assert _admission_is_customer_decision_question(question, product, locale) is True


@pytest.mark.parametrize(
    ("locale", "product", "question"),
    [
        ("ko-KR", _PRODUCT, "어떤 성분인가요?"),
        ("ko-KR", _PRODUCT, "이 제품의 평점은 몇 점인가요?"),
        ("en-US", _EN_PRODUCT, "Which ingredients are listed?"),
        ("en-US", _EN_PRODUCT, "What is the rating?"),
    ],
)
def test_an_analyst_question_is_still_refused(locale: str, product: dict[str, str], question: str) -> None:
    """상황이 없는 분석가의 질문은 여전히 기각된다."""

    assert _admission_is_customer_decision_question(question, product, locale) is False


def _safety_question_scope(locale: str, name: str) -> list[dict[str, object]]:
    first, second = (
        ("피부과 테스트 완료", "인체 안자극 테스트 완료")
        if locale == "ko-KR"
        else ("Dermatologist tested", "Ophthalmologist tested")
    )
    def atom(identifier: str, role: str, text: str, source_path: str) -> dict[str, object]:
        return {
            "id": identifier,
            "role": role,
            "text": text,
            "sourcePath": source_path,
            "locale": locale,
            "productScope": "product",
            "confidence": 1,
        }
    return [
        atom("ev-brand", "identity", "SAMPLE_DERMA", "product.brand"),
        atom("ev-identity", "identity", name, "product.name"),
        atom("ev-safety-0", "safety", first, "product.semanticFacts.safetyTests[0]"),
        atom("ev-safety-1", "safety", second, "product.semanticFacts.safetyTests[1]"),
    ]


@pytest.mark.parametrize(
    ("locale", "name", "question"),
    [
        (
            "ko-KR",
            "SampleDerma BarrierCare365 젠틀 포밍클렌저",
            "세안 전 완료된 테스트를 확인하고 싶을 때 어떤 클렌징폼이 맞을까요?",
        ),
        (
            "ko-KR",
            "SampleDerma BarrierCare365 젠틀 포밍클렌저",
            "자극 테스트 여부를 확인하고 싶다면 어떤 제품이 해당하나요?",
        ),
        (
            "en-US",
            "Barrier Cleansing Foam",
            "Which cleansing foam has completed a dermatologist test?",
        ),
    ],
)
def test_a_question_choosing_any_product_form_binds_to_its_card(
    locale: str, name: str, question: str
) -> None:
    """어떤 상품 형태를 고르는 질문이든 그 카드의 근거에 결속된다."""

    scope = _safety_question_scope(locale, name)
    card = {"id": "faq-safety-1", "evidenceIds": [item["id"] for item in scope]}

    assert _faq_membership_question_evidence(question, scope, faq_card=card) != []


@pytest.mark.parametrize(
    ("locale", "name", "question"),
    [
        ("en-US", "Barrier Cleansing Foam", "Which ingredients are listed?"),
        ("ko-KR", "SampleDerma BarrierCare365 젠틀 포밍클렌저", "성분은 무엇인가요?"),
    ],
)
def test_a_source_heading_question_still_binds_to_nothing(locale: str, name: str, question: str) -> None:
    """원문 표제를 되읊은 질문은 여전히 아무 근거에도 결속되지 않는다."""

    scope = _safety_question_scope(locale, name)
    card = {"id": "faq-safety-1", "evidenceIds": [item["id"] for item in scope]}

    assert _faq_membership_question_evidence(question, scope, faq_card=card) == []


@pytest.mark.parametrize(
    "text",
    [
        "아침저녁 매일 쓰는 세안제를 고를 때",
        "메이크업을 깨끗하게 지우고 싶은 경우",
        "짙은 화장을 지울 때",
        "외출 후 세안할 경우",
    ],
)
def test_an_occasion_is_read_from_its_adnominal_ending_not_from_its_verb(text: str) -> None:
    """``때``·``경우`` 앞의 관형형 어미가 상황을 표시한다. 그 어미를 짊어진 동사는 글쓴이의 것이다."""

    assert states_a_customer_situation(text, "ko-KR") is True


@pytest.mark.parametrize(
    "question",
    [
        "For dry skin, which ingredients are listed on the PDP?",
        "Which source field lists the rating?",
        "어떤 효과가 표기되어 있나요?",
        "어느 섹션에 성분이 나열되어 있나요?",
        "평점은 어느 정도인가요?",
    ],
)
def test_a_source_question_is_read_wherever_it_stands(question: str) -> None:
    """원문이 무엇을 적어 두었는지 묻는 질문은 문두가 아닌 자리에서도 원문의 질문이다."""

    assert asks_what_the_source_recorded(question) is True


@pytest.mark.parametrize(
    "question",
    [
        "Which cleansing foam has completed a dermatologist test?",
        "세안 전 완료된 테스트를 확인하고 싶을 때 어떤 클렌징폼이 맞을까요?",
        "자극 테스트 여부를 확인하고 싶다면 어떤 제품이 해당하나요?",
        "Which cleanser is best for removing long-wear makeup?",
    ],
)
def test_asking_what_the_product_itself_did_is_not_a_source_question(question: str) -> None:
    """상품이 스스로 한 일을 묻는 질문은 기록 행위를 묻는 것이 아니다."""

    assert asks_what_the_source_recorded(question) is False


@pytest.mark.parametrize(
    ("locale", "name", "question"),
    [
        ("en-US", "Barrier Cleansing Foam", "For dry skin, which ingredients are listed on the PDP?"),
        ("en-US", "Barrier Cleansing Foam", "Which source field lists the rating?"),
        ("ko-KR", "SampleDerma BarrierCare365 젠틀 포밍클렌저", "어떤 효과가 표기되어 있나요?"),
        ("ko-KR", "SampleDerma BarrierCare365 젠틀 포밍클렌저", "어느 섹션에 성분이 나열되어 있나요?"),
        ("ko-KR", "SampleDerma BarrierCare365 젠틀 포밍클렌저", "평점은 어느 정도인가요?"),
    ],
)
def test_a_customer_in_front_of_a_source_heading_binds_to_nothing(
    locale: str, name: str, question: str
) -> None:
    """고객을 앞세운 원문 표제도 아무 근거에 결속되지 않는다."""

    scope = _safety_question_scope(locale, name)
    card = {"id": "faq-safety-1", "evidenceIds": [item["id"] for item in scope]}

    assert _faq_membership_question_evidence(question, scope, faq_card=card) == []


# Eight ordinary product questions whose predicate stood on the inscription
# list, and five analyst questions whose predicate did not.  The list decided
# both wrongly, so the acts are now read only in the record's own voice.
_PRODUCT_QUESTIONS_WITH_AN_INSCRIPTION_VERB = [
    "When you want to support skin firmness and elasticity while improving radiance, "
    "which serum provides that support?",
    "When you want to support skin firmness and elasticity while improving radiance, "
    "which serum shows that benefit?",
    "When you want to support skin firmness and elasticity while improving radiance, "
    "which serum describes that benefit?",
    "Which cleanser provides gentle care for sensitive skin?",
    "Which moisturizer shows visible results on dry skin?",
    "Which cream lists ceramide among its key ingredients?",
    "민감한 피부 고민을 기록하고 나면 어떤 클렌저가 맞을까요?",
    "피부 타입을 표시하고 제품을 고를 때 어떤 클렌징폼이 맞을까요?",
]
_RECORD_QUESTIONS_THE_VERB_LIST_MISSED = [
    "어떤 성분이 수록되어 있나요?",
    "어떤 사용법이 안내되어 있나요?",
    "어떤 주의사항이 고지되어 있나요?",
    "What does the label declare?",
    "Which ingredients are disclosed in full?",
]


@pytest.mark.parametrize("question", _PRODUCT_QUESTIONS_WITH_AN_INSCRIPTION_VERB)
def test_an_active_predicate_reports_its_own_subject_and_not_the_record(question: str) -> None:
    """상품이 주어인 능동 술어는 상품이 한 일을 말한다. 낱말이 목록에 있다고 원문의 질문이 되지 않는다."""

    assert asks_what_the_source_recorded(question) is False


@pytest.mark.parametrize("question", _RECORD_QUESTIONS_THE_VERB_LIST_MISSED)
def test_an_act_nobody_performed_is_the_records_own_voice(question: str) -> None:
    """행위자가 없는 기록 상태와 기록의 부분은 목록에 없던 낱말이어도 원문의 질문이다."""

    assert asks_what_the_source_recorded(question) is True


@pytest.mark.parametrize("question", _RECORD_QUESTIONS_THE_VERB_LIST_MISSED)
def test_a_record_question_the_verb_list_missed_binds_to_nothing(question: str) -> None:
    """목록이 놓쳤던 원문의 질문도 이제 아무 근거에 결속되지 않는다."""

    scope = _safety_question_scope("ko-KR", "SampleDerma BarrierCare365 젠틀 포밍클렌저")
    card = {"id": "faq-safety-1", "evidenceIds": [item["id"] for item in scope]}

    assert _faq_membership_question_evidence(question, scope, faq_card=card) == []


@pytest.mark.parametrize(
    ("locale", "name", "question"),
    [
        (
            "ko-KR",
            "SampleDerma BarrierCare365 젠틀 포밍클렌저",
            "세안할 때 눈가 자극 부담을 고려해 클렌저를 고를 때, "
            "SampleDerma BarrierCare365 젠틀 포밍클렌저는 어떤 테스트를 완료했나요?",
        ),
        (
            "en-US",
            "BarrierCare365 Cleansing Foam",
            "For sensitive skin, which BarrierCare365 Cleansing Foam test has been completed?",
        ),
    ],
)
def test_a_digit_in_the_products_own_name_does_not_measure_anything(
    locale: str, name: str, question: str
) -> None:
    """상품 이름이 지닌 숫자는 측정값이 아니다. 이름을 부른 질문이 그 때문에 끊기지 않는다."""

    scope = _safety_question_scope(locale, name)
    card = {"id": "faq-safety-1", "evidenceIds": [item["id"] for item in scope]}

    assert _faq_membership_question_evidence(question, scope, faq_card=card) != []


@pytest.mark.parametrize(
    ("locale", "name", "question"),
    [
        (
            "ko-KR",
            "SampleDerma BarrierCare365 젠틀 포밍클렌저",
            "민감한 피부라면 99.9% 저자극인 어떤 제품이 맞을까요?",
        ),
        (
            "en-US",
            "BarrierCare365 Cleansing Foam",
            "For sensitive skin, which cleanser is 99.9% gentle?",
        ),
    ],
)
def test_a_digit_no_name_carries_still_has_to_be_recorded(
    locale: str, name: str, question: str
) -> None:
    """어느 이름도 지니지 않은 숫자는 여전히 기록을 요구한다."""

    scope = _safety_question_scope(locale, name)
    card = {"id": "faq-safety-1", "evidenceIds": [item["id"] for item in scope]}

    assert _faq_membership_question_evidence(question, scope, faq_card=card) == []

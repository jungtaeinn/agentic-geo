"""Completed-test and certification evidence contracts."""

from __future__ import annotations

import re
from collections.abc import Sequence

from neo_js_compat import js_code_unit_length
from pdp_geo_eval_agent.contracts import contains_serialized_metadata

from .sentence_form import is_atomic_fact_phrase
from .usage import clean_usage_text

_QUANTIFIED_RESULT_PATTERN = re.compile(r"(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*배)")
_CLINICAL_CONTEXT_PATTERN = re.compile(
    r"(?:임상|인체\s*적용|자가\s*평가|소비자\s*평가|시험|테스트|결과|clinical|study|self[-\s]?assessment|instrumental|participants?|subjects?|women|men|users?)",
    re.IGNORECASE,
)
_CERTIFICATION_SPLITTER = re.compile(r"\s*,\s*|[.。]\s*|\s+[-–—]\s+|;\s*")
_ENGLISH_CERTIFICATION_PATTERN = re.compile(
    r"(?:use\s*suitability|skin\s*irritation|low\s*irritation|dermatolog|hypoallergenic|non[-\s]?comedogenic|tested)",
    re.IGNORECASE,
)
_COMPLETED_TEST_TOKEN_PATTERN = re.compile(r"\btest(?:ed|ing|s)?\b", re.IGNORECASE)


def is_quantified_clinical_result_sentence(value: str) -> bool:
    """Return whether a sentence is measured efficacy evidence, not certification."""
    text = clean_usage_text(value)
    return _QUANTIFIED_RESULT_PATTERN.search(text) is not None and _CLINICAL_CONTEXT_PATTERN.search(text) is not None


def select_atomic_functional_certification_values(value: str, locale: str) -> list[str]:
    """Extract explicitly completed, short certification facts from mixed text."""
    if locale == "ko-KR":
        text = re.sub(r"\s+", " ", value).strip()
        has_sensitive_irritation = (
            re.search(r"민감\s*피부\s*(?:대상\s*)?(?:피부\s*)?자극\s*테스트\s*완료", text) is not None
        )
        values: tuple[tuple[bool, str], ...] = (
            (re.search(r"극민감\s*(?:피부\s*)?테스트\s*완료", text) is not None, "극민감 피부 테스트 완료"),
            (has_sensitive_irritation, "민감 피부 자극 테스트 완료"),
            (re.search(r"피부과\s*테스트\s*완료", text) is not None, "피부과 테스트 완료"),
            (
                re.search(r"여드름성\s*피부\s*사용\s*적합\s*테스트\s*완료", text) is not None,
                "여드름성 피부 사용 적합 테스트 완료",
            ),
            (
                re.search(r"알러지\s*테스트\s*완료", text) is not None
                and re.search(r"하이포\s*알러지\s*테스트\s*완료", text) is None,
                "알러지 테스트 완료",
            ),
            (re.search(r"인체\s*안자극\s*테스트\s*완료", text) is not None, "인체 안자극 테스트 완료"),
            (re.search(r"소아과\s*피부\s*테스트\s*완료", text) is not None, "소아과 피부 테스트 완료"),
            (re.search(r"피부\s*내성\s*테스트\s*완료", text) is not None, "피부 내성 테스트 완료"),
            (
                re.search(r"민감\s*성?\s*피부\s*사용\s*적합\s*테스트\s*완료", text) is not None,
                "민감성 피부 사용 적합 테스트 완료",
            ),
            (
                re.search(r"민감\s*피부\s*대상\s*사용성\s*테스트\s*완료", text) is not None,
                "민감 피부 대상 사용성 테스트 완료",
            ),
            (
                re.search(r"민감\s*피부\s*대상\s*피부\s*자극\s*테스트\s*완료", text) is not None,
                "민감 피부 대상 피부 자극 테스트 완료",
            ),
            (
                not has_sensitive_irritation and re.search(r"피부\s*자극\s*테스트\s*완료", text) is not None,
                "피부 자극 테스트 완료",
            ),
            (re.search(r"저자극\s*테스트\s*완료", text) is not None, "저자극 테스트 완료"),
            (re.search(r"안\s*자극\s*대체\s*시험\s*완료", text) is not None, "안자극 대체 시험 완료"),
            (
                re.search(r"하이포\s*알러(?:지|제닉)\s*테스트\s*완료", text) is not None
                or re.search(r"하이포알러(?:지|제닉)\s*테스트\s*완료", text) is not None,
                "하이포알러제닉 테스트 완료",
            ),
            (re.search(r"논코메도제닉\s*테스트\s*완료", text) is not None, "논코메도제닉 테스트 완료"),
        )
        return [canonical for matched, canonical in values if matched]

    candidates = (clean_usage_text(item) for item in _CERTIFICATION_SPLITTER.split(value))
    return [
        item
        for item in candidates
        if item
        and _ENGLISH_CERTIFICATION_PATTERN.search(item) is not None
        and _COMPLETED_TEST_TOKEN_PATTERN.search(item) is not None
        and not is_quantified_clinical_result_sentence(item)
        and not contains_serialized_metadata(item)
        and is_atomic_fact_phrase(item)
    ]


def restates_typed_field_as_raw_transcription(value: str, typed_facts: Sequence[str]) -> bool:
    """Return whether longer raw text merely repeats a typed certification fact."""
    text = clean_usage_text(value)
    if not text or is_quantified_clinical_result_sentence(text):
        return False
    return any(
        fact in text and js_code_unit_length(text) > js_code_unit_length(fact) * 2
        for raw_fact in typed_facts
        if (fact := clean_usage_text(raw_fact)) and js_code_unit_length(fact) >= 2
    )


isQuantifiedClinicalResultSentence = is_quantified_clinical_result_sentence
selectAtomicFunctionalCertificationValues = select_atomic_functional_certification_values
restatesTypedFieldAsRawTranscription = restates_typed_field_as_raw_transcription
containsSerializedMetadata = contains_serialized_metadata


__all__ = [
    "contains_serialized_metadata",
    "containsSerializedMetadata",
    "is_quantified_clinical_result_sentence",
    "isQuantifiedClinicalResultSentence",
    "restates_typed_field_as_raw_transcription",
    "restatesTypedFieldAsRawTranscription",
    "select_atomic_functional_certification_values",
    "selectAtomicFunctionalCertificationValues",
]

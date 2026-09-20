"""Ports of the six two-reading OCR verification cases."""

from __future__ import annotations

from pdp_extractor_agent.ocr.pipeline import reconcile_ocr_readings

FIRST = "철저히 검증한 피부 안전성 테스트 피부과 테스트 휘경보건 피부과에서 48시간 패치를 활용한 자극여부 확인 22.12.19-22.12.22, 32명 대상"
SECOND = "철저히 검증한 피부 안전성 테스트 피부과 테스트 대학병원 피부과에서 48시간 패치를 활용한 자극여부 확인 22.12.19-22.12.22, 32명 대상"


def test_drops_a_proper_noun_the_two_readings_disagree_on() -> None:
    text, dropped = reconcile_ocr_readings(FIRST, SECOND)
    assert "휘경보건" not in text
    assert "휘경보건" in " ".join(dropped)


def test_keeps_tokens_that_both_readings_agree_on() -> None:
    text, _ = reconcile_ocr_readings(FIRST, SECOND)
    assert "피부과 테스트" in text
    assert "48시간 패치를 활용한 자극여부 확인" in text
    assert "32명 대상" in text


def test_keeps_an_identical_reading_untouched() -> None:
    assert reconcile_ocr_readings(SECOND, SECOND) == (SECOND, [])


def test_tolerates_harmless_spacing_and_line_break_differences() -> None:
    text, dropped = reconcile_ocr_readings(
        "피부과  테스트\n대학병원 피부과에서 48시간 패치", "피부과 테스트 대학병원 피부과에서 48시간 패치"
    )
    assert dropped == []
    assert text == "피부과 테스트\n대학병원 피부과에서 48시간 패치"
    assert "대학병원" in text


def test_keeps_first_reading_when_documents_are_unrelated() -> None:
    assert reconcile_ocr_readings(FIRST, "전혀 다른 구간의 성분 설명과 사용법 안내가 담긴 문장입니다") == (FIRST, [])


def test_caps_repeated_tokens_to_the_shared_multiplicity() -> None:
    assert reconcile_ocr_readings("세라마이드 세라마이드 캡슐", "세라마이드 캡슐")[0] == "세라마이드 캡슐"

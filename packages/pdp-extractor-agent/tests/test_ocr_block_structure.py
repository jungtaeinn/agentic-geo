"""Ports of the legacy OCR block structure examples (7 cases)."""

from __future__ import annotations

from pdp_extractor_agent.ocr.blocks import parse_ocr_block_sections


def test_splits_korean_summary_into_heading_and_numbered_items() -> None:
    assert parse_ocr_block_sections(
        "효능\n1\n약산성 아미노산 유래\n세정 성분으로 장벽 손상 방어\n2\n가벼운 메이크업 세정력"
    ) == [
        {
            "heading": "효능",
            "items": [
                {"ordinal": 1, "text": "약산성 아미노산 유래 세정 성분으로 장벽 손상 방어"},
                {"ordinal": 2, "text": "가벼운 메이크업 세정력"},
            ],
        }
    ]


def test_keeps_numbered_usage_steps_separate() -> None:
    sections = parse_ocr_block_sections(
        "사용법\n1\n젖은 손에 적당량을 덜어\n충분히 거품을 내주세요.\n2\n얼굴에 부드럽게 롤링하여\n미온수로 깨끗이 씻어줍니다."
    )
    assert sections[0]["items"] == [
        {"ordinal": 1, "text": "젖은 손에 적당량을 덜어 충분히 거품을 내주세요."},
        {"ordinal": 2, "text": "얼굴에 부드럽게 롤링하여 미온수로 깨끗이 씻어줍니다."},
    ]


def test_heading_shaped_line_starts_a_new_section() -> None:
    sections = parse_ocr_block_sections("효능\n장벽 손상 방어\n핵심 성분\n세라마이드")
    assert [section.get("heading") for section in sections] == ["효능", "핵심 성분"]


def test_numbered_section_resumes_after_peripheral_text() -> None:
    sections = parse_ocr_block_sections("사용법\n1\n아침에 사용합니다.\nSAMPLE_DERMA\n2\n저녁에 사용합니다.")
    assert sections[0]["items"] == [
        {"ordinal": 1, "text": "아침에 사용합니다."},
        {"ordinal": 2, "text": "저녁에 사용합니다."},
    ]


def test_splits_english_three_section_summary() -> None:
    sections = parse_ocr_block_sections(
        "BENEFITS\n1\nMildly acidic amino-acid derived\ncleansing agents guard the barrier\n2\nLight makeup cleansing power\nKEY INGREDIENTS\nBarrier Protective Formula\n(Panthenol, Betaine, DermaON)\nRECOMMENDED FOR\nDry or sensitive skin"
    )
    assert sections == [
        {
            "heading": "BENEFITS",
            "items": [
                {"ordinal": 1, "text": "Mildly acidic amino-acid derived cleansing agents guard the barrier"},
                {"ordinal": 2, "text": "Light makeup cleansing power"},
            ],
        },
        {"heading": "KEY INGREDIENTS", "items": [{"text": "Barrier Protective Formula (Panthenol, Betaine, DermaON)"}]},
        {"heading": "RECOMMENDED FOR", "items": [{"text": "Dry or sensitive skin"}]},
    ]


def test_keeps_each_numbered_english_usage_step_separate() -> None:
    sections = parse_ocr_block_sections(
        "HOW TO USE\n1\nDispense an appropriate amount\nonto wet hands and lather.\n2\nGently roll over the face\nthen rinse with lukewarm water."
    )
    assert sections == [
        {
            "heading": "HOW TO USE",
            "items": [
                {"ordinal": 1, "text": "Dispense an appropriate amount onto wet hands and lather."},
                {"ordinal": 2, "text": "Gently roll over the face then rinse with lukewarm water."},
            ],
        }
    ]


def test_does_not_read_a_running_english_sentence_as_heading() -> None:
    assert "heading" not in parse_ocr_block_sections("Clinically tested for sensitive skin\nDermatologist tested")[0]


def test_recognizes_title_case_product_section_labels_without_misreading_a_clause() -> None:
    assert parse_ocr_block_sections(
        "Benefits\nBarrier support improves hydration\nHow to Use\nApply nightly after toner"
    ) == [
        {"heading": "Benefits", "items": [{"text": "Barrier support improves hydration"}]},
        {"heading": "How to Use", "items": [{"text": "Apply nightly after toner"}]},
    ]


def test_keeps_heading_immediate_short_children_as_section_items() -> None:
    """A title-shaped first child cannot replace the section that owns it."""

    assert parse_ocr_block_sections(
        "BENEFITS\nVisible Results\nSkin appears smoother and more hydrated after use.\n"
        "HOW TO USE\nGentle Application\nApply nightly after toner."
    ) == [
        {
            "heading": "BENEFITS",
            "items": [
                {"text": "Visible Results"},
                {"text": "Skin appears smoother and more hydrated after use."},
            ],
        },
        {
            "heading": "HOW TO USE",
            "items": [
                {"text": "Gentle Application"},
                {"text": "Apply nightly after toner."},
            ],
        },
    ]

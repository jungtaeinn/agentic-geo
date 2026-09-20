"""Behavioral port of ``image-sections.test.ts``."""

from __future__ import annotations

import importlib


def _image_sections():
    return importlib.import_module("pdp_geo_eval_agent.citation.image_sections")


def test_groups_published_sentences_by_image_url_with_sentence_provenance_precedence() -> None:
    module = _image_sections()

    sections = module.build_image_attributable_sections(
        [
            {
                "fieldPath": "HowTo.step[0].text",
                "text": "세안 후 얼굴 전체에 분사합니다. 건조할 때 수시로 사용합니다.",
                "imageUrls": ["https://cdn.example.com/usage.png"],
                "sentences": [
                    {"text": "세안 후 얼굴 전체에 분사합니다.", "imageUrls": ["https://cdn.example.com/usage.png"]},
                    {"text": "건조할 때 수시로 사용합니다."},
                ],
            },
            {
                "fieldPath": "Product.description",
                "sentences": [
                    {"text": "세라마이드 10,000ppm을 함유했습니다.", "imageUrls": ["https://cdn.example.com/metric.png"]},
                    {"text": "48시간 패치 테스트를 완료했습니다.", "imageUrls": ["https://cdn.example.com/metric.png"]},
                ],
            },
        ]
    )

    assert [section.id for section in sections] == [
        "https://cdn.example.com/usage.png",
        "https://cdn.example.com/metric.png",
    ]
    assert sections[0].text == "세안 후 얼굴 전체에 분사합니다."
    assert "세라마이드 10,000ppm" in sections[1].text
    assert "48시간 패치" in sections[1].text


def test_falls_back_to_entry_image_urls_when_no_sentence_has_image_lineage() -> None:
    module = _image_sections()

    sections = module.build_image_attributable_sections(
        [
            {
                "fieldPath": "HowTo.step[1].text",
                "text": "흔들지 않고 사용합니다.",
                "imageUrls": ["https://cdn.example.com/usage.png"],
            }
        ]
    )

    assert [(section.id, section.text) for section in sections] == [
        ("https://cdn.example.com/usage.png", "흔들지 않고 사용합니다.")
    ]


def test_deduplicates_repeated_sentences_and_skips_entries_without_images() -> None:
    module = _image_sections()

    sections = module.build_image_attributable_sections(
        [
            {"fieldPath": "Product.description", "text": "이미지 근거 없음 문장."},
            {
                "fieldPath": "FAQPage.mainEntity[0].acceptedAnswer.text",
                "sentences": [
                    {"text": "동일 문장.", "imageUrls": ["https://cdn.example.com/a.png"]},
                    {"text": "동일 문장.", "imageUrls": ["https://cdn.example.com/a.png"]},
                ],
            },
        ]
    )

    assert [(section.id, section.text) for section in sections] == [("https://cdn.example.com/a.png", "동일 문장.")]

"""Numbered usage-sequence recovery contracts (2 legacy counterparts)."""

from __future__ import annotations

import pytest

from pdp_extractor_agent.ocr.pipeline import extract_numbered_usage_steps
from pdp_extractor_agent.providers.mock import MockKeywordClassifier
from pdp_extractor_agent.service import extract_product_from_html


def test_recovers_explicit_korean_numbered_spray_steps_without_package_noise() -> None:
    text = "CREAM MIST 사용법 1 연약하고 건조해진 피부 부위에 미세 분사를 합니다. 2 피부에 건조함이 느껴질 때 수시로 뿌려줍니다. CREAM MIST"
    assert extract_numbered_usage_steps(text) == [
        "1. 연약하고 건조해진 피부 부위에 미세 분사를 합니다.",
        "2. 피부에 건조함이 느껴질 때 수시로 뿌려줍니다.",
    ]


def test_recovers_english_numbered_steps_in_source_order() -> None:
    assert extract_numbered_usage_steps("How to use: 1 Apply after toner. 2 Massage until absorbed.") == [
        "1. Apply after toner.",
        "2. Massage until absorbed.",
    ]


def test_recovers_inline_ritual_steps_in_source_order() -> None:
    assert extract_numbered_usage_steps(
        "RITUAL: Step 1: After serum, warm a pearl-sized amount between your palms. "
        "Step 2: Press the cream gently over the face and neck."
    ) == [
        "1. After serum, warm a pearl-sized amount between your palms.",
        "2. Press the cream gently over the face and neck.",
    ]


def test_recovers_inline_ritual_steps_after_intro_in_source_order() -> None:
    assert extract_numbered_usage_steps(
        "RITUAL Experience the age-old benefits of this rich cream ritual. "
        "Step 1: After serum, warm a pearl-sized amount between your palms. "
        "Step 2: Press the cream gently over the face and neck."
    ) == [
        "1. After serum, warm a pearl-sized amount between your palms.",
        "2. Press the cream gently over the face and neck.",
    ]


def test_keeps_long_packaging_preamble_out_of_generic_step_recovery() -> None:
    assert extract_numbered_usage_steps(
        "DIRECTIONS Read the package storage and recycling information before opening. "
        "Step 1: Keep the carton upright. Step 2: Recycle the carton."
    ) == []


@pytest.mark.asyncio
async def test_html_extraction_keeps_every_source_owned_ocr_usage_step() -> None:
    """The extractor wire must not truncate a valid long numbered procedure."""

    source_steps = " ".join(f"{number}. Apply layer {number} after toner." for number in range(1, 14))
    run = await extract_product_from_html(
        f'<main><h1>Sequence Serum</h1><img src="https://cdn.example.test/ritual.png" data-ocr-text="How to use: {source_steps}" /></main>',
        "https://brand.example.test/products/sequence-serum",
    )
    product = run.result["geoProduct"]

    expected = [f"{number}. Apply layer {number} after toner." for number in range(1, 14)]
    assert product["usage"] == expected
    assert product["semanticFacts"]["usageSteps"] == expected
    assert product["sourceExtraction"]["ocr"]["semanticFacts"]["usageSteps"] == expected


@pytest.mark.asyncio
async def test_html_sections_keep_more_than_twelve_source_owned_usage_steps() -> None:
    """DOM section collection must not impose a hidden public HowTo cap."""

    expected = [f"{number}. Apply layer {number} after toner." for number in range(1, 14)]
    html = "".join(
        f"<section><h2>How to use</h2><p>{step}</p></section>" for step in expected
    )
    run = await extract_product_from_html(
        f"<main><h1>Sequence Serum</h1>{html}</main>",
        "https://brand.example.test/products/sequence-serum",
    )

    assert run.result["geoProduct"]["usage"] == expected


@pytest.mark.asyncio
async def test_mock_classifier_keeps_every_numbered_usage_step_in_source_order() -> None:
    """The deterministic classifier cannot silently remove a late HowTo step."""

    expected = [f"{number}. Apply layer {number} after toner." for number in range(1, 14)]
    result = await MockKeywordClassifier().classify_keywords(
        {
            "imageTexts": [
                {
                    "imageUrl": "https://cdn.example.test/long-ritual.png",
                    "text": "How to use: " + " ".join(expected),
                }
            ]
        }
    )

    assert [insight["text"] for insight in result["sentenceInsights"]] == expected
    assert result["semanticFacts"]["usageSteps"] == expected


@pytest.mark.asyncio
async def test_mock_classifier_keeps_more_than_eighteen_source_insights_in_order() -> None:
    """A long source panel remains intact rather than stopping at an arbitrary insight count."""

    expected = [f"Barrier hydration result {number}." for number in range(1, 21)]
    result = await MockKeywordClassifier().classify_keywords(
        {
            "imageTexts": [
                {
                    "imageUrl": "https://cdn.example.test/long-benefits.png",
                    "text": " ".join(expected),
                }
            ]
        }
    )

    assert [insight["text"] for insight in result["sentenceInsights"]] == expected
    assert result["semanticFacts"]["benefits"] == expected
    assert result["semanticFacts"]["evidenceSentences"] == expected


@pytest.mark.asyncio
async def test_mock_classifier_preserves_source_safety_tests_without_efficacy_reclassification() -> None:
    """Provider output keeps safety source facts out of benefit/effect/usage buckets."""

    source_safety = [
        "CAUTION: Avoid use if irritation occurs.",
        "Dermatologist-tested for sensitive skin.",
        "피부 안전성 테스트에서 자극 완화 효과를 확인했습니다.",
        "주의: 이상 반응이 있으면 사용을 중지하십시오.",
    ]

    response = await MockKeywordClassifier().classify_keywords(
        {"imageTexts": [{"text": "\n".join(source_safety)}]}
    )

    facts = response["semanticFacts"]
    assert facts["safetyTests"] == source_safety
    assert not facts["benefits"]
    assert not facts["effects"]
    assert not facts["usageSteps"]
    assert not response["sentenceInsights"]

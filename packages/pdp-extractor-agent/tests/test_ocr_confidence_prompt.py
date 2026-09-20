"""OCR confidence prompt propagation (2 legacy counterparts)."""

from __future__ import annotations

import math

import pytest

from pdp_extractor_agent.ocr.prompt import (
    create_image_ocr_prompt,
    create_keyword_classification_prompt,
    create_keyword_classification_prompt_parts,
)

REQUEST = {
    "source": "https://example.com/product",
    "productName": "Capsule Toner",
    "imageTexts": [
        {
            "imageUrl": "https://example.com/detail.png#ocr-slice-4of10",
            "text": "After 3 days 320; after 7 days 200",
            "confidence": 0.42,
        },
        {"imageUrl": "https://example.com/detail.png#ocr-slice-1of10", "text": "Barrier moisture capsule toner"},
    ],
}


def test_annotates_each_evidence_block_with_transcription_confidence_when_present() -> None:
    prompt = create_keyword_classification_prompt_parts(REQUEST)
    assert "Evidence 1 (transcription confidence: 0.42)" in prompt["user"]
    assert "Evidence 2:" in prompt["user"]
    assert "Evidence 2 (transcription confidence" not in prompt["user"]


@pytest.mark.parametrize(
    ("confidence", "expected"),
    (
        (1.125, "1.13"),
        (-0.0, "0.00"),
        (math.nan, "NaN"),
        (math.inf, "Infinity"),
    ),
)
def test_confidence_label_uses_javascript_to_fixed_two_decimal_rules(confidence: float, expected: str) -> None:
    """Python's formatter differs from Number#toFixed at ties, signed zero, and non-finite values."""

    prompt = create_keyword_classification_prompt_parts(
        {"imageTexts": [{"imageUrl": "https://example.com/detail.png", "text": "Evidence", "confidence": confidence}]}
    )

    assert f"transcription confidence: {expected}" in prompt["user"]


def test_instructs_classifier_to_treat_low_confidence_numeric_evidence_as_unreliable() -> None:
    prompt = create_keyword_classification_prompt_parts(REQUEST)
    assert "transcription confidence" in prompt["system"]
    assert "metricClaims" in prompt["system"]


def test_declares_safety_tests_as_a_source_grounded_semantic_fact() -> None:
    prompt = create_keyword_classification_prompt_parts(REQUEST)
    assert '"safetyTests":[""]' in prompt["system"]
    assert "safetyTests preserve explicit safety tests and cautions" in prompt["system"]


def test_freezes_the_complete_policy_bearing_ocr_and_classification_prompt_contracts() -> None:
    parts = create_keyword_classification_prompt_parts(
        {
            **REQUEST,
            "analysisPrompt": "Do not turn delivery copy into evidence.",
            "ragDocuments": [{"name": "rules.md", "content": "Keep only source-backed product facts."}],
        }
    )
    image_prompt = create_image_ocr_prompt(
        {"source": "https://example.com/product", "productName": "Capsule Toner", "imageUrls": ["https://img.test/a.png"]}
    )

    assert '"source":"llm"' in parts["system"]
    assert "For sentenceInsights, return source-backed semantic evidence statements" in parts["system"]
    assert "Classify before/after-use measurement rows" in parts["system"]
    assert "If runtime RAG guidance conflicts with the JSON schema" in parts["system"]
    assert "Runtime RAG profile. Treat these instructions" in parts["system"]
    assert create_keyword_classification_prompt({**REQUEST, "analysisPrompt": "policy"}) == (
        "System instructions:\n\n" + create_keyword_classification_prompt_parts({**REQUEST, "analysisPrompt": "policy"})["system"]
        + "\n\nUser evidence:\n\n"
        + create_keyword_classification_prompt_parts({**REQUEST, "analysisPrompt": "policy"})["user"]
    )
    assert "small, blurry, or partially cropped text lowers it" in image_prompt
    assert "Every image is a set of groups of lines" in image_prompt
    assert "lines[].pairedLabel" in image_prompt

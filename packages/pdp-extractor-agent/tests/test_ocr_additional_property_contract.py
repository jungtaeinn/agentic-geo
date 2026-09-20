"""OCR role boundaries that keep schema property inputs concise and grounded."""

from __future__ import annotations

from collections.abc import Mapping

import pytest

from pdp_extractor_agent.service import extract_product_from_html


@pytest.mark.asyncio
async def test_local_ocr_routes_direct_audience_away_from_benefits_and_rejects_a_dangling_effect_fragment() -> None:
    """A target-skin statement and a partial OCR line must not inflate efficacy properties."""

    audience = "건조 피부 또는 민감 피부에 추천됩니다."
    benefit = "세안 후 약해진 피부장벽과 건조함을 즉시 케어합니다."
    fragment = "세안 후 약해진 피부장벽을 강화하고 피부결을 정돈해"
    source = "\n".join((audience, benefit, fragment))

    run = await extract_product_from_html(
        f'<main><h1>Barrier Toner</h1><img src="https://images.example.test/detail.png" '
        f'data-ocr-text="{source}" /></main>',
        "https://example.test/products/barrier-toner",
        {"provider": "mock"},
    )

    product = run.result["geoProduct"]
    ocr = product["sourceExtraction"]["ocr"]
    facts = ocr["semanticFacts"]

    assert facts["skinTypes"] == ["건조 피부", "민감 피부"]
    assert audience not in facts["benefits"]
    assert audience not in facts["effects"]
    assert benefit in facts["benefits"]
    assert fragment not in facts["benefits"]
    assert fragment not in facts["effects"]
    assert fragment not in facts["ingredients"]
    assert fragment not in facts["usageSteps"]
    assert any(fragment in text for text in ocr["textBlocks"])  # raw OCR remains auditable evidence


@pytest.mark.asyncio
async def test_local_ocr_splits_a_flattened_safety_panel_into_direct_source_facts() -> None:
    """Flattened safety panes stay grounded without becoming one public schema-sized value."""

    safety_panel = (
        "/ 300 mL 철저히 검증한 피부 안전성 테스트 "
        "HYPERSENSITIVE SKIN TESTED 테스트 완료 "
        "SENSITIVE SKIN PANEL TESTED 민감 피부 자극 테스트 완료 "
        "DERMATOLOGIST TESTED 피부과 테스트 완료 "
        "ALLERGY TESTED 알러지 테스트 완료 "
        "NON-COMEDOGENIC TESTED 여드름성 피부 사용 적합 테스트 완료"
    )

    class ProviderSpy:
        async def extract_image_text(self, request: Mapping[str, object]) -> dict[str, object]:
            return {
                "images": [
                    {"imageUrl": image_url, "text": safety_panel}
                    for image_url in request["imageUrls"]  # type: ignore[index]
                ]
            }

        async def classify_keywords(self, _request: Mapping[str, object]) -> dict[str, object]:
            # This is the same shape a semantic provider emits for a flattened
            # panel: compact labels plus the raw OCR evidence delivered above.
            return {
                "keywords": [],
                "sentenceInsights": [],
                "semanticFacts": {
                    "safetyTests": [
                        "HYPERSENSITIVE SKIN TESTED",
                        "SENSITIVE SKIN PANEL TESTED",
                        "DERMATOLOGIST TESTED",
                        "ALLERGY TESTED",
                        "NON-COMEDOGENIC TESTED",
                    ]
                },
            }

    run = await extract_product_from_html(
        '<main><h1>Barrier Toner</h1><img src="https://images.example.test/safety.png" /></main>',
        "https://example.test/products/barrier-toner",
        {"provider": "openai", "provider_client": ProviderSpy()},
    )

    product = run.result["geoProduct"]
    facts = product["sourceExtraction"]["ocr"]["semanticFacts"]

    assert facts["safetyTests"] == [
        "HYPERSENSITIVE SKIN TESTED 테스트 완료",
        "SENSITIVE SKIN PANEL TESTED 민감 피부 자극 테스트 완료",
        "DERMATOLOGIST TESTED 피부과 테스트 완료",
        "ALLERGY TESTED 알러지 테스트 완료",
        "NON-COMEDOGENIC TESTED 여드름성 피부 사용 적합 테스트 완료",
    ]
    assert safety_panel in facts["evidenceSentences"]
    assert safety_panel not in facts["safetyTests"]
    assert not product["benefits"]
    assert not product["effects"]
    assert not product["ingredients"]
    assert not product["usage"]

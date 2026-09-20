from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Mapping
from typing import Any, NoReturn

import pytest
from neo_agent_api.services.generation import GenerationService
from neo_agent_api.services.ocr_enrichment import OcrEnrichmentService
from neo_agent_api.services.product_sanitizer import sanitize_product_html
from neo_agent_api.services.queue import GeoQueue, GeoQueueJob
from neo_agent_api.services.schema_types import compute_result_hash, derive_schema_types
from pdp_geo_generator_agent.normalization import normalize_pdp_product


async def test_queue_retries_at_the_front_before_existing_waiters() -> None:
    queue = GeoQueue(concurrency=1, max_attempts=2, backoff_ms=1)
    seen: list[tuple[str, int]] = []
    release_waiting = asyncio.Event()

    async def handler(job: GeoQueueJob) -> None:
        generation_id = str(job.data["geoGenerationId"])
        seen.append((generation_id, job.attempts_made))
        if generation_id == "retry" and job.attempts_made == 0:
            raise RuntimeError("transient")
        if generation_id == "waiting":
            await release_waiting.wait()

    queue.set_handler(handler)
    await queue.add({"geoGenerationId": "retry", "locale": "ko-KR", "product": {}})
    await queue.add({"geoGenerationId": "waiting", "locale": "ko-KR", "product": {}})
    await asyncio.sleep(0.01)
    await queue.add({"geoGenerationId": "tail", "locale": "ko-KR", "product": {}})
    release_waiting.set()
    await asyncio.sleep(0.05)

    assert seen == [("retry", 0), ("waiting", 0), ("retry", 1), ("tail", 0)]
    await queue.shutdown()


async def test_queue_tracks_backoff_for_dedup_and_discards_waiting_work_on_shutdown() -> None:
    queue = GeoQueue(concurrency=1, max_attempts=2, backoff_ms=100)
    attempts: list[int] = []

    async def handler(job: GeoQueueJob) -> None:
        attempts.append(job.attempts_made)
        raise RuntimeError("fail")

    queue.set_handler(handler)
    await queue.add({"geoGenerationId": "same", "locale": "ko-KR", "product": {}})
    await asyncio.sleep(0.01)
    await queue.add({"geoGenerationId": "same", "locale": "ko-KR", "product": {}})
    await queue.shutdown()
    await asyncio.sleep(0.12)

    assert attempts == [0]


def test_schema_hash_sorts_object_keys_but_preserves_array_order() -> None:
    assert (
        compute_result_hash({"b": {"z": 1, "a": 2}, "a": ["first", "second"]})
        == hashlib.sha256(b'{"a":["first","second"],"b":{"a":2,"z":1}}').hexdigest()
    )
    assert derive_schema_types({"@graph": [{"@type": "Product"}, {"@type": ["WebPage", "Product"]}]}) == [
        "Product",
        "WebPage",
    ]


def test_schema_hash_uses_javascript_number_and_property_enumeration_rules() -> None:
    assert compute_result_hash({"value": 1.0}) == "48208f9428d64634bd8e28ff345bf0eab60d53c18fa2fbdb0b9bc1e84df2b5f6"
    assert compute_result_hash({"10": "ten", "2": "two", "01": "leading"}) == (
        "ad4027e5ffdcdac0d2a1f9b9d6221a8cd1617dcbbc2bb36378d808974a0d6e60"
    )


def test_product_sanitizer_is_copy_on_write_and_removes_only_noise_blocks() -> None:
    product = {"description": '<p>Serum</p><style>.x{}</style><!-- note --><script>x()</script><img alt="keep">'}

    sanitized = sanitize_product_html(product)

    assert product["description"].startswith("<p>Serum</p><style>")
    assert sanitized["description"] == '<p>Serum</p><img alt="keep">'


async def test_ocr_enrichment_rejects_private_targets_and_downgrades_provider_failure_to_warning() -> None:
    async def failing_extractor(_request: Mapping[str, Any], _options: Mapping[str, Any]) -> NoReturn:
        raise RuntimeError("provider down")

    service = OcrEnrichmentService(extract_image_ocr_evidence=failing_extractor)
    product = {"ocrImages": ["http://127.0.0.1/x.png", "https://cdn.example.com/x.png"]}
    outcome = await service.enrich(product, None)

    assert product == {"ocrImages": ["http://127.0.0.1/x.png", "https://cdn.example.com/x.png"]}
    assert outcome["performed"] is False
    assert outcome["diagnostics"]["excludedTargets"] == [
        {"url": "http://127.0.0.1/x.png", "reason": "private-or-local-address"}
    ]
    assert outcome["warnings"] == ["1 target(s) skipped by URL policy", "provider down"]


async def test_ocr_enrichment_matches_the_existing_ocr_and_contract_alias_rules() -> None:
    service = OcrEnrichmentService()

    existing = await service.enrich(
        {"ocrImages": ["https://cdn.example.com/x.png"], "ocr": {"sentenceInsights": [{"text": "already"}]}},
        None,
    )
    invalid = await service.enrich({"ocrImages": "https://cdn.example.com/x.png"}, None)
    geo_invalid = await service.enrich({"geoProduct": {"ocrImages": ["ok", 1]}}, None)

    assert existing["skippedReason"] == "existing-ocr"
    assert invalid["warnings"] == ["ocrImages contract violation: expected string[] (ocrImages)"]
    assert geo_invalid["warnings"] == ["ocrImages contract violation: expected string[] (geoProduct.ocrImages)"]


async def test_ocr_enrichment_keeps_existing_wrapped_ocr_in_the_generator_namespace() -> None:
    """A wrapped extractor payload must not re-run OCR or lose its OCR evidence."""

    calls: list[Mapping[str, Any]] = []

    async def extractor(request: Mapping[str, Any], _options: Mapping[str, Any]) -> Mapping[str, Any]:
        calls.append(request)
        return {"ocr": {"imageTexts": [{"text": "duplicate"}]}, "diagnostics": {"warnings": []}}

    image_url = "https://cdn.example.com/clinical-panel.png"
    source_text = "Ceramide formula supports hydration after four weeks."
    product = {
        "geoProduct": {
            "name": "Wrapper Serum",
            "ocrImages": [image_url],
            "sourceExtraction": {
                "ocr": {
                    "imageTexts": [{"imageUrl": image_url, "confidence": 0.91, "text": source_text}],
                    "textBlocks": [source_text],
                    "sentenceInsights": [
                        {
                            "text": source_text,
                            "category": "ingredient",
                            "keywords": ["Ceramide formula"],
                            "imageUrls": [image_url],
                        }
                    ],
                    "semanticFacts": {"ingredients": ["Ceramide formula"]},
                }
            },
        }
    }

    outcome = await OcrEnrichmentService(extract_image_ocr_evidence=extractor).enrich(product, None)
    normalized = normalize_pdp_product(outcome["product"])

    assert outcome["performed"] is False
    assert outcome["skippedReason"] == "existing-ocr"
    assert calls == []
    assert normalized["product"]["semanticFacts"]["ingredients"] == ["Ceramide formula"]
    assert normalized["product"]["sourceTextMeta"][source_text] == {
        "imageUrls": [image_url],
        "ocrConfidence": 0.91,
    }


async def test_ocr_enrichment_writes_new_ocr_inside_a_wrapped_generator_payload() -> None:
    """A wrapper's generated OCR must remain below geoProduct for normalization."""

    image_url = "https://cdn.example.com/usage-panel.png"
    source_text = "After cleansing, apply one pump and press gently until absorbed."

    async def extractor(_request: Mapping[str, Any], _options: Mapping[str, Any]) -> Mapping[str, Any]:
        return {
            "ocr": {
                "imageTexts": [{"imageUrl": image_url, "confidence": 0.88, "text": source_text}],
                "textBlocks": [source_text],
                "sentenceInsights": [
                    {"text": source_text, "category": "usage", "imageUrls": [image_url]}
                ],
                "semanticFacts": {"usageSteps": [source_text]},
            },
            "diagnostics": {"warnings": []},
        }

    product = {"geoProduct": {"name": "Wrapper Serum", "ocrImages": [image_url]}}
    outcome = await OcrEnrichmentService(extract_image_ocr_evidence=extractor).enrich(product, None)
    enriched = outcome["product"]
    normalized = normalize_pdp_product(enriched)

    assert outcome["performed"] is True
    assert enriched["geoProduct"]["sourceExtraction"]["ocr"]["textBlocks"] == [source_text]
    assert "sourceExtraction" not in enriched
    assert normalized["product"]["usage"] == [source_text]
    assert normalized["product"]["sourceTextMeta"][source_text] == {
        "imageUrls": [image_url],
        "ocrConfidence": 0.88,
    }


async def test_generation_keeps_generator_validation_warnings_separate_from_ocr_result_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Enrichment:
        async def enrich(self, product: object, source_url: str | None) -> dict[str, Any]:
            del source_url
            return {
                "product": product,
                "warnings": ["image OCR provider unavailable"],
                "diagnostics": {"performed": False, "warnings": ["image OCR provider unavailable"]},
            }

    async def generate(_request: Mapping[str, Any], _runtime: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "result": {
                "schemaMarkup": {"jsonLd": {"@type": "Product"}, "scriptTag": "<script/>"},
                "diagnostics": {"validationWarnings": ["schema warning"]},
                "content": {"sections": {"productName": "Serum"}},
                "ragProfile": "profile@1",
                "generatedAt": "2026-09-10T00:00:00.000Z",
            },
            "diagnostics": {"validationWarnings": ["schema warning"]},
        }

    monkeypatch.setattr("neo_agent_api.services.generation.generate_pdp_geo", generate)
    artifact = await GenerationService(Enrichment(), runtime={"provider": "mock"}).generate(
        {"geoGenerationId": "id", "locale": "ko-KR", "product": {"name": "Serum"}}
    )

    assert artifact["resultStatus"] == "SUCCEEDED_WITH_WARNINGS"
    assert artifact["diagnostics"]["validationWarnings"] == ["schema warning"]
    assert artifact["diagnostics"]["ocrEnrichment"]["performed"] is False

"""Frozen Node v24 contracts for public validation and RAG cap boundaries."""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any, cast

import httpx
from neo_js_compat import js_code_unit_length, js_utf8_replacement_text
from pytest import MonkeyPatch

import pdp_geo_generator_agent.rag.retrieval as retrieval
from pdp_geo_generator_agent.rag.retrieval import FetchRagUrlResolver
from pdp_geo_generator_agent.validation import (
    apply_safe_public_copy_repairs,
    validate_and_repair_pdp_geo_artifacts,
    validate_pdp_geo_artifacts,
)

_FIXTURE_PATH = Path(__file__).with_name("fixtures") / "generator-validation-rag-parity.v1.json"
_TASK8E_FIXTURE_PATH = Path(__file__).with_name("fixtures") / "generator-task8e-source-contract-v1.json"


def _fixture() -> dict[str, Any]:
    value: dict[str, Any] = json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))
    return value


def _task8e_fixture() -> dict[str, Any]:
    value: dict[str, Any] = json.loads(_TASK8E_FIXTURE_PATH.read_text(encoding="utf-8"))
    return value


def _sections(how_to_use: str = "Apply the product.") -> dict[str, str]:
    return {
        "productName": "Test Serum",
        "description": "Test Serum description.",
        "quickFacts": "Quick fact.",
        "benefits": "Benefit.",
        "ingredients": "Ingredient.",
        "howToUse": how_to_use,
        "faq": "Q. Question?\nA. Answer.",
    }


def _safe_input() -> dict[str, Any]:
    return {
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [
                    0,
                    {},
                    {"@type": "Organization", "name": "Unchanged organization"},
                    {
                        "@type": "Product",
                        "name": "Product name",
                        "description": "Product description.",
                        "additionalProperty": [
                            7,
                            {},
                            {"@type": "PropertyValue", "name": "Texture", "value": "Smooth texture."},
                        ],
                    },
                ],
            },
            "scriptTag": '<script type="application/ld+json">old</script>',
        },
        "content": {"sections": _sections(), "html": "<article>caller-rendered</article>"},
        "fallbackProductName": "Test Serum",
        "fallbackDescription": "Test Serum description.",
        "locale": "en-US",
    }


def _read_only_input() -> dict[str, Any]:
    return {
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [
                    {"@type": "Product", "name": "Test Serum", "description": "Test Serum description."},
                    {"@type": "MedicalEntity", "name": "Medical claim"},
                ],
            },
            "scriptTag": "",
        },
        "content": {"sections": _sections(), "html": "<article>read-only</article>"},
        "fallbackProductName": "Test Serum",
        "fallbackDescription": "Test Serum description.",
        "locale": "en-US",
    }


def _korean_how_to_input() -> dict[str, Any]:
    steps = [
        "적당량을 손바닥에 덜어 거품내어 줍니다",
        "적당량을 덜어 거품을 냅니다",
        "얼굴에 마사지하듯 문지릅니다",
        "미온수로 깨끗하게 헹굽니다",
        "얼굴에 마사지합니다",
    ]
    return {
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [
                    {
                        "@type": "Product",
                        "@id": "https://catalog.example/kr/products/gentle-foam-cleanser#product",
                        "name": "DemoDerma Gentle Foam Cleanser",
                        "description": "건조하고 민감한 피부를 위한 저자극 포밍 클렌저입니다.",
                    },
                    {
                        "@type": "HowTo",
                        "@id": "https://catalog.example/kr/products/gentle-foam-cleanser#how-to-use",
                        "name": "DemoDerma Gentle Foam Cleanser 사용 방법",
                        "inLanguage": "ko-KR",
                        "about": {"@id": "https://catalog.example/kr/products/gentle-foam-cleanser#product"},
                        "step": [
                            {"@type": "HowToStep", "position": index, "name": f"{index}단계", "text": text}
                            for index, text in enumerate(steps, start=1)
                        ],
                    },
                ],
            },
            "scriptTag": "",
        },
        "content": {"sections": _sections("\n".join(f"{index}. {text}" for index, text in enumerate(steps, start=1))), "html": ""},
        "fallbackProductName": "DemoDerma Gentle Foam Cleanser",
        "fallbackDescription": "건조하고 민감한 피부를 위한 저자극 포밍 클렌저입니다.",
        "locale": "ko-KR",
    }


def _task8e_validation_input() -> dict[str, Any]:
    product_id = "https://catalog.example/kr/products/dew-capsule-toner#product"
    marketing_copy = (
        "피부 장벽 유사 성분을 담은 캡슐 민감 피부 고보습 장벽 토너 바르는 순간 개운한 ‘보습 장벽’ 케어 "
        "무너진 피부장벽과 속건조 개선에 도움 피부 장벽 유사 성분을 담은 캡슐 토너 세라마이드 캡슐 세라마이드"
    )
    sensory_copy = "산뜻한 마무리감과 부드러운 피부결 사용감을 제공합니다"
    json_ld: dict[str, Any] = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "Product",
                "@id": product_id,
                "name": "DemoDerma Dew Capsule Toner",
                "description": "건조하거나 민감한 피부를 위한 장벽 보습 캡슐 토너입니다.",
                "image": [
                    "https://assets.example/images/dew-capsule-toner-incomplete.",
                    "https://assets.example/images/dew-capsule-toner.webp",
                ],
            },
            {
                "@type": "FAQPage",
                "@id": "https://catalog.example/kr/products/dew-capsule-toner#faq",
                "inLanguage": "ko-KR",
                "mainEntity": [
                    {
                        "@type": "Question",
                        "name": "캡슐은 어떤 방식으로 토너에 포함되나요?",
                        "acceptedAnswer": {
                            "@type": "Answer",
                            "text": "동일 여부는 현재 제품 정보만으로 확인하기 어렵습니다. DemoDerma Dew Capsule Toner는 PHA 워터에 띄워진 수분 베이스에 캡슐형 보습 성분을 담은 토너입니다.",
                        },
                    },
                    {
                        "@type": "Question",
                        "name": "동일 여부를 확인할 수 있나요?",
                        "acceptedAnswer": {
                            "@type": "Answer",
                            "text": "동일 여부는 현재 제품 정보만으로 확인하기 어렵습니다.",
                        },
                    },
                ],
            },
            {
                "@type": "HowTo",
                "@id": "https://catalog.example/kr/products/dew-capsule-toner#how-to-use",
                "inLanguage": "ko-KR",
                "step": [
                    {"@type": "HowToStep", "position": 1, "name": "1단계", "text": marketing_copy},
                    {"@type": "HowToStep", "position": 2, "name": "2단계", "text": sensory_copy},
                    {
                        "@type": "HowToStep",
                        "position": 3,
                        "name": "3단계",
                        "text": "손바닥에 적당량을 덜어 피부결을 따라 부드럽게 펴 바릅니다",
                    },
                ],
            },
        ],
    }
    return {
        "schemaMarkup": {
            "jsonLd": json_ld,
            "scriptTag": f'<script type="application/ld+json">{json.dumps(json_ld, ensure_ascii=False, indent=2)}</script>',
        },
        "content": {
            "html": "",
            "sections": {
                "productName": "DemoDerma Dew Capsule Toner",
                "description": "건조하거나 민감한 피부를 위한 장벽 보습 캡슐 토너입니다.",
                "quickFacts": "제품 유형: 캡슐 토너",
                "benefits": "장벽 보습",
                "ingredients": "고밀도 세라마이드 캡슐",
                "howToUse": f"1. {marketing_copy}\n2. {sensory_copy}\n3. 손바닥에 적당량을 덜어 피부결을 따라 부드럽게 펴 바릅니다",
                "faq": "",
            },
        },
        "fallbackProductName": "DemoDerma Dew Capsule Toner",
        "fallbackDescription": "건조하거나 민감한 피부를 위한 장벽 보습 캡슐 토너입니다.",
        "locale": "ko-KR",
    }


def _node_utf8_sha256(value: str) -> str:
    return hashlib.sha256(js_utf8_replacement_text(value).encode("utf-8")).hexdigest()


def _resolve_public_text(monkeypatch: MonkeyPatch, value: str, seen_read: list[str] | None = None) -> dict[str, Any]:
    """Exercise the public resolver while observing its bounded stream input."""

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"Content-Type": "text/plain"}, text=value)

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_with_transport(*, timeout: float, follow_redirects: bool = True) -> httpx.AsyncClient:
        return original_client(timeout=timeout, follow_redirects=follow_redirects, transport=transport)

    monkeypatch.setattr(httpx, "AsyncClient", client_with_transport)
    if seen_read is not None:
        def capture_read_text(candidate: object) -> str:
            text = candidate if isinstance(candidate, str) else ""
            seen_read.append(text)
            return text

        monkeypatch.setattr(retrieval, "_preserve_markdown_text", capture_read_text)
    resolved = asyncio.run(FetchRagUrlResolver({"urlFetchTimeoutMs": 500}).resolve({"url": "https://public.example/"}))
    assert resolved is not None
    return resolved


def test_source_fixture_records_public_validation_rag_provenance() -> None:
    fixture = _fixture()
    provenance: dict[str, Any] = fixture["provenance"]

    assert provenance == {
        "capture": "agentic-geo-public-validation-rag-parity-v1",
        "runtime": "Python deterministic validator",
    }


def test_safe_public_repair_preserves_non_record_graph_and_property_values() -> None:
    fixture = _fixture()["safe"]
    input_ = _safe_input()
    result = apply_safe_public_copy_repairs(input_)

    assert input_["content"]["html"] == fixture["callerHtml"]
    assert result["content"]["html"] == fixture["callerHtml"]
    assert result["schemaMarkup"]["jsonLd"]["@graph"] == fixture["expectedGraph"]
    assert hashlib.sha256(result["schemaMarkup"]["scriptTag"].encode("utf-8")).hexdigest() == fixture["scriptTagSha256"]


def test_read_only_validation_reports_empty_script_and_unsupported_type_without_mutation() -> None:
    fixture = _fixture()["readOnly"]
    input_ = _read_only_input()
    original = json.loads(json.dumps(input_, ensure_ascii=False))

    result = validate_pdp_geo_artifacts(input_)

    assert input_ == original
    assert result["validationWarnings"] == fixture["warnings"]
    assert [finding["field"] for finding in result["validationFindings"]] == fixture["findingFields"]


def test_full_validation_matches_source_korean_how_to_semantic_dedupe_and_sync() -> None:
    fixture = _fixture()["koreanHowTo"]
    result = validate_and_repair_pdp_geo_artifacts(_korean_how_to_input())
    graph = cast(list[dict[str, Any]], result["schemaMarkup"]["jsonLd"]["@graph"])
    how_to = next(node for node in graph if node.get("@type") == "HowTo")

    assert how_to["step"] == fixture["steps"]
    assert result["content"]["sections"]["howToUse"] == fixture["howToUse"]


def test_rag_public_resolver_uses_source_utf16_read_and_output_caps_for_astral_text(monkeypatch: MonkeyPatch) -> None:
    expected_read = _fixture()["ragUtf16"]["responseEmoji"]
    expected_output = _fixture()["ragUtf16"]["outputEmoji"]
    seen_read: list[str] = []
    resolved = _resolve_public_text(monkeypatch, "😀" * 100_000, seen_read)
    assert seen_read
    value = seen_read[-1]

    content = cast(str, resolved["content"])
    assert len(value) == expected_read["codePoints"]
    assert js_code_unit_length(value) == expected_read["codeUnits"]
    assert _node_utf8_sha256(value) == expected_read["sha256"]
    assert len(content) == expected_output["codePoints"]
    assert js_code_unit_length(content) == expected_output["codeUnits"]
    assert _node_utf8_sha256(content) == expected_output["sha256"]


def test_rag_public_resolver_preserves_source_utf16_read_split_boundary(monkeypatch: MonkeyPatch) -> None:
    rag = _fixture()["ragUtf16"]
    seen_read: list[str] = []
    _resolve_public_text(monkeypatch, ("A" * 179_999) + "😀", seen_read)
    response_value = seen_read[-1]

    assert len(response_value) == rag["responseSplit"]["codePoints"]
    assert js_code_unit_length(response_value) == rag["responseSplit"]["codeUnits"]
    assert response_value.endswith(chr(0xD83D))
    assert _node_utf8_sha256(response_value) == rag["responseSplit"]["sha256"]


def test_rag_public_resolver_preserves_source_utf16_output_split_boundary(monkeypatch: MonkeyPatch) -> None:
    rag = _fixture()["ragUtf16"]
    resolved = _resolve_public_text(monkeypatch, ("A" * 39_999) + "😀")
    content = cast(str, resolved["content"])
    assert len(content) == rag["outputSplit"]["codePoints"]
    assert js_code_unit_length(content) == rag["outputSplit"]["codeUnits"]
    assert content.endswith(chr(0xD83D))
    assert _node_utf8_sha256(content) == rag["outputSplit"]["sha256"]


def test_task8e_source_fixture_records_validation_contract_provenance() -> None:
    fixture = _task8e_fixture()
    provenance = cast(dict[str, Any], fixture["provenance"])

    assert provenance == {
        "capture": "agentic-geo-public-synthetic-validation-v1",
        "runtime": "Python deterministic validator",
    }


def test_task8e_full_and_read_only_validation_match_source_repair_candidates() -> None:
    fixture = _task8e_fixture()["validation"]
    full_expected = cast(dict[str, Any], fixture["full"])
    full = validate_and_repair_pdp_geo_artifacts(_task8e_validation_input())

    assert full["schemaMarkup"]["jsonLd"]["@graph"] == full_expected["graph"]
    assert full["content"] == full_expected["content"]
    assert full["validationRepairs"] == full_expected["repairs"]
    assert full["validationWarnings"] == full_expected["warnings"]

    read_only_expected = cast(dict[str, Any], fixture["readOnly"])
    input_ = _task8e_validation_input()
    original = json.loads(json.dumps(input_, ensure_ascii=False))
    read_only = validate_pdp_geo_artifacts(input_)

    assert input_ == original
    assert read_only["validationFindings"] == read_only_expected["findings"]
    assert read_only["validationWarnings"] == read_only_expected["warnings"]

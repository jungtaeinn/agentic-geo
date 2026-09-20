"""Frozen native-stage prompt contracts captured from the legacy Node runtime."""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast

import httpx
import pytest
from neo_js_compat import js_code_unit_length, js_utf8_replacement_text

from pdp_geo_generator_agent import (
    content_planning,
    copy_refiner,
    final_proofreader,
    keyword_normalizer,
    product_normalizer,
)
from pdp_geo_generator_agent.providers import OpenAIProvider

_FIXTURE_PATH = Path(__file__).with_name("fixtures") / "legacy-stage-prompts-v1.json"
_TASK8E_FIXTURE_PATH = Path(__file__).with_name("fixtures") / "generator-task8e-source-contract-v1.json"


def _product() -> dict[str, object]:
    return {
        "name": "Glow Barrier Serum",
        "originalName": "Glow Barrier Serum 30 mL",
        "description": "Glow Barrier Serum supports hydration for dry skin.",
        "brand": "Neo",
        "category": "Serum",
        "images": [],
        "options": [{"name": "30 mL", "price": -0.0, "currency": "USD"}],
        "benefits": ["hydration", "comfort"],
        "effects": ["skin feels comfortable"],
        "ingredients": ["Ceramide", "Niacinamide"],
        "usage": ["Apply one pump after cleansing."],
        "metrics": ["1e-6 precise marker"],
        "faq": [{"question": "Who is it for?", "answer": "For dry skin."}],
        "reviews": {
            "rating": 4.8,
            "reviewCount": 4,
            "items": [{"body": "Lightweight and comfortable.", "rating": 5}],
            "keywords": ["hydration", "lone\ud800"],
        },
        "breadcrumbs": [],
        "sourceTexts": [
            "Glow Barrier Serum supports hydration for dry skin.",
            "Apply one pump after cleansing.",
            "Ceramide supports the moisture barrier.",
        ],
        "semanticFacts": {
            "ingredients": ["Ceramide", "Niacinamide"],
            "benefits": ["hydration"],
            "effects": ["skin feels comfortable"],
            "skinTypes": ["dry skin"],
            "usageSteps": ["Apply one pump after cleansing."],
            "safetyTests": ["Dermatologically tested."],
            "metricClaims": [
                {
                    "label": "hydration",
                    "subject": "skin",
                    "value": 4,
                    "unit": "%",
                    "metric": "hydration",
                    "direction": "increase",
                    "timing": "after one use",
                    "sourceText": "Hydration increased by 4%.",
                }
            ],
            "evidenceSentences": ["Hydration increased by 4%."],
            "ingredientBenefitLinks": [
                {"ingredient": "Ceramide", "benefit": "hydration", "sentence": "Ceramide supports hydration."}
            ],
            "citations": [
                {"type": "article", "title": "Barrier article", "publisher": "Neo Lab", "finding": "Hydration context."}
            ],
        },
    }


def _product_request(product: Mapping[str, object]) -> dict[str, object]:
    return {
        "rawProduct": {
            "10": "ten",
            "2": "two",
            "numeric": -0.0,
            "tiny": 1e-6,
            "huge": 1e20,
            "nonfinite": float("nan"),
            "lone": "x\ud800",
            "product": dict(product),
        },
        "bootstrapProduct": dict(product),
        "source": {"url": "https://neo.example/products/glow"},
        "hints": {"brand": "Neo", "schemaTargets": ["Product", "WebPage"]},
        "fieldMapping": {"benefits": "marketing.benefits"},
        "locale": "en-US",
        "market": "US",
        "analysisPrompt": "Use only product evidence.",
        "ragDocuments": [{"name": "policy.md", "version": "v1", "content": "Policy guidance for the current product."}],
    }


def _copy_request(product: Mapping[str, object]) -> dict[str, object]:
    return {
        "product": dict(product),
        "locale": "en-US",
        "market": "US",
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [
                    {
                        "@type": "Product",
                        "@id": "urn:product",
                        "name": product["name"],
                        "description": product["description"],
                        "additionalProperty": [{"@type": "PropertyValue", "name": "Texture", "value": "lightweight"}],
                    },
                    {"@type": "WebPage", "@id": "urn:page", "name": product["name"], "description": "Glow Barrier Serum product page."},
                    {
                        "@type": "FAQPage",
                        "mainEntity": [
                            {
                                "@type": "Question",
                                "name": "Who is it for?",
                                "acceptedAnswer": {"@type": "Answer", "text": "For dry skin."},
                            }
                        ],
                    },
                ],
            },
            "scriptTag": "",
        },
        "content": {
            "html": "",
            "sections": {
                "productName": product["name"],
                "description": product["description"],
                "quickFacts": "Texture: lightweight",
                "benefits": "Hydration",
                "ingredients": "Ceramide",
                "howToUse": "Apply one pump after cleansing.",
                "faq": "Q. Who is it for?\nA. For dry skin.",
            },
        },
        "ragChunks": [
            {"id": "best", "kind": "best-practice", "source": "best.md", "title": "Voice", "text": "Use grounded, direct wording.", "score": 1},
            {"id": "geo", "kind": "geo-research", "source": "geo.md", "title": "GEO", "text": "Cite evidence.", "score": 1},
        ],
        "policyRules": [
            {
                "id": "critical",
                "document": "policy.md",
                "kind": "geo-research",
                "heading": "Scope",
                "severity": "critical",
                "extraction": "rules",
                "priority": 10,
                "intents": ["claims"],
                "fieldTargets": ["Product.description"],
                "text": "Preserve evidence scope.",
            }
        ],
        "inferredSearchQueries": [
            {
                "kind": "direct",
                "question": "Is Glow Barrier Serum good for dry skin?",
                "keywords": ["dry skin"],
                "answer": "",
                "source": "product",
                "mentionsProductOrBrand": True,
            }
        ],
        "refinementFeedback": [{"field": "Product.description", "reason": "Keep factual scope."}],
    }


def _keyword_request(product: Mapping[str, object]) -> dict[str, object]:
    return {
        "productName": product["name"],
        "locale": "en-US",
        "market": "US",
        "reviewKeywords": ["hydrtaion", "lone\ud800"],
        "reviewBodies": ["Lightweight and comfortable."],
        "benefits": ["hydration"],
        "effects": ["skin feels comfortable"],
        "sourceTexts": ["Glow Barrier Serum supports hydration for dry skin."],
    }


def _final_request(product: Mapping[str, object]) -> dict[str, object]:
    return {
        "locale": "en-US",
        "market": "US",
        "productName": product["name"],
        "brand": "Neo",
        "fields": [
            {
                "fieldPath": "Product.description",
                "sourceHash": "abc123",
                "text": "Glow Barrier Serum is lightweight..",
                "priorRejection": "Do not change claims.",
            }
        ],
        "evidenceLedger": [{"id": "must-not-serialize", "text": "private evidence"}],
    }


def _planning_request(product: Mapping[str, object]) -> dict[str, object]:
    return {
        "product": dict(product),
        "locale": "en-US",
        "market": "US",
        "hints": {"schemaTargets": ["Product", "WebPage", "FAQPage"]},
        "planningFeedback": [{"field": "content-plan", "reason": "Audit citations."}],
        "candidatePlan": {"locale": "en-US", "warnings": ["candidate"]},
        "evidenceLedger": [
            {"id": "id-identity", "role": "identity", "text": product["name"], "sourcePath": "product.name", "confidence": 1},
            {"id": "id-ingredient", "role": "ingredient", "text": "Ceramide supports hydration.", "sourcePath": "product.ingredients[0]", "confidence": 0.9},
            {"id": "id-metric", "role": "metric", "text": "Hydration increased by 4%; evidenceGroup=study-1", "sourcePath": "product.semanticFacts.metricClaims[0]", "confidence": 0.8},
            {"id": "id-review", "role": "review", "text": "Lightweight and comfortable.", "sourcePath": "product.reviews.items[0]", "confidence": 0.7},
        ],
        "ragChunks": [
            {"id": "field", "kind": "field-contracts", "source": "field.md", "title": "Fields", "text": "Field contract text", "score": 1, "intents": ["schema"], "fieldTargets": ["schema"], "metadata": {"headingPath": "Contracts > Fields"}},
            {"id": "geo", "kind": "geo-research", "source": "geo.md", "title": "GEO", "text": "GEO guidance", "score": 1, "intents": ["copy"], "fieldTargets": ["productDescription"]},
            {"id": "cards", "kind": "evidence-cards", "source": "cards.md", "title": "Cards", "text": "Evidence cards", "score": 1, "intents": [], "fieldTargets": []},
            {"id": "cep", "kind": "cep", "source": "cep.md", "title": "CEP", "text": "CEP guidance", "score": 1, "intents": [], "fieldTargets": []},
            {"id": "eeat", "kind": "eeat", "source": "eeat.md", "title": "Trust", "text": "Trust guidance", "score": 1, "intents": [], "fieldTargets": []},
            {"id": "tone-a", "kind": "best-practice", "source": "tone.md", "title": "Voice A", "text": "Voice guidance A", "score": 1, "intents": [], "fieldTargets": ["productDescription"]},
            {"id": "tone-b", "kind": "best-practice", "source": "tone.md", "title": "Voice B", "text": "Voice guidance B", "score": 1, "intents": [], "fieldTargets": ["webPageDescription"]},
        ],
        "policyRules": [
            {"id": "critical", "document": "policy.md", "kind": "geo-research", "heading": "Scope", "severity": "critical", "extraction": "rules", "priority": 10, "intents": ["claims"], "fieldTargets": ["Product.description"], "text": "Preserve evidence scope."},
            {"id": "guide", "document": "policy.md", "kind": "geo-research", "heading": "Style", "severity": "guidance", "extraction": "rules", "priority": 1, "intents": ["copy"], "fieldTargets": ["WebPage.description"], "text": "Use concise sentences."},
        ],
    }


def _fixture_prompt(stage: str) -> tuple[str, str]:
    fixture = cast(Mapping[str, object], json.loads(_FIXTURE_PATH.read_text(encoding="utf-8")))
    prompts = cast(Mapping[str, object], fixture["prompts"])
    record = cast(Mapping[str, object], prompts[stage])
    system = base64.b64decode(cast(str, record["systemBase64"])).decode("utf-8")
    user = base64.b64decode(cast(str, record["userBase64"])).decode("utf-8")
    assert hashlib.sha256(system.encode("utf-8")).hexdigest() == record["systemSha256"]
    assert hashlib.sha256(user.encode("utf-8")).hexdigest() == record["userSha256"]
    return system, user


def _assert_prompt(stage: str, prompt: Mapping[str, object]) -> None:
    expected_system, expected_user = _fixture_prompt(stage)
    assert prompt["system"] == expected_system
    assert prompt["user"] == expected_user


def _task8e_fixture() -> dict[str, Any]:
    value: dict[str, Any] = json.loads(_TASK8E_FIXTURE_PATH.read_text(encoding="utf-8"))
    return value


def _task8e_product() -> dict[str, object]:
    return {
        "name": "Glow Barrier Serum",
        "description": "Glow Barrier Serum supports hydration for dry skin.",
        "images": [],
        "options": [],
        "benefits": ["hydration"],
        "effects": [],
        "ingredients": ["Ceramide"],
        "usage": ["Apply one pump after cleansing."],
        "metrics": [],
        "faq": [{"question": "Who is it for?", "answer": "For dry skin."}],
        "reviews": {"items": [], "keywords": []},
        "breadcrumbs": [],
        "sourceTexts": [],
        "semanticFacts": {"metricClaims": []},
    }


def _task8e_copy_request() -> dict[str, object]:
    product = _task8e_product()
    product["sourceTexts"] = ["```json\nFact ,  value", ("a" * 519) + "😀"]
    return {
        "product": product,
        "locale": "en-US",
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [
                    {
                        "@type": "Product",
                        "name": "Glow Barrier Serum",
                        "description": "Glow Barrier Serum supports hydration.",
                        "additionalProperty": [
                            {
                                "@type": "PropertyValue",
                                "name": "Name ```json ,",
                                "value": "Value ```json , " + ("p" * 600),
                            }
                        ],
                    },
                    {
                        "@type": "FAQPage",
                        "mainEntity": [
                            {
                                "@type": "Question",
                                "name": "FAQ ```json ,",
                                "acceptedAnswer": {"@type": "Answer", "text": "```json\nAnswer ,  value"},
                            }
                        ],
                    },
                ],
            }
        },
        "content": {
            "html": "",
            "sections": {"productName": "Glow Barrier Serum", "description": "Glow Barrier Serum supports hydration."},
        },
        "ragChunks": [
            {"id": "geo", "kind": "geo-research", "source": "geo.md", "text": ("r" * 699) + "😀", "score": 1}
        ],
        "hydratedRagDocuments": [
            {
                "source": "full.md",
                "version": "v1",
                "kind": "geo-research",
                "hydrationMode": "full",
                "selectedChunkTitles": ["Full"],
                "content": ("h" * 7999) + "😀",
            }
        ],
        "policyRules": [],
    }


def _assert_source_utf8_capture(value: str, expected: Mapping[str, object]) -> None:
    encoded = js_utf8_replacement_text(value).encode("utf-8")
    trailing_code_units = cast(list[int], expected["trailingCodeUnits"])
    assert base64.b64encode(encoded).decode("ascii") == expected["base64"]
    assert hashlib.sha256(encoded).hexdigest() == expected["sha256"]
    assert js_code_unit_length(value) == expected["codeUnitLength"]
    assert [ord(character) for character in value[-1:]] == [trailing_code_units[-1]]


@pytest.mark.parametrize("stage", ["productNormalization", "copyRefinement", "keywordNormalization", "finalProofreading", "contentPlanning"])
def test_native_stage_builders_match_frozen_legacy_prompts(stage: str) -> None:
    """Every native stage owns its source-captured system and JSON serialization."""

    product = _product()
    if stage == "productNormalization":
        _assert_prompt(stage, product_normalizer.create_product_normalization_prompt(_product_request(product), 400))
    elif stage == "copyRefinement":
        _assert_prompt(stage, copy_refiner.create_copy_refinement_prompt(_copy_request(product)))
    elif stage == "keywordNormalization":
        builder = getattr(keyword_normalizer, "create_keyword_normalization_prompt", None)
        assert callable(builder), "keyword normalization must own the legacy prompt builder"
        _assert_prompt(stage, cast(Mapping[str, object], builder(_keyword_request(product))))
    elif stage == "finalProofreading":
        builder = getattr(final_proofreader, "create_final_proofreading_prompt", None)
        assert callable(builder), "final proofreading must own the legacy prompt builder"
        _assert_prompt(stage, cast(Mapping[str, object], builder(_final_request(product))))
    else:
        builder = getattr(content_planning, "create_planning_prompt", None)
        assert callable(builder), "content planning must own the legacy prompt builder"
        _assert_prompt(stage, cast(Mapping[str, object], builder(_planning_request(product), 160, 5)))


@pytest.mark.asyncio
async def test_source_captured_native_user_text_survives_the_real_openai_httpx_boundary() -> None:
    """A completed native prompt must not be overwritten by ``payload`` fallback text."""

    expected_system, expected_user = _fixture_prompt("keywordNormalization")
    observed: list[bytes] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        observed.append(request.content)
        envelope = cast(Mapping[str, object], json.loads(request.content))
        assert envelope["instructions"] == expected_system
        assert cast(str, envelope["input"]).encode("utf-8") == expected_user.encode("utf-8")
        return httpx.Response(200, json={"output_text": "{}"})

    await OpenAIProvider(
        api_key="fixture-key",
        model="fixture-model",
        transport=httpx.MockTransport(handler),
    ).generate_json(
        stage="keyword-normalization",
        system=expected_system,
        user=expected_user,
        payload={"must": "not replace source-captured user"},
        json_schema={"type": "object"},
    )

    assert len(observed) == 1


def test_task8e_source_fixture_records_public_synthetic_prompt_provenance() -> None:
    fixture = _task8e_fixture()
    provenance = cast(Mapping[str, object], fixture["provenance"])

    assert provenance == {
        "capture": "agentic-geo-public-synthetic-validation-v1",
        "runtime": "Python deterministic validator",
    }


def test_task8e_product_prompt_preserves_explicit_nulls_and_utf16_boundaries() -> None:
    contracts = cast(Mapping[str, Any], _task8e_fixture()["promptContracts"])
    explicit_null = cast(Mapping[str, object], contracts["productExplicitNull"])
    product = _task8e_product()

    null_payload = json.loads(
        product_normalizer.create_product_normalization_prompt(
            {"rawProduct": {"name": "Glow Barrier Serum"}, "bootstrapProduct": product, "locale": "en-US", "ragDocuments": []}
        )["user"]
    )
    for field, expected in explicit_null.items():
        assert null_payload[field] == expected

    boundary = cast(Mapping[str, Any], contracts["productBoundary"])
    payload = json.loads(
        product_normalizer.create_product_normalization_prompt(
            {
                "rawProduct": {"name": "Glow Barrier Serum"},
                "bootstrapProduct": product,
                "locale": "en-US",
                "source": {"url": "https://example.test/product"},
                "hints": {},
                "fieldMapping": {},
                "analysisPrompt": "first\n   second",
                "ragDocuments": [{"name": "policy\nname", "content": ("a" * 2399) + "😀"}],
            }
        )["user"]
    )
    assert payload["ragPolicy"][0] == boundary["analysisPrompt"]
    rag_document = payload["ragPolicy"][1]
    expected_document = cast(Mapping[str, Any], boundary["ragDocument"])
    assert {key: rag_document[key] for key in ("name", "version")} == {
        key: expected_document[key] for key in ("name", "version")
    }
    rag_content = cast(str, rag_document["content"])
    assert rag_content == ("a" * 2399) + chr(0xD83D)
    _assert_source_utf8_capture(rag_content, cast(Mapping[str, object], expected_document["content"]))

    raw_payload = json.loads(
        product_normalizer.create_product_normalization_prompt(
            {"rawProduct": "😀", "bootstrapProduct": product, "locale": "en-US", "ragDocuments": []}, 2
        )["user"]
    )
    raw_expected = cast(Mapping[str, Any], boundary["rawProduct"])
    raw_product = cast(Mapping[str, object], raw_payload["rawProduct"])
    assert raw_product["truncated"] is raw_expected["truncated"]
    raw_text = cast(str, raw_product["text"])
    assert raw_text == '"' + chr(0xD83D)
    assert js_code_unit_length(raw_text) == 2


def test_task8e_optional_prompt_fields_follow_javascript_undefined_omission() -> None:
    contracts = cast(Mapping[str, Any], _task8e_fixture()["promptContracts"])
    product = _task8e_product()

    keyword = json.loads(
        keyword_normalizer.create_keyword_normalization_prompt(
            {"productName": "Glow Barrier Serum", "locale": "en-US", "reviewKeywords": []}
        )["user"]
    )
    keyword_expected = cast(Mapping[str, Any], contracts["keywordAbsent"])
    assert keyword == keyword_expected["payload"]
    assert list(keyword) == keyword_expected["keys"]
    assert list(keyword["context"]) == keyword_expected["contextKeys"]

    final = json.loads(
        final_proofreader.create_final_proofreading_prompt(
            {"locale": "en-US", "productName": "Glow Barrier Serum", "fields": []}
        )["user"]
    )
    final_expected = cast(Mapping[str, Any], contracts["finalAbsent"])
    assert final == final_expected["payload"]
    assert list(final) == final_expected["keys"]

    planning = json.loads(
        content_planning.create_planning_prompt(
            {
                "product": product,
                "locale": "en-US",
                "evidenceLedger": [{"id": "evidence-1", "role": "benefit", "text": "Hydration support"}],
                "ragChunks": [{"id": "field", "kind": "field-contracts", "source": "field.md", "text": "Field guidance", "score": 1}],
            },
            8,
            4,
        )["user"]
    )
    planning_expected = cast(Mapping[str, Any], contracts["planningAbsent"])
    assert planning == planning_expected["payload"]
    assert list(planning) == planning_expected["keys"]
    assert list(planning["evidenceLedger"][0]) == planning_expected["ledgerKeys"]
    assert list(planning["taskGuidance"][0]) == planning_expected["guidanceKeys"]


def test_task8e_copy_prompt_matches_source_cleaner_omissions_and_utf16_bounds() -> None:
    expected = cast(Mapping[str, Any], _task8e_fixture()["promptContracts"])["copy"]
    payload = json.loads(copy_refiner.create_copy_refinement_prompt(_task8e_copy_request())["user"])

    assert list(payload) == expected["keys"]
    assert payload["currentCopy"] == expected["currentCopy"]
    assert list(payload["productEvidence"]) == expected["productEvidenceKeys"]
    assert payload["productEvidence"]["sourceTexts"][0] == expected["sourceTextCleaned"]

    evidence = cast(str, payload["productEvidence"]["sourceTexts"][1])
    evidence_bound = cast(Mapping[str, object], expected["sourceTextBound"])
    assert evidence == (cast(str, evidence_bound["prefixCharacter"]) * cast(int, evidence_bound["prefixCodeUnits"])) + cast(str, evidence_bound["suffix"])
    assert js_code_unit_length(evidence) == evidence_bound["codeUnitLength"]
    assert hashlib.sha256(evidence.encode("utf-8")).hexdigest() == evidence_bound["sha256"]

    excerpt = cast(str, payload["strategicExposureGuidance"][0]["excerpt"])
    excerpt_bound = cast(Mapping[str, object], expected["strategicExcerpt"])
    assert excerpt == (cast(str, excerpt_bound["prefixCharacter"]) * cast(int, excerpt_bound["prefixCodeUnits"])) + cast(str, excerpt_bound["suffix"])
    assert js_code_unit_length(excerpt) == excerpt_bound["codeUnitLength"]
    assert hashlib.sha256(excerpt.encode("utf-8")).hexdigest() == excerpt_bound["sha256"]

    hydrated = cast(Mapping[str, object], payload["strategicFullDocuments"][0])
    hydrated_expected = cast(Mapping[str, Any], expected["hydratedDocument"])
    assert {key: hydrated[key] for key in ("source", "version", "kind", "hydrationMode", "selectedChunkTitles", "contentTruncated")} == {
        key: hydrated_expected[key] for key in ("source", "version", "kind", "hydrationMode", "selectedChunkTitles", "contentTruncated")
    }
    hydrated_content = cast(str, hydrated["content"])
    hydrated_bound = cast(Mapping[str, object], hydrated_expected["content"])
    assert hydrated_content == (cast(str, hydrated_bound["prefixCharacter"]) * cast(int, hydrated_bound["prefixCodeUnits"])) + cast(str, hydrated_bound["suffix"])
    assert js_code_unit_length(hydrated_content) == hydrated_bound["codeUnitLength"]
    assert hashlib.sha256(hydrated_content.encode("utf-8")).hexdigest() == hydrated_bound["sha256"]
    assert payload["ragGuidance"] == expected["ragGuidance"]

"""Frozen public validation contracts for deterministic regression coverage."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from typing import Any, cast

import pdp_geo_generator_agent as generator
from pdp_geo_generator_agent.validation import (
    apply_safe_public_copy_repairs,
    serialize_schema_markup,
    validate_and_repair_pdp_geo_artifacts,
    validate_pdp_geo_artifacts,
)

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "generator-validation-contract-v1.json"
_FIXTURE_SHA256 = "ba93650a0eaaf2f880966419f6569529c40a8b49836642208ef376be92d9e828"


def _contract() -> dict[str, Any]:
    payload = cast(dict[str, Any], json.loads(_FIXTURE_PATH.read_text(encoding="utf-8")))
    digest_subject = {key: value for key, value in payload.items() if key != "wholeContractSha256"}
    encoded = json.dumps(digest_subject, ensure_ascii=False, separators=(",", ":")).encode()
    assert hashlib.sha256(encoded).hexdigest() == _FIXTURE_SHA256
    assert payload["wholeContractSha256"] == _FIXTURE_SHA256
    assert payload["provenance"] == {
        "capture": "agentic-geo-public-synthetic-validation-v1",
        "runtime": "Python deterministic validator",
    }
    return payload


def _sections() -> dict[str, str]:
    return {
        "productName": "Test Serum",
        "description": "Test Serum is a serum ,  described for dry skin.\\nIt includes ginseng.",
        "quickFacts": "First item ,  second item.\\nThird item ! .",
        "benefits": "Calms dry skin. https://example.com/upload/benefit.png",
        "ingredients": "Ginseng Extract, What, Niacinamide",
        "howToUse": "1. Gently pat 2-3 pumps onto skin morning and night.\\n2. Gently pat 2-3 pumps onto skin morning and night.",
        "faq": "Q. Is Test Serum suitable for dry skin?\\nA. Test Serum is suitable for dry skin ,  and layers easily.",
    }


def _safe_input() -> dict[str, Any]:
    return {
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [
                    {
                        "@type": "WebPage",
                        "name": "Page Name ,  untouched",
                        "description": "Test Serum is a serum ,  described for dry skin.\\nIt includes ginseng.",
                    },
                    {
                        "@type": "Organization",
                        "name": "Organization ,  unchanged",
                        "description": "Organization copy ,  unchanged.",
                    },
                    {
                        "@type": "Product",
                        "name": "Product ,  unchanged",
                        "description": "Test Serum is a serum ,  described for dry skin.\\nIt includes ginseng.",
                        "additionalProperty": [
                            {
                                "@type": "PropertyValue",
                                "name": "Usage",
                                "value": "1. Gently pat 2-3 pumps onto skin morning and night; Step 2: Gently pat 2-3 pumps onto skin morning and night.",
                            },
                            {
                                "@type": "PropertyValue",
                                "name": "Key ingredients",
                                "value": "Ginseng Extract, What, Niacinamide",
                            },
                            {
                                "@type": "PropertyValue",
                                "name": "URL-only",
                                "value": "https://example.com/upload/product/usage.png",
                            },
                        ],
                    },
                    {
                        "@type": "FAQPage",
                        "mainEntity": [
                            {
                                "@type": "Question",
                                "name": "Is Test Serum suitable for dry skin ? .",
                                "acceptedAnswer": {
                                    "@type": "Answer",
                                    "text": "Test Serum is suitable for dry skin ,  and layers easily.",
                                },
                            }
                        ],
                    },
                    {
                        "@type": "HowTo",
                        "step": [
                            {
                                "@type": "HowToStep",
                                "text": "1. Gently pat 2-3 pumps onto skin morning and night.",
                            }
                        ],
                    },
                ],
            },
            "scriptTag": '<script type="application/ld+json">old</script>',
        },
        "content": {"sections": _sections(), "html": "<article>caller-rendered</article>"},
        "fallbackProductName": "Fallback Serum",
        "fallbackDescription": "Fallback serum description.",
        "locale": "en-US",
    }


def _malformed_input() -> dict[str, Any]:
    return {
        "schemaMarkup": {
            "jsonLd": {
                "@context": "not-schema",
                "@graph": [
                    {
                        "@type": "WebPage",
                        "@id": "https://example.com/page#webpage",
                        "name": "Page",
                        "inLanguage": "fr-FR",
                        "hasPart": {"@id": "https://example.com/page#faq"},
                        "description": "Page description.",
                    },
                    {
                        "@type": "Product",
                        "@id": "https://example.com/page#product",
                        "name": "",
                        "description": "",
                        "image": [
                            "bad-image",
                            {
                                "@type": "ImageObject",
                                "contentUrl": "https://example.com/image.jpg",
                                "width": 100,
                                "height": 0,
                            },
                        ],
                        "offers": {"@type": "Offer", "price": "", "priceCurrency": "", "availability": "not-a-url"},
                        "aggregateRating": {"@type": "AggregateRating", "ratingValue": "9", "reviewCount": -1},
                        "review": [{"@type": "Review", "reviewBody": "", "reviewRating": {"@type": "Rating", "ratingValue": 6}}],
                        "additionalProperty": [
                            {
                                "@type": "PropertyValue",
                                "name": "Key ingredients",
                                "value": "Ginseng Extract, What, Niacinamide",
                            }
                        ],
                    },
                    {
                        "@type": "FAQPage",
                        "@id": "https://example.com/page#faq",
                        "mainEntity": [{"@type": "Question", "name": "", "acceptedAnswer": {"@type": "Answer", "text": ""}}],
                    },
                    {
                        "@type": "HowTo",
                        "@id": "https://example.com/page#howto",
                        "name": "How to use",
                        "step": [{"@type": "HowToStep", "position": 4, "text": "Gently pat 2-3 pumps onto skin morning and night."}],
                    },
                ],
            },
            "scriptTag": "not-a-script",
        },
        "content": {"sections": _sections(), "html": "<article>full-mutator-clears-this</article>"},
        "fallbackProductName": "Fallback Serum",
        "fallbackDescription": "Fallback serum description.",
        "locale": "en-US",
        "sourceProduct": {
            "name": "Fallback Serum",
            "description": "",
            "ingredients": ["Ginseng Extract", "Niacinamide"],
            "benefits": [],
            "effects": [],
            "usage": [],
            "metrics": [],
            "options": [],
            "sourceTexts": [],
            "faq": [],
            "reviews": {"items": [], "keywords": []},
        },
    }


def _graph(result: dict[str, Any]) -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], result["schemaMarkup"]["jsonLd"]["@graph"])


def _node(graph: list[dict[str, Any]], type_: str) -> dict[str, Any]:
    return next(node for node in graph if node.get("@type") == type_)


def test_safe_public_copy_repair_keeps_html_and_non_target_names_while_normalizing_copy() -> None:
    contract = _contract()
    expected = contract["safe"]
    input_ = _safe_input()
    original = copy.deepcopy(input_)

    result = apply_safe_public_copy_repairs(input_)
    graph = _graph(result)
    product = _node(graph, "Product")
    organization = _node(graph, "Organization")
    properties = cast(list[dict[str, Any]], product["additionalProperty"])

    assert input_ == original
    assert result["content"]["html"] == expected["callerHtml"]
    assert product["name"] == expected["productName"]
    assert organization["name"] == expected["organizationName"]
    assert organization["description"] == expected["organizationDescription"]
    assert product["description"] == expected["normalizedDescription"]
    assert result["content"]["sections"]["quickFacts"] == expected["normalizedQuickFacts"]
    assert result["content"]["sections"]["benefits"] == expected["normalizedBenefits"]
    assert result["content"]["sections"]["faq"] == expected["normalizedFaq"]
    assert product["additionalProperty"] == [
        {"@type": "PropertyValue", "name": "Usage", "value": expected["usage"]},
        {"@type": "PropertyValue", "name": "Key ingredients", "value": expected["keyIngredients"]},
    ]
    assert result["schemaMarkup"]["scriptTag"].startswith(expected["scriptTagPrefix"])
    assert expected["normalizedDescription"] in result["schemaMarkup"]["scriptTag"]
    assert any(repair["field"] == "Product.additionalProperty.Usage" for repair in result["appliedRepairs"])
    assert any(repair["field"] == "Product.additionalProperty.URL-only" for repair in result["appliedRepairs"])
    assert properties[0]["value"] == expected["usage"]


def test_safe_public_copy_repair_preserves_source_captured_decimal_price_spelling() -> None:
    expected = _contract()["safe"]["decimalPriceSentence"]
    input_ = _safe_input()
    input_["schemaMarkup"]["jsonLd"]["@graph"] = [{"@type": "WebPage", "description": expected}]

    result = apply_safe_public_copy_repairs(input_)

    assert _node(_graph(result), "WebPage")["description"] == expected
    assert not any(repair["field"] == "WebPage.description" for repair in result["appliedRepairs"])


def test_read_only_validation_reports_full_mutator_candidate_without_mutating_caller() -> None:
    contract = _contract()
    input_ = _malformed_input()
    original = copy.deepcopy(input_)

    report = validate_pdp_geo_artifacts(input_)
    fields = {finding["field"] for finding in report["validationFindings"]}

    assert input_ == original
    assert set(contract["readOnly"]["requiredFindingFields"]) <= fields
    script_finding = next(finding for finding in report["validationFindings"] if finding["field"] == "schemaMarkup.scriptTag")
    assert script_finding["issue"] == contract["readOnly"]["scriptTagIssue"]
    assert script_finding["suggestedAction"] == "Re-serialize scriptTag deterministically from schemaMarkup.jsonLd before publishing."


def test_read_only_validation_preserves_qualitative_review_wording_as_a_trust_finding() -> None:
    contract = _contract()
    input_ = _safe_input()
    input_["schemaMarkup"]["jsonLd"]["@graph"] = [
        {
            "@type": "Product",
            "name": "Test Serum",
            "description": "Customers highlight the comforting texture and quick absorption.",
        }
    ]
    input_["sourceProduct"] = {
        "name": "Test Serum",
        "description": "",
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "sourceTexts": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
    }

    report = validate_pdp_geo_artifacts(input_)

    qualitative = next(
        finding
        for finding in report["validationFindings"]
        if finding["issue"] == contract["readOnly"]["qualitativeReviewIssue"]
    )
    assert qualitative["field"] == "Product.description"
    assert qualitative["source"] == "trust-field-validator"
    assert qualitative["suggestedAction"] == "Keep AggregateRating, but omit qualitative review claims until source-scoped review evidence exists."


def test_full_mutator_repairs_graph_trust_fields_and_only_it_clears_html() -> None:
    contract = _contract()
    expected = contract["full"]
    input_ = _malformed_input()
    original = copy.deepcopy(input_)

    result = validate_and_repair_pdp_geo_artifacts(input_)
    graph = _graph(result)
    product = _node(graph, "Product")
    how_to = _node(graph, "HowTo")

    assert input_ == original
    assert result["schemaMarkup"]["jsonLd"]["@context"] == expected["context"]
    assert result["content"]["html"] == ""
    assert [node["@type"] for node in graph] == ["WebPage", "Product", "HowTo"]
    assert product["name"] == expected["fallbackName"]
    assert product["description"] == expected["fallbackDescription"]
    assert product["image"] == [expected["canonicalImage"]]
    assert "offers" not in product
    assert "aggregateRating" not in product
    assert "review" not in product
    assert how_to["inLanguage"] == "en-US"
    assert how_to["step"] == [{"@type": "HowToStep", **expected["howToStep"]}]
    assert any(repair["field"] == "Product.image" for repair in result["validationRepairs"])
    assert any(repair["field"] == "WebPage.hasPart" for repair in result["validationRepairs"])


def test_full_mutator_adds_a_product_from_fallback_when_the_graph_has_none() -> None:
    contract = _contract()
    expected = contract["full"]
    input_ = _malformed_input()
    input_["schemaMarkup"] = {
        "jsonLd": {"@graph": [{"@type": "WebPage", "name": "A page"}]},
        "scriptTag": "",
    }
    input_["content"]["html"] = "<article>fallback-clears-this</article>"

    result = validate_and_repair_pdp_geo_artifacts(input_)
    product = _node(_graph(result), "Product")

    assert product == {
        "@type": "Product",
        "@id": expected["fallbackProductId"],
        "name": expected["fallbackName"],
        "description": expected["fallbackDescription"],
    }
    assert result["content"]["html"] == ""
    assert any(repair["field"] == "@graph.Product" for repair in result["validationRepairs"])


def test_public_validation_aliases_remain_identity_aliases() -> None:
    assert generator.applySafePublicCopyRepairs is generator.apply_safe_public_copy_repairs
    assert generator.validatePdpGeoArtifacts is generator.validate_pdp_geo_artifacts
    assert generator.validateAndRepairPdpGeoArtifacts is generator.validate_and_repair_pdp_geo_artifacts


def test_read_only_validation_reports_a_stale_final_public_copy_provenance_binding() -> None:
    """Final public fields need a current text, hash, and ledger binding."""

    description = "Test Serum is a serum for dry skin."
    report = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": serialize_schema_markup(
                {"@context": "https://schema.org", "@graph": [{"@type": "Product", "name": "Test Serum", "description": description}]}
            ),
            "content": {"html": "", "sections": {"description": description}},
            "evidenceLedger": [
                {
                    "id": "description-source",
                    "role": "description",
                    "text": description,
                    "sourcePath": "product.description",
                    "locale": "en-US",
                    "productScope": "product",
                    "confidence": 1,
                }
            ],
            "publicCopyProvenance": [
                {
                    "fieldPath": "Product.description",
                    "text": "Test Serum is a serum for oily skin.",
                    "sourceHash": "fnv1a-stale",
                    "evidenceIds": ["description-source"],
                    "sentences": [],
                }
            ],
        }
    )

    assert any(finding["source"] == "public-copy-provenance" for finding in report["validationFindings"])

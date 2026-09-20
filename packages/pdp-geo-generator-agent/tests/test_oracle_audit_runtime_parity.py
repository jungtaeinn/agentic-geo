"""Focused source-backed regressions from the retained TypeScript oracle audit."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Mapping
from typing import Any, cast

import httpx
import pytest
from pdp_geo_eval_agent import evaluate_geo_quality
from pdp_geo_eval_agent.benchmark import eval_products

from pdp_geo_generator_agent.content_planning import (
    create_conservative_content_plan,
    create_pdp_geo_evidence_ledger,
    plan_pdp_geo_content,
)
from pdp_geo_generator_agent.normalization import normalize_pdp_product
from pdp_geo_generator_agent.rag.retrieval import (
    create_pdp_geo_rag_query,
    resolve_pdp_geo_rag_settings,
    retrieve_pdp_geo_rag_chunks,
)
from pdp_geo_generator_agent.service import generate_pdp_geo


def _node(graph: list[dict[str, Any]], type_name: str) -> dict[str, Any]:
    return next(
        item
        for item in graph
        if type_name in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]])
    )


_SPARSE_HYDRA_PRODUCT: dict[str, Any] = {
    "name": "Hydra Barrier Cream",
    "description": "Daily hydration cream for dry skin.",
    "brand": "Neo",
    "benefits": ["Supports hydration"],
    "ingredients": ["Ceramide"],
    "usage": ["Apply after serum."],
}


@pytest.mark.parametrize(
    ("product_id", "field", "expected"),
    [
        (
            "fieldnote-arcwell-night-serum",
            "benefits",
            ["comforting", "smoothing", "moisturizing"],
        ),
        (
            "fieldnote-arcwell-night-serum",
            "effects",
            [
                "softer-feeling texture",
                "more comfortable dry areas",
                "a more even-looking surface",
            ],
        ),
        (
            "fieldnote-daybreak-first-essence",
            "benefits",
            ["hydrating", "radiance", "texture-refining"],
        ),
        (
            "fieldnote-daybreak-first-essence",
            "effects",
            [
                "more even-looking texture",
                "comfortable first-step hydration",
                "a fresher-looking tone",
            ],
        ),
        (
            "byeolmorae-waterfold-toner",
            "benefits",
            ["장벽 보습", "피부결 정돈", "세안 후 수분 공급"],
        ),
        (
            "byeolmorae-waterfold-toner",
            "ingredients",
            [
                "글루코노락톤",
                "판테놀",
                "베타글루칸",
                "소듐하이알루로네이트",
            ],
        ),
    ],
)
def test_normalizer_keeps_retained_role_admission_order(
    product_id: str, field: str, expected: list[str]
) -> None:
    """Mapped signals follow the TypeScript role-first selection sequence.

    These are deliberately not alphabetical expectations.  The retained
    normalizer admits direct field values only after its semantic role gate,
    then recovers trusted mapped values; that sequence is public diagnostics
    data and feeds deterministic public copy.
    """

    normalized = normalize_pdp_product(eval_products[product_id])

    assert normalized["product"][field] == expected


def test_conservative_plan_matches_ts_model_only_descriptions_and_unlabelled_usage() -> None:
    """Freeze the legacy content planner's fail-closed sparse-PDP plan.

    The deterministic renderer, not the conservative planner, composes public
    descriptions.  A single source instruction is eligible only as an
    unlabelled, source-cited step; it never gains a synthetic ``Step 1`` name
    or invented order semantics.
    """

    ledger = create_pdp_geo_evidence_ledger(_SPARSE_HYDRA_PRODUCT, "en-US")
    plan = create_conservative_content_plan(
        {"product": _SPARSE_HYDRA_PRODUCT, "locale": "en-US", "evidenceLedger": ledger}
    )

    assert plan == {
        "mode": "conservative",
        "locale": "en-US",
        "productDescription": {
            "include": False,
            "text": "",
            "intent": "product-entity-summary",
            "evidenceIds": [],
            "confidence": 0,
            "omitReason": "No model-backed field plan was available; the source-backed renderer fallback is used.",
        },
        "webPageDescription": {
            "include": False,
            "text": "",
            "intent": "page-coverage-summary",
            "evidenceIds": [],
            "confidence": 0,
            "omitReason": "No model-backed field plan was available; the source-backed renderer fallback is used.",
        },
        "faq": [],
        "howTo": {
            "eligible": True,
            "ordered": True,
            "goal": "How to use Hydra Barrier Cream",
            "steps": [
                {
                    "position": 1,
                    "name": "",
                    "text": "Apply after serum.",
                    "evidenceIds": ["ev-usage-142wng7"],
                }
            ],
            "evidenceIds": ["ev-usage-142wng7"],
            "confidence": 0.75,
            "omitReason": "",
        },
        "cep": [],
        "warnings": [],
    }


def test_conservative_plan_does_not_invent_order_for_independent_source_actions() -> None:
    """Independent usage notes retain their source rows without becoming a Schema.org procedure."""

    product = {
        "name": "Cloudveil Example Mist",
        "brand": "Demo Lab",
        "category": "미스트",
        "description": "독립된 사용 문장을 검증하기 위한 합성 미스트 예시입니다.",
        "ingredients": ["글리세린"],
        "benefits": ["가벼운 보습"],
        "usage": [
            "세안 뒤 얼굴에서 약 20cm 거리를 두고 분사합니다.",
            "건조하게 느껴질 때 필요에 따라 다시 분사합니다.",
        ],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
    }
    ledger = create_pdp_geo_evidence_ledger(product, "ko-KR")
    how_to = create_conservative_content_plan(
        {"product": product, "locale": "ko-KR", "evidenceLedger": ledger}
    )["howTo"]

    source_steps = [cast(str, item["text"]) for item in cast(list[dict[str, Any]], how_to["steps"])]
    assert how_to["eligible"] is True
    assert how_to["ordered"] is False
    assert how_to["goal"] == "Cloudveil Example Mist 사용 방법"
    assert source_steps == product["usage"]
    assert len(how_to["evidenceIds"]) == 2

    # The planner paraphrases the source instruction. The service may reject
    # it during admission, but it must never let either route rewrite the
    # canonical public source procedure.
    paraphrased_plan_steps = [
        "세안 뒤 미스트를 사용합니다.",
        "건조할 때 필요에 따라 덧뿌립니다.",
    ]

    async def paraphrasing_planner(request: Mapping[str, Any]) -> dict[str, Any]:
        plan = create_conservative_content_plan(request)
        planned_how_to = cast(dict[str, Any], plan["howTo"])
        plan["howTo"] = {
            **planned_how_to,
            "steps": [
                {**raw, "text": paraphrase}
                for raw, paraphrase in zip(
                    cast(list[dict[str, Any]], planned_how_to["steps"]), paraphrased_plan_steps, strict=True
                )
            ],
        }
        return {"plan": {key: value for key, value in plan.items() if key != "mode"}}

    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": product,
                "hints": {"locale": "ko-KR", "market": "KR"},
            },
            {"customContentPlanner": paraphrasing_planner, "qualityGate": {"enabled": False}},
        )
    )
    graph = cast(list[dict[str, Any]], run["result"]["schemaMarkup"]["jsonLd"]["@graph"])
    visible_steps = run["result"]["content"]["sections"]["howToUse"].split("\n")

    assert [item["text"] for item in run["diagnostics"]["contentPlan"]["howTo"]["steps"]] in (
        paraphrased_plan_steps,
        source_steps,
    )
    assert run["diagnostics"]["contentPlan"]["howTo"]["ordered"] is False
    assert not any(
        "HowTo" in (node["@type"] if isinstance(node["@type"], list) else [node["@type"]]) for node in graph
    )
    assert source_steps == visible_steps


def test_sparse_generation_keeps_public_shape_and_source_grounded_artifacts() -> None:
    """Sparse source facts remain rich, role-ordered, and wire-shape compatible."""

    run = asyncio.run(generate_pdp_geo({"product": _SPARSE_HYDRA_PRODUCT, "hints": {"locale": "en-US"}}))
    result = cast(Mapping[str, Any], run["result"])
    content = cast(Mapping[str, Any], result["content"])
    sections = cast(Mapping[str, str], content["sections"])
    graph = cast(list[dict[str, Any]], cast(Mapping[str, Any], result["schemaMarkup"])["jsonLd"]["@graph"])
    product = _node(graph, "Product")
    webpage = _node(graph, "WebPage")
    faq = _node(graph, "FAQPage")["mainEntity"]

    assert set(content) == {"html", "sections"}
    assert set(sections) == {"productName", "description", "quickFacts", "benefits", "ingredients", "howToUse", "faq"}
    assert sections["productName"] == "Hydra Barrier Cream"
    assert sections["howToUse"] == "Apply after serum."
    assert sections["description"] == product["description"]
    assert product["description"] != webpage["description"]
    normalized_description = product["description"].casefold()
    for fact in ("Hydra Barrier Cream", "Neo", "Daily hydration cream for dry skin.", "Ceramide", "Supports hydration"):
        assert fact.casefold() in normalized_description
    assert [normalized_description.index(fact.casefold()) for fact in ("Daily hydration cream for dry skin.", "Ceramide", "Supports hydration")] == sorted(
        normalized_description.index(fact.casefold()) for fact in ("Daily hydration cream for dry skin.", "Ceramide", "Supports hydration")
    )
    assert "The page also outlines how to use Hydra Barrier Cream from Neo." in webpage["description"]
    assert "Apply after serum." not in webpage["description"]
    assert 2 <= len(faq) <= 3
    rendered_faq = "\n".join(f"{item['name']}\n{item['acceptedAnswer']['text']}" for item in faq)
    assert all("Hydra Barrier Cream" in item["name"] for item in faq)
    for fact in ("Ceramide", "Supports hydration", "Apply after serum."):
        assert fact.casefold() in rendered_faq.casefold()
    assert not any(token in rendered_faq.casefold() for token in ("best suited", "consider", "product-selection"))
    assert not any(finding["source"] == "public-copy-provenance" for finding in run["diagnostics"]["validationFindings"])
    assert run["diagnostics"]["contentPlan"]["productDescription"]["include"] is False
    assert run["diagnostics"]["contentPlan"]["webPageDescription"]["confidence"] == 0
    assert run["diagnostics"]["contentPlan"]["howTo"] == {
        "eligible": True,
        "ordered": True,
        "goal": "How to use Hydra Barrier Cream",
        "steps": [
            {
                "position": 1,
                "name": "",
                "text": "Apply after serum.",
                "evidenceIds": ["ev-usage-142wng7"],
            }
        ],
        "evidenceIds": ["ev-usage-142wng7"],
        "confidence": 0.75,
        "omitReason": "",
    }
    assert "source" not in run["result"]
    assert "copyRefinement" not in run["diagnostics"]
    assert "copyRefinement" not in run["result"]["diagnostics"]
    # The TypeScript REST JSON omits JavaScript undefined keys. Freeze that
    # public serializable key set instead of preserving Python-only null or
    # disabled-stage placeholders.
    assert set(run["result"]) == {
        "locale",
        "market",
        "schemaMarkup",
        "content",
        "diagnostics",
        "generatedAt",
        "ragProfile",
    }
    assert list(run["diagnostics"]) == [
        "normalizedProduct",
        "evidenceLedger",
        "contentPlan",
        "ocrSentences",
        "recommendations",
        "evidence",
        "selectedRagChunks",
        "hydratedRagDocuments",
        "policyCoverage",
        "reasoning",
        "ragQueryPlan",
        "ragUsage",
        "runtimeUsage",
        "terminology",
        "inferredSearchQueries",
        "finalProofreading",
        "finalPublicCopyProvenance",
        "publicCopyProvenanceDecisionDiagnostics",
        "validationWarnings",
        "validationFindings",
        "validationRepairs",
        "ragMode",
        "generatedAt",
    ]


def test_sparse_generation_matches_ts_schema_markup_and_property_contract() -> None:
    """Freeze public schema shape, graph eligibility, and property order.

    The legacy renderer exposes only the wire-facing JSON-LD/script fields. A
    complete one-line usage instruction becomes one source-backed HowTo node,
    while the Product retains its field-separated customer/composition context.
    """

    result = asyncio.run(
        generate_pdp_geo({"product": _SPARSE_HYDRA_PRODUCT, "hints": {"locale": "en-US"}})
    )["result"]
    schema_markup = result["schemaMarkup"]
    graph = schema_markup["jsonLd"]["@graph"]
    product = _node(graph, "Product")

    assert list(schema_markup) == ["jsonLd", "scriptTag"]
    assert [item["@type"] for item in graph] == [["WebPage", "ItemPage"], "Product", "FAQPage", "HowTo", "BreadcrumbList"]
    assert _node(graph, "HowTo")["step"] == [
        {"@type": "HowToStep", "position": 1, "name": "Step 1", "text": "Apply after serum."}
    ]
    assert product["additionalProperty"] == [
        {"@type": "PropertyValue", "name": "Target customer", "value": "dry skin"},
        {"@type": "PropertyValue", "name": "Recommended skin type", "value": "dry skin"},
        {"@type": "PropertyValue", "name": "Key benefit", "value": "hydration"},
        {"@type": "PropertyValue", "name": "Key ingredients", "value": "Ceramide"},
        {
            "@type": "PropertyValue",
            "name": "Ingredient/effect detail",
            "value": (
                "The formula includes Ceramide. Product information identifies hydration as care benefits for customers with "
                "dry skin"
            ),
        },
    ]
    assert not any(item["name"] == "Routine synergy" for item in product["additionalProperty"])
    # JSON object order is wire-visible inside scriptTag. The retained TS
    # Product inserts the page linkage before its description; do not let a
    # semantically equivalent Python mapping change the frozen script artifact.
    assert list(product) == [
        "@type",
        "@id",
        "name",
        "mainEntityOfPage",
        "description",
        "brand",
        "category",
        "additionalProperty",
    ]
    product_script = schema_markup["scriptTag"].split('"@type": "Product"', 1)[1].split('"@type": "FAQPage"', 1)[0]
    assert product_script.index('"mainEntityOfPage"') < product_script.index('"description"')


def test_core_generation_derives_source_grounded_narrative_faq_and_query_diagnostics() -> None:
    """Public artifacts preserve source roles instead of a frozen legacy template."""

    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "name": "Hydra Barrier Cream",
                    "description": "Daily hydration cream for dry skin.",
                    "brand": "Neo",
                    "benefits": ["Supports hydration"],
                    "ingredients": ["Ceramide"],
                    "usage": ["Apply after serum."],
                },
                "hints": {"locale": "en-US"},
            }
        )
    )

    result = run["result"]
    graph = result["schemaMarkup"]["jsonLd"]["@graph"]
    product_description = _node(graph, "Product")["description"]
    webpage_description = _node(graph, "WebPage")["description"]
    normalized_product_description = product_description.casefold()
    for fact in ("Hydra Barrier Cream", "Neo", "Daily hydration cream for dry skin.", "Ceramide", "Supports hydration"):
        assert fact.casefold() in normalized_product_description
    assert product_description != webpage_description
    assert "The page also outlines how to use Hydra Barrier Cream from Neo." in webpage_description
    assert "Apply after serum." not in webpage_description
    faq = _node(graph, "FAQPage")["mainEntity"]
    rendered_faq = "\n".join(f"{item['name']}\n{item['acceptedAnswer']['text']}" for item in faq)
    assert all("Hydra Barrier Cream" in item["name"] for item in faq)
    for fact in ("Ceramide", "Supports hydration", "Apply after serum."):
        assert fact.casefold() in rendered_faq.casefold()
    assert not any(token in rendered_faq.casefold() for token in ("best suited", "consider", "product-selection"))

    queries = result["diagnostics"]["inferredSearchQueries"]
    assert len(queries) == 2
    assert {item["kind"] for item in queries} == {"direct", "indirect"}
    assert all(item["source"] == "product-fact" for item in queries)
    assert any("Ceramide" in item["keywords"] for item in queries)


def test_service_keeps_canonical_evidence_once_and_omits_disabled_quality_gate() -> None:
    """Mirror the TS artifact assembly when no corrective quality pass runs.

    The legacy generator appends each provenance record once, in source order, and
    leaves ``qualityGate`` undefined when it is disabled.  The Python port
    accidentally appended generated evidence twice and exposed a disabled
    diagnostics object that JavaScript JSON serialization would omit.
    """

    run = asyncio.run(
        generate_pdp_geo(
            {"product": {"name": "Serum", "description": "Hydration serum."}},
            {"qualityGate": {"enabled": False}},
        )
    )

    diagnostics = run["diagnostics"]
    evidence = diagnostics["evidence"]
    fingerprints = [json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":")) for item in evidence]
    # Two input/provenance entries, four generated RAG entries, and the
    # retained breadcrumb hierarchy finding are each exposed exactly once.
    assert len(evidence) == 8
    assert len(fingerprints) == len(set(fingerprints))
    assert "qualityGate" not in diagnostics
    assert "qualityGate" not in run["result"]["diagnostics"]


def test_service_reports_the_retained_single_item_breadcrumb_finding() -> None:
    """A generated one-item hierarchy is a read-only public validation finding."""

    run = asyncio.run(
        generate_pdp_geo(
            {"product": {"name": "Serum", "description": "Hydration serum."}},
            {"qualityGate": {"enabled": False}},
        )
    )

    issue = "BreadcrumbList has fewer than two valid hierarchy items."
    assert run["diagnostics"]["validationWarnings"] == [f"BreadcrumbList.itemListElement: {issue}"]
    assert run["diagnostics"]["validationFindings"] == [
        {
            "field": "BreadcrumbList.itemListElement",
            "source": "trust-field-validator",
            "issue": issue,
            "suggestedAction": "Not applied; suggested only: Kept the breadcrumb node but flagged it because stronger hierarchy evidence is needed.",
            "before": [{"@type": "ListItem", "position": 1, "name": "Serum"}],
            "suggestedAfter": [{"@type": "ListItem", "position": 1, "name": "Serum"}],
            "evidence": ["BreadcrumbList.itemListElement", "schema hierarchy quality gate"],
        }
    ]
    assert run["diagnostics"]["evidence"][-1] == {
        "field": "validation",
        "source": "schema-validator",
        "value": f"BreadcrumbList.itemListElement: {issue}",
    }


@pytest.mark.parametrize("product_id", tuple(eval_products))
def test_benchmark_products_hold_the_retained_geo_cep_eeat_floors(product_id: str) -> None:
    """Port the legacy quality-threshold regression as a generator gate.

    The benchmark deliberately lacks optional offer/freshness source fields,
    so a passing floor proves the generated buyer-answer artifacts retain the
    source-supported customer and composition path rather than relying on
    synthetic commerce metadata.
    """

    product = eval_products[product_id]
    locale = "ko-KR" if product_id.startswith(("sample_derma-", "byeolmorae-")) else "en-US"
    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": product,
                "hints": {
                    "locale": locale,
                    "market": "KR" if locale == "ko-KR" else "US",
                    "brand": product.get("brand"),
                    "category": product.get("category"),
                },
            }
        )
    )

    evaluation = evaluate_geo_quality(
        {
            "jsonLd": run["result"]["schemaMarkup"]["jsonLd"],
            "diagnostics": run["diagnostics"],
        },
        "ko" if locale == "ko-KR" else "en",
    )
    scores = {dimension.id: dimension.score for dimension in evaluation.dimensions}
    assert run["diagnostics"]["validationWarnings"] == []
    assert run["diagnostics"]["validationRepairs"] == []
    assert scores["geo"] >= 90
    # The public synthetic corpus intentionally keeps customer evidence sparse:
    # no invented FAQ or review detail is added merely to inflate CEP coverage.
    assert scores["cep"] >= 85
    assert scores["eeat"] >= 90


def test_commerce_schema_fails_closed_and_renders_variant_policy_shipping_and_seller() -> None:
    """Port the legacy structured-commerce mapping path.

    The product-level identifiers are deliberately invalid.  The two variant
    identifiers are valid GS1 values, so a one-Offer fallback would lose real
    option-specific commerce facts while emitting the invalid product values.
    """

    run = asyncio.run(
        generate_pdp_geo(
            {
                "product": {
                    "geoProduct": {
                        "name": "Hydra Barrier Cream",
                        "description": "Barrier care.",
                        "benefits": ["hydration"],
                        "ingredients": ["ceramide"],
                        "sku": "product",
                        "gtin": "8801234567890",
                        "price": "29",
                        "currency": "USD",
                        "variants": [
                            {
                                "sku": "NEO-S",
                                "gtin": "4006381333931",
                                "title": "Small",
                                "price": "29",
                                "currency": "USD",
                                "url": "https://example.test/s",
                            },
                            {
                                "sku": "NEO-L",
                                "gtin": "9780201379624",
                                "title": "Large",
                                "price": "39",
                                "currency": "USD",
                                "url": "https://example.test/l",
                            },
                        ],
                        "returnPolicy": {
                            "category": "MerchantReturnFiniteReturnWindow",
                            "merchantReturnDays": 30,
                            "applicableCountry": "US",
                        },
                        "shipping": {
                            "destinationCountry": "US",
                            "handlingDaysMin": 0,
                            "handlingDaysMax": 1,
                            "transitDaysMin": 1,
                            "transitDaysMax": 6,
                        },
                    }
                },
                "hints": {
                    "locale": "en-US",
                    "market": "US",
                    "organization": {"name": "NEO", "url": "https://neo.example.test"},
                },
            }
        )
    )

    graph = run["result"]["schemaMarkup"]["jsonLd"]["@graph"]
    product = _node(graph, "Product")
    organization = _node(graph, "Organization")
    assert "sku" not in product
    assert "gtin" not in product
    assert isinstance(product["offers"], list)
    offers = cast(list[dict[str, Any]], product["offers"])
    assert [offer["sku"] for offer in offers] == ["NEO-S", "NEO-L"]
    assert [offer["gtin"] for offer in offers] == ["4006381333931", "9780201379624"]
    assert [offer["price"] for offer in offers] == [29.0, 39.0]
    assert [offer["url"] for offer in offers] == ["https://example.test/s", "https://example.test/l"]
    assert organization == {
        "@type": "Organization",
        "@id": "https://neo.example.test/#organization",
        "name": "NEO",
        "url": "https://neo.example.test",
    }
    for offer in offers:
        assert offer["seller"] == {"@id": organization["@id"]}
        assert offer["hasMerchantReturnPolicy"] == {
            "@type": "MerchantReturnPolicy",
            "returnPolicyCategory": "https://schema.org/MerchantReturnFiniteReturnWindow",
            "merchantReturnDays": 30,
            "applicableCountry": "US",
            "returnPolicyCountry": "US",
        }
        assert offer["shippingDetails"] == {
            "@type": "OfferShippingDetails",
            "shippingDestination": {"@type": "DefinedRegion", "addressCountry": "US"},
            "deliveryTime": {
                "@type": "ShippingDeliveryTime",
                "handlingTime": {"@type": "QuantitativeValue", "minValue": 0, "maxValue": 1, "unitCode": "DAY"},
                "transitTime": {"@type": "QuantitativeValue", "minValue": 1, "maxValue": 6, "unitCode": "DAY"},
            },
        }


def _planning_request() -> dict[str, Any]:
    product: dict[str, Any] = {
        "name": "Hydra Serum",
        "description": "A hydrating serum for dry skin.",
        "benefits": ["hydration"],
        "effects": [],
        "ingredients": ["ceramide"],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": [],
        "semanticFacts": {},
    }
    return {"product": product, "locale": "en-US", "evidenceLedger": create_pdp_geo_evidence_ledger(product, "en-US")}


def _wire_plan(request: dict[str, Any]) -> dict[str, Any]:
    """Produce a complete provider wire payload, not the Python-only ``mode`` field."""

    return {key: value for key, value in create_conservative_content_plan(request).items() if key != "mode"}


def _semantic_admission_product() -> dict[str, Any]:
    """Return source-complete PDP input for service-path admission regressions."""

    return {
        "name": "Barrier Serum",
        "brand": "Example Lab",
        "category": "serum",
        "description": "Barrier Serum is a serum for dry skin.",
        "ingredients": ["Ceramide Complex"],
        "benefits": ["supports hydration"],
        "effects": ["helps soothe dry skin"],
        "usage": [
            "Dispense two pumps and smooth over face and neck.",
            "Press gently to absorb.",
        ],
        "metrics": [
            "Instrumental testing found 1.3x hydration after 2 weeks. Individual results may vary.",
            "A 4-week panel recorded 96% participant satisfaction.",
        ],
        "options": [],
        "faq": [
            {
                "question": "Which ingredient is listed for Barrier Serum?",
                "answer": "Barrier Serum lists Ceramide Complex.",
            },
            {
                "question": "What hydration benefit is stated for Barrier Serum?",
                "answer": "Barrier Serum supports hydration.",
            },
        ],
        "reviews": {"items": [], "keywords": ["lightweight finish"]},
        "sourceTexts": [
            "Barrier Serum is a serum for dry skin.",
            "Ceramide Complex supports hydration.",
            "Instrumental testing found 1.3x hydration after 2 weeks. Individual results may vary.",
        ],
        "semanticFacts": {
            "skinTypes": ["dry skin"],
            "usageSteps": [
                "Dispense two pumps and smooth over face and neck.",
                "Press gently to absorb.",
            ],
            "metricClaims": [
                {
                    "metric": "hydration",
                    "value": "1.3",
                    "unit": "x",
                    "timing": "after 2 weeks",
                    "caveat": "Individual results may vary.",
                    "sourceText": (
                        "Instrumental testing found 1.3x hydration after 2 weeks. Individual results may vary."
                    ),
                }
            ],
        },
    }


def _semantic_admission_ids(request: Mapping[str, Any], role: str) -> list[str]:
    """Resolve real, normalized ledger IDs without coupling tests to their hashes."""

    identifiers = [
        cast(str, item["id"])
        for raw in cast(list[dict[str, Any]], request["evidenceLedger"])
        if (item := raw).get("role") == role and isinstance(item.get("id"), str)
    ]
    assert identifiers, f"semantic-admission fixture needs {role!r} evidence"
    return identifiers


def _service_run_with_semantic_candidate(
    product: Mapping[str, Any],
    mutate: Callable[[dict[str, Any], Mapping[str, Any]], None],
) -> dict[str, Any]:
    """Exercise the planner, service admission marker, and public renderer together."""

    async def planner(request: Mapping[str, Any]) -> dict[str, Any]:
        candidate = _wire_plan(dict(request))
        mutate(candidate, request)
        return {"plan": candidate}

    return asyncio.run(
        generate_pdp_geo(
            {"product": dict(product), "hints": {"locale": "en-US", "market": "US"}},
            {"customContentPlanner": planner, "qualityGate": {"enabled": False}},
        )
    )


def _service_result_text(run: Mapping[str, Any]) -> str:
    return json.dumps(run["result"], ensure_ascii=False)


def _assert_service_locally_rejected_unsafe_candidate(run: Mapping[str, Any]) -> None:
    """Unsafe units stay out while independent wire-valid model units remain usable."""

    assert cast(Mapping[str, Any], run["diagnostics"])["contentPlan"]["mode"] == "model"
    assert "qualityGate" not in cast(Mapping[str, Any], run["diagnostics"])


def _assert_service_rejected_malformed_candidate(run: Mapping[str, Any]) -> None:
    """Malformed nested wire data must never grant the model-plan marker."""

    assert cast(Mapping[str, Any], run["diagnostics"])["contentPlan"]["mode"] == "conservative"
    assert "qualityGate" not in cast(Mapping[str, Any], run["diagnostics"])


_SOURCE_BOUND_DESCRIPTION = (
    "Barrier Serum from Example Lab is a serum for dry skin. Ceramide Complex supports hydration. "
    "Instrumental testing found 1.3x hydration after 2 weeks. Individual results may vary. "
    "Customers mention a lightweight finish."
)


@pytest.mark.parametrize(
    ("case", "product_text", "webpage_text", "roles", "blocked_text"),
    [
        ("empty included product description", "", None, ("description",), ""),
        (
            "wrong-locale Korean description",
            "배리어 세럼은 임신 중 사용을 권장합니다.",
            None,
            ("identity", "description"),
            "배리어 세럼은 임신 중 사용을 권장합니다.",
        ),
        (
            "Product and WebPage clone",
            _SOURCE_BOUND_DESCRIPTION,
            _SOURCE_BOUND_DESCRIPTION,
            ("identity", "description", "ingredient", "benefit", "metric", "review", "usage"),
            "",
        ),
        (
            "canned WebPage wrapper",
            _SOURCE_BOUND_DESCRIPTION,
            "This product page is your complete shopping destination for Barrier Serum.",
            ("identity", "description", "ingredient", "benefit", "metric", "review", "usage"),
            "This product page is your complete shopping destination for Barrier Serum.",
        ),
        (
            "mixed direct fact and unsupported causal suitability claim",
            (
                "Barrier Serum supports hydration. Ceramide Complex causes Barrier Serum to soothe dry skin during "
                "pregnancy."
            ),
            None,
            ("ingredient", "benefit", "effect"),
            "Ceramide Complex causes Barrier Serum to soothe dry skin during pregnancy.",
        ),
        (
            "metric without its study qualifier",
            "Barrier Serum delivers 1.3x hydration.",
            None,
            ("metric",),
            "Barrier Serum delivers 1.3x hydration.",
        ),
        (
            "unrelated metric number and timing combination",
            "Barrier Serum delivered 1.3x hydration after 4 weeks.",
            None,
            ("metric",),
            "Barrier Serum delivered 1.3x hydration after 4 weeks.",
        ),
        (
            "invented safety recommendation",
            "Barrier Serum is safe and recommended during pregnancy.",
            None,
            ("identity",),
            "Barrier Serum is safe and recommended during pregnancy.",
        ),
        (
            "unproven ingredient-to-benefit bridge",
            "Ceramide Complex causes Barrier Serum to soothe dry skin.",
            None,
            ("ingredient", "effect"),
            "Ceramide Complex causes Barrier Serum to soothe dry skin.",
        ),
    ],
)
def test_service_locally_rejects_unsafe_model_descriptions_before_renderer_bypass(
    case: str,
    product_text: str,
    webpage_text: str | None,
    roles: tuple[str, ...],
    blocked_text: str,
) -> None:
    """Valid IDs alone cannot admit malformed, wrong-role, or unsupported public prose."""

    product = _semantic_admission_product()

    def mutate(plan: dict[str, Any], request: Mapping[str, Any]) -> None:
        evidence_ids = [identifier for role in roles for identifier in _semantic_admission_ids(request, role)]
        plan["productDescription"] = {
            **cast(dict[str, Any], plan["productDescription"]),
            "include": True,
            "text": product_text,
            "evidenceIds": evidence_ids,
            "confidence": 0.95,
            "omitReason": "",
        }
        if webpage_text is not None:
            plan["webPageDescription"] = {
                **cast(dict[str, Any], plan["webPageDescription"]),
                "include": True,
                "text": webpage_text,
                "evidenceIds": evidence_ids,
                "confidence": 0.95,
                "omitReason": "",
            }

    run = _service_run_with_semantic_candidate(product, mutate)

    _assert_service_locally_rejected_unsafe_candidate(run)
    public_text = _service_result_text(run)
    if blocked_text:
        assert blocked_text not in public_text
    graph = cast(list[dict[str, Any]], run["result"]["schemaMarkup"]["jsonLd"]["@graph"])
    rendered_product = _node(graph, "Product")
    if case == "empty included product description":
        assert rendered_product.get("description")
        assert "Barrier Serum from Example Lab is a serum for dry skin." in rendered_product["description"]
    if case == "Product and WebPage clone":
        assert rendered_product["description"] != _node(graph, "WebPage")["description"]


@pytest.mark.parametrize(
    "case",
    [
        "faq is not an array",
        "HowTo primitive and steps array are malformed",
        "CEP primitives are malformed",
    ],
    ids=lambda case: case,
)
def test_service_rejects_malformed_nested_model_plan_before_admission(case: str) -> None:
    """Wire-shaped nested primitives cannot turn a plan into a trusted renderer bypass."""

    product = _semantic_admission_product()

    def mutate(plan: dict[str, Any], request: Mapping[str, Any]) -> None:
        identity_evidence = _semantic_admission_ids(request, "identity")[0]
        if case == "faq is not an array":
            plan["faq"] = "not-an-array"
        elif case == "HowTo primitive and steps array are malformed":
            plan["howTo"] = {
                **cast(dict[str, Any], plan["howTo"]),
                "eligible": "yes",
                "ordered": "yes",
                "steps": {"not": "an array"},
                "confidence": "0.75",
            }
        else:
            plan["cep"] = [
                {
                    "situation": 42,
                    "need": ["hydration"],
                    "constraint": False,
                    "evidenceIds": [identity_evidence],
                    "confidence": "0.9",
                }
            ]

    run = _service_run_with_semantic_candidate(product, mutate)

    _assert_service_rejected_malformed_candidate(run)
    graph = cast(list[dict[str, Any]], run["result"]["schemaMarkup"]["jsonLd"]["@graph"])
    source_plan = create_conservative_content_plan(
        {"product": product, "locale": "en-US", "evidenceLedger": create_pdp_geo_evidence_ledger(product, "en-US")}
    )
    assert [step["text"] for step in _node(graph, "HowTo")["step"]] == [
        step["text"] for step in source_plan["howTo"]["steps"]
    ]


def test_service_isolates_a_wire_malformed_faq_row_from_the_rest_of_the_plan() -> None:
    """A malformed FAQ row is a rejected unit, not a reason to distrust the plan.

    The row itself stays exactly as untrusted as before: it yields no admitted
    FAQ and no renderer bypass.  What it no longer does is revoke the model
    marker from the descriptions, CEP, and procedure beside it.
    """

    product = _semantic_admission_product()

    def mutate(plan: dict[str, Any], request: Mapping[str, Any]) -> None:
        # Wire-complete apart from the one defect, so the row is rejected for a
        # non-boolean "include" rather than for a missing key.
        plan["faq"] = [
            _carded_faq_row(
                _semantic_admission_card(request, "formula-and-benefit"),
                _ADMISSIBLE_FAQ_QUESTION,
                _SOURCE_BOUND_FAQ_ANSWER,
                include="true",
            )
        ]

    run = _service_run_with_semantic_candidate(product, mutate)

    _assert_service_locally_rejected_unsafe_candidate(run)
    content_plan = cast(Mapping[str, Any], run["diagnostics"])["contentPlan"]
    assert content_plan["faq"] == []
    rejected = [
        field
        for field in cast(list[dict[str, Any]], content_plan["admissionDiagnostics"]["fields"])
        if field["outcome"] == "rejected"
    ]
    assert [field["field"] for field in rejected] == ["FAQ[0]"]
    assert rejected[0]["predicate"] == "wireSchema"


def test_service_rejects_unsupported_cep_context_before_admission() -> None:
    """A real identity ID cannot substantiate a pregnancy-safety CEP claim."""

    product = _semantic_admission_product()
    unsafe_context = "Barrier Serum is safe during pregnancy."

    def mutate(plan: dict[str, Any], request: Mapping[str, Any]) -> None:
        plan["cep"] = [
            {
                "situation": "During pregnancy",
                "need": unsafe_context,
                "constraint": "",
                "evidenceIds": _semantic_admission_ids(request, "identity"),
                "confidence": 0.9,
            }
        ]

    run = _service_run_with_semantic_candidate(product, mutate)

    _assert_service_locally_rejected_unsafe_candidate(run)
    assert unsafe_context not in _service_result_text(run)


# A question the card-scoped intent gate accepts, so a case's own defect is what
# trips admission rather than the question shape.
_ADMISSIBLE_FAQ_QUESTION = "How does Example Lab's Barrier Serum support hydration for dry skin?"
_SOURCE_BOUND_FAQ_ANSWER = "Example Lab's Barrier Serum is a serum for dry skin. Ceramide Complex supports hydration."


def _semantic_admission_card(request: Mapping[str, Any], intent: str) -> dict[str, Any]:
    """Return the service-generated relationship card a model row must select."""

    cards = cast(list[dict[str, Any]], request["faqRelationshipCards"])
    card = next((item for item in cards if item.get("intent") == intent), None)
    assert card is not None, f"semantic-admission fixture needs a {intent!r} relationship card"
    return card


def _carded_faq_row(card: Mapping[str, Any], question: str, answer: str, **overrides: Any) -> dict[str, Any]:
    """Build a wire-complete FAQ row bound to ``card``.

    The ``id`` matters: without it the row dies at the wire-schema gate and every
    semantic gate below stays unevaluated, which silently turns a rejection test
    into a test of nothing.
    """

    return {
        "id": card["id"],
        "include": True,
        "question": question,
        "answer": answer,
        "intent": card["intent"],
        "cep": "",
        "evidenceIds": list(cast(list[str], card["evidenceIds"])),
        "confidence": 0.95,
        "omitReason": "",
    } | overrides


def _published_faq_text(run: Mapping[str, Any]) -> list[str]:
    """Return published FAQ question and answer text, empty when no page was emitted."""

    graph = cast(list[dict[str, Any]], run["result"]["schemaMarkup"]["jsonLd"]["@graph"])
    page = next((node for node in graph if node.get("@type") == "FAQPage"), None)
    if page is None:
        return []
    return [
        cast(str, value)
        for item in cast(list[dict[str, Any]], page["mainEntity"])
        for value in (item["name"], item["acceptedAnswer"]["text"])
    ]


def _rejected_faq_predicates(run: Mapping[str, Any]) -> list[str]:
    fields = cast(
        list[dict[str, Any]],
        cast(Mapping[str, Any], run["diagnostics"])["contentPlan"]["admissionDiagnostics"]["fields"],
    )
    return [
        cast(str, field.get("predicate"))
        for field in fields
        if field["field"].startswith("FAQ") and field["outcome"] == "rejected"
    ]


@pytest.mark.parametrize(
    ("case", "predicates"),
    [
        ("generic question", ["customerDecisionQuestion"]),
        ("wrong-locale question and answer", ["customerDecisionQuestion"]),
        ("unsupported recommendation", ["sourceSupport"]),
        ("unattributed review claim", ["relationshipCardEvidence"]),
        ("semantic duplicate", ["sourceSupport", "buyerAnchor"]),
    ],
    ids=[
        "generic question",
        "wrong-locale question and answer",
        "unsupported recommendation",
        "unattributed review claim",
        "semantic duplicate",
    ],
)
def test_service_rejects_unsafe_model_faqs_before_renderer_bypass(case: str, predicates: list[str]) -> None:
    """FAQ rows need product intent, locale, direct support, review attribution, and distinct meaning.

    Every row here is wire-complete and card-bound on purpose, so each case is
    answered by a semantic gate rather than by the wire-schema gate.  Asserting
    the rejection predicate is what keeps that true: a row that silently stopped
    reaching the named gate would change the predicate and fail here.
    """

    product = _semantic_admission_product()
    blocked_text: str | None = None

    def mutate(plan: dict[str, Any], request: Mapping[str, Any]) -> None:
        nonlocal blocked_text
        formula_card = _semantic_admission_card(request, "formula-and-benefit")
        if case == "generic question":
            blocked_text = "Which product is better?"
            plan["faq"] = [_carded_faq_row(formula_card, blocked_text, _SOURCE_BOUND_FAQ_ANSWER)]
        elif case == "wrong-locale question and answer":
            blocked_text = "배리어 세럼은 세라마이드 콤플렉스를 포함합니다."
            plan["faq"] = [_carded_faq_row(formula_card, "배리어 세럼은 어떤 성분을 포함하나요?", blocked_text)]
        elif case == "unsupported recommendation":
            blocked_text = "Example Lab's Barrier Serum is recommended during pregnancy."
            plan["faq"] = [_carded_faq_row(formula_card, _ADMISSIBLE_FAQ_QUESTION, blocked_text)]
        elif case == "unattributed review claim":
            blocked_text = "Example Lab's Barrier Serum has a lightweight finish."
            plan["faq"] = [
                _carded_faq_row(
                    formula_card,
                    _ADMISSIBLE_FAQ_QUESTION,
                    blocked_text,
                    evidenceIds=[_semantic_admission_ids(request, "review")[0]],
                )
            ]
        else:
            blocked_text = "Ceramide Complex supports hydration for Example Lab's Barrier Serum."
            plan["faq"] = [
                _carded_faq_row(formula_card, _ADMISSIBLE_FAQ_QUESTION, _SOURCE_BOUND_FAQ_ANSWER),
                _carded_faq_row(
                    _semantic_admission_card(request, "buyer-decision"),
                    _ADMISSIBLE_FAQ_QUESTION,
                    blocked_text,
                ),
            ]

    run = _service_run_with_semantic_candidate(product, mutate)

    _assert_service_locally_rejected_unsafe_candidate(run)
    assert blocked_text is not None
    assert not any(blocked_text in published for published in _published_faq_text(run))
    assert _rejected_faq_predicates(run) == predicates


def test_service_replaces_shallow_source_field_faqs_with_distinct_customer_decision_answers() -> None:
    """Two cited labels must not displace the 2–3 useful buyer questions."""

    product = _semantic_admission_product()
    expected_pairs = [
        ("Which ingredient is listed for Barrier Serum?", "Barrier Serum lists Ceramide Complex."),
        ("What hydration benefit is stated for Barrier Serum?", "Barrier Serum supports hydration."),
    ]

    def mutate(plan: dict[str, Any], request: Mapping[str, Any]) -> None:
        faq_ids = _semantic_admission_ids(request, "faq")
        plan["faq"] = [
            {
                "include": True,
                "question": question,
                "answer": answer,
                "intent": "source FAQ",
                "cep": "",
                "evidenceIds": [faq_ids[index]],
                "confidence": 1,
                "omitReason": "",
            }
            for index, (question, answer) in enumerate(expected_pairs)
        ]

    run = _service_run_with_semantic_candidate(product, mutate)

    assert run["diagnostics"]["contentPlan"]["mode"] == "model"
    graph = cast(list[dict[str, Any]], run["result"]["schemaMarkup"]["jsonLd"]["@graph"])
    rendered_pairs = [
        (item["name"], cast(dict[str, str], item["acceptedAnswer"])["text"])
        for item in _node(graph, "FAQPage")["mainEntity"]
    ]
    expected_buyer = (
        "What should people with dry skin know about Example Lab's Barrier Serum?",
        "Example Lab's Barrier Serum is a serum for dry skin. Example Lab's Barrier Serum includes Ceramide Complex. "
        "Example Lab's Barrier Serum supports hydration. Example Lab's Barrier Serum helps soothe dry skin. "
        "Instrumental testing found 1.3x hydration after 2 weeks. Individual results may vary.",
    )
    assert rendered_pairs == [
        expected_buyer,
        (
            "How should Example Lab's Barrier Serum be used?",
            "Dispense two pumps and smooth over face and neck. Press gently to absorb.",
        ),
        (
            "What do customers positively note about Example Lab's Barrier Serum?",
            "Customers who reviewed Example Lab's Barrier Serum positively noted lightweight finish.",
        ),
    ]
    assert 2 <= len(rendered_pairs) <= 3
    assert not any(question in {pair[0] for pair in expected_pairs} for question, _ in rendered_pairs)
    assert all("source-field question" in warning for warning in run["diagnostics"]["contentPlan"]["warnings"])
    assert len({question.casefold() for question, _ in rendered_pairs}) == len(rendered_pairs)
    provenance = [
        item
        for item in run["diagnostics"]["finalPublicCopyProvenance"]
        if str(item["fieldPath"]).startswith("FAQPage.mainEntity")
    ]
    assert provenance
    assert all(sentence["evidenceIds"] for item in provenance for sentence in item["sentences"])


def test_content_planning_honors_disable_rejects_unbacked_plan_and_invokes_enabled_openai() -> None:
    """Exercise the TS resolver precedence and strict evidence-plan admission gate."""

    request = _planning_request()
    custom_calls = 0

    async def custom(_: dict[str, Any]) -> dict[str, Any]:
        nonlocal custom_calls
        custom_calls += 1
        return {"plan": _wire_plan(request)}

    disabled = asyncio.run(
        plan_pdp_geo_content(
            request,
            {"contentPlanning": {"enabled": False}, "customContentPlanner": custom},
        )
    )
    assert custom_calls == 0
    assert disabled["called"] is False
    assert disabled["applied"] is False
    assert disabled["plan"]["mode"] == "conservative"

    async def unbacked(_: dict[str, Any]) -> dict[str, Any]:
        return {
            "plan": {
                "locale": "en-US",
                "productDescription": {
                    "include": True,
                    "text": "Hydra Serum provides hydration.",
                    "intent": "product-entity-summary",
                    "evidenceIds": ["invented-evidence-id"],
                    "confidence": 0.99,
                    "omitReason": "",
                },
            }
        }

    rejected = asyncio.run(plan_pdp_geo_content(request, {"customContentPlanner": unbacked}))
    assert rejected["called"] is True
    assert rejected["applied"] is False
    assert rejected["plan"]["mode"] == "conservative"
    assert any("evidence" in warning.lower() or "schema" in warning.lower() for warning in rejected["warnings"])

    requests: list[dict[str, Any]] = []

    async def openai_handler(http_request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(http_request.content))
        return httpx.Response(200, json={"output_text": json.dumps(_wire_plan(request))})

    enabled = asyncio.run(
        plan_pdp_geo_content(
            request,
            {
                "contentPlanning": {
                    "enabled": True,
                    "provider": "openai",
                    "apiKey": "test-key",
                    "model": "gpt-test",
                    "transport": httpx.MockTransport(openai_handler),
                }
            },
        )
    )
    assert enabled["called"] is True
    assert enabled["applied"] is True
    # A native planner's valid first pass is still audited through the bounded
    # second request.  The audit carries the candidate plan rather than
    # silently trusting the initial provider JSON.
    assert len(requests) == 2
    assert requests[0]["model"] == "gpt-test"
    assert requests[0]["text"]["format"]["name"] == "pdp_geo_content_plan"
    second_payload = json.loads(requests[1]["input"])
    assert second_payload["candidatePlan"] == _wire_plan(request)
    assert second_payload["correctiveFeedback"] == [
        {
            "field": "content-plan",
            "reason": "Audit every candidatePlan clause for semantic entailment, claim modality, locale, and evidence-ID relevance; return a corrected full plan.",
        }
    ]


def test_content_planner_corrects_an_empty_custom_first_response_once() -> None:
    """A custom planner gets one schema-directed recovery request, not a fallback."""

    request = _planning_request()
    requests: list[dict[str, Any]] = []

    async def custom(candidate: Mapping[str, Any]) -> dict[str, Any]:
        requests.append(dict(candidate))
        return {} if len(requests) == 1 else {"plan": _wire_plan(request)}

    result = asyncio.run(plan_pdp_geo_content(request, {"customContentPlanner": custom}))

    assert result["called"] is True
    assert result["applied"] is True
    assert result["plan"]["mode"] == "model"
    # 교정 패스는 한 번만 돈다. 세 번째 호출은 별개의 FAQ 복구 패스다.
    assert len(requests) == 3
    assert "candidatePlan" not in requests[1]
    assert requests[1]["planningFeedback"] == [
        {
            "field": "content-plan",
            "reason": "The provider returned no parseable plan matching the required JSON schema.",
        }
    ]
    assert requests[2]["faqRecoveryOnly"] is True


def test_url_rag_preserves_markdown_sections_and_filters_non_geo_auth_boilerplate() -> None:
    """Port the exact resolved-URL fixture from the legacy RAG profile test."""

    product = {
        "name": "Reference Serum",
        "benefits": ["hydration"],
        "effects": [],
        "ingredients": ["Niacinamide"],
        "usage": ["Apply after toner."],
        "metrics": [],
        "faq": [],
        "reviews": {"keywords": ["lightweight texture"], "items": []},
        "images": [],
        "options": [],
        "breadcrumbs": [],
        "sourceTexts": [],
    }

    class Resolver:
        async def resolve(self, request: dict[str, object]) -> dict[str, object]:
            assert request["url"] == "https://example.com/geo-trends"
            return {
                "url": request["url"],
                "title": "GEO Trend Note",
                "content": "\n".join(
                    (
                        "## Authentication Setup",
                        "Install the SDK, create an API key, configure billing, and run curl commands.",
                        "",
                        "## Review-led FAQ Eligibility",
                        "Generative search answers prefer customer review questions when FAQ answers include source-backed review language.",
                        "",
                        "## Evidence-backed Claims",
                        "Claims need citation-ready metrics, source support, and Product additionalProperty mapping.",
                    )
                ),
                "contentType": "text/markdown",
            }

    rows = asyncio.run(
        retrieve_pdp_geo_rag_chunks(
            {
                "query": create_pdp_geo_rag_query(product, "en-US", "US"),
                "product": product,
                "locale": "en-US",
                "market": "US",
                "documents": [
                    {
                        "name": "custom-geo-links.md",
                        "version": "v1",
                        "content": "Read the latest GEO trend note: https://example.com/geo-trends",
                    }
                ],
                "settings": resolve_pdp_geo_rag_settings(
                    {"resolveUrls": True, "maxResolvedUrlDocuments": 1, "maxChunks": 10, "scoreThreshold": 0}
                ),
            },
            {"customUrlResolver": Resolver()},
        )
    )
    source_rows = [row for row in rows if row["source"] == "https://example.com/geo-trends"]
    titles = {row.get("title") for row in source_rows}
    assert "Authentication Setup" not in titles
    faq = next(row for row in source_rows if row.get("title") == "Review-led FAQ Eligibility")
    claims = next(row for row in source_rows if row.get("title") == "Evidence-backed Claims")
    assert {"faq", "review"} <= set(faq["intents"])
    assert "FAQPage.mainEntity" in faq["fieldTargets"]
    assert {"claims", "evidence"} <= set(claims["intents"])
    assert "Product.additionalProperty" in claims["fieldTargets"]
    assert "Source URL: https://example.com/geo-trends" in source_rows[0]["text"] or all(
        row["metadata"].get("version") == "v1" for row in source_rows
    )

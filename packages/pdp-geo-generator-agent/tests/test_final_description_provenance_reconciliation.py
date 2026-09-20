"""Regression coverage for retaining safe final-description provenance."""

from __future__ import annotations

import asyncio
import copy
from collections.abc import Mapping
from typing import Any, cast

import pytest
from pdp_geo_eval_agent.benchmark import eval_products

import pdp_geo_generator_agent.final_proofreader as final_proofreader
import pdp_geo_generator_agent.service as service
from pdp_geo_generator_agent.content_planning import create_conservative_content_plan
from pdp_geo_generator_agent.final_proofreader import (
    create_pdp_geo_public_copy_provenance,
    reconcile_pdp_geo_public_copy_provenance,
)
from pdp_geo_generator_agent.validation import serialize_schema_markup, validate_pdp_geo_artifacts


def _source_product() -> dict[str, Any]:
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
        "metrics": [],
        "options": [],
        "faq": [
            {
                "question": "What does Barrier Serum include?",
                "answer": "Barrier Serum includes Ceramide Complex.",
            }
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
                    "sourceText": "Instrumental testing found 1.3x hydration after 2 weeks. Individual results may vary.",
                }
            ],
        },
    }


def _public_copy_paths(provenance: list[dict[str, Any]]) -> set[str]:
    return {str(entry["fieldPath"]) for entry in provenance}


def _find_node(schema_markup: Mapping[str, Any], kind: str) -> dict[str, Any]:
    graph = cast(list[dict[str, Any]], cast(Mapping[str, Any], schema_markup["jsonLd"])["@graph"])
    return next(
        node for node in graph if kind in (node["@type"] if isinstance(node["@type"], list) else [node["@type"]])
    )


class _NoopCopyRefiner:
    def refine_copy(self, _request: Mapping[str, Any]) -> dict[str, Any]:
        return {}


class _PunctuationOnlyDescriptionProofreader:
    """Makes a gate-approved final prose edit to both description fields."""

    def proofread(self, request: Mapping[str, Any]) -> dict[str, Any]:
        edits: list[dict[str, Any]] = []
        for raw in cast(list[Mapping[str, Any]], request["fields"]):
            field = dict(raw)
            path = str(field["fieldPath"])
            text = str(field["text"])
            revised = (
                text.replace(
                    "Barrier Serum from Example Lab includes Ceramide Complex.",
                    "Barrier Serum, from Example Lab, includes Ceramide Complex.",
                    1,
                )
                if path in {"Product.description", "WebPage.description"}
                else text
            )
            edits.append(
                {
                    "fieldPath": path,
                    "sourceHash": field["sourceHash"],
                    "action": "revise" if revised != text else "keep",
                    "revisedText": revised,
                    "issueCodes": ["punctuation"] if revised != text else [],
                }
            )
        return {"edits": edits, "warnings": []}


class _RecordingNoopCopyRefiner:
    """Records both refinement passes while preserving the generated artifact."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    def refine_copy(self, request: Mapping[str, Any]) -> dict[str, Any]:
        self.requests.append(copy.deepcopy(dict(request)))
        return {"warnings": []}


class _RecordingKeepProofreader:
    """Records eligible fields and returns a complete no-change envelope."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    def proofread(self, request: Mapping[str, Any]) -> dict[str, Any]:
        self.requests.append(copy.deepcopy(dict(request)))
        return {
            "edits": [
                {
                    "fieldPath": field["fieldPath"],
                    "sourceHash": field["sourceHash"],
                    "action": "keep",
                    "revisedText": field["text"],
                    "issueCodes": [],
                }
                for field in cast(list[Mapping[str, str]], request["fields"])
            ],
            "warnings": [],
        }


@pytest.mark.parametrize("product_id", ("byeolmorae-waterfold-toner", "byeolmorae-cloudveil-mist"))
def test_synthetic_korean_renderer_descriptions_keep_complete_final_sentence_provenance(product_id: str) -> None:
    """Source-backed Korean renderer copy keeps each final description sentence bound."""

    product = eval_products[product_id]
    run = asyncio.run(
        service.generate_pdp_geo(
            {
                "product": product,
                "hints": {
                    "locale": "ko-KR",
                    "market": "KR",
                    "brand": product.get("brand"),
                    "category": product.get("category"),
                },
            },
            {"qualityGate": {"enabled": False}},
        )
    )

    diagnostics = cast(Mapping[str, Any], run["diagnostics"])
    bindings = {
        str(entry["fieldPath"]): entry
        for entry in cast(list[dict[str, Any]], diagnostics["finalPublicCopyProvenance"])
    }
    for path in ("Product.description", "WebPage.description"):
        sentences = cast(list[Mapping[str, Any]], bindings[path]["sentences"])
        assert sentences
        assert all(sentence["evidenceIds"] for sentence in sentences)
    assert not any(
        finding["source"] == "public-copy-provenance"
        and finding["field"] in {"Product.description", "WebPage.description"}
        for finding in cast(list[dict[str, Any]], diagnostics["validationFindings"])
    )
    assert diagnostics["validationRepairs"] == []


def test_sparse_english_description_keeps_a_named_source_anchor_without_a_category_tautology() -> None:
    """A terse source descriptor becomes a useful named product sentence.

    The fallback must not pad a product description with ``<name> is a
    cream`` when the source already supplies a more useful descriptor.  The
    named attribution still needs both identity and description provenance,
    so an unsupported rewrite cannot quietly replace the source fact.
    """

    product: dict[str, Any] = {
        "name": "Hydra Barrier Cream",
        "brand": "Neo",
        "category": "cream",
        "description": "Daily hydration cream for dry skin.",
        "ingredients": ["Ceramide"],
        "benefits": ["Supports hydration"],
        "effects": [],
        "usage": ["Apply after serum."],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["Daily hydration cream for dry skin.", "Apply after serum."],
    }

    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": product, "hints": {"locale": "en-US", "market": "US"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    product_description = str(_find_node(cast(Mapping[str, Any], run["result"])["schemaMarkup"], "Product")["description"])
    assert "Hydra Barrier Cream from Neo is described as a daily hydration cream for dry skin." in product_description
    assert "Hydra Barrier Cream from Neo is a cream." not in product_description

    binding = next(
        item
        for item in cast(list[dict[str, Any]], cast(Mapping[str, Any], run["diagnostics"])["finalPublicCopyProvenance"])
        if item["fieldPath"] == "Product.description"
    )
    sentence = next(
        item
        for item in cast(list[dict[str, Any]], binding["sentences"])
        if item["text"] == "Hydra Barrier Cream from Neo is described as a daily hydration cream for dry skin."
    )
    assert len(cast(list[str], sentence["evidenceIds"])) >= 2


def test_korean_named_source_description_keeps_its_direct_target_and_identity_provenance() -> None:
    """Branding a source subject must not turn a direct Korean target into an unbound rewrite."""

    product: dict[str, Any] = {
        "name": "수분 세럼",
        "brand": "예시 랩",
        "category": "Reviews",
        "description": "수분 세럼은 건조한 피부를 위한 제품입니다.",
        "ingredients": ["세라마이드"],
        "benefits": ["수분 케어"],
        "effects": [],
        "usage": ["세안 후 얼굴에 부드럽게 펴 바릅니다."],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["수분 세럼은 건조한 피부를 위한 제품입니다."],
    }
    lead = "예시 랩의 수분 세럼은 건조한 피부를 위한 제품입니다."

    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": product, "hints": {"locale": "ko-KR", "market": "KR"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    result = cast(Mapping[str, Any], run["result"])
    assert lead in _find_node(result["schemaMarkup"], "Product")["description"]
    assert lead in _find_node(result["schemaMarkup"], "WebPage")["description"]

    bindings = cast(list[dict[str, Any]], cast(Mapping[str, Any], run["diagnostics"])["finalPublicCopyProvenance"])
    for path in ("Product.description", "WebPage.description"):
        binding = next(item for item in bindings if item["fieldPath"] == path)
        sentence = next(item for item in binding["sentences"] if item["text"] == lead)
        assert len(cast(list[str], sentence["evidenceIds"])) >= 2
    assert not any(
        finding["source"] == "public-copy-provenance"
        for finding in cast(list[dict[str, Any]], cast(Mapping[str, Any], run["diagnostics"])["validationFindings"])
    )


def test_model_plan_descriptions_keep_sentence_bindings_for_direct_commerce_facts() -> None:
    """Admitted rich copy may state a source-backed option without losing its whole field."""

    product_description = "Barrier Serum is available in a 30 ml option."
    webpage_description = "On the Barrier Serum product page, the 30 ml option is listed."
    question = "Which size option is listed for Barrier Serum?"
    answer = product_description
    usage = "Apply Barrier Serum to clean skin."
    ledger = [
        {
            "id": "identity",
            "role": "identity",
            "text": "Barrier Serum",
            "sourcePath": "product.name",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "commerce",
            "role": "commerce",
            "text": product_description,
            "sourcePath": "product.options[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "faq",
            "role": "faq",
            "text": f"{question}\n{answer}",
            "sourcePath": "product.faq[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        {
            "id": "usage",
            "role": "usage",
            "text": usage,
            "sourcePath": "product.usage[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
    ]
    schema_markup = serialize_schema_markup(
        {
            "@context": "https://schema.org",
            "@graph": [
                {"@type": "Product", "name": "Barrier Serum", "description": product_description},
                {"@type": "WebPage", "description": webpage_description},
                {
                    "@type": "FAQPage",
                    "mainEntity": [
                        {
                            "@type": "Question",
                            "name": question,
                            "acceptedAnswer": {"@type": "Answer", "text": answer},
                        }
                    ],
                },
                {"@type": "HowTo", "step": [{"@type": "HowToStep", "text": usage}]},
            ],
        }
    )
    plan = {
        "mode": "model",
        "productDescription": {"include": True, "text": product_description, "evidenceIds": ["identity", "commerce"]},
        "webPageDescription": {"include": True, "text": webpage_description, "evidenceIds": ["identity", "commerce"]},
        "faq": [{"include": True, "question": question, "answer": answer, "evidenceIds": ["faq", "commerce"]}],
        "howTo": {"steps": [{"text": usage, "evidenceIds": ["usage"]}]},
    }

    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": schema_markup, "contentPlan": plan, "evidenceLedger": ledger}
    )
    by_path = {entry["fieldPath"]: entry for entry in provenance}

    assert {"Product.description", "WebPage.description"} <= set(by_path)
    assert "commerce" in by_path["Product.description"]["sentences"][0]["evidenceIds"]
    assert "commerce" in by_path["WebPage.description"]["sentences"][0]["evidenceIds"]
    assert any(path.startswith("FAQPage.") for path in by_path)
    assert any(path.startswith("HowTo.") for path in by_path)


def test_service_keeps_admitted_rich_model_description_provenance() -> None:
    """The admitted-plan path retains a naturally branded description without a rewrite."""

    product = _source_product()
    product_description = "Example Lab's Barrier Serum is available in a 30 ml option."
    webpage_description = "On the Example Lab Barrier Serum product page, the 30 ml option is listed."
    product["options"] = [product_description]

    async def planner(request: Mapping[str, Any]) -> dict[str, Any]:
        plan = create_conservative_content_plan(request)
        commerce_id = next(
            str(entry["id"])
            for entry in cast(list[Mapping[str, Any]], request["evidenceLedger"])
            if entry["role"] == "commerce"
        )
        identity_ids = [
            str(entry["id"])
            for entry in cast(list[Mapping[str, Any]], request["evidenceLedger"])
            if entry["role"] == "identity"
        ]
        plan["productDescription"] = {
            "include": True,
            "text": product_description,
            "intent": "product-entity-summary",
            "evidenceIds": [*identity_ids, commerce_id],
            "confidence": 1,
            "omitReason": "",
        }
        plan["webPageDescription"] = {
            "include": True,
            "text": webpage_description,
            "intent": "page-coverage-summary",
            "evidenceIds": [*identity_ids, commerce_id],
            "confidence": 1,
            "omitReason": "",
        }
        return {"plan": {key: value for key, value in plan.items() if key != "mode"}}

    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": product, "hints": {"locale": "en-US"}},
            {"customContentPlanner": planner, "qualityGate": {"enabled": False}},
        )
    )

    diagnostics = run["diagnostics"]
    provenance = {
        entry["fieldPath"]: entry for entry in cast(list[dict[str, Any]], diagnostics["finalPublicCopyProvenance"])
    }
    assert diagnostics["contentPlan"]["mode"] == "model"
    assert diagnostics["finalProofreading"]["applied"] is False
    assert provenance["Product.description"]["text"] == product_description
    assert provenance["WebPage.description"]["text"] == webpage_description
    assert all(
        entry["origin"] == "model-plan"
        and any("commerce" in evidence_id for evidence_id in entry["sentences"][0]["evidenceIds"])
        for entry in (provenance["Product.description"], provenance["WebPage.description"])
    )
    assert not any(finding["source"] == "public-copy-provenance" for finding in diagnostics["validationFindings"])


def test_service_retains_admitted_price_descriptions_through_noop_model_stages() -> None:
    """A cited literal price remains bound through the final no-op model stages."""

    product = _source_product()
    product.update(
        {
            "name": "Apex Lotion",
            "brand": "Apex",
            "category": "lotion",
            "description": "Apex Lotion is a lotion.",
            "options": ["Apex Lotion price: $40."],
            "sourceTexts": ["Apex Lotion is a lotion.", "Apex Lotion price: $40."],
        }
    )
    product_description = "Apex Lotion has a price of $40."
    webpage_description = "On the Apex Lotion product page, the price is $40."
    copy_refiner = _RecordingNoopCopyRefiner()
    proofreader = _RecordingKeepProofreader()

    async def planner(request: Mapping[str, Any]) -> dict[str, Any]:
        plan = create_conservative_content_plan(request)
        commerce_id = next(
            str(entry["id"])
            for entry in cast(list[Mapping[str, Any]], request["evidenceLedger"])
            if entry["role"] == "commerce"
        )
        plan["productDescription"] = {
            "include": True,
            "text": product_description,
            "intent": "product-entity-summary",
            "evidenceIds": [commerce_id],
            "confidence": 1,
            "omitReason": "",
        }
        plan["webPageDescription"] = {
            "include": True,
            "text": webpage_description,
            "intent": "page-coverage-summary",
            "evidenceIds": [commerce_id],
            "confidence": 1,
            "omitReason": "",
        }
        return {"plan": {key: value for key, value in plan.items() if key != "mode"}}

    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": product, "hints": {"locale": "en-US"}},
            {
                "customContentPlanner": planner,
                "customCopyRefiner": copy_refiner,
                "customFinalProofreader": proofreader,
                "copyRefinement": {"enabled": True},
                "qualityGate": {"enabled": True, "thresholds": {"geo": 101, "cep": 0, "eeat": 0}},
            },
        )
    )

    diagnostics = run["diagnostics"]
    provenance = {
        entry["fieldPath"]: entry for entry in cast(list[dict[str, Any]], diagnostics["finalPublicCopyProvenance"])
    }
    proofread_paths = {
        field["fieldPath"]
        for field in cast(list[Mapping[str, str]], proofreader.requests[0]["fields"])
    }

    assert diagnostics["contentPlan"]["mode"] == "model"
    assert diagnostics["finalProofreading"]["called"] is True
    assert diagnostics["finalProofreading"]["applied"] is False
    assert diagnostics["qualityGate"]["attempted"] is True
    assert len(copy_refiner.requests) == 2
    assert len(proofreader.requests) == 1
    assert {"Product.description", "WebPage.description"} <= proofread_paths
    assert {"Product.description", "WebPage.description"} <= set(provenance)
    assert provenance["Product.description"]["text"] == product_description
    assert provenance["WebPage.description"]["text"] == webpage_description
    assert all(
        any("commerce" in evidence_id for evidence_id in provenance[path]["sentences"][0]["evidenceIds"])
        for path in ("Product.description", "WebPage.description")
    )
    assert not any(finding["source"] == "public-copy-provenance" for finding in diagnostics["validationFindings"])


def test_model_plan_cannot_bind_an_ungrounded_description_through_commerce_evidence() -> None:
    """A direct option fact never launders an unrelated therapeutic assertion."""

    unsafe = "Barrier Serum cures acne overnight."
    ledger = [
        {
            "id": "commerce",
            "role": "commerce",
            "text": "Barrier Serum is available in a 30 ml option.",
            "sourcePath": "product.options[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        }
    ]
    schema_markup = serialize_schema_markup(
        {
            "@context": "https://schema.org",
            "@graph": [
                {"@type": "Product", "name": "Barrier Serum", "description": unsafe},
                {"@type": "WebPage", "description": unsafe},
            ],
        }
    )
    plan = {
        "mode": "model",
        "productDescription": {"include": True, "text": unsafe, "evidenceIds": ["commerce"]},
        "webPageDescription": {"include": True, "text": unsafe, "evidenceIds": ["commerce"]},
    }

    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": schema_markup, "contentPlan": plan, "evidenceLedger": ledger}
    )
    report = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": schema_markup,
            "evidenceLedger": ledger,
            "publicCopyProvenance": provenance,
        }
    )

    assert not {"Product.description", "WebPage.description"} & _public_copy_paths(provenance)
    assert {
        finding["field"] for finding in report["validationFindings"] if finding["source"] == "public-copy-provenance"
    } >= {"Product.description", "WebPage.description"}


@pytest.mark.parametrize(
    ("unsafe", "commerce_source"),
    [
        (
            "On the Apex Lotion product page, the price is $40 and it helps soothe dry skin.",
            "Apex Lotion price: $40.",
        ),
        (
            "On the Apex Lotion product page, the price is $40 and it is recommended for dry skin.",
            "Apex Lotion price: $40.",
        ),
        (
            "On the Apex Lotion product page, the price is $40 and it has 5 stars.",
            "Apex Lotion price: $40; 5 stars.",
        ),
    ],
)
def test_commerce_price_provenance_rejects_sensitive_claims(unsafe: str, commerce_source: str) -> None:
    """A price source cannot be extended into a benefit, recommendation, or rating claim."""

    ledger = [
        {
            "id": "commerce",
            "role": "commerce",
            "text": commerce_source,
            "sourcePath": "product.options[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        }
    ]
    schema_markup = serialize_schema_markup(
        {
            "@context": "https://schema.org",
            "@graph": [
                {"@type": "Product", "name": "Apex Lotion", "description": unsafe},
                {"@type": "WebPage", "description": unsafe},
            ],
        }
    )
    plan = {
        "mode": "model",
        "productDescription": {"include": True, "text": unsafe, "evidenceIds": ["commerce"]},
        "webPageDescription": {"include": True, "text": unsafe, "evidenceIds": ["commerce"]},
    }

    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": schema_markup, "contentPlan": plan, "evidenceLedger": ledger}
    )

    assert not {"Product.description", "WebPage.description"} & _public_copy_paths(provenance)


def test_reconciler_retains_valid_final_descriptions_when_fresh_matching_omits_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A final binding remains valid even when a fresh planner match cannot rediscover it."""

    baseline = asyncio.run(
        service.generate_pdp_geo(
            {"product": _source_product(), "hints": {"locale": "en-US"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    diagnostics = baseline["diagnostics"]
    prior = cast(list[dict[str, Any]], diagnostics["finalPublicCopyProvenance"])
    schema_markup = copy.deepcopy(cast(dict[str, Any], baseline["result"]["schemaMarkup"]))
    content = copy.deepcopy(cast(dict[str, Any], baseline["result"]["content"]))
    ledger = cast(list[dict[str, Any]], diagnostics["evidenceLedger"])
    plan = cast(dict[str, Any], diagnostics["contentPlan"])
    for kind in ("Product", "WebPage"):
        node = _find_node(schema_markup, kind)
        node["description"] = str(node["description"]).replace(
            "Barrier Serum from Example Lab is a serum.",
            "Barrier Serum, from Example Lab, is a serum.",
            1,
        )
    content["sections"]["description"] = _find_node(schema_markup, "Product")["description"]
    retained_non_descriptions = [entry for entry in prior if entry["fieldPath"].startswith(("FAQPage.", "HowTo."))]

    def rebuild_without_descriptions(_input: Mapping[str, Any]) -> list[dict[str, Any]]:
        return retained_non_descriptions

    monkeypatch.setattr(
        final_proofreader,
        "create_pdp_geo_public_copy_provenance",
        rebuild_without_descriptions,
    )

    reconciled = reconcile_pdp_geo_public_copy_provenance(
        {
            "schemaMarkup": schema_markup,
            "contentPlan": plan,
            "evidenceLedger": ledger,
            "publicCopyProvenance": prior,
        }
    )
    report = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": schema_markup,
            "content": content,
            "evidenceLedger": ledger,
            "publicCopyProvenance": reconciled,
        }
    )

    paths = _public_copy_paths(reconciled)
    assert {"Product.description", "WebPage.description"} <= paths
    assert all(
        entry["text"] == _find_node(schema_markup, entry["fieldPath"].split(".", 1)[0])["description"]
        for entry in reconciled
        if entry["fieldPath"] in {"Product.description", "WebPage.description"}
    )
    assert any(path.startswith("FAQPage.") for path in paths)
    assert any(path.startswith("HowTo.") for path in paths)
    assert not any(finding["source"] == "public-copy-provenance" for finding in report["validationFindings"])


def test_reconciler_does_not_rebind_an_ungrounded_final_description(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The fallback is provenance validation, not a blanket description exemption."""

    baseline = asyncio.run(
        service.generate_pdp_geo(
            {"product": _source_product(), "hints": {"locale": "en-US"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    diagnostics = baseline["diagnostics"]
    schema_markup = copy.deepcopy(cast(dict[str, Any], baseline["result"]["schemaMarkup"]))
    content = copy.deepcopy(cast(dict[str, Any], baseline["result"]["content"]))
    ledger = cast(list[dict[str, Any]], diagnostics["evidenceLedger"])
    plan = cast(dict[str, Any], diagnostics["contentPlan"])
    unsafe = "Barrier Serum cures acne overnight."
    _find_node(schema_markup, "Product")["description"] = unsafe
    _find_node(schema_markup, "WebPage")["description"] = unsafe
    content["sections"]["description"] = unsafe
    forged = copy.deepcopy(cast(list[dict[str, Any]], diagnostics["finalPublicCopyProvenance"]))
    for entry in forged:
        if entry["fieldPath"] in {"Product.description", "WebPage.description"}:
            entry["text"] = unsafe
            entry["sourceHash"] = final_proofreader.stable_text_hash(f"{entry['fieldPath']}\n{unsafe}")
            entry["sentences"] = [
                {
                    "text": unsafe,
                    "sourceHash": final_proofreader.stable_text_hash(f"{entry['fieldPath']}#sentence[0]\n{unsafe}"),
                    "evidenceIds": entry["sentences"][0]["evidenceIds"],
                }
            ]
            entry["evidenceIds"] = list(entry["sentences"][0]["evidenceIds"])

    def rebuild_nothing(_input: Mapping[str, Any]) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(final_proofreader, "create_pdp_geo_public_copy_provenance", rebuild_nothing)

    reconciled = reconcile_pdp_geo_public_copy_provenance(
        {
            "schemaMarkup": schema_markup,
            "contentPlan": plan,
            "evidenceLedger": ledger,
            "publicCopyProvenance": forged,
        }
    )
    report = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": schema_markup,
            "content": content,
            "evidenceLedger": ledger,
            "publicCopyProvenance": reconciled,
        }
    )

    assert not {"Product.description", "WebPage.description"} & _public_copy_paths(reconciled)
    assert {
        finding["field"] for finding in report["validationFindings"] if finding["source"] == "public-copy-provenance"
    } >= {"Product.description", "WebPage.description"}


def test_service_keeps_proofread_description_bindings_when_fresh_match_loses_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The quality gate must not block solely because service discarded valid final bindings."""

    original_service_builder = final_proofreader.create_pdp_geo_public_copy_provenance
    original_final_builder = final_proofreader.create_pdp_geo_public_copy_provenance
    service_builder_calls = 0

    def service_builder(input_: Mapping[str, Any]) -> list[dict[str, Any]]:
        nonlocal service_builder_calls
        service_builder_calls += 1
        generated = original_service_builder(input_)
        return (
            [entry for entry in generated if entry["fieldPath"].startswith(("FAQPage.", "HowTo."))]
            if service_builder_calls > 1
            else generated
        )

    def final_builder(input_: Mapping[str, Any]) -> list[dict[str, Any]]:
        generated = original_final_builder(input_)
        return [entry for entry in generated if entry["fieldPath"].startswith(("FAQPage.", "HowTo."))]

    monkeypatch.setattr(service, "create_pdp_geo_public_copy_provenance", service_builder)
    monkeypatch.setattr(final_proofreader, "create_pdp_geo_public_copy_provenance", final_builder)

    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": _source_product(), "hints": {"locale": "en-US"}},
            {
                "customCopyRefiner": _NoopCopyRefiner(),
                "customFinalProofreader": _PunctuationOnlyDescriptionProofreader(),
                "qualityGate": {"enabled": True, "thresholds": {"geo": 101, "cep": 0, "eeat": 0}},
            },
        )
    )

    provenance = cast(list[dict[str, Any]], run["diagnostics"]["finalPublicCopyProvenance"])
    paths = _public_copy_paths(provenance)
    assert {"Product.description", "WebPage.description"} <= paths
    assert any(path.startswith("FAQPage.") for path in paths)
    assert any(path.startswith("HowTo.") for path in paths)
    assert run["diagnostics"]["finalProofreading"]["acceptedFields"] == [
        "Product.description",
        "WebPage.description",
    ]
    assert not any(
        finding["source"] == "public-copy-provenance" for finding in run["diagnostics"]["validationFindings"]
    )
    assert run["diagnostics"]["qualityGate"]["attempted"] is True

"""Regression coverage for final-copy provenance and publish-blocking quality gates."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from typing import Any, cast

import pytest

import pdp_geo_generator_agent.final_proofreader as final_proofreader
import pdp_geo_generator_agent.service as service
from pdp_geo_generator_agent.content_planning import create_conservative_content_plan
from pdp_geo_generator_agent.final_proofreader import create_pdp_geo_public_copy_provenance
from pdp_geo_generator_agent.validation import serialize_schema_markup, validate_pdp_geo_artifacts

_PublicCopyProvenanceFactory = Callable[[Mapping[str, Any]], list[dict[str, Any]]]
_isolate_unbound_public_copy = cast(Callable[..., dict[str, Any]], getattr(service, "_isolate_unbound_public_copy"))


def _partial_howto_provenance_input(tail: str, source_text: str) -> dict[str, Any]:
    grounded = "Apply Glow Serum to clean skin."
    text = f"{grounded} {tail}"
    return {
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [{"@type": "HowTo", "step": [{"@type": "HowToStep", "text": text}]}],
            }
        },
        "contentPlan": {
            "mode": "model",
            "howTo": {"eligible": True, "steps": [{"text": text, "evidenceIds": ["ev-usage"]}]},
        },
        "evidenceLedger": [
            {
                "id": "ev-usage",
                "role": "usage",
                "text": grounded,
                "sourcePath": "product.usage[0]",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
            {
                "id": "ev-source",
                "role": "source",
                "text": source_text,
                "sourcePath": "product.sourceTexts[0]",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
        ],
    }


def test_partial_provenance_preserves_only_a_verified_source_literal_as_protected() -> None:
    """A source literal protects just its own sentence; arbitrary text stays unpublished."""

    literal = "Keep this source wording exactly: use only as directed."
    verified = create_pdp_geo_public_copy_provenance(_partial_howto_provenance_input(literal, literal))
    path = "HowTo.step[0].text"
    entry = next(item for item in verified if item["fieldPath"] == path)

    assert entry["evidenceIds"] == ["ev-usage"]
    assert entry["sentences"][0]["evidenceIds"] == ["ev-usage"]
    assert entry["sentences"][1]["evidenceIds"] == []
    assert entry["sentences"][1]["protected"] is True

    unbound = create_pdp_geo_public_copy_provenance(
        _partial_howto_provenance_input(
            "This generated marketing sentence has no source support.",
            literal,
        )
    )
    assert all(item["fieldPath"] != path for item in unbound)


def test_stale_or_out_of_scope_model_plan_uses_deterministic_full_ledger_provenance() -> None:
    """Model-plan origin requires matching plan text and sentence-relevant plan evidence."""

    product_text = "Glow Serum supports hydration."
    webpage_text = "This page presents Glow Serum."
    provenance = create_pdp_geo_public_copy_provenance(
        {
            "schemaMarkup": {
                "jsonLd": {
                    "@context": "https://schema.org",
                    "@graph": [
                        {"@type": "Product", "name": "Glow Serum", "description": product_text},
                        {"@type": "WebPage", "description": webpage_text},
                    ],
                }
            },
            "contentPlan": {
                "mode": "model",
                "productDescription": {
                    "include": True,
                    "text": "Stale planner product copy.",
                    "evidenceIds": ["ev-product"],
                },
                "webPageDescription": {
                    "include": True,
                    "text": webpage_text,
                    "evidenceIds": ["ev-unrelated"],
                },
            },
            "evidenceLedger": [
                {
                    "id": "ev-product",
                    "role": "benefit",
                    "text": product_text,
                    "sourcePath": "product.benefits[0]",
                    "locale": "en-US",
                    "productScope": "product",
                    "confidence": 1,
                },
                {
                    "id": "ev-page",
                    "role": "description",
                    "text": webpage_text,
                    "sourcePath": "product.description",
                    "locale": "en-US",
                    "productScope": "product",
                    "confidence": 1,
                },
                {
                    "id": "ev-unrelated",
                    "role": "description",
                    "text": "Packaged in an amber bottle.",
                    "sourcePath": "product.sourceTexts[0]",
                    "locale": "en-US",
                    "productScope": "product",
                    "confidence": 1,
                },
            ],
        }
    )
    by_path = {item["fieldPath"]: item for item in provenance}

    assert by_path["Product.description"]["origin"] == "deterministic-renderer"
    assert by_path["Product.description"]["evidenceIds"] == ["ev-product"]
    assert by_path["WebPage.description"]["origin"] == "deterministic-renderer"
    assert by_path["WebPage.description"]["evidenceIds"] == ["ev-page"]


def test_partial_model_plan_keeps_faq_provenance_within_its_cited_evidence() -> None:
    """A model FAQ cannot borrow an uncited fact from the wider ledger."""

    hydration = "Glow Serum supports hydration."
    soothing = "Glow Serum helps soothe dry skin."
    description = f"{hydration} {soothing}"
    question = "Which benefits are listed for Glow Serum?"
    graph = [
        {"@type": "Product", "name": "Glow Serum", "description": description},
        {"@type": "WebPage", "description": description},
        {
            "@type": "FAQPage",
            "mainEntity": [
                {
                    "@type": "Question",
                    "name": question,
                    "acceptedAnswer": {"@type": "Answer", "text": description},
                }
            ],
        },
    ]
    input_ = {
        "schemaMarkup": serialize_schema_markup({"@context": "https://schema.org", "@graph": graph}),
        "contentPlan": {
            "mode": "model",
            "productDescription": {"include": True, "text": description, "evidenceIds": ["ev-hydration"]},
            "webPageDescription": {"include": True, "text": description, "evidenceIds": ["ev-hydration"]},
            "faq": [
                {
                    "include": True,
                    "question": question,
                    "answer": description,
                    "evidenceIds": ["ev-hydration"],
                }
            ],
        },
        "evidenceLedger": [
            {
                "id": "ev-hydration",
                "role": "benefit",
                "text": hydration,
                "sourcePath": "product.benefits[0]",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
            {
                "id": "ev-soothing",
                "role": "effect",
                "text": soothing,
                "sourcePath": "product.effects[0]",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
        ],
    }

    provenance = create_pdp_geo_public_copy_provenance(input_)
    by_path = {item["fieldPath"]: item for item in provenance}
    expected_description_paths = (
        "Product.description",
        "WebPage.description",
    )

    for path in expected_description_paths:
        entry = by_path[path]
        assert entry["origin"] == "deterministic-renderer"
        assert entry["evidenceIds"] == ["ev-hydration", "ev-soothing"]
        assert [sentence["evidenceIds"] for sentence in entry["sentences"]] == [
            ["ev-hydration"],
            ["ev-soothing"],
        ]

    assert "FAQPage.mainEntity[0].acceptedAnswer.text" not in by_path

    validation = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": input_["schemaMarkup"],
            "content": {"html": "", "sections": {"description": description}},
            "evidenceLedger": input_["evidenceLedger"],
            "publicCopyProvenance": provenance,
        }
    )
    assert any(
        finding["source"] == "public-copy-provenance"
        and finding.get("field") == "FAQPage.mainEntity[0].acceptedAnswer.text"
        for finding in validation["validationFindings"]
    )


async def _approved_plan_with_unrendered_rows(request: Mapping[str, Any]) -> dict[str, Any]:
    plan = create_conservative_content_plan(request)
    ledger = cast(list[dict[str, Any]], request["evidenceLedger"])
    evidence_id = {item["role"]: item["id"] for item in ledger if item["role"] in {"description", "ingredient"}}
    description = cast(str, cast(dict[str, Any], request["product"])["description"])
    plan["productDescription"] = {
        "include": True,
        "text": description,
        "intent": "product-entity-summary",
        "evidenceIds": [evidence_id["description"]],
        "confidence": 1,
        "omitReason": "",
    }
    plan["webPageDescription"] = {
        "include": True,
        "text": description,
        "intent": "page-coverage-summary",
        "evidenceIds": [evidence_id["description"]],
        "confidence": 1,
        "omitReason": "",
    }
    plan["faq"] = [
        {
            "include": True,
            "question": "Which ingredient is listed for Barrier Cream?",
            "answer": "Barrier Cream includes Ceramide.",
            "intent": "formula",
            "cep": "",
            "evidenceIds": [evidence_id["ingredient"]],
            "confidence": 1,
            "omitReason": "",
        }
    ]
    return {"plan": {key: value for key, value in plan.items() if key != "mode"}}


def _structurally_incomplete_request() -> dict[str, Any]:
    return {
        "product": {
            "name": "Barrier Cream",
            "brand": "Example Lab",
            "description": "Barrier Cream is a cream for dry skin.",
            "ingredients": ["Ceramide"],
            "benefits": ["supports hydration"],
            "usage": ["Apply after cleansing."],
        },
        "hints": {"locale": "en-US", "schemaTargets": ["WebPage", "Product"]},
    }


class _NoopRefiner:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    def refine_copy(self, request: Mapping[str, Any]) -> dict[str, Any]:
        self.requests.append(dict(request))
        return {}


def _fully_grounded_product() -> dict[str, Any]:
    """Use direct facts for every renderer-created public field in the score-only case."""

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
        "faq": [],
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


def test_quality_gate_blocks_unresolved_structural_rows_after_corrective_attempt() -> None:
    """A corrective no-op cannot publish an artifact missing approved FAQ/HowTo rows."""

    refiner = _NoopRefiner()
    with pytest.raises(RuntimeError, match="Quality gate blocked final artifact"):
        asyncio.run(
            service.generate_pdp_geo(
                _structurally_incomplete_request(),
                {
                    "customContentPlanner": _approved_plan_with_unrendered_rows,
                    "customCopyRefiner": refiner,
                    "qualityGate": {"enabled": True, "thresholds": {"geo": 0, "cep": 0, "eeat": 0}},
                },
            )
        )

    corrective = next(request for request in refiner.requests if "refinementFeedback" in request)
    assert any("plan/render structural coverage shortfall" in item["reason"] for item in corrective["refinementFeedback"])


def test_quality_gate_omits_unresolved_public_copy_and_returns_the_remaining_artifact(monkeypatch: Any) -> None:
    """One missing final binding must not discard an otherwise-safe artifact.

    This hides an initial description binding until the unbound lead sentence
    is omitted. The generator must omit only the affected public-copy units,
    retain a success result, and record machine-readable omission diagnostics
    instead of turning a recoverable copy defect into a terminal failure.
    """

    original_create = cast(
        _PublicCopyProvenanceFactory,
        getattr(service, "create_pdp_geo_public_copy_provenance"),
    )
    original_reconcile = cast(
        _PublicCopyProvenanceFactory,
        getattr(service, "reconcile_pdp_geo_public_copy_provenance"),
    )

    def has_unbound_lead_sentence(input_: Mapping[str, Any]) -> bool:
        schema_markup = cast(Mapping[str, Any], input_["schemaMarkup"])
        json_ld = cast(Mapping[str, Any], schema_markup["jsonLd"])
        graph = cast(list[Mapping[str, Any]], json_ld["@graph"])
        return any(
            "Quality Probe is a serum for dry skin." in str(item.get("description") or "")
            for item in graph
        )

    def omit_only_the_initial_unbound_field(input_: Mapping[str, Any]) -> list[dict[str, Any]]:
        return [] if has_unbound_lead_sentence(input_) else original_create(input_)

    def reconcile_initial_unbound_field(input_: Mapping[str, Any]) -> list[dict[str, Any]]:
        return [] if has_unbound_lead_sentence(input_) else original_reconcile(input_)

    monkeypatch.setattr(service, "create_pdp_geo_public_copy_provenance", omit_only_the_initial_unbound_field)
    monkeypatch.setattr(final_proofreader, "create_pdp_geo_public_copy_provenance", omit_only_the_initial_unbound_field)
    monkeypatch.setattr(service, "reconcile_pdp_geo_public_copy_provenance", reconcile_initial_unbound_field)
    refiner = _NoopRefiner()
    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": {"name": "Quality Probe", "description": "Quality Probe is a serum for dry skin."}},
            {
                "customCopyRefiner": refiner,
                "qualityGate": {"enabled": True, "thresholds": {"geo": 0, "cep": 0, "eeat": 0}},
            },
        )
    )

    omissions = run["diagnostics"]["publicCopyOmissions"]
    assert {item["fieldPath"] for item in omissions} >= {"Product.description", "WebPage.description"}
    # 기본 사유 ``unresolvedBinding``은 여기 없어야 한다.  이 시험은 첫 필드의
    # 바인딩 이음매를 비웠으므로 엔트리가 쓰이지 않은 것이 곧 사유이고, 기본값이
    # 다시 나온다면 원인이 다시 가려졌다는 뜻이다.
    assert all(
        item["reason"]
        in {"directSupportRejected", "assertionFrameRejected", "noEligibleEvidence", "noProvenanceEntry"}
        for item in omissions
    )
    assert not any(
        item["source"] == "public-copy-provenance" for item in run["diagnostics"]["validationFindings"]
    )
    assert all(step["status"] == "done" for step in run["process"])


def test_public_copy_isolation_keeps_grounded_sentences_and_omits_unsafe_ordered_howto() -> None:
    """Descriptions and FAQ pairs degrade independently; ordered HowTos stay atomic."""

    schema_markup = serialize_schema_markup(
        {
            "@context": "https://schema.org",
            "@graph": [
                {
                    "@type": "Product",
                    "@id": "urn:glow#product",
                    "name": "Glow Serum",
                    "description": "Glow Serum supports hydration. Glow Serum cures eczema overnight.",
                },
                {
                    "@type": "WebPage",
                    "@id": "urn:glow#page",
                    "description": "This page presents Glow Serum.",
                    "hasPart": [{"@id": "urn:glow#faq"}, {"@id": "urn:glow#howto"}],
                },
                {
                    "@type": "FAQPage",
                    "@id": "urn:glow#faq",
                    "mainEntity": [
                        {
                            "@type": "Question",
                            "name": "Can Glow Serum cure eczema overnight?",
                            "acceptedAnswer": {"@type": "Answer", "text": "Glow Serum cures eczema overnight."},
                        },
                        {
                            "@type": "Question",
                            "name": "What benefit is listed for Glow Serum?",
                            "acceptedAnswer": {"@type": "Answer", "text": "Glow Serum supports hydration."},
                        },
                    ],
                },
                {
                    "@type": "HowTo",
                    "@id": "urn:glow#howto",
                    "name": "How to use Glow Serum",
                    "step": [
                        {"@type": "HowToStep", "position": 1, "name": "Step 1", "text": "Apply Glow Serum to clean skin."},
                        {"@type": "HowToStep", "position": 2, "name": "Step 2", "text": "Use Glow Serum during pregnancy."},
                    ],
                },
            ],
        }
    )
    isolated = _isolate_unbound_public_copy(
        schema_markup=schema_markup,
        content={
            "html": "",
            "sections": {
                "description": "Glow Serum supports hydration. Glow Serum cures eczema overnight.",
                "faq": "Q. Can Glow Serum cure eczema overnight?\nA. Glow Serum cures eczema overnight.\n\nQ. What benefit is listed for Glow Serum?\nA. Glow Serum supports hydration.",
                "howToUse": "1. Apply Glow Serum to clean skin.\n2. Use Glow Serum during pregnancy.",
            },
        },
        validation={
            "validationFindings": [
                {"field": "Product.description", "source": "public-copy-provenance"},
                {"field": "FAQPage.mainEntity[0].acceptedAnswer.text", "source": "public-copy-provenance"},
                {"field": "HowTo.step[1].text", "source": "public-copy-provenance"},
            ]
        },
        decisions=[
            {"fieldPath": "Product.description", "phase": "afterSafeRepair", "sentenceIndex": 0, "outcome": "bound", "reason": "directSupportAccepted"},
            {"fieldPath": "Product.description", "phase": "afterSafeRepair", "sentenceIndex": 1, "outcome": "unsupported", "reason": "assertionFrameRejected"},
            {"fieldPath": "FAQPage.mainEntity[0].acceptedAnswer.text", "phase": "afterSafeRepair", "sentenceIndex": 0, "outcome": "unsupported", "reason": "assertionFrameRejected"},
            {"fieldPath": "HowTo.step[1].text", "phase": "afterSafeRepair", "sentenceIndex": 0, "outcome": "unsupported", "reason": "assertionFrameRejected"},
        ],
        phase="afterSafeRepair",
        locale="en-US",
    )

    graph = isolated["schemaMarkup"]["jsonLd"]["@graph"]
    product = next(item for item in graph if item["@type"] == "Product")
    faq = next(item for item in graph if item["@type"] == "FAQPage")

    assert product["description"] == "Glow Serum supports hydration."
    assert faq["mainEntity"] == [
        {
            "@type": "Question",
            "name": "What benefit is listed for Glow Serum?",
            "acceptedAnswer": {"@type": "Answer", "text": "Glow Serum supports hydration."},
        }
    ]
    assert not any(item["@type"] == "HowTo" for item in graph)
    assert isolated["content"]["sections"]["description"] == "Glow Serum supports hydration."
    assert isolated["content"]["sections"]["faq"] == (
        "Q. What benefit is listed for Glow Serum?\nA. Glow Serum supports hydration."
    )
    assert isolated["content"]["sections"]["howToUse"] == ""
    assert {(item["fieldPath"], item["action"]) for item in isolated["omissions"]} == {
        ("Product.description", "sentenceOmitted"),
        ("FAQPage.mainEntity[0].acceptedAnswer.text", "faqItemOmitted"),
        ("HowTo", "howToSequenceOmitted"),
    }


def test_public_copy_isolation_keeps_visible_unordered_usage_without_a_schema_howto() -> None:
    """A description omission must not erase safe, deliberately non-schema usage guidance."""

    source_steps = [
        "Apply Glow Serum to clean skin.",
        "Press gently until absorbed.",
    ]
    isolated = _isolate_unbound_public_copy(
        schema_markup=serialize_schema_markup(
            {
                "@context": "https://schema.org",
                "@graph": [
                    {
                        "@type": "Product",
                        "@id": "urn:glow#product",
                        "name": "Glow Serum",
                        "description": "Glow Serum supports hydration. Glow Serum cures eczema overnight.",
                    }
                ],
            }
        ),
        content={
            "html": "",
            "sections": {
                "description": "Glow Serum supports hydration. Glow Serum cures eczema overnight.",
                "faq": "",
                "howToUse": "\n".join(source_steps),
            },
        },
        validation={
            "validationFindings": [
                {"field": "Product.description", "source": "public-copy-provenance"},
            ]
        },
        decisions=[
            {
                "fieldPath": "Product.description",
                "phase": "afterSafeRepair",
                "sentenceIndex": 0,
                "outcome": "bound",
                "reason": "directSupportAccepted",
            },
            {
                "fieldPath": "Product.description",
                "phase": "afterSafeRepair",
                "sentenceIndex": 1,
                "outcome": "unsupported",
                "reason": "assertionFrameRejected",
            },
        ],
        phase="afterSafeRepair",
        locale="en-US",
    )

    assert not any(node["@type"] == "HowTo" for node in isolated["schemaMarkup"]["jsonLd"]["@graph"])
    assert isolated["content"]["sections"]["howToUse"].splitlines() == source_steps


def test_public_copy_isolation_omits_an_ordered_howto_when_its_middle_step_is_unsupported() -> None:
    source_steps = [
        "Circle the balm along the cheekbones.",
        "Cradle the face until the finish settles.",
        "Pause briefly before continuing.",
    ]
    isolated = _isolate_unbound_public_copy(
        schema_markup=serialize_schema_markup(
            {
                "@context": "https://schema.org",
                "@graph": [
                    {"@type": "Product", "@id": "urn:fixture#product", "name": "Fixture Balm"},
                    {"@type": "WebPage", "@id": "urn:fixture#page", "hasPart": [{"@id": "urn:fixture#howto"}]},
                    {
                        "@type": "HowTo",
                        "@id": "urn:fixture#howto",
                        "name": "How to use Fixture Balm",
                        "step": [
                            {"@type": "HowToStep", "position": index, "name": f"Step {index}", "text": text}
                            for index, text in enumerate(source_steps, start=1)
                        ],
                    },
                ],
            }
        ),
        content={
            "html": "",
            "sections": {"description": "", "faq": "", "howToUse": "\n".join(source_steps)},
        },
        validation={
            "validationFindings": [
                {"field": "HowTo.step[1].text", "source": "public-copy-provenance"},
            ]
        },
        decisions=[
            {
                "fieldPath": "HowTo.step[1].text",
                "phase": "afterSafeRepair",
                "sentenceIndex": 0,
                "outcome": "unsupported",
                "reason": "assertionFrameRejected",
            }
        ],
        phase="afterSafeRepair",
        locale="en-US",
    )

    graph = isolated["schemaMarkup"]["jsonLd"]["@graph"]

    assert not any(item["@type"] == "HowTo" for item in graph)
    assert isolated["content"]["sections"]["howToUse"] == ""
    assert isolated["omissions"] == [
        {
            "fieldPath": "HowTo",
            "action": "howToSequenceOmitted",
            "reason": "assertionFrameRejected",
            "count": 3,
            "sentenceIndex": 0,
        }
    ]


def test_quality_gate_keeps_low_geo_score_nonfatal_after_a_corrective_attempt() -> None:
    """A score shortfall alone remains advisory even when the one correction has been spent."""

    refiner = _NoopRefiner()
    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": _fully_grounded_product(), "hints": {"locale": "en-US"}},
            {
                "customCopyRefiner": refiner,
                "qualityGate": {"enabled": True, "thresholds": {"geo": 101, "cep": 0, "eeat": 0}},
            },
        )
    )

    quality = run["diagnostics"]["qualityGate"]
    assert quality["attempted"] is True
    assert any(item.startswith("GEO ") for item in quality["shortfalls"])
    assert run["result"]["schemaMarkup"]["jsonLd"]["@graph"]


def _schema_description(schema_markup: Mapping[str, Any], kind: str) -> str:
    json_ld = cast(Mapping[str, Any], schema_markup["jsonLd"])
    graph = cast(list[Mapping[str, Any]], json_ld["@graph"])
    node = next(item for item in graph if item.get("@type") == kind)
    return cast(str, node["description"])


class _InitialProvenanceLeakingRefiner:
    """Returns copy that the token-tolerance gate accepts but sentence provenance cannot bind."""

    def __init__(self, candidate: str) -> None:
        self.candidate = candidate
        self.requests: list[dict[str, Any]] = []

    def refine_copy(self, request: Mapping[str, Any]) -> dict[str, Any]:
        self.requests.append(dict(request))
        return {"schemaDescriptions": {"product": self.candidate}}


def _source_tolerant_but_unbound_candidate(description: str) -> str:
    return description.replace("is a serum for dry skin.", "is suitable for dry skin.")


def test_initial_copy_refinement_rolls_back_new_public_copy_provenance_paths() -> None:
    """Initial refinement must not replace a valid renderer artifact with unbound public copy."""

    baseline = asyncio.run(
        service.generate_pdp_geo(
            {"product": _fully_grounded_product(), "hints": {"locale": "en-US"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    refiner = _InitialProvenanceLeakingRefiner(
        _source_tolerant_but_unbound_candidate(
            _schema_description(baseline["result"]["schemaMarkup"], "Product")
        )
    )
    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": _fully_grounded_product(), "hints": {"locale": "en-US"}},
            {
                "customCopyRefiner": refiner,
                "copyRefinement": {"enabled": True},
                "qualityGate": {"enabled": False},
            },
        )
    )

    diagnostics = run["diagnostics"]
    assert run["result"]["schemaMarkup"] == baseline["result"]["schemaMarkup"]
    assert run["result"]["content"] == baseline["result"]["content"]
    assert not any(
        finding["source"] == "public-copy-provenance" for finding in diagnostics["validationFindings"]
    )
    assert diagnostics["copyRefinementProvenanceRollback"] == {
        "findingCount": 1,
        "fieldPaths": ["Product.description"],
    }
    assert [
        evidence
        for evidence in diagnostics["evidence"]
        if evidence.get("field") == "copy.refinement.provenance" or evidence.get("source") == "llm"
    ] == [
        {
            "field": "copy.refinement.provenance",
            "source": "quality-gate",
            "value": "Initial copy refinement was rolled back after provenance validation.",
        }
    ]
    assert "suitable for dry skin" not in str(diagnostics["evidence"])
    assert len(refiner.requests) == 1


def _mutate_refinement_request_in_place(request: Mapping[str, Any], candidate: str) -> None:
    schema_markup = cast(dict[str, Any], request["schemaMarkup"])
    json_ld = cast(dict[str, Any], schema_markup["jsonLd"])
    graph = cast(list[dict[str, Any]], json_ld["@graph"])
    next(item for item in graph if item.get("@type") == "Product")["description"] = candidate
    content = cast(dict[str, Any], request["content"])
    sections = cast(dict[str, Any], content["sections"])
    sections["description"] = candidate


class _InPlaceInitialMutationRefiner:
    def __init__(self, candidate: str) -> None:
        self.candidate = candidate
        self.requests: list[dict[str, Any]] = []

    def refine_copy(self, request: Mapping[str, Any]) -> dict[str, Any]:
        self.requests.append(dict(request))
        _mutate_refinement_request_in_place(request, self.candidate)
        return {}


def test_initial_copy_refiner_cannot_mutate_the_committed_artifact_without_an_accepted_response() -> None:
    """An in-place custom callback returning no edits must leave the renderer artifact untouched."""

    baseline = asyncio.run(
        service.generate_pdp_geo(
            {"product": _fully_grounded_product(), "hints": {"locale": "en-US"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    refiner = _InPlaceInitialMutationRefiner(
        _source_tolerant_but_unbound_candidate(
            _schema_description(baseline["result"]["schemaMarkup"], "Product")
        )
    )

    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": _fully_grounded_product(), "hints": {"locale": "en-US"}},
            {
                "customCopyRefiner": refiner,
                "copyRefinement": {"enabled": True},
                "qualityGate": {"enabled": False},
            },
        )
    )

    diagnostics = run["diagnostics"]
    assert run["result"]["schemaMarkup"] == baseline["result"]["schemaMarkup"]
    assert run["result"]["content"] == baseline["result"]["content"]
    assert not any(
        finding["source"] == "public-copy-provenance" for finding in diagnostics["validationFindings"]
    )
    assert "copyRefinementProvenanceRollback" not in diagnostics
    assert len(refiner.requests) == 1


class _CorrectiveProvenanceLeakingRefiner:
    """Leaves the initial artifact intact, then supplies an unsafe-but-source-tolerant correction."""

    def __init__(self, candidate: str) -> None:
        self.candidate = candidate
        self.requests: list[dict[str, Any]] = []

    def refine_copy(self, request: Mapping[str, Any]) -> dict[str, Any]:
        self.requests.append(dict(request))
        return (
            {"schemaDescriptions": {"product": self.candidate}}
            if "refinementFeedback" in request
            else {}
        )


class _InPlaceCorrectiveMutationRefiner:
    def __init__(self, candidate: str) -> None:
        self.candidate = candidate
        self.requests: list[dict[str, Any]] = []

    def refine_copy(self, request: Mapping[str, Any]) -> dict[str, Any]:
        self.requests.append(dict(request))
        if "refinementFeedback" in request:
            _mutate_refinement_request_in_place(request, self.candidate)
        return {}


def test_corrective_copy_refiner_cannot_mutate_the_committed_artifact_without_an_accepted_response() -> None:
    """A no-op corrective callback cannot bypass stale validation by mutating its live request."""

    baseline = asyncio.run(
        service.generate_pdp_geo(
            {"product": _fully_grounded_product(), "hints": {"locale": "en-US"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    refiner = _InPlaceCorrectiveMutationRefiner(
        _source_tolerant_but_unbound_candidate(
            _schema_description(baseline["result"]["schemaMarkup"], "Product")
        )
    )

    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": _fully_grounded_product(), "hints": {"locale": "en-US"}},
            {
                "customCopyRefiner": refiner,
                "copyRefinement": {"enabled": True},
                "qualityGate": {"enabled": True, "thresholds": {"geo": 101, "cep": 0, "eeat": 0}},
            },
        )
    )

    diagnostics = run["diagnostics"]
    assert run["result"]["schemaMarkup"] == baseline["result"]["schemaMarkup"]
    assert run["result"]["content"] == baseline["result"]["content"]
    assert not any(
        finding["source"] == "public-copy-provenance" for finding in diagnostics["validationFindings"]
    )
    assert diagnostics["qualityGate"]["attempted"] is True
    assert diagnostics["qualityGate"]["adopted"] is False
    assert any("refinementFeedback" in request for request in refiner.requests)


def test_quality_gate_rejects_a_higher_scoring_corrective_candidate_with_new_provenance_paths(
    monkeypatch: Any,
) -> None:
    """A better-scoring correction cannot introduce final public-copy provenance defects."""

    baseline = asyncio.run(
        service.generate_pdp_geo(
            {"product": _fully_grounded_product(), "hints": {"locale": "en-US"}},
            {"qualityGate": {"enabled": False}},
        )
    )
    baseline_description = _schema_description(baseline["result"]["schemaMarkup"], "Product")
    refiner = _CorrectiveProvenanceLeakingRefiner(
        _source_tolerant_but_unbound_candidate(baseline_description)
    )
    original_validate = cast(
        Callable[[Mapping[str, Any]], dict[str, Any]],
        getattr(service, "validate_pdp_geo_artifacts"),
    )

    def validation_with_initial_advisories(input_: Mapping[str, Any]) -> dict[str, Any]:
        result = original_validate(input_)
        if (
            _schema_description(cast(Mapping[str, Any], input_["schemaMarkup"]), "Product")
            == baseline_description
        ):
            extra_findings: list[dict[str, Any]] = [
                {
                    "field": f"test.initial-advisory[{index}]",
                    "source": "test-quality-control",
                    "issue": "Simulated initial quality warning.",
                    "suggestedAction": "Improve the initial artifact.",
                    "evidence": [],
                }
                for index in range(12)
            ]
            return {
                "validationWarnings": [
                    *cast(list[str], result["validationWarnings"]),
                    *[f"{item['field']}: {item['issue']}" for item in extra_findings],
                ],
                "validationFindings": [
                    *cast(list[dict[str, Any]], result["validationFindings"]),
                    *extra_findings,
                ],
            }
        return result

    scores = iter(
        [
            {"overall": 10, "geo": 10, "cep": 100, "eeat": 100},
            {"overall": 100, "geo": 100, "cep": 100, "eeat": 100},
        ]
    )

    def controlled_quality_scores(_evaluation: Any) -> dict[str, int]:
        return next(scores)

    monkeypatch.setattr(service, "validate_pdp_geo_artifacts", validation_with_initial_advisories)
    monkeypatch.setattr(service, "quality_gate_scores", controlled_quality_scores)

    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": _fully_grounded_product(), "hints": {"locale": "en-US"}},
            {
                "customCopyRefiner": refiner,
                "copyRefinement": {"enabled": True},
                "qualityGate": {"enabled": True, "thresholds": {"geo": 50, "cep": 0, "eeat": 0}},
            },
        )
    )

    diagnostics = run["diagnostics"]
    quality = diagnostics["qualityGate"]
    assert quality["correctedScores"]["overall"] > quality["initialScores"]["overall"]
    assert quality["correctedWarningCount"] < quality["initialWarningCount"]
    assert quality["adopted"] is False
    assert quality["rejectedCorrectedPublicCopyProvenance"] == {
        "findingCount": 1,
        "fieldPaths": ["Product.description"],
    }
    assert run["result"]["schemaMarkup"] == baseline["result"]["schemaMarkup"]
    assert run["result"]["content"] == baseline["result"]["content"]
    assert not any(
        finding["source"] == "public-copy-provenance" for finding in diagnostics["validationFindings"]
    )
    assert any("refinementFeedback" in request for request in refiner.requests)


def _partial_description_provenance_input(sentences: list[str]) -> dict[str, Any]:
    """A Product.description whose sentences are separately provable, or not."""

    text = " ".join(sentences)
    return {
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [{"@type": "Product", "name": "Glow Serum", "description": text}],
            }
        },
        "contentPlan": {"mode": "conservative"},
        "evidenceLedger": [
            {
                "id": "ev-identity",
                "role": "identity",
                "text": "Glow Serum",
                "sourcePath": "product.name",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
            {
                "id": "ev-audience",
                "role": "audience",
                "text": "dry skin",
                "sourcePath": "product.semanticFacts.skinTypes[0]",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
            {
                "id": "ev-benefit",
                "role": "benefit",
                "text": "supports hydration",
                "sourcePath": "product.benefits[0]",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
        ],
    }


def test_a_description_sentence_without_a_binding_is_left_out_and_the_rest_is_kept() -> None:
    """원문에 없는 한 문장 때문에 설명문 전체가 사라지지 않는다.

    상품 페이지에 고객 리뷰가 없으면 리뷰 문장만 빠지고 성분·대상 고객·측정
    결과는 그대로 남아야 한다.  이전에는 결속되지 않는 문장 하나가 필드의
    provenance 전체를 폐기시켜 필드가 증명 불가가 되고, 격리 단계가 설명문을
    통째로 지웠다.
    """

    supported = ["Glow Serum is a serum for dry skin.", "Glow Serum supports hydration."]
    unsupported = "Customers call Glow Serum the best serum of the year."
    entries = create_pdp_geo_public_copy_provenance(_partial_description_provenance_input([*supported, unsupported]))
    entry = next(item for item in entries if item["fieldPath"] == "Product.description")
    rows = entry["sentences"]

    assert [row["text"] for row in rows] == [*supported, unsupported]
    assert all(row["evidenceIds"] for row in rows[:2])
    assert rows[2]["evidenceIds"] == []
    assert rows[2].get("protected") is not True
    # 필드의 근거 목록은 증명된 문장들의 합집합 그대로다.
    assert entry["evidenceIds"] == sorted(
        {identifier for row in rows[:2] for identifier in row["evidenceIds"]}, key=entry["evidenceIds"].index
    )


def test_a_description_of_only_unbindable_sentences_supplies_no_provenance() -> None:
    """증명할 문장이 하나도 없으면 발행할 근거도 없다."""

    entries = create_pdp_geo_public_copy_provenance(
        _partial_description_provenance_input(
            [
                "Customers call Glow Serum the best serum of the year.",
                "Dermatologists worldwide recommend applying it twice daily.",
            ]
        )
    )

    assert all(item["fieldPath"] != "Product.description" for item in entries)


def test_isolation_removes_only_the_unbound_sentence_and_publishes_the_rest() -> None:
    """격리는 증명되지 않은 문장 하나만 빼고 나머지 설명문을 그대로 발행한다.

    문장 판정과 provenance 공급이 어긋나면 격리가 뺄 문장을 지목할 수 없어
    필드를 통째로 지웠다.  두 신호가 같은 문장을 가리켜야 "고객 리뷰만 빠지고
    나머지는 남는다"가 성립한다.
    """

    supported = ["Glow Serum is a serum for dry skin.", "Glow Serum supports hydration."]
    unsupported = "Customers call Glow Serum the best serum of the year."
    payload = _partial_description_provenance_input([*supported, unsupported])
    provenance = create_pdp_geo_public_copy_provenance(payload)
    decisions = final_proofreader.create_pdp_geo_public_copy_provenance_decision_diagnostics(
        {**payload, "publicCopyProvenance": provenance}, phase="initial"
    )
    validation = validate_pdp_geo_artifacts(
        {
            **payload,
            "content": {"sections": {}},
            "locale": "en-US",
            "sourceProduct": {"name": "Glow Serum"},
            "publicCopyProvenance": provenance,
        }
    )

    product_decisions = [row for row in decisions if row["fieldPath"] == "Product.description"]
    assert [row["outcome"] for row in product_decisions] == ["bound", "bound", "unsupported"]

    isolated = _isolate_unbound_public_copy(
        schema_markup=payload["schemaMarkup"],
        content={"sections": {}},
        validation=validation,
        decisions=decisions,
        phase="initial",
        locale="en-US",
    )

    assert [
        (item["fieldPath"], item["action"], item["count"], item["sentenceIndex"])
        for item in isolated["omissions"]
    ] == [("Product.description", "sentenceOmitted", 1, 2)]
    graph = isolated["schemaMarkup"]["jsonLd"]["@graph"]
    product = next(node for node in graph if node["@type"] == "Product")
    assert product["description"] == " ".join(supported)

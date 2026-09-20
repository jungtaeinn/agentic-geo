"""High-risk orchestration contracts retained from the TypeScript generator.

These tests cover the seams that are easy to miss when the deterministic
renderer itself works: persisted RAG profiles, brand isolation, protected
overlay context, and the optional evaluator concept judge.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast

from pdp_geo_eval_agent.benchmark import eval_products

import pdp_geo_generator_agent.rag.orchestration as rag_orchestration
import pdp_geo_generator_agent.rag.retrieval as rag_retrieval
import pdp_geo_generator_agent.service as service
from pdp_geo_generator_agent.content_planning import create_conservative_content_plan
from pdp_geo_generator_agent.rag.eval import load_pdp_geo_rag_eval_goldens, score_pdp_geo_rag_retrieval
from pdp_geo_generator_agent.rag.profile_store import read_pdp_geo_generator_rag_profile
from pdp_geo_generator_agent.rag.retrieval import (
    create_pdp_geo_rag_query_plan,
    infer_pdp_geo_brand_overlay_documents,
    resolve_pdp_geo_rag_settings,
    scope_pdp_geo_brand_rag_documents,
    select_final_rag_chunks,
)

_PUBLIC_HOWTO_CONTRACT = Path(__file__).parent / "fixtures" / "public-rag-candidate-contract-v1.json"


def _document(name: str, content: str = "# Guidance\n\nSource-backed guidance.") -> dict[str, str]:
    return {"name": name, "version": "v1", "content": content}


def test_brand_overlay_scope_recognizes_sample_derma_display_name() -> None:
    """The public display name must select its matching generic RAG overlays."""

    assert infer_pdp_geo_brand_overlay_documents({"brand": "SampleDerma", "name": "Barrier Cream"}) == [
        "brands/sample_derma/best-practice_v2.md",
        "brands/sample_derma/locale-expression-guidelines_v2.md",
        "brands/sample_derma/locale-terminology-map_v2.json",
    ]


def test_brand_overlay_scope_recognizes_sample_botanics_display_name() -> None:
    """The public display name must select its matching generic RAG overlays."""

    assert infer_pdp_geo_brand_overlay_documents({"brand": "SampleBotanics", "name": "Serum"}) == [
        "brands/sample_botanics/best-practice_v2.md",
        "brands/sample_botanics/locale-expression-guidelines_v2.md",
        "brands/sample_botanics/locale-terminology-map_v2.json",
    ]


def test_brand_profile_documents_are_loaded_scoped_and_protected_from_budget_eviction(monkeypatch: Any) -> None:
    """Only the matched brand's overlays reach retrieval, and they survive budget pressure."""

    profile_documents = [
        _document("geo-research_v3.md"),
        _document("brands/sample_derma/brand-identity_v2.md", "# SampleDerma identity\n\nDaily derma context."),
        _document("brands/sample_derma/best-practice_v2.md", "# SampleDerma voice\n\nCalm clinical wording."),
        _document("brands/sample_derma/locale-expression-guidelines_v2.md"),
        _document("brands/sample_derma/locale-terminology-map_v2.json", '{"barrier":"barrier"}'),
        _document("brands/sample_botanics/brand-identity_v1.md", "# SampleBotanics identity\n\nHeritage context."),
        _document("custom/merchant-guidance_v1.md"),
    ]

    async def profile() -> dict[str, object]:
        return {"profile": "editable-profile", "analysisPrompt": "profile prompt", "documents": profile_documents}

    seen: list[set[str]] = []

    async def retriever(request: dict[str, object]) -> list[dict[str, object]]:
        raw_documents = request["documents"]
        assert isinstance(raw_documents, list)
        documents = cast(list[Mapping[str, object]], raw_documents)
        names = {str(document["name"]) for document in documents}
        seen.append(names)
        assert "brands/sample_botanics/brand-identity_v1.md" not in names
        return []

    monkeypatch.setattr(service, "read_pdp_geo_generator_rag_profile", profile)
    asyncio.run(
        service.generate_pdp_geo(
            {"product": {"name": "SAMPLE_DERMA Barrier Cream", "brand": "SAMPLE_DERMA", "description": "Barrier cream."}},
            {"rag": {"mode": "managed-vector-store-rag", "provider": "custom"}, "customRetriever": retriever},
        )
    )
    assert seen
    assert any("brands/sample_derma/brand-identity_v2.md" in names for names in seen)

    scoped = scope_pdp_geo_brand_rag_documents(profile_documents, {"brand": "SAMPLE_DERMA", "name": "Cream"})
    assert "brands/sample_derma/best-practice_v2.md" in {item["name"] for item in scoped}
    assert "brands/sample_botanics/brand-identity_v1.md" not in {item["name"] for item in scoped}
    assert infer_pdp_geo_brand_overlay_documents({"brand": "SAMPLE_DERMA", "name": "Cream"}) == [
        "brands/sample_derma/best-practice_v2.md",
        "brands/sample_derma/locale-expression-guidelines_v2.md",
        "brands/sample_derma/locale-terminology-map_v2.json",
    ]
    selected = select_final_rag_chunks(
        [
            {"id": "base", "source": "geo-research_v3.md", "kind": "geo-research", "score": 0.99, "metadata": {}},
            {
                "id": "overlay",
                "source": "brands/sample_derma/best-practice_v2.md",
                "kind": "best-practice",
                "score": 0.01,
                "metadata": {},
            },
        ],
        1,
        {"brandOverlayDocuments": infer_pdp_geo_brand_overlay_documents({"brand": "SAMPLE_DERMA", "name": "Cream"})},
    )
    assert {item["id"] for item in selected} == {"base", "overlay"}


def test_coverage_retrieval_uses_ts_policy_and_brand_specific_queries(monkeypatch: Any) -> None:
    """Coverage invokes the retained per-document TS query contracts, not one generic query."""

    canonical_documents = {
        "content-field-contracts_v1.md": "field-contracts",
        "schema-org-product_v2.md": "schema",
        "geo-research_v3.md": "geo-research",
        "cep_v1.md": "cep",
        "eeat_v1.md": "eeat",
        "evidence/geo-research-cards_v1.md": "evidence-cards",
        "official-ai-search-platform-docs_v1.md": "official-docs",
        "best-practice_v1.md": "best-practice",
        "locale-expression-guidelines_v1.md": "locale",
        "locale-terminology-map_v1.json": "terminology",
        "brands/sample_derma/brand-identity_v2.md": "custom",
        "brands/sample_derma/best-practice_v2.md": "best-practice",
    }
    calls: dict[str, dict[str, object]] = {}

    async def retrieve(request: Mapping[str, object], _runtime: Mapping[str, object]) -> list[dict[str, object]]:
        raw_documents: object = request["documents"]
        assert isinstance(raw_documents, list)
        documents = cast(list[object], raw_documents)
        if len(documents) != 1:
            return []
        document = cast(Mapping[str, object], documents[0])
        name = str(document["name"])
        calls[name] = dict(request)
        return [
            {
                "id": name,
                "source": name,
                "title": "Guidance",
                "text": "# Guidance\n\nSource-backed PDP guidance.",
                "kind": canonical_documents[name],
                "intents": ["general"],
                "fieldTargets": ["PDP.content"],
                "metadata": {},
                "score": 0.1,
            }
        ]

    monkeypatch.setattr(rag_retrieval, "retrieve_pdp_geo_rag_chunks", retrieve)
    product = {
        "name": "SampleDerma Barrier Cream",
        "brand": "SampleDerma",
        "category": "Cream",
        "benefits": ["Supports hydration"],
        "ingredients": ["Ceramide"],
        "usage": ["Apply after serum."],
        "reviews": {"keywords": ["comfortable"]},
    }
    documents = [_document(name) for name in canonical_documents]
    chunks = asyncio.run(
        rag_orchestration.assemble_pdp_geo_rag_chunks(
            {
                "queryPlan": {"queries": []},
                "product": product,
                "locale": "en-US",
                "documents": documents,
                "settings": {"maxChunks": 14},
            }
        )
    )

    # Direct source ports from agent.ts:775-835, 1002-1035, and 1066-1238.
    assert str(calls["content-field-contracts_v1.md"]["query"]).startswith(
        "Canonical PDP field contracts for description composition and separation"
    )
    assert str(calls["content-field-contracts_v1.md"]["query"]).endswith(
        "Ingredients: Ceramide. Usage: Apply after serum. Review keywords: comfortable."
    )
    assert str(calls["brands/sample_derma/brand-identity_v2.md"]["query"]).startswith(
        "Target brand identity for PDP GEO generation: brand image, tone, vocabulary"
    )
    assert "Usage: Apply after serum." not in str(calls["brands/sample_derma/brand-identity_v2.md"]["query"])
    assert str(calls["brands/sample_derma/best-practice_v2.md"]["query"]).startswith(
        "Brand-specific best practice overlay for PDP GEO generation"
    )
    assert "Usage: Apply after serum." in str(calls["brands/sample_derma/best-practice_v2.md"]["query"])
    by_source = {str(chunk["source"]): chunk for chunk in chunks}
    assert by_source["content-field-contracts_v1.md"]["metadata"]["queryPlanReason"] == (
        "Ensure the canonical field contracts are present when the documents that explain them rank higher."
    )
    assert by_source["brands/sample_derma/brand-identity_v2.md"]["metadata"]["queryPlanReason"] == (
        "Ensure the matched target-brand identity document is available to generation without adding other brand identity documents."
    )
    assert by_source["brands/sample_derma/brand-identity_v2.md"]["score"] == 0.93


def test_howto_goldens_match_public_candidate_keys_and_confusion_without_duplicate_brand_coverage() -> None:
    """Freeze the public HOWTO candidate pools, not just their floor.

    The selector receives the matched overlay under the public
    ``brandOverlayDocuments`` key before strategic backfill.  The corpus may
    retrieve multiple sections from that one overlay, but it must never admit
    an overlay from another brand family.  The fixture pins the public
    candidate IDs and TP/FP/FN/TN sets.
    """

    expected = json.loads(_PUBLIC_HOWTO_CONTRACT.read_text(encoding="utf-8"))

    async def observe() -> dict[str, dict[str, object]]:
        profile = await read_pdp_geo_generator_rag_profile()
        documents = [dict(item) for item in cast(list[Mapping[str, object]], profile["documents"])]
        observed: dict[str, dict[str, object]] = {}
        for golden in load_pdp_geo_rag_eval_goldens():
            if golden["id"] not in expected:
                continue
            product = dict(eval_products[str(golden["productId"])])
            plan = create_pdp_geo_rag_query_plan(
                product,
                str(golden["locale"]),
                str(golden["market"]),
                {"queryPlanning": {"enabled": True, "updateTargets": [golden["target"]]}},
            )
            subquery = next(
                (item for item in cast(list[dict[str, Any]], plan["queries"]) if item["target"] == golden["target"]),
                None,
            )
            settings = resolve_pdp_geo_rag_settings()
            candidates = await rag_orchestration.assemble_pdp_geo_rag_chunks(
                {
                    "queryPlan": {**plan, "queries": [subquery]} if subquery else plan,
                    "product": product,
                    "locale": golden["locale"],
                    "market": golden["market"],
                    "documents": scope_pdp_geo_brand_rag_documents(documents, product),
                    "settings": settings,
                }
            )
            selected = select_final_rag_chunks(
                candidates,
                int(settings["maxChunks"]),
                {"brandOverlayDocuments": infer_pdp_geo_brand_overlay_documents(product)},
            )
            classification = score_pdp_geo_rag_retrieval(golden, selected, candidates)["classification"]
            observed[str(golden["id"])] = {
                "candidateKeys": [str(chunk["id"]) for chunk in candidates],
                "confusion": {key: classification[key] for key in ("tp", "fp", "fn", "tn")},
            }
            brand_coverage_sources = {
                str(chunk["source"])
                for chunk in candidates
                if chunk.get("metadata", {}).get("queryPlanTarget") == "brandBestPracticeCoverage"
            }
            assert brand_coverage_sources <= set(infer_pdp_geo_brand_overlay_documents(product))
            assert len(brand_coverage_sources) <= 1
        return observed

    assert asyncio.run(observe()) == expected


def test_quality_gate_records_optional_concept_judge_assessment(monkeypatch: Any) -> None:
    """Concept scoring is additive to deterministic rubric scoring, never ignored."""

    async def judge(_input: dict[str, object], _config: dict[str, object], _locale: str) -> dict[str, object]:
        return {
            "assessment": {
                "overallScore": 72,
                "dimensions": [
                    {"id": "geo", "score": 72, "embodied": [], "missing": ["answer coverage"], "improvements": []}
                ],
                "summary": "Needs answer coverage.",
            }
        }

    monkeypatch.setattr(service, "judge_concept_embodiment_safely", judge)
    run = asyncio.run(
        service.generate_pdp_geo(
            {"product": {"name": "Barrier Cream", "description": "A barrier cream."}},
            {"qualityGate": {"enabled": True, "conceptJudge": {"provider": "test"}}},
        )
    )

    quality = run["diagnostics"]["qualityGate"]
    assert quality["conceptAssessment"]["overallScore"] == 72
    assert any(item.startswith("concept GEO") for item in quality["shortfalls"])


def test_quality_gate_reports_a_structural_shortfall_when_approved_plan_rows_are_not_rendered() -> None:
    """A retained quality result cannot silently lose approved FAQ or HowTo rows."""

    async def approved_planner(request: Mapping[str, Any]) -> dict[str, Any]:
        plan = create_conservative_content_plan(request)
        ledger = cast(list[dict[str, Any]], request["evidenceLedger"])
        evidence_id = {
            item["role"]: item["id"]
            for item in ledger
            if item["role"] in {"description", "ingredient"}
        }
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

    run = asyncio.run(
        service.generate_pdp_geo(
            {
                "product": {
                    "name": "Barrier Cream",
                    "brand": "Example Lab",
                    "description": "Barrier Cream is a cream for dry skin.",
                    "ingredients": ["Ceramide"],
                    "benefits": ["supports hydration"],
                    "usage": ["Apply after cleansing."],
                },
                "hints": {"locale": "en-US", "schemaTargets": ["WebPage", "Product"]},
            },
            {
                "customContentPlanner": approved_planner,
                "qualityGate": {"enabled": True, "thresholds": {"geo": 0, "cep": 0, "eeat": 0}},
            },
        )
    )
    plan = run["diagnostics"]["contentPlan"]
    graph = run["result"]["schemaMarkup"]["jsonLd"]["@graph"]
    rendered_types = {
        type_name
        for item in graph
        for type_name in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]])
    }
    quality = run["diagnostics"]["qualityGate"]

    assert plan["faq"][0]["include"] is True
    assert plan["howTo"]["eligible"] is True
    assert "FAQPage" not in rendered_types
    assert "HowTo" not in rendered_types
    assert any("FAQ" in item for item in quality["shortfalls"])
    assert any("HowTo" in item for item in quality["shortfalls"])
    assert quality["reason"] != "Quality gate passed without correction."
    assert quality["adopted"] is False

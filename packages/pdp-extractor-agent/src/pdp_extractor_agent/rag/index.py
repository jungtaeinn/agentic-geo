"""Stable managed document index for profile-aware consumers."""

from __future__ import annotations

from copy import deepcopy
from typing import Any
from unicodedata import normalize

from .manifest import PRODUCT_EXTRACTOR_RAG_MANIFEST


def _section(heading: str, intents: list[str], targets: list[str], priority: float) -> dict[str, Any]:
    return {"heading": heading, "intents": intents, "fieldTargets": targets, "priority": priority}


def _entry(
    document: str,
    kind: str,
    intents: list[str],
    targets: list[str],
    priority: float,
    sections: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "document": document,
        "version": "v1",
        "kind": kind,
        "sourceRole": "policy",
        "checkedAt": "2026-06-24",
        "intents": intents,
        "fieldTargets": targets,
        "priority": priority,
        "sections": sections,
    }


PRODUCT_EXTRACTOR_RAG_INDEX: list[dict[str, Any]] = [
    _entry(
        PRODUCT_EXTRACTOR_RAG_MANIFEST["analysisPrompt"],
        "analysis-prompt",
        ["orchestration", "evidence", "diagnostics"],
        ["geoProduct", "diagnostics"],
        0.82,
        [
            _section("RAG Orchestration", ["orchestration", "diagnostics"], ["diagnostics", "rag.chunks"], 0.92),
            _section("Evidence Contract", ["evidence", "diagnostics"], ["geoProduct", "diagnostics"], 0.90),
            _section(
                "Field Mapping",
                ["normalization", "classification"],
                ["benefits", "effects", "ingredients", "usage"],
                0.86,
            ),
            _section("Exclusion Rules", ["exclusion", "diagnostics"], ["diagnostics"], 0.94),
        ],
    ),
    _entry(
        PRODUCT_EXTRACTOR_RAG_MANIFEST["documents"]["productNormalization"],
        "product-normalization",
        ["normalization", "schema-ready", "evidence"],
        ["geoProduct", "contentAnalysis.sections", "rag.chunks"],
        0.90,
        [
            _section("Source Priority", ["normalization", "evidence"], ["geoProduct", "diagnostics"], 0.86),
            _section(
                "Field Rules",
                ["normalization", "classification"],
                ["benefits", "effects", "ingredients", "usage", "contentAnalysis.sections"],
                0.94,
            ),
            _section("Content Analysis Output", ["schema-ready"], ["contentAnalysis.sections", "rag.chunks"], 0.88),
            _section("Exclusions and Diagnostics", ["exclusion", "diagnostics"], ["diagnostics", "geoProduct"], 0.92),
        ],
    ),
    _entry(
        PRODUCT_EXTRACTOR_RAG_MANIFEST["documents"]["ocrKeywordClassification"],
        "ocr-classification",
        ["classification", "evidence", "exclusion"],
        ["ocr.sentenceInsights", "benefits", "effects", "ingredients", "usage", "metrics", "diagnostics"],
        0.92,
        [
            _section(
                "Sentence Reconstruction", ["classification", "evidence"], ["ocr.sentenceInsights", "rag.chunks"], 0.96
            ),
            _section(
                "Category Routing", ["classification"], ["benefits", "effects", "ingredients", "usage", "metrics"], 0.94
            ),
            _section("Exclusion Rules", ["exclusion", "diagnostics"], ["diagnostics"], 0.96),
        ],
    ),
    _entry(
        PRODUCT_EXTRACTOR_RAG_MANIFEST["documents"]["reviewKeywordExtraction"],
        "review-extraction",
        ["review", "evidence"],
        ["reviews", "diagnostics"],
        0.80,
        [_section("Review Evidence", ["review", "evidence"], ["reviews"], 0.90)],
    ),
    _entry(
        PRODUCT_EXTRACTOR_RAG_MANIFEST["documents"]["faqExtraction"],
        "faq-extraction",
        ["faq", "evidence"],
        ["faq", "rag.chunks"],
        0.80,
        [_section("FAQ Evidence", ["faq", "evidence"], ["faq"], 0.90)],
    ),
]


def product_extractor_rag_index() -> list[dict[str, Any]]:
    return deepcopy(PRODUCT_EXTRACTOR_RAG_INDEX)


def find_product_extractor_rag_index_entry(document_name: str) -> dict[str, Any] | None:
    return next((deepcopy(entry) for entry in PRODUCT_EXTRACTOR_RAG_INDEX if entry["document"] == document_name), None)


def find_product_extractor_rag_section_entry(document_name: str, heading: str | None = None) -> dict[str, Any] | None:
    entry = find_product_extractor_rag_index_entry(document_name)
    if not entry or not heading:
        return None
    normalized = _heading(heading)
    return next(
        (
            section
            for section in entry["sections"]
            if normalized in _heading(section.get("heading", "")) or _heading(section.get("heading", "")) in normalized
        ),
        None,
    )


productExtractorRagIndex = PRODUCT_EXTRACTOR_RAG_INDEX
findProductExtractorRagIndexEntry = find_product_extractor_rag_index_entry
findProductExtractorRagSectionEntry = find_product_extractor_rag_section_entry


def _heading(value: str) -> str:
    return " ".join(
        "".join(character if character.isalnum() else " " for character in normalize("NFKC", value).casefold()).split()
    )

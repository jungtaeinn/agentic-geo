"""Typed routing metadata frozen from the TypeScript RAG index."""

from __future__ import annotations

import json
import re
import unicodedata
from importlib.resources import files
from typing import Any

PDP_GEO_RAG_INDEX: list[dict[str, Any]] = json.loads(
    files("pdp_geo_generator_agent")
    .joinpath("resources", "rag", "rag-index.generated.json")
    .read_text(encoding="utf-8")
)


def find_pdp_geo_rag_index_entry(document_name: str) -> dict[str, Any] | None:
    return next((entry for entry in PDP_GEO_RAG_INDEX if entry["document"] == document_name), None)


def find_pdp_geo_rag_section_entry(
    document_name: str, heading: str | None = None, heading_path: str | None = None
) -> dict[str, Any] | None:
    entry = find_pdp_geo_rag_index_entry(document_name)
    if entry is None:
        return None
    candidates = (
        [
            item
            for item in [heading, *reversed([part.strip() for part in heading_path.split(">")])]
            if item and item.strip()
        ]
        if heading_path
        else [heading]
        if heading and heading.strip()
        else []
    )
    for candidate in candidates:
        normalized = _normalize_heading(candidate)
        if not normalized:
            continue
        for section in entry.get("sections", []):
            section_normalized = _normalize_heading(str(section.get("heading", "")))
            if section_normalized and (normalized in section_normalized or section_normalized in normalized):
                return section
    return None


def _normalize_heading(value: str) -> str:
    # Python's unicode predicates cover the same Korean/Japanese/Chinese class
    # used by the JS character range while keeping numbers/ASCII literal.
    normalized = unicodedata.normalize("NFKC", value.lower())
    return re.sub(r"\s+", " ", "".join(char if char.isalnum() else " " for char in normalized)).strip()


pdpGeoRagIndex = PDP_GEO_RAG_INDEX
findPdpGeoRagIndexEntry = find_pdp_geo_rag_index_entry
findPdpGeoRagSectionEntry = find_pdp_geo_rag_section_entry

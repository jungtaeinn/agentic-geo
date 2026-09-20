"""Offline typed-index skeleton generator for reviewable RAG maintenance."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

from .._json import as_dict, as_list
from .index import find_pdp_geo_rag_index_entry, find_pdp_geo_rag_section_entry
from .retrieval import chunk_pdp_geo_rag_document


def create_pdp_geo_rag_index_skeleton(documents: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for document in documents:
        name, version = str(document.get("name") or ""), str(document.get("version") or "v1")
        chunks = chunk_pdp_geo_rag_document(name, str(document.get("content") or ""), version)
        index = find_pdp_geo_rag_index_entry(name)
        sections: list[dict[str, Any]] = []
        seen: set[str] = set()
        for chunk in chunks:
            heading = str(chunk.get("title") or "")
            metadata = as_dict(chunk.get("metadata"))
            path = str(metadata.get("headingPath") or heading)
            key = f"{heading}::{path}"
            if not heading or key in seen:
                continue
            seen.add(key)
            sections.append(
                {
                    "heading": heading,
                    "headingPath": path,
                    "indexed": find_pdp_geo_rag_section_entry(name, heading, path) is not None,
                    "intents": list(chunk.get("intents") or []),
                    "fieldTargets": list(chunk.get("fieldTargets") or []),
                }
            )
        entries.append(
            {
                "document": name,
                "version": version,
                "kind": chunks[0].get("kind", "custom") if chunks else "custom",
                "documentIndexed": index is not None,
                "sections": sections,
                "unindexedSectionCount": sum(not section["indexed"] for section in sections),
            }
        )
    return entries


def render_pdp_geo_rag_index_skeleton(entries: Sequence[Mapping[str, Any]]) -> str:
    lines: list[str] = []
    for raw in entries:
        entry = as_dict(raw)
        unindexed = [as_dict(item) for item in as_list(entry.get("sections")) if not as_dict(item).get("indexed")]
        if not entry.get("documentIndexed"):
            lines.append(
                f"// MISSING DOCUMENT ENTRY: {entry.get('document', '')} (kind: {entry.get('kind', 'custom')}, version: {entry.get('version', 'v1')})"
            )
        if not unindexed:
            continue
        lines.append(f"// {entry.get('document', '')}: {len(unindexed)} unindexed heading(s)")
        for section in unindexed:
            lines.extend(
                [
                    "{",
                    f"  heading: {json.dumps(section.get('heading', ''), ensure_ascii=False)},",
                    f"  intents: {json.dumps(section.get('intents', []), ensure_ascii=False)},",
                    f"  fieldTargets: {json.dumps(section.get('fieldTargets', []), ensure_ascii=False)},",
                    "  priority: 0.8",
                    "},",
                ]
            )
    return "\n".join(lines)


createPdpGeoRagIndexSkeleton = create_pdp_geo_rag_index_skeleton
renderPdpGeoRagIndexSkeleton = render_pdp_geo_rag_index_skeleton

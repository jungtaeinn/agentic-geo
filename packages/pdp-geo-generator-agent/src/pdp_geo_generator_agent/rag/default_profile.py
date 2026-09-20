"""Package-data backed default RAG profile.

Unlike the TypeScript generated string snapshot, Python ships the exact source
documents as wheel resources.  The profile still snapshots their bytes at
import time so write/reset fallbacks cannot silently depend on a checkout.
"""

from __future__ import annotations

from importlib.resources import files
from typing import Any, cast

from .manifest import PDP_GEO_GENERATOR_RAG_MANIFEST


def managed_rag_directory() -> Any:
    """Return the importlib traversable without assuming a filesystem wheel."""

    return cast(Any, files("pdp_geo_generator_agent")).joinpath("resources", "rag")


def read_managed_resource(name: str) -> str:
    return cast(str, managed_rag_directory().joinpath(*name.split("/")).read_text(encoding="utf-8"))


_documents = cast(dict[str, str], PDP_GEO_GENERATOR_RAG_MANIFEST["documents"])
DEFAULT_PDP_GEO_GENERATOR_ANALYSIS_PROMPT = read_managed_resource(str(PDP_GEO_GENERATOR_RAG_MANIFEST["analysisPrompt"]))
DEFAULT_PDP_GEO_GENERATOR_RAG_PROFILE: dict[str, Any] = {
    "profile": PDP_GEO_GENERATOR_RAG_MANIFEST["profile"],
    "analysisPrompt": DEFAULT_PDP_GEO_GENERATOR_ANALYSIS_PROMPT,
    "documents": [
        {
            "name": str(_documents["contentFieldContracts"]),
            "version": "v1",
            "content": read_managed_resource(str(_documents["contentFieldContracts"])),
        },
        {
            "name": str(_documents["schemaOrgProduct"]),
            "version": "v2",
            "content": read_managed_resource(str(_documents["schemaOrgProduct"])),
        },
        {"name": str(_documents["eeat"]), "version": "v1", "content": read_managed_resource(str(_documents["eeat"]))},
        {"name": str(_documents["cep"]), "version": "v1", "content": read_managed_resource(str(_documents["cep"]))},
        {
            "name": str(_documents["bestPractice"]),
            "version": "v1",
            "content": read_managed_resource(str(_documents["bestPractice"])),
        },
        {
            "name": str(_documents["geoResearch"]),
            "version": "v3",
            "content": read_managed_resource(str(_documents["geoResearch"])),
        },
        {
            "name": str(_documents["geoResearchEvidenceCards"]),
            "version": "v1",
            "content": read_managed_resource(str(_documents["geoResearchEvidenceCards"])),
        },
        {
            "name": str(_documents["officialAiSearchPlatformDocs"]),
            "version": "v1",
            "content": read_managed_resource(str(_documents["officialAiSearchPlatformDocs"])),
        },
        {
            "name": str(_documents["localeExpressionGuidelines"]),
            "version": "v1",
            "content": read_managed_resource(str(_documents["localeExpressionGuidelines"])),
        },
        {
            "name": str(_documents["localeTerminologyMap"]),
            "version": "v1",
            "content": read_managed_resource(str(_documents["localeTerminologyMap"])),
        },
    ],
}

defaultPdpGeoGeneratorAnalysisPrompt = DEFAULT_PDP_GEO_GENERATOR_ANALYSIS_PROMPT
defaultPdpGeoGeneratorRagProfile = DEFAULT_PDP_GEO_GENERATOR_RAG_PROFILE

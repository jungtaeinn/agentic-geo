"""Immutable filenames for the managed PDP GEO RAG corpus."""

from __future__ import annotations

from typing import Final

PDP_GEO_GENERATOR_RAG_MANIFEST: Final[dict[str, object]] = {
    "profile": "pdp-geo-generator-default",
    "analysisPrompt": "analysis-prompt_v1.md",
    "documents": {
        "contentFieldContracts": "content-field-contracts_v1.md",
        "schemaOrgProduct": "schema-org-product_v2.md",
        "eeat": "eeat_v1.md",
        "cep": "cep_v1.md",
        "bestPractice": "best-practice_v1.md",
        "geoResearch": "geo-research_v3.md",
        "geoResearchEvidenceCards": "evidence/geo-research-cards_v1.md",
        "officialAiSearchPlatformDocs": "official-ai-search-platform-docs_v1.md",
        "localeExpressionGuidelines": "locale-expression-guidelines_v1.md",
        "localeTerminologyMap": "locale-terminology-map_v1.json",
    },
    "brandIdentities": {
        "sample_botanics": "brands/sample_botanics/brand-identity_v1.md",
        "sample_derma": "brands/sample_derma/brand-identity_v2.md",
    },
    "brandBestPractices": {
        "sample_botanics": "brands/sample_botanics/best-practice_v2.md",
        "sample_derma": "brands/sample_derma/best-practice_v2.md",
    },
    "brandLocaleExpressionGuidelines": {
        "sample_botanics": "brands/sample_botanics/locale-expression-guidelines_v2.md",
        "sample_derma": "brands/sample_derma/locale-expression-guidelines_v2.md",
    },
    "brandLocaleTerminologyMaps": {
        "sample_botanics": "brands/sample_botanics/locale-terminology-map_v2.json",
        "sample_derma": "brands/sample_derma/locale-terminology-map_v2.json",
    },
}

pdpGeoGeneratorRagManifest = PDP_GEO_GENERATOR_RAG_MANIFEST

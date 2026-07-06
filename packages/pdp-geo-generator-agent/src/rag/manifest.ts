/** RAG profile used to keep GEO generator document versions explicit and testable. */
export const pdpGeoGeneratorRagManifest = {
  profile: "pdp-geo-generator-default",
  analysisPrompt: "analysis-prompt_v1.md",
  documents: {
    schemaOrgProduct: "schema-org-product_v1.md",
    eeat: "eeat_v1.md",
    cep: "cep_v1.md",
    bestPractice: "best-practice_v1.md",
    geoResearch: "geo-research_v1.md",
    officialAiSearchPlatformDocs: "official-ai-search-platform-docs_v1.md",
    localeExpressionGuidelines: "locale-expression-guidelines_v1.md",
    localeTerminologyMap: "locale-terminology-map_v1.json"
  },
  brandIdentities: {
    sulwhasoo: "brands/sulwhasoo/brand-identity_v1.md",
    aestura: "brands/aestura/brand-identity_v1.md"
  },
  brandBestPractices: {
    sulwhasoo: "brands/sulwhasoo/best-practice_v1.md",
    aestura: "brands/aestura/best-practice_v1.md"
  },
  brandLocaleExpressionGuidelines: {
    sulwhasoo: "brands/sulwhasoo/locale-expression-guidelines_v1.md",
    aestura: "brands/aestura/locale-expression-guidelines_v1.md"
  },
  brandLocaleTerminologyMaps: {
    sulwhasoo: "brands/sulwhasoo/locale-terminology-map_v1.json",
    aestura: "brands/aestura/locale-terminology-map_v1.json"
  }
} as const;

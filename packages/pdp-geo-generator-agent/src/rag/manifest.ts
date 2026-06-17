/** RAG profile used to keep GEO generator document versions explicit and testable. */
export const pdpGeoGeneratorRagManifest = {
  profile: "pdp-geo-generator-default",
  analysisPrompt: "analysis-prompt_v1.md",
  documents: {
    schemaOrgProduct: "schema-org-product_v1.md",
    eeat: "eeat_v1.md",
    cep: "cep_v1.md",
    bestPractice: "best-practice_v1.md",
    geoPaper: "geo-paper_v1.md",
    officialAiSearchPlatformDocs: "official-ai-search-platform-docs_v1.md",
    localeExpressionGuidelines: "locale-expression-guidelines_v1.md",
    localeTerminologyMap: "locale-terminology-map_v1.json"
  }
} as const;

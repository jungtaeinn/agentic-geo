/** RAG profile used to keep GEO generator document versions explicit and testable. */
export const pdpGeoGeneratorRagManifest = {
  profile: "pdp-geo-generator-default",
  analysisPrompt: "analysis-prompt_v1.md",
  documents: {
    contentFieldContracts: "content-field-contracts_v1.md",
    schemaOrgProduct: "schema-org-product_v2.md",
    eeat: "eeat_v1.md",
    cep: "cep_v1.md",
    bestPractice: "best-practice_v1.md",
    geoResearch: "geo-research_v3.md",
    geoResearchEvidenceCards: "evidence/geo-research-cards_v1.md",
    officialAiSearchPlatformDocs: "official-ai-search-platform-docs_v1.md",
    localeExpressionGuidelines: "locale-expression-guidelines_v1.md",
    localeTerminologyMap: "locale-terminology-map_v1.json"
  },
  brandIdentities: {
    exampleluxe: "brands/exampleluxe/brand-identity_v1.md",
    examplederma: "brands/examplederma/brand-identity_v1.md"
  },
  brandBestPractices: {
    exampleluxe: "brands/exampleluxe/best-practice_v2.md",
    examplederma: "brands/examplederma/best-practice_v2.md"
  },
  brandLocaleExpressionGuidelines: {
    exampleluxe: "brands/exampleluxe/locale-expression-guidelines_v2.md",
    examplederma: "brands/examplederma/locale-expression-guidelines_v2.md"
  },
  brandLocaleTerminologyMaps: {
    exampleluxe: "brands/exampleluxe/locale-terminology-map_v2.json",
    examplederma: "brands/examplederma/locale-terminology-map_v2.json"
  }
} as const;

import { pdpGeoGeneratorRagManifest } from "./manifest";
import { generatedAnalysisPromptFallback, generatedRagFallbackDocuments } from "./default-profile-fallback.generated";

/** A document that can be attached to the PDP GEO generator RAG profile. */
export interface PdpGeoGeneratorRagDocument {
  name: string;
  version: string;
  content: string;
}

/** Default prompt and reference documents shared by the UI, REST adapter, and RAG retrievers. */
export interface PdpGeoGeneratorRagProfile {
  profile: string;
  analysisPrompt: string;
  documents: PdpGeoGeneratorRagDocument[];
}

export const defaultPdpGeoGeneratorAnalysisPrompt = generatedAnalysisPromptFallback;

function generatedFallbackContent(documentName: string): string {
  const content = generatedRagFallbackDocuments[documentName];
  if (content === undefined) {
    throw new Error(`Missing generated RAG fallback content for "${documentName}". Run "npm run rag:generate-fallback".`);
  }
  return content;
}

/**
 * Inline bootstrap fallback for the managed RAG corpus.
 *
 * The committed files under src/rag/ are the authoritative documents; the
 * inline `content` below is a generated verbatim copy of that same corpus,
 * used only when a managed file is missing on disk (see profile.ts). It must
 * never overwrite an existing managed file. Do not edit `content` here —
 * edit the corresponding md/json file under src/rag/ and regenerate with
 * `npm run rag:generate-fallback` (see default-profile-fallback.generated.ts).
 * A drift test (tests/rag-profile.test.ts) fails CI if this falls out of
 * sync with the committed corpus.
 */
export const defaultPdpGeoGeneratorRagProfile: PdpGeoGeneratorRagProfile = {
  profile: pdpGeoGeneratorRagManifest.profile,
  analysisPrompt: defaultPdpGeoGeneratorAnalysisPrompt,
  documents: [
    // The contract canon is listed first so its authoritative rule wording wins
    // the policy compiler's global dedupe over any restatement elsewhere in the
    // corpus.
    {
      name: pdpGeoGeneratorRagManifest.documents.contentFieldContracts,
      version: "v1",
      content: generatedFallbackContent(pdpGeoGeneratorRagManifest.documents.contentFieldContracts)
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
      version: "v2",
      content: generatedFallbackContent(pdpGeoGeneratorRagManifest.documents.schemaOrgProduct)
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.eeat,
      version: "v1",
      content: generatedFallbackContent(pdpGeoGeneratorRagManifest.documents.eeat)
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.cep,
      version: "v1",
      content: generatedFallbackContent(pdpGeoGeneratorRagManifest.documents.cep)
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.bestPractice,
      version: "v1",
      content: generatedFallbackContent(pdpGeoGeneratorRagManifest.documents.bestPractice)
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.geoResearch,
      version: "v3",
      content: generatedFallbackContent(pdpGeoGeneratorRagManifest.documents.geoResearch)
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.geoResearchEvidenceCards,
      version: "v1",
      content: generatedFallbackContent(pdpGeoGeneratorRagManifest.documents.geoResearchEvidenceCards)
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.officialAiSearchPlatformDocs,
      version: "v1",
      content: generatedFallbackContent(pdpGeoGeneratorRagManifest.documents.officialAiSearchPlatformDocs)
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines,
      version: "v1",
      content: generatedFallbackContent(pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines)
    },
    {
      name: pdpGeoGeneratorRagManifest.documents.localeTerminologyMap,
      version: "v1",
      content: generatedFallbackContent(pdpGeoGeneratorRagManifest.documents.localeTerminologyMap)
    }
  ]
};

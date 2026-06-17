import { describe, expect, it } from "vitest";
import { pdpGeoGeneratorRagManifest } from "../src";
import { readPdpGeoGeneratorRagProfile } from "../src/rag/profile";

describe("readPdpGeoGeneratorRagProfile", () => {
  it("reads managed GEO generator RAG files including locale terminology", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();

    expect(profile.profile).toBe(pdpGeoGeneratorRagManifest.profile);
    expect(profile.analysisPrompt).toContain("GEO-optimized PDP artifacts");
    expect(profile.documents.map((document) => document.name)).toEqual(expect.arrayContaining([
      pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
      pdpGeoGeneratorRagManifest.documents.eeat,
      pdpGeoGeneratorRagManifest.documents.cep,
      pdpGeoGeneratorRagManifest.documents.bestPractice,
      pdpGeoGeneratorRagManifest.documents.geoPaper,
      pdpGeoGeneratorRagManifest.documents.officialAiSearchPlatformDocs,
      pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines,
      pdpGeoGeneratorRagManifest.documents.localeTerminologyMap
    ]));
  });
});

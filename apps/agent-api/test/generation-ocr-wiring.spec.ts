import { GenerationService } from "../src/geo/generation.service";
import type { OcrEnrichmentService, OcrEnrichmentOutcome } from "../src/geo/ocr-enrichment.service";

const generatePdpGeo = jest.fn();
jest.mock("@agentic-geo/pdp-geo-generator-agent", () => ({
  generatePdpGeo: (...args: unknown[]) => generatePdpGeo(...args),
}));

function buildRun(validationWarnings: string[] = []) {
  return {
    result: {
      schemaMarkup: { jsonLd: { "@context": "https://schema.org", "@graph": [] }, scriptTag: "<script/>" },
      diagnostics: { validationWarnings, normalizedProduct: {} },
      ragProfile: "profile@1",
      content: { sections: {} },
      generatedAt: "2026-09-01T00:00:00.000Z",
    },
  };
}

function makeOcrEnrichment(outcome: OcrEnrichmentOutcome): { enrich: jest.Mock; service: OcrEnrichmentService } {
  const enrich = jest.fn().mockResolvedValue(outcome);
  return { enrich, service: { enrich } as unknown as OcrEnrichmentService };
}

describe("GenerationService OCR enrichment wiring", () => {
  beforeEach(() => generatePdpGeo.mockReset());

  it("passes the OCR-enriched product to the generator, not the original", async () => {
    const enrichedProduct = { name: "test", ocr: { textBlocks: ["세라마이드"] } };
    const { enrich, service: ocrEnrichment } = makeOcrEnrichment({
      product: enrichedProduct,
      performed: true,
      warnings: [],
      diagnostics: { performed: true, targetCount: 1, excludedTargets: [], warnings: [] },
    });
    generatePdpGeo.mockResolvedValue(buildRun());

    const service = new GenerationService(ocrEnrichment);
    const originalProduct = {
      name: "test",
      ocrImages: ["https://cdn.example.com/a.png"],
      canonicalUrl: "https://store.example.com/p",
    };

    await service.generate({
      geoGenerationId: "11111111-1111-1111-1111-111111111111",
      locale: "ko-KR",
      product: originalProduct,
    });

    // enrich() must see the untouched original product plus the source url read from it.
    expect(enrich).toHaveBeenCalledWith(originalProduct, "https://store.example.com/p");

    const requestArg = generatePdpGeo.mock.calls[0][0] as { product: unknown };
    expect(requestArg.product).toEqual(enrichedProduct);
  });

  it("flips resultStatus to SUCCEEDED_WITH_WARNINGS from OCR warnings even with zero generator warnings", async () => {
    const ocrDiagnostics = {
      performed: false,
      skippedReason: "provider-not-configured" as const,
      targetCount: 1,
      excludedTargets: [],
      warnings: ["1 target(s) skipped: image OCR provider not configured"],
    };
    const { service: ocrEnrichment } = makeOcrEnrichment({
      product: { name: "test", ocrImages: ["https://cdn.example.com/a.png"] },
      performed: false,
      skippedReason: "provider-not-configured",
      warnings: ocrDiagnostics.warnings,
      diagnostics: ocrDiagnostics,
    });
    generatePdpGeo.mockResolvedValue(buildRun([]));

    const service = new GenerationService(ocrEnrichment);
    const artifact = await service.generate({
      geoGenerationId: "11111111-1111-1111-1111-111111111111",
      locale: "ko-KR",
      product: { name: "test", ocrImages: ["https://cdn.example.com/a.png"] },
    });

    expect(artifact.resultStatus).toBe("SUCCEEDED_WITH_WARNINGS");
    expect(artifact.diagnostics.ocrEnrichment).toEqual(ocrDiagnostics);
  });

  it("keeps SUCCEEDED when neither the generator nor OCR enrichment produced warnings", async () => {
    const { service: ocrEnrichment } = makeOcrEnrichment({
      product: { name: "test" },
      performed: false,
      skippedReason: "no-targets",
      warnings: [],
      diagnostics: { performed: false, skippedReason: "no-targets", targetCount: 0, excludedTargets: [], warnings: [] },
    });
    generatePdpGeo.mockResolvedValue(buildRun([]));

    const service = new GenerationService(ocrEnrichment);
    const artifact = await service.generate({
      geoGenerationId: "11111111-1111-1111-1111-111111111111",
      locale: "ko-KR",
      product: { name: "test" },
    });

    expect(artifact.resultStatus).toBe("SUCCEEDED");
  });
});

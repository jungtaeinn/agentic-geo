import { OcrEnrichmentService } from "../src/geo/ocr-enrichment.service";

const extractImageOcrEvidence = jest.fn();
jest.mock("@agentic-geo/pdp-extractor-agent", () => ({
  extractImageOcrEvidence: (...args: unknown[]) => extractImageOcrEvidence(...args),
}));

const OCR_RESULT = {
  ocr: {
    imageTexts: [{ imageUrl: "https://cdn.example.com/a.png", imageUrls: ["https://cdn.example.com/a.png"], text: "세라마이드 10,000ppm", confidence: 0.9 }],
    textBlocks: ["세라마이드 10,000ppm"],
    sentenceInsights: [{ imageUrl: "https://cdn.example.com/a.png", imageUrls: ["https://cdn.example.com/a.png"], text: "세라마이드 10,000ppm", category: "ingredient", keywords: [] }],
    semanticFacts: undefined,
  },
  keywords: {},
  diagnostics: { ocr: { relations: { attributionCounts: { declared: 1, fuzzy: 0, local: 0 } } }, warnings: [], runtimeUsage: undefined },
  generatedAt: "2026-09-01T00:00:00.000Z",
};

describe("OcrEnrichmentService", () => {
  beforeEach(() => extractImageOcrEvidence.mockReset());

  it("enriches a copy with OCR blocks and never mutates the input", async () => {
    extractImageOcrEvidence.mockResolvedValue(OCR_RESULT);
    const service = new OcrEnrichmentService();
    const input = { name: "테스트 크림", ocrImages: ["https://cdn.example.com/a.png"] };
    const frozen = JSON.stringify(input);

    const outcome = await service.enrich(input, "https://example.com/p/1");

    expect(outcome.performed).toBe(true);
    expect(JSON.stringify(input)).toBe(frozen);
    const enriched = outcome.product as Record<string, unknown>;
    const sourceOcr = (enriched.sourceExtraction as Record<string, unknown>).ocr as Record<string, unknown>;
    expect(sourceOcr.imageTexts).toHaveLength(1);
    const topOcr = enriched.ocr as Record<string, unknown>;
    expect(topOcr.textBlocks).toEqual(["세라마이드 10,000ppm"]);
    expect(topOcr.keywords).toBeUndefined();
    expect(outcome.diagnostics.ocr).toBeDefined();
  });

  it("skips when the payload already carries OCR text", async () => {
    const service = new OcrEnrichmentService();
    const input = { ocrImages: ["https://cdn.example.com/a.png"], sourceExtraction: { ocr: { imageTexts: [{ imageUrl: "x", text: "y" }] } } };

    const outcome = await service.enrich(input, undefined);

    expect(outcome.performed).toBe(false);
    expect(outcome.skippedReason).toBe("existing-ocr");
    expect(outcome.warnings).toEqual([]);
    expect(extractImageOcrEvidence).not.toHaveBeenCalled();
  });

  it("excludes non-http and disallowed hosts with one policy warning", async () => {
    extractImageOcrEvidence.mockResolvedValue(OCR_RESULT);
    process.env.AGENTIC_GEO_OCR_IMAGE_ALLOWED_HOSTS = "cdn.example.com";
    const service = new OcrEnrichmentService();
    const input = { ocrImages: ["data:image/png;base64,AAAA", "https://evil.example.net/x.png", "https://img.cdn.example.com/a.png"] };

    const outcome = await service.enrich(input, undefined);

    expect(outcome.diagnostics.excludedTargets).toHaveLength(2);
    expect(outcome.warnings.some((warning) => warning.includes("URL policy"))).toBe(true);
    expect(extractImageOcrEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrls: ["https://img.cdn.example.com/a.png"] }),
      expect.anything(),
    );
    delete process.env.AGENTIC_GEO_OCR_IMAGE_ALLOWED_HOSTS;
  });

  it("degrades to a warning when extraction throws", async () => {
    extractImageOcrEvidence.mockRejectedValue(new Error("provider down"));
    const service = new OcrEnrichmentService();
    const input = { ocrImages: ["https://cdn.example.com/a.png"] };

    const outcome = await service.enrich(input, undefined);

    expect(outcome.performed).toBe(false);
    expect(outcome.product).toBe(input);
    expect(outcome.warnings.some((warning) => warning.includes("provider down"))).toBe(true);
  });

  it("returns no-targets without warnings when ocrImages is absent", async () => {
    const service = new OcrEnrichmentService();
    const outcome = await service.enrich({ name: "x" }, undefined);
    expect(outcome.skippedReason).toBe("no-targets");
    expect(outcome.warnings).toEqual([]);
  });

  it("skips when the payload already carries OCR text in the top-level merged shape", async () => {
    const service = new OcrEnrichmentService();
    const input = { ocrImages: ["https://cdn.example.com/a.png"], ocr: { textBlocks: ["already extracted"] } };

    const outcome = await service.enrich(input, undefined);

    expect(outcome.performed).toBe(false);
    expect(outcome.skippedReason).toBe("existing-ocr");
    expect(outcome.warnings).toEqual([]);
    expect(extractImageOcrEvidence).not.toHaveBeenCalled();
  });

  it("skips when only the top-level ocr.imageTexts is non-empty (symmetric existing-ocr check)", async () => {
    const service = new OcrEnrichmentService();
    const input = { ocrImages: ["https://cdn.example.com/a.png"], ocr: { imageTexts: [{ imageUrl: "x", text: "already extracted" }] } };

    const outcome = await service.enrich(input, undefined);

    expect(outcome.performed).toBe(false);
    expect(outcome.skippedReason).toBe("existing-ocr");
    expect(outcome.warnings).toEqual([]);
    expect(extractImageOcrEvidence).not.toHaveBeenCalled();
  });

  it("preserves unrelated existing top-level ocr keys when merging new OCR results", async () => {
    extractImageOcrEvidence.mockResolvedValue(OCR_RESULT);
    const service = new OcrEnrichmentService();
    const input = { ocrImages: ["https://cdn.example.com/a.png"], ocr: { customField: "keep-me" } };

    const outcome = await service.enrich(input, undefined);

    expect(outcome.performed).toBe(true);
    const enriched = outcome.product as Record<string, unknown>;
    const topOcr = enriched.ocr as Record<string, unknown>;
    expect(topOcr.customField).toBe("keep-me");
    expect(topOcr.textBlocks).toEqual(["세라마이드 10,000ppm"]);
  });

  it("does not call the extractor when every target is excluded by URL policy", async () => {
    const service = new OcrEnrichmentService();
    const input = { ocrImages: ["data:image/png;base64,AAAA", "ftp://cdn.example.com/a.png"] };

    const outcome = await service.enrich(input, undefined);

    expect(outcome.performed).toBe(false);
    expect(extractImageOcrEvidence).not.toHaveBeenCalled();
    expect(outcome.diagnostics.excludedTargets).toHaveLength(2);
    expect(outcome.warnings.some((warning) => warning.includes("URL policy"))).toBe(true);
  });

  it("records provider-not-configured and counts its warning when the extractor reports zero OCR candidates", async () => {
    extractImageOcrEvidence.mockResolvedValue({
      ocr: { imageTexts: [], textBlocks: [], sentenceInsights: [], semanticFacts: undefined },
      keywords: {},
      diagnostics: {
        ocr: { relations: { attributionCounts: { declared: 0, fuzzy: 0, local: 0 } } },
        warnings: [{ code: "IMAGE_OCR_PROVIDER_NOT_CONFIGURED", message: "image OCR was skipped because the active provider is mock" }],
        runtimeUsage: undefined,
      },
      generatedAt: "2026-09-01T00:00:00.000Z",
    });
    const service = new OcrEnrichmentService();
    const input = { ocrImages: ["https://cdn.example.com/a.png"] };

    const outcome = await service.enrich(input, undefined);

    expect(outcome.performed).toBe(false);
    expect(outcome.skippedReason).toBe("provider-not-configured");
    expect(outcome.warnings.some((warning) => warning.includes("active provider is mock"))).toBe(true);
    expect(outcome.diagnostics.ocr).toBeDefined();
  });

  it("records diagnostics without a skippedReason when the extractor simply found no OCR candidates", async () => {
    extractImageOcrEvidence.mockResolvedValue({
      ocr: { imageTexts: [], textBlocks: [], sentenceInsights: [], semanticFacts: undefined },
      keywords: {},
      diagnostics: { ocr: { relations: { attributionCounts: { declared: 0, fuzzy: 0, local: 0 } } }, warnings: [], runtimeUsage: undefined },
      generatedAt: "2026-09-01T00:00:00.000Z",
    });
    const service = new OcrEnrichmentService();
    const input = { ocrImages: ["https://cdn.example.com/a.png"] };

    const outcome = await service.enrich(input, undefined);

    expect(outcome.performed).toBe(false);
    expect(outcome.skippedReason).toBeUndefined();
    expect(outcome.diagnostics.ocr).toBeDefined();
  });

  it("reads targets and the product name from the geoProduct alias", async () => {
    extractImageOcrEvidence.mockResolvedValue(OCR_RESULT);
    const service = new OcrEnrichmentService();
    const input = { geoProduct: { name: "테스트 크림", ocrImages: ["https://cdn.example.com/a.png"] } };

    const outcome = await service.enrich(input, undefined);

    expect(outcome.performed).toBe(true);
    expect(extractImageOcrEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ productName: "테스트 크림", imageUrls: ["https://cdn.example.com/a.png"] }),
      expect.anything(),
    );
    const enriched = outcome.product as Record<string, unknown>;
    const sourceOcr = (enriched.sourceExtraction as Record<string, unknown>).ocr as Record<string, unknown>;
    expect(sourceOcr.imageTexts).toHaveLength(1);
  });

  it("rejects localhost, loopback, private, link-local, CGNAT, and IP-literal-encoded hosts regardless of allowlist", async () => {
    extractImageOcrEvidence.mockResolvedValue(OCR_RESULT);
    const service = new OcrEnrichmentService();
    const input = {
      ocrImages: [
        "http://localhost/x.png",
        "http://127.0.0.1/x.png",
        "http://0x7f000001/x.png",
        "http://169.254.169.254/x.png",
        "http://10.0.0.5/x.png",
        "http://172.16.0.5/x.png",
        "http://192.168.1.5/x.png",
        "http://0.0.0.5/x.png",
        "http://100.64.0.5/x.png",
        "http://[::1]/x.png",
        "http://[fe80::1]/x.png",
        "http://[fc00::1]/x.png",
        "http://[::]/x.png",
        "http://[::ffff:127.0.0.1]/x.png",
        "http://[::ffff:169.254.169.254]/x.png",
        "https://cdn.example.com/a.png",
      ],
    };

    const outcome = await service.enrich(input, undefined);

    const excludedByPrivate = outcome.diagnostics.excludedTargets.filter((target) => target.reason === "private-or-local-address");
    expect(excludedByPrivate).toHaveLength(15);
    expect(extractImageOcrEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrls: ["https://cdn.example.com/a.png"] }),
      expect.anything(),
    );
  });

  it("allows a public IPv4-mapped IPv6 literal through", async () => {
    extractImageOcrEvidence.mockResolvedValue(OCR_RESULT);
    const service = new OcrEnrichmentService();
    const input = { ocrImages: ["http://[::ffff:8.8.8.8]/x.png"] };

    const outcome = await service.enrich(input, undefined);

    expect(outcome.diagnostics.excludedTargets).toHaveLength(0);
    expect(extractImageOcrEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrls: ["http://[::ffff:8.8.8.8]/x.png"] }),
      expect.anything(),
    );
  });

  it("fails closed and excludes every target when the allowlist env is set but parses to no hosts", async () => {
    const service = new OcrEnrichmentService();
    process.env.AGENTIC_GEO_OCR_IMAGE_ALLOWED_HOSTS = " , , ";
    const input = { ocrImages: ["https://cdn.example.com/a.png", "https://other.example.com/b.png"] };

    const outcome = await service.enrich(input, undefined);

    delete process.env.AGENTIC_GEO_OCR_IMAGE_ALLOWED_HOSTS;

    expect(outcome.performed).toBe(false);
    expect(extractImageOcrEvidence).not.toHaveBeenCalled();
    expect(outcome.diagnostics.excludedTargets).toHaveLength(2);
    expect(outcome.diagnostics.excludedTargets.every((target) => target.reason === "allowlist-misconfigured")).toBe(true);
    expect(outcome.warnings.some((warning) => warning.includes("URL policy"))).toBe(true);
  });

  it("deduplicates raw URLs and caps at 50 targets, recording overflow without an extra warning", async () => {
    extractImageOcrEvidence.mockResolvedValue(OCR_RESULT);
    const service = new OcrEnrichmentService();
    const uniqueUrls = Array.from({ length: 55 }, (_, index) => `https://cdn.example.com/img-${index}.png`);
    const input = { ocrImages: [...uniqueUrls, uniqueUrls[0]] }; // 55 unique + 1 duplicate

    const outcome = await service.enrich(input, undefined);

    const overflow = outcome.diagnostics.excludedTargets.filter((target) => target.reason === "target-limit-exceeded");
    expect(overflow).toHaveLength(5);
    expect(outcome.warnings.some((warning) => warning.includes("URL policy"))).toBe(false);
    expect(extractImageOcrEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrls: expect.arrayContaining([uniqueUrls[0]]) }),
      expect.anything(),
    );
    const calledImageUrls = extractImageOcrEvidence.mock.calls[0][0].imageUrls as string[];
    expect(calledImageUrls).toHaveLength(50);
    expect(new Set(calledImageUrls).size).toBe(50);
  });

  it("applies the 50-target cap only to policy survivors, so invalid URLs cannot push valid ones out", async () => {
    extractImageOcrEvidence.mockResolvedValue(OCR_RESULT);
    const service = new OcrEnrichmentService();
    const validUrls = Array.from({ length: 55 }, (_, index) => `https://cdn.example.com/img-${index}.png`);
    const invalidUrls = ["not-a-url", "ftp://cdn.example.com/x.png", "http://127.0.0.1/x.png"];
    const input = { ocrImages: [...invalidUrls, ...validUrls] };

    const outcome = await service.enrich(input, undefined);

    const overflow = outcome.diagnostics.excludedTargets.filter((target) => target.reason === "target-limit-exceeded");
    const policyExcluded = outcome.diagnostics.excludedTargets.filter((target) => target.reason !== "target-limit-exceeded");
    expect(overflow).toHaveLength(5);
    expect(policyExcluded).toHaveLength(3);
    const calledImageUrls = extractImageOcrEvidence.mock.calls[0][0].imageUrls as string[];
    expect(calledImageUrls).toHaveLength(50);
    expect(calledImageUrls.every((url) => validUrls.includes(url))).toBe(true);
  });

  it("records a countable warning and an invalid-contract diagnostic when ocrImages is not a string array", async () => {
    const service = new OcrEnrichmentService();
    const input = { ocrImages: "https://cdn.example.com/a.png" };

    const outcome = await service.enrich(input, undefined);

    expect(outcome.performed).toBe(false);
    expect(outcome.skippedReason).toBe("no-targets");
    expect(outcome.warnings.some((warning) => warning.includes("ocrImages contract violation"))).toBe(true);
    expect(outcome.diagnostics.excludedTargets.some((target) => target.reason === "invalid-contract")).toBe(true);
    expect(extractImageOcrEvidence).not.toHaveBeenCalled();
  });

  it("records a countable warning when ocrImages is a mixed array", async () => {
    const service = new OcrEnrichmentService();
    const input = { ocrImages: ["https://cdn.example.com/a.png", 42] };

    const outcome = await service.enrich(input, undefined);

    expect(outcome.performed).toBe(false);
    expect(outcome.skippedReason).toBe("no-targets");
    expect(outcome.warnings.some((warning) => warning.includes("ocrImages contract violation"))).toBe(true);
    expect(outcome.diagnostics.excludedTargets.some((target) => target.reason === "invalid-contract")).toBe(true);
    expect(extractImageOcrEvidence).not.toHaveBeenCalled();
  });

  it("forwards the layout relation diagnostics the extractor reported", async () => {
    // agent-api로 들어온 이미지에서도 관계가 채택됐는지 폐기됐는지 남아야 한다.
    // 이 블록이 없으면 운영에서 구조 보고 품질을 볼 방법이 없다.
    extractImageOcrEvidence.mockResolvedValue({
      ...OCR_RESULT,
      diagnostics: {
        ...OCR_RESULT.diagnostics,
        ocr: {
          layout: {
            groupsReported: 3,
            groupsKept: 2,
            lineRoles: { title: 1, body: 2, label: 1, value: 2, footnote: 1 },
            sliceStitches: 1,
            structureDiscarded: [{ imageUrl: "https://cdn.example.com/a.png", reason: "quorum" }],
          },
        },
      },
    });
    const service = new OcrEnrichmentService();

    const outcome = await service.enrich({ ocrImages: ["https://cdn.example.com/a.png"] }, undefined);

    const layout = (outcome.diagnostics.ocr as Record<string, unknown>).layout as Record<string, unknown>;
    expect(layout.groupsKept).toBe(2);
    expect(layout.sliceStitches).toBe(1);
    expect(layout.structureDiscarded).toEqual([{ imageUrl: "https://cdn.example.com/a.png", reason: "quorum" }]);
  });

  it("passes the product name so chart series can be attributed", async () => {
    // 차트 계열 귀속은 라벨에 상품명이 들어 있는지로만 판정된다. 상품명이
    // 전달되지 않으면 "예시더마 클렌징폼 대비 자사 알칼리 폼"을 가릴 수 없다.
    extractImageOcrEvidence.mockResolvedValue(OCR_RESULT);
    const service = new OcrEnrichmentService();

    await service.enrich(
      { name: "예시더마 모이베리어365 클렌징폼", ocrImages: ["https://cdn.example.com/a.png"] },
      "https://shop.example.com/web/product/view.do?prdSeq=1145",
    );

    expect(extractImageOcrEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ productName: "예시더마 모이베리어365 클렌징폼" }),
      expect.anything(),
    );
  });
});

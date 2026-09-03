import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { GeoTestController } from "../src/geo/geo-test.controller";
import { GenerationService } from "../src/geo/generation.service";
import { OcrEnrichmentService } from "../src/geo/ocr-enrichment.service";

const artifact = {
  resultStatus: "SUCCEEDED" as const,
  jsonLd: { "@context": "https://schema.org" },
  scriptTag: "<script/>",
  schemaTypes: ["Product"],
  resultHash: "hash",
  ragProfile: "profile@1",
  diagnostics: {
    validationWarnings: [],
    runtimeUsage: {
      steps: [
        {
          stage: "final",
          label: "generate",
          model: "gpt-test",
          called: true,
          tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        },
      ],
      tokenTotals: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    },
    normalizedProduct: { name: "test" },
  },
  contentSections: {
    productName: "테스트 제품",
    description: "설명",
    quickFacts: "",
    benefits: "",
    ingredients: "",
    howToUse: "",
    faq: "",
  },
  generatedAt: "2026-08-05T00:00:00.000Z",
};

describe("GeoTestController (e2e)", () => {
  let app: INestApplication;
  const generate = jest.fn();
  const flagBefore = process.env.GEO_TEST_SYNC_ENDPOINT;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      controllers: [GeoTestController],
      providers: [{ provide: GenerationService, useValue: { generate } }],
    }).compile();
    app = ref.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    generate.mockReset();
    process.env.GEO_TEST_SYNC_ENDPOINT = "true";
  });

  afterEach(() => {
    if (flagBefore === undefined) delete process.env.GEO_TEST_SYNC_ENDPOINT;
    else process.env.GEO_TEST_SYNC_ENDPOINT = flagBefore;
  });

  it("스위치가 꺼져 있으면 404를 반환한다", async () => {
    delete process.env.GEO_TEST_SYNC_ENDPOINT;
    await request(app.getHttpServer())
      .post("/internal/v1/geo/test-generations")
      .send({ locale: "ko-KR", product: { name: "test" } })
      .expect(404);
    expect(generate).not.toHaveBeenCalled();
  });

  it("동기 생성 결과를 runtimeUsage와 함께 반환한다", async () => {
    generate.mockResolvedValueOnce(artifact);
    const res = await request(app.getHttpServer())
      .post("/internal/v1/geo/test-generations")
      .send({ locale: "ko-KR", product: { name: "test" } });

    expect(res.status).toBe(200);
    expect(res.body.geoGenerationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.resultStatus).toBe("SUCCEEDED");
    expect(res.body.jsonLd).toEqual({ "@context": "https://schema.org" });
    expect(res.body.runtimeUsage.tokenTotals.totalTokens).toBe(30);
    // 대용량 opt-in 페이로드는 기본 응답에 싣지 않는다
    expect(res.body.diagnostics).toBeUndefined();
    expect(res.body.contentSections).toBeUndefined();

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "ko-KR", product: { name: "test" } }),
    );
  });

  it("includeDiagnostics=true면 diagnostics와 contentSections를 함께 반환한다", async () => {
    generate.mockResolvedValueOnce(artifact);
    const res = await request(app.getHttpServer())
      .post("/internal/v1/geo/test-generations")
      .send({ locale: "ko-KR", product: { name: "test" }, includeDiagnostics: true });

    expect(res.status).toBe(200);
    // 품질 루브릭이 읽는 진단 계약이 그대로 실려야 한다
    expect(res.body.diagnostics.normalizedProduct).toEqual({ name: "test" });
    expect(res.body.diagnostics.validationWarnings).toEqual([]);
    // 개선 프롬프트가 "현재 콘텐츠"로 요구하는 섹션
    expect(res.body.contentSections.productName).toBe("테스트 제품");
    // 기본 응답 필드는 그대로 유지된다
    expect(res.body.resultStatus).toBe("SUCCEEDED");
    expect(res.body.validationWarnings).toEqual([]);
  });

  it("includeDiagnostics가 불리언이 아니면 400을 반환한다", async () => {
    await request(app.getHttpServer())
      .post("/internal/v1/geo/test-generations")
      .send({ locale: "ko-KR", product: { name: "test" }, includeDiagnostics: "yes" })
      .expect(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it("잘못된 본문이면 400을 반환한다", async () => {
    await request(app.getHttpServer())
      .post("/internal/v1/geo/test-generations")
      .send({ locale: "", product: "not-an-object" })
      .expect(400);
    expect(generate).not.toHaveBeenCalled();
  });
});

/**
 * 위 describe와 달리 GenerationService를 목으로 대체하지 않는다 — OCR 보강 배선이
 * 실제 GenerationService → OcrEnrichmentService → (mock 프로바이더) 생성기까지 이어지는지
 * 검증하려면 실물이 필요하다. mock 프로바이더는 이미지 OCR 대상이 있으면 네트워크 호출
 * 없이 경고만 내므로(packages/pdp-extractor-agent) 이 스위트도 여전히 실 LLM/네트워크와 무관하다.
 */
describe("GeoTestController (e2e) — OCR enrichment wiring", () => {
  let app: INestApplication;
  const flagBefore = process.env.GEO_TEST_SYNC_ENDPOINT;
  const providerBefore = process.env.AGENTIC_GEO_PROVIDER;

  beforeAll(async () => {
    process.env.AGENTIC_GEO_PROVIDER = "mock";
    const ref = await Test.createTestingModule({
      controllers: [GeoTestController],
      providers: [GenerationService, OcrEnrichmentService],
    }).compile();
    app = ref.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (providerBefore === undefined) delete process.env.AGENTIC_GEO_PROVIDER;
    else process.env.AGENTIC_GEO_PROVIDER = providerBefore;
  });

  beforeEach(() => {
    process.env.GEO_TEST_SYNC_ENDPOINT = "true";
  });

  afterEach(() => {
    if (flagBefore === undefined) delete process.env.GEO_TEST_SYNC_ENDPOINT;
    else process.env.GEO_TEST_SYNC_ENDPOINT = flagBefore;
  });

  it("product.ocrImages가 있으면 mock 프로바이더 미구성 경고로 SUCCEEDED_WITH_WARNINGS를 반환한다", async () => {
    const res = await request(app.getHttpServer())
      .post("/internal/v1/geo/test-generations")
      .set("x-api-key", "test-key")
      .send({
        locale: "ko-KR",
        product: { name: "테스트 크림", ocrImages: ["https://cdn.example.com/a.png"] },
        includeDiagnostics: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.resultStatus).toBe("SUCCEEDED_WITH_WARNINGS");
    expect(res.body.diagnostics.ocrEnrichment.skippedReason).toBe("provider-not-configured");
  });
});

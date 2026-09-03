import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";
import type { PdpGeoGenerationRun } from "../src/types";
import {
  agentApiSubmitPayloads,
  extractorLiveProductKeys,
  extractorRunResults,
  pdpGeoGenerationInputs
} from "./fixtures/pdp-extractor-live-products";
import { graphOf, nodeOf } from "./support/graph";

// 라이브 PDP 4종(예시럭셔리 2, 예시더마 2)을 pdp-extractor-agent 결과물 형태로 재현한
// 목업으로 pdp-geo-generator-agent 전체 파이프라인을 검증한다.
// - 목업 자체가 extractor 출력 계약(GeoProductRawData 미러 불변식)을 지키는지
// - agent-api SubmitGenerationDto 계약(geoGenerationId/locale/product)을 지키는지
// - 생성 결과의 정량값(가격/평점/리뷰 수/옵션/메트릭 클레임)이 원본 PDP와 일치하는지
// - JSON-LD 구조(WebPage/Product/FAQPage, canonicalUrl 앵커)가 정상 구성되는지
/**
 * Each case runs the whole generation pipeline over a live product fixture, so
 * these are seconds-scale by nature — around seven seconds for the file on its
 * own. Vitest's 5s default made them fail only when the rest of the suite ran
 * in parallel, which reads as a flake and hides real failures behind it. The
 * timeout is stated here rather than raised globally so ordinary unit tests
 * keep the tight default.
 */
const LIVE_FIXTURE_TIMEOUT_MS = 30_000;

describe("pdp-extractor live product fixtures (mock contract)", { timeout: LIVE_FIXTURE_TIMEOUT_MS }, () => {
  it.each(extractorLiveProductKeys)("%s mirrors the extractor output invariants", (key) => {
    const { geoProduct } = extractorRunResults[key];

    // extractor 파이프라인 불변식: 분류 블록은 최상위 목록의 미러다.
    expect(geoProduct.categorizedProductInfo.benefits).toEqual(geoProduct.benefits);
    expect(geoProduct.categorizedProductInfo.effects).toEqual(geoProduct.effects);
    expect(geoProduct.categorizedProductInfo.ingredients).toEqual(geoProduct.ingredients);
    expect(geoProduct.categorizedProductInfo.usage).toEqual(geoProduct.usage);
    expect(geoProduct.categorizedProductInfo.metrics).toEqual(geoProduct.metrics);
    expect(geoProduct.categorizedProductInfo.faq).toEqual(geoProduct.faq);
    expect(geoProduct.ocr.textBlocks).toEqual(geoProduct.sourceExtraction.ocr.textBlocks);
    expect(geoProduct.ocr.textBlocks).toEqual(geoProduct.sourceExtraction.ocr.imageTexts.map((item) => item.text));

    // 모든 상품에 OCR 근거와 RAG chunk가 채워져 있어야 한다.
    expect(geoProduct.ocr.textBlocks.length).toBeGreaterThanOrEqual(2);
    expect(geoProduct.rag.chunks.length).toBeGreaterThanOrEqual(3);
    expect(geoProduct.rag.chunks.some((chunk) => chunk.kind === "ocr")).toBe(true);
    expect(geoProduct.semanticFacts?.metricClaims.length ?? 0).toBeGreaterThanOrEqual(1);

    const result = extractorRunResults[key];
    expect(result.sourceType).toBe("url");
    expect(result.ragProfile).toBe("pdp-extractor-default");
    expect(result.source).toMatch(/^https:\/\//);
  });

  it.each(extractorLiveProductKeys)("%s agent-api payload follows SubmitGenerationDto", (key) => {
    const payload = agentApiSubmitPayloads[key];

    expect(payload.geoGenerationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(["ko-KR", "en-US"]).toContain(payload.locale);
    // agent-api extractSourceUrl()이 @id 앵커로 사용하는 canonicalUrl 계약(GEO-128).
    expect(String(payload.product.canonicalUrl)).toBe(extractorRunResults[key].source);
    expect(payload.product.geoProduct).toBeDefined();
  });
});

describe("generatePdpGeo with ExampleLuxe Botanical Ginseng Rejuvenating Serum (en-US)", { timeout: LIVE_FIXTURE_TIMEOUT_MS }, () => {
  it("normalizes extractor output and emits en-US Product/WebPage schema", async () => {
    const run = await generatePdpGeo(pdpGeoGenerationInputs["exampleluxe-cgr-serum"]);
    const normalized = run.result.diagnostics.normalizedProduct;

    // 정량값: 원본 PDP와 일치해야 한다.
    expect(normalized.name).toBe("Botanical Ginseng Rejuvenating Serum");
    expect(normalized.brand).toBe("ExampleLuxe");
    expect(normalized.price?.raw).toBe("$215.00");
    expect(normalized.price?.amount).toBe(215);
    expect(normalized.options).toContain("50 mL");
    expect(normalized.ingredients).toContain("Niacinamide");
    expect(normalized.benefits).toContain("anti-aging");

    // OCR 근거 문장이 sourceTexts로 유입되어야 한다.
    expect(normalized.sourceTexts.some((text) => text.includes("32 women"))).toBe(true);

    // 정량 메트릭 클레임이 보존되어야 한다.
    const claims = normalized.semanticFacts?.metricClaims ?? [];
    expect(claims.some((claim) => claim.value === "100" && claim.unit === "%")).toBe(true);

    // JSON-LD 구조.
    expect(run.result.locale).toBe("en-US");
    const product = nodeOf(run, "Product");
    const webPage = nodeOf(run, "WebPage");
    expect(product).toBeDefined();
    expect(webPage).toBeDefined();
    expect(String(product?.name)).toContain("Botanical Ginseng Rejuvenating Serum");

    // 가격/통화는 Offer 노드로 반영되어야 한다.
    const offer = product?.offers as Record<string, any>;
    expect(offer?.price).toBe(215);
    expect(offer?.priceCurrency).toBe("USD");
    expect(String(offer?.availability)).toContain("InStock");

    expect(run.result.schemaMarkup.scriptTag).toContain('type="application/ld+json"');
    expect(run.result.content.sections.productName.length).toBeGreaterThan(0);
    expect(run.result.content.sections.description.length).toBeGreaterThan(0);
  });
});

describe("generatePdpGeo with ExampleLuxe Essential Activating Serum (en-US)", { timeout: LIVE_FIXTURE_TIMEOUT_MS }, () => {
  it("keeps variant options, price and survey metric claims", async () => {
    const run = await generatePdpGeo(pdpGeoGenerationInputs["exampleluxe-fcas-vi"]);
    const normalized = run.result.diagnostics.normalizedProduct;

    expect(normalized.name).toBe("Essential Activating Serum");
    expect(normalized.price?.raw).toBe("$89.00");
    expect(normalized.options).toContain("60 mL");
    expect(normalized.options).toContain("90 mL");
    expect(normalized.ingredients).toContain("500-Hour Aged Ginseng Extract");

    // 설문/기기 측정 정량 클레임 3건이 정규화 이후에도 보존되어야 한다.
    const claims = normalized.semanticFacts?.metricClaims ?? [];
    expect(claims.length).toBeGreaterThanOrEqual(3);
    expect(claims.some((claim) => claim.value === "92" && claim.unit === "%")).toBe(true);
    expect(claims.some((claim) => claim.value === "86" && claim.unit === "%")).toBe(true);
    expect(claims.some((claim) => claim.value === "100" && claim.unit === "%")).toBe(true);

    // trust-sensitive 판매 순위 클레임(수치 근거 없음)은 extractor 목업에는 있지만
    // sanitizer가 정규화 단계에서 걸러내야 한다.
    const fixtureClaims =
      extractorRunResults["exampleluxe-fcas-vi"].geoProduct.semanticFacts?.metricClaims ?? [];
    expect(fixtureClaims.some((claim) => claim.caveat !== undefined && /trust-sensitive/i.test(claim.caveat))).toBe(true);
    expect(claims.some((claim) => /number one/i.test(claim.label ?? ""))).toBe(false);

    // trust-sensitive 마케팅 클레임("Korea's number one")은 공개 문구에 근거 없이 복제되면 안 된다.
    const publicCopy = [
      run.result.content.sections.description,
      run.result.content.sections.quickFacts,
      run.result.content.sections.benefits
    ].join("\n");
    expect(publicCopy).not.toMatch(/number one|no\.\s*1|1위/i);

    expect(run.result.locale).toBe("en-US");
    expect(nodeOf(run, "Product")).toBeDefined();
  });
});

describe("generatePdpGeo with EXAMPLEDERMA 모이베리어365 캡슐 토너 (ko-KR)", { timeout: LIVE_FIXTURE_TIMEOUT_MS }, () => {
  it("emits Korean copy, FAQPage schema, and keeps barrier metric claims", async () => {
    const run = await generatePdpGeo(pdpGeoGenerationInputs["examplederma-capsule-toner"]);
    const normalized = run.result.diagnostics.normalizedProduct;

    expect(normalized.name).toBe("예시더마 모이베리어365 캡슐 토너");
    expect(normalized.brand).toBe("EXAMPLEDERMA");
    expect(normalized.options).toContain("300ml");
    expect(normalized.ingredients).toContain("세라마이드엔피");
    expect(normalized.faq).toHaveLength(4);

    // 정량 메트릭: 수분량 1.3배, 장벽 손상 93% 회복, 각질량 82% 감소.
    const claims = normalized.semanticFacts?.metricClaims ?? [];
    expect(claims.length).toBeGreaterThanOrEqual(5);
    expect(claims.some((claim) => claim.value === "1.3")).toBe(true);
    expect(claims.some((claim) => claim.value === "93" && claim.unit === "%")).toBe(true);
    expect(claims.some((claim) => claim.value === "82" && claim.unit === "%")).toBe(true);

    // OCR로 추출한 특허 출원 번호가 근거 텍스트로 유입되어야 한다.
    expect(normalized.sourceTexts.some((text) => text.includes("KR10-2023-0133775"))).toBe(true);

    // ko-KR 스키마: 원본 FAQ 4건을 기반으로 FAQPage가 구성되어야 한다
    // (generator가 근거 기반 파생 질문을 추가할 수 있으므로 최소 4건).
    expect(run.result.locale).toBe("ko-KR");
    const faqPage = nodeOf(run, "FAQPage");
    expect(faqPage).toBeDefined();
    const questions = (faqPage?.mainEntity as Array<Record<string, unknown>>).map((item) => String(item.name));
    expect(questions.length).toBeGreaterThanOrEqual(4);
    expect(questions.some((question) => question.includes("여드름성 피부"))).toBe(true);
    expect(run.result.content.sections.faq.length).toBeGreaterThan(0);
  });
});

describe("generatePdpGeo with EXAMPLEDERMA 모이베리어 365 크림 미스트 (ko-KR)", { timeout: LIVE_FIXTURE_TIMEOUT_MS }, () => {
  it("keeps review aggregates and ceramide content metric", async () => {
    const run = await generatePdpGeo(pdpGeoGenerationInputs["examplederma-cream-mist"]);
    const normalized = run.result.diagnostics.normalizedProduct;

    // 정량값: 평점/리뷰 수/리뷰 아이템이 원본 그대로 유지되어야 한다.
    expect(normalized.name).toBe("모이베리어 365 크림 미스트");
    expect(normalized.reviews.rating).toBe(4.9);
    expect(normalized.reviews.reviewCount).toBe(1482);
    expect(normalized.reviews.items.length).toBeGreaterThanOrEqual(3);
    expect(normalized.faq).toHaveLength(4);

    // 세라마이드 10,000ppm 함량은 extractor 목업 클레임과 정규화된 성분/근거 텍스트에 보존되어야 한다.
    const fixtureClaims =
      extractorRunResults["examplederma-cream-mist"].geoProduct.semanticFacts?.metricClaims ?? [];
    expect(fixtureClaims.some((claim) => claim.value === "10000" && claim.unit === "ppm")).toBe(true);
    expect(normalized.ingredients.some((item) => item.includes("10,000ppm"))).toBe(true);
    expect(normalized.sourceTexts.some((text) => text.includes("10,000ppm"))).toBe(true);

    // 피부과 48시간 패치 테스트 정량 클레임은 정규화 이후에도 보존되어야 한다.
    const claims = normalized.semanticFacts?.metricClaims ?? [];
    expect(claims.some((claim) => claim.value === "48" && claim.unit === "시간")).toBe(true);

    expect(run.result.locale).toBe("ko-KR");
    const product = nodeOf(run, "Product");
    expect(product).toBeDefined();

    // 평점/리뷰 수는 JSON-LD AggregateRating으로 반영되어야 한다.
    const serialized = JSON.stringify(run.result.schemaMarkup.jsonLd);
    expect(serialized).toContain("4.9");
    expect(serialized).toContain("1482");
  });

  it("publishes the explicitly numbered 사용법 sequence as an ordered two-step HowTo", async () => {
    const run = await generatePdpGeo(pdpGeoGenerationInputs["examplederma-cream-mist"]);
    const normalized = run.result.diagnostics.normalizedProduct;

    // OCR 사용법 1/2 스텝은 분사(스프레이) 동작이라도 usage로 정규화 이후에도 보존되어야 한다.
    expect(normalized.usage.some((text) => text.includes("미세 분사를 합니다"))).toBe(true);
    expect(normalized.usage.some((text) => text.includes("수시로 뿌려줍니다"))).toBe(true);

    const graph = run.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, unknown>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, unknown> | undefined;
    expect(howTo).toBeDefined();

    // 원문에 명시된 사용법 1/2 순서는 스텝 수와 순서를 그대로 유지해야 한다.
    const steps = howTo?.step as Array<Record<string, unknown>>;
    const stepTexts = steps.map((step) => String(step.text));
    expect(stepTexts.some((text) => text.includes("연약하고 건조해진 피부 부위에 미세 분사를 합니다"))).toBe(true);
    expect(stepTexts.some((text) => text.includes("피부에 건조함이 느껴질 때 수시로 뿌려줍니다"))).toBe(true);
    expect(stepTexts.findIndex((text) => text.includes("미세 분사를 합니다")))
      .toBeLessThan(stepTexts.findIndex((text) => text.includes("수시로 뿌려줍니다")));
    // 스텝 본문에 번호 마커가 그대로 남으면 렌더링 시 이중 번호가 된다.
    expect(stepTexts.every((text) => !/^\d+[.)]/.test(text))).toBe(true);
  });
});

describe("generatePdpGeo via agent-api SubmitGenerationDto contract", { timeout: LIVE_FIXTURE_TIMEOUT_MS }, () => {
  it("anchors JSON-LD ids to canonicalUrl the way agent-api GenerationService does", async () => {
    const payload = agentApiSubmitPayloads["examplederma-capsule-toner"];

    // apps/agent-api GenerationService.generate()와 동일한 호출 형태를 재현한다:
    // source.type은 "manual-json", source.url은 extractSourceUrl(product)의 canonicalUrl.
    const run = await generatePdpGeo({
      product: payload.product,
      source: { type: "manual-json", url: String(payload.product.canonicalUrl) },
      hints: { locale: payload.locale as "ko-KR" }
    });

    expect(run.result.locale).toBe("ko-KR");
    expect(nodeOf(run, "Product")).toBeDefined();

    // canonicalUrl이 있으면 @id가 urn 대신 실제 URL 앵커가 되어야 한다(GEO-128).
    const serialized = JSON.stringify(run.result.schemaMarkup.jsonLd);
    expect(serialized).toContain("shop.example.com");
  });

  it("accepts every payload without validation errors", async () => {
    for (const key of extractorLiveProductKeys) {
      const payload = agentApiSubmitPayloads[key];
      const run = await generatePdpGeo({
        product: payload.product,
        source: { type: "manual-json", url: String(payload.product.canonicalUrl) },
        hints: { locale: payload.locale as "ko-KR" | "en-US" }
      });

      expect(run.result.schemaMarkup.jsonLd["@graph"]).toBeDefined();
      expect(run.result.content.sections.productName.length).toBeGreaterThan(0);
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import { refinePdpGeoCopy } from "../src/copy-refiner";
import { normalizePdpProduct } from "../src/normalize";
import type { PdpGeoReasoningResult } from "../src/types";

const reasoning = {
  mode: "explicit-rag-product-reasoning",
  queryIntents: [], selectedSources: [],
  productEvidence: { benefits: [], effects: [], ingredients: [], usage: [], reviews: [], faq: [], sourceBackedClaims: [] },
  principles: [], decisions: []
} as unknown as PdpGeoReasoningResult;

describe("refinement copy guards", () => {
    it("rejects a stutter and a raw transcription restatement", async () => {
    const { product } = normalizePdpProduct({
      name: "모이베리어 365 크림 미스트", brand: "EXAMPLEDERMA", category: "크림 미스트",
      benefits: ["수분 충전과 동시에 보습막을 형성합니다."],
      ingredients: ["세라마이드 10,000ppm"],
      usage: ["피부에 건조함이 느껴질 때 수시로 뿌려 사용합니다."]
    }, { hints: { locale: "ko-KR" } });
    const withFacts = { ...product, semanticFacts: {
      ingredients: [], benefits: [], effects: [], skinTypes: ["건조 피부"], usageSteps: [],
      safetyTests: ["피부과 테스트", "하이포알러제닉 테스트"], metricClaims: [], evidenceSentences: [],
      ingredientBenefitLinks: [], citations: []
    } } as typeof product;

    const refined = { schemaDescriptions: {
      product: "EXAMPLEDERMA 모이베리어 365 크림 미스트는 건조함이 느껴지는 건조 피부를 위한 크림 미스트입니다. 세라마이드 10,000ppm이 함유돼 있습니다.",
      webPage: "모이베리어 365 크림 미스트 상품 페이지는 휘경보건 피부과에서 2022년 12월 19일부터 22일까지 32명을 대상으로 48시간 패치를 활용해 자극 여부를 확인하는 피부과 테스트를 완료한 정보를 담고 있습니다."
    } };
    const fetchMock = async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(refined) }] }]
    }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn(fetchMock));
    const result = await refinePdpGeoCopy({
      product: withFacts, locale: "ko-KR", market: "KR",
      schemaMarkup: { jsonLd: { "@context": "https://schema.org", "@graph": [
        { "@type": "Product", name: withFacts.name, description: "EXAMPLEDERMA 모이베리어 365 크림 미스트는 건조 피부를 위한 크림 미스트입니다. 세라마이드 10,000ppm이 함유돼 있습니다." },
        { "@type": ["WebPage", "ItemPage"], name: withFacts.name, description: "모이베리어 365 크림 미스트 상품 페이지는 EXAMPLEDERMA가 선보이는 건조 피부 고객을 위한 크림 미스트 정보를 다룹니다." }
      ] } } as never,
      content: { productName: withFacts.name, sections: { productName: withFacts.name, description: "", quickFacts: "", benefits: "", ingredients: "", howToUse: "", faq: "" }, html: "" } as never,
      ragChunks: [], hydratedRagDocuments: [], reasoning, inferredSearchQueries: []
    }, { copyRefinement: { enabled: true, provider: "openai", apiKey: "k", model: "m" } });
    vi.unstubAllGlobals();
      const reasons = result.rejections.map((rejection) => rejection.reason).join(" ");
      // "건조함이 느껴지는 건조 피부" restates its own head; the page sentence
      // republishes a transcription of a fact already typed as a safety test.
      expect(reasons).toMatch(/repeats the same concept/u);
      expect(reasons).toMatch(/raw transcription/u);
      // Neither reaches the graph.
      const published = JSON.stringify(result.schemaMarkup.jsonLd);
      expect(published).not.toContain("휘경보건");
      expect(published).not.toContain("건조함이 느껴지는 건조");
    });
});

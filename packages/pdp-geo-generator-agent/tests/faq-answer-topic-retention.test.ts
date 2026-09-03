import { describe, expect, it, vi } from "vitest";
import { refinePdpGeoCopy } from "../src/copy-refiner";
import { normalizePdpProduct } from "../src/normalize";
import type { PdpGeoReasoningResult } from "../src/types";

const reasoning = {
  mode: "explicit-rag-product-reasoning", queryIntents: [], selectedSources: [],
  productEvidence: { benefits: [], effects: [], ingredients: [], usage: [], reviews: [], faq: [], sourceBackedClaims: [] },
  principles: [], decisions: []
} as unknown as PdpGeoReasoningResult;

/**
 * A FAQ answer that stopped answering its own question.
 *
 * Refinement rewrote the answer to "제형과 사용감은 어떤가요?" from "끈적임이 적은
 * 마무리가 특징입니다" into a description of the emulsion process. Both sentences
 * are true and both are about the product, so every claim-safety and
 * evidence check passed — the question asked what the product feels like and
 * the published answer no longer said.
 */
describe("FAQ answer topic retention", () => {
  it("rejects a rewrite that keeps nothing of what the base answer said", async () => {
  const { product } = normalizePdpProduct({
    name: "모이베리어 365 크림 미스트", brand: "EXAMPLEDERMA", category: "크림 미스트",
    benefits: ["수분 충전과 동시에 보습막을 형성합니다.", "흔들 필요 없이 사용할 수 있습니다."],
    ingredients: ["세라마이드 10,000ppm"],
    sourceTexts: ["작게 쪼개진 세라마이드와 수분을 묶은 특수 에멀젼 공법으로, 흔들 필요 없이 사용할 수 있다고 안내합니다."],
    reviews: { rating: 4.8, reviewCount: 100, items: [
      { body: "뿌린 후에는 피부가 촉촉하고 편안해지며, 끈적임 없이 산뜻하게 흡수됩니다. 미세하게 분사되어 좋아요.", rating: 5 }
    ], keywords: ["촉촉", "산뜻", "흡수"] }
  }, { hints: { locale: "ko-KR" } });

  const question = "모이베리어 365 크림 미스트의 제형과 사용감은 어떤가요?";
  const baseAnswer = "모이베리어 365 크림 미스트는 끈적임이 적은 마무리가 특징입니다.";
  const driftedAnswer = "모이베리어 365 크림 미스트는 작게 쪼개진 세라마이드와 수분을 묶은 특수 에멀젼 공법을 적용해 흔들 필요 없이 사용할 수 있는 크림 미스트입니다.";

  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    output: [{ content: [{ type: "output_text", text: JSON.stringify({ faqAnswers: [{ question, answer: driftedAnswer }] }) }] }]
  }), { status: 200 })));
  const result = await refinePdpGeoCopy({
    product, locale: "ko-KR", market: "KR",
    schemaMarkup: { jsonLd: { "@context": "https://schema.org", "@graph": [
      { "@type": "Product", name: product.name, description: "설명" },
      { "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: question, acceptedAnswer: { "@type": "Answer", text: baseAnswer } }] }
    ] } } as never,
    content: { productName: product.name, sections: { productName: product.name, description: "", quickFacts: "", benefits: "", ingredients: "", howToUse: "", faq: "" }, html: "" } as never,
    ragChunks: [], hydratedRagDocuments: [], reasoning, inferredSearchQueries: []
  }, { copyRefinement: { enabled: true, provider: "openai", apiKey: "k", model: "m" } });
  vi.unstubAllGlobals();

  const graph = (result.schemaMarkup.jsonLd as { "@graph": Array<Record<string, unknown>> })["@graph"];
  const faq = graph.find((node) => node["@type"] === "FAQPage") as { mainEntity: Array<{ acceptedAnswer: { text: string } }> } | undefined;
    expect(result.rejections.map((rejection) => rejection.reason).join(" "))
      .toMatch(/no longer covers the topic/u);
    // The texture answer the question was matched to is what stays published.
    expect(faq?.mainEntity?.[0]?.acceptedAnswer?.text).toBe(baseAnswer);
  });
});

import { describe, expect, it, vi } from "vitest";
import { planPdpGeoContent } from "../src/content-planner";
import { normalizePdpProduct } from "../src/normalize";
import { planningRequest, planPayload } from "./support/planning";

/**
 * A FAQ question must name the exact product — the FAQ contract forbids a
 * deictic subject such as "이 제품". The entailment gate then compared the
 * question's semantic concepts against the cited evidence and required every
 * one to appear there, including the concept the product name itself carries.
 *
 * On the EXAMPLEDERMA 모이베리어365 크림 run that rejected a fully supported question:
 * "크림" contributed the concept `cream`, the cited safety-test atoms contribute
 * `sensitive` and `acne`, and no safety-test atom says "크림". The question was
 * dropped for obeying the contract that required the product name in it.
 */
function productWithSafetyTests() {
  const base = normalizePdpProduct({
    name: "모이베리어365 크림",
    brand: "EXAMPLEDERMA",
    category: "크림",
    benefits: ["피부장벽 강화"],
    ingredients: ["고밀도 세라마이드 캡슐"]
  }, { hints: { locale: "ko-KR" } }).product;
  return {
    ...base,
    semanticFacts: {
      ingredients: [],
      benefits: [],
      effects: [],
      skinTypes: [],
      usageSteps: [],
      safetyTests: ["민감 피부 자극 테스트 완료", "피부과 테스트 완료", "여드름성 피부 사용 적합 테스트 완료"],
      metricClaims: [],
      evidenceSentences: [],
      ingredientBenefitLinks: [],
      citations: []
    }
  } as typeof base;
}

async function planFaq(question: string, answer: string, pickIds: (request: ReturnType<typeof planningRequest>) => string[]) {
  const request = planningRequest(productWithSafetyTests(), "ko-KR");
  const plan = planPayload({
    faq: [{
      include: true,
      question,
      answer,
      intent: "safety-test-scope",
      cep: "",
      evidenceIds: pickIds(request),
      confidence: 0.9,
      omitReason: ""
    }]
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    output: [{ content: [{ type: "output_text", text: JSON.stringify(plan) }] }]
  }), { status: 200 })));
  try {
    return await planPdpGeoContent(request, {
      contentPlanning: { enabled: true, provider: "openai", apiKey: "key", model: "gpt-test" }
    });
  } finally {
    vi.unstubAllGlobals();
  }
}

const safetyIds = (request: ReturnType<typeof planningRequest>) =>
  request.evidenceLedger.filter((item) => /safetyTests/u.test(item.sourcePath)).map((item) => item.id);

describe("FAQ question entailment", () => {
  it("keeps a supported question that names the product", async () => {
    const result = await planFaq(
      "모이베리어365 크림은 어떤 피부 안전성 테스트를 완료했나요?",
      "모이베리어365 크림은 민감 피부 자극 테스트, 피부과 테스트, 여드름성 피부 사용 적합 테스트를 완료한 것으로 표기되어 있습니다.",
      safetyIds
    );

    expect(result.plan.faq).toHaveLength(1);
    expect(result.plan.warnings.join(" ")).not.toMatch(/question-entailment/);
  });

  it("still rejects a question the cited evidence cannot answer", async () => {
    // Identity is excluded from the comparison; a real unsupported concept is
    // not. Nothing in the safety-test atoms speaks to wrinkles.
    const result = await planFaq(
      "모이베리어365 크림은 주름 개선 시험을 완료했나요?",
      "모이베리어365 크림은 민감 피부 자극 테스트를 완료한 것으로 표기되어 있습니다.",
      safetyIds
    );

    expect(result.plan.faq).toHaveLength(0);
    expect(result.plan.warnings.join(" ")).toMatch(/question-entailment/);
  });
});

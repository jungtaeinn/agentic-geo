import { describe, expect, it } from "vitest";
import { isVolumeOrLabelOnlyReviewText, refinePdpGeoCopy } from "../src/copy-refiner";
import type {
  PdpGeoCopyRefinementRequest,
  PdpGeoCopyRefinementResult,
  PdpGeoGeneratorOptions
} from "../src/types";

function createRefinementRequest(
  overrides: {
    productDescription?: string;
    webPageDescription?: string;
    faq?: Array<{ question: string; answer: string }>;
    locale?: PdpGeoCopyRefinementRequest["locale"];
    market?: string;
    targetCustomer?: string;
    /** `product.description` — the evidence corpus the acceptance gates read, not the published copy. */
    sourceDescription?: string;
  } = {}
): PdpGeoCopyRefinementRequest {
  const productDescription = overrides.productDescription
    ?? "모이베리어365 캡슐 토너는 건조하고 민감한 피부를 위한 장벽보습 캡슐 토너입니다.";
  const webPageDescription = overrides.webPageDescription
    ?? "모이베리어365 캡슐 토너 상품 페이지는 민감 피부 고객을 위한 장벽보습 정보를 소개합니다.";
  const faq = overrides.faq ?? [
    {
      question: "모이베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
      answer: "모이베리어365 캡슐 토너의 캡슐은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐입니다."
    },
    {
      question: "예시더마 모이베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?",
      answer: "예시더마 모이베리어365 캡슐 토너는 건조하고 민감한 피부 고객에게 적합한 장벽보습 캡슐 토너입니다."
    },
    {
      question: "예시더마 모이베리어365 캡슐 토너의 주요 성분과 효능은 무엇인가요?",
      answer: "예시더마 모이베리어365 캡슐 토너는 PHA와 고밀도 세라마이드 캡슐을 담은 장벽보습 캡슐 토너입니다."
    }
  ];

  return {
    locale: overrides.locale ?? "ko-KR",
    market: overrides.market ?? "KR",
    product: {
      name: "예시더마 모이베리어365 캡슐 토너",
      brand: "EXAMPLEDERMA",
      description: overrides.sourceDescription ?? "세안 후 약해진 피부장벽을 강화하고 피부결을 정돈하는 장벽보습 캡슐 토너",
      images: [],
      options: [],
      benefits: ["장벽 보습", "수분감", "피부결 정돈"],
      effects: ["세정에 의한 장벽 손상은 사용 직후 93% 회복되었다."],
      ingredients: ["PHA", "고밀도 세라마이드 캡슐", "세라마이드 NP"],
      usage: ["캡슐을 부드럽게 녹이듯 골고루 펴 바른 후 가볍게 두드려 흡수시켜 줍니다."],
      metrics: ["세정에 의한 장벽 손상 93% 즉시 회복", "사용 직후 수분량 1.3배 증가"],
      faq,
      reviews: {
        keywords: ["장벽 보습", "촉촉한 사용감"],
        items: [{ body: "10.14 fl. oz. / 300 mL" }]
      },
      breadcrumbs: [],
      sourceTexts: [
        "세정에 의한 장벽 손상은 사용 직후 93% 즉시 회복.",
        "사용 직후 수분량 1.3배 증가.",
        "고밀도 세라마이드 캡슐이 장벽 보습을 돕는다.",
        "동일한 고밀도 세라마이드 캡슐이 모이베리어365 크림과 캡슐 토너에 사용된다."
      ]
    },
    schemaMarkup: {
      jsonLd: {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebPage", description: webPageDescription },
          {
            "@type": "Product",
            description: productDescription,
            additionalProperty: [
              { "@type": "PropertyValue", name: "Reported details", value: "세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다." },
              { "@type": "PropertyValue", name: "Target customer", value: overrides.targetCustomer ?? "장벽 보습이 필요한 고객" },
              { "@type": "PropertyValue", name: "Key ingredients and technologies", value: "PHA, 고밀도 세라마이드 캡슐, 세라마이드 NP" }
            ]
          },
          {
            "@type": "FAQPage",
            mainEntity: faq.map((item) => ({
              "@type": "Question",
              name: item.question,
              acceptedAnswer: { "@type": "Answer", text: item.answer }
            }))
          }
        ]
      },
      scriptTag: ""
    },
    content: {
      sections: {
        productName: "예시더마 모이베리어365 캡슐 토너",
        description: productDescription,
        quickFacts: "용량: 10.14 fl. oz. / 300 mL",
        benefits: "",
        ingredients: "",
        howToUse: "",
        faq: faq.map((item) => `Q. ${item.question}\nA. ${item.answer}`).join("\n\n")
      },
      html: ""
    },
    ragChunks: []
  };
}

function createOptions(refineCopy: (request: PdpGeoCopyRefinementRequest) => PdpGeoCopyRefinementResult | Promise<PdpGeoCopyRefinementResult>): PdpGeoGeneratorOptions {
  return { customCopyRefiner: { refineCopy } };
}

describe("copy refinement description gates", () => {
  it("rejects refined descriptions that expose analysis labels", async () => {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaDescriptions: {
        product: "예시더마 모이베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다."
      }
    })));

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(product.description).not.toContain("평가 지표:");
    expect(result.warnings.some((warning) => warning.includes("Product.description") && warning.includes("analysis label"))).toBe(true);
  });

  it("rejects refined descriptions that enumerate raw volume strings", async () => {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaDescriptions: {
        webPage: "모이베리어365 캡슐 토너 상품 페이지는 장벽 보습 맥락과 촉촉한 사용감 중심의 리뷰 맥락, 10.14 fl. oz. / 300 mL 용량을 함께 살펴볼 수 있습니다."
      }
    })));

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    expect(webPage.description).not.toContain("fl. oz.");
    expect(result.warnings.some((warning) => warning.includes("WebPage.description") && warning.includes("volume"))).toBe(true);
  });
});

describe("schema property refinements keep the value's form", () => {
  /**
   * 2026-09-02 예시더마 1145 실측: 정제 패스가 `Target customer`를
   * "건조 피부 또는 민감 피부 고객"에서 "건조하거나 민감한 피부를 위한
   * 클렌저입니다."로 바꿔 발행했다. 속성 슬롯에 문장이 들어갔고, 그 값이
   * 속성 이름이 묻는 대상(고객)이 아니라 제품을 설명한다.
   */
  async function refineTargetCustomer(value: string): Promise<{ published: string; warnings: string[] }> {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaProperties: { "Target customer": value }
    })));
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const properties = product.additionalProperty as Array<Record<string, string>>;
    return {
      published: String(properties.find((entry) => entry.name === "Target customer")?.value ?? ""),
      warnings: result.warnings
    };
  }

  it("rejects a refinement that turns a noun-phrase property into a sentence", async () => {
    const { published, warnings } = await refineTargetCustomer("장벽 보습을 돕는 캡슐 토너입니다.");

    expect(published).toBe("장벽 보습이 필요한 고객");
    expect(warnings.some((warning) => warning.includes("Target customer") && warning.includes("attribute value"))).toBe(true);
  });

  it("rejects a refinement that changes what the value describes", async () => {
    const { published, warnings } = await refineTargetCustomer("장벽 보습을 돕는 캡슐 토너");

    expect(published).toBe("장벽 보습이 필요한 고객");
    expect(warnings.some((warning) => warning.includes("Target customer") && warning.includes("what the value describes"))).toBe(true);
  });

  it("accepts a rewording that keeps the noun phrase and its head", async () => {
    const { published } = await refineTargetCustomer("세안 후 장벽 보습을 고려하는 고객");

    expect(published).toBe("세안 후 장벽 보습을 고려하는 고객");
  });

  it("still allows a sentence-shaped property to be refined as a sentence", async () => {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaProperties: { "Reported details": "인체적용시험에서 세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다." }
    })));
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const properties = product.additionalProperty as Array<Record<string, string>>;

    expect(String(properties.find((entry) => entry.name === "Reported details")?.value ?? "")).toContain("인체적용시험");
  });
});

describe("corrective refinement pass", () => {
  it("rewrites editorial caveat narration as a direct customer-facing FAQ ending", async () => {
    const question = "예시더마 모이베리어365 캡슐 토너의 쿨링 결과에는 개인 차가 있나요?";
    const directAnswer = "예시더마 모이베리어365 캡슐 토너는 사용 직후 시원한 쿨링감을 줄 수 있으며, 해당 쿨링 결과에는 개인 차가 있을 수 있습니다.";
    const request = createRefinementRequest({
      faq: [{ question, answer: directAnswer }]
    });
    request.product.effects.push("사용 직후 시원한 쿨링감을 줄 수 있습니다.");
    request.product.sourceTexts.push("사용 직후 시원한 쿨링감을 줄 수 있으며, 해당 쿨링 결과에는 개인 차가 있을 수 있습니다.");
    const calls: PdpGeoCopyRefinementRequest[] = [];

    const result = await refinePdpGeoCopy(request, createOptions((incoming) => {
      calls.push(incoming);
      return {
        faqAnswers: [{
          sourceQuestion: question,
          question,
          answer: calls.length === 1
            ? "예시더마 모이베리어365 캡슐 토너는 사용 직후 시원한 쿨링감을 줄 수 있으며, 해당 쿨링 결과에는 개인 차가 있을 수 있다는 단서가 붙습니다."
            : directAnswer
        }]
      };
    }));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.refinementFeedback?.some((item) =>
      item.field.includes("acceptedAnswer") && item.reason.includes("broken Korean sentence fragment")
    )).toBe(true);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const faqPage = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const answer = String((faqPage.mainEntity as Array<Record<string, any>>)[0]!.acceptedAnswer.text);
    expect(answer).toBe(directAnswer);
    expect(answer).not.toContain("단서가 붙습니다");
  });

  it("retries Korean Product descriptions that retain OCR, predicate, test-note, or passive-review artifacts", async () => {
    const request = createRefinementRequest();
    request.product.reviews.items = [{ body: "촉촉하고 편안한 사용감이 만족스러웠습니다." }];
    const badDescription = "예시더마 모이베리어365 캡슐 토너는 민감 피부용 토너입니다. 주요 성분은 PHA이며, 하는 기술이 적용되어 있고 ☑ 장벽 지표 93% ※ 시험 결과입니다. 완료된 테스트는 참고할 수 있는 시험 정보입니다. 실제 고객 리뷰에서는 촉촉한 사용감이 언급됩니다.";
    const cleanDescription = "예시더마 모이베리어365 캡슐 토너는 건조하고 민감한 피부 고객을 위한 장벽보습 캡슐 토너로, 고밀도 세라마이드 캡슐이 장벽 보습을 돕고 세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다.";
    const calls: PdpGeoCopyRefinementRequest[] = [];

    const result = await refinePdpGeoCopy(request, createOptions((incoming) => {
      calls.push(incoming);
      return calls.length === 1
        ? { schemaDescriptions: { product: badDescription } }
        : { schemaDescriptions: { product: cleanDescription } };
    }));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.refinementFeedback?.some((item) =>
      item.field === "Product.description" && item.reason.includes("broken Korean sentence fragment")
    )).toBe(true);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(product.description).toBe(cleanDescription);
  });

  it("retries rejected description refinement once with structured feedback", async () => {
    const request = createRefinementRequest();
    const cleanDescription = "예시더마 모이베리어365 캡슐 토너는 건조하고 민감한 피부 고객을 위한 장벽보습 캡슐 토너로, 고밀도 세라마이드 캡슐이 장벽 보습을 돕고 세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다.";
    const calls: PdpGeoCopyRefinementRequest[] = [];

    const result = await refinePdpGeoCopy(request, createOptions((incoming) => {
      calls.push(incoming);
      if (calls.length === 1) {
        return {
          schemaDescriptions: {
            product: "예시더마 모이베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다."
          },
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
        };
      }
      return {
        schemaDescriptions: { product: cleanDescription },
        usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 }
      };
    }));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.refinementFeedback?.some((item) =>
      item.field === "Product.description" && item.reason.includes("analysis label")
    )).toBe(true);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(product.description).toBe(cleanDescription);
    expect(result.usage?.totalTokens).toBe(210);
  });

  it("triggers the corrective pass when unrefined fallback copy keeps analysis labels", async () => {
    const request = createRefinementRequest({
      productDescription: "예시더마 모이베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다."
    });
    const cleanDescription = "예시더마 모이베리어365 캡슐 토너는 건조하고 민감한 피부 고객을 위한 장벽보습 캡슐 토너로, 세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다.";
    const calls: PdpGeoCopyRefinementRequest[] = [];

    const result = await refinePdpGeoCopy(request, createOptions((incoming) => {
      calls.push(incoming);
      if (calls.length === 1) {
        return {};
      }
      return { schemaDescriptions: { product: cleanDescription } };
    }));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.refinementFeedback?.some((item) => item.field === "Product.description")).toBe(true);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(product.description).toBe(cleanDescription);
  });

  it("falls back with a warning when the corrective pass also fails", async () => {
    const badDescription = "예시더마 모이베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다.";
    const request = createRefinementRequest();
    let callCount = 0;

    const result = await refinePdpGeoCopy(request, createOptions(() => {
      callCount += 1;
      return { schemaDescriptions: { product: badDescription } };
    }));

    expect(callCount).toBe(2);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(product.description).toBe(request.content.sections.description);
    expect(result.warnings.some((warning) => warning.includes("corrective refinement pass"))).toBe(true);
  });

  it("keeps fallback copy and records a warning when the corrective pass provider throws", async () => {
    const request = createRefinementRequest();
    let callCount = 0;

    const result = await refinePdpGeoCopy(request, createOptions(() => {
      callCount += 1;
      if (callCount === 1) {
        return {
          schemaDescriptions: {
            product: "예시더마 모이베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다."
          }
        };
      }
      throw new Error("corrective provider unavailable");
    }));

    expect(callCount).toBe(2);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(product.description).toBe(request.content.sections.description);
    expect(result.warnings.some((warning) => warning.includes("Corrective refinement pass skipped"))).toBe(true);
  });

  it("does not reorder FAQ items when the corrective pass returns only a partial faqAnswers list", async () => {
    const request = createRefinementRequest();
    const cleanDescription = "예시더마 모이베리어365 캡슐 토너는 건조하고 민감한 피부 고객을 위한 장벽보습 캡슐 토너로, 고밀도 세라마이드 캡슐이 장벽 보습을 돕고 세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다.";
    const calls: PdpGeoCopyRefinementRequest[] = [];

    const result = await refinePdpGeoCopy(request, createOptions((incoming) => {
      calls.push(incoming);
      if (calls.length === 1) {
        return {
          schemaDescriptions: {
            product: "예시더마 모이베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다."
          },
          faqAnswers: [
            {
              sourceQuestion: "예시더마 모이베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?",
              question: "민감하고 건조한 피부에는 어떤 토너를 추천하나요?",
              answer: "예시더마 모이베리어365 캡슐 토너는 건조하고 민감한 피부 고객에게 추천할 수 있는 장벽보습 캡슐 토너로, 고밀도 세라마이드 캡슐이 장벽 보습을 돕습니다."
            },
            {
              sourceQuestion: "예시더마 모이베리어365 캡슐 토너의 주요 성분과 효능은 무엇인가요?",
              question: "예시더마 모이베리어365 캡슐 토너의 주요 성분과 효능은 무엇인가요?",
              answer: "예시더마 모이베리어365 캡슐 토너는 PHA와 고밀도 세라마이드 캡슐을 담은 장벽보습 캡슐 토너로, 장벽 보습과 피부결 정돈을 돕습니다."
            },
            {
              sourceQuestion: "모이베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
              question: "모이베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
              answer: "네, 동일한 고밀도 세라마이드 캡슐입니다. 모이베리어365 크림과 캡슐 토너에 같은 고밀도 세라마이드 캡슐이 사용됩니다."
            }
          ]
        };
      }
      return {
        schemaDescriptions: { product: cleanDescription },
        faqAnswers: [
          {
            sourceQuestion: "예시더마 모이베리어365 캡슐 토너의 주요 성분과 효능은 무엇인가요?",
            question: "예시더마 모이베리어365 캡슐 토너에는 어떤 성분이 들어 있나요?",
            answer: "예시더마 모이베리어365 캡슐 토너에는 PHA와 고밀도 세라마이드 캡슐이 담겨 있으며, 장벽 보습과 피부결 정돈에 도움을 줍니다."
          }
        ]
      };
    }));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.refinementFeedback?.length ?? 0).toBeGreaterThan(0);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const faqPage = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const mainEntity = faqPage.mainEntity as Array<Record<string, any>>;

    expect(mainEntity[0]!.name).toBe("예시더마 모이베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?");
    expect(mainEntity[1]!.name).toBe("예시더마 모이베리어365 캡슐 토너에는 어떤 성분이 들어 있나요?");
    expect(mainEntity[1]!.acceptedAnswer.text).toBe(
      "예시더마 모이베리어365 캡슐 토너에는 PHA와 고밀도 세라마이드 캡슐이 담겨 있으며, 장벽 보습과 피부결 정돈에 도움을 줍니다."
    );
    expect(mainEntity[2]!.name).toBe("모이베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?");
  });

  it("omits hydratedRagDocuments from the corrective retry payload", async () => {
    const request = createRefinementRequest();
    request.hydratedRagDocuments = [
      {
        source: "brand-identity.md",
        kind: "geo-research",
        hydrationMode: "controlled-full-document",
        selectedChunkTitles: ["Intro"],
        content: "Full brand identity document content kept as controlled background context only."
      }
    ];
    const cleanDescription = "예시더마 모이베리어365 캡슐 토너는 건조하고 민감한 피부 고객을 위한 장벽보습 캡슐 토너로, 고밀도 세라마이드 캡슐이 장벽 보습을 돕고 세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다.";
    const calls: PdpGeoCopyRefinementRequest[] = [];

    await refinePdpGeoCopy(request, createOptions((incoming) => {
      calls.push(incoming);
      if (calls.length === 1) {
        return {
          schemaDescriptions: {
            product: "예시더마 모이베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다."
          }
        };
      }
      return { schemaDescriptions: { product: cleanDescription } };
    }));

    expect(calls).toHaveLength(2);
    expect(calls[0]!.hydratedRagDocuments).toBeDefined();
    expect(calls[1]!.hydratedRagDocuments).toBeUndefined();
  });

  it("includes warnings emitted by the corrective refinement pass in the final result", async () => {
    const request = createRefinementRequest();
    const cleanDescription = "예시더마 모이베리어365 캡슐 토너는 건조하고 민감한 피부 고객을 위한 장벽보습 캡슐 토너로, 고밀도 세라마이드 캡슐이 장벽 보습을 돕고 세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다.";
    let callCount = 0;

    const result = await refinePdpGeoCopy(request, createOptions(() => {
      callCount += 1;
      if (callCount === 1) {
        return {
          schemaDescriptions: {
            product: "예시더마 모이베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다."
          }
        };
      }
      return {
        schemaDescriptions: { product: cleanDescription },
        warnings: ["Corrective pass model self-reported limited evidence coverage."]
      };
    }));

    expect(callCount).toBe(2);
    expect(result.warnings).toContain("Corrective pass model self-reported limited evidence coverage.");
  });
});

describe("FAQ generative-intent recomposition", () => {
  it("reorders FAQ, rewrites questions, and applies yes-leading comparison answers", async () => {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      faqAnswers: [
        {
          sourceQuestion: "예시더마 모이베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?",
          question: "민감하고 건조한 피부에는 어떤 토너를 추천하나요?",
          answer: "예시더마 모이베리어365 캡슐 토너는 건조하고 민감한 피부 고객에게 추천할 수 있는 장벽보습 캡슐 토너로, 고밀도 세라마이드 캡슐이 장벽 보습을 돕습니다."
        },
        {
          sourceQuestion: "예시더마 모이베리어365 캡슐 토너의 주요 성분과 효능은 무엇인가요?",
          question: "예시더마 모이베리어365 캡슐 토너에는 어떤 성분이 들어 있나요?",
          answer: "예시더마 모이베리어365 캡슐 토너는 PHA와 고밀도 세라마이드 캡슐을 담은 장벽보습 캡슐 토너로, 장벽 보습과 피부결 정돈을 돕습니다."
        },
        {
          sourceQuestion: "모이베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
          question: "모이베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
          answer: "네, 동일한 고밀도 세라마이드 캡슐입니다. 모이베리어365 크림과 캡슐 토너에 같은 고밀도 세라마이드 캡슐이 사용됩니다."
        }
      ]
    })));

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const faqPage = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const mainEntity = faqPage.mainEntity as Array<Record<string, any>>;

    expect(mainEntity[0]!.name).toBe("예시더마 모이베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?");
    expect(mainEntity[2]!.name).toBe("모이베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?");
    expect(mainEntity[2]!.acceptedAnswer.text.startsWith("네,")).toBe(true);
    expect(result.content.sections.faq.indexOf("예시더마 모이베리어365 캡슐 토너는 어떤 고객에게")).toBeLessThan(
      result.content.sections.faq.indexOf("동일한 캡슐인가요?")
    );
    expect(result.warnings.some((warning) => warning.includes("question is no longer specific to this product or brand"))).toBe(true);
  });

  it("drops FAQ items without a matching sourceQuestion and preserves unlisted existing items", async () => {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      faqAnswers: [
        {
          sourceQuestion: "이 제품은 어디에서 구매할 수 있나요?",
          question: "이 제품은 어디에서 구매할 수 있나요?",
          answer: "구매처 정보는 공식몰에서 확인할 수 있습니다."
        },
        {
          sourceQuestion: "예시더마 모이베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?",
          question: "민감하고 건조한 피부에는 어떤 토너를 추천하나요?",
          answer: "예시더마 모이베리어365 캡슐 토너는 건조하고 민감한 피부 고객에게 추천할 수 있는 장벽보습 캡슐 토너입니다."
        }
      ]
    })));

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const faqPage = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const mainEntity = faqPage.mainEntity as Array<Record<string, any>>;

    expect(mainEntity).toHaveLength(3);
    expect(mainEntity[0]!.name).toBe("예시더마 모이베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?");
    expect(mainEntity.some((item) => String(item.name).includes("구매"))).toBe(false);
    expect(mainEntity.some((item) => String(item.name).includes("동일한 캡슐"))).toBe(true);
    expect(mainEntity.some((item) => String(item.name).includes("주요 성분과 효능"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("does not match an existing FAQ question"))).toBe(true);
  });
});

describe("approved copy contract preservation", () => {
  it("retains the approved Product.description when refinement drops an existing core role", async () => {
    const baseDescription = [
      "예시더마 모이베리어365 캡슐 토너는 장벽보습 캡슐 토너입니다.",
      "건조하고 민감한 피부 고객에게 적합합니다.",
      "PHA와 고밀도 세라마이드 캡슐을 함유합니다.",
      "제품은 장벽 보습과 피부결 정돈에 도움을 줍니다.",
      "고객 리뷰에서 고객들은 촉촉한 사용감을 긍정적으로 평가했습니다."
    ].join(" ");
    const request = createRefinementRequest({ productDescription: baseDescription });
    const droppedIngredient = [
      "예시더마 모이베리어365 캡슐 토너는 장벽보습 캡슐 토너입니다.",
      "건조하고 민감한 피부 고객에게 적합합니다.",
      "제품은 장벽 보습과 피부결 정돈에 도움을 줍니다.",
      "고객 리뷰에서 고객들은 촉촉한 사용감을 긍정적으로 평가했습니다."
    ].join(" ");

    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaDescriptions: { product: droppedIngredient }
    })));

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(product.description).toBe(baseDescription);
    expect(result.warnings.some((warning) => warning.includes("ingredient/formula role"))).toBe(true);
  });

  it("keeps an attributed review last when that role exists in the approved Product.description", async () => {
    const baseDescription = [
      "예시더마 모이베리어365 캡슐 토너는 장벽보습 캡슐 토너입니다.",
      "건조하고 민감한 피부 고객에게 적합합니다.",
      "고밀도 세라마이드 캡슐을 함유합니다.",
      "제품은 장벽 보습에 도움을 줍니다.",
      "고객 리뷰에서 고객들은 촉촉한 사용감을 긍정적으로 평가했습니다."
    ].join(" ");
    const request = createRefinementRequest({ productDescription: baseDescription });
    const reviewBeforeBenefit = [
      "예시더마 모이베리어365 캡슐 토너는 장벽보습 캡슐 토너입니다.",
      "건조하고 민감한 피부 고객에게 적합합니다.",
      "고밀도 세라마이드 캡슐을 함유합니다.",
      "고객 리뷰에서 고객들은 촉촉한 사용감을 긍정적으로 평가했습니다.",
      "제품은 장벽 보습에 도움을 줍니다."
    ].join(" ");

    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaDescriptions: { product: reviewBeforeBenefit }
    })));

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(product.description).toBe(baseDescription);
    expect(result.warnings.some((warning) => warning.includes("attributed review role") || warning.includes("final Product.description role"))).toBe(true);
  });

  it("rejects a newly invented ingredient-to-benefit causal relation", async () => {
    const request = createRefinementRequest();
    const unsupportedRelation = [
      "예시더마 모이베리어365 캡슐 토너는 장벽보습 캡슐 토너입니다.",
      "건조하고 민감한 피부를 위한 제품입니다.",
      "PHA가 피부 장벽 보습과 피부결 개선을 돕습니다."
    ].join(" ");

    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaDescriptions: { product: unsupportedRelation }
    })));

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(product.description).toBe(request.content.sections.description);
    expect(result.warnings.some((warning) => warning.includes("unsupported causal ingredient-to-benefit relation") && warning.includes("PHA"))).toBe(true);
  });

  it("accepts a page-scoped WebPage refinement that connects supported buyer-decision facts", async () => {
    const productDescription = [
      "예시더마 모이베리어365 캡슐 토너는 장벽보습 캡슐 토너입니다.",
      "건조하고 민감한 피부 고객에게 적합합니다.",
      "PHA와 고밀도 세라마이드 캡슐을 함유합니다.",
      "제품은 장벽 보습과 피부결 정돈에 도움을 줍니다.",
      "고객 리뷰에서 고객들은 촉촉한 사용감을 긍정적으로 평가했습니다."
    ].join(" ");
    const webPageDescription = "EXAMPLEDERMA의 예시더마 모이베리어365 캡슐 토너 상품 페이지는 상품 정보와 브랜드 정보, 사용법 및 FAQ를 제공합니다.";
    const request = createRefinementRequest({ productDescription, webPageDescription });
    const productClone = [
      "EXAMPLEDERMA의 예시더마 모이베리어365 캡슐 토너 상품 페이지는 건조하고 민감한 피부 고객을 위한 장벽보습 토너를 소개합니다.",
      "PHA와 고밀도 세라마이드 캡슐을 함유하고 장벽 보습과 피부결 정돈에 도움을 주며, 고객 리뷰에서 고객들은 촉촉한 사용감을 긍정적으로 평가했습니다."
    ].join(" ");

    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaDescriptions: { webPage: productClone }
    })));

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    expect(webPage.description).toBe(productClone);
    expect(result.warnings.some((warning) => warning.includes("detailed Product") || warning.includes("detailed Product target"))).toBe(false);
  });

  it("retains a product-specific FAQ answer when refinement becomes generic", async () => {
    const request = createRefinementRequest();
    const sourceQuestion = "예시더마 모이베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?";
    const genericAnswer = "건조하고 민감한 피부 고객에게 장벽 보습과 피부결 정돈을 제공하는 데일리 토너를 추천할 수 있습니다.";

    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      faqAnswers: [{
        sourceQuestion,
        question: "건조하고 민감한 피부에는 어떤 토너를 추천하나요?",
        answer: genericAnswer
      }]
    })));

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const faqPage = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const targetFaq = (faqPage.mainEntity as Array<Record<string, any>>).find((item) =>
      String(item.acceptedAnswer?.text ?? "").includes("건조하고 민감한 피부 고객에게 적합한 장벽보습 캡슐 토너"));
    expect(targetFaq?.acceptedAnswer.text).toContain("예시더마 모이베리어365 캡슐 토너");
    expect(targetFaq?.acceptedAnswer.text).not.toBe(genericAnswer);
    expect(result.warnings.some((warning) => warning.includes("answer is no longer product-specific"))).toBe(true);
  });

  it("rejects unverifiable free-form FAQ section rewrites", async () => {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      contentSections: {
        faq: "Q. 어떤 화장품이 모든 피부 문제를 해결하나요? A. 이 토너는 누구에게나 확실한 효과를 제공합니다."
      }
    })));

    expect(result.content.sections.faq).toBe(request.content.sections.faq);
    expect(result.warnings.some((warning) => warning.includes("free-form FAQ section copy cannot be verified"))).toBe(true);
  });
});

describe("isVolumeOrLabelOnlyReviewText", () => {
  it("does not classify real ultra-short reviews with no digits as volume/label-only", () => {
    expect(isVolumeOrLabelOnlyReviewText("좋아요")).toBe(false);
    expect(isVolumeOrLabelOnlyReviewText("촉촉함")).toBe(false);
    expect(isVolumeOrLabelOnlyReviewText("만족")).toBe(false);
  });

  it("still classifies digit/unit-only label strings as volume/label-only", () => {
    expect(isVolumeOrLabelOnlyReviewText("300정")).toBe(true);
    expect(isVolumeOrLabelOnlyReviewText("10.14 fl. oz. / 300 mL")).toBe(true);
  });
});

describe("analysis-label shell in a refined property value", () => {
  /**
   * 2026-09-02 예시더마 1145 재실측: 생성기는 더 이상 "측정/평가 결과는 …입니다"
   * 껍데기를 만들지 않지만, 정제 패스가 같은 원문 근거를 읽고 그 껍데기를
   * `Reported details`에 다시 써 넣었다. 기존 라벨 게이트는 콜론 형태
   * ("평가 지표: …")만 보고 조사 형태("측정/평가 결과는 …")를 놓쳤고,
   * description 필드에만 적용돼 속성값에는 닿지 않았다.
   */
  async function refineReportedDetails(value: string): Promise<{ published: string; warnings: string[] }> {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaProperties: { "Reported details": value }
    })));
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const properties = product.additionalProperty as Array<Record<string, string>>;
    return {
      published: String(properties.find((entry) => entry.name === "Reported details")?.value ?? ""),
      warnings: result.warnings
    };
  }

  it("rejects the label shell attached by a topic particle", async () => {
    const { published, warnings } = await refineReportedDetails(
      "측정/평가 결과는 세정에 의한 장벽 손상 93% 즉시 회복, 사용 직후 수분량 1.3배 증가입니다."
    );

    expect(published).toBe("세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다.");
    expect(warnings.some((warning) => warning.includes("Reported details") && warning.includes("analysis label"))).toBe(true);
  });

  it("rejects the label shell attached by a colon", async () => {
    const { published } = await refineReportedDetails("평가 지표: 세정에 의한 장벽 손상 93% 즉시 회복.");

    expect(published).toBe("세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다.");
  });

  it("still accepts the same measurement written as a natural sentence", async () => {
    const { published } = await refineReportedDetails(
      "인체적용시험에서 세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다."
    );

    expect(published).toBe("인체적용시험에서 세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다.");
  });
});

describe("head preservation does not apply to coordinate lists", () => {
  /**
   * 머리어 비교는 핵후치 수식을 전제한다 — 마지막 낱말이 그 구가 무엇에 대한
   * 것인지를 정한다는 전제다. 목록은 그 전제를 깨뜨린다: 항목들이 대등하므로
   * 단일 머리어가 없고, 순서를 바꾸면 사실은 그대로인데 마지막 낱말만 달라진다.
   */
  async function refineIngredientList(value: string): Promise<string> {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaProperties: { "Key ingredients and technologies": value }
    })));
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const properties = product.additionalProperty as Array<Record<string, string>>;
    return String(properties.find((entry) => entry.name === "Key ingredients and technologies")?.value ?? "");
  }

  it("accepts a reordered list even though its last item changed", async () => {
    expect(await refineIngredientList("고밀도 세라마이드 캡슐, 세라마이드 NP, PHA"))
      .toBe("고밀도 세라마이드 캡슐, 세라마이드 NP, PHA");
  });

  it("still refuses to turn a list into a sentence", async () => {
    expect(await refineIngredientList("PHA와 고밀도 세라마이드 캡슐, 세라마이드 NP를 함유합니다."))
      .toBe("PHA, 고밀도 세라마이드 캡슐, 세라마이드 NP");
  });

  it("keeps the head test on a value that is one phrase, not a list", async () => {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaProperties: { "Target customer": "장벽 보습을 돕는 캡슐 토너" }
    })));
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const properties = product.additionalProperty as Array<Record<string, string>>;

    expect(String(properties.find((entry) => entry.name === "Target customer")?.value ?? ""))
      .toBe("장벽 보습이 필요한 고객");
  });
});

describe("known gap: the English form of the same drift is not caught", () => {
  /**
   * 현재 동작을 그대로 고정한다 — 고쳤다는 뜻이 아니라 알려진 구멍이라는 표시다.
   * compactSchemaPropertyText가 모든 속성값의 종결부호를 떼어내므로 영어에서는
   * 구두점으로 명사구와 문장을 가를 수 없고, validate.ts의 속성 검사도
   * Target customer에는 걸리지 않는다. 이 테스트가 깨지면 구멍이 닫힌 것이니
   * 기대값을 바꾸면 된다.
   */
  it("publishes an English refinement that turned the customer into the product", async () => {
    const request = createRefinementRequest({
      locale: "en-US",
      market: "US",
      targetCustomer: "Customers with dry or sensitive skin",
      // 이 픽스처의 근거에 dry/sensitive가 실제로 있어야 기존
      // isSupportedTargetCustomerCopy 게이트가 먼저 거절하지 않는다 — 그래야
      // 남은 구멍이 어디인지가 이 테스트에 정확히 드러난다.
      sourceDescription: "A gentle cleanser for dry or sensitive skin that supports the skin barrier."
    });
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaProperties: { "Target customer": "This is a gentle cleanser for dry or sensitive skin." }
    })));
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const properties = product.additionalProperty as Array<Record<string, string>>;

    expect(String(properties.find((entry) => entry.name === "Target customer")?.value ?? ""))
      .toBe("This is a gentle cleanser for dry or sensitive skin.");
  });

  it("catches the same drift in Korean", async () => {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaProperties: { "Target customer": "이 제품은 장벽 보습을 돕는 캡슐 토너입니다." }
    })));
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const properties = product.additionalProperty as Array<Record<string, string>>;

    expect(String(properties.find((entry) => entry.name === "Target customer")?.value ?? ""))
      .toBe("장벽 보습이 필요한 고객");
  });
});

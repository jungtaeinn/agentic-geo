import { describe, expect, it } from "vitest";
import { refinePdpGeoCopy } from "../src/copy-refiner";
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
  } = {}
): PdpGeoCopyRefinementRequest {
  const productDescription = overrides.productDescription
    ?? "아토베리어365 캡슐 토너는 건조하고 민감한 피부를 위한 장벽보습 캡슐 토너입니다.";
  const webPageDescription = overrides.webPageDescription
    ?? "아토베리어365 캡슐 토너 상품 페이지는 민감 피부 고객을 위한 장벽보습 정보를 소개합니다.";
  const faq = overrides.faq ?? [
    {
      question: "아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
      answer: "아토베리어365 캡슐 토너의 캡슐은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐입니다."
    },
    {
      question: "에스트라 아토베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?",
      answer: "에스트라 아토베리어365 캡슐 토너는 건조하고 민감한 피부 고객에게 적합한 장벽보습 캡슐 토너입니다."
    },
    {
      question: "에스트라 아토베리어365 캡슐 토너의 주요 성분과 효능은 무엇인가요?",
      answer: "에스트라 아토베리어365 캡슐 토너는 PHA와 고밀도 세라마이드 캡슐을 담은 장벽보습 캡슐 토너입니다."
    }
  ];

  return {
    locale: "ko-KR",
    market: "KR",
    product: {
      name: "에스트라 아토베리어365 캡슐 토너",
      brand: "AESTURA",
      description: "세안 후 약해진 피부장벽을 강화하고 피부결을 정돈하는 장벽보습 캡슐 토너",
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
        "동일한 고밀도 세라마이드 캡슐이 아토베리어365 크림과 캡슐 토너에 사용된다."
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
              { "@type": "PropertyValue", name: "Reported details", value: "세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다." }
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
        productName: "에스트라 아토베리어365 캡슐 토너",
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
        product: "에스트라 아토베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다."
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
        webPage: "아토베리어365 캡슐 토너 상품 페이지는 장벽 보습 맥락과 촉촉한 사용감 중심의 리뷰 맥락, 10.14 fl. oz. / 300 mL 용량을 함께 살펴볼 수 있습니다."
      }
    })));

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    expect(webPage.description).not.toContain("fl. oz.");
    expect(result.warnings.some((warning) => warning.includes("WebPage.description") && warning.includes("volume"))).toBe(true);
  });
});

describe("corrective refinement pass", () => {
  it("retries rejected description refinement once with structured feedback", async () => {
    const request = createRefinementRequest();
    const cleanDescription = "에스트라 아토베리어365 캡슐 토너는 건조하고 민감한 피부 고객을 위한 장벽보습 캡슐 토너로, 고밀도 세라마이드 캡슐이 장벽 보습을 돕고 세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다.";
    const calls: PdpGeoCopyRefinementRequest[] = [];

    const result = await refinePdpGeoCopy(request, createOptions((incoming) => {
      calls.push(incoming);
      if (calls.length === 1) {
        return {
          schemaDescriptions: {
            product: "에스트라 아토베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다."
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
      productDescription: "에스트라 아토베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다."
    });
    const cleanDescription = "에스트라 아토베리어365 캡슐 토너는 건조하고 민감한 피부 고객을 위한 장벽보습 캡슐 토너로, 세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다.";
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
    const badDescription = "에스트라 아토베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다.";
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
});

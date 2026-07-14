import { describe, expect, it } from "vitest";
import { generatePdpGeo, type JsonValue } from "../src";
import { generatePdpGeoArtifacts } from "../src/generate";
import { normalizePdpProduct } from "../src/normalize";

function graphNodes(run: Awaited<ReturnType<typeof generatePdpGeo>>): Array<Record<string, JsonValue>> {
  const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
  return graph.filter((node): node is Record<string, JsonValue> =>
    typeof node === "object" && node !== null && !Array.isArray(node));
}

describe("buyer-intent generation contracts", () => {
  it("keeps an explicit short product description instead of replacing it with review body text", () => {
    const normalized = normalizePdpProduct({
      name: "Clear Serum",
      description: "A face serum.",
      reviews: {
        items: [{ body: "Clear Serum feels light and absorbs quickly." }]
      }
    }, { hints: { locale: "en-US" } });

    expect(normalized.product.description).toBe("A face serum.");
  });

  it("publishes one source usage instruction as exactly one HowTo step", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "Hydra Serum",
        description: "A hydrating face serum for dry-feeling skin.",
        category: "Serum",
        usage: ["Apply one pump to the face and gently pat until absorbed."]
      },
      hints: { locale: "en-US", market: "US" }
    });

    const howTo = graphNodes(run).find((node) => node["@type"] === "HowTo");
    expect(howTo).toBeDefined();
    expect(howTo?.step).toEqual([expect.objectContaining({
      "@type": "HowToStep",
      position: 1,
      text: "Apply one pump to the face and gently pat until absorbed"
    })]);
    expect(run.result.content.sections.howToUse.trim()).toBe("1. Apply one pump to the face and gently pat until absorbed");
  });

  it("keeps explicitly numbered source directions in their original order", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "Barrier Cream",
        description: "A face cream for a dry-feeling skin routine.",
        category: "Cream",
        usage: [
          "Step 1: Apply the cream evenly to the face.",
          "Step 2: Press gently until absorbed."
        ]
      },
      hints: { locale: "en-US", market: "US" }
    });

    const howTo = graphNodes(run).find((node) => node["@type"] === "HowTo");
    const steps = (howTo?.step ?? []) as Array<Record<string, JsonValue>>;

    expect(howTo?.name).toBe("How to use Barrier Cream");
    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.position)).toEqual([1, 2]);
    expect(steps.map((step) => String(step.text))).toEqual([
      "Apply the cream evenly to the face",
      "Press gently until absorbed"
    ]);
  });

  it("orders descriptions through research citation and review keywords while preserving parsed dates and numbers", async () => {
    const citationSource = "2025년 3월 14일 대한피부과학회 학술지에 게재된 연구 '겨울철 피부 보습 관찰'에서는 32명을 4주간 관찰한 결과 수분량이 18.6% 증가했습니다.";
    const run = await generatePdpGeo({
      product: {
        name: "윈터 배리어 크림",
        brand: "테스트랩",
        category: "크림",
        description: "겨울철 건조하고 민감한 피부 고객을 위한 보습 크림입니다.",
        benefits: ["보습", "피부 장벽 케어"],
        ingredients: ["세라마이드", "판테놀"],
        sourceTexts: [citationSource],
        semanticFacts: {
          ingredients: ["세라마이드", "판테놀"],
          benefits: ["보습", "피부 장벽 케어"],
          effects: [],
          skinTypes: ["건조하고 민감한 피부"],
          usageSteps: [],
          metricClaims: [],
          evidenceSentences: [citationSource],
          ingredientBenefitLinks: [],
          citations: [{
            type: "research",
            title: "겨울철 피부 보습 관찰",
            publisher: "대한피부과학회 학술지",
            publishedAt: "2025-03-14",
            finding: "32명을 4주간 관찰한 결과 수분량이 18.6% 증가했습니다.",
            sourceText: citationSource
          }]
        },
        reviews: {
          items: [{ body: "촉촉하고 편안하게 마무리되어 만족했습니다." }],
          keywords: ["촉촉한 사용감", "편안한 마무리"]
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const nodes = graphNodes(run);
    const productDescription = String(nodes.find((node) => node["@type"] === "Product")?.description);
    const webPageDescription = String(nodes.find((node) => node["@type"] === "WebPage")?.description);
    const faqItems = nodes.find((node) => node["@type"] === "FAQPage")?.mainEntity as Array<Record<string, JsonValue>>;
    for (const description of [productDescription, webPageDescription]) {
      expect(description).toContain("2025년 3월 14일");
      expect(description).toContain("겨울철 피부 보습 관찰");
      expect(description).toContain("32명을 4주간");
      expect(description).toContain("18.6%");
      expect(description.indexOf("세라마이드")).toBeLessThan(description.indexOf("피부 장벽 케어"));
      expect(description.indexOf("피부 장벽 케어")).toBeLessThan(description.indexOf("2025년 3월 14일"));
      expect(description.indexOf("2025년 3월 14일")).toBeLessThan(description.indexOf("고객 리뷰"));
    }
    expect(String(faqItems[0]?.name)).toBe("겨울철 보습 화장품으로 윈터 배리어 크림은 추천할 수 있나요?");
  });

  it("turns label-heavy OCR citation metadata into natural Korean prose", async () => {
    const citationSource = "연구명: 장벽 보습 관찰 | 학술지: 피부과학저널 | 게재일: 2025.04.09 | 연구 결과: 성인 24명을 6주간 관찰한 결과 수분 지표가 12.4% 증가했습니다.";
    const run = await generatePdpGeo({
      product: {
        name: "리서치 보습 크림",
        category: "크림",
        description: "건조한 피부를 위한 보습 크림입니다.",
        benefits: ["보습"],
        ingredients: ["세라마이드"],
        sourceTexts: [citationSource]
      },
      hints: { locale: "ko-KR" }
    });

    const nodes = graphNodes(run);
    for (const type of ["Product", "WebPage"]) {
      const description = String(nodes.find((node) => node["@type"] === type)?.description);
      expect(description).toContain("2025년 4월 9일 피부과학저널에 공개된 관련 연구 「장벽 보습 관찰」에서는");
      expect(description).toContain("성인 24명을 6주간 관찰한 결과 수분 지표가 12.4% 증가했습니다");
      expect(description).not.toMatch(/연구명:|학술지:|게재일:|연구 결과:/u);
    }
  });

  it("uses life-stage gift query shapes only when one product evidence unit supports every detail", async () => {
    const supported = await generatePdpGeo({
      product: {
        name: "마더 리뉴 크림",
        category: "크림",
        description: "50대 어머니를 위한 화장품 선물로 소개되는 탄력 보습 크림입니다.",
        benefits: ["탄력", "보습"],
        sourceTexts: ["50대 어머니를 위한 화장품 선물로 추천하는 탄력 보습 크림입니다."]
      },
      hints: { locale: "ko-KR" }
    });
    const unsupported = await generatePdpGeo({
      product: {
        name: "데일리 보습 크림",
        category: "크림",
        description: "건조한 피부를 위한 데일리 보습 크림입니다.",
        benefits: ["보습"]
      },
      hints: { locale: "ko-KR" }
    });
    const firstQuestion = (run: Awaited<ReturnType<typeof generatePdpGeo>>) => {
      const faq = graphNodes(run).find((node) => node["@type"] === "FAQPage");
      return String((faq?.mainEntity as Array<Record<string, JsonValue>>)?.[0]?.name ?? "");
    };

    expect(firstQuestion(supported)).toBe("50대 어머니를 위한 화장품 선물로 마더 리뉴 크림은 추천할 수 있나요?");
    expect(firstQuestion(unsupported)).not.toMatch(/50대|어머니|선물|겨울/u);
  });

  it("separates product detail from page and brand context while prioritising concern-led FAQ", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "하이드라 리페어 세럼",
        brand: "테스트랩",
        category: "세럼",
        description: "건조하고 민감한 피부를 위한 보습 세럼입니다.",
        benefits: ["보습", "피부 장벽 케어"],
        ingredients: ["나이아신아마이드", "판테놀"],
        usage: ["세안 후 적당량을 얼굴에 고르게 바릅니다."],
        reviews: {
          items: [{ body: "가볍게 흡수되고 촉촉한 사용감이 좋았습니다." }],
          keywords: ["가벼운 흡수감", "촉촉한 사용감"]
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const nodes = graphNodes(run);
    const product = nodes.find((node) => node["@type"] === "Product")!;
    const webPage = nodes.find((node) => node["@type"] === "WebPage")!;
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const productDescription = String(product.description);
    const webPageDescription = String(webPage.description);
    const faq = (faqPage.mainEntity as Array<Record<string, JsonValue>>)
      .map((item) => ({
        question: String(item.name),
        answer: String((item.acceptedAnswer as Record<string, JsonValue>).text)
      }));
    const suitability = faq.find((item) => /(?:고민|어떤\s*고객|추천|고객에게[^?？]*적합)/u.test(item.question));

    expect(productDescription.indexOf("하이드라 리페어 세럼")).toBeLessThan(productDescription.indexOf("건조"));
    expect(productDescription.indexOf("건조")).toBeLessThan(productDescription.indexOf("나이아신아마이드"));
    expect(productDescription.indexOf("나이아신아마이드")).toBeLessThan(productDescription.indexOf("보습"));
    expect(productDescription.indexOf("보습")).toBeLessThan(productDescription.indexOf("리뷰"));
    expect(webPageDescription).toMatch(/상품\s*페이지/u);
    expect(webPageDescription).toContain("테스트랩");
    expect(webPageDescription).toMatch(/하이드라 리페어 세럼은[^.]*건조하고 민감한 피부 고객을 위한 제품/u);
    expect(webPageDescription).toContain("나이아신아마이드, 판테놀을 주요 성분·기술로 포함하고");
    expect(webPageDescription).toMatch(/포함하고[^.]*수분[^.]*피부 장벽 케어[^.]*돕습니다/u);
    expect(webPageDescription).not.toMatch(/페이지 본문에서는|페이지에서 확인할 수 있는|페이지에 공개된/u);
    expect(webPageDescription).toMatch(/고객 리뷰에서 고객들은 하이드라 리페어 세럼의 [^.]*촉촉한 사용감[^.]*흡수감[^.]*긍정적으로 평가했습니다/u);
    expect(webPageDescription).not.toContain("구매 판단에 필요한");
    expect(webPageDescription).not.toBe(productDescription);
    expect(suitability).toBeDefined();
    expect(`${suitability?.question} ${suitability?.answer}`).toMatch(/건조|민감|장벽/u);
    expect(suitability?.answer).not.toMatch(/(?:나이아신아마이드|판테놀)[^.!?。！？]{0,80}(?:보습|장벽)[^.!?。！？]{0,30}(?:돕|지원|개선|효과)/u);
    expect(run.result.content.sections.quickFacts).not.toMatch(/(?:나이아신아마이드|판테놀)[^\n]{0,50}(?:보습|수분감|피부\s*장벽)\s*포인트/u);
  });

  it("does not reinterpret an application timing phrase as a product cleansing benefit", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "Hydra Barrier Cream",
        description: "A moisturizer for dry and sensitive-feeling skin.",
        category: "Moisturizer",
        benefits: ["hydration", "skin barrier support"],
        ingredients: ["Ceramide", "Panthenol"],
        usage: ["After cleansing, apply a small amount to the face."]
      },
      hints: { locale: "en-US", market: "US" }
    });

    const publicOutput = JSON.stringify({
      schemaMarkup: run.result.schemaMarkup,
      content: run.result.content
    });
    const product = graphNodes(run).find((node) => node["@type"] === "Product")!;
    expect(publicOutput).not.toMatch(/cleansing power/i);
    expect(publicOutput).not.toMatch(/Ceramide\s+for\s+(?:hydration|skin barrier)|Panthenol\s+for\s+(?:hydration|skin barrier)|(?:hydration|skin barrier)\s+with\s+(?:Ceramide|Panthenol)|(?:Ceramide|Panthenol)\s+supports?\s+(?:hydration|skin barrier)/i);
    expect(String(product.description)).toMatch(/documented benefit is .*hydration.*skin barrier|documented benefits are .*hydration.*skin barrier/i);
  });

  it("keeps rich WebPage descriptions page-scoped while naming concrete supported information", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "아토베리어365 크림",
        brand: "AESTURA",
        category: "크림",
        description: "건조하고 민감한 피부 고객을 위한 장벽 보습 크림입니다.",
        benefits: ["피부 장벽 보습", "보습 지속"],
        ingredients: ["고밀도 세라마이드 캡슐", "더마온 기술"],
        usage: ["아침과 저녁 세안 후 적당량을 피부에 골고루 펴 바릅니다."],
        options: ["80 mL"],
        metrics: ["인체적용시험에서 사용 직후 보습량은 사용 전 대비 2배 증가했습니다."],
        faq: [{
          question: "아토베리어365 크림은 어떤 피부에 적합한가요?",
          answer: "건조하고 민감한 피부 고객을 위한 장벽 보습 크림입니다."
        }],
        reviews: {
          items: [{ body: "촉촉하고 편안하게 마무리되어 만족했습니다." }],
          keywords: ["촉촉한 사용감", "편안한 마무리"]
        },
        semanticFacts: {
          ingredients: ["고밀도 세라마이드 캡슐", "더마온 기술"],
          benefits: ["피부 장벽 보습", "보습 지속"],
          effects: [],
          skinTypes: ["건조 피부", "민감 피부"],
          usageSteps: ["아침과 저녁 세안 후 적당량을 피부에 골고루 펴 바릅니다."],
          metricClaims: [{
            label: "보습량",
            value: "2",
            unit: "배",
            direction: "증가",
            timing: "사용 직후",
            baseline: "사용 전",
            sample: "건조하고 민감한 피부 고민이 있는 여성 32명",
            period: "4주",
            method: "인체적용시험",
            institution: "테스트기관",
            sentence: "인체적용시험에서 사용 직후 보습량은 사용 전 대비 2배 증가했습니다.",
            sourceText: "테스트기관이 건조하고 민감한 피부 고민이 있는 여성 32명을 대상으로 4주간 진행한 인체적용시험에서 사용 직후 보습량은 사용 전 대비 2배 증가했습니다."
          }],
          evidenceSentences: ["인체적용시험에서 사용 직후 보습량은 사용 전 대비 2배 증가했습니다."],
          ingredientBenefitLinks: [],
          safetyTests: ["민감 피부 자극 테스트 완료", "피부과 테스트 완료"]
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const nodes = graphNodes(run);
    const webPageDescription = String(nodes.find((node) => node["@type"] === "WebPage")?.description);
    const productDescription = String(nodes.find((node) => node["@type"] === "Product")?.description);
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const faqItems = faqPage.mainEntity as Array<Record<string, JsonValue>>;
    const reverseSuitabilityFaq = faqItems.find((item) => /고객에게[^?？]*적합한가요/u.test(String(item.name)))!;
    const reverseSuitabilityAnswer = String((reverseSuitabilityFaq.acceptedAnswer as Record<string, JsonValue>).text);

    expect(webPageDescription).toContain("아토베리어365 크림 상품 페이지는 AESTURA가 선보이는");
    expect(webPageDescription).toMatch(/아토베리어365 크림은[^.]*건조하고 민감한 피부 고객을 위한 제품/u);
    expect(webPageDescription).toMatch(/고밀도 세라마이드 캡슐, (?:더마온|DermaON®) 기술을 주요 성분·기술로 포함하고/u);
    expect(webPageDescription).toMatch(/테스트기관이[^.]*여성\s*32명을\s*대상으로\s*진행한\s*인체적용시험에서\s*사용\s*직후\s*보습량은\s*사용\s*전\s*대비\s*2배\s*증가했습니다/u);
    expect(webPageDescription).toContain("또한 민감 피부 자극 테스트와 피부과 테스트 등을 완료해 민감 피부를 고려한 안전성을 입증했습니다");
    expect(webPageDescription).toContain("아토베리어365 크림은 80 mL 옵션으로 구성되어 있습니다");
    expect(webPageDescription).not.toMatch(/페이지 본문에서는|페이지에서 확인할 수 있는|페이지에 공개된/u);
    expect(webPageDescription).not.toContain("구매 판단에 필요한");
    expect(webPageDescription).not.toContain("상품별 FAQ");
    expect(webPageDescription).not.toBe(productDescription);
    expect(String(reverseSuitabilityFaq.name)).toMatch(/속건조와\s*피부\s*장벽\s*관리가\s*고민인\s*고객에게.*아토베리어365\s*크림은\s*적합한가요/u);
    expect(reverseSuitabilityAnswer).toMatch(/건조하고\s*민감한\s*피부\s*고객을\s*위한\s*크림/u);
    expect(reverseSuitabilityAnswer).toMatch(/아토베리어365\s*크림은[^.]*피부\s*장벽\s*관리[^.]*수분\s*케어를\s*돕습니다/u);
    expect(reverseSuitabilityAnswer).toMatch(/인체적용시험[^.]*사용\s*직후[^.]*2배\s*증가/u);
    expect(reverseSuitabilityAnswer).toMatch(/고밀도\s*세라마이드\s*캡슐[^.]*포함/u);
    expect(reverseSuitabilityAnswer).not.toMatch(/특정\s*성분이[^.]*단독|설명됩니다|안내됩니다/u);
    expect(reverseSuitabilityAnswer).toMatch(/따라서[^.]*고려할\s*수\s*있습니다/u);
    expect(reverseSuitabilityAnswer).toContain("개인에 따라 사용 결과는 달라질 수 있습니다");
  });

  it("publishes an ingredient-benefit relation only when the source provides an explicit link", async () => {
    const relation = "Ceramide supports skin barrier care.";
    const run = await generatePdpGeo({
      product: {
        name: "Linked Barrier Cream",
        description: `A cream for dry-feeling skin. ${relation}`,
        category: "Cream",
        ingredients: ["Ceramide"],
        benefits: ["skin barrier care"],
        semanticFacts: {
          ingredients: ["Ceramide"],
          benefits: ["skin barrier care"],
          effects: [],
          skinTypes: ["dry-feeling skin"],
          usageSteps: [],
          metricClaims: [],
          evidenceSentences: [relation],
          ingredientBenefitLinks: [{
            ingredient: "Ceramide",
            benefit: "skin barrier care",
            sentence: relation,
            sourceText: relation
          }]
        }
      },
      hints: { locale: "en-US", market: "US" }
    });

    const product = graphNodes(run).find((node) => node["@type"] === "Product")!;
    const publicOutput = JSON.stringify(product);

    expect(publicOutput).toMatch(/Ceramide\s+(?:for|to support)\s+skin barrier/i);
    expect(String(product.description).match(/Ceramide supports skin barrier care/gi)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("does not promote an ingredient role into a finished-product benefit", async () => {
    const relation = "Ceramide supports skin barrier care.";
    const run = await generatePdpGeo({
      product: {
        name: "Link-only Barrier Cream",
        description: "A face cream with Ceramide.",
        category: "Cream",
        ingredients: ["Ceramide"],
        sourceTexts: [relation],
        semanticFacts: {
          ingredients: ["Ceramide"],
          benefits: [],
          effects: [],
          skinTypes: [],
          usageSteps: [],
          metricClaims: [],
          evidenceSentences: [relation],
          ingredientBenefitLinks: [{
            ingredient: "Ceramide",
            benefit: "skin barrier care",
            sentence: relation,
            sourceText: relation
          }]
        }
      },
      hints: { locale: "en-US", market: "US" }
    });

    const publicOutput = JSON.stringify({
      schemaMarkup: run.result.schemaMarkup,
      content: run.result.content
    });

    expect(publicOutput).toMatch(/Ceramide supports skin barrier (?:care|health)/i);
    expect(publicOutput).not.toMatch(/Link-only Barrier Cream supports skin barrier/i);
    expect(publicOutput).not.toMatch(/product(?:'s)? documented benefit is skin barrier/i);
    expect(publicOutput).not.toMatch(/skincare layering routine|fit into a skincare routine|Routine synergy/i);
  });

  it("keeps a source-backed finished-product benefit when no ingredient or metric detail exists", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "Radiance Serum",
        description: "A facial serum.",
        category: "Serum",
        benefits: ["hydration"]
      },
      hints: { locale: "en-US", market: "US" }
    });

    const product = graphNodes(run).find((node) => node["@type"] === "Product")!;
    const description = String(product.description);

    expect(description).toContain("Radiance Serum is a serum");
    expect(description).toContain("The product's documented benefit is hydration");
    expect(description.indexOf("Radiance Serum")).toBeLessThan(description.indexOf("hydration"));
  });

  it("attributes only observed English review signals without a generic care template", () => {
    const normalized = normalizePdpProduct({
      name: "Glow Serum",
      description: "A facial serum with a radiance benefit.",
      category: "Serum",
      benefits: ["radiance"]
    }, { hints: { locale: "en-US" } }).product;
    const result = generatePdpGeoArtifacts({
      product: {
        ...normalized,
        reviews: {
          rating: 4.7,
          reviewCount: 24,
          items: [],
          keywords: ["absorbs quickly"]
        }
      },
      locale: "en-US",
      market: "US",
      ragChunks: [],
      ragDocuments: []
    });
    const description = result.content.sections.description;

    expect(description).toContain("Customers highlight absorbs quickly in reviews");
    expect(description).not.toMatch(/supports the product's texture, moisture, firmness|texture, moisture, firmness/i);
  });

  it("keeps English target, barrier, and single-review wording specific and non-duplicative", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "Barrier Relief Cream",
        description: "A moisturizer for dry and sensitive-feeling skin.",
        category: "Moisturizer",
        benefits: ["skin barrier support", "skin barrier care"],
        reviews: {
          items: [{ body: "It absorbs quickly without feeling sticky." }],
          keywords: ["quick absorption"]
        }
      },
      hints: { locale: "en-US", market: "US" }
    });

    const nodes = graphNodes(run);
    const product = nodes.find((node) => node["@type"] === "Product")!;
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const faq = (faqPage.mainEntity as Array<Record<string, JsonValue>>).map((item) => ({
      question: String(item.name),
      answer: String((item.acceptedAnswer as Record<string, JsonValue>).text)
    }));
    const suitability = faq.find((item) => /best suited|suitable for/i.test(item.question));
    const review = faq.find((item) => /What do customer reviews highlight/i.test(item.question));
    const description = String(product.description);

    expect(description).toContain("customers with dry or sensitive skin");
    expect(description).toContain("One customer review highlights quick absorption");
    expect(description.match(/skin barrier (?:support|care|health)/gi)).toHaveLength(1);
    expect(description).not.toMatch(/absorbs\b|repeated/i);
    expect(`${suitability?.question} ${suitability?.answer}`).toContain("dry or sensitive skin");
    expect(review?.answer).toContain("quick absorption");
    expect(review?.answer).not.toMatch(/skin barrier|for search, comparison, and routine decisions|repeat/i);
  });

  it("uses natural Korean texture attribution without claiming one review is repeated", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "하이드라 리페어 세럼",
        description: "건조하고 민감한 피부를 위한 보습 세럼입니다.",
        category: "세럼",
        benefits: ["보습"],
        reviews: {
          items: [{ body: "촉촉하고 흡수가 빨라 사용감이 좋았어요." }],
          keywords: ["촉촉한 사용감", "흡수감"]
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const nodes = graphNodes(run);
    const product = nodes.find((node) => node["@type"] === "Product")!;
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const faqText = (faqPage.mainEntity as Array<Record<string, JsonValue>>)
      .map((item) => `${String(item.name)} ${String((item.acceptedAnswer as Record<string, JsonValue>).text)}`)
      .join("\n");

    expect(faqText).toContain("촉촉한 사용감과 흡수감이 특징입니다");
    expect(faqText).not.toContain("흡수감 사용감");
    expect(`${String(product.description)}\n${faqText}`).not.toMatch(/리뷰[^\n.!?。！？]{0,80}반복/u);
  });

  it("does not infer a reverse-FAQ concern from ingredient or general source-text co-occurrence", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "글로우 세럼",
        description: "피부 광채를 위한 세럼입니다.",
        category: "세럼",
        benefits: ["광채 케어"],
        ingredients: ["세라마이드"],
        sourceTexts: ["성분 자료에는 건조, 민감, 세라마이드라는 용어가 함께 있습니다."]
      },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const faqPage = graphNodes(run).find((node) => node["@type"] === "FAQPage")!;
    const questions = ((faqPage.mainEntity ?? []) as Array<Record<string, JsonValue>>)
      .map((item) => String(item.name));

    expect(questions.join("\n")).toMatch(/글로우 세럼의 주요 효능·효과는 무엇인가요/u);
    expect(questions.join("\n")).not.toMatch(/상품 근거|인체적용시험/u);
    expect(questions.join("\n")).not.toMatch(/(?:건조|민감)한 피부가 고민인 고객/u);
  });

  it("rejects full English narrative in ko-KR while retaining INCI tokens in Korean copy", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "Barrier Lab Serum",
        description: "This product supports hydration for dry skin.",
        category: "세럼",
        benefits: ["보습"],
        ingredients: ["Ceramide NP", "Panthenol"],
        sourceTexts: [
          "Ceramide NP와 Panthenol을 함유한 포뮬러입니다.",
          "This product is recommended for dry skin."
        ],
        reviews: {
          items: [{ body: "I love this serum because it absorbs quickly." }],
          keywords: ["quick absorption"]
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const product = graphNodes(run).find((node) => node["@type"] === "Product")!;
    const description = String(product.description);

    expect(description).toMatch(/Ceramide NP|Panthenol/u);
    expect(description).not.toContain("This product supports hydration for dry skin");
    expect(description).not.toContain("This product is recommended for dry skin");
    expect(description).not.toContain("I love this serum");
  });

  it("uses the ordered deterministic renderer when a model plan omits Product.description", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "하이드라 세럼",
        description: "건조 피부용 보습 세럼입니다.",
        category: "세럼",
        benefits: ["보습"],
        ingredients: ["Ceramide NP"],
        reviews: {
          items: [{ body: "촉촉하고 흡수가 빠른 사용감이 좋았습니다." }],
          keywords: ["촉촉한 사용감"]
        },
        semanticFacts: {
          ingredients: ["Ceramide NP"],
          benefits: ["보습"],
          effects: [],
          skinTypes: ["건조 피부"],
          usageSteps: [],
          metricClaims: [],
          evidenceSentences: [],
          ingredientBenefitLinks: []
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    }, {
      customContentPlanner: {
        planContent: () => ({
          plan: {
            locale: "ko-KR",
            productDescription: {
              include: false,
              text: "",
              intent: "product-target-ingredient-benefit-review",
              evidenceIds: [],
              confidence: 0,
              omitReason: "omitted by planner"
            },
            webPageDescription: {
              include: false,
              text: "",
              intent: "page-brand-scope",
              evidenceIds: [],
              confidence: 0,
              omitReason: "omitted by planner"
            },
            faq: [],
            howTo: {
              eligible: false,
              ordered: false,
              goal: "",
              steps: [],
              evidenceIds: [],
              confidence: 0,
              omitReason: "no source usage"
            },
            cep: [],
            warnings: []
          }
        })
      }
    });

    const product = graphNodes(run).find((node) => node["@type"] === "Product")!;
    const description = String(product.description);
    const targetIndex = description.indexOf("건조 피부");
    const ingredientIndex = description.indexOf("Ceramide NP");
    const benefitIndex = description.indexOf("보습", ingredientIndex);
    const reviewIndex = description.indexOf("리뷰");

    expect(description).not.toBe("건조 피부용 보습 세럼입니다.");
    expect(description.indexOf("하이드라 세럼")).toBeLessThan(targetIndex);
    expect(targetIndex).toBeLessThan(ingredientIndex);
    expect(ingredientIndex).toBeLessThan(benefitIndex);
    expect(benefitIndex).toBeLessThan(reviewIndex);
    expect(description).not.toMatch(/Ceramide NP[^.!?。！？]{0,80}(?:보습|수분)[^.!?。！？]{0,30}(?:돕|개선|효과)/u);
  });
});

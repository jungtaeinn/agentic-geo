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
    const steps = (howTo?.step ?? []) as JsonValue[];

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      "@type": "HowToStep",
      position: 1,
      text: "Apply one pump to the face and gently pat until absorbed"
    });
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

    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.position)).toEqual([1, 2]);
    expect(steps.map((step) => String(step.text))).toEqual([
      "Apply the cream evenly to the face",
      "Press gently until absorbed"
    ]);
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
    expect(webPageDescription).toContain("건조하고 민감한 피부 고객을 대상 고객으로 안내합니다");
    expect(webPageDescription).toContain("주요 성분·기술은 나이아신아마이드, 판테놀");
    expect(webPageDescription).toMatch(/공개된 효능·효과는 .*수분.*피부 장벽 케어/u);
    expect(webPageDescription).toContain("고객 리뷰에서는 흡수감, 촉촉한 사용감이 언급됩니다");
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

    expect(webPageDescription).toContain("AESTURA의 아토베리어365 크림 상품 페이지");
    expect(webPageDescription).toContain("건조하고 민감한 피부 고객을 대상 고객으로 안내합니다");
    expect(webPageDescription).toMatch(/주요 성분·기술은 고밀도 세라마이드 캡슐, (?:더마온|DermaON®) 기술/u);
    expect(webPageDescription).toContain("완제품 인체적용시험에서 사용 직후 보습량은 사용 전 대비 2배 증가했습니다");
    expect(webPageDescription).toContain("민감 피부 자극 테스트와 피부과 테스트 등의 완료 정보");
    expect(webPageDescription).toContain("옵션은 80 mL로 표시됩니다");
    expect(webPageDescription).not.toContain("구매 판단에 필요한");
    expect(webPageDescription).not.toContain("상품별 FAQ");
    expect(webPageDescription).not.toBe(productDescription);
    expect(String(reverseSuitabilityFaq.name)).toMatch(/속건조와\s*피부\s*장벽\s*관리가\s*고민인\s*고객에게.*아토베리어365\s*크림은\s*적합한가요/u);
    expect(reverseSuitabilityAnswer).toMatch(/건조하고\s*민감한\s*피부\s*고객을\s*위한\s*크림/u);
    expect(reverseSuitabilityAnswer).toMatch(/공식\s*상품\s*정보에서[^.]*피부\s*장벽\s*관리[^.]*수분\s*케어에\s*도움을\s*주는\s*제품/u);
    expect(reverseSuitabilityAnswer).toMatch(/인체적용시험[^.]*사용\s*직후[^.]*2배\s*증가/u);
    expect(reverseSuitabilityAnswer).toMatch(/고밀도\s*세라마이드\s*캡슐[^.]*포함/u);
    expect(reverseSuitabilityAnswer).toContain("특정 성분이 완제품의 효능·효과를 단독으로 만들었다고 단정할 근거는 제공되지 않았습니다");
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

    expect(description).toContain("Customer reviews mention absorbs quickly");
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
    expect(description).toContain("One customer review mentions quick absorption");
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

    expect(questions.join("\n")).toMatch(/주요 효능·효과와 이를 뒷받침하는 상품 근거/u);
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

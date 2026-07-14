import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPdpGeoEvidenceLedger,
  generatePdpGeo,
  inferPdpEvidenceRoles,
  normalizePdpProductWithAgent,
  planPdpGeoContent,
  sanitizePdpSemanticFacts,
  type JsonValue,
  type PdpGeoContentPlan,
  type PdpProductSignal
} from "../src";
import { normalizePdpProduct } from "../src/normalize";
import { validateAndRepairPdpGeoArtifacts } from "../src/validate";

afterEach(() => {
  vi.unstubAllGlobals();
});

function expectKoreanWebPageScopeDescription(description: string, productName: string, brand?: string): void {
  expect(description).toContain(productName);
  expect(description.split(productName).length - 1).toBeGreaterThanOrEqual(1);
  expect(description.split(productName).length - 1).toBeLessThanOrEqual(4);
  expect(description).toMatch(/상품\s*페이지/u);
  expect(description).not.toMatch(/페이지\s*본문에서는|페이지에서\s*확인할\s*수\s*있는|페이지에\s*공개된/u);
  expect(description).not.toMatch(/구매\s*판단에\s*필요한|상품별\s*FAQ|가격·구매\s*정보를\s*함께\s*제공/u);
  if (brand) {
    expect(description).toContain(brand);
  }
  expect(description).not.toMatch(/FAQ와\s*HowTo|페이지에서\s*확인할\s*수\s*있는\s*정보\s*범위/u);
}

describe("evidence-rich GEO regression contracts", () => {
  it("accepts audited same-language GEO synthesis for descriptions, FAQ, and CEP", async () => {
    const product = evidenceRichProduct();
    const evidenceLedger = createPdpGeoEvidenceLedger(product, "ko-KR");
    const identity = evidenceLedger.find((item) => item.sourcePath === "product.name")!;
    const description = evidenceLedger.find((item) => item.role === "description")!;
    const ingredient = evidenceLedger.find((item) => item.role === "ingredient")!;
    const benefit = evidenceLedger.find((item) => item.role === "benefit")!;
    const review = evidenceLedger.find((item) => item.role === "review")!;
    const plan = planPayload({
      productDescription: {
        include: true,
        text: "하이드라 배리어 크림은 건조하고 민감한 피부 고객을 위한 크림으로, 세라마이드 캡슐이 피부 장벽 보습을 돕는다고 설명되며 고객 리뷰에서는 촉촉하고 편안한 사용감이 반복돼 제품 선택 기준을 제공합니다.",
        intent: "product-target-ingredient-benefit-evidence",
        evidenceIds: [identity.id, description.id, ingredient.id, benefit.id, review.id],
        confidence: 0.94,
        omitReason: ""
      },
      faq: [
        {
          include: true,
          question: "하이드라 배리어 크림은 어떤 고객에게 적합한가요?",
          answer: "건조하고 민감한 피부 고객이 피부 장벽 보습을 고려할 때 선택할 수 있는 크림입니다.",
          intent: "target-customer",
          cep: "건조하고 민감한 피부의 장벽 보습",
          evidenceIds: [description.id, benefit.id],
          confidence: 0.92,
          omitReason: ""
        },
        {
          include: true,
          question: "건조하고 민감한 피부 고민에 어떤 성분이 도움이 되나요?",
          answer: "세라마이드 캡슐이 건조하고 민감한 피부의 피부 장벽 보습을 돕는다고 설명됩니다.",
          intent: "concern-ingredient-benefit",
          cep: "민감 피부 장벽 보습",
          evidenceIds: [description.id, ingredient.id, benefit.id],
          confidence: 0.93,
          omitReason: ""
        }
      ],
      cep: [{
        situation: "피부가 건조하고 민감할 때",
        need: "세라마이드 캡슐 기반 피부 장벽 보습",
        constraint: "",
        evidenceIds: [description.id, ingredient.id, benefit.id],
        confidence: 0.91
      }]
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(plan) }] }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await planPdpGeoContent({
      product,
      locale: "ko-KR",
      evidenceLedger,
      ragChunks: []
    }, {
      contentPlanning: { enabled: true, provider: "openai", apiKey: "key", model: "gpt-test" }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.plan.productDescription.include).toBe(true);
    expect(result.plan.productDescription.text).toMatch(/대상|고객/u);
    expect(result.plan.productDescription.text).toMatch(/세라마이드/u);
    expect(result.plan.productDescription.text).toMatch(/장벽|보습/u);
    expect(result.plan.productDescription.text).toMatch(/리뷰/u);
    expect(result.plan.faq.map((item) => item.intent)).toEqual(expect.arrayContaining(["target-customer", "concern-ingredient-benefit"]));
    expect(result.plan.cep).toHaveLength(1);
  });

  it("omits an audited model description when Korean fluency artifacts survive generation", async () => {
    const product = evidenceRichProduct();
    const evidenceLedger = createPdpGeoEvidenceLedger(product, "ko-KR");
    const evidenceIds = evidenceLedger.map((item) => item.id);
    const plan = planPayload({
      productDescription: {
        include: true,
        text: "하이드라 배리어 크림은 건조하고 민감한 피부 고객을 위한 크림입니다. 세라마이드 캡슐과 하는 기술이 적용되어 있고 ☑ 피부 장벽 보습 120시간 ※ 시험 결과입니다. 완료된 테스트는 참고할 수 있는 시험 정보입니다. 실제 고객 리뷰에서는 촉촉한 사용감이 언급됩니다.",
        intent: "product-target-formula-evidence-review",
        evidenceIds,
        confidence: 0.9,
        omitReason: ""
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(plan) }] }]
    }), { status: 200 })));

    const result = await planPdpGeoContent({
      product,
      locale: "ko-KR",
      evidenceLedger,
      ragChunks: []
    }, {
      contentPlanning: { enabled: true, provider: "openai", apiKey: "key", model: "gpt-test" }
    });

    expect(result.plan.productDescription.include).toBe(false);
    expect(result.plan.warnings.some((warning) => warning.includes("OCR artifact") && warning.includes("dependent predicate fragment"))).toBe(true);
  });

  it("uses accepted model CEP paths in search diagnostics and factual customer-situation properties", async () => {
    const product = evidenceRichProduct();
    const evidenceLedger = createPdpGeoEvidenceLedger(product, "ko-KR");
    const identity = evidenceLedger.find((item) => item.sourcePath === "product.name")!;
    const description = evidenceLedger.find((item) => item.role === "description")!;
    const ingredient = evidenceLedger.find((item) => item.role === "ingredient" && /세라마이드/u.test(item.text))!;
    const benefit = evidenceLedger.find((item) => item.role === "benefit" && /장벽\s*보습/u.test(item.text))!;
    const relation = evidenceLedger.find((item) => item.role === "source" && /세라마이드[^.!?。！？]{0,80}장벽\s*보습/u.test(item.text))!;
    const plan = planPayload({
      productDescription: {
        include: true,
        text: "하이드라 배리어 크림은 건조하고 민감한 피부 고객을 위한 크림입니다. 주요 성분인 세라마이드 캡슐이 피부 장벽 보습을 돕습니다.",
        intent: "product-target-ingredient-benefit",
        evidenceIds: [identity.id, description.id, ingredient.id, benefit.id, relation.id],
        confidence: 0.95,
        omitReason: ""
      },
      faq: [{
        include: true,
        question: "하이드라 배리어 크림은 어떤 고객에게 적합한가요?",
        answer: "하이드라 배리어 크림은 건조하고 민감한 피부 고객의 피부 장벽 보습을 돕는 크림입니다.",
        intent: "target-customer-suitability",
        cep: "건조하고 민감한 피부의 장벽 보습",
        evidenceIds: [identity.id, description.id, benefit.id],
        confidence: 0.94,
        omitReason: ""
      }],
      cep: [{
        situation: "건조하고 민감한 피부 고객",
        need: "피부 장벽 보습",
        constraint: "세라마이드 캡슐이 피부 장벽 보습을 돕습니다",
        evidenceIds: [description.id, ingredient.id, benefit.id, relation.id],
        confidence: 0.93
      }]
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(plan) }] }]
    }), { status: 200 })));

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } }, {
      contentPlanning: { enabled: true, provider: "openai", apiKey: "key", model: "gpt-test" }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const properties = (productNode.additionalProperty as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const customerSituation = String(properties.find((item) => item.name === "Customer situation")?.value ?? "");
    const plannedQuery = run.result.diagnostics.inferredSearchQueries?.find((query) => query.source === "model-inferred-cep");

    expect(run.result.diagnostics.contentPlan?.cep).toHaveLength(1);
    expect(customerSituation).toMatch(/건조하고\s*민감한\s*피부\s*고객/u);
    expect(customerSituation).toMatch(/세라마이드\s*캡슐/u);
    expect(customerSituation).toMatch(/피부\s*장벽\s*보습/u);
    expect(properties.some((item) => item.name === "Review-derived recommendation context")).toBe(false);
    expect(plannedQuery).toBeDefined();
    expect(plannedQuery?.question).toContain("하이드라 배리어 크림");
    expect(plannedQuery?.keywords.join(" ")).toMatch(/건조|민감|장벽|세라마이드/u);
  });

  it("uses evidence-rich fallbacks and removes ingredient/metric artifacts when a model plan is omitted", async () => {
    const product = evidenceRichProduct();
    const run = await generatePdpGeo({
      product,
      hints: { locale: "ko-KR" }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const webPage = nodes.find((node) => node["@type"] === "WebPage")!;
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const properties = (productNode.additionalProperty as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const propertyValue = (name: string) => String(properties.find((item) => item.name === name)?.value ?? "");
    const productDescription = String(productNode.description ?? "");
    const webPageDescription = String(webPage.description ?? "");
    const faqText = JSON.stringify(faqPage.mainEntity ?? []);
    const faqQuestions = ((faqPage.mainEntity as JsonValue[]) ?? [])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item))
      .map((item) => String(item.name ?? ""));

    expect(productDescription).toMatch(/건조|민감/u);
    expect(productDescription).toMatch(/세라마이드/u);
    expect(productDescription).toMatch(/장벽|보습/u);
    expect(productDescription).toMatch(/리뷰|촉촉/u);
    expect(productDescription).not.toMatch(/(?:필요|고민|효능|효과|케어|보습|장벽|수분)[^.!?。！？]{0,90}선택할\s*수\s*있습니다/u);
    const targetIndex = productDescription.indexOf("건조하고 민감한 피부");
    const ingredientIndex = productDescription.indexOf("세라마이드");
    const benefitIndex = productDescription.indexOf("피부 장벽");
    const reviewIndex = productDescription.indexOf("고객 리뷰");
    expect(targetIndex).toBeGreaterThan(-1);
    expect(targetIndex).toBeLessThan(ingredientIndex);
    expect(ingredientIndex).toBeLessThan(benefitIndex);
    expect(benefitIndex).toBeLessThan(reviewIndex);
    const productSentences = productDescription.split(/(?<=[.!?。！？])\s+/u);
    expect(productSentences.some((sentence) => /주요\s*성분/u.test(sentence) && /세라마이드/u.test(sentence))).toBe(true);
    expect(productSentences.some((sentence) => /피부\s*장벽|보습/u.test(sentence) && /도와|돕/u.test(sentence))).toBe(true);

    expectKoreanWebPageScopeDescription(webPageDescription, "하이드라 배리어 크림", "테스트랩");
    expect(webPageDescription).not.toBe("하이드라 배리어 크림에 대해 제공된 정보를 확인할 수 있는 상품 페이지입니다.");
    expect(webPageDescription).toMatch(/하이드라\s*배리어\s*크림은\s*건조하고\s*민감한\s*피부\s*고객을\s*위한\s*제품으로,[^.]*고밀도\s*세라마이드[^.]*피부\s*장벽[^.]*돕습니다/u);
    expect(webPageDescription).not.toMatch(/고객을\s*위한\s*제품입니다\.\s*주요\s*성분·기술/u);
    expect(webPageDescription).toMatch(/고객\s*리뷰에서\s*고객들은[^.]*촉촉[^.]*사용감[^.]*긍정적으로\s*평가했습니다/u);

    expect(propertyValue("Key ingredients")).toContain("세라마이드");
    expect(propertyValue("Key ingredients")).not.toMatch(/(?:^|,\s*)(?:흡수력|유지력|보습\s*캡슐)(?:,|$)/u);
    expect(propertyValue("Reported details")).not.toMatch(/확인\s*지표\s*:/u);
    expect(propertyValue("Reported details")).not.toMatch(/또한,\s*(?:확인|측정|시험)/u);
    expect(propertyValue("Reported details")).not.toMatch(/^\s*190%[.!。]?\s*$/u);
    expect(propertyValue("Reported details").match(/190%/gu)?.length ?? 0).toBeLessThanOrEqual(1);

    expect(faqText).toMatch(/어떤\s*고객|누구|적합|고민인\s*고객/u);
    expect(faqText).toMatch(/성분|세라마이드/u);
    expect(faqText).toMatch(/효능|효과|보습|장벽/u);
    expect(faqQuestions.slice(0, 3).join(" ")).toMatch(/어떤\s*고객|누구|적합|고민인\s*고객/u);
    expect(faqQuestions.slice(0, 3).join(" ")).toMatch(/성분|세라마이드/u);
  });

  it("reconstructs Korean Product.description from structured evidence without OCR fragments or report-style endings", async () => {
    const productName = "하이드라 리페어 수딩크림";
    const relation = "특허 받은 고밀도 세라마이드 캡슐은 세라마이드, 콜레스테롤, 지방산과 피부지질 유사 층판형 구조를 연결해 피부 장벽의 빈틈을 촘촘하게 하는 기술로 제시됩니다.";
    const structure = "고밀도 세라마이드 캡슐은 롱체인 세라마이드와 링커 세라마이드로 구성됩니다.";
    const sourceText = "샐 틈 없이 탄탄하게, 피부 장벽을 강화 ☑ 1회 사용 직후 손상된 피부 장벽 2.7배 개선 79% 28% 무도포 대조 부위 크림 사용 부위 ※ ㈜글로벌의학연구센터, 2025.09.15-10.14, 수분이 부족한 민감 지성 피부 고민이 있는 만 20~39세 성인 여성 30명 대상 인체적용시험 결과";
    const sample = "수분이 부족한 민감 지성 피부 고민이 있는 만 20~39세 성인 여성 30명";
    const product: PdpProductSignal = {
      name: productName,
      description: `${productName}은 수분이 부족한 민감 지성 피부 고객을 위한 크림입니다.`,
      brand: "테스트랩",
      category: "크림",
      images: [],
      options: [],
      benefits: ["피부 장벽 케어", "속보습"],
      effects: ["손상된 피부 장벽 개선"],
      ingredients: ["압축 히알루론산", "고밀도 세라마이드 캡슐", "롱체인 세라마이드", "링커 세라마이드"],
      usage: ["세안 후 적당량을 피부에 골고루 펴 바릅니다."],
      metrics: [sourceText],
      faq: [],
      reviews: {
        items: [
          { body: "촉촉하고 자극 없이 편안해서 만족스러웠습니다.", rating: 5 },
          { body: "산뜻하면서도 보습감이 좋아 만족합니다.", rating: 5 }
        ],
        keywords: ["촉촉한 사용감", "자극 없이 편안한 사용감", "만족도"]
      },
      breadcrumbs: [],
      sourceTexts: [relation, structure, sourceText],
      semanticFacts: {
        ingredients: ["압축 히알루론산", "고밀도 세라마이드 캡슐", "롱체인 세라마이드", "링커 세라마이드"],
        benefits: ["피부 장벽 케어", "속보습"],
        effects: ["손상된 피부 장벽 개선"],
        skinTypes: ["수분이 부족한 민감 지성 피부"],
        usageSteps: ["세안 후 적당량을 피부에 골고루 펴 바릅니다."],
        safetyTests: ["극민감 피부 테스트 완료", "민감 피부 자극 테스트 완료", "여드름성 피부 사용 적합 테스트 완료", "논코메도제닉 테스트 완료"],
        metricClaims: [{
          label: "손상된 피부 장벽 개선",
          subject: productName,
          value: "2.7",
          unit: "배",
          metric: "손상된 피부 장벽 개선",
          direction: "개선",
          timing: "1회 사용 직후",
          baseline: "무도포 대조 부위 28%",
          comparator: "크림 사용 부위 79%",
          sample,
          period: "2025.09.15-10.14",
          method: "인체적용시험",
          institution: "㈜글로벌의학연구센터",
          evidenceGroup: "완제품 인체적용시험 2025.09.15-10.14",
          sentence: "1회 사용 직후 손상된 피부 장벽이 2.7배 개선되었습니다.",
          sourceText
        }],
        evidenceSentences: [relation, structure, "1회 사용 직후 손상된 피부 장벽이 2.7배 개선되었으며, 무도포 대조 부위 28%와 크림 사용 부위 79%가 함께 측정되었습니다."],
        ingredientBenefitLinks: []
      }
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const description = String(nodes.find((node) => node["@type"] === "Product")?.description ?? "");

    expect(description).not.toMatch(/하는\s*기술(?:이|가)?\s*적용|적용되어\s*있고/u);
    expect(description).not.toMatch(/[☑※□■]|참고할\s*수\s*있는\s*(?:시험|테스트)\s*정보|고객\s*리뷰에서는[^.]*언급됩니다/u);
    expect(description).toMatch(/\(주\)글로벌의학연구센터[^.]*2025년\s*9월\s*15일[^.]*성인\s*여성\s*30명[^.]*인체적용시험/u);
    expect(description).toMatch(/크림\s*사용\s*부위는\s*79%[^.]*무도포\s*대조\s*부위는\s*28%[^.]*1회\s*사용\s*직후\s*손상된\s*피부\s*장벽은\s*2\.7배\s*개선되었습니다/u);
    expect(description).toMatch(/민감하거나\s*트러블이\s*고민인\s*피부까지\s*고려한\s*테스트\s*범위를\s*갖췄습니다/u);
    expect(description).toMatch(/실제\s*고객\s*리뷰에서\s*고객들은[^.]*긍정적으로\s*평가했습니다/u);
  });

  it("places an official efficacy measurement after the supported benefit and before reviews", async () => {
    const base = evidenceRichProduct();
    const officialMetric = "기기 측정 시험에서 사용 2시간 후 피부 수분량이 35% 증가했습니다.";
    const product: PdpProductSignal = {
      ...base,
      metrics: ["고밀도 세라마이드 캡슐 10,000ppm", "평점 4.9", "리뷰 190개", "30% 할인", officialMetric],
      sourceTexts: [...base.sourceTexts, officialMetric],
      semanticFacts: {
        ...base.semanticFacts!,
        metricClaims: [
          ...(base.semanticFacts?.metricClaims ?? []),
          {
            label: "피부 수분량 증가",
            value: "35%",
            timing: "사용 2시간 후",
            method: "기기 측정 시험",
            sentence: officialMetric,
            sourceText: officialMetric
          }
        ],
        evidenceSentences: [...(base.semanticFacts?.evidenceSentences ?? []), officialMetric]
      }
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const webPage = nodes.find((node) => node["@type"] === "WebPage")!;
    const properties = (productNode.additionalProperty as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const reportedDetails = String(properties.find((item) => item.name === "Reported details")?.value ?? "");

    const productDescription = String(productNode.description ?? "");
    const webPageDescription = String(webPage.description ?? "");
    expect(productDescription).toContain("35%");
    expect(productDescription).toMatch(/기기\s*측정\s*시험/u);
    expect(productDescription).toMatch(/사용\s*2시간\s*후/u);
    expect(productDescription).not.toMatch(/10,000\s*ppm|평점\s*4\.9|리뷰\s*190개|30%\s*할인/u);
    expect(productDescription).not.toMatch(/확인\s*지표|평가\s*지표|결과가\s*제시|수치가\s*제시/u);
    expect(productDescription.indexOf("세라마이드")).toBeLessThan(productDescription.indexOf("35%"));
    expect(productDescription.search(/피부\s*장벽|보습|수분\s*케어/u)).toBeLessThan(productDescription.indexOf("35%"));
    expect(productDescription.indexOf("35%")).toBeLessThan(productDescription.indexOf("고객 리뷰"));

    expectKoreanWebPageScopeDescription(webPageDescription, "하이드라 배리어 크림", "테스트랩");
    expect(webPageDescription).not.toMatch(/공식\s*시험·측정\s*결과|35%|기기\s*측정\s*시험|사용\s*2시간\s*후|10,000\s*ppm|평점\s*4\.9|리뷰\s*190개|30%\s*할인/u);

    expect(reportedDetails).toContain("35%");
    expect((run.result.diagnostics.validationRepairs ?? []).filter((repair) => /description/u.test(repair.field))).toHaveLength(0);
  });

  it("connects Korean ingredient, benefit, and source-backed concern with one named composition reminder", async () => {
    const run = await generatePdpGeo({
      product: evidenceRichProduct(),
      hints: { locale: "ko-KR" }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const webPage = nodes.find((node) => node["@type"] === "WebPage")!;
    const productDescription = String(productNode.description ?? "");
    const webPageDescription = String(webPage.description ?? "");

    expect(productDescription.match(/하이드라\s*배리어\s*크림/gu)?.length ?? 0).toBe(2);
    expect(productDescription).toMatch(/하이드라\s*배리어\s*크림의\s*주요\s*성분은/u);
    expect(productDescription).toMatch(/주요\s*성분은\s*고밀도\s*세라마이드\s*캡슐과\s*콜레스테롤이며,\s*피부\s*장벽\s*케어와\s*(?:속보습을|수분\s*케어를)\s*도와\s*건조하고\s*민감한\s*피부가\s*고민인\s*고객에게\s*적합합니다/u);
    expectKoreanWebPageScopeDescription(webPageDescription, "하이드라 배리어 크림", "테스트랩");
    expect(webPageDescription).toMatch(/주요\s*성분·기술(?:인|로)\s*고밀도\s*세라마이드\s*캡슐.*콜레스테롤/u);
    expect(`${productDescription}\n${webPageDescription}`).not.toMatch(/이러한\s*효능[·・]?효과를\s*바탕으로/u);
    expect(productDescription.indexOf("세라마이드")).toBeLessThan(productDescription.indexOf("피부 장벽 케어"));
    expect(productDescription.indexOf("피부 장벽 케어")).toBeLessThan(productDescription.indexOf("고객 리뷰"));
    expect((run.result.diagnostics.validationRepairs ?? []).filter((repair) => /description/u.test(repair.field))).toHaveLength(0);
  });

  it("keeps product-fact ingredient and benefit FAQ when no public review evidence exists", async () => {
    const base = evidenceRichProduct();
    const product: PdpProductSignal = {
      ...base,
      faq: [],
      reviews: { items: [], keywords: [] }
    };
    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const faqItems = (faqPage.mainEntity as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const faqText = JSON.stringify(faqItems);

    expect(String(faqItems[0]?.name ?? "")).toMatch(/고객|추천|적합/u);
    expect(String(faqItems[1]?.name ?? "")).toMatch(/구성\s*성분.*효능[·・]?효과/u);
    expect(faqText).toMatch(/세라마이드/u);
    expect(faqText).toMatch(/피부\s*장벽|보습/u);
    expect(faqText).not.toMatch(/고객\s*리뷰|긍정\s*리뷰|리뷰에서\s*반복/u);
  });

  it("groups footnoted efficacy outcomes with their study context and keeps duration claims distinct", async () => {
    const base = evidenceRichProduct();
    const study = "㈜테스트리서치, 2024.01.02-2024.02.16, 스스로 피부가 민감하다고 느끼고 건조 고민이 있는 여성 32명 대상 인체적용시험 완료 *사용 전 대비 보습량 2배 증가, 손상장벽 2배 개선";
    const product: PdpProductSignal = {
      ...base,
      metrics: [
        "한번만 발라도. 120시간 보습 지속",
        "사용 직후. 보습량 2배* 증가",
        "단 10분 만에. 손상장벽 2배* 개선",
        "캡슐 제형은 비캡슐 대비 190% 높은 잔존 효과이며 원료적 특성에 한한 ex vivo 테스트 결과입니다."
      ],
      effects: ["피부 장벽 강화", "120시간 보습 지속", "사용 직후 보습량 2배 증가", "단 10분 만에 손상장벽 2배 개선"],
      sourceTexts: [...base.sourceTexts, study],
      semanticFacts: {
        ...base.semanticFacts!,
        metricClaims: [
          { sentence: "한번만 발라도. 120시간 보습 지속", sourceText: "한번만 발라도. 120시간 보습 지속" },
          { sentence: "사용 직후. 보습량 2배* 증가", sourceText: "사용 직후. 보습량 2배* 증가" },
          { sentence: "단 10분 만에. 손상장벽 2배* 개선", sourceText: "단 10분 만에. 손상장벽 2배* 개선" }
        ],
        evidenceSentences: [...(base.semanticFacts?.evidenceSentences ?? []), study]
      }
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const webPage = nodes.find((node) => node["@type"] === "WebPage")!;
    const properties = (productNode.additionalProperty as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const reportedDetails = String(properties.find((item) => item.name === "Reported details")?.value ?? "");
    const productDescription = String(productNode.description ?? "");
    const webPageDescription = String(webPage.description ?? "");

    expect(productDescription).toMatch(/주요\s*성분(?:은|인)\s*고밀도\s*세라마이드\s*캡슐과\s*콜레스테롤(?:입니다|이며|로\s*구성(?:됩니다|되며|되어\s*있습니다|되어\s*있으며))/u);
    expect(productDescription).toMatch(/한\s*번\s*사용\s*후\s*보습이\s*120시간\s*지속됩니다/u);
    expect(productDescription).toMatch(/\(주\)테스트리서치/u);
    expect(productDescription).toMatch(/2024년\s*1월\s*2일부터\s*2024년\s*2월\s*16일까지/u);
    expect(productDescription).toMatch(/여성\s*32명/u);
    expect(productDescription).toMatch(/사용\s*직후\s*보습량은\s*사용\s*전\s*대비\s*2배\s*증가/u);
    expect(productDescription).toMatch(/단\s*10분\s*만에\s*손상\s*장벽은\s*사용\s*전\s*대비\s*2배\s*개선/u);
    expect(productDescription).toMatch(/건조하고\s*민감한\s*피부\s*고객을\s*위한\s*크림입니다/u);
    expect(productDescription).not.toMatch(/190%|ex\s*vivo/iu);
    expect(productDescription.indexOf("고밀도 세라마이드 캡슐")).toBeLessThan(productDescription.indexOf("피부 장벽 케어"));
    expect(productDescription.indexOf("피부 장벽 케어")).toBeLessThan(productDescription.indexOf("120시간"));
    expect(productDescription.indexOf("120시간")).toBeLessThan(productDescription.indexOf("고객 리뷰"));

    expectKoreanWebPageScopeDescription(webPageDescription, "하이드라 배리어 크림", "테스트랩");
    expect(webPageDescription).not.toMatch(/공식\s*시험·측정\s*결과|120시간|테스트리서치|여성\s*32명|보습량은|손상\s*장벽은|190%|ex\s*vivo/iu);

    expect(reportedDetails).toMatch(/120시간|\(주\)테스트리서치|여성\s*32명|사용\s*전\s*대비/u);
    expect(reportedDetails.match(/한\s*번\s*사용\s*후\s*보습이\s*120시간\s*지속/gu)?.length ?? 0).toBe(1);
    expect(reportedDetails).toMatch(/원료적\s*특성에\s*한한\s*ex\s*vivo\s*테스트에서[^.!?。！？]*190%[^.!?。！？]*잔존\s*효과가\s*확인/u);
    expect(reportedDetails).not.toMatch(/(?:확인|평가)\s*지표\s*:/u);
    expect(reportedDetails).not.toMatch(/건조하고\s*민감한\s*피부\s*고객에게\s*적합합니다/u);
    expect((run.result.diagnostics.validationRepairs ?? []).filter((repair) => /description/u.test(repair.field))).toHaveLength(0);
  });

  it("writes named Korean ingredient narratives and maps multi-timepoint clinical values into natural prose", async () => {
    const productName = "에스트라 아토베리어365 하이드로 수딩크림";
    const compressedHyaluronicAcid = "압축 히알루론산은 특허 기술로 1/100 사이즈로 압축한 히알루론산의 흡수 빠른 수분 충전으로 탁월한 수분 지속 효과를 표방하며 원료적 특성에 한한다고 안내됩니다.";
    const capsuleStructure = "고밀도 세라마이드 캡슐은 롱체인 세라마이드와 링커 세라마이드로 구성됩니다.";
    const moistureBarrierIngredients = "제품의 수분 장벽 성분으로 더마온, 히알루론산, 판테놀이 표시됩니다.";
    const patentedCapsule = "고밀도 세라마이드 캡슐은 세라마이드·콜레스테롤·지방산의 피부지질 구성성분과 피부지질 유사 층판형 구조를 결합해 피부 장벽의 빈틈을 촘촘하게 하는 특허 받은 캡슐로 설명됩니다.";
    const balanceSource = "유수분 밸런스 개선 81.0 35.8 61.7 사용 전 사용 직후 사용 12시간 후";
    const sample = "스스로 수분이 부족한 지성 피부라고 느끼고 민감 고민이 있고, 눈에 띄는 모공이 있는 만 20~39세 성인 여성 30명";
    const product: PdpProductSignal = {
      name: productName,
      description: "민감하고 수분이 부족한 지성 피부의 유수분 밸런스를 위한 장벽 수분 크림입니다.",
      brand: "AESTURA",
      category: "크림",
      images: [],
      options: [],
      benefits: ["피부 장벽 케어", "수분 케어"],
      effects: ["유수분 밸런스 개선"],
      ingredients: [
        "압축 히알루론산",
        "고밀도 세라마이드 캡슐",
        "롱체인 세라마이드",
        "링커 세라마이드",
        "세라마이드",
        "콜레스테롤",
        "지방산",
        "더마온",
        "히알루론산",
        "판테놀"
      ],
      usage: [],
      metrics: [balanceSource],
      faq: [],
      breadcrumbs: [],
      sourceTexts: [compressedHyaluronicAcid, capsuleStructure, moistureBarrierIngredients, patentedCapsule, balanceSource],
      reviews: {
        items: [{ body: "촉촉하고 자극 없이 편안해서 만족합니다." }],
        keywords: ["촉촉한 사용감", "편안한 사용감"]
      },
      semanticFacts: {
        ingredients: [
          "압축 히알루론산",
          "고밀도 세라마이드 캡슐",
          "롱체인 세라마이드",
          "링커 세라마이드",
          "세라마이드",
          "콜레스테롤",
          "지방산",
          "더마온",
          "히알루론산",
          "판테놀"
        ],
        benefits: ["피부 장벽 케어", "수분 케어"],
        effects: ["유수분 밸런스 개선"],
        skinTypes: ["수분 부족형 민감 지성 피부", "복합성 피부"],
        usageSteps: [],
        metricClaims: [{
          label: "유수분 밸런스",
          subject: productName,
          value: "81.0 / 35.8 / 61.7",
          metric: "유수분 밸런스 지표",
          direction: "개선",
          timing: "사용 전, 사용 직후, 사용 12시간 후",
          baseline: "사용 전",
          period: "2025.09.15-10.14",
          sample,
          method: "인체적용시험",
          institution: "㈜글로벌의학연구센터",
          evidenceGroup: "유수분 인체적용시험",
          sentence: "유수분 밸런스 개선 지표로 81.0, 35.8, 61.7이 사용 전·사용 직후·사용 12시간 후와 함께 표시됩니다.",
          sourceText: balanceSource
        }],
        evidenceSentences: [compressedHyaluronicAcid, capsuleStructure, moistureBarrierIngredients, patentedCapsule, balanceSource],
        ingredientBenefitLinks: []
      }
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR", market: "KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph
      .filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const description = String(productNode.description ?? "");
    const faqQuestions = (faqPage.mainEntity as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item))
      .map((item) => String(item.name));

    expect(description).toContain(`${productName}의 주요 성분은 압축 히알루론산과 고밀도 세라마이드 캡슐입니다`);
    expect(description).toContain("고밀도 세라마이드 캡슐은 롱체인 세라마이드와 링커 세라마이드로 구성됩니다");
    expect(description).toContain("제품의 구성성분인 더마온, 히알루론산, 판테놀이 수분 장벽 강화 효능을 돕습니다");
    expect(description).toContain("특히 압축 히알루론산은 특허 기술로 1/100 사이즈로 압축한 히알루론산의 흡수 빠른 수분 충전으로 탁월한 수분 지속 효과가 있습니다");
    expect(description).toContain("또한 고밀도 세라마이드 캡슐은 세라마이드·콜레스테롤·지방산의 피부지질 구성성분과 피부지질 유사 층판형 구조를 결합해 피부 장벽의 빈틈을 촘촘하게 하는 특허 받은 캡슐입니다");
    expect(description).not.toContain("원료 특성으입니다");
    expect(description).toContain("압축 히알루론산과 고밀도 세라마이드 캡슐이 포함된 " + productName + "은 피부 장벽 케어와 수분 케어에 효과적입니다");
    expect(description).not.toContain("압축 히알루론산과 고밀도 세라마이드 캡슐을 통해");
    expect(description).toContain(`(주)글로벌의학연구센터가 2025년 9월 15일부터 2025년 10월 14일까지 ${sample}을 대상으로 진행한 인체적용시험에서 유수분 밸런스 개선 지표는 사용 전 81.0, 사용 직후 35.8, 사용 12시간 후 61.7로 각각 측정되었습니다`);
    expect(description).not.toMatch(/유수분 밸런스\s+81\.0\s*\/\s*35\.8\s*\/\s*61\.7\s*\(시점|비교 기준|기간\s*2025\.09\.15/u);
    expect(faqQuestions).toContain(`${productName}의 주요 효능·효과는 무엇이며, 공개된 인체적용시험 결과는 어떻게 나타났나요?`);
    expect(faqQuestions.join("\n")).not.toMatch(/이를 뒷받침하는 상품 근거/u);
  });

  it("normalizes Korean eu-ro explanatory endings without producing a broken copula", async () => {
    const productName = "하이드라 원료 특성 크림";
    const structure = "고밀도 세라마이드 캡슐은 롱체인 세라마이드와 링커 세라마이드로 구성됩니다.";
    const rawMaterialCharacteristic = "압축 히알루론산은 빠른 수분 충전과 수분 지속을 돕는 원료 특성으로 설명됩니다.";
    const product: PdpProductSignal = {
      name: productName,
      description: "수분이 부족한 피부 고객을 위한 수분 크림입니다.",
      category: "크림",
      images: [],
      options: [],
      benefits: ["수분 케어"],
      effects: [],
      ingredients: ["압축 히알루론산", "고밀도 세라마이드 캡슐", "롱체인 세라마이드", "링커 세라마이드"],
      usage: [],
      metrics: [],
      faq: [],
      breadcrumbs: [],
      sourceTexts: [structure, rawMaterialCharacteristic],
      reviews: { items: [], keywords: [] },
      semanticFacts: {
        ingredients: ["압축 히알루론산", "고밀도 세라마이드 캡슐", "롱체인 세라마이드", "링커 세라마이드"],
        benefits: ["수분 케어"],
        effects: [],
        skinTypes: ["수분이 부족한 피부"],
        usageSteps: [],
        metricClaims: [],
        evidenceSentences: [structure, rawMaterialCharacteristic],
        ingredientBenefitLinks: []
      }
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const productNode = graph
      .filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node))
      .find((node) => node["@type"] === "Product")!;
    const description = String(productNode.description ?? "");

    expect(description).toContain("압축 히알루론산은 빠른 수분 충전과 수분 지속을 돕는 원료 특성입니다");
    expect(description).not.toContain("원료 특성으입니다");
  });

  it("turns AESTURA oil-dehydration CEP and same-study oil metrics into connected WebPage and Product narratives", async () => {
    const productName = "에스트라 아토베리어365 하이드로 수딩크림";
    const sample = "스스로 수분이 부족한 지성 피부라고 느끼고 민감 고민이 있고, 눈에 띄는 모공이 있는 만 20~39세 성인 여성 30명";
    const oilSource = `과잉 분비된 유분을 조절 사용 직후 유분량 55% 개선 12시간 후에도 23% 개선 ※㈜글로벌의학연구센터, 2025.09.15-10.14, ${sample} 대상 인체적용시험 결과`;
    const product: PdpProductSignal = {
      name: productName,
      brand: "AESTURA",
      description: "민감하고 수분이 부족한 지성 피부의 유수분 밸런스를 맞추고 속수분을 채워주는 장벽 수분 크림입니다.",
      category: "크림",
      images: [],
      options: ["80 mL"],
      benefits: ["피부 장벽 케어", "수분 케어"],
      effects: ["유수분 밸런스 개선", "과잉 유분 컨트롤"],
      ingredients: ["압축 히알루론산", "고밀도 세라마이드 캡슐", "롱체인 세라마이드", "링커 세라마이드"],
      usage: ["아침과 저녁 세안 후 크림 단계에서 골고루 펴 바릅니다."],
      metrics: [oilSource],
      faq: [],
      breadcrumbs: [],
      sourceTexts: [
        "추천 피부 타입은 수분 부족형 민감 지성 피부이며, 수부지/복합성 피부에 끈적임 없이 산뜻한 수분 수딩 크림으로 추천됩니다.",
        "압축 히알루론산은 빠른 수분 충전과 수분 지속을 돕습니다.",
        "고밀도 세라마이드 캡슐은 롱체인 세라마이드와 링커 세라마이드로 구성되며 장벽 보습을 돕습니다.",
        oilSource
      ],
      reviews: {
        items: [{ body: "촉촉하면서도 자극 없이 편안하고 산뜻하게 사용할 수 있어 만족합니다." }],
        keywords: ["촉촉한 사용감", "자극 없이 편안한 사용감"]
      },
      semanticFacts: {
        ingredients: ["압축 히알루론산", "고밀도 세라마이드 캡슐", "롱체인 세라마이드", "링커 세라마이드"],
        benefits: ["피부 장벽 케어", "수분 케어"],
        effects: ["유수분 밸런스 개선", "과잉 유분 컨트롤"],
        skinTypes: ["수분 부족형 민감 지성 피부", "수부지/복합성 피부"],
        usageSteps: ["아침과 저녁 세안 후 크림 단계에서 골고루 펴 바릅니다."],
        safetyTests: ["극민감 피부 테스트 완료", "민감 피부 자극 테스트 완료", "여드름성 피부 사용 적합 테스트 완료", "논코메도제닉 테스트 완료"],
        metricClaims: [
          {
            label: "사용 직후 유분량 개선",
            subject: "과잉 분비된 유분",
            value: "55",
            unit: "%",
            metric: "유분량 개선",
            direction: "개선",
            timing: "사용 직후",
            baseline: "사용 전",
            period: "2025.09.15-10.14",
            sample,
            method: "인체적용시험",
            institution: "㈜글로벌의학연구센터",
            evidenceGroup: "쿨링·붉은기·유수분·유분 인체적용시험",
            sentence: "과잉 분비된 유분은 사용 직후 유분량 55% 개선으로 제시됩니다.",
            sourceText: oilSource
          },
          {
            label: "12시간 후 유분량 개선",
            subject: "과잉 분비된 유분",
            value: "23",
            unit: "%",
            metric: "유분량 개선",
            direction: "개선",
            timing: "사용 12시간 후",
            baseline: "사용 전",
            period: "2025.09.15-10.14",
            sample,
            method: "인체적용시험",
            institution: "㈜글로벌의학연구센터",
            evidenceGroup: "쿨링·붉은기·유수분·유분 인체적용시험",
            sentence: "과잉 분비된 유분은 12시간 후에도 23% 개선으로 제시됩니다.",
            sourceText: oilSource
          }
        ],
        evidenceSentences: [oilSource],
        ingredientBenefitLinks: [
          { ingredient: "압축 히알루론산", benefit: "수분 케어", sentence: "압축 히알루론산은 빠른 수분 충전과 수분 지속을 돕습니다." },
          { ingredient: "고밀도 세라마이드 캡슐", benefit: "피부 장벽 케어", sentence: "고밀도 세라마이드 캡슐은 장벽 보습을 돕습니다." }
        ]
      }
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR", market: "KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productDescription = String(nodes.find((node) => node["@type"] === "Product")?.description ?? "");
    const webPageDescription = String(nodes.find((node) => node["@type"] === "WebPage")?.description ?? "");
    const groupedStudy = `(주)글로벌의학연구센터가 2025년 9월 15일부터 2025년 10월 14일까지 ${sample}을 대상으로 진행한 인체적용시험에서 유분량은 사용 전 대비 사용 직후 55%, 12시간 후에도 23% 개선되었습니다`;

    expect(productDescription).toMatch(/유분이 많지만 수분이 부족한/u);
    expect(productDescription).toMatch(/수분 부족형 민감 지성 피부|수부지·복합성 피부/u);
    expect(productDescription).toContain(groupedStudy);
    expect(productDescription).not.toContain("과잉 분비된 유분을 조절 사용 직후");
    expect(productDescription).not.toMatch(/크림입니다\. 특히/u);
    expect(productDescription.indexOf("수분이 부족한")).toBeLessThan(productDescription.indexOf("압축 히알루론산"));
    expect(productDescription.indexOf("압축 히알루론산")).toBeLessThan(productDescription.indexOf("55%"));
    expect(productDescription.indexOf("55%")).toBeLessThan(productDescription.indexOf("실제 고객 리뷰"));

    expect(webPageDescription).toContain(`${productName} 상품 페이지`);
    expect(webPageDescription).toContain(productName);
    expect(webPageDescription).toContain(groupedStudy);
    expect(webPageDescription).not.toMatch(/페이지 본문에서는|페이지에서 확인할 수 있는|페이지에 공개된/u);
    expect(webPageDescription).not.toContain("과잉 분비된 유분을 조절 사용 직후");
  });

  it("turns AESTURA FAQ evidence into CEP recommendations instead of source and formula dumps", async () => {
    const productName = "에스트라 아토베리어365 하이드로 수딩크림";
    const studyPeriod = "2025.09.15-10.14";
    const sample = "스스로 수분이 부족한 지성 피부라고 느끼고 민감 고민이 있고, 눈에 띄는 모공이 있는 만 20~39세 성인 여성 30명";
    const coolingFormula = "쿨링을 주는 화학적 성분은 사용하지 않고 수분감을 높인 워터 크림 특화 제형을 통해 피부에 닿음과 동시에 시원하고 산뜻한 쿨링감을 줄 수 있게 설계되었습니다.";
    const lifeStageAnswer = "소아과 피부 테스트를 진행한 품목으로 영유아, 어린이가 사용해도 무방하며, 임산부가 우려할 만한 성분도 함유되어 있지 않습니다. 우려가 되는 경우 귀 뒤나 팔 안쪽에 먼저 테스트하고 필요 시 전문가와 상담 후 사용하시기 바랍니다.";
    const product: PdpProductSignal = {
      name: productName,
      brand: "AESTURA",
      description: "민감하고 수분이 부족한 지성·수부지·복합성 피부를 위한 장벽 수분 크림입니다.",
      category: "크림",
      images: [],
      options: ["80 mL"],
      breadcrumbs: [],
      ingredients: ["DermaON® + HA", "압축 히알루론산", "징크", "고밀도 세라마이드 캡슐"],
      benefits: ["피부 장벽 관리", "수분 케어", "즉각적인 쿨링 진정"],
      effects: ["일시적인 붉은기 완화", "과잉 유분 컨트롤", "72시간 수분 지속 효과"],
      usage: [],
      metrics: [
        "제품 사용 직후 일시적 붉은기가 가온 후 대비 70.5% 개선되었습니다.",
        "제품 사용 직후 즉각적인 쿨링 효과 -5.5°C"
      ],
      faq: [
        { question: "쿨링 효과는 어떤 성분이 해주는 것인가요?", answer: coolingFormula },
        { question: "영유아나 임산부가 사용해도 되나요?", answer: lifeStageAnswer }
      ],
      sourceTexts: [coolingFormula, lifeStageAnswer],
      reviews: {
        items: [{ body: "촉촉하고 자극 없이 편안하면서 산뜻하게 사용할 수 있어 만족합니다." }],
        keywords: ["촉촉한 사용감", "자극 없이 편안한 사용감"]
      },
      semanticFacts: {
        ingredients: ["DermaON® + HA", "압축 히알루론산", "징크", "고밀도 세라마이드 캡슐"],
        benefits: ["피부 장벽 관리", "수분 케어", "즉각적인 쿨링 진정"],
        effects: ["일시적인 붉은기 완화", "과잉 유분 컨트롤", "72시간 수분 지속 효과"],
        skinTypes: ["지성 피부", "수부지", "복합성 피부", "민감 피부"],
        usageSteps: [],
        safetyTests: ["소아과 피부 테스트 완료"],
        metricClaims: [
          {
            label: "제품 사용 직후 일시적 붉은기 완화",
            subject: "일시적 붉은기",
            value: "70.5",
            unit: "%",
            metric: "일시적 붉은기 완화",
            direction: "개선",
            timing: "제품 사용 직후",
            baseline: "가온 후",
            period: studyPeriod,
            sample,
            method: "인체적용시험",
            institution: "㈜글로벌의학연구센터",
            evidenceGroup: "쿨링·붉은기 인체적용시험",
            sentence: "제품 사용 직후 일시적 붉은기는 가온 후 대비 70.5% 개선되었습니다.",
            sourceText: "가온 후 제품 사용 직후 일시적 붉은기 완화 70.5%"
          },
          {
            label: "제품 사용 직후 즉각적인 쿨링 효과",
            subject: "즉각적인 쿨링 효과",
            value: "-5.5",
            unit: "°C",
            metric: "즉각적인 쿨링 효과",
            direction: "확인",
            timing: "제품 사용 직후",
            baseline: "가온 후",
            period: studyPeriod,
            sample,
            method: "인체적용시험",
            institution: "㈜글로벌의학연구센터",
            evidenceGroup: "쿨링·붉은기 인체적용시험",
            sentence: "제품 사용 직후 즉각적인 쿨링 효과는 -5.5°C로 확인되었습니다.",
            sourceText: "제품 사용 직후 즉각적인 쿨링 효과 -5.5°C"
          }
        ],
        evidenceSentences: [coolingFormula, lifeStageAnswer],
        ingredientBenefitLinks: [
          { ingredient: "압축 히알루론산", benefit: "수분 케어", sentence: "압축 히알루론산은 빠른 수분 충전과 수분 지속을 돕습니다." },
          { ingredient: "징크", benefit: "과잉 유분 컨트롤", sentence: "징크는 과잉 유분 컨트롤을 돕습니다." },
          { ingredient: "고밀도 세라마이드 캡슐", benefit: "피부 장벽 관리", sentence: "고밀도 세라마이드 캡슐은 피부 장벽 관리를 돕습니다." }
        ]
      }
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR", market: "KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const faqPage = graph
      .filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node))
      .find((node) => node["@type"] === "FAQPage")!;
    const faqItems = (faqPage.mainEntity as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const answerFor = (pattern: RegExp): string => {
      const item = faqItems.find((candidate) => pattern.test(String(candidate.name ?? "")));
      return String((item?.acceptedAnswer as Record<string, JsonValue> | undefined)?.text ?? "");
    };

    const suitability = answerFor(/피부\s*장벽|민감한\s*피부/u);
    const composition = answerFor(/구성\s*성분과\s*효능/u);
    const cooling = answerFor(/땀을\s*많이\s*흘리거나\s*더위를\s*많이/u);
    const lifeStage = answerFor(/영유아나\s*임산부/u);

    expect(suitability).toContain(productName);
    expect(suitability).toMatch(/\(주\)글로벌의학연구센터.*2025년\s*9월\s*15일부터\s*2025년\s*10월\s*14일까지.*70\.5%/u);
    expect(suitability).toMatch(/이\s*결과는\s*민감\s*피부의\s*진정\s*관리\s*효능을\s*뒷받침합니다/u);
    expect(suitability).not.toMatch(/눈에\s*띄는\s*모공|2025\.09\.15|설명됩니다|안내됩니다/u);

    expect(composition).toMatch(/유분이\s*많지만\s*수분이\s*부족한/u);
    expect(composition).toMatch(/주요\s*성분·기술로\s*구성한/u);
    expect(composition).toMatch(/압축\s*히알루론산은[^.]*수분\s*케어를\s*돕습니다/u);
    expect(composition).toMatch(/완제품은[^.]*피부\s*장벽[^.]*수분/u);
    expect(composition).not.toMatch(/설명됩니다|안내됩니다|특정\s*성분이[^.]*단독/u);

    expect(cooling, JSON.stringify(faqItems, null, 2)).toContain(productName);
    expect(cooling).toMatch(/워터\s*크림\s*특화\s*제형/u);
    expect(cooling).toMatch(/제품\s*사용\s*직후[^.]*-5\.5°C로\s*확인되었습니다/u);
    expect(cooling).toMatch(/더위를\s*많이\s*느끼거나\s*땀을\s*흘린\s*뒤[^.]*추천할\s*수\s*있습니다/u);
    expect(cooling).not.toMatch(/땀\s*(?:조절|억제|감소)|열(?:사병|치료)|화학적\s*성분/u);

    expect(lifeStage).toContain(productName);
    expect(lifeStage).toMatch(/소아과\s*피부\s*테스트를\s*진행했습니다/u);
    expect(lifeStage).toMatch(/영유아와\s*어린이가\s*사용할\s*수\s*있으며[^.]*임산부/u);
    expect(lifeStage).toMatch(/추천할\s*수\s*있습니다/u);
    expect(lifeStage).toMatch(/귀\s*뒤나\s*팔\s*안쪽|전문가와\s*상담/u);
    expect(lifeStage).not.toMatch(/설명됩니다|안내됩니다/u);
  });

  it("adopts an evidence-gated CEP WebPage narrative instead of rebuilding it from fixed sentence templates", async () => {
    const productName = "에스트라 아토베리어365 하이드로 수딩크림";
    const evidenceGroup = "완제품 인체적용시험 2025.09.15-10.14";
    const sample = "스스로 수분이 부족한 지성 피부라고 느끼는 만 20~39세 성인 여성 30명";
    const product: PdpProductSignal = {
      name: productName,
      brand: "AESTURA",
      category: "크림",
      description: "민감하고 수분이 부족한 지성 피부의 유수분 밸런스를 맞추고 속수분을 채워주는 장벽 수분 크림입니다.",
      price: { raw: "33000.0", amount: 33000, currency: "KRW" },
      images: [],
      options: ["2.70 fl. oz. / 80 mL"],
      breadcrumbs: [],
      ingredients: ["DermaON® 기술", "압축 히알루론산", "저분자 히알루론산"],
      benefits: ["피부 장벽 케어", "수분 케어", "진정 케어"],
      effects: ["속수분 충전", "수분 지속"],
      usage: ["아침, 저녁 세안 후 크림 사용 단계에서 적당량을 덜어 사용합니다."],
      metrics: [
        "완제품 인체적용시험에서 사용 직후 10층 속수분 충전 효과가 확인되었습니다.",
        "같은 완제품 인체적용시험에서 1회 사용 후 수분 효과가 72시간 동안 지속되었습니다."
      ],
      faq: [],
      sourceTexts: [
        "아침, 저녁 세안 후 크림 사용 단계에서 적당량을 덜어 사용합니다.",
        "극민감 테스트, 민감 피부 자극 테스트, 피부과 테스트 완료",
        "완제품 인체적용시험에서 사용 직후 10층 속수분 충전과 1회 사용 후 72시간 수분 지속이 확인되었습니다."
      ],
      reviews: {
        items: [
          { body: "촉촉하고 자극 없이 편안해서 만족합니다." },
          { body: "끈적임 없이 산뜻하고 흡수가 빨라요." },
          { body: "발림성과 쿨링감이 좋고 보습력도 만족스러워요." }
        ],
        keywords: ["발림성", "쿨링감", "보습력", "만족"]
      },
      semanticFacts: {
        ingredients: ["DermaON® 기술", "압축 히알루론산", "저분자 히알루론산"],
        benefits: ["피부 장벽 케어", "수분 케어", "진정 케어"],
        effects: ["속수분 충전", "수분 지속"],
        skinTypes: ["민감하고 수분이 부족한 지성 피부", "복합성 피부"],
        usageSteps: ["아침, 저녁 세안 후 크림 사용 단계에서 적당량을 덜어 사용합니다."],
        safetyTests: ["극민감 테스트 완료", "민감 피부 자극 테스트 완료", "피부과 테스트 완료"],
        metricClaims: [
          {
            label: "10층 속수분 충전",
            subject: productName,
            value: "10",
            unit: "층",
            metric: "속수분 충전 깊이",
            direction: "충전",
            timing: "사용 직후",
            sample,
            method: "인체적용시험",
            institution: "㈜글로벌의학연구센터",
            evidenceGroup,
            sentence: "사용 직후 즉각적인 10층 속수분 충전 효과가 확인되었습니다.",
            sourceText: "사용 직후 10층 속수분 충전"
          },
          {
            label: "수분 지속",
            subject: productName,
            value: "72",
            unit: "시간",
            metric: "수분 지속",
            direction: "지속",
            timing: "1회 사용 후",
            period: "72시간",
            sample,
            method: "인체적용시험",
            institution: "㈜글로벌의학연구센터",
            evidenceGroup,
            sentence: "1회 사용 후 수분 효과가 72시간 동안 지속되었습니다.",
            sourceText: "1회 사용 후 72시간 수분 지속"
          }
        ],
        evidenceSentences: [
          "완제품 인체적용시험에서 사용 직후 10층 속수분 충전과 1회 사용 후 72시간 수분 지속이 확인되었습니다.",
          "극민감 테스트, 민감 피부 자극 테스트, 피부과 테스트 완료"
        ],
        ingredientBenefitLinks: []
      }
    };

    const plannedDescription = [
      `${productName} 상품 페이지는 AESTURA가 선보이는 장벽 수분 크림의 특징과 제품 선택에 필요한 정보를 한데 담고 있습니다.`,
      "유분이 많지만 수분이 부족한 지성·복합성 피부 고객을 위한 이 제품은 DermaON® 기술, 압축 히알루론산, 저분자 히알루론산을 주요 성분·기술로 포함하고 피부 장벽 케어, 수분 케어와 진정 케어를 돕습니다.",
      `${productName}은 아침과 저녁 세안 후 사용하는 것을 권장합니다.`,
      "완제품 인체적용시험에서 사용 직후 10층 속수분 충전 효과가 입증되었으며, 같은 시험에서 1회 사용 후 수분 효과가 72시간 동안 지속되는 것으로 확인되었습니다.",
      "또한 극민감 테스트, 민감 피부 자극 테스트, 피부과 테스트 등을 완료해 민감 피부를 고려한 안전성을 입증했습니다.",
      `${productName}은 2.70 fl. oz. / 80 mL 옵션으로 구성되어 있으며, 33,000원에 판매되고 있습니다.`,
      `고객 리뷰에서 고객들은 ${productName}의 촉촉하고 자극 없이 편안한 사용감, 산뜻한 마무리와 보습력을 긍정적으로 평가했습니다.`
    ].join(" ");
    const normalizedForLedger = normalizePdpProduct(product, { hints: { locale: "ko-KR", market: "KR" } }).product;
    const evidenceIds = createPdpGeoEvidenceLedger(normalizedForLedger, "ko-KR").map((item) => item.id);
    const plan = planPayload({
      webPageDescription: {
        include: true,
        text: plannedDescription,
        intent: "page-coverage-cep-narrative",
        evidenceIds,
        confidence: 0.98,
        omitReason: ""
      },
      cep: [{
        situation: "유분이 많지만 수분이 부족한 지성·복합성 피부",
        need: "피부 장벽 케어, 수분 케어와 진정 케어",
        constraint: "아침과 저녁 세안 후 사용하는 루틴",
        evidenceIds,
        confidence: 0.96
      }]
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(plan) }] }]
    }), { status: 200 })));
    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR", market: "KR" } }, {
      contentPlanning: { enabled: true, provider: "openai", apiKey: "key", model: "gpt-test" }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const webPage = graph
      .filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node))
      .find((node) => node["@type"] === "WebPage")!;
    const description = String(webPage.description ?? "");

    expect(
      run.result.diagnostics.contentPlan?.webPageDescription.include,
      JSON.stringify(run.result.diagnostics.contentPlan?.warnings ?? [])
    ).toBe(true);
    expect(description).toBe(plannedDescription);
    expect(description).toMatch(new RegExp(`${productName} 상품 페이지는 AESTURA가 선보이는 장벽 수분 크림의 특징과 제품 선택에 필요한 정보를 한데 담고 있습니다`, "u"));
    expect(description).not.toMatch(/AESTURA의[^.]*크림 상품을 소개합니다/u);
    expect(description).toMatch(new RegExp(`${productName}은 아침과 저녁 세안 후 사용하는 것을 권장합니다`, "u"));
    expect(description).toMatch(/완제품 인체적용시험에서 사용 직후 10층 속수분 충전 효과가 입증되었으며, 같은 시험에서 1회 사용 후 수분 효과가 72시간 동안 지속되는 것으로 확인되었습니다/u);
    expect(description).not.toMatch(/10층 속수분 충전은 10층 충전되었습니다/u);
    expect(description).toMatch(/극민감 테스트, 민감 피부 자극 테스트, 피부과 테스트 등을 완료해 민감 피부를 고려한 안전성을 입증했습니다/u);
    expect(description).toMatch(new RegExp(`${productName}은 2\\.70 fl\\. oz\\. / 80 mL 옵션으로 구성되어 있으며, 33,000원에 판매되고 있습니다`, "u"));
    expect(description).toMatch(new RegExp(`고객 리뷰에서 고객들은 ${productName}의 [^.]*촉촉하고 자극 없이 편안한 사용감[^.]*긍정적으로 평가했습니다`, "u"));
    expect(description).not.toMatch(/고객 리뷰에서는 보습력이 언급됩니다/u);
  });

  it("uses explicit metric footnote markers to join atomic outcomes with one unambiguous study context", async () => {
    const base = evidenceRichProduct();
    const study = "㈜풋노트리서치, 2025.01.06-2025.02.14, 건조하고 민감한 피부 고민이 있는 성인 30명 대상 인체적용시험 완료";
    const product: PdpProductSignal = {
      ...base,
      metrics: [
        "한번만 발라도. 96시간 보습 지속",
        "사용 직후. 보습량 1.8배* 증가",
        "단 15분 만에. 손상장벽 1.6배* 개선"
      ],
      sourceTexts: [...base.sourceTexts, study],
      semanticFacts: {
        ...base.semanticFacts!,
        metricClaims: [
          { sentence: "한번만 발라도. 96시간 보습 지속", sourceText: "한번만 발라도. 96시간 보습 지속" },
          { sentence: "사용 직후. 보습량 1.8배* 증가", sourceText: "사용 직후. 보습량 1.8배* 증가" },
          { sentence: "단 15분 만에. 손상장벽 1.6배* 개선", sourceText: "단 15분 만에. 손상장벽 1.6배* 개선" }
        ],
        evidenceSentences: [...(base.semanticFacts?.evidenceSentences ?? []), study]
      }
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productDescription = String(nodes.find((node) => node["@type"] === "Product")?.description ?? "");
    const webPageDescription = String(nodes.find((node) => node["@type"] === "WebPage")?.description ?? "");

    expect(productDescription).toMatch(/한\s*번\s*사용\s*후\s*보습이\s*96시간\s*지속/u);
    expect(productDescription).toMatch(/\(주\)풋노트리서치[^.!?。！？]*성인\s*30명[^.!?。！？]*인체적용시험/u);
    expect(productDescription).toMatch(/사용\s*직후\s*보습량은\s*1\.8배\s*증가/u);
    expect(productDescription).toMatch(/단\s*15분\s*만에\s*손상\s*장벽은\s*1\.6배\s*개선/u);
    expect(productDescription).not.toMatch(/사용\s*전\s*대비/u);
    expect(productDescription).not.toMatch(/\*|인체적용시험\s*완료/u);

    expectKoreanWebPageScopeDescription(webPageDescription, "하이드라 배리어 크림", "테스트랩");
    expect(webPageDescription).not.toMatch(/96시간|풋노트리서치|성인\s*30명|1\.8배|1\.6배/u);
  });

  it("groups arbitrary source-backed duration and study values without product-specific numbers", async () => {
    const base = evidenceRichProduct();
    const study = "㈜뉴리서치, 2025.04.01-2025.05.15, 건조 피부 고민이 있는 여성 28명 대상 인체적용시험 완료 *사용 전 대비 피부 수분량 38% 증가, 피부 장벽 지표 27% 개선";
    const product: PdpProductSignal = {
      ...base,
      benefits: ["피부 장벽 보습", "72시간 수분 지속"],
      effects: ["피부 수분량 증가", "피부 장벽 지표 개선"],
      metrics: [
        "한 번 사용 후 수분이 72시간 지속됩니다.",
        "사용 30분 후 피부 수분량 38% 증가",
        "사용 2주 후 피부 장벽 지표 27% 개선"
      ],
      sourceTexts: [...base.sourceTexts, study],
      semanticFacts: {
        ...base.semanticFacts!,
        metricClaims: [
          { sentence: "한 번 사용 후 수분이 72시간 지속됩니다.", sourceText: "한 번 사용 후 수분이 72시간 지속됩니다." },
          { sentence: "사용 30분 후 피부 수분량 38% 증가", sourceText: "사용 30분 후 피부 수분량 38% 증가" },
          { sentence: "사용 2주 후 피부 장벽 지표 27% 개선", sourceText: "사용 2주 후 피부 장벽 지표 27% 개선" }
        ],
        evidenceSentences: [...(base.semanticFacts?.evidenceSentences ?? []), study]
      }
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productDescription = String(nodes.find((node) => node["@type"] === "Product")?.description ?? "");
    const webPageDescription = String(nodes.find((node) => node["@type"] === "WebPage")?.description ?? "");

    expect(productDescription).toMatch(/수분이\s*72시간\s*지속/u);
    expect(productDescription).toContain("(주)뉴리서치");
    expect(productDescription).toMatch(/여성\s*28명/u);
    expect(productDescription).toMatch(/사용\s*전\s*대비\s*38%\s*증가/u);
    expect(productDescription).toMatch(/사용\s*전\s*대비\s*27%\s*개선/u);
    expect(productDescription).not.toMatch(/120시간|2배/u);

    expectKoreanWebPageScopeDescription(webPageDescription, "하이드라 배리어 크림", "테스트랩");
    expect(webPageDescription).not.toMatch(/72시간|뉴리서치|여성\s*28명|38%|27%|120시간|2배/u);
  });

  it("classifies a concrete ingredient over its generic class and atomizes reverse-order OCR outcomes", async () => {
    const ingredientEvidence = "니아신아마이드는 비타민 B3로 소개되며 피부 장벽을 개선하는 데 효과적인 성분입니다.";
    const study = "사용 직후 계절성 건조로 인한. 들뜬 각질 개선 (41.7%) 사용 6주 후 건조로 인해. 거칠어진 피부결 개선 (8.4%) ※ ㈜범용리서치, 2025.04.03-05.14, 계절성 건조를 느끼는 성인 29명 대상 인체적용시험 완료 *사용 전 대비 들뜬 각질 41.7% 개선, 거칠어진 피부결 8.4% 개선";
    const product: PdpProductSignal = {
      name: "범용 배리어 로션",
      description: "건조하고 민감한 피부의 피부 장벽 보습을 돕는 로션입니다.",
      category: "로션",
      images: [],
      options: [],
      ingredients: ["고밀도 세라마이드 캡슐", "비타민"],
      benefits: ["피부 장벽 보습", "건조로 인해 거칠어진 피부결 개선"],
      effects: ["들뜬 각질 개선", "거칠어진 피부결 개선"],
      usage: [],
      metrics: [
        "사용 직후 계절성 건조로 인한. 들뜬 각질 개선 (41.7%)",
        "사용 6주 후 건조로 인해. 거칠어진 피부결 개선 (8.4%)"
      ],
      faq: [],
      reviews: {
        keywords: ["촉촉한 사용감", "끈적임이 적은 마무리"],
        items: [{ body: "촉촉하면서 끈적임이 적은 마무리가 만족스러웠습니다.", rating: 5 }]
      },
      breadcrumbs: [],
      sourceTexts: [ingredientEvidence, study],
      semanticFacts: {
        ingredients: ["고밀도 세라마이드 캡슐"],
        benefits: ["피부 장벽 보습"],
        effects: ["들뜬 각질 개선", "거칠어진 피부결 개선"],
        skinTypes: ["건조하고 민감한 피부"],
        usageSteps: [],
        safetyTests: [],
        metricClaims: [
          { sentence: "사용 직후 계절성 건조로 인한. 들뜬 각질 개선 (41.7%)", sourceText: "사용 직후 계절성 건조로 인한. 들뜬 각질 개선 (41.7%)" },
          { sentence: "사용 6주 후 건조로 인해. 거칠어진 피부결 개선 (8.4%)", sourceText: "사용 6주 후 건조로 인해. 거칠어진 피부결 개선 (8.4%)" }
        ],
        evidenceSentences: [ingredientEvidence, study],
        ingredientBenefitLinks: []
      }
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR", market: "KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productDescription = String(nodes.find((node) => node["@type"] === "Product")?.description ?? "");
    const webPageDescription = String(nodes.find((node) => node["@type"] === "WebPage")?.description ?? "");
    const faqText = JSON.stringify(nodes.find((node) => node["@type"] === "FAQPage")?.mainEntity ?? []);

    expect(productDescription).toMatch(/주요\s*성분[^.!?。！？]*고밀도\s*세라마이드\s*캡슐[^.!?。！？]*니아신아마이드/u);
    expect(productDescription).not.toMatch(/주요\s*성분[^.!?。！？]*\b비타민(?:이며|이고|으로|입니다)/u);
    expect(productDescription).toMatch(/\(주\)범용리서치/u);
    expect(productDescription).toMatch(/2025년\s*4월\s*3일부터\s*2025년\s*5월\s*14일까지/u);
    expect(productDescription).toMatch(/성인\s*29명/u);
    expect(productDescription).toMatch(/사용\s*직후\s*계절성\s*건조로\s*인한\s*들뜬\s*각질은\s*사용\s*전\s*대비\s*41\.7%\s*개선/u);
    expect(productDescription).toMatch(/사용\s*6주\s*후\s*건조로\s*인해\s*거칠어진\s*피부결은\s*사용\s*전\s*대비\s*8\.4%\s*개선/u);
    expect(productDescription).not.toMatch(/인한\.|인해\.|개선\s*\(/u);

    expectKoreanWebPageScopeDescription(webPageDescription, "범용 배리어 로션");
    expect(webPageDescription).toMatch(/고밀도\s*세라마이드.*니아신아마이드[^.]*주요\s*성분·기술로\s*포함하고/u);
    expect(webPageDescription).not.toMatch(/범용리서치|성인\s*29명|41\.7%|8\.4%/u);
    expect(faqText).not.toMatch(/시험\s*대상\/표본\s*수\s*미공개|시험\/평가\s*기준/u);
    expect(faqText).not.toMatch(/인한\.|인해\.|개선\s*\(/u);
    expect((run.result.diagnostics.validationRepairs ?? []).filter((repair) =>
      /description|FAQPage\.mainEntity|content\.sections\.faq/u.test(repair.field)
    )).toHaveLength(0);
  });

  it("atomizes a single run-on Korean OCR efficacy block before composing public descriptions", async () => {
    const base = evidenceRichProduct();
    const ocrBlock = "사용 2시간 만에 피부 10층 깊이에 도달하는 세라마이드 사용 전 사용 후 (겉보습 1층) 242% 사용 후 (속보습 10층) 356% 120h 한번만 발라도 120시간 보습 지속 사용 직후 보습량 2배 증가 단 10분 만에 손상장벽 2배 개선 ※ ㈜엘리드, 2023.02.02-2023.03.23, 스스로 피부가 민감하다고 느끼고 건조 고민이 있는 여성 32명 대상 인체적용시험 완료 *사용 전 대비 보습량 2배 증가, 손상장벽 2배 개선 이 제품입니다.";
    const product: PdpProductSignal = {
      ...base,
      name: "아토베리어365 크림",
      originalName: "아토베리어365 크림 80 mL",
      benefits: ["피부 장벽 케어", "속보습"],
      effects: ["피부 장벽 케어", "속보습"],
      metrics: [ocrBlock],
      sourceTexts: [...base.sourceTexts, ocrBlock],
      semanticFacts: {
        ...base.semanticFacts!,
        metricClaims: [{ sentence: ocrBlock, sourceText: ocrBlock }],
        evidenceSentences: [...(base.semanticFacts?.evidenceSentences ?? []), ocrBlock]
      }
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const webPage = nodes.find((node) => node["@type"] === "WebPage")!;
    const properties = (productNode.additionalProperty as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const reportedDetails = String(properties.find((item) => item.name === "Reported details")?.value ?? "");
    const productDescription = String(productNode.description ?? "");
    const webPageDescription = String(webPage.description ?? "");
    const sentences = productDescription.split(/(?<=[.!?。！？])\s+/u);
    const durationSentence = sentences.find((sentence) => /120시간/u.test(sentence));
    const studySentence = sentences.find((sentence) => /인체적용시험/u.test(sentence));
    expect(durationSentence).toMatch(/한\s*번\s*사용\s*후\s*보습이\s*120시간\s*지속됩니다/u);
    expect(studySentence).toMatch(/\(주\)엘리드/u);
    expect(studySentence).toMatch(/2023년\s*2월\s*2일부터\s*2023년\s*3월\s*23일까지/u);
    expect(studySentence).toMatch(/여성\s*32명/u);
    expect(studySentence).toMatch(/사용\s*직후\s*보습량은\s*사용\s*전\s*대비\s*2배\s*증가/u);
    expect(studySentence).toMatch(/단\s*10분\s*만에\s*손상\s*장벽은\s*사용\s*전\s*대비\s*2배\s*개선/u);
    expect(productDescription).toMatch(/주요\s*성분(?:은|인)\s*고밀도\s*세라마이드\s*캡슐과\s*콜레스테롤/u);
    expect(productDescription).toMatch(/피부\s*장벽\s*케어와\s*속보습을\s*돕고,\s*한\s*번\s*사용\s*후\s*보습이\s*120시간\s*지속됩니다/u);
    expect(productDescription).toMatch(/건조하고\s*민감한\s*피부\s*고객을\s*위한\s*크림입니다/u);
    expect(productDescription.indexOf("건조하고 민감한 피부 고객")).toBeLessThan(productDescription.indexOf("주요 성분"));
    expect(productDescription.indexOf("인체적용시험")).toBeLessThan(productDescription.indexOf("고객 리뷰"));
    expect(productDescription).not.toMatch(/주요\s*성분[^.!?。！？]{0,80}DermaON/iu);
    expect(productDescription.match(/보습량은\s*사용\s*전\s*대비\s*2배\s*증가/gu)?.length ?? 0).toBe(1);
    expect(productDescription.match(/손상\s*장벽은\s*사용\s*전\s*대비\s*2배\s*개선/gu)?.length ?? 0).toBe(1);
    expect(productDescription).not.toMatch(/사용\s*전\s*사용\s*후|120h|※|\*|인체적용시험\s*완료|이\s*제품입니다|\(겉보습|242%|356%/u);

    expectKoreanWebPageScopeDescription(webPageDescription, "아토베리어365 크림", "테스트랩");
    expect(webPageDescription).toMatch(/주요\s*성분·기술(?:인|로)\s*고밀도\s*세라마이드.*콜레스테롤/iu);
    expect(webPageDescription).not.toMatch(/120시간|엘리드|여성\s*32명|2배/iu);

    expect(reportedDetails).toMatch(/120시간|\(주\)엘리드|여성\s*32명|사용\s*전\s*대비/u);
    expect(reportedDetails).not.toMatch(/사용\s*전\s*사용\s*후|120h|※|\*|인체적용시험\s*완료|이\s*제품입니다/u);
    expect((run.result.diagnostics.validationRepairs ?? []).filter((repair) => /description/u.test(repair.field))).toHaveLength(0);
  });

  it("renders one shared clinical evidence group once across Product and evidence summary fields", async () => {
    const base = evidenceRichProduct();
    const sourceText = "한번만 발라도 120시간 보습 지속 사용 직후 보습량 2배 증가 단 10분 만에 손상장벽 2배 개선 ※ ㈜엘리드, 2023.02.02-2023.03.23, 스스로 피부가 민감하다고 느끼고 건조 고민이 있는 여성 32명 대상 인체적용시험 완료 *사용 전 대비 보습량 2배 증가, 손상장벽 2배 개선";
    const product: PdpProductSignal = {
      ...base,
      name: "배리어 리커버리 크림",
      effects: [sourceText, "사용 직후 보습량 2배 증가", "단 10분 만에 손상장벽 2배 개선"],
      metrics: [sourceText, "한번만 발라도 120시간 보습 지속"],
      sourceTexts: [...base.sourceTexts, sourceText],
      semanticFacts: {
        ...base.semanticFacts!,
        metricClaims: [
          {
            subject: "보습 지속",
            value: "120",
            unit: "시간",
            timing: "한번만 발라도",
            evidenceGroup: "barrier-study",
            sentence: "한번만 발라도 120시간 보습 지속",
            sourceText
          },
          {
            subject: "보습량",
            value: "2",
            unit: "배",
            direction: "증가",
            timing: "사용 직후",
            baseline: "사용 전 대비",
            evidenceGroup: "barrier-study",
            sentence: "사용 직후 보습량 2배 증가",
            sourceText
          },
          {
            subject: "손상장벽",
            value: "2",
            unit: "배",
            direction: "개선",
            timing: "단 10분 만에",
            baseline: "사용 전 대비",
            evidenceGroup: "barrier-study",
            sentence: "단 10분 만에 손상장벽 2배 개선",
            sourceText
          }
        ],
        evidenceSentences: [...(base.semanticFacts?.evidenceSentences ?? []), sourceText]
      }
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const webPage = nodes.find((node) => node["@type"] === "WebPage")!;
    const properties = (productNode.additionalProperty as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const detailedPublicSummaries = [
      String(productNode.description ?? ""),
      String(properties.find((item) => item.name === "Reported details")?.value ?? ""),
      String(properties.find((item) => item.name === "Clinical result summary")?.value ?? "")
    ];

    for (const value of detailedPublicSummaries) {
      expect(value.match(/\(주\)엘리드/gu)?.length ?? 0).toBe(1);
      expect(value.match(/사용\s*직후\s*보습량은\s*사용\s*전\s*대비\s*2배\s*증가/gu)?.length ?? 0).toBe(1);
      expect(value.match(/단\s*10분\s*만에\s*손상\s*장벽은\s*사용\s*전\s*대비\s*2배\s*개선/gu)?.length ?? 0).toBe(1);
      expect(value.match(/한\s*번\s*사용\s*후\s*보습이\s*120시간\s*지속/gu)?.length ?? 0).toBe(1);
      const sentences = value.split(/(?<=[.!?。！？])\s+/u).map((sentence) => sentence.trim()).filter(Boolean);
      expect(new Set(sentences).size).toBe(sentences.length);
    }
    const webPageDescription = String(webPage.description ?? "");
    expectKoreanWebPageScopeDescription(webPageDescription, "배리어 리커버리 크림", "테스트랩");
    expect(webPageDescription).toMatch(/완제품\s*인체적용시험에서[^.]*보습량은[^.]*2배\s*증가/u);
    expect(webPageDescription).toMatch(/같은\s*시험에서[^.]*손상\s*장벽은[^.]*2배\s*개선/u);
    expect(webPageDescription).not.toMatch(/엘리드|120시간|190%|ex\s*vivo/iu);
    expect((run.result.diagnostics.validationRepairs ?? []).filter((repair) => /description/u.test(repair.field))).toHaveLength(0);
  });

  it("generalizes a detailed Product narrative from classified formula, study, safety, and review evidence", async () => {
    const study = "한 번만 사용해도 72시간 수분 지속 사용 30분 후 피부 수분량 1.6배 증가 사용 14일 후 장벽 지표 31% 개선 ※ ㈜클리어랩, 2025.04.03-2025.05.19, 계절성 건조를 느끼는 성인 27명 대상 인체적용시험 완료 *사용 전 대비 피부 수분량 1.6배 증가, 장벽 지표 31% 개선";
    const product: PdpProductSignal = {
      name: "리피드 리커버리 밤",
      description: "LamellaMesh™ 기술이 계절성 건조 피부의 수분 장벽 강화를 돕습니다.",
      category: "밤",
      images: [],
      options: [],
      benefits: ["수분 장벽 강화", "수분 유지"],
      effects: ["피부 수분량 증가", "장벽 지표 개선"],
      ingredients: ["LamellaMesh™ 기술", "리포좀 지질 캡슐", "피토세라마이드", "식물성 스테롤", "판테놀"],
      usage: [],
      metrics: [study],
      faq: [],
      reviews: {
        items: [{ body: "부드럽게 발리고 피부가 편안하며 끈적임이 적은 마무리가 만족스러웠습니다." }],
        keywords: ["부드러운 발림", "편안한 마무리", "만족"]
      },
      breadcrumbs: [],
      sourceTexts: [
        "리포좀 지질 캡슐은 피토세라마이드와 식물성 스테롤로 구성됩니다.",
        "리포좀 지질 캡슐이 피부 수분 장벽 유지를 돕습니다.",
        "판테놀은 건조로 민감해진 피부의 보습을 돕는 성분입니다.",
        "LamellaMesh™ 기술이 계절성 건조 피부의 수분 장벽 강화를 돕습니다.",
        "DERMATOLOGIST TESTED 피부과 테스트 완료 SENSITIVE SKIN PANEL TESTED 민감 피부 자극 테스트 완료",
        study
      ],
      semanticFacts: {
        ingredients: ["리포좀 지질 캡슐", "피토세라마이드", "식물성 스테롤", "판테놀"],
        benefits: ["수분 장벽 강화", "수분 유지"],
        effects: ["피부 수분량 증가", "장벽 지표 개선"],
        skinTypes: ["계절성 건조 피부"],
        usageSteps: [],
        safetyTests: ["피부과 테스트 완료", "민감 피부 자극 테스트 완료"],
        metricClaims: [{ sentence: study, sourceText: study, evidenceGroup: "generic-study" }],
        evidenceSentences: [
          "리포좀 지질 캡슐은 피토세라마이드와 식물성 스테롤로 구성됩니다.",
          "리포좀 지질 캡슐이 피부 수분 장벽 유지를 돕습니다.",
          "판테놀은 건조로 민감해진 피부의 보습을 돕는 성분입니다.",
          "LamellaMesh™ 기술이 계절성 건조 피부의 수분 장벽 강화를 돕습니다.",
          study
        ],
        ingredientBenefitLinks: [
          { ingredient: "리포좀 지질 캡슐", benefit: "수분 장벽 유지", sentence: "리포좀 지질 캡슐이 피부 수분 장벽 유지를 돕습니다." },
          { ingredient: "판테놀", benefit: "보습", sentence: "판테놀은 건조로 민감해진 피부의 보습을 돕는 성분입니다." }
        ]
      }
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const productNode = graph
      .filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node))
      .find((node) => node["@type"] === "Product")!;
    const description = String(productNode.description ?? "");

    const ingredientIndex = description.indexOf("리포좀 지질 캡슐");
    const technologyIndex = description.indexOf("LamellaMesh™ 기술");
    const clinicalIndex = description.indexOf("(주)클리어랩");
    const safetyIndex = description.indexOf("피부과 테스트");
    const reviewIndex = description.indexOf("실제 고객 리뷰");
    expect(ingredientIndex).toBeGreaterThanOrEqual(0);
    expect(technologyIndex).toBeGreaterThanOrEqual(0);
    expect(description).toMatch(/(?:피토)?세라마이드와\s*식물성\s*스테롤로\s*구성/u);
    expect(description).toMatch(/판테놀[^.!?。！？]*보습/u);
    expect(description).toMatch(/72시간/u);
    expect(description).toMatch(/1\.6배/u);
    expect(description).toMatch(/31%/u);
    expect(description).toMatch(/성인\s*27명/u);
    expect(ingredientIndex).toBeLessThan(clinicalIndex);
    expect(technologyIndex).toBeLessThan(clinicalIndex);
    expect(clinicalIndex).toBeLessThan(safetyIndex);
    expect(safetyIndex).toBeLessThan(reviewIndex);
    expect(description).not.toMatch(/아토베리어|DermaON|엘리드|120시간|여성\s*32명|극민감|소아과/u);
    expect(description).not.toMatch(/독일\s*더마/u);
  });

  it("keeps arbitrary compressed OCR measurements atomic and does not misroute textPreview as a review", async () => {
    const ocrBlock = "사용 90분 만에 피부 8층 깊이에 도달하는 배리어 지질 복합체 사용 전 사용 후 (겉보습 1층) 118% 사용 후 (속보습 8층) 164% 96h 한 번만 사용해도 96시간 수분 지속 사용 30분 후 피부 수분량 38% 증가 사용 14일 후 장벽 지표 27% 개선 ※ ㈜뉴리서치, 2025.04.01-2025.05.15, 건조함을 느끼는 성인 28명 대상 인체적용시험 완료 *사용 전 대비 피부 수분량 38% 증가, 장벽 지표 27% 개선 본 제품입니다.";
    const normalized = normalizePdpProduct({
      name: "배리어 리페어 크림",
      description: "건조 피부 고객을 위한 장벽 크림입니다.",
      category: "크림",
      benefits: ["피부 장벽 케어", "수분 케어"],
      effects: ["피부 수분량 증가", "장벽 지표 개선"],
      ingredients: ["배리어 지질 복합체", "세라마이드", "콜레스테롤"],
      sourceTexts: ["세라마이드와 콜레스테롤을 함유한 장벽 크림입니다."],
      sourceExtraction: {
        ocr: {
          images: [{ imageUrl: "https://example.com/evidence.jpg", textPreview: ocrBlock }]
        }
      }
    }, { hints: { locale: "ko-KR" } });

    expect(normalized.product.reviews.items).toEqual([]);
    expect(normalized.product.reviews.keywords).toEqual([]);
    expect(normalized.product.metrics).not.toContain(ocrBlock);
    expect(normalized.product.sourceTexts).toContain(ocrBlock);

    const run = await generatePdpGeo({ product: normalized.product, hints: { locale: "ko-KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productDescription = String(nodes.find((node) => node["@type"] === "Product")?.description ?? "");
    const webPageDescription = String(nodes.find((node) => node["@type"] === "WebPage")?.description ?? "");
    const studySentence = productDescription.split(/(?<=[.!?。！？])\s+/u).find((sentence) => /인체적용시험/u.test(sentence));
    expect(productDescription).toMatch(/한\s*번\s*사용\s*후\s*수분이\s*96시간\s*지속됩니다/u);
    expect(studySentence).toMatch(/\(주\)뉴리서치/u);
    expect(studySentence).toMatch(/2025년\s*4월\s*1일부터\s*2025년\s*5월\s*15일까지/u);
    expect(studySentence).toMatch(/성인\s*28명/u);
    expect(studySentence).toMatch(/사용\s*30분\s*후\s*피부\s*수분량은\s*사용\s*전\s*대비\s*38%\s*증가/u);
    expect(studySentence).toMatch(/사용\s*14일\s*후\s*장벽\s*지표는\s*사용\s*전\s*대비\s*27%\s*개선/u);
    expect(productDescription).not.toMatch(/고객\s*리뷰/u);
    expect(productDescription).not.toMatch(/사용\s*전\s*사용\s*후|96h|※|\*|인체적용시험\s*완료|본\s*제품입니다|\(겉보습|118%|164%|120시간|2배|32명/u);

    expectKoreanWebPageScopeDescription(webPageDescription, "배리어 리페어 크림");
    expect(webPageDescription).not.toMatch(/96시간|뉴리서치|성인\s*28명|38%|27%|118%|164%/u);
  });

  it("routes model-inferred metric structures as atomic ledger evidence while retaining raw OCR only as provenance", () => {
    const rawBlock = "사용 전 사용 후 여러 측정값 120h ※ ㈜리서치랩, 2025.01.02-2025.02.03, 성인 30명 대상 인체적용시험 완료 사용 직후 보습량 2배 증가, 사용 10분 후 장벽 지표 35% 개선";
    const normalized = normalizePdpProduct({
      name: "아토믹 배리어 크림",
      description: "건조 피부를 위한 크림입니다.",
      sourceTexts: [rawBlock],
      semanticFacts: {
        ingredients: [],
        benefits: ["피부 장벽 케어"],
        effects: ["보습량 증가", "장벽 지표 개선"],
        skinTypes: ["건조 피부"],
        usageSteps: [],
        evidenceSentences: [rawBlock],
        ingredientBenefitLinks: [],
        metricClaims: [
          {
            label: "보습량 증가",
            value: "2",
            unit: "배",
            direction: "증가",
            timing: "사용 직후",
            baseline: "사용 전 대비",
            sample: "성인 30명",
            period: "2025.01.02-2025.02.03",
            method: "인체적용시험",
            institution: "㈜리서치랩",
            evidenceGroup: "study-1",
            sentence: "사용 직후 보습량 2배 증가",
            sourceText: rawBlock
          },
          {
            label: "장벽 지표 개선",
            value: "35",
            unit: "%",
            direction: "개선",
            timing: "사용 10분 후",
            baseline: "사용 전 대비",
            sample: "성인 30명",
            period: "2025.01.02-2025.02.03",
            method: "인체적용시험",
            institution: "㈜리서치랩",
            evidenceGroup: "study-1",
            sentence: "사용 10분 후 장벽 지표 35% 개선",
            sourceText: rawBlock
          }
        ]
      }
    }, { hints: { locale: "ko-KR" } });

    expect(normalized.product.semanticFacts?.metricClaims).toHaveLength(2);
    expect(normalized.product.metrics).toHaveLength(2);
    expect(normalized.product.metrics.join(" ")).toMatch(/보습량\s*증가.*2배.*사용\s*직후.*사용\s*전\s*대비/u);
    expect(normalized.product.metrics.join(" ")).toMatch(/장벽\s*지표\s*개선.*35%.*사용\s*10분\s*후/u);
    expect(normalized.product.metrics.join(" ")).not.toMatch(/사용\s*전\s*사용\s*후|120h|※|인체적용시험\s*완료/u);

    const ledger = createPdpGeoEvidenceLedger(normalized.product, "ko-KR");
    const metricEvidence = ledger.filter((item) => item.role === "metric").map((item) => item.text).join("\n");
    const sourceEvidence = ledger.filter((item) => item.role === "source").map((item) => item.text).join("\n");
    expect(metricEvidence).toMatch(/baseline=사용\s*전\s*대비/u);
    expect(metricEvidence).toMatch(/evidenceGroup=study-1/u);
    expect(metricEvidence).not.toContain(rawBlock);
    expect(sourceEvidence).toContain(rawBlock);
  });

  it("keeps Korean descriptions in a natural CEP narrative and routes report-style evidence out of descriptions", async () => {
    const base = evidenceRichProduct();
    const product: PdpProductSignal = {
      ...base,
      sourceTexts: [...base.sourceTexts, "민감 피부를 고려한 피부과 테스트 완료"],
      semanticFacts: {
        ...base.semanticFacts!,
        evidenceSentences: [
          ...base.semanticFacts!.evidenceSentences,
          "민감 피부를 고려한 피부과 테스트 완료"
        ]
      }
    };
    const run = await generatePdpGeo({
      product,
      hints: { locale: "ko-KR" }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const webPage = nodes.find((node) => node["@type"] === "WebPage")!;
    const properties = (productNode.additionalProperty as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const reportedDetails = String(properties.find((item) => item.name === "Reported details")?.value ?? "");
    const productDescription = String(productNode.description ?? "");
    const webPageDescription = String(webPage.description ?? "");

    expect(productDescription).toMatch(/하이드라 배리어 크림/u);
    expect(productDescription).toMatch(/건조하고 민감한 피부/u);
    expect(productDescription).toMatch(/세라마이드/u);
    expect(productDescription).toMatch(/피부 장벽|보습/u);
    expect(productDescription).toMatch(/고객 리뷰/u);
    expect(productDescription.indexOf("하이드라 배리어 크림")).toBeLessThan(productDescription.indexOf("건조하고 민감한 피부"));
    expect(productDescription.indexOf("건조하고 민감한 피부")).toBeLessThan(productDescription.indexOf("세라마이드"));
    expect(productDescription.indexOf("세라마이드")).toBeLessThan(productDescription.indexOf("고객 리뷰"));
    expect(productDescription).not.toMatch(/민감 피부 사용 맥락은|선택 기준을 보완|원료적 특성에 한한|해당 결과는|표기되어 있다|190%|ex vivo/iu);

    expect(productDescription).not.toMatch(/상품\s*페이지/u);
    expectKoreanWebPageScopeDescription(webPageDescription, "하이드라 배리어 크림", "테스트랩");
    expect(webPageDescription).toMatch(/하이드라\s*배리어\s*크림은\s*건조하고\s*민감한\s*피부\s*고객을\s*위한\s*제품으로,[^.]*고밀도\s*세라마이드[^.]*피부\s*장벽[^.]*돕습니다/iu);
    expect(webPageDescription).toMatch(/고객\s*리뷰에서\s*고객들은[^.]*긍정적으로\s*평가했습니다/u);
    expect(webPageDescription).not.toMatch(/190%|ex\s*vivo/iu);
    expect(reportedDetails).toMatch(/190%/u);
    expect(reportedDetails).toMatch(/ex vivo/iu);
    expect(reportedDetails).not.toMatch(/표기되어 있다|제시된다|설명된다/u);
  });

  it("removes generic educational FAQ and keeps product decision questions", async () => {
    const base = evidenceRichProduct();
    const product: PdpProductSignal = {
      ...base,
      name: "하이드라 배리어 크림",
      faq: [
        {
          question: "피부 장벽의 기능이 무엇인가요?",
          answer: "피부 장벽은 말 그대로 '벽'의 역할을 합니다."
        }
      ]
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const faqPage = graph
      .filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node))
      .find((node) => node["@type"] === "FAQPage")!;
    const faqItems = (faqPage.mainEntity as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const questions = faqItems.map((item) => String(item.name));
    const answers = faqItems.map((item) => String((item.acceptedAnswer as Record<string, JsonValue>).text));

    expect(questions).not.toContain("피부 장벽의 기능이 무엇인가요?");
    expect(answers.join(" ")).not.toContain("말 그대로 '벽'의 역할");
    expect(questions.some((question) => /(?:어떤\s*(?:고객|피부)|고민|효능|효과)/u.test(question))).toBe(true);
    expect(questions.some((question) => /(?:성분|기술)/u.test(question))).toBe(true);
  });

  it("rewrites source-narrated FAQ into concern, effect, and direct life-stage answers before validation", async () => {
    const base = evidenceRichProduct();
    const product: PdpProductSignal = {
      ...base,
      name: "아토베리어365 크림",
      originalName: "아토베리어365 크림 80 mL",
      brand: "에스트라",
      usage: [
        "아침/저녁 세안 후 적당량의 내용물을 덜어 피부에 골고루 펴 바릅니다.",
        "아침과 저녁 세안 후 적당량을 덜어 피부에 골고루 펴 바릅니다.",
        "부드럽게 피부를 눌러 흡수를 도와주세요."
      ],
      faq: [
        {
          question: "아토베리어365 크림은 진정 효과가 있나요?",
          answer: "제품 FAQ에서는 아토베리어365 크림이 손상된 피부 장벽 기능을 강화해주는 제품이며, 외부 자극이나 유해 환경으로 인해 민감해지고 손상된 피부 장벽에 진정과 보습을 제공한다고 설명합니다. 단순히 진정을 넘어 보습을 통한 장벽 개선까지 도와주는 제품으로 안내되어 있습니다."
        },
        {
          question: "영유아도 아토베리어365 크림을 사용할 수 있나요?",
          answer: "제품 FAQ에서는 아토베리어365 크림이 민감하고 연약한 피부가 사용할 수 있게 개발된 제품으로 0세부터 성인까지 누구나 사용 가능한 제품이라고 안내합니다. 팔 안쪽, 귀 뒷면 등 국소부위에 먼저 테스트 후 사용할 수 있습니다."
        }
      ],
      semanticFacts: {
        ...base.semanticFacts!,
        skinTypes: ["민감피부", "sensitive skin", "건조 피부"],
        usageSteps: [
          "아침/저녁 세안 후 적당량의 내용물을 덜어 피부에 골고루 펴 바릅니다.",
          "아침과 저녁 세안 후 적당량을 덜어 피부에 골고루 펴 바릅니다.",
          "캡슐 제형은 도포 18시간 후 비캡슐 대비 잔존 효과가 190% 높다는 실험 결과입니다.",
          "부드럽게 피부를 눌러 흡수를 도와주세요."
        ]
      }
    };

    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const faqItems = (faqPage.mainEntity as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const effectFaq = faqItems.find((item) => /(?:속건조|피부\s*장벽\s*관리|손상된\s*피부\s*장벽)[^?？]*고민/u.test(String(item.name)))!;
    const infantFaq = faqItems.find((item) => /영유아/u.test(String(item.name)))!;
    expect(effectFaq, JSON.stringify(faqItems, null, 2)).toBeDefined();
    const effectAnswer = String((effectFaq.acceptedAnswer as Record<string, JsonValue>).text);
    const infantAnswer = String((infantFaq.acceptedAnswer as Record<string, JsonValue>).text);
    const properties = (productNode.additionalProperty as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const skinType = String(properties.find((item) => item.name === "Recommended skin type")?.value ?? "");
    const usage = String(properties.find((item) => item.name === "Usage")?.value ?? "");

    expect(effectAnswer).toMatch(/아토베리어365 크림/u);
    expect(effectAnswer).toMatch(/건조하고\s*민감한\s*피부\s*고객을\s*위한\s*크림/u);
    expect(effectAnswer).toMatch(/아토베리어365\s*크림은[^.]*피부\s*장벽\s*관리[^.]*수분\s*케어를\s*돕습니다/u);
    expect(effectAnswer).toMatch(/세라마이드\s*캡슐은[^.]*피부\s*장벽(?:\s*관리)?를\s*돕습니다/u);
    expect(effectAnswer).toMatch(/따라서[^.]*고려할\s*수\s*있습니다/u);
    expect(infantAnswer).toMatch(/아토베리어365 크림/u);
    expect(infantAnswer).toMatch(/0세부터\s*성인까지/u);
    expect(infantAnswer).toMatch(/국소부위|국소\s*부위|귀\s*뒤나\s*팔\s*안쪽/u);
    expect(JSON.stringify(faqItems)).not.toMatch(/제품\s*FAQ에서는|상품\s*정보에\s*따르면|설명합니다|안내합니다/u);
    expect(skinType.split(" 또는 ").sort()).toEqual(["건조 피부", "민감 피부"].sort());
    expect(usage.match(/펴\s*바릅니다/gu)?.length ?? 0).toBe(1);
    expect(`${usage}\n${run.result.content.sections.howToUse}`).not.toMatch(/190%|실험\s*결과/u);
    expect((run.result.diagnostics.validationRepairs ?? []).every((repair) =>
      /FAQPage\.mainEntity|content\.sections\.faq|content\.html/u.test(repair.field)
    )).toBe(true);
  });

  it("removes stiff certification and source-report sentences during final description validation", () => {
    const metric = "캡슐 제형은 캡슐 vs 비캡슐 실험에서 190% 높은 잔존 효과가 제시되며, 해당 결과는 원료적 특성에 한한 ex vivo 테스트 결과로 표기되어 있다.";
    const productDescription = `하이드라 배리어 크림은 건조하고 민감한 피부 고객을 위한 크림입니다. 고밀도 세라마이드 캡슐이 피부 장벽 보습을 돕습니다. ${metric} 고객 리뷰에서는 촉촉한 사용감이 반복해서 언급됩니다.`;
    const webPageDescription = `하이드라 배리어 크림 상품 페이지는 건조하고 민감한 피부 고객에게 크림을 소개합니다. 고밀도 세라마이드 캡슐이 피부 장벽 보습을 돕습니다. 민감 피부 사용 맥락은 피부과 테스트 완료로 보완됩니다. ${metric} 고객 리뷰에서는 촉촉한 사용감이 반복해서 언급됩니다.`;
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "ko-KR",
      fallbackProductName: "하이드라 배리어 크림",
      fallbackDescription: productDescription,
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebPage",
              "@id": "https://example.com/hydra#webpage",
              name: "하이드라 배리어 크림",
              description: webPageDescription,
              mainEntity: { "@id": "https://example.com/hydra#product" }
            },
            {
              "@type": "Product",
              "@id": "https://example.com/hydra#product",
              name: "하이드라 배리어 크림",
              description: productDescription,
              additionalProperty: [{ "@type": "PropertyValue", name: "Reported details", value: metric }]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        html: "",
        sections: {
          productName: "하이드라 배리어 크림",
          description: productDescription,
          quickFacts: "",
          benefits: "",
          ingredients: "",
          howToUse: "",
          faq: ""
        }
      }
    });
    const graph = repaired.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const serializedDescriptions = graph
      .filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node))
      .filter((node) => node["@type"] === "WebPage" || node["@type"] === "Product")
      .map((node) => String(node.description ?? ""))
      .join(" ");
    const productNode = graph
      .filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node))
      .find((node) => node["@type"] === "Product")!;

    expect(serializedDescriptions).not.toMatch(/민감 피부 사용 맥락은|원료적 특성에 한한|해당 결과는|표기되어 있다|190%|ex vivo/iu);
    expect(JSON.stringify(productNode.additionalProperty)).toMatch(/190%/u);
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && /description/.test(repair.field))).toBe(true);
  });

  it("keeps review narratives, FAQ fragments, orphan technology, and context-free metrics out of public evidence fields", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "데일리 배리어 크림",
        description: "건조하고 민감한 피부의 장벽 보습을 위한 크림입니다.",
        category: "크림",
        benefits: ["피부 장벽", "수분감"],
        effects: ["보습"],
        ingredients: [
          "세라마이드",
          "현재 데일리 배리어 크림에 사용하고 있는 세라마이드는 총 4가지입니다.",
          "민감 피부용 세라마이드 명칭은 아래와 같은 명칭에서 확인하실 수 있습니다.",
          "데일리 배리어 크림에 들어가 있",
          "데일리 배리어 크림에 어떤 세라마이드가 들어가는지 알고 싶습니다?"
        ],
        metrics: ["세라마이드 190%"],
        sourceTexts: [
          "기술이 건조하고 민감한 피부의 장벽 기능을 강화시켜줍니다.",
          "몇 통째 사용 중인 만큼: 크림이 순하고 좋습니다 열기가 잘 빠지네요.",
          "세안 후에도 자극 없이 촉촉해서 좋습니다: 피부가 편안하고 만족합니다."
        ],
        usage: ["세안 후 적당량을 피부에 골고루 펴 바릅니다."],
        faq: [{
          question: "동물유래성분이 들어가있는 제품인가요?",
          answer: "-> 동물성 원료를 사용하지 않은 비건 제품입니다."
        }],
        reviews: {
          keywords: ["촉촉한 사용감"],
          items: [{ body: "여러 통째 사용 중이며 피부가 촉촉하고 편안해서 만족합니다.", rating: 5 }]
        },
        images: [],
        options: [],
        breadcrumbs: [],
        price: undefined,
        claims: [],
        certifications: []
      },
      hints: { locale: "ko-KR" }
    });

    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const properties = (productNode.additionalProperty as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const brandScience = properties.find((item) => item.name === "Brand science");
    const reportedDetails = properties.find((item) => item.name === "Reported details");
    const publicSections = `${run.result.content.sections.benefits}\n${run.result.content.sections.ingredients}`;
    const faqText = JSON.stringify(faqPage.mainEntity ?? []);

    expect(publicSections).not.toMatch(/몇\s*통째|열기가\s*잘\s*빠지|만족합니다|저자극\s*세안|세정력/u);
    expect(run.result.content.sections.ingredients).not.toMatch(/총\s*4가지|아래와\s*같은\s*명칭|알고\s*싶|들어가\s*있(?:\s|$)/u);
    expect(brandScience).toBeUndefined();
    expect(reportedDetails).toBeUndefined();
    expect(faqText).toContain("들어가 있는 제품인가요?");
    expect(faqText).not.toMatch(/들어가있은|(?:-{1,2}|=)>|→/u);
    expect(faqText).toContain("동물성 원료를 사용하지 않은 비건 제품입니다.");
  });

  it("keeps English public fields locale-pure while preserving a Korean product entity", async () => {
    const productName = "아토베리어365 크림";
    const run = await generatePdpGeo({
      product: {
        name: productName,
        description: "건조하고 민감한 피부의 장벽 보습을 위한 크림입니다.",
        category: "Cream",
        benefits: ["장벽", "보습", "수분", "진정"],
        ingredients: ["고밀도 세라마이드 캡슐", "콜레스테롤", "DermaON® 기술"],
        metrics: ["세라마이드 190%"],
        reviews: {
          keywords: ["피부결", "만족", "보습력"],
          items: [{ body: "피부가 촉촉하고 편안해서 만족하며 여러 통째 사용하고 있습니다.", rating: 5 }]
        }
      },
      hints: { locale: "en-US" }
    });

    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const properties = (productNode.additionalProperty as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const keyIngredients = String(properties.find((item) => item.name === "Key ingredients")?.value ?? "");
    const reportedDetails = properties.find((item) => item.name === "Reported details");
    const faqNarrative = JSON.stringify(faqPage.mainEntity ?? []).replaceAll(productName, "");
    const descriptionNarrative = String(productNode.description ?? "").replaceAll(productName, "");

    expect(run.result.diagnostics.validationRepairs).toHaveLength(0);
    expect(descriptionNarrative).not.toMatch(/[가-힣]/u);
    expect(keyIngredients.split(", ")).toEqual(expect.arrayContaining(["High-density Ceramide Capsule", "Cholesterol", "DermaON® technology"]));
    expect(run.result.content.sections.ingredients).not.toMatch(/[가-힣]/u);
    expect(faqNarrative).not.toMatch(/[가-힣]/u);
    expect(reportedDetails).toBeUndefined();
    expect(productNode.review).toBeUndefined();
  });

  it("classifies atomic evidence roles before fields consume mixed Korean and English source text", () => {
    expect(inferPdpEvidenceRoles("150ml").roles).toEqual(["commerce"]);
    expect(inferPdpEvidenceRoles("Patch testing is recommended for sensitive skin users.").roles).toContain("safety");
    expect(inferPdpEvidenceRoles("Patch testing is recommended for sensitive skin users.").roles).not.toContain("usage");
    expect(inferPdpEvidenceRoles("모공이 막히지는 않는지 궁금합니다.").primaryRole).toBe("faq");

    const linked = inferPdpEvidenceRoles("Ginseng Peptide helps support visibly firmer-looking skin.");
    expect(linked.roles).toEqual(expect.arrayContaining(["ingredient", "benefit", "effect"]));
    expect(linked.canLinkIngredientToOutcome).toBe(true);

    const inci = inferPdpEvidenceRoles("INGREDIENTS: WATER, GLYCERIN, BUTYLENE GLYCOL, NIACINAMIDE, SQUALANE, PANTHENOL, RETINOL, CERAMIDE NP, TOCOPHEROL, XANTHAN GUM");
    expect(inci.roles).toContain("ingredient");
    expect(inci.roles).not.toContain("benefit");
  });

  it("keeps outcome words inside standalone ingredient names from becoming outcome or causal claims", () => {
    const namedIngredients = [
      "Hydration Boost Complex",
      "Moisture Retention Complex",
      "Barrier Support Formula",
      "수분 유지 복합체",
      "AquaShield Ferment"
    ];

    for (const name of namedIngredients) {
      const inference = inferPdpEvidenceRoles(name);
      expect(inference.roles, name).toContain("ingredient");
      expect(inference.roles, name).not.toContain("benefit");
      expect(inference.roles, name).not.toContain("effect");
      expect(inference.canLinkIngredientToOutcome, name).toBe(false);
    }

    const explicitClaim = inferPdpEvidenceRoles("Hydration Boost Complex helps support skin hydration");
    expect(explicitClaim.roles).toEqual(expect.arrayContaining(["ingredient", "benefit", "effect"]));
    expect(explicitClaim.canLinkIngredientToOutcome).toBe(true);

    const sanitized = sanitizePdpSemanticFacts({
      ingredients: namedIngredients,
      benefits: namedIngredients,
      effects: namedIngredients
    });
    expect(sanitized.ingredients).toEqual(expect.arrayContaining(namedIngredients));
    expect(sanitized.benefits).toEqual([]);
    expect(sanitized.effects).toEqual([]);
  });

  it("rejects skin-type labels and review-only vocabulary while preserving a novel model-routed ingredient", async () => {
    expect(inferPdpEvidenceRoles("피부 타입").roles).not.toContain("ingredient");
    expect(sanitizePdpSemanticFacts({ ingredients: ["피부 타입"] }).ingredients).toEqual([]);

    const reviewScoped = normalizePdpProduct({
      name: "Review Scoped Serum",
      sourceExtraction: {
        ocr: {
          sentenceInsights: [
            { text: "Hydration Boost Complex", category: "review" },
            { text: "silky hydration finish", category: "review" }
          ]
        }
      }
    });
    expect(reviewScoped.product.ingredients).not.toContain("Hydration Boost Complex");
    expect(reviewScoped.product.benefits).not.toContain("silky hydration finish");
    expect(reviewScoped.product.effects).not.toContain("silky hydration finish");

    const bootstrap: PdpProductSignal = {
      ...evidenceRichProduct(),
      benefits: [],
      effects: [],
      ingredients: ["AquaShield Ferment"],
      sourceTexts: [],
      semanticFacts: undefined,
      reviews: {
        keywords: ["silky finish", "Hydration Boost Complex"],
        items: [{ body: "Customers describe a silky finish and mention Hydration Boost Complex.", rating: 5 }]
      }
    };
    const normalized = await normalizePdpProductWithAgent({
      rawProduct: {
        name: bootstrap.name,
        ingredients: ["AquaShield Ferment"],
        audienceLabel: "피부 타입",
        reviews: bootstrap.reviews
      },
      bootstrapProduct: bootstrap,
      locale: "en-US",
      market: "US",
      ragDocuments: []
    }, {
      customProductNormalizer: {
        normalizeProduct: () => ({
          product: {
            benefits: ["silky finish"],
            effects: ["silky finish"],
            ingredients: ["Hydration Boost Complex", "피부 타입", "AquaShield Ferment"],
            semanticFacts: {
              ingredients: ["Hydration Boost Complex", "피부 타입", "AquaShield Ferment"],
              benefits: ["silky finish"],
              effects: ["silky finish"],
              skinTypes: [],
              usageSteps: [],
              metricClaims: [],
              evidenceSentences: [],
              ingredientBenefitLinks: []
            }
          }
        })
      }
    });

    expect(normalized.product.benefits).not.toContain("silky finish");
    expect(normalized.product.effects).not.toContain("silky finish");
    expect(normalized.product.ingredients).toEqual(["AquaShield Ferment"]);
    expect(normalized.product.semanticFacts?.ingredients).toEqual(["AquaShield Ferment"]);
    expect(normalized.product.semanticFacts?.benefits).toEqual([]);
    expect(normalized.product.semanticFacts?.effects).toEqual([]);

    const auditedClear = await normalizePdpProductWithAgent({
      rawProduct: {
        name: bootstrap.name,
        ingredients: ["AquaShield Ferment"],
        reviews: bootstrap.reviews
      },
      bootstrapProduct: {
        ...bootstrap,
        benefits: ["silky finish"],
        effects: ["silky finish"],
        ingredients: ["Hydration Boost Complex", "AquaShield Ferment"]
      },
      locale: "en-US",
      market: "US",
      ragDocuments: []
    }, {
      customProductNormalizer: {
        normalizeProduct: () => ({
          product: {
            benefits: [],
            effects: [],
            ingredients: ["AquaShield Ferment"]
          }
        })
      }
    });

    expect(auditedClear.product.benefits).toEqual([]);
    expect(auditedClear.product.effects).toEqual([]);
    expect(auditedClear.product.ingredients).toEqual(["AquaShield Ferment"]);
  });

  it("normalizes a machine-prefixed brand only when domain and visible PDP identity agree", () => {
    const normalized = normalizePdpProduct({
      product: {
        name: "Sulwhasoo First Care Activating Serum",
        brand: "apus-sulwhasoo",
        description: "Sulwhasoo First Care Activating Serum is a daily serum.",
        breadcrumbs: [
          { name: "Home" },
          { name: "apus-sulwhasoo" },
          { name: "Sulwhasoo First Care Activating Serum" }
        ]
      }
    }, { sourceUrl: "https://us.sulwhasoo.com/products/first-care-activating-serum" });

    expect(normalized.product.brand).toBe("Sulwhasoo");
    expect(normalized.product.breadcrumbs.map((item) => item.name)).toContain("Sulwhasoo");
    expect(JSON.stringify(normalized.product.breadcrumbs)).not.toContain("apus-sulwhasoo");

    const legitimateHyphenatedBrand = normalizePdpProduct({
      product: {
        name: "Atelier Brand Repair Serum",
        brand: "atelier-brand",
        description: "Atelier Brand Repair Serum is a daily serum."
      }
    }, { sourceUrl: "https://brand.com/products/repair-serum" });
    expect(legitimateHyphenatedBrand.product.brand).toBe("atelier-brand");
  });

  it("removes cross-role semantic facts without losing atomic ingredient-outcome or study evidence", () => {
    const atomicStudy = "In a 6-week study of 32 women, 93% reported visibly firmer-looking skin.";
    const sanitized = sanitizePdpSemanticFacts({
      ingredients: [
        "Ginseng Peptide",
        "absorption",
        "INGREDIENTS: WATER, GLYCERIN, NIACINAMIDE, SQUALANE, PANTHENOL, RETINOL, CERAMIDE NP, TOCOPHEROL, XANTHAN GUM"
      ],
      benefits: ["visibly firmer-looking skin", "After 6 weeks", "60mL"],
      effects: ["supports visible firmness", "after 1 weeks"],
      skinTypes: ["normal skin", "Patch testing is recommended for sensitive skin users."],
      usageSteps: [
        "After applying toner, dispense two pumps and smooth over the face.",
        "Patch testing is recommended for sensitive skin users.",
        "After 6 weeks."
      ],
      metricClaims: [
        { sentence: "93%", sourceText: "93%" },
        { sentence: "60mL", sourceText: "60mL" },
        { sentence: atomicStudy, sourceText: atomicStudy }
      ],
      evidenceSentences: [atomicStudy],
      ingredientBenefitLinks: [{
        ingredient: "Ginseng Peptide",
        benefit: "visibly firmer-looking skin",
        sentence: "Ginseng Peptide helps support visibly firmer-looking skin.",
        sourceText: "Ginseng Peptide helps support visibly firmer-looking skin."
      }]
    });

    expect(sanitized.ingredients).toContain("Ginseng Peptide");
    expect(sanitized.ingredients).not.toContain("absorption");
    expect(sanitized.benefits).not.toEqual(expect.arrayContaining(["After 6 weeks", "60mL"]));
    expect(sanitized.usageSteps).toEqual(["After applying toner, dispense two pumps and smooth over the face."]);
    expect(sanitized.skinTypes).toEqual(["normal skin"]);
    expect(sanitized.metricClaims).toHaveLength(1);
    expect(sanitized.metricClaims[0]?.sourceText).toBe(atomicStudy);
    expect(sanitized.ingredientBenefitLinks).toHaveLength(1);
  });

  it("requires an explicit semantic link before relating an ingredient to a benefit", async () => {
    const product: PdpProductSignal = {
      name: "Clear Serum",
      description: "A face serum.",
      category: "serum",
      images: [],
      options: [],
      ingredients: ["Niacinamide"],
      benefits: ["hydration"],
      effects: [],
      usage: [],
      metrics: [],
      faq: [],
      breadcrumbs: [],
      sourceTexts: [],
      reviews: {
        keywords: ["lightweight texture"],
        items: [{ body: "Clear Serum feels light and absorbs quickly.", rating: 5 }]
      }
    };
    const unlinked = await generatePdpGeo({ product, hints: { locale: "en-US" } });
    const unlinkedGraph = unlinked.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const unlinkedNodes = unlinkedGraph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = unlinkedNodes.find((node) => node["@type"] === "Product")!;
    const webPageNode = unlinkedNodes.find((node) => node["@type"] === "WebPage")!;
    const unlinkedDescriptions = `${String(productNode.description)} ${String(webPageNode.description)}`;

    expect(unlinkedDescriptions).not.toMatch(/Niacinamide[^.!?]{0,50}(?:support|help|deliver)[^.!?]{0,30}hydration/iu);
    expect(String(productNode.description)).toContain("Clear Serum includes Niacinamide");
    expect(String(productNode.description)).toContain("The product's documented benefit is hydration");
    expect(String(productNode.description)).toContain("One customer review highlights");
    expect(String(productNode.description)).toContain("lightweight texture");
    expect(String(productNode.description)).toContain("quick absorption");
    expect(String(productNode.description)).not.toMatch(/reviews? (?:repeatedly )?report|repeated review/i);
    expect(String(productNode.description)).not.toContain("for customers");
    expect(String(webPageNode.description)).toMatch(/^This Clear Serum product page introduces the serum\./u);
    expect(String(webPageNode.description)).not.toMatch(/for customers|introduces[^.!?]*through/iu);
    expect(String(productNode.description).match(/Clear\s+Serum/gu)?.length ?? 0).toBe(2);
    expect(String(webPageNode.description).match(/Clear\s+Serum/gu)?.length ?? 0).toBe(1);
    expect(String(webPageNode.description)).toMatch(/lists Niacinamide as highlighted formula components.*documents hydration as product benefits/iu);
    expect(String(webPageNode.description)).toMatch(/One customer review highlights lightweight texture, quick absorption, and texture/iu);
    expect(String(webPageNode.description)).not.toMatch(/The formula includes Niacinamide|documented benefit is hydration/iu);
    expect(unlinked.result.content.sections.ingredients).toBe("- Niacinamide");
    expect(unlinkedDescriptions).not.toMatch(/dry\s+skin|skin[-\s]?barrier|aging|wrinkle/iu);

    const faqNode = unlinkedNodes.find((node) => node["@type"] === "FAQPage")!;
    const faqQuestions = (faqNode.mainEntity as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item))
      .map((item) => String(item.name ?? ""));
    expect(faqQuestions).toContain("What are the main benefits of Clear Serum?");
    expect(faqQuestions.join(" ")).not.toMatch(/what product evidence supports|\bthis (?:product|serum)\b/iu);

    const linked = await generatePdpGeo({
      product: {
        ...product,
        reviews: { items: [], keywords: [] },
        semanticFacts: {
          ingredients: ["Niacinamide"],
          benefits: ["hydration"],
          effects: [],
          skinTypes: [],
          usageSteps: [],
          metricClaims: [],
          evidenceSentences: ["Niacinamide supports hydration."],
          ingredientBenefitLinks: [{
            ingredient: "Niacinamide",
            benefit: "hydration",
            sentence: "Niacinamide supports hydration.",
            sourceText: "Niacinamide supports hydration."
          }]
        }
      },
      hints: { locale: "en-US" }
    });
    const linkedGraph = linked.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    expect(JSON.stringify(linkedGraph)).toMatch(/Niacinamide[^.!?]{0,30}support hydration/iu);
  });

  it("renders Sulwhasoo US composition, clinical timelines, and benefit FAQ as natural attributable English", async () => {
    const { result } = await generatePdpGeo({
      product: {
        name: "Sulwhasoo Hydro Balance Cream",
        brand: "Sulwhasoo",
        description: "A lightweight cream for customers concerned about dehydration and visible loss of firmness.",
        category: "Cream",
        ingredients: ["Ginseng Peptide", "Hyaluronic Acid"],
        benefits: ["hydration", "visible firmness"],
        effects: ["helps improve hydration and visible firmness"],
        usage: ["Apply evenly to the face after serum."],
        metrics: [],
        faq: [],
        images: [],
        options: [],
        breadcrumbs: [],
        sourceTexts: [],
        reviews: { keywords: ["lightweight texture"], items: [] },
        semanticFacts: {
          ingredients: ["Ginseng Peptide", "Hyaluronic Acid"],
          benefits: ["hydration", "visible firmness"],
          effects: ["helps improve hydration and visible firmness"],
          skinTypes: [],
          usageSteps: ["Apply evenly to the face after serum."],
          evidenceSentences: [],
          ingredientBenefitLinks: [],
          metricClaims: [{
            label: "Skin moisture balance",
            metric: "Skin moisture balance",
            value: "81.0 / 35.8 / 61.7",
            unit: "%",
            timing: "before use, immediately after use, 12 hours after use",
            period: "2025.09.15-2025.10.14",
            sample: "30 women ages 20 to 39 with self-identified oily skin",
            method: "clinical study",
            institution: "Global Medical Research Center",
            sentence: "In a clinical study of 30 women, skin moisture balance improved after product use.",
            sourceText: "Clinical study of 30 women conducted from 2025.09.15 to 2025.10.14."
          }]
        }
      },
      hints: { locale: "en-US", market: "US" }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const description = String(product.description);
    const questions = (faq.mainEntity as Array<Record<string, any>>).map((item) => String(item.name));

    expect(description.match(/Sulwhasoo Hydro Balance Cream/gu)?.length ?? 0).toBe(2);
    expect(description).toMatch(/Sulwhasoo Hydro Balance Cream (?:includes|combines|uses) Ginseng Peptide and Hyaluronic Acid/iu);
    expect(description).toContain("In a clinical study conducted by Global Medical Research Center from September 15, 2025 to October 14, 2025 involving 30 women ages 20 to 39 with self-identified oily skin");
    expect(description).toContain("Skin moisture balance was measured at 81.0% before use, 35.8% immediately after use, and 61.7% 12 hours after use");
    expect(description).not.toMatch(/\((?:timing|sample|period|method|institution)\b|Reported result:/iu);
    expect(questions).toContain("What are the main benefits of Sulwhasoo Hydro Balance Cream, and what do the reported clinical study results show?");
    expect(questions.join(" ")).not.toMatch(/what product evidence supports|\bthis (?:product|cream)\b/iu);
  });

  it("keeps review-only Korean terms out of ingredients and does not expand hydration into an audience", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "클리어 세럼",
        description: "얼굴용 세럼입니다.",
        category: "세럼",
        ingredients: ["나이아신아마이드"],
        benefits: ["수분감"],
        reviews: {
          keywords: ["촉촉함", "피부결"],
          items: [{ body: "클리어 세럼은 촉촉하고 피부결이 매끄럽게 느껴집니다.", rating: 5 }]
        }
      },
      hints: { locale: "ko-KR" }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const properties = (productNode.additionalProperty as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const description = String(productNode.description ?? "");

    expect(run.result.content.sections.ingredients).toBe("- 나이아신아마이드");
    expect(run.result.content.sections.ingredients).not.toMatch(/촉촉|피부결/u);
    expect(description).toMatch(/촉촉한 사용감/u);
    expect(description).toMatch(/매끄러운 피부결/u);
    expect(description).not.toMatch(/나이아신아마이드[^.!?。！？]{0,50}(?:수분|보습)[^.!?。！？]{0,20}(?:돕|도와)/u);
    expect(description).not.toMatch(/고객을 위한/u);
    expect(JSON.stringify(properties)).not.toMatch(/Target customer|Recommended skin type/u);
    expect(description).not.toMatch(/건조|장벽/u);
  });

  it("deduplicates equivalent suitability FAQ while preserving direct ingredient-benefit FAQ in Korean and English", async () => {
    const cases: Array<{ locale: "ko-KR" | "en-US"; product: PdpProductSignal }> = [
      {
        locale: "en-US",
        product: {
          name: "Hydra Serum",
          description: "A hydrating serum suitable for dry skin.",
          category: "serum",
          images: [],
          options: [],
          ingredients: ["Niacinamide"],
          benefits: ["hydration"],
          effects: [],
          usage: [],
          metrics: [],
          breadcrumbs: [],
          sourceTexts: [],
          faq: [
            { question: "Which customers is Hydra Serum suitable for?", answer: "Hydra Serum is suitable for customers with dry skin seeking hydration." },
            { question: "Who is Hydra Serum best suited for, and which concerns does it address?", answer: "It is suited to dry skin customers comparing hydration." },
            { question: "What are the key ingredients and benefits of Hydra Serum?", answer: "The formula includes Niacinamide. Its documented benefit is hydration." }
          ],
          reviews: { items: [], keywords: [] }
        }
      },
      {
        locale: "ko-KR",
        product: {
          name: "하이드라 세럼",
          description: "건조 피부의 수분 케어에 적합한 세럼입니다.",
          category: "세럼",
          images: [],
          options: [],
          ingredients: ["나이아신아마이드"],
          benefits: ["수분감"],
          effects: [],
          usage: [],
          metrics: [],
          breadcrumbs: [],
          sourceTexts: [],
          faq: [
            { question: "하이드라 세럼은 어떤 고객에게 적합한가요?", answer: "건조 피부로 수분 케어가 필요한 고객에게 적합합니다." },
            { question: "하이드라 세럼은 어떤 피부 고민과 효능에 적합한가요?", answer: "건조 피부 고객이 수분 케어를 비교할 때 적합합니다." },
            { question: "하이드라 세럼의 주요 성분과 효능은 무엇인가요?", answer: "나이아신아마이드가 포함되어 있으며 주요 효능은 수분감입니다." }
          ],
          reviews: { items: [], keywords: [] }
        }
      }
    ];

    for (const testCase of cases) {
      const run = await generatePdpGeo({ product: testCase.product, hints: { locale: testCase.locale } });
      const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
      const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
      const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
      const questions = (faqPage.mainEntity as JsonValue[])
        .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item))
        .map((item) => String(item.name));
      const suitabilityQuestions = questions.filter((question) => testCase.locale === "ko-KR"
        ? /(?:어떤 고객|피부 고민[^?]*적합|고민인 고객[^?]*(?:효과|적합)|고객에게[^?]*적합)/u.test(question)
        : /(?:which customers[^?]*suitable|who[^?]*best suited|skin concerns[^?]*address)/iu.test(question));

      expect(suitabilityQuestions).toHaveLength(1);
      expect(questions.some((question) => testCase.locale === "ko-KR"
        ? /구성 성분.*효능[·・]?효과/u.test(question)
        : /key ingredients?.*supported benefits?/iu.test(question))).toBe(true);
      expect(questions[0]).toBe(suitabilityQuestions[0]);
    }
  });

  it("keeps a model plan authoritative and creates a clean query from CEP-only evidence", async () => {
    const source = "피부가 건조할 때 촉촉한 사용감과 끈적임이 적은 마무리가 필요한 고객을 위한 세럼입니다.";
    const product: PdpProductSignal = {
      name: "하이드라 세럼",
      description: source,
      category: "세럼",
      images: [],
      options: [],
      benefits: ["수분감"],
      effects: [],
      ingredients: ["히알루론산"],
      usage: [],
      metrics: [],
      faq: [],
      breadcrumbs: [],
      sourceTexts: [source],
      reviews: {
        keywords: ["촉촉한 사용감"],
        items: [
          { body: "피부가 건조할 때 촉촉해서 만족했습니다.", rating: 5 },
          { body: "주름 고민에는 효과를 느끼지 못했습니다.", rating: 2 }
        ]
      }
    };
    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } }, {
      customContentPlanner: {
        planContent(request) {
          const evidence = request.evidenceLedger.find((item) => item.text.includes("피부가 건조할 때"))!;
          return {
            plan: planPayload({
              cep: [{
                situation: "피부가 건조할 때",
                need: "촉촉한 사용감",
                constraint: "끈적임이 적은 마무리",
                evidenceIds: [evidence.id],
                confidence: 0.9
              }]
            })
          };
        }
      }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const faqText = JSON.stringify(nodes.find((node) => node["@type"] === "FAQPage")?.mainEntity ?? []);
    const properties = (productNode.additionalProperty as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const queries = run.result.diagnostics.inferredSearchQueries ?? [];

    expect(run.result.diagnostics.contentPlan?.mode).toBe("model");
    expect(run.result.diagnostics.contentPlan?.cep).toHaveLength(1);
    const cepQuery = queries.find((query) => /피부가 건조할 때 촉촉한 사용감이 필요한 경우/u.test(query.question));
    expect(cepQuery?.question).toMatch(/피부가 건조할 때 촉촉한 사용감이 필요한 경우 어떤 세럼이 적합한가요\?/u);
    expect(cepQuery?.answer).toMatch(/피부가 건조할 때 촉촉한 사용감을 고려한 세럼/u);
    expect(`${cepQuery?.question} ${cepQuery?.answer}`).not.toMatch(/촉촉한 사용감 같은 사용감|주름/u);
    expect(queries.some((query) => query.kind === "direct")).toBe(true);
    expect(properties.some((item) => item.name === "Customer situation")).toBe(true);
    expect(properties.some((item) => item.name === "Review-derived recommendation context")).toBe(false);
    expect(properties.some((item) => item.propertyID === "indirectCustomerQuestion" || item.propertyID === "directProductQuestion")).toBe(false);
    expect(String(productNode.description)).not.toMatch(/효과를 느끼지 못/u);
    expect(faqText).not.toMatch(/주름/u);
    expect(faqText).not.toMatch(/촉촉한 사용감 같은 (?:긍정적 )?사용감/u);

    const audienceSource = "건조 피부 고객에게 피부 장벽 보습이 필요한 세럼입니다.";
    const audienceRun = await generatePdpGeo({
      product: { ...product, description: audienceSource, sourceTexts: [audienceSource] },
      hints: { locale: "ko-KR" }
    }, {
      customContentPlanner: {
        planContent(request) {
          const evidence = request.evidenceLedger.find((item) => item.text.includes("건조 피부 고객"))!;
          return {
            plan: planPayload({
              cep: [{
                situation: "건조 피부 고객",
                need: "피부 장벽 보습",
                constraint: "",
                evidenceIds: [evidence.id],
                confidence: 0.9
              }]
            })
          };
        }
      }
    });
    const audienceQuery = audienceRun.result.diagnostics.inferredSearchQueries?.find((query) =>
      /^건조 피부 고객에게 피부 장벽 보습이 필요한 경우/u.test(query.question)
    );
    expect(audienceQuery?.question).toMatch(/^건조 피부 고객에게 피부 장벽 보습이 필요한 경우/u);
    expect(audienceQuery?.answer).toMatch(/건조 피부 고객에게 필요한 피부 장벽 보습을 다루는 세럼/u);
  });

  it("restores required product FAQ without restoring review-derived properties from an empty model plan", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "하이드라 세럼",
        description: "수분감을 제공하는 세럼입니다.",
        category: "세럼",
        benefits: ["수분감"],
        ingredients: ["히알루론산"],
        reviews: {
          keywords: ["촉촉한 사용감"],
          items: [{ body: "피부가 촉촉해서 만족했습니다.", rating: 5 }]
        }
      },
      hints: { locale: "ko-KR" }
    }, {
      customContentPlanner: { planContent: () => ({ plan: planPayload() }) }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const productNode = nodes.find((node) => node["@type"] === "Product")!;
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage");
    const properties = (productNode.additionalProperty as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const faqRepairs = (run.result.diagnostics.validationRepairs ?? []).filter((repair) =>
      /^(?:FAQPage\.mainEntity|content\.sections\.faq|content\.html)$/u.test(repair.field));

    expect(run.result.diagnostics.contentPlan?.mode).toBe("model");
    const plannedFaq = run.result.diagnostics.contentPlan?.faq ?? [];
    expect(plannedFaq[0]?.intent).toBe("target-customer-recommendation");
    expect(plannedFaq[1]?.intent).toBe("composition-benefit-effect");
    expect(faqPage).toBeDefined();
    expect(run.result.content.sections.faq).toMatch(/어떤 고객|추천/u);
    expect(run.result.content.sections.faq).toMatch(/구성 성분과 효능[·・]?효과/u);
    expect(JSON.stringify(run.result.diagnostics.inferredSearchQueries)).not.toMatch(/주름|효과를 느끼지 못/u);
    expect(faqRepairs).toHaveLength(0);
    expect(properties.some((item) => item.name === "Review-derived recommendation context")).toBe(false);
    expect(properties.some((item) => item.propertyID === "indirectCustomerQuestion" || item.propertyID === "directProductQuestion")).toBe(false);
  });

  it("replaces deictic Korean FAQ subjects with the exact product name", async () => {
    const productName = "에스트라 아토베리어365 하이드로 수딩크림";
    const rawQuestion = "이 크림의 핵심 성분과 효능은 어떻게 구분해 보면 되나요?";
    const namedQuestion = `${productName}의 핵심 성분과 효능은 어떻게 구분해 보면 되나요?`;
    const answer = `${productName}의 핵심 성분은 압축 히알루론산과 고밀도 세라마이드 캡슐이며, 완제품 효능은 피부 장벽 케어와 수분 케어입니다.`;
    const product: PdpProductSignal = {
      name: productName,
      description: "수분이 부족한 민감 지성 피부를 위한 장벽 수분 크림입니다.",
      category: "크림",
      images: [],
      options: [],
      benefits: ["피부 장벽 케어", "수분 케어"],
      effects: [],
      ingredients: ["압축 히알루론산", "고밀도 세라마이드 캡슐"],
      faq: [{ question: rawQuestion, answer }],
      usage: [],
      metrics: [],
      breadcrumbs: [],
      reviews: { items: [], keywords: [] },
      sourceTexts: [answer]
    };
    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } }, {
      customContentPlanner: {
        planContent(request) {
          const evidence = request.evidenceLedger.find((item) => item.role === "faq" && item.text.includes(rawQuestion))!;
          return {
            plan: planPayload({
              faq: [{
                include: true,
                question: rawQuestion,
                answer,
                intent: "composition-benefit-effect",
                cep: "핵심 성분과 완제품 효능 구분",
                evidenceIds: [evidence.id],
                confidence: 0.97,
                omitReason: ""
              }]
            })
          };
        }
      }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const questions = (faqPage.mainEntity as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item))
      .map((item) => String(item.name));

    expect(questions).toContain(namedQuestion);
    expect(questions).not.toContain(rawQuestion);
    expect(run.result.content.sections.faq).toContain(`Q. ${namedQuestion}`);
  });

  it("keeps the approved FAQ first while completing required and applicable FAQ coverage", async () => {
    const approvedQuestion = "배리어 로션은 어떤 고객에게 적합한가요?";
    const approvedAnswer = "배리어 로션은 건조하고 민감한 피부 고객에게 적합한 보습 로션입니다.";
    const excludedQuestion = "배리어 로션은 어떻게 사용하나요?";
    const product: PdpProductSignal = {
      name: "배리어 로션",
      description: approvedAnswer,
      category: "로션",
      images: [],
      options: [],
      benefits: ["피부 보습"],
      effects: [],
      ingredients: ["세라마이드"],
      faq: [
        { question: approvedQuestion, answer: approvedAnswer },
        { question: excludedQuestion, answer: "세안 후 적당량을 얼굴에 고르게 펴 바릅니다." }
      ],
      usage: ["세안 후 적당량을 얼굴에 고르게 펴 바릅니다."],
      metrics: [],
      breadcrumbs: [],
      reviews: { items: [], keywords: [] },
      sourceTexts: [approvedAnswer]
    };
    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } }, {
      customContentPlanner: {
        planContent(request) {
          const evidence = request.evidenceLedger.find((item) => item.role === "faq" && item.text.includes(approvedQuestion))!;
          return {
            plan: planPayload({
              faq: [{
                include: true,
                question: approvedQuestion,
                answer: approvedAnswer,
                intent: "target-customer-suitability",
                cep: "건조하고 민감한 피부 고객의 피부 보습",
                evidenceIds: [evidence.id],
                confidence: 0.96,
                omitReason: ""
              }]
            })
          };
        }
      }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const faqItems = (faqPage.mainEntity as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const renderedFaq = faqItems.map((item) => ({
      question: String(item.name),
      answer: String((item.acceptedAnswer as Record<string, JsonValue>).text)
    }));

    const plannedQuestions = run.result.diagnostics.contentPlan?.faq.map((item) => item.question) ?? [];
    expect(plannedQuestions[0]).toBe(approvedQuestion);
    expect(plannedQuestions[1]).toMatch(/구성 성분과 효능[·・]?효과/u);
    expect(renderedFaq.map((item) => item.question)).toEqual(plannedQuestions);
    expect(run.result.content.sections.faq).toContain(`Q. ${approvedQuestion}\nA. ${approvedAnswer}`);
    expect(run.result.content.html).toBe("");
    expect((run.result.diagnostics.validationRepairs ?? []).filter((repair) =>
      /^(?:FAQPage\.mainEntity|content\.sections\.faq|content\.html)$/u.test(repair.field))).toHaveLength(0);
  });

  it("keeps positive low-stickiness review FAQ, excludes complaints, and keeps texture answers factual", async () => {
    const product: PdpProductSignal = {
      name: "배리어 로션",
      description: "건조하고 민감한 피부 고객을 위한 보습 로션입니다. 세라마이드가 피부 보습 장벽 강화를 돕습니다.",
      category: "로션",
      images: [],
      options: [],
      benefits: ["피부 보습 장벽 강화"],
      effects: ["피부 보습"],
      ingredients: ["세라마이드"],
      usage: ["세안 후 적당량을 얼굴에 고르게 펴 바릅니다."],
      metrics: [],
      faq: [],
      breadcrumbs: [],
      reviews: {
        keywords: ["촉촉한 사용감", "피부결", "끈적임이 적은 마무리", "향이 강해 불편"],
        items: [
          { body: "촉촉하게 발리면서 끈적임이 적은 마무리가 만족스럽습니다.", rating: 5 },
          { body: "향이 강해 불편했습니다.", rating: 2 }
        ]
      },
      sourceTexts: [
        "세라마이드가 피부 보습 장벽 강화를 돕습니다.",
        "촉촉한 사용감과 끈적임이 적은 마무리가 특징입니다."
      ]
    };
    const run = await generatePdpGeo({ product, hints: { locale: "ko-KR" } });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const faqItems = (faqPage.mainEntity as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const faqPairs = faqItems.map((item) => ({
      question: String(item.name),
      answer: String((item.acceptedAnswer as Record<string, JsonValue>).text)
    }));
    const reviewFaq = faqPairs.find((item) => /고객\s*리뷰|리뷰에서/u.test(item.question));
    const textureFaq = faqPairs.find((item) => /제형이나\s*사용감/u.test(item.question));
    const faqText = JSON.stringify(faqPairs);

    expect(reviewFaq).toBeDefined();
    expect(reviewFaq?.answer).toContain("끈적임이 적은 마무리");
    expect(faqText).not.toMatch(/향이\s*강해\s*불편/u);
    expect(textureFaq).toBeDefined();
    expect(textureFaq?.answer).toMatch(/사용감(?:은|이|가)|마무리(?:는|이|가)/u);
    expect(textureFaq?.answer).not.toMatch(/고객\s*리뷰|리뷰에서는|후기/u);
    expect((run.result.diagnostics.validationRepairs ?? []).filter((repair) =>
      /^(?:FAQPage\.mainEntity|FAQPage\.mainEntity\.acceptedAnswer\.text|content\.sections\.faq|content\.html)$/u.test(repair.field))).toHaveLength(0);
  });

  it("keeps broad skin-type scope consistent and removes overlapping suitability FAQ before validation", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "Rejuvenating Serum",
        description: "A rejuvenating serum for firmness and elasticity.",
        category: "Serum",
        benefits: ["firmness", "elasticity"],
        ingredients: ["Ginseng Peptide"],
        faq: [{
          question: "Is this serum suitable for all skin types?",
          answer: "Rejuvenating Serum is suitable for most skin types, including normal and combination skin. Patch testing is recommended for sensitive skin users."
        }],
        sourceTexts: ["Suitable for most skin types, including normal and combination skin."]
      },
      hints: { locale: "en-US", market: "US" }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const product = nodes.find((node) => node["@type"] === "Product")!;
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const faqItems = faqPage.mainEntity as Array<Record<string, JsonValue>>;
    const properties = product.additionalProperty as Array<Record<string, JsonValue>>;
    const suitabilityFaq = faqItems.filter((item) => /skin\s*types?|best\s+suited|suitable\s+for/iu.test(String(item.name)));

    expect(String(product.description)).toContain("customers across most skin types");
    expect(properties.find((item) => item.name === "Target customer")?.value).toBe("most skin types");
    expect(suitabilityFaq).toHaveLength(1);
    expect(JSON.stringify(suitabilityFaq)).not.toMatch(/normal skin or combination skin/iu);
    expect(run.result.diagnostics.validationRepairs ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "FAQPage.mainEntity" })
    ]));
  });

  it("rejects weak safety FAQ answers and avoids double-subject Korean leads", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "배리어 로션",
        description: "민감하고 건조한 피부에 특화된 보습 로션입니다.",
        category: "로션",
        benefits: ["피부 장벽", "수분감"],
        ingredients: ["세라마이드"],
        faq: [
          {
            question: "건성 피부라 피부가 따가운 상태인데 이 제품을 써도 될까요?",
            answer: "배리어 라인은 민감하고 건조한 피부에 특화된 보습 솔루션을 제공합니다."
          },
          {
            question: "신생아가 사용해도 되는 제품인가요?",
            answer: "배리어 로션은 세라마이드가 피부 장벽과 보습을 돕는 제품입니다."
          }
        ],
        sourceTexts: [
          "배리어 라인은 민감하고 건조한 피부에 특화된 보습 솔루션을 제공합니다.",
          "제형. 수분젤 제형이라 빠르고 산뜻하게 흡수되는 수분감입니다."
        ]
      },
      hints: { locale: "ko-KR", market: "KR" }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const nodes = graph.filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node));
    const product = nodes.find((node) => node["@type"] === "Product")!;
    const faqPage = nodes.find((node) => node["@type"] === "FAQPage")!;
    const faqText = JSON.stringify(faqPage.mainEntity);

    expect(String(product.description)).toMatch(/배리어 로션은 건조하고 민감한 피부 고객을 위한 로션입니다/u);
    expect(String(product.description)).not.toMatch(/로션은\s+배리어\s+라인은/u);
    expect(faqText).not.toMatch(/따가운\s*상태.*써도|신생아가\s*사용/u);
    expect(faqText).not.toMatch(/제형이라[^.]*수분감입니다,|효능[^.]*효능[^.]*뒷받침|케어와\s*연결됩니다|사용\s*루틴\s*답변/u);
  });
});

function evidenceRichProduct(): PdpProductSignal {
  const ingredientBenefitEvidence = "세라마이드 캡슐이 건조하고 민감한 피부의 피부 장벽 보습을 돕는다고 설명됩니다.";
  const retainedMetric = "캡슐 제형은 비캡슐 대비 세정 실험에서 190% 높은 잔존 효과가 표시되며, 원료적 특성에 한한 ex vivo 테스트 결과입니다.";
  return {
    name: "하이드라 배리어 크림",
    originalName: "하이드라 배리어 크림 80 mL",
    description: `건조하고 민감한 피부 고객을 위한 크림으로, ${ingredientBenefitEvidence}`,
    brand: "테스트랩",
    category: "크림",
    images: [],
    options: ["80 mL"],
    benefits: ["피부 장벽 보습", "120시간 보습 지속"],
    effects: ["피부 장벽 강화", "보습 지속"],
    ingredients: ["고밀도 세라마이드 캡슐", "Ceramide NP", "콜레스테롤"],
    usage: ["세안 후 적당량을 피부에 골고루 펴 바릅니다.", "부드럽게 피부를 눌러 흡수를 도와주세요."],
    metrics: ["190%", retainedMetric, "사용 2시간 후 겉보습 242%, 속보습 356%가 표시됩니다."],
    faq: [
      {
        question: "하이드라 배리어 크림은 어떤 고객에게 적합한가요?",
        answer: "건조하고 민감한 피부 고객이 피부 장벽 보습을 고려할 때 사용할 수 있습니다."
      },
      {
        question: "건조하고 민감한 피부 고민에 어떤 성분이 도움이 되나요?",
        answer: ingredientBenefitEvidence
      }
    ],
    reviews: {
      items: [{ body: "건조할 때 사용하면 촉촉하고 편안한 사용감이 오래간다는 점이 만족스러웠습니다." }],
      keywords: ["촉촉한 사용감", "피부 장벽"]
    },
    breadcrumbs: [],
    sourceTexts: [ingredientBenefitEvidence, retainedMetric, "추천 피부 타입은 건조 피부 또는 민감 피부입니다."],
    semanticFacts: {
      ingredients: ["고밀도 세라마이드 캡슐", "Ceramide NP", "흡수력", "유지력", "보습 캡슐", "견고한 구조"],
      benefits: ["피부 장벽 보습"],
      effects: ["피부 장벽 강화"],
      skinTypes: ["건조 피부", "민감 피부"],
      usageSteps: ["세안 후 적당량을 피부에 골고루 펴 바릅니다.", "부드럽게 피부를 눌러 흡수를 도와주세요."],
      metricClaims: [
        { sentence: "190%", sourceText: "190%" },
        { sentence: retainedMetric, sourceText: retainedMetric }
      ],
      evidenceSentences: [ingredientBenefitEvidence, retainedMetric],
      ingredientBenefitLinks: [{
        ingredient: "세라마이드 캡슐",
        benefit: "피부 장벽 보습",
        sentence: ingredientBenefitEvidence,
        sourceText: ingredientBenefitEvidence
      }]
    }
  };
}

function planPayload(overrides: Partial<Omit<PdpGeoContentPlan, "mode">> = {}): Omit<PdpGeoContentPlan, "mode"> {
  return {
    locale: "ko-KR",
    productDescription: {
      include: false,
      text: "",
      intent: "product-entity-summary",
      evidenceIds: [],
      confidence: 0,
      omitReason: "insufficient evidence"
    },
    webPageDescription: {
      include: false,
      text: "",
      intent: "page-coverage-summary",
      evidenceIds: [],
      confidence: 0,
      omitReason: "insufficient evidence"
    },
    faq: [],
    howTo: {
      eligible: false,
      ordered: false,
      goal: "",
      steps: [],
      evidenceIds: [],
      confidence: 0,
      omitReason: "not a procedure"
    },
    cep: [],
    warnings: [],
    ...overrides
  };
}

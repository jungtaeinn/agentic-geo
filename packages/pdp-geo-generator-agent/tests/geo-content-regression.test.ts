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
    expect(webPageDescription).toMatch(/상품\s*페이지/u);
    expect(webPageDescription).toMatch(/세라마이드/u);
    expect(webPageDescription).not.toBe("하이드라 배리어 크림에 대해 제공된 정보를 확인할 수 있는 상품 페이지입니다.");
    expect(webPageDescription).not.toMatch(/(?:필요|고민|효능|효과|케어|보습|장벽|수분)[^.!?。！？]{0,90}(?:비교|확인|살펴|고려)할\s*수\s*있습니다/u);
    const targetIndex = webPageDescription.indexOf("건조하고 민감한 피부");
    const ingredientIndex = webPageDescription.indexOf("세라마이드");
    const benefitIndex = webPageDescription.indexOf("피부 장벽");
    const reviewIndex = webPageDescription.indexOf("고객 리뷰");
    expect(targetIndex).toBeGreaterThan(-1);
    expect(targetIndex).toBeLessThan(ingredientIndex);
    expect(ingredientIndex).toBeLessThan(benefitIndex);
    expect(benefitIndex).toBeLessThan(reviewIndex);
    const webPageSentences = webPageDescription.split(/(?<=[.!?。！？])\s+/u);
    expect(webPageSentences.some((sentence) => /세라마이드/u.test(sentence) && /사용|포함|적용|구성/u.test(sentence))).toBe(true);
    expect(webPageSentences.some((sentence) => /피부\s*장벽|보습/u.test(sentence) && /도와|돕/u.test(sentence))).toBe(true);

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

    for (const description of [String(productNode.description ?? ""), String(webPage.description ?? "")]) {
      expect(description).toContain("35%");
      expect(description).toMatch(/기기\s*측정\s*시험/u);
      expect(description).toMatch(/사용\s*2시간\s*후/u);
      expect(description).not.toMatch(/10,000\s*ppm|평점\s*4\.9|리뷰\s*190개|30%\s*할인/u);
      expect(description).not.toMatch(/확인\s*지표|평가\s*지표|결과가\s*제시|수치가\s*제시/u);
      expect(description.indexOf("세라마이드")).toBeLessThan(description.indexOf("35%"));
      expect(description.search(/피부\s*장벽|보습|수분\s*케어/u)).toBeLessThan(description.indexOf("35%"));
      expect(description.indexOf("35%")).toBeLessThan(description.indexOf("고객 리뷰"));
    }

    expect(reportedDetails).toContain("35%");
    expect((run.result.diagnostics.validationRepairs ?? []).filter((repair) => /description/u.test(repair.field))).toHaveLength(0);
  });

  it("connects Korean ingredient, benefit, and source-backed concern without repeating the product entity", async () => {
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

    expect(productDescription.match(/하이드라\s*배리어\s*크림/gu)?.length ?? 0).toBe(1);
    expect(webPageDescription.match(/하이드라\s*배리어\s*크림/gu)?.length ?? 0).toBe(2);
    expect(productDescription).toMatch(/주요\s*성분은\s*고밀도\s*세라마이드\s*캡슐과\s*콜레스테롤이며,\s*피부\s*장벽\s*케어와\s*(?:속보습을|수분\s*케어를)\s*도와\s*건조하고\s*민감한\s*피부가\s*고민인\s*고객에게\s*적합합니다/u);
    expect(webPageDescription).toMatch(/하이드라\s*배리어\s*크림은\s*주요\s*성분인\s*고밀도\s*세라마이드\s*캡슐과\s*콜레스테롤로\s*구성되어\s*있으며,\s*피부\s*장벽\s*케어와\s*(?:속보습을|수분\s*케어를)\s*도와\s*건조하고\s*민감한\s*피부가\s*고민인\s*고객에게\s*적합합니다/u);
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

    expect(faqItems.some((item) => /주요\s*성분과\s*효능/u.test(String(item.name ?? "")))).toBe(true);
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

    for (const description of [String(productNode.description ?? ""), String(webPage.description ?? "")]) {
      expect(description).toMatch(/주요\s*성분(?:은|인)\s*고밀도\s*세라마이드\s*캡슐과\s*콜레스테롤(?:입니다|이며|로\s*구성(?:됩니다|되며|되어\s*있습니다|되어\s*있으며))/u);
      expect(description).toMatch(/한\s*번\s*사용\s*후\s*보습이\s*120시간\s*지속됩니다/u);
      expect(description).toMatch(/\(주\)테스트리서치/u);
      expect(description).toMatch(/2024년\s*1월\s*2일부터\s*2024년\s*2월\s*16일까지/u);
      expect(description).toMatch(/여성\s*32명/u);
      expect(description).toMatch(/사용\s*직후\s*보습량은\s*사용\s*전\s*대비\s*2배\s*증가/u);
      expect(description).toMatch(/단\s*10분\s*만에\s*손상\s*장벽은\s*사용\s*전\s*대비\s*2배\s*개선/u);
      expect(description).toMatch(/건조하고\s*민감한\s*피부(?:가\s*고민인)?\s*고객에게\s*적합합니다/u);
      expect(description).not.toMatch(/190%|ex\s*vivo/iu);
      expect(description.indexOf("고밀도 세라마이드 캡슐")).toBeLessThan(description.indexOf("피부 장벽 케어"));
      expect(description.indexOf("피부 장벽 케어")).toBeLessThan(description.indexOf("120시간"));
      expect(description.indexOf("120시간")).toBeLessThan(description.indexOf("고객 리뷰"));
    }

    expect(reportedDetails).toMatch(/120시간|\(주\)테스트리서치|여성\s*32명|사용\s*전\s*대비/u);
    expect(reportedDetails.match(/한\s*번\s*사용\s*후\s*보습이\s*120시간\s*지속/gu)?.length ?? 0).toBe(1);
    expect(reportedDetails).toMatch(/원료적\s*특성에\s*한한\s*ex\s*vivo\s*테스트에서[^.!?。！？]*190%[^.!?。！？]*잔존\s*효과가\s*확인/u);
    expect(reportedDetails).not.toMatch(/(?:확인|평가)\s*지표\s*:/u);
    expect(reportedDetails).not.toMatch(/건조하고\s*민감한\s*피부\s*고객에게\s*적합합니다/u);
    expect((run.result.diagnostics.validationRepairs ?? []).filter((repair) => /description/u.test(repair.field))).toHaveLength(0);
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
    const descriptions = graph
      .filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node))
      .filter((node) => node["@type"] === "Product" || node["@type"] === "WebPage")
      .map((node) => String(node.description ?? ""));

    for (const description of descriptions) {
      expect(description).toMatch(/한\s*번\s*사용\s*후\s*보습이\s*96시간\s*지속/u);
      expect(description).toMatch(/\(주\)풋노트리서치[^.!?。！？]*성인\s*30명[^.!?。！？]*인체적용시험/u);
      expect(description).toMatch(/사용\s*직후\s*보습량은\s*1\.8배\s*증가/u);
      expect(description).toMatch(/단\s*15분\s*만에\s*손상\s*장벽은\s*1\.6배\s*개선/u);
      expect(description).not.toMatch(/사용\s*전\s*대비/u);
      expect(description).not.toMatch(/\*|인체적용시험\s*완료/u);
    }
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
    const descriptions = nodes
      .filter((node) => node["@type"] === "Product" || node["@type"] === "WebPage")
      .map((node) => String(node.description ?? ""));

    for (const description of descriptions) {
      expect(description).toMatch(/수분이\s*72시간\s*지속/u);
      expect(description).toContain("(주)뉴리서치");
      expect(description).toMatch(/여성\s*28명/u);
      expect(description).toMatch(/사용\s*전\s*대비\s*38%\s*증가/u);
      expect(description).toMatch(/사용\s*전\s*대비\s*27%\s*개선/u);
      expect(description).not.toMatch(/120시간|2배/u);
    }
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
    const descriptions = nodes
      .filter((node) => node["@type"] === "Product" || node["@type"] === "WebPage")
      .map((node) => String(node.description ?? ""));
    const faqText = JSON.stringify(nodes.find((node) => node["@type"] === "FAQPage")?.mainEntity ?? []);

    for (const description of descriptions) {
      expect(description).toMatch(/주요\s*성분[^.!?。！？]*고밀도\s*세라마이드\s*캡슐[^.!?。！？]*니아신아마이드/u);
      expect(description).not.toMatch(/주요\s*성분[^.!?。！？]*\b비타민(?:이며|이고|으로|입니다)/u);
      expect(description).toMatch(/\(주\)범용리서치/u);
      expect(description).toMatch(/2025년\s*4월\s*3일부터\s*2025년\s*5월\s*14일까지/u);
      expect(description).toMatch(/성인\s*29명/u);
      expect(description).toMatch(/사용\s*직후\s*계절성\s*건조로\s*인한\s*들뜬\s*각질은\s*사용\s*전\s*대비\s*41\.7%\s*개선/u);
      expect(description).toMatch(/사용\s*6주\s*후\s*건조로\s*인해\s*거칠어진\s*피부결은\s*사용\s*전\s*대비\s*8\.4%\s*개선/u);
      expect(description).not.toMatch(/인한\.|인해\.|개선\s*\(/u);
    }
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

    for (const description of [String(productNode.description ?? ""), String(webPage.description ?? "")]) {
      const sentences = description.split(/(?<=[.!?。！？])\s+/u);
      const durationSentence = sentences.find((sentence) => /120시간/u.test(sentence));
      const studySentence = sentences.find((sentence) => /인체적용시험/u.test(sentence));
      expect(durationSentence).toMatch(/한\s*번\s*사용\s*후\s*보습이\s*120시간\s*지속됩니다/u);
      expect(studySentence).toMatch(/\(주\)엘리드/u);
      expect(studySentence).toMatch(/2023년\s*2월\s*2일부터\s*2023년\s*3월\s*23일까지/u);
      expect(studySentence).toMatch(/여성\s*32명/u);
      expect(studySentence).toMatch(/사용\s*직후\s*보습량은\s*사용\s*전\s*대비\s*2배\s*증가/u);
      expect(studySentence).toMatch(/단\s*10분\s*만에\s*손상\s*장벽은\s*사용\s*전\s*대비\s*2배\s*개선/u);
      expect(description).toMatch(/주요\s*성분(?:은|인)\s*고밀도\s*세라마이드\s*캡슐과\s*콜레스테롤/u);
      expect(description).toMatch(/피부\s*장벽\s*케어와\s*속보습을\s*돕고,\s*한\s*번\s*사용\s*후\s*보습이\s*120시간\s*지속됩니다/u);
      expect(description).toMatch(/이러한\s*효능·효과를\s*바탕으로\s*건조하고\s*민감한\s*피부\s*고객에게\s*적합합니다/u);
      expect(description.indexOf("인체적용시험")).toBeLessThan(description.indexOf("이러한 효능·효과"));
      expect(description.indexOf("이러한 효능·효과")).toBeLessThan(description.indexOf("고객 리뷰"));
      expect(description).not.toMatch(/주요\s*성분[^.!?。！？]{0,80}DermaON/iu);
      expect(description.match(/보습량은\s*사용\s*전\s*대비\s*2배\s*증가/gu)?.length ?? 0).toBe(1);
      expect(description.match(/손상\s*장벽은\s*사용\s*전\s*대비\s*2배\s*개선/gu)?.length ?? 0).toBe(1);
      expect(description).not.toMatch(/사용\s*전\s*사용\s*후|120h|※|\*|인체적용시험\s*완료|이\s*제품입니다|\(겉보습|242%|356%/u);
    }

    expect(reportedDetails).toMatch(/120시간|\(주\)엘리드|여성\s*32명|사용\s*전\s*대비/u);
    expect(reportedDetails).not.toMatch(/사용\s*전\s*사용\s*후|120h|※|\*|인체적용시험\s*완료|이\s*제품입니다/u);
    expect((run.result.diagnostics.validationRepairs ?? []).filter((repair) => /description/u.test(repair.field))).toHaveLength(0);
  });

  it("renders one shared clinical evidence group once across every public summary field", async () => {
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
    const publicSummaries = [
      String(productNode.description ?? ""),
      String(webPage.description ?? ""),
      String(properties.find((item) => item.name === "Reported details")?.value ?? ""),
      String(properties.find((item) => item.name === "Clinical result summary")?.value ?? "")
    ];

    for (const value of publicSummaries) {
      expect(value.match(/\(주\)엘리드/gu)?.length ?? 0).toBe(1);
      expect(value.match(/사용\s*직후\s*보습량은\s*사용\s*전\s*대비\s*2배\s*증가/gu)?.length ?? 0).toBe(1);
      expect(value.match(/단\s*10분\s*만에\s*손상\s*장벽은\s*사용\s*전\s*대비\s*2배\s*개선/gu)?.length ?? 0).toBe(1);
      expect(value.match(/한\s*번\s*사용\s*후\s*보습이\s*120시간\s*지속/gu)?.length ?? 0).toBe(1);
      const sentences = value.split(/(?<=[.!?。！？])\s+/u).map((sentence) => sentence.trim()).filter(Boolean);
      expect(new Set(sentences).size).toBe(sentences.length);
    }
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
    const descriptions = graph
      .filter((node): node is Record<string, JsonValue> => typeof node === "object" && node !== null && !Array.isArray(node))
      .filter((node) => node["@type"] === "Product" || node["@type"] === "WebPage")
      .map((node) => String(node.description ?? ""));

    for (const description of descriptions) {
      const studySentence = description.split(/(?<=[.!?。！？])\s+/u).find((sentence) => /인체적용시험/u.test(sentence));
      expect(description).toMatch(/한\s*번\s*사용\s*후\s*수분이\s*96시간\s*지속됩니다/u);
      expect(studySentence).toMatch(/\(주\)뉴리서치/u);
      expect(studySentence).toMatch(/2025년\s*4월\s*1일부터\s*2025년\s*5월\s*15일까지/u);
      expect(studySentence).toMatch(/성인\s*28명/u);
      expect(studySentence).toMatch(/사용\s*30분\s*후\s*피부\s*수분량은\s*사용\s*전\s*대비\s*38%\s*증가/u);
      expect(studySentence).toMatch(/사용\s*14일\s*후\s*장벽\s*지표는\s*사용\s*전\s*대비\s*27%\s*개선/u);
      expect(description).not.toMatch(/고객\s*리뷰/u);
      expect(description).not.toMatch(/사용\s*전\s*사용\s*후|96h|※|\*|인체적용시험\s*완료|본\s*제품입니다|\(겉보습|118%|164%|120시간|2배|32명/u);
    }
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

    for (const description of [productDescription, webPageDescription]) {
      expect(description).toMatch(/하이드라 배리어 크림/u);
      expect(description).toMatch(/건조하고 민감한 피부/u);
      expect(description).toMatch(/세라마이드/u);
      expect(description).toMatch(/피부 장벽|보습/u);
      expect(description).toMatch(/고객 리뷰/u);
      expect(description.indexOf("하이드라 배리어 크림")).toBeLessThan(description.indexOf("건조하고 민감한 피부"));
      expect(description.indexOf("건조하고 민감한 피부")).toBeLessThan(description.indexOf("세라마이드"));
      expect(description.indexOf("세라마이드")).toBeLessThan(description.indexOf("고객 리뷰"));
      expect(description).not.toMatch(/민감 피부 사용 맥락은|선택 기준을 보완|원료적 특성에 한한|해당 결과는|표기되어 있다|190%|ex vivo/iu);
    }

    expect(productDescription).not.toMatch(/상품\s*페이지/u);
    expect(webPageDescription).toMatch(/상품\s*페이지/u);
    expect(reportedDetails).toMatch(/190%/u);
    expect(reportedDetails).toMatch(/ex vivo/iu);
    expect(reportedDetails).not.toMatch(/표기되어 있다|제시된다|설명된다/u);
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
    const effectFaq = faqItems.find((item) => /손상된\s*피부\s*장벽이\s*고민/u.test(String(item.name)))!;
    const infantFaq = faqItems.find((item) => /영유아/u.test(String(item.name)))!;
    expect(effectFaq, JSON.stringify(faqItems, null, 2)).toBeDefined();
    const effectAnswer = String((effectFaq.acceptedAnswer as Record<string, JsonValue>).text);
    const infantAnswer = String((infantFaq.acceptedAnswer as Record<string, JsonValue>).text);
    const properties = (productNode.additionalProperty as JsonValue[])
      .filter((item): item is Record<string, JsonValue> => typeof item === "object" && item !== null && !Array.isArray(item));
    const skinType = String(properties.find((item) => item.name === "Recommended skin type")?.value ?? "");
    const usage = String(properties.find((item) => item.name === "Usage")?.value ?? "");

    expect(effectAnswer).toMatch(/아토베리어365 크림/u);
    expect(effectAnswer).toMatch(/외부\s*자극|유해\s*환경/u);
    expect(effectAnswer).toMatch(/진정과\s*보습/u);
    expect(effectAnswer).toMatch(/따라서\s*진정과\s*보습을\s*원하는\s*고객/u);
    expect(infantAnswer).toMatch(/아토베리어365 크림/u);
    expect(infantAnswer).toMatch(/0세부터\s*성인까지/u);
    expect(infantAnswer).toMatch(/국소부위|국소\s*부위/u);
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
    expect(String(productNode.description)).toContain("The formula includes Niacinamide");
    expect(String(productNode.description)).toContain("The product's documented benefit is hydration");
    expect(String(productNode.description)).toContain("reviews report that it feels light and absorbs quickly");
    expect(String(productNode.description)).not.toContain("for customers");
    expect(String(webPageNode.description)).toMatch(/^This Clear Serum product page introduces the serum\./u);
    expect(String(webPageNode.description)).not.toMatch(/for customers|introduces[^.!?]*through/iu);
    expect(String(productNode.description).match(/Clear\s+Serum/gu)?.length ?? 0).toBe(1);
    expect(String(webPageNode.description).match(/Clear\s+Serum/gu)?.length ?? 0).toBe(2);
    expect(unlinked.result.content.sections.ingredients).toBe("- Niacinamide");
    expect(unlinkedDescriptions).not.toMatch(/dry\s+skin|skin[-\s]?barrier|aging|wrinkle/iu);

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
        ? /(?:어떤 고객|피부 고민[^?]*적합|고민인 고객[^?]*효과)/u.test(question)
        : /(?:which customers[^?]*suitable|who[^?]*best suited|skin concerns[^?]*address)/iu.test(question));

      expect(suitabilityQuestions).toHaveLength(1);
      expect(questions.some((question) => testCase.locale === "ko-KR"
        ? /주요 성분과 효능/u.test(question)
        : /key ingredients and benefits/iu.test(question))).toBe(true);
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
    expect(queries).toHaveLength(1);
    expect(queries[0]?.source).toBe("model-inferred-cep");
    expect(queries[0]?.question).toMatch(/피부가 건조할 때 촉촉한 사용감이 필요한 경우 어떤 세럼이 적합한가요\?/u);
    expect(queries[0]?.answer).toMatch(/피부가 건조할 때 촉촉한 사용감을 고려한 세럼/u);
    expect(`${queries[0]?.question} ${queries[0]?.answer}`).not.toMatch(/촉촉한 사용감 같은 사용감|주름/u);
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
    const audienceQuery = audienceRun.result.diagnostics.inferredSearchQueries?.[0];
    expect(audienceQuery?.question).toMatch(/^건조 피부 고객에게 피부 장벽 보습이 필요한 경우/u);
    expect(audienceQuery?.answer).toMatch(/건조 피부 고객에게 필요한 피부 장벽 보습을 다루는 세럼/u);
  });

  it("does not restore review-derived properties or queries when an empty model plan is accepted", async () => {
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
    expect(run.result.diagnostics.contentPlan?.faq).toEqual([]);
    expect(run.result.diagnostics.inferredSearchQueries).toEqual([]);
    expect(faqPage).toBeUndefined();
    expect(run.result.content.sections.faq).toBe("");
    expect(run.result.content.html).not.toMatch(/(?:FAQ|자주\s*묻는\s*질문)/iu);
    expect(faqRepairs).toHaveLength(0);
    expect(properties.some((item) => item.name === "Review-derived recommendation context")).toBe(false);
    expect(properties.some((item) => item.propertyID === "indirectCustomerQuestion" || item.propertyID === "directProductQuestion")).toBe(false);
  });

  it("keeps exact model-approved FAQ membership without replenishing excluded source questions", async () => {
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

    expect(run.result.diagnostics.contentPlan?.faq.map((item) => item.question)).toEqual([approvedQuestion]);
    expect(renderedFaq).toEqual([{ question: approvedQuestion, answer: approvedAnswer }]);
    expect(run.result.content.sections.faq).toBe(`Q. ${approvedQuestion}\nA. ${approvedAnswer}`);
    expect(run.result.content.html).toContain(approvedQuestion);
    expect(run.result.content.html).not.toContain(excludedQuestion);
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

    expect(String(product.description)).toMatch(/배리어 로션은 건조하고 민감한 피부 고객을 위한 로션/u);
    expect(String(product.description)).not.toMatch(/로션은\s+배리어\s+라인은/u);
    expect(faqText).not.toMatch(/따가운\s*상태.*써도|신생아가\s*사용/u);
    expect(faqText).not.toMatch(/제형이라[^.]*수분감입니다,|효능.*효능.*뒷받침|케어와\s*연결됩니다|사용\s*루틴\s*답변/u);
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

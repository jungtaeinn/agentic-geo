import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPdpGeoEvidenceLedger,
  generatePdpGeo,
  planPdpGeoContent,
  type PdpGeoContentPlan,
  type PdpGeoContentPlanningRequest,
  type PdpGeoLocale,
  type PdpProductSignal
} from "../src/index";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adversarial evidence-bound content planning", () => {
  it("does not treat a repeated cross-language corrective pass as semantic proof", async () => {
    const source = product({ description: "A hydrating serum for dry skin." });
    const request = planningRequest(source, "ko-KR");
    const description = request.evidenceLedger.find((item) => item.role === "description")!;
    const unsupportedPlan = planPayload("ko-KR", {
      productDescription: plannedField({
        text: "지성 피부용 산뜻한 세럼입니다.",
        evidenceIds: [description.id]
      })
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(unsupportedPlan) }] }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await planPdpGeoContent(request, {
      contentPlanning: {
        enabled: true,
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-test"
      }
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(result.plan.productDescription.include).toBe(false);
    expect(result.plan.productDescription.text).toBe("");
  });

  it("rejects a claim that removes source negation", async () => {
    const source = product({ description: "This serum does not improve hydration." });
    const request = planningRequest(source, "en-US");
    const description = request.evidenceLedger.find((item) => item.role === "description")!;

    const result = await planPdpGeoContent(request, {
      customContentPlanner: {
        planContent: () => ({
          plan: planPayload("en-US", {
            productDescription: plannedField({
              text: "This serum improves hydration.",
              evidenceIds: [description.id]
            })
          })
        })
      }
    });

    expect(result.plan.productDescription.include).toBe(false);
  });

  it("rejects numeric claims that swap values between source durations", async () => {
    const source = product({
      description: undefined,
      metrics: ["Hydration improved 10% after 2 weeks and 20% after 4 weeks."]
    });
    const request = planningRequest(source, "en-US");
    const metric = request.evidenceLedger.find((item) => item.role === "metric")!;

    const result = await planPdpGeoContent(request, {
      customContentPlanner: {
        planContent: () => ({
          plan: planPayload("en-US", {
            productDescription: plannedField({
              text: "Hydration improved 20% after 2 weeks and 10% after 4 weeks.",
              evidenceIds: [metric.id]
            })
          })
        })
      }
    });

    expect(result.plan.productDescription.include).toBe(false);
  });

  it("rejects an unsupported FAQ question even when its answer is evidence-backed", async () => {
    const source = product({ description: "A hydrating serum for dry skin." });
    const request = planningRequest(source, "en-US");
    const description = request.evidenceLedger.find((item) => item.role === "description")!;

    const result = await planPdpGeoContent(request, {
      customContentPlanner: {
        planContent: () => ({
          plan: planPayload("en-US", {
            faq: [{
              include: true,
              question: "Does this serum cure cancer?",
              answer: "A hydrating serum for dry skin.",
              intent: "medical-treatment",
              cep: "cancer treatment",
              evidenceIds: [description.id],
              confidence: 0.9,
              omitReason: ""
            }]
          })
        })
      }
    });

    expect(result.plan.faq).toEqual([]);
  });

  it("keeps a natural generic FAQ question when its answer is directly supported", async () => {
    const source = product({ description: "This serum provides hydration for dry skin." });
    const request = planningRequest(source, "en-US");
    const description = request.evidenceLedger.find((item) => item.role === "description")!;

    const result = await planPdpGeoContent(request, {
      customContentPlanner: {
        planContent: () => ({
          plan: planPayload("en-US", {
            faq: [{
              include: true,
              question: "What is the main benefit?",
              answer: "This serum provides hydration for dry skin.",
              intent: "benefit",
              cep: "dry skin hydration",
              evidenceIds: [description.id],
              confidence: 0.9,
              omitReason: ""
            }]
          })
        })
      }
    });

    expect(result.plan.faq).toHaveLength(1);
  });

  it("retains audited Korean product FAQs despite natural inflection and separated numeric question context", async () => {
    const source = product({
      name: "아토베리어365 크림",
      description: "아토베리어365 크림은 건조하고 민감한 피부 고객을 위한 장벽 보습 크림입니다.",
      category: "크림",
      benefits: ["피부 장벽 보습"],
      ingredients: ["고밀도 세라마이드 캡슐"],
      usage: ["아침과 저녁 세안 후 적당량을 피부에 골고루 펴 바릅니다."],
      metrics: ["인체적용시험에서 사용 직후 보습량은 사용 전 대비 2배 증가했습니다."],
      semanticFacts: {
        ingredients: ["고밀도 세라마이드 캡슐"],
        benefits: ["피부 장벽 보습"],
        effects: [],
        skinTypes: ["건조 피부", "민감 피부"],
        usageSteps: ["아침과 저녁 세안 후 적당량을 피부에 골고루 펴 바릅니다."],
        metricClaims: [],
        evidenceSentences: [],
        ingredientBenefitLinks: [],
        safetyTests: ["민감 피부 자극 테스트 완료", "피부과 테스트 완료"]
      }
    });
    const request = planningRequest(source, "ko-KR");
    const ids = (...roles: string[]) => request.evidenceLedger
      .filter((item) => roles.includes(item.role))
      .map((item) => item.id);
    const candidate = planPayload("ko-KR", {
      faq: [
        {
          include: true,
          question: "아토베리어365 크림은 건조하고 민감한 피부 고객에게 적합한가요?",
          answer: "아토베리어365 크림은 건조하고 민감한 피부 고객이 장벽 보습을 고려할 때 적합한 크림입니다.",
          intent: "target-customer-suitability",
          cep: "건조하고 민감한 피부의 장벽 보습",
          evidenceIds: ids("identity", "description", "audience", "benefit"),
          confidence: 0.95,
          omitReason: ""
        },
        {
          include: true,
          question: "아토베리어365 크림의 보습 개선 근거는 무엇인가요?",
          answer: "인체적용시험에서 사용 직후 보습량은 사용 전보다 2배 증가했습니다.",
          intent: "official-measurement",
          cep: "공식 보습 측정 결과 확인",
          evidenceIds: ids("identity", "metric"),
          confidence: 0.95,
          omitReason: ""
        },
        {
          include: true,
          question: "아토베리어365 크림은 언제, 어떻게 바르나요?",
          answer: "아침과 저녁 세안 후 적당량을 피부에 골고루 펴 바릅니다.",
          intent: "usage-order",
          cep: "아침과 저녁 세안 후 사용",
          evidenceIds: ids("usage"),
          confidence: 0.95,
          omitReason: ""
        },
        {
          include: true,
          question: "아토베리어365 크림에는 어떤 피부 안전성 테스트 완료 표기가 있나요?",
          answer: "민감 피부 자극 테스트와 피부과 테스트 완료가 표기되어 있습니다.",
          intent: "completed-safety-tests",
          cep: "민감 피부 테스트 완료 항목 확인",
          evidenceIds: ids("identity", "source"),
          confidence: 0.95,
          omitReason: ""
        }
      ]
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(candidate) }] }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await planPdpGeoContent(request, {
      contentPlanning: {
        enabled: true,
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-test"
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.plan.faq.map((item) => item.intent)).toEqual([
      "target-customer-suitability",
      "official-measurement",
      "usage-order",
      "completed-safety-tests"
    ]);
    expect(result.warnings.join("\n")).not.toMatch(/numeric-relationship|question-entailment|answer-entailment/u);
  });

  it("retains audited rich-product FAQ answers when cited metric atoms contain extra sample and study numbers", async () => {
    const source = product({
      name: "아토베리어365 크림",
      description: "아토베리어365 크림은 건조하고 민감한 피부 고객을 위한 장벽 보습 크림입니다.",
      category: "크림",
      benefits: ["피부 장벽 관리", "수분 케어"],
      ingredients: ["고밀도 세라마이드 캡슐", "롱체인 세라마이드", "링커 세라마이드"],
      usage: ["아침과 저녁 세안 후 토너와 세럼 다음 단계에 피부에 골고루 펴 바릅니다."],
      metrics: [
        "㈜엘리드가 여성 32명을 대상으로 2023.02.02-2023.03.23 진행한 완제품 인체적용시험에서 사용 직후 보습량은 사용 전 대비 2배 증가했습니다.",
        "완제품 인체적용시험에서 한 번 도포 후 보습 효과가 120시간 지속되는 것으로 확인되었습니다."
      ],
      faq: [{
        question: "크림을 바르는데 알갱이가 느껴져요. 써도 되나요?",
        answer: "크림에 함유된 캡슐은 바를 때 부드럽게 녹으며, 지속 사용에 불편감이 있으면 고객서비스센터로 연락하도록 안내합니다."
      }],
      semanticFacts: {
        ingredients: ["고밀도 세라마이드 캡슐", "롱체인 세라마이드", "링커 세라마이드"],
        benefits: ["피부 장벽 관리", "수분 케어"],
        effects: [],
        skinTypes: ["건조 피부", "민감 피부"],
        usageSteps: ["아침과 저녁 세안 후 토너와 세럼 다음 단계에 피부에 골고루 펴 바릅니다."],
        metricClaims: [],
        evidenceSentences: [],
        ingredientBenefitLinks: [],
        safetyTests: ["민감 피부 자극 테스트 완료", "피부과 테스트 완료"]
      }
    });
    const request = planningRequest(source, "ko-KR");
    const ids = (...roles: string[]) => request.evidenceLedger
      .filter((item) => roles.includes(item.role))
      .map((item) => item.id);
    const candidate = planPayload("ko-KR", {
      faq: [
        {
          include: true,
          question: "건조하고 민감한 피부 고객에게 아토베리어365 크림은 적합한가요?",
          answer: "아토베리어365 크림은 건조하고 민감한 피부 고객이 피부 장벽 관리와 수분 케어를 고려할 때 선택할 수 있는 크림입니다.",
          intent: "target-customer-suitability",
          cep: "건조하고 민감한 피부의 장벽 보습",
          evidenceIds: ids("identity", "description", "audience", "benefit"),
          confidence: 0.95,
          omitReason: ""
        },
        {
          include: true,
          question: "아토베리어365 크림의 보습량 증가 수치는 어떤 시험에서 나온 결과인가요?",
          answer: "아토베리어365 크림은 여성 32명을 대상으로 진행한 완제품 인체적용시험에서 사용 직후 보습량이 사용 전 대비 2배 증가했습니다.",
          intent: "official-measurement",
          cep: "완제품 보습 시험 결과 확인",
          evidenceIds: ids("identity", "metric"),
          confidence: 0.95,
          omitReason: ""
        },
        {
          include: true,
          question: "아토베리어365 크림의 주요 성분과 기술은 무엇인가요?",
          answer: "아토베리어365 크림에는 고밀도 세라마이드 캡슐, 롱체인 세라마이드, 링커 세라마이드가 포함되어 있습니다.",
          intent: "ingredient-technology",
          cep: "세라마이드 캡슐 구성 확인",
          evidenceIds: ids("identity", "ingredient"),
          confidence: 0.95,
          omitReason: ""
        },
        {
          include: true,
          question: "아토베리어365 크림은 아침과 저녁 루틴에서 언제 바르나요?",
          answer: "아침과 저녁 세안 후 토너와 세럼 다음 단계에 피부에 골고루 펴 바릅니다.",
          intent: "usage-order",
          cep: "아침과 저녁 사용 순서",
          evidenceIds: ids("identity", "usage"),
          confidence: 0.95,
          omitReason: ""
        },
        {
          include: true,
          question: "아토베리어365 크림을 바를 때 알갱이가 느껴져도 사용할 수 있나요?",
          answer: "크림에 함유된 캡슐은 바를 때 부드럽게 녹으며, 지속 사용에 불편감이 있으면 고객서비스센터로 연락하도록 안내합니다.",
          intent: "capsule-use-feel",
          cep: "캡슐 사용감 확인",
          evidenceIds: ids("identity", "faq"),
          confidence: 0.95,
          omitReason: ""
        },
        {
          include: true,
          question: "아토베리어365 크림은 어떤 피부 안전성 테스트를 완료했나요?",
          answer: "민감 피부 자극 테스트와 피부과 테스트 완료가 표기되어 있습니다.",
          intent: "completed-safety-tests",
          cep: "민감 피부 테스트 완료 항목 확인",
          evidenceIds: ids("identity", "source"),
          confidence: 0.95,
          omitReason: ""
        }
      ]
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(candidate) }] }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await planPdpGeoContent(request, {
      contentPlanning: {
        enabled: true,
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-test"
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.plan.faq.map((item) => item.intent)).toEqual([
      "target-customer-suitability",
      "official-measurement",
      "ingredient-technology",
      "usage-order",
      "capsule-use-feel",
      "completed-safety-tests"
    ]);
    expect(result.warnings.join("\n")).not.toMatch(/numeric-relationship|answer-entailment/u);
  });

  it("does not infer order from unmarked semantic action-stage facts", async () => {
    const source = product({
      semanticFacts: {
        ingredients: [],
        benefits: [],
        effects: [],
        skinTypes: [],
        usageSteps: [
          "Dispense one pump into the hand.",
          "Apply the serum to the face.",
          "Massage gently until absorbed."
        ],
        metricClaims: [],
        evidenceSentences: [],
        ingredientBenefitLinks: []
      }
    });

    const result = await planPdpGeoContent(planningRequest(source, "en-US"), {});

    expect(result.plan.howTo.eligible).toBe(false);
    expect(result.plan.howTo.steps).toEqual([]);
  });

  it("does not let semantic step labels add order to unmarked source usage notes", async () => {
    const source = product({
      sourceTexts: [
        "Dispense one pump into the hand.",
        "Apply the serum evenly to the face."
      ],
      semanticFacts: {
        ingredients: [],
        benefits: [],
        effects: [],
        skinTypes: [],
        usageSteps: [
          "Step 1: Dispense one pump into the hand.",
          "Step 2: Apply the serum evenly to the face."
        ],
        metricClaims: [],
        evidenceSentences: [],
        ingredientBenefitLinks: []
      }
    });

    const result = await planPdpGeoContent(planningRequest(source, "en-US"), {});

    expect(result.plan.howTo.eligible).toBe(false);
    expect(result.plan.howTo.steps).toEqual([]);
  });

  it("keeps one direct product usage instruction out of HowTo even when unrelated source text contains a sequence", async () => {
    const source = product({
      usage: ["Apply one pump evenly to the face."],
      sourceTexts: [
        "Step 1: Remove the outer carton.",
        "Step 2: Recycle the empty carton."
      ]
    });

    const result = await planPdpGeoContent(planningRequest(source, "en-US"), {});

    expect(result.plan.howTo.eligible).toBe(false);
    expect(result.plan.howTo.steps).toEqual([]);
  });

  it("does not publish a raw wrong-locale description when the plan omits it", async () => {
    const rawDescription = "A hydrating serum for dry skin.";
    const source = product({ description: rawDescription });

    const run = await generatePdpGeo({
      product: source,
      hints: { locale: "ko-KR" }
    }, {
      customContentPlanner: {
        planContent: () => ({ plan: planPayload("ko-KR") })
      }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, unknown>>;
    const productNode = graph.find((node) => node["@type"] === "Product");

    expect(productNode?.description).not.toBe(rawDescription);
    expect(run.result.content.sections.description).not.toBe(rawDescription);
  });

  it("does not accept Chinese copy as ja-JP solely because it uses Han characters", async () => {
    const source = product({
      name: "测试精华",
      description: "本产品适合干燥皮肤并提供水分。"
    });
    const request = planningRequest(source, "ja-JP");
    const description = request.evidenceLedger.find((item) => item.role === "description")!;

    const result = await planPdpGeoContent(request, {
      customContentPlanner: {
        planContent: () => ({
          plan: planPayload("ja-JP", {
            productDescription: plannedField({
              text: "本产品适合干燥皮肤并提供水分。",
              evidenceIds: [description.id]
            })
          })
        })
      }
    });

    expect(result.plan.productDescription.include).toBe(false);
  });

  it("does not infer an ingredient-benefit causal link from sentence co-occurrence", async () => {
    const source = product({
      description: "Contains ceramide. The formula improves hydration.",
      benefits: ["Improves hydration"],
      ingredients: ["Ceramide"]
    });
    const request = planningRequest(source, "en-US");
    const description = request.evidenceLedger.find((item) => item.role === "description")!;

    const result = await planPdpGeoContent(request, {
      customContentPlanner: {
        planContent: () => ({
          plan: planPayload("en-US", {
            productDescription: plannedField({
              text: "Ceramide improves hydration.",
              evidenceIds: [description.id]
            })
          })
        })
      }
    });

    expect(result.plan.productDescription.include).toBe(false);
  });

  it.each([
    ["ko-KR", "찬 바람에 건조한 피부", "수분 공급"],
    ["ko-KR", "추위로 건조한 피부", "수분 공급"],
    ["en-US", "dry skin during the cold months", "hydration"]
  ] as const)("rejects an unsupported weather context expressed as %s copy: %s", async (locale, situation, need) => {
    const source = locale === "ko-KR"
      ? product({
          name: "하이드라 세럼",
          description: "건조한 피부에 수분을 공급하는 세럼입니다.",
          benefits: ["수분 공급"]
        })
      : product({ description: "A hydrating serum for dry skin.", benefits: ["hydration"] });
    const request = planningRequest(source, locale);
    const description = request.evidenceLedger.find((item) => item.role === "description")!;
    const benefit = request.evidenceLedger.find((item) => item.role === "benefit")!;
    const unsupportedPlan = planPayload(locale, {
      cep: [{
        situation,
        need,
        constraint: "",
        evidenceIds: [description.id, benefit.id],
        confidence: 0.9
      }]
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(unsupportedPlan) }] }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await planPdpGeoContent(request, {
      contentPlanning: {
        enabled: true,
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-test"
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.plan.cep).toEqual([]);
    expect(result.warnings.join("\n")).toContain("QUERY_HYPOTHESIS_ONLY");
  });

  it.each([
    ["en-US", "Ceramide delivers hydration."],
    ["en-US", "Hydration is based on Ceramide."],
    ["en-US", "A serum with Ceramide for hydration."],
    ["ko-KR", "세라마이드로 보습"]
  ] as const)("rejects an ingredient-benefit relationship assembled from separate facts: %s", async (locale, constraint) => {
    const source = locale === "ko-KR"
      ? product({
          name: "테스트 크림",
          description: "건조한 피부를 위한 크림입니다.",
          category: "크림",
          benefits: ["보습"],
          ingredients: ["세라마이드"]
        })
      : product({
          description: "A serum for dry skin.",
          benefits: ["hydration"],
          ingredients: ["Ceramide"]
        });
    const request = planningRequest(source, locale);
    const description = request.evidenceLedger.find((item) => item.role === "description")!;
    const benefit = request.evidenceLedger.find((item) => item.role === "benefit")!;
    const ingredient = request.evidenceLedger.find((item) => item.role === "ingredient")!;
    const unsupportedPlan = planPayload(locale, {
      cep: [{
        situation: locale === "ko-KR" ? "건조한 피부" : "dry skin",
        need: locale === "ko-KR" ? "보습" : "hydration",
        constraint,
        evidenceIds: [description.id, benefit.id, ingredient.id],
        confidence: 0.9
      }]
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(unsupportedPlan) }] }]
    }), { status: 200 })));

    const result = await planPdpGeoContent(request, {
      contentPlanning: {
        enabled: true,
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-test"
      }
    });

    expect(result.plan.cep).toEqual([]);
  });

  it("retains an ingredient-benefit CEP when one cited clause states the relationship", async () => {
    const source = product({
      description: "Ceramide delivers hydration for dry skin.",
      benefits: ["hydration"],
      ingredients: ["Ceramide"]
    });
    const request = planningRequest(source, "en-US");
    const description = request.evidenceLedger.find((item) => item.role === "description")!;
    const benefit = request.evidenceLedger.find((item) => item.role === "benefit")!;
    const ingredient = request.evidenceLedger.find((item) => item.role === "ingredient")!;

    const result = await planPdpGeoContent(request, {
      customContentPlanner: {
        planContent: () => ({
          plan: planPayload("en-US", {
            cep: [{
              situation: "dry skin",
              need: "hydration",
              constraint: "Ceramide delivers hydration",
              evidenceIds: [description.id, benefit.id, ingredient.id],
              confidence: 0.9
            }]
          })
        })
      }
    });

    expect(result.plan.cep).toHaveLength(1);
    expect(result.plan.cep[0]?.constraint).toBe("Ceramide delivers hydration");
  });
});

function product(overrides: Partial<PdpProductSignal> = {}): PdpProductSignal {
  return {
    name: "Test Serum",
    description: "A hydrating serum for dry skin.",
    images: [],
    options: [],
    benefits: [],
    effects: [],
    ingredients: [],
    usage: [],
    metrics: [],
    faq: [],
    reviews: { items: [], keywords: [] },
    breadcrumbs: [],
    sourceTexts: [],
    ...overrides
  };
}

function planningRequest(value: PdpProductSignal, locale: PdpGeoLocale): PdpGeoContentPlanningRequest {
  return {
    product: value,
    locale,
    evidenceLedger: createPdpGeoEvidenceLedger(value, locale),
    ragChunks: []
  };
}

function planPayload(
  locale: PdpGeoLocale,
  overrides: Partial<Omit<PdpGeoContentPlan, "mode">> = {}
): Omit<PdpGeoContentPlan, "mode"> {
  return {
    locale,
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

function plannedField(input: { text: string; evidenceIds: string[] }) {
  return {
    include: true,
    text: input.text,
    intent: "product-entity-summary",
    evidenceIds: input.evidenceIds,
    confidence: 0.9,
    omitReason: ""
  };
}

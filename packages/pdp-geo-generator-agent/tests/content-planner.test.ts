import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPdpGeoEvidenceLedger,
  generatePdpGeo,
  ModelBackedContentPlanner,
  ModelBackedCopyRefiner,
  ModelBackedProductNormalizer,
  normalizePdpProductWithAgent,
  planPdpGeoContent,
  refinePdpGeoCopy,
  type PdpGeoContentPlan,
  type PdpGeoContentPlanningRequest,
  type PdpGeoContentPlanningResult,
  type PdpGeoCopyRefinementRequest,
  type PdpGeoLocale,
  type PdpProductSignal
} from "../src/index";
import { selectProductNormalizationRagDocuments } from "../src/product-normalizer";

const product: PdpProductSignal = {
  name: "하이드라 세럼",
  description: "건조한 피부에 수분을 공급하는 세럼입니다.",
  brand: "테스트랩",
  category: "세럼",
  images: [],
  options: [],
  benefits: ["수분 공급"],
  effects: [],
  ingredients: ["세라마이드"],
  usage: ["세안 후 토너를 사용합니다.", "세럼을 얼굴에 고르게 바릅니다."],
  metrics: [],
  faq: [],
  reviews: { items: [], keywords: [] },
  breadcrumbs: [],
  sourceTexts: []
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("evidence-bound content planning", () => {
  it("reserves GEO, E-E-A-T, and CEP documents in a three-document normalization budget", () => {
    const selected = selectProductNormalizationRagDocuments([
      { name: "irrelevant-one.md", content: "generic content" },
      { name: "best-practice_v1.md", content: "best practice" },
      { name: "eeat_v1.md", content: "trust" },
      { name: "irrelevant-two.md", content: "generic content" },
      { name: "cep_v1.md", content: "customer entry points" },
      { name: "geo-research_v1.md", content: "GEO research" }
    ], 3);

    expect(selected.map((document) => document.name)).toEqual([
      "geo-research_v1.md",
      "eeat_v1.md",
      "cep_v1.md"
    ]);
  });

  it("builds stable atomic evidence with role and source provenance", () => {
    const first = createPdpGeoEvidenceLedger(product, "ko-KR");
    const second = createPdpGeoEvidenceLedger(product, "ko-KR");

    expect(second).toEqual(first);
    expect(first.find((item) => item.sourcePath === "product.name")).toMatchObject({ role: "identity", confidence: 1 });
    expect(first.filter((item) => item.role === "usage")).toHaveLength(2);
    expect(new Set(first.map((item) => item.id)).size).toBe(first.length);
  });

  it("classifies source text by semantic job instead of surface words such as use or absorption", () => {
    const ingredientRelation = "압축 히알루론산은 흡수 빠른 수분 충전과 수분 지속을 돕는 성분입니다.";
    const finishedProductResult = "완제품 인체적용시험에서 1회 사용 직후 수분량이 55% 개선되었습니다.";
    const direction = "세안 후 세럼을 얼굴에 고르게 바릅니다.";
    const review = "직접 구매해 사용해 보니 촉촉하고 편안해서 만족해요.";
    const ledger = createPdpGeoEvidenceLedger({
      ...product,
      usage: [],
      sourceTexts: [ingredientRelation, finishedProductResult, direction, review]
    }, "ko-KR");

    expect(ledger.find((item) => item.text === ingredientRelation)?.role).toBe("ingredient");
    expect(ledger.find((item) => item.text === ingredientRelation)?.role).not.toBe("usage");
    expect(ledger.find((item) => item.text === finishedProductResult)?.role).toBe("metric");
    expect(ledger.find((item) => item.text === direction)?.role).toBe("usage");
    expect(ledger.find((item) => item.text === review)?.role).toBe("review");
  });

  it("keeps non-actionable unordered notes out of HowTo in conservative mode", async () => {
    const unordered = {
      ...product,
      usage: ["매일 사용할 수 있습니다.", "외용으로만 사용하세요."]
    };
    const request = planningRequest(unordered);
    const result = await planPdpGeoContent(request, {});

    expect(result.called).toBe(false);
    expect(result.plan.mode).toBe("conservative");
    expect(result.plan.howTo.eligible).toBe(false);
    expect(result.plan.howTo.steps).toEqual([]);
  });

  it("does not promote a customer-review usage anecdote into HowTo", async () => {
    const reviewUsage = "저는 매일 밤 두 펌프를 얼굴에 바르고 흡수시켜요.";
    const reviewedProduct = {
      ...product,
      usage: [],
      sourceTexts: [reviewUsage],
      reviews: { items: [{ body: reviewUsage }], keywords: [] }
    };
    const ledger = createPdpGeoEvidenceLedger(reviewedProduct, "ko-KR");
    const result = await planPdpGeoContent(planningRequest(reviewedProduct), {});

    expect(ledger.find((item) => item.text === reviewUsage)?.role).not.toBe("usage");
    expect(result.plan.howTo.eligible).toBe(false);
    expect(result.plan.howTo.steps).toEqual([]);
  });

  it("keeps one polite Korean application direction as one HowTo step", async () => {
    const direction = "세럼을 얼굴에 고르게 바릅니다.";
    const result = await planPdpGeoContent(planningRequest({
      ...product,
      usage: [direction]
    }), {});

    expect(result.plan.howTo.eligible).toBe(true);
    expect(result.plan.howTo.steps).toHaveLength(1);
    expect(result.plan.howTo.steps[0]?.text).toBe(direction);
  });

  it("keeps one polite Korean application direction visible with one-step HowTo schema", async () => {
    const direction = "세럼을 얼굴에 고르게 바릅니다.";
    const run = await generatePdpGeo({
      product: {
        ...product,
        usage: [direction]
      },
      hints: { locale: "ko-KR" }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;

    expect(howTo.step).toHaveLength(1);
    expect(howTo.step[0].text).toBe(direction.replace(/\.$/, ""));
    expect(run.result.content.sections.howToUse).toBe(`1. ${direction.replace(/\.$/, "")}`);
  });

  it("does not treat two unrelated actions as an ordered procedure", async () => {
    const result = await planPdpGeoContent(planningRequest({
      ...product,
      usage: ["Apply to the face.", "Massage the neck."]
    }), {});

    expect(result.plan.howTo.eligible).toBe(false);
    expect(result.plan.howTo.steps).toEqual([]);
  });

  it("does not infer a multi-step procedure from unmarked action-stage progression", async () => {
    const result = await planPdpGeoContent(planningRequest({
      ...product,
      usage: [
        "Dispense one pump into the hand.",
        "Apply the serum to the face.",
        "Massage gently until absorbed."
      ]
    }, "en-US"), {});

    expect(result.plan.howTo.eligible).toBe(false);
    expect(result.plan.howTo.steps).toEqual([]);
  });

  it("preserves an explicitly sequential First-Then source procedure", async () => {
    const usage = [
      "First, dispense one pump into the hand.",
      "Then, apply the serum evenly to the face.",
      "Finally, press gently until absorbed."
    ];
    const result = await planPdpGeoContent(planningRequest({
      ...product,
      usage
    }, "en-US"), {});

    expect(result.plan.howTo.eligible).toBe(true);
    expect(result.plan.howTo.steps.map((step) => step.text)).toEqual(usage);
    expect(result.plan.howTo.steps.map((step) => step.position)).toEqual([1, 2, 3]);
  });

  it("honours an explicit contentPlanning disable even when a custom planner is present", async () => {
    let called = false;
    const result = await planPdpGeoContent(planningRequest(product), {
      contentPlanning: { enabled: false },
      customContentPlanner: {
        planContent: () => {
          called = true;
          return { plan: planPayload() };
        }
      }
    });

    expect(called).toBe(false);
    expect(result.plan.mode).toBe("conservative");
  });

  it("lets the model add evidence-backed FAQ and decide schema applicability before rendering", async () => {
    let copyRefinerCalled = false;
    const run = await generatePdpGeo({
      product: {
        ...product,
        usage: ["세럼을 얼굴에 고르게 바릅니다."]
      },
      hints: { locale: "ko-KR" }
    }, {
      customContentPlanner: {
        planContent(request): PdpGeoContentPlanningResult {
          const identity = request.evidenceLedger.find((item) => item.sourcePath === "product.name")!;
          const description = request.evidenceLedger.find((item) => item.role === "description")!;
          const benefit = request.evidenceLedger.find((item) => item.role === "benefit")!;
          const ingredient = request.evidenceLedger.find((item) => item.role === "ingredient")!;
          return {
            plan: planPayload({
              locale: "ko-KR",
              productDescription: {
                include: true,
                text: "하이드라 세럼은 건조한 피부에 수분을 공급하는 세럼입니다.",
                intent: "product-entity-summary",
                evidenceIds: [identity.id, description.id],
                confidence: 0.96,
                omitReason: ""
              },
              webPageDescription: {
                include: true,
                text: "이 페이지에서는 하이드라 세럼의 수분 공급 특징과 성분 정보를 확인할 수 있습니다.",
                intent: "page-coverage-summary",
                evidenceIds: [identity.id, benefit.id, ingredient.id],
                confidence: 0.93,
                omitReason: ""
              },
              faq: [{
                include: true,
                question: "하이드라 세럼은 어떤 피부 고민에 적합한가요?",
                answer: "건조한 피부에 수분을 공급하는 세럼으로 소개됩니다.",
                intent: "suitability",
                cep: "피부가 건조해 수분 공급이 필요할 때",
                evidenceIds: [description.id, benefit.id],
                confidence: 0.92,
                omitReason: ""
              }]
            })
          };
        }
      },
      customCopyRefiner: {
        refineCopy() {
          copyRefinerCalled = true;
          return {};
        }
      }
    });

    const graph = run.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, unknown>>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, unknown>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const productNode = graph.find((node) => node["@type"] === "Product") as Record<string, unknown>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, unknown>;

    // The product plan is usable, but the stiff WebPage wrapper is rejected.
    // A partial plan must receive the model copy-repair pass instead of
    // silently stopping at the deterministic description fallback.
    expect(copyRefinerCalled).toBe(true);
    expect(productNode.description).toContain("건조한 피부에 수분을 공급");
    expect(webPage.description).toContain("하이드라 세럼 상품 페이지");
    expect(webPage.description).toMatch(/세라마이드를 주요 성분·기술로 포함하고 수분 케어를 돕습니다/u);
    const faqItems = faq.mainEntity as Array<Record<string, any>>;
    expect(faqItems.length).toBeGreaterThanOrEqual(2);
    expect(String(faqItems[0]?.name)).toContain("하이드라 세럼은 어떤 피부 고민에 적합한가요");
    expect(String(faqItems[1]?.name)).toMatch(/구성 성분과 효능[·・]?효과/u);
    expect(String(faqItems[1]?.acceptedAnswer?.text)).toMatch(/세라마이드/u);
    expect(String(faqItems[1]?.acceptedAnswer?.text)).toMatch(/수분/u);
    expect(howTo.step).toHaveLength(1);
    expect(run.result.content.sections.howToUse).toContain("세럼을 얼굴에 고르게 바릅니다");
    expect(run.result.diagnostics.contentPlan?.mode).toBe("model");
    expect(run.result.diagnostics.evidenceLedger?.length).toBeGreaterThan(5);
  });

  it("drops an unknown planned FAQ and replaces contaminated HowTo with the source usage plan", async () => {
    const directUsage = ["세럼을 얼굴에 고르게 바릅니다."];
    const request = planningRequest({ ...product, usage: directUsage });
    const result = await planPdpGeoContent(request, {
      customContentPlanner: {
        planContent: () => ({
          plan: planPayload({
            faq: [{
              include: true,
              question: "검증되지 않은 인증이 있나요?",
              answer: "공식 인증을 받은 제품입니다.",
              intent: "certification",
              cep: "인증 제품을 찾을 때",
              evidenceIds: ["ev-unknown"],
              confidence: 0.99,
              omitReason: ""
            }],
            howTo: {
              eligible: true,
              ordered: true,
              goal: "제품 사용",
              evidenceIds: ["ev-unknown"],
              confidence: 0.9,
              omitReason: "",
              steps: [{ position: 1, name: "바르기", text: "제품을 바릅니다.", evidenceIds: ["ev-unknown"] }]
            }
          })
        })
      }
    });

    expect(result.plan.faq).toEqual([]);
    expect(result.plan.howTo.eligible).toBe(true);
    expect(result.plan.howTo.steps).toHaveLength(1);
    expect(result.plan.howTo.steps[0]?.text).toBe(directUsage[0]);
    expect(result.warnings.join(" ")).toMatch(/omitted/i);
    expect(result.warnings.join(" ")).toMatch(/failed checks:.*known-evidence-ids/iu);
    expect(result.warnings.join(" ")).toContain("검증되지 않은 인증이 있나요?");
    expect(result.warnings.join(" ")).toMatch(/retained evidence IDs: none/iu);
  });

  it("replaces a polluted planned HowTo with the normalized source usage plan", async () => {
    const rejectedStep = "세라마이드는 포뮬러의 핵심 성분입니다.";
    const acceptedStep = "세럼을 얼굴에 고르게 바릅니다.";
    const run = await generatePdpGeo({
      product: { ...product, usage: [acceptedStep] },
      hints: { locale: "ko-KR" }
    }, {
      customContentPlanner: {
        planContent(request) {
          const usageEvidence = request.evidenceLedger.filter((item) => item.role === "usage");
          return {
            plan: planPayload({
              howTo: {
                eligible: true,
                ordered: true,
                goal: "하이드라 세럼 사용법",
                evidenceIds: usageEvidence.map((item) => item.id),
                confidence: 0.9,
                omitReason: "",
                steps: [
                  { position: 1, name: "성분 설명", text: rejectedStep, evidenceIds: [usageEvidence[0]!.id] },
                  { position: 2, name: "바르기", text: acceptedStep, evidenceIds: [usageEvidence[0]!.id] }
                ]
              }
            })
          };
        }
      }
    });

    const graph = run.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo");

    expect(howTo).toBeDefined();
    expect(howTo?.step).toHaveLength(1);
    expect(run.result.content.sections.howToUse).not.toContain(rejectedStep);
    expect(run.result.content.sections.howToUse).toContain(acceptedStep.replace(/\.$/, ""));
    expect(run.result.content.html).not.toContain(rejectedStep);
    expect(run.result.diagnostics.contentPlan?.howTo.eligible).toBe(true);
  });

  it("retries a rejected field with explicit evidence-gate feedback", async () => {
    const request = planningRequest(product);
    const benefit = request.evidenceLedger.find((item) => item.role === "benefit")!;
    const description = request.evidenceLedger.find((item) => item.role === "description")!;
    let calls = 0;
    const result = await planPdpGeoContent(request, {
      customContentPlanner: {
        planContent(planningRequest) {
          calls += 1;
          const corrected = Boolean(planningRequest.planningFeedback?.length);
          return {
            plan: planPayload({
              faq: [{
                include: true,
                question: "이 세럼의 핵심 장점은 무엇인가요?",
                answer: "건조한 피부를 위한 수분 공급이 핵심 장점입니다.",
                intent: "benefit",
                cep: "건조함 때문에 수분 공급 제품을 찾을 때",
                evidenceIds: corrected ? [benefit.id, description.id] : ["ev-unknown"],
                confidence: 0.94,
                omitReason: ""
              }]
            })
          };
        }
      }
    });

    expect(calls).toBe(2);
    expect(result.plan.faq).toHaveLength(1);
    expect(result.plan.faq[0]?.evidenceIds).toEqual([benefit.id, description.id]);
  });

  it("rejects an added benefit that is not entailed by the cited evidence", async () => {
    const request = planningRequest(product);
    const description = request.evidenceLedger.find((item) => item.role === "description")!;
    const result = await planPdpGeoContent(request, {
      customContentPlanner: {
        planContent: () => ({
          plan: planPayload({
            productDescription: {
              include: true,
              text: "하이드라 세럼은 건조한 피부를 밝게 하고 수분을 공급하는 세럼입니다.",
              intent: "product-entity-summary",
              evidenceIds: [description.id],
              confidence: 0.95,
              omitReason: ""
            }
          })
        })
      }
    });

    expect(result.plan.productDescription.include).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/evidence gate/i);
  });

  it("rejects numeric claims when the cited duration unit changes", async () => {
    const metricProduct = {
      ...product,
      description: "2주 사용 후 수분 개선을 평가한 세럼입니다.",
      metrics: ["2주 사용 후 수분 개선"]
    };
    const request = planningRequest(metricProduct);
    const metric = request.evidenceLedger.find((item) => item.role === "metric")!;
    const result = await planPdpGeoContent(request, {
      customContentPlanner: {
        planContent: () => ({
          plan: planPayload({
            productDescription: {
              include: true,
              text: "2시간 사용 후 수분 개선을 평가한 세럼입니다.",
              intent: "product-entity-summary",
              evidenceIds: [metric.id],
              confidence: 0.9,
              omitReason: ""
            }
          })
        })
      }
    });

    expect(result.plan.productDescription.include).toBe(false);
  });

  it("accepts cross-language copy only after the model-backed entailment audit", async () => {
    const englishProduct = {
      ...product,
      name: "Hydra Serum",
      description: "A hydrating serum for dry skin.",
      benefits: ["hydration"],
      ingredients: [],
      usage: []
    };
    const request = planningRequest(englishProduct);
    const description = request.evidenceLedger.find((item) => item.role === "description")!;
    const payload = planPayload({
      productDescription: {
        include: true,
        text: "건조한 피부에 수분을 공급하는 세럼입니다.",
        intent: "product-entity-summary",
        evidenceIds: [description.id],
        confidence: 0.93,
        omitReason: ""
      }
    });
    const requestBodies: Array<Record<string, any>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
        usage: { input_tokens: 10, output_tokens: 5 }
      }), { status: 200 });
    }));

    const result = await planPdpGeoContent(request, {
      contentPlanning: { enabled: true, provider: "openai", apiKey: "key", model: "gpt-test" }
    });

    expect(requestBodies).toHaveLength(2);
    expect(JSON.parse(String(requestBodies[1]?.input ?? "{}"))).toHaveProperty("candidatePlan");
    expect(result.plan.productDescription.include).toBe(true);
    expect(result.plan.productDescription.text).toContain("수분을 공급");
  });

  it("rejects a cross-language medical claim even after the model audit", async () => {
    const englishProduct = {
      ...product,
      name: "Hydra Serum",
      description: "A hydrating serum for dry skin.",
      benefits: ["hydration"],
      ingredients: [],
      usage: []
    };
    const request = planningRequest(englishProduct);
    const description = request.evidenceLedger.find((item) => item.role === "description")!;
    const payload = planPayload({
      productDescription: {
        include: true,
        text: "암을 치료하는 보습 세럼입니다.",
        intent: "product-entity-summary",
        evidenceIds: [description.id],
        confidence: 0.99,
        omitReason: ""
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }]
    }), { status: 200 })));

    const result = await planPdpGeoContent(request, {
      contentPlanning: { enabled: true, provider: "openai", apiKey: "key", model: "gpt-test" }
    });

    expect(result.plan.productDescription.include).toBe(false);
  });

  it("keeps unsupported seasonal associations as query hypotheses after the model audit", async () => {
    const request = planningRequest(product);
    const identity = request.evidenceLedger.find((item) => item.role === "identity")!;
    const description = request.evidenceLedger.find((item) => item.role === "description")!;
    const benefit = request.evidenceLedger.find((item) => item.role === "benefit")!;
    const seasonalPlan = planPayload({
      productDescription: {
        include: true,
        text: "하이드라 세럼은 겨울철 건조한 피부에 수분을 공급하는 세럼입니다.",
        intent: "seasonal-suitability",
        evidenceIds: [identity.id, description.id, benefit.id],
        confidence: 0.92,
        omitReason: ""
      },
      faq: [{
        include: true,
        question: "겨울철 건조한 피부에는 어떤 세럼이 적합한가요?",
        answer: "하이드라 세럼은 겨울철 건조한 피부에 수분을 공급하는 세럼입니다.",
        intent: "seasonal-suitability",
        cep: "겨울철 건조함 때문에 수분 공급이 필요할 때",
        evidenceIds: [identity.id, description.id, benefit.id],
        confidence: 0.91,
        omitReason: ""
      }],
      cep: [{
        situation: "겨울철 피부가 건조할 때",
        need: "수분 공급",
        constraint: "",
        evidenceIds: [description.id, benefit.id],
        confidence: 0.9
      }]
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(seasonalPlan) }] }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await planPdpGeoContent(request, {
      contentPlanning: { enabled: true, provider: "openai", apiKey: "key", model: "gpt-test" }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.plan.productDescription.include).toBe(false);
    expect(result.plan.faq).toEqual([]);
    expect(result.plan.cep).toEqual([]);
    expect(result.warnings.join("\n")).toContain("QUERY_HYPOTHESIS_ONLY");
  });

  it("allows a second exact product mention when it preserves entity clarity across the CEP narrative", async () => {
    const request = planningRequest(product);
    const identity = request.evidenceLedger.find((item) => item.role === "identity")!;
    const description = request.evidenceLedger.find((item) => item.role === "description")!;
    const benefit = request.evidenceLedger.find((item) => item.role === "benefit")!;
    const ingredient = request.evidenceLedger.find((item) => item.role === "ingredient")!;
    const repeatedPlan = planPayload({
      productDescription: {
        include: true,
        text: "하이드라 세럼은 건조한 피부에 수분을 공급하는 세럼입니다. 하이드라 세럼은 세라마이드를 포함합니다.",
        intent: "product-entity-summary",
        evidenceIds: [identity.id, description.id, benefit.id, ingredient.id],
        confidence: 0.92,
        omitReason: ""
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(repeatedPlan) }] }]
    }), { status: 200 })));

    const result = await planPdpGeoContent(request, {
      contentPlanning: { enabled: true, provider: "openai", apiKey: "key", model: "gpt-test" }
    });

    expect(result.plan.productDescription.include).toBe(true);
    expect(result.plan.productDescription.text).toContain("하이드라 세럼은 세라마이드를 포함합니다");
    expect(result.warnings.join("\n")).not.toMatch(/repeats the full product entity/i);
  });

  it("accepts an audited multi-sentence CEP description when every claim unit is supported by a different evidence role", async () => {
    const richProduct: PdpProductSignal = {
      ...product,
      description: "민감하고 수분이 부족한 피부를 위한 수분 세럼입니다.",
      benefits: ["수분 공급", "피부 장벽 보습"],
      effects: ["사용 직후와 12시간 후 수분량 개선"],
      ingredients: ["세라마이드"],
      reviews: { items: [{ body: "고객들은 촉촉하고 편안한 사용감으로 만족스럽게 평가했습니다." }], keywords: ["촉촉함", "편안한 사용감"] },
      semanticFacts: {
        ingredients: ["세라마이드"],
        benefits: ["수분 공급", "피부 장벽 보습"],
        effects: ["사용 직후와 12시간 후 수분량 개선"],
        skinTypes: ["민감하고 수분이 부족한 피부"],
        usageSteps: [],
        metricClaims: [
          {
            label: "수분량 개선",
            value: "55",
            unit: "%",
            direction: "개선",
            timing: "사용 직후",
            method: "완제품 인체적용시험",
            evidenceGroup: "hydration-study",
            sourceText: "완제품 인체적용시험에서 사용 직후 수분량이 55% 개선되었습니다."
          },
          {
            label: "수분량 개선",
            value: "23",
            unit: "%",
            direction: "개선",
            timing: "12시간 후",
            method: "완제품 인체적용시험",
            evidenceGroup: "hydration-study",
            sourceText: "같은 완제품 인체적용시험에서 12시간 후 수분량이 23% 개선되었습니다."
          }
        ],
        evidenceSentences: ["민감하고 수분이 부족한 피부를 위한 수분 세럼입니다."],
        ingredientBenefitLinks: [{
          ingredient: "세라마이드",
          benefit: "피부 장벽 보습",
          sourceText: "세라마이드는 피부 장벽 보습을 돕습니다."
        }]
      }
    };
    const request = planningRequest(richProduct);
    const evidenceIds = request.evidenceLedger.map((item) => item.id);
    const plannedText = "하이드라 세럼은 민감하고 수분이 부족한 피부를 위한 수분 세럼입니다. 하이드라 세럼의 주요 성분은 세라마이드이며, 세라마이드는 피부 장벽 보습을 돕습니다. 완제품 인체적용시험에서는 수분량이 사용 직후 55%, 12시간 후 23% 개선되었습니다. 고객들은 촉촉하고 편안한 사용감으로 평가했습니다.";
    const naturalPlan = planPayload({
      productDescription: {
        include: true,
        text: plannedText,
        intent: "audience-composition-proof-review",
        evidenceIds,
        confidence: 0.94,
        omitReason: ""
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(naturalPlan) }] }]
    }), { status: 200 })));

    const result = await planPdpGeoContent(request, {
      contentPlanning: { enabled: true, provider: "openai", apiKey: "key", model: "gpt-test" }
    });

    expect(result.plan.productDescription.include).toBe(true);
    expect(result.plan.productDescription.text).toBe(plannedText);
    expect(result.warnings.join("\n")).not.toMatch(/Product\.description was omitted/i);
  });

  it("recovers an omitted field-level citation when a WebPage routine sentence matches existing usage evidence", async () => {
    const routineProduct: PdpProductSignal = {
      ...product,
      usage: ["아침과 저녁 세안 후 세럼을 얼굴에 고르게 바릅니다."],
      semanticFacts: {
        ingredients: ["세라마이드"],
        benefits: ["수분 공급"],
        effects: [],
        skinTypes: ["건조한 피부"],
        usageSteps: ["아침과 저녁 세안 후 세럼을 얼굴에 고르게 바릅니다."],
        metricClaims: [],
        evidenceSentences: [],
        ingredientBenefitLinks: []
      }
    };
    const request = planningRequest(routineProduct);
    const identity = request.evidenceLedger.find((item) => item.role === "identity")!;
    const description = request.evidenceLedger.find((item) => item.role === "description")!;
    const pageText = "하이드라 세럼 상품 페이지는 건조한 피부를 위한 수분 세럼 정보를 담고 있습니다. 하이드라 세럼은 아침과 저녁 세안 후 사용하는 것을 권장합니다.";
    const pagePlan = planPayload({
      webPageDescription: {
        include: true,
        text: pageText,
        intent: "page-audience-routine-summary",
        // Deliberately omit the usage ID to reproduce the field-level citation
        // loss observed in the real planner response.
        evidenceIds: [identity.id, description.id],
        confidence: 0.92,
        omitReason: ""
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(pagePlan) }] }]
    }), { status: 200 })));

    const result = await planPdpGeoContent(request, {
      contentPlanning: { enabled: true, provider: "openai", apiKey: "key", model: "gpt-test" }
    });

    expect(result.plan.webPageDescription.include).toBe(true);
    expect(result.plan.webPageDescription.text).toBe(pageText);
    expect(result.plan.webPageDescription.evidenceIds.some((id) =>
      request.evidenceLedger.find((item) => item.id === id)?.role === "usage"
    )).toBe(true);
    expect(result.warnings.join("\n")).not.toMatch(/QUERY_HYPOTHESIS_ONLY: WebPage\.description/u);
  });

  it("still rejects a description that mechanically restarts every sentence with the full product entity", async () => {
    const request = planningRequest(product);
    const identity = request.evidenceLedger.find((item) => item.role === "identity")!;
    const description = request.evidenceLedger.find((item) => item.role === "description")!;
    const benefit = request.evidenceLedger.find((item) => item.role === "benefit")!;
    const ingredient = request.evidenceLedger.find((item) => item.role === "ingredient")!;
    const repeatedPlan = planPayload({
      productDescription: {
        include: true,
        text: "하이드라 세럼은 건조한 피부에 수분을 공급하는 세럼입니다. 하이드라 세럼은 세라마이드를 포함합니다. 하이드라 세럼은 수분 공급을 돕습니다.",
        intent: "product-entity-summary",
        evidenceIds: [identity.id, description.id, benefit.id, ingredient.id],
        confidence: 0.92,
        omitReason: ""
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(repeatedPlan) }] }]
    }), { status: 200 })));

    const result = await planPdpGeoContent(request, {
      contentPlanning: { enabled: true, provider: "openai", apiKey: "key", model: "gpt-test" }
    });

    expect(result.plan.productDescription.include).toBe(false);
    expect(result.warnings.join("\n")).toMatch(/repeats the full product entity/i);
  });
});

describe("provider-native structured output", () => {
  it("keeps every available evidence role represented before generic source atoms can exhaust the prompt budget", async () => {
    let body: Record<string, any> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: JSON.stringify(planPayload()) }] }]
      }), { status: 200 });
    }));
    const crowdedProduct: PdpProductSignal = {
      ...product,
      options: ["80 mL"],
      reviews: { items: [{ body: "직접 구매한 고객은 촉촉하고 편안한 사용감에 만족했습니다." }], keywords: ["촉촉함"] },
      semanticFacts: {
        ingredients: ["세라마이드"],
        benefits: ["수분 공급"],
        effects: ["피부 장벽 보습"],
        skinTypes: ["건조한 피부"],
        usageSteps: ["세안 후 세럼을 얼굴에 고르게 바릅니다."],
        metricClaims: [{ label: "수분량 개선", value: "55", unit: "%", timing: "사용 직후", method: "인체적용시험", evidenceGroup: "hydration-study" }],
        evidenceSentences: Array.from({ length: 80 }, (_, index) => `근거 자료 ${index + 1}은 상품 정보를 설명합니다.`),
        ingredientBenefitLinks: [{ ingredient: "세라마이드", benefit: "피부 장벽 보습", sourceText: "세라마이드는 피부 장벽 보습을 돕습니다." }]
      }
    };
    const planner = new ModelBackedContentPlanner({
      provider: "openai",
      apiKey: "key",
      model: "gpt-test",
      maxEvidenceItems: 20,
      maxRagChunks: 1
    });

    await planner.planContent(planningRequest(crowdedProduct));

    const payload = JSON.parse(String(body.input ?? "{}")) as { evidenceLedger: Array<{ role: string }> };
    const roles = new Set(payload.evidenceLedger.map((item) => item.role));
    expect([...roles]).toEqual(expect.arrayContaining([
      "identity", "description", "audience", "ingredient", "benefit", "effect", "metric", "usage", "commerce", "review", "source"
    ]));
  });

  it("protects BestPractice tone guidance alongside GEO, CEP, and E-E-A-T in a small planner context", async () => {
    let body: Record<string, any> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: JSON.stringify(planPayload()) }] }]
      }), { status: 200 });
    }));
    const planner = new ModelBackedContentPlanner({
      provider: "openai",
      apiKey: "key",
      model: "gpt-test",
      maxEvidenceItems: 20,
      maxRagChunks: 3
    });
    const request = planningRequest(product);
    request.ragChunks = [
      { id: "noise", source: "noise.md", kind: "custom", text: "generic", metadata: {}, score: 0.99 },
      { id: "geo", source: "geo-research_v1.md", kind: "geo-research", text: "answer-ready product facts", metadata: {}, score: 0.9 },
      { id: "cep", source: "cep_v1.md", kind: "cep", text: "customer entry context", metadata: {}, score: 0.89 },
      { id: "eeat", source: "eeat_v1.md", kind: "eeat", text: "bounded claim modality", metadata: {}, score: 0.88 },
      { id: "best", source: "brands/aestura/best-practice_v1.md", kind: "best-practice", text: "Use a calm, assured dermocosmetic voice with natural evidence transitions.", metadata: {}, score: 0.87 }
    ];

    await planner.planContent(request);

    const payload = JSON.parse(String(body.input ?? "{}")) as Record<string, any>;
    expect(body.instructions).toContain("active best-practice guidance as the public-copy style benchmark");
    expect(payload.taskGuidance.map((item: Record<string, unknown>) => item.kind)).toEqual(
      expect.arrayContaining(["best-practice", "geo-research", "cep", "eeat"])
    );
    expect(payload.bestPracticeToneGuidance).toHaveLength(1);
    expect(payload.toneApplicationPolicy).toContain("Do not copy examples");
  });

  it.each([
    ["openai", { apiKey: "key", model: "gpt-test" }],
    ["gemini", { apiKey: "key", model: "gemini-test" }],
    ["azure-openai", { apiKey: "key", endpoint: "https://example.openai.azure.com", deployment: "reasoning" }],
    ["aistudio", { apiKey: "key", endpoint: "https://example.ai.studio", deployment: "reasoning" }]
  ] as const)("sends a strict JSON schema to %s", async (provider, config) => {
    let body: Record<string, any> | undefined;
    const payload = JSON.stringify(planPayload());
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      if (provider === "openai") {
        return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: payload }] }], usage: { input_tokens: 12, output_tokens: 7 } }), { status: 200 });
      }
      if (provider === "gemini") {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: payload }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: payload } }], usage: { prompt_tokens: 12, completion_tokens: 7 } }), { status: 200 });
    }));

    const planner = new ModelBackedContentPlanner({
      provider,
      ...config,
      maxEvidenceItems: 30,
      maxRagChunks: 3
    });
    const result = await planner.planContent(planningRequest(product));

    expect(result.plan?.locale).toBe("ko-KR");
    if (provider === "openai") expect(body?.text?.format?.type).toBe("json_schema");
    if (provider === "gemini") {
      expect(body?.generationConfig?.responseMimeType).toBe("application/json");
      expect(body?.generationConfig?.responseSchema?.type).toBe("OBJECT");
    }
    if (provider === "azure-openai" || provider === "aistudio") expect(body?.response_format?.type).toBe("json_schema");
  });

  it("retries OpenAI planning without temperature when the model only accepts its default", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "Unsupported value: temperature only the default is allowed" } }), { status: 400 });
      }
      return new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: JSON.stringify(planPayload()) }] }]
      }), { status: 200 });
    }));
    const planner = new ModelBackedContentPlanner({
      provider: "openai",
      apiKey: "key",
      model: "gpt-test",
      temperature: 0.2,
      maxEvidenceItems: 20,
      maxRagChunks: 2
    });

    const result = await planner.planContent(planningRequest(product));

    expect(result.plan).toBeDefined();
    expect(bodies[0]).toHaveProperty("temperature", 0.2);
    expect(bodies[1]).not.toHaveProperty("temperature");
  });

  it("uses the AI Studio chat-completions contract for product normalization", async () => {
    let url = "";
    let authorization = "";
    let systemPrompt = "";
    let responseFormat: unknown;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input);
      authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role?: string; content?: string }>;
        response_format?: unknown;
      };
      systemPrompt = body.messages?.find((message) => message.role === "system")?.content ?? "";
      responseFormat = body.response_format;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ product: { name: product.name }, locale: "ko-KR", market: "KR", warnings: [] }) } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
      }), { status: 200 });
    }));
    const normalizer = new ModelBackedProductNormalizer({
      provider: "aistudio",
      apiKey: "key",
      endpoint: "https://example.ai.studio",
      deployment: "reasoning"
    });

    const result = await normalizer.normalizeProduct({
      rawProduct: product,
      bootstrapProduct: product,
      locale: "ko-KR",
      market: "KR",
      ragDocuments: []
    });

    expect(url).toBe("https://example.ai.studio/openai/deployments/reasoning/chat/completions");
    expect(authorization).toBe("Bearer key");
    expect(systemPrompt).toContain("source assertions, source-backed synthesis, and query hypotheses");
    expect(systemPrompt).toContain("QUERY_HYPOTHESIS_ONLY");
    expect(systemPrompt).toContain("Do not create a causal or suitability relationship from co-occurrence");
    expect(responseFormat).toMatchObject({
      type: "json_schema",
      json_schema: { name: "pdp_product_normalization_patch", strict: true }
    });
    expect(result.product?.name).toBe(product.name);
    expect(result.usage?.totalTokens).toBe(8);
  });

  it("retries one malformed normalization response with the structured patch contract", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "{\"product\":" } }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          product: { benefits: ["피부 장벽 보습"] },
          locale: "ko-KR",
          market: "KR",
          warnings: []
        }) } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
      }), { status: 200 });
    }));

    const result = await normalizePdpProductWithAgent({
      rawProduct: { ...product, benefits: ["피부 장벽 보습"] },
      bootstrapProduct: product,
      locale: "ko-KR",
      market: "KR",
      ragDocuments: []
    }, {
      provider: "aistudio",
      apiKey: "key",
      endpoint: "https://example.ai.studio",
      deployment: "reasoning",
      productNormalization: { enabled: true, provider: "aistudio" }
    });

    expect(calls).toBe(2);
    expect(result.product.benefits).toEqual(["피부 장벽 보습"]);
    expect(result.warnings).toContain("Product normalization recovered after one corrective structured retry.");
    expect(result.usage?.totalTokens).toBe(14);
    expect(result.evidence.some((item) => /DEGRADED_MODE/u.test(item.value))).toBe(false);
  });

  it("preserves one bootstrap usage boundary when a custom normalizer tries to split it", async () => {
    const sourceUsage = "Apply one pump to the face and gently pat until absorbed.";
    const bootstrapProduct: PdpProductSignal = {
      ...product,
      name: "Hydra Serum",
      description: "A hydrating serum.",
      brand: "Test Lab",
      category: "Serum",
      benefits: ["hydration"],
      ingredients: ["Ceramide"],
      usage: [sourceUsage],
      sourceTexts: [sourceUsage]
    };
    const result = await normalizePdpProductWithAgent({
      rawProduct: bootstrapProduct,
      bootstrapProduct,
      locale: "en-US",
      market: "US",
      ragDocuments: []
    }, {
      customProductNormalizer: {
        normalizeProduct: () => ({
          product: {
            usage: [
              "Apply one pump to the face.",
              "Gently pat until absorbed."
            ]
          },
          warnings: []
        })
      }
    });

    expect(result.product.usage).toEqual([sourceUsage]);
    expect(result.product.usage).toHaveLength(1);
    expect(result.warnings).toContain("Model usage normalization was ignored to preserve source instruction boundaries and order.");
  });
});

describe("model-backed evidence-role routing", () => {
  it("keeps a novel source-backed complex while rejecting ingredient attributes and unsupported co-occurrence links", async () => {
    const explicitRelation = "NovaSyn X7™ supports skin reset comfort.";
    const coOccurrence = "Orbis Q™. Skin reset comfort.";
    const rawProduct = {
      ...product,
      ingredients: ["NovaSyn X7™", "Orbis Q™", "absorption"],
      benefits: ["skin reset comfort"],
      sourceTexts: [explicitRelation, coOccurrence]
    };
    const result = await normalizePdpProductWithAgent({
      rawProduct,
      bootstrapProduct: { ...product, sourceTexts: [explicitRelation, coOccurrence] },
      locale: "en-US",
      market: "US",
      ragDocuments: []
    }, {
      customProductNormalizer: {
        normalizeProduct: () => ({
          product: {
            ingredients: ["NovaSyn X7™", "Orbis Q™", "absorption"],
            benefits: ["skin reset comfort"],
            semanticFacts: {
              ingredients: ["NovaSyn X7™", "Orbis Q™", "absorption"],
              benefits: ["skin reset comfort"],
              effects: [],
              skinTypes: [],
              usageSteps: [],
              metricClaims: [],
              evidenceSentences: [explicitRelation, coOccurrence],
              ingredientBenefitLinks: [
                {
                  ingredient: "NovaSyn X7™",
                  benefit: "skin reset comfort",
                  sentence: explicitRelation,
                  sourceText: explicitRelation
                },
                {
                  ingredient: "Orbis Q™",
                  benefit: "skin reset comfort",
                  sentence: coOccurrence,
                  sourceText: coOccurrence
                }
              ]
            }
          }
        })
      }
    });

    expect(result.product.ingredients).toEqual(expect.arrayContaining(["NovaSyn X7™", "Orbis Q™"]));
    expect(result.product.ingredients).not.toContain("absorption");
    expect(result.product.semanticFacts?.ingredientBenefitLinks).toHaveLength(1);
    expect(result.product.semanticFacts?.ingredientBenefitLinks[0]?.ingredient).toBe("NovaSyn X7™");
  });
});

describe("copy-refinement query-hypothesis boundary", () => {
  it("labels inferred search intents as non-evidentiary in the model prompt", async () => {
    let body: Record<string, any> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ warnings: [] }) }] }]
      }), { status: 200 });
    }));
    const refiner = new ModelBackedCopyRefiner({ provider: "openai", apiKey: "key", model: "gpt-test" });

    await refiner.refineCopy(copyRefinementRequest());

    expect(String(body.instructions)).toContain("generativeQueryIntents");
    expect(String(body.instructions)).toContain("non-evidentiary query hypotheses");
    const payload = JSON.parse(String(body.input ?? "{}"));
    expect(payload.generativeQueryIntents[0]).toMatchObject({
      evidenceStatus: "query-hypothesis-only"
    });
  });

  it("rejects seasonal query hypotheses promoted into descriptions or FAQ", async () => {
    const request = copyRefinementRequest();
    const result = await refinePdpGeoCopy(request, {
      customCopyRefiner: {
        refineCopy: () => ({
          schemaDescriptions: {
            product: "하이드라 세럼은 겨울철 건조한 피부에 수분을 공급하는 데일리 보습 세럼입니다."
          },
          faqAnswers: [{
            sourceQuestion: "하이드라 세럼은 어떤 피부에 적합한가요?",
            question: "겨울철 건조한 피부에는 하이드라 세럼이 적합한가요?",
            answer: "하이드라 세럼은 겨울철 건조한 피부에 수분을 공급하는 보습 세럼입니다."
          }]
        })
      }
    });
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const productNode = graph.find((node) => node["@type"] === "Product")!;
    const faqPage = graph.find((node) => node["@type"] === "FAQPage")!;

    expect(String(productNode.description)).not.toContain("겨울");
    expect(JSON.stringify(faqPage.mainEntity)).not.toContain("겨울");
    expect(result.warnings.join("\n")).toMatch(/query hypothesis/i);
  });
});

function planningRequest(value: PdpProductSignal, locale: PdpGeoLocale = "ko-KR"): PdpGeoContentPlanningRequest {
  return {
    product: value,
    locale,
    evidenceLedger: createPdpGeoEvidenceLedger(value, locale),
    ragChunks: []
  };
}

function copyRefinementRequest(): PdpGeoCopyRefinementRequest {
  const productDescription = "하이드라 세럼은 건조한 피부에 수분을 공급하는 데일리 보습 세럼입니다.";
  const webPageDescription = "하이드라 세럼 상품 페이지에서는 건조한 피부를 위한 수분 공급 특징을 소개합니다.";
  const faqQuestion = "하이드라 세럼은 어떤 피부에 적합한가요?";
  const faqAnswer = "하이드라 세럼은 건조한 피부에 수분을 공급하는 보습 세럼입니다.";
  return {
    product,
    locale: "ko-KR",
    schemaMarkup: {
      jsonLd: {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Product", "@id": "urn:test#product", name: product.name, description: productDescription },
          { "@type": "WebPage", "@id": "urn:test#webpage", name: product.name, description: webPageDescription },
          {
            "@type": "FAQPage",
            "@id": "urn:test#faq",
            mainEntity: [{
              "@type": "Question",
              name: faqQuestion,
              acceptedAnswer: { "@type": "Answer", text: faqAnswer }
            }]
          }
        ]
      },
      scriptTag: ""
    },
    content: {
      html: "",
      sections: {
        productName: product.name,
        description: productDescription,
        quickFacts: "제품 유형: 세럼",
        benefits: "- 수분 공급",
        ingredients: "- 세라마이드",
        howToUse: "",
        faq: `Q. ${faqQuestion}\nA. ${faqAnswer}`
      }
    },
    ragChunks: [],
    inferredSearchQueries: [{
      kind: "indirect",
      question: "겨울철 건조한 피부에는 어떤 세럼이 좋은가요?",
      keywords: ["겨울철", "건조한 피부", "보습 세럼"],
      answer: "건조한 피부를 위한 수분 공급 세럼을 비교합니다.",
      source: "product-fact",
      mentionsProductOrBrand: false
    }]
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
      omitReason: "not requested"
    },
    webPageDescription: {
      include: false,
      text: "",
      intent: "page-coverage-summary",
      evidenceIds: [],
      confidence: 0,
      omitReason: "not requested"
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

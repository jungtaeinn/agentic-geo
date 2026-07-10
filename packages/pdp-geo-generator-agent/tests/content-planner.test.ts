import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPdpGeoEvidenceLedger,
  generatePdpGeo,
  ModelBackedContentPlanner,
  ModelBackedProductNormalizer,
  planPdpGeoContent,
  type PdpGeoContentPlan,
  type PdpGeoContentPlanningRequest,
  type PdpGeoContentPlanningResult,
  type PdpProductSignal
} from "../src/index";

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
  it("builds stable atomic evidence with role and source provenance", () => {
    const first = createPdpGeoEvidenceLedger(product, "ko-KR");
    const second = createPdpGeoEvidenceLedger(product, "ko-KR");

    expect(second).toEqual(first);
    expect(first.find((item) => item.sourcePath === "product.name")).toMatchObject({ role: "identity", confidence: 1 });
    expect(first.filter((item) => item.role === "usage")).toHaveLength(2);
    expect(new Set(first.map((item) => item.id)).size).toBe(first.length);
  });

  it("keeps a single or unordered note out of HowTo in conservative mode", async () => {
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

  it("does not treat two unrelated actions as an ordered procedure", async () => {
    const result = await planPdpGeoContent(planningRequest({
      ...product,
      usage: ["Apply to the face.", "Massage the neck."]
    }), {});

    expect(result.plan.howTo.eligible).toBe(false);
    expect(result.plan.howTo.steps).toEqual([]);
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
      product,
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
    const productNode = graph.find((node) => node["@type"] === "Product") as Record<string, unknown>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, unknown>;

    expect(copyRefinerCalled).toBe(false);
    expect(productNode.description).toContain("건조한 피부에 수분을 공급");
    expect(webPage.description).toContain("이 페이지에서는");
    expect(faq.mainEntity).toHaveLength(1);
    expect(graph.some((node) => node["@type"] === "HowTo")).toBe(false);
    expect(run.result.diagnostics.contentPlan?.mode).toBe("model");
    expect(run.result.diagnostics.evidenceLedger?.length).toBeGreaterThan(5);
  });

  it("fails closed when planned FAQ or HowTo cites unknown evidence", async () => {
    const request = planningRequest(product);
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
    expect(result.plan.howTo.eligible).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/omitted/i);
  });

  it("does not publish a planned HowTo without ordered source provenance", async () => {
    const rejectedStep = "세라마이드는 포뮬러의 핵심 성분입니다.";
    const acceptedStep = "세럼을 얼굴에 고르게 바릅니다.";
    const run = await generatePdpGeo({
      product,
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
                  { position: 2, name: "바르기", text: acceptedStep, evidenceIds: [usageEvidence[1]!.id] }
                ]
              }
            })
          };
        }
      }
    });

    const graph = run.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo");

    expect(howTo).toBeUndefined();
    expect(run.result.content.sections.howToUse).not.toContain(rejectedStep);
    expect(run.result.content.html).not.toContain(rejectedStep);
    expect(run.result.diagnostics.contentPlan?.howTo.eligible).toBe(false);
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
});

describe("provider-native structured output", () => {
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
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input);
      authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
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
    expect(result.product?.name).toBe(product.name);
    expect(result.usage?.totalTokens).toBe(8);
  });
});

function planningRequest(value: PdpProductSignal): PdpGeoContentPlanningRequest {
  return {
    product: value,
    locale: "ko-KR",
    evidenceLedger: createPdpGeoEvidenceLedger(value, "ko-KR"),
    ragChunks: []
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

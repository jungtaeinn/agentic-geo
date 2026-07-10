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

  it("does not infer order from unrelated semantic usage facts", async () => {
    const source = product({
      semanticFacts: {
        ingredients: [],
        benefits: [],
        effects: [],
        skinTypes: [],
        usageSteps: [
          "Apply the serum to the face.",
          "Massage the cleanser onto the hands."
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

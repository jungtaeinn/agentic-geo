import { describe, expect, it } from "vitest";
import {
  buildConceptEmbodimentPrompt,
  judgeConceptEmbodiment,
  parseConceptEmbodimentResponse
} from "../src/quality/concept-judge";
import type { GeoEvalEngineConfig } from "../src/citation/engine";
import type { EvalDiagnosticsInput, GeoQualityEvalInput } from "../src/types";

/**
 * Contract under test: the concept-embodiment judge is a separate, opt-in
 * LLM layer over the deterministic rubric (`evaluate.ts`) — it never scores
 * schema hygiene, only whether the GEO/CEP/E-E-A-T CONCEPTS are embodied in
 * the copy. These tests never call the deterministic rubric.
 */

const config: GeoEvalEngineConfig = { provider: "openai", apiKey: "test-key", model: "gpt-test" };

function makeInput(): GeoQualityEvalInput {
  const diagnostics: EvalDiagnosticsInput = {
    normalizedProduct: {
      name: "Renewal Serum",
      ingredients: ["Ceramide", "Niacinamide"],
      benefits: ["Firming"],
      effects: [],
      usage: ["Apply once in the evening"],
      reviews: { keywords: ["hydrating"] }
    },
    validationWarnings: []
  };

  return {
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebPage",
          "@id": "https://example.com/p#webpage",
          name: "Renewal Serum",
          description: "Renewal Serum product page."
        },
        {
          "@type": "Product",
          "@id": "https://example.com/p#product",
          name: "Renewal Serum",
          description: "Renewal Serum is a firming serum with ceramide capsules for dry skin.",
          additionalProperty: [
            { "@type": "PropertyValue", name: "Skin Type", value: "Dry" }
          ]
        },
        {
          "@type": "FAQPage",
          mainEntity: [
            {
              "@type": "Question",
              name: "How often should I use this?",
              acceptedAnswer: { "@type": "Answer", text: "Use once daily in the evening." }
            }
          ]
        },
        {
          "@type": "HowTo",
          name: "How to use Renewal Serum",
          step: [
            { "@type": "HowToStep", name: "Apply", text: "Apply a pump to clean, dry skin." }
          ]
        }
      ]
    },
    diagnostics
  };
}

describe("buildConceptEmbodimentPrompt", () => {
  it("includes the extracted public sections and the source-signal summary", () => {
    const prompt = buildConceptEmbodimentPrompt(makeInput(), "en");
    expect(prompt.user).toMatch(/ceramide capsules/i);
    expect(prompt.user).toMatch(/How often should I use this\?/);
    expect(prompt.user).toMatch(/Apply a pump/);
    expect(prompt.user).toMatch(/Skin Type/);
    expect(prompt.user).toMatch(/sourceIngredientCount/);
    expect(prompt.user).toMatch(/"hasReviewSignal": true/);
  });

  it("states the fairness rules (no penalty for absent source signals, no inventing content)", () => {
    const prompt = buildConceptEmbodimentPrompt(makeInput(), "en");
    expect(prompt.system).toMatch(/never penalize/i);
    expect(prompt.system).toMatch(/never propose an improvement that would add information/i);
  });

  it("requests Korean output for the ko locale", () => {
    const prompt = buildConceptEmbodimentPrompt(makeInput(), "ko");
    expect(prompt.system).toMatch(/Korean/);
    expect(prompt.system).not.toMatch(/English/);
  });

  it("requests English output for the en locale", () => {
    const prompt = buildConceptEmbodimentPrompt(makeInput(), "en");
    expect(prompt.system).toMatch(/English/);
    expect(prompt.system).not.toMatch(/Korean/);
  });
});

describe("parseConceptEmbodimentResponse", () => {
  const validRaw = JSON.stringify({
    dimensions: {
      geo: {
        score: 80,
        embodied: ["states what the product is"],
        missing: ["no self-contained usage answer"],
        improvements: ["surface the existing how-to step as a standalone sentence"]
      },
      cep: {
        score: 70,
        embodied: [],
        missing: ["no situation-to-need link"],
        improvements: ["connect 'dry skin' to the ceramide ingredient already named"]
      },
      eeat: {
        score: 90,
        embodied: ["explains ceramide's barrier function"],
        missing: [],
        improvements: []
      }
    },
    summary: "Solid GEO coverage; the CEP path is not closed."
  });

  it("parses a valid response and computes the overall score deterministically", () => {
    const assessment = parseConceptEmbodimentResponse(validRaw);
    expect(assessment.dimensions.map((dimension) => dimension.id)).toEqual(["geo", "cep", "eeat"]);
    expect(assessment.dimensions[0]!.score).toBe(80);
    expect(assessment.dimensions[0]!.missing).toEqual(["no self-contained usage answer"]);
    expect(assessment.overallScore).toBe(80); // round((80 + 70 + 90) / 3) = 80
    expect(assessment.summary).toContain("CEP path");
  });

  it("parses fenced JSON the same as raw JSON", () => {
    const fenced = "```json\n" + validRaw + "\n```";
    expect(parseConceptEmbodimentResponse(fenced).overallScore).toBe(80);
  });

  it("throws a clear error when a dimension is missing", () => {
    const raw = JSON.stringify({
      dimensions: { geo: { score: 80, embodied: [], missing: [], improvements: [] } },
      summary: "x"
    });
    expect(() => parseConceptEmbodimentResponse(raw)).toThrow(/"cep"/);
  });

  it("throws a clear error when a score is out of range", () => {
    const raw = JSON.stringify({
      dimensions: {
        geo: { score: 120, embodied: [], missing: [], improvements: [] },
        cep: { score: 50, embodied: [], missing: [], improvements: [] },
        eeat: { score: 50, embodied: [], missing: [], improvements: [] }
      },
      summary: "x"
    });
    expect(() => parseConceptEmbodimentResponse(raw)).toThrow(/out-of-range/);
  });

  it("throws a clear error when a list field is not an array", () => {
    const raw = JSON.stringify({
      dimensions: {
        geo: { score: 50, embodied: "not an array", missing: [], improvements: [] },
        cep: { score: 50, embodied: [], missing: [], improvements: [] },
        eeat: { score: 50, embodied: [], missing: [], improvements: [] }
      },
      summary: "x"
    });
    expect(() => parseConceptEmbodimentResponse(raw)).toThrow(/non-array/);
  });

  it("throws a clear error when the response has no summary", () => {
    const raw = JSON.stringify({
      dimensions: {
        geo: { score: 50, embodied: [], missing: [], improvements: [] },
        cep: { score: 50, embodied: [], missing: [], improvements: [] },
        eeat: { score: 50, embodied: [], missing: [], improvements: [] }
      }
    });
    expect(() => parseConceptEmbodimentResponse(raw)).toThrow(/summary/);
  });
});

describe("judgeConceptEmbodiment", () => {
  it("passes the built prompt to the injected complete function and returns the parsed assessment", async () => {
    let capturedSystem = "";
    let capturedUser = "";
    const complete = async (_config: GeoEvalEngineConfig, system: string, user: string) => {
      capturedSystem = system;
      capturedUser = user;
      return JSON.stringify({
        dimensions: {
          geo: { score: 100, embodied: [], missing: [], improvements: [] },
          cep: { score: 100, embodied: [], missing: [], improvements: [] },
          eeat: { score: 100, embodied: [], missing: [], improvements: [] }
        },
        summary: "ok"
      });
    };

    const assessment = await judgeConceptEmbodiment(makeInput(), config, "en", complete);
    expect(assessment.overallScore).toBe(100);
    expect(capturedUser).toMatch(/ceramide capsules/i);
    expect(capturedSystem).toMatch(/English/);
  });

  it("propagates a clear parse error when the model returns malformed JSON", async () => {
    const complete = async () => "not json";
    await expect(judgeConceptEmbodiment(makeInput(), config, "en", complete)).rejects.toThrow(/no JSON object/i);
  });
});

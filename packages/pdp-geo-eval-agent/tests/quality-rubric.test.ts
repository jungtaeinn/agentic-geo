import { describe, expect, it } from "vitest";
import { getGeoQualityCopy } from "../src/quality/copy";
import { evaluateGeoQuality } from "../src/quality/evaluate";
import type { EvalDiagnosticsInput, GeoQualityEvalInput } from "../src/types";

/**
 * Behavioral contract for the research-recalibrated quality rubric:
 *
 * - Validation warnings/repairs penalize GEO (schema hygiene) only — no more
 *   triple counting across CEP/E-E-A-T.
 * - All three dimensions can reach 100 (scale symmetry).
 * - GEO rewards the two deterministically checkable citation gatekeepers
 *   confirmed by What Gets Cited (SIGIR 2026): explicit price + freshness.
 * - CEP cue regexes are cross-checked against the content plan so a single
 *   missed detection cannot swing the score.
 * - Claim-distortion lints catch the defects observed in a live run:
 *   "100%%", "supports supports", "decreased by 100%".
 */

const PAGE_ID = "https://example.com/p#webpage";
const PRODUCT_ID = "https://example.com/p#product";

function makeJsonLd(overrides?: {
  withPrice?: boolean;
  withFreshness?: boolean;
  productDescription?: string;
}) {
  const withPrice = overrides?.withPrice ?? true;
  const withFreshness = overrides?.withFreshness ?? true;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": PAGE_ID,
        name: "Renewal Serum",
        description: "Product page for Renewal Serum with formula and usage details.",
        ...(withFreshness ? { dateModified: "2026-08-01" } : {})
      },
      {
        "@type": "Product",
        "@id": PRODUCT_ID,
        name: "Renewal Serum",
        description: overrides?.productDescription
          ?? "Renewal Serum is a firming serum formulated with ceramide capsules that help support elasticity for dry skin types choosing barrier care. In an instrumental result, 100% of 32 women showed improvement after 6 weeks of daily use.",
        ...(withPrice ? { offers: { "@type": "Offer", price: 42, priceCurrency: "USD" } } : {})
      }
    ]
  };
}

function makeDiagnostics(overrides?: Partial<EvalDiagnosticsInput>): EvalDiagnosticsInput {
  return {
    normalizedProduct: {
      name: "Renewal Serum",
      images: [],
      breadcrumbs: [],
      ingredients: ["Ceramide"],
      benefits: ["Firming"],
      effects: []
    },
    validationWarnings: [],
    validationRepairs: [],
    evidence: [
      { field: "product.name", source: "input", value: "Renewal Serum" },
      { field: "content.description", source: "rag", value: "grounded" }
    ],
    ragUsage: [
      { principle: "evidence-backed claims", enabled: true, references: [{ kind: "eeat", fieldTargets: ["Product.description"] }] },
      { principle: "target customer context", enabled: true, references: [{ kind: "cep", fieldTargets: ["Product.additionalProperty"] }] }
    ],
    evidenceLedger: [
      { id: "ev-1", role: "benefit", text: "Firming" },
      { id: "ev-2", role: "ingredient", text: "Ceramide" }
    ],
    contentPlan: {
      mode: "model",
      productDescription: { include: true, evidenceIds: ["ev-1", "ev-2"] },
      webPageDescription: { include: false, evidenceIds: [] },
      faq: [],
      howTo: { eligible: false, steps: [] },
      cep: [{ situation: "dry skin", need: "barrier care", evidenceIds: ["ev-2"] }]
    },
    ...overrides
  };
}

function makeInput(overrides?: {
  jsonLd?: unknown;
  diagnostics?: Partial<EvalDiagnosticsInput>;
}): GeoQualityEvalInput {
  return {
    jsonLd: overrides?.jsonLd ?? makeJsonLd(),
    diagnostics: makeDiagnostics(overrides?.diagnostics)
  };
}

describe("validation single-attribution", () => {
  it("penalizes GEO only for validation warnings and repairs", () => {
    const clean = evaluateGeoQuality(makeInput(), "ko");
    const warned = evaluateGeoQuality(makeInput({
      diagnostics: {
        validationWarnings: ["Product.additionalProperty.Usage: duplicated step text.", "FAQ wording upgraded a result."],
        validationRepairs: [{ field: "Product.name", issue: "trimmed" }]
      }
    }), "ko");

    const dim = (evaluation: typeof clean, id: string) =>
      evaluation.dimensions.find((d) => d.id === id)?.score ?? -1;

    expect(dim(warned, "geo")).toBeLessThan(dim(clean, "geo"));
    expect(dim(warned, "cep")).toBe(dim(clean, "cep"));
    expect(dim(warned, "eeat")).toBe(dim(clean, "eeat"));
  });
});

describe("scale symmetry", () => {
  it("lets GEO reach 100 with a clean graph plus price and freshness gatekeepers", () => {
    const evaluation = evaluateGeoQuality(makeInput(), "en");
    expect(evaluation.dimensions.find((d) => d.id === "geo")?.score).toBe(100);
  });

  it("drops GEO gatekeeper bonuses when price and freshness are absent", () => {
    const evaluation = evaluateGeoQuality(makeInput({
      jsonLd: makeJsonLd({ withPrice: false, withFreshness: false })
    }), "en");
    expect(evaluation.dimensions.find((d) => d.id === "geo")?.score).toBe(90);
    const geo = evaluation.dimensions.find((d) => d.id === "geo");
    expect(geo?.improvements.join("\n")).toMatch(/dateModified|date/i);
  });

  it("lets E-E-A-T reach 100 with grounded coverage and scoped metrics", () => {
    const evaluation = evaluateGeoQuality(makeInput(), "en");
    expect(evaluation.dimensions.find((d) => d.id === "eeat")?.score).toBe(100);
  });
});

describe("CEP cue cross-check", () => {
  it("does not crater the score when regex cues miss but the plan has grounded CEPs", () => {
    const neutralDescription = "Renewal Serum is a daily formula. It absorbs quickly.";
    const withPlan = evaluateGeoQuality(makeInput({
      jsonLd: makeJsonLd({ productDescription: neutralDescription })
    }), "en");
    const withoutPlan = evaluateGeoQuality(makeInput({
      jsonLd: makeJsonLd({ productDescription: neutralDescription }),
      diagnostics: { contentPlan: undefined }
    }), "en");

    const cepWith = withPlan.dimensions.find((d) => d.id === "cep")?.score ?? -1;
    const cepWithout = withoutPlan.dimensions.find((d) => d.id === "cep")?.score ?? -1;
    expect(cepWith).toBeGreaterThan(cepWithout);
    expect(cepWith - cepWithout).toBeGreaterThanOrEqual(20);
  });
});

describe("gatekeeper issue accounting", () => {
  it("counts missing price and freshness in the GEO issue count shown in the summary", () => {
    const evaluation = evaluateGeoQuality(makeInput({
      jsonLd: makeJsonLd({ withPrice: false, withFreshness: false })
    }), "en");
    const geo = evaluation.dimensions.find((d) => d.id === "geo");
    // Both gatekeeper improvements are listed, so the summary must count them
    // as issues instead of claiming "no observable diagnostic issue".
    expect(geo?.summary).toBe(getGeoQualityCopy("en").scoreSummary(90, 2));
  });
});

describe("validation repair/warning pairing", () => {
  it("keeps unmatched warnings scored and reported when repairs are unrelated", () => {
    const evaluation = evaluateGeoQuality(makeInput({
      diagnostics: {
        validationWarnings: ["FAQ acceptedAnswer upgraded a claim beyond the source."],
        validationRepairs: [
          { field: "Product.name", issue: "trimmed" },
          { field: "Product.image", issue: "deduplicated" }
        ]
      }
    }), "en");
    expect(evaluation.validationDetails.join("\n")).toMatch(/acceptedAnswer/);
    expect(evaluation.validationImprovements.length).toBeGreaterThan(0);
  });

  it("treats a warning naming the repaired field as resolved", () => {
    const evaluation = evaluateGeoQuality(makeInput({
      diagnostics: {
        validationWarnings: ["Product.name had trailing whitespace and was trimmed."],
        validationRepairs: [{ field: "Product.name", issue: "trimmed" }]
      }
    }), "en");
    expect(evaluation.validationImprovements).toEqual([]);
  });
});

describe("Korean sample/time-scope disclosure", () => {
  it("does not penalize sample-size or time-scope when both are stated in natural Korean", () => {
    const evaluation = evaluateGeoQuality(makeInput({
      jsonLd: makeJsonLd({
        productDescription: "일반 성인 32명을 대상으로 2022년 12월 19일부터 22일까지 48시간 패치로 자극 여부를 확인한 피부과 테스트와, 53명을 대상으로 2018년 4월 13일부터 6월 1일까지 진행한 하이포알러제닉 테스트를 완료했습니다. 사용 후 피부 자극감이 94% 개선되었습니다."
      })
    }), "ko");
    const eeat = evaluation.dimensions.find((d) => d.id === "eeat");
    const improvements = eeat?.improvements.join("\n") ?? "";

    expect(improvements).not.toMatch(/대상으로.*확인했는지/);
    expect(improvements).not.toMatch(/사용 기간/);
    expect(eeat?.score).toBe(100);
  });

  it("recognizes '120명이 참여' and '53명 대상' sample phrasing", () => {
    const evaluation = evaluateGeoQuality(makeInput({
      jsonLd: makeJsonLd({
        productDescription: "120명이 참여한 사용성 조사와 53명 대상 하이포알러제닉 테스트에서 6주 후 92% 개선을 확인했습니다."
      })
    }), "ko");
    const eeat = evaluation.dimensions.find((d) => d.id === "eeat");
    expect(eeat?.improvements.join("\n")).not.toMatch(/대상으로.*확인했는지/);
    expect(eeat?.score).toBe(100);
  });

  it("still penalizes a percentage claim with no sample or time scope at all", () => {
    const evaluation = evaluateGeoQuality(makeInput({
      jsonLd: makeJsonLd({
        productDescription: "Renewal Serum improved skin hydration by 45% overall, according to internal testing."
      })
    }), "en");
    const eeat = evaluation.dimensions.find((d) => d.id === "eeat");
    const improvements = eeat?.improvements.join("\n") ?? "";

    expect(improvements).toMatch(/how many people they were tested on/i);
    expect(improvements).toMatch(/usage period/i);
    expect(eeat?.score ?? 100).toBeLessThanOrEqual(78);
  });
});

describe("HowTo single-step validity", () => {
  it("does not penalize GEO for a valid single-step HowTo (generator contract: 1 instruction = 1 step)", () => {
    const jsonLd = makeJsonLd();
    (jsonLd["@graph"] as Record<string, unknown>[]).push({
      "@type": "HowTo",
      "@id": `${PRODUCT_ID}-howto`,
      name: "How to use Renewal Serum",
      step: [
        { "@type": "HowToStep", name: "Apply", text: "Apply a pump to clean, dry skin each evening." }
      ]
    });
    const evaluation = evaluateGeoQuality(makeInput({
      jsonLd,
      diagnostics: {
        contentPlan: {
          ...makeDiagnostics().contentPlan!,
          howTo: { eligible: true, steps: [{ evidenceIds: [] }] }
        }
      }
    }), "en");
    const geo = evaluation.dimensions.find((d) => d.id === "geo");

    expect(geo?.improvements.join("\n")).not.toMatch(/how-?to/i);
    expect(geo?.score).toBe(100);
  });
});

describe("claim-distortion lints", () => {
  it("flags %%, stuttered verbs, and implausible change magnitudes", () => {
    const evaluation = evaluateGeoQuality(makeInput({
      jsonLd: makeJsonLd({
        productDescription: "Ginseng Peptide supports supports elasticity. Fine lines and wrinkles decreased by 100% after 4 weeks. 100%% of women agreed."
      })
    }), "en");
    const eeat = evaluation.dimensions.find((d) => d.id === "eeat");
    const improvements = eeat?.improvements.join("\n") ?? "";

    expect(improvements).toMatch(/duplicated unit|100%%/i);
    expect(improvements).toMatch(/repeats the same word|supports supports/i);
    expect(improvements).toMatch(/overstatement|participants/i);
    expect(eeat?.score ?? 100).toBeLessThan(80);
  });
});

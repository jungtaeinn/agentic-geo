import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";
import { generatePdpGeoArtifacts } from "../src/generate";
import { normalizePdpProduct } from "../src/normalize";
import { validateAndRepairPdpGeoArtifacts, validatePdpGeoArtifacts } from "../src/validate";
import { graphOf } from "./support/graph";

// 실행 진단(2026-08-13, 예시럭셔리 US CGR Serum)에서 품질 게이트를 하드 실패시킨
// trust-field-validator 경고 4종을 생성/수리 단계에서 예방하는 계약.
// 경고 1건만 남아도 게이트가 실패하므로(unresolvedWarningCount > 0),
// 검증기가 지적할 문구는 애초에 생성되지 않아야 한다.

describe("method-faithful claim labeling (trust warning prevention)", () => {
  // 실행 진단의 normalizedProduct와 동일 구조: instrumental 결과와
  // "Self-assessment from clinical" 방법론이 공존하는 상품.
  const normalized = normalizePdpProduct({
    name: "Ginseng Firming Serum",
    description: "A lightweight firming serum.",
    category: "Serum",
    benefits: ["firmness", "fine lines and wrinkles"],
    ingredients: ["Ginseng Peptide"],
    usage: ["Use morning and night after applying toner. Warm three pumps between fingers and apply to your face and neck."],
    metrics: [
      "After 6 weeks of daily use, 100% of users showed improvement in firmness. Instrumental result in 32 women.",
      "After 6 weeks of daily use, 100% agreed skin feels firmer and more elastic. Self-assessment from a clinical study in 32 women."
    ]
  }, { hints: { locale: "en-US" } }).product;

  const artifacts = generatePdpGeoArtifacts({
    product: {
      ...normalized,
      semanticFacts: {
        ingredients: ["Ginseng Peptide"],
        benefits: ["firmness"],
        effects: [],
        skinTypes: [],
        usageSteps: [],
        safetyTests: [],
        metricClaims: [
          {
            subject: "Firmness",
            value: "100",
            unit: "%",
            metric: "Users who showed improvement",
            direction: "improved",
            timing: "after 6 weeks",
            period: "6 weeks of daily use",
            sample: "32 women",
            method: "Instrumental result",
            evidenceGroup: "6-week instrumental result",
            sentence: "After 6 weeks of daily use, 100% of users showed improvement in firmness.",
            sourceText: "After 6 weeks of daily use, 100% of users showed improvement in firmness, based on an instrumental result in 32 women."
          },
          {
            subject: "Skin firmness and elasticity",
            value: "100",
            unit: "%",
            metric: "Participants who agreed skin feels firmer and more elastic",
            direction: "agreed",
            timing: "after 6 weeks",
            period: "6 weeks of daily use",
            sample: "32 women",
            method: "Self-assessment from clinical",
            evidenceGroup: "6-week clinical self-assessment",
            sentence: "After 6 weeks of use, 100% agreed skin feels firmer and more elastic.",
            sourceText: "100% AGREED SKIN FEELS FIRMER AND MORE ELASTIC. Self-assessment from clinical, 32 women, with daily use."
          }
        ],
        evidenceSentences: [],
        ingredientBenefitLinks: [],
        citations: []
      }
    },
    locale: "en-US",
    market: "US",
    ragChunks: [],
    ragDocuments: []
  });

  it("does not upgrade an instrumental/self-assessment FAQ to 'clinical study results' wording", () => {
    const faq = graphOf(artifacts).find((node) => node["@type"] === "FAQPage");
    const questions = ((faq?.mainEntity ?? []) as Array<Record<string, any>>).map((item) => String(item.name));

    expect(questions.join(" ")).not.toMatch(/clinical\s+stud(?:y|ies)/i);
  });

  it("labels a self-assessment-only summary as 'Reported assessment summary'", () => {
    const product = graphOf(artifacts).find((node) => node["@type"] === "Product") as Record<string, any>;
    const properties = product.additionalProperty as Array<Record<string, any>>;
    const summary = properties.find((item) => /result summary|assessment summary/i.test(String(item.name)));

    if (summary && /self[-\s]?assessment/i.test(String(summary.value))
      && !/(?:instrumental|clinical\s+(?:study|trial|test))/i.test(String(summary.value))) {
      expect(summary.name).toBe("Reported assessment summary");
    }
  });

  it("produces no trust findings for method upgrades in the read-only validator", () => {
    const readOnly = validatePdpGeoArtifacts({
      schemaMarkup: artifacts.schemaMarkup,
      content: artifacts.content,
      fallbackProductName: "Ginseng Firming Serum",
      fallbackDescription: "A lightweight firming serum.",
      locale: "en-US",
      sourceProduct: normalized
    });

    const trustIssues = readOnly.validationFindings.map((finding) => finding.issue).join("\n");
    expect(trustIssues).not.toContain("upgraded an instrumental result to a clinical study");
    expect(trustIssues).not.toContain("was labeled \"Clinical result summary\"");
  });
});

describe("ingredient alias normalization (trust warning prevention)", () => {
  it("does not flag a source-backed ingredient whose alias marker was normalized", () => {
    const normalized = normalizePdpProduct({
      name: "Ginseng Firming Serum",
      description: "A firming serum with Botanical Actives (AKA Botanical Complex™).",
      category: "Serum",
      benefits: ["firmness"],
      ingredients: ["Botanical Actives (AKA Botanical Complex™)", "Ginseng Peptide™"]
    }, { hints: { locale: "en-US" } }).product;

    const readOnly = validatePdpGeoArtifacts({
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              "@id": "https://example.com/products/ginseng-firming-serum#product",
              name: "Ginseng Firming Serum",
              description: "A firming serum.",
              additionalProperty: [
                {
                  "@type": "PropertyValue",
                  name: "Key ingredients",
                  value: "Botanical Actives (Botanical Complex), Ginseng Peptide"
                }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "Ginseng Firming Serum",
          description: "A firming serum.",
          quickFacts: "",
          benefits: "firmness",
          ingredients: "Botanical Actives (AKA Botanical Complex™)",
          howToUse: "",
          faq: ""
        },
        html: ""
      },
      fallbackProductName: "Ginseng Firming Serum",
      fallbackDescription: "A firming serum.",
      locale: "en-US",
      sourceProduct: normalized
    });

    const issues = readOnly.validationFindings.map((finding) => finding.issue).join("\n");
    expect(issues).not.toContain("does not appear in this product's source evidence");
  });
});

describe("usage punctuation no-op (trust warning prevention)", () => {
  it("does not report a Usage repair when only the trailing period would change", () => {
    const usageValue = "Use morning and night after applying toner. Warm three pumps between fingers, apply to the face and neck with upward motions, then gently wrap the palms around the face to help the serum absorb.";
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "en-US",
      fallbackProductName: "Ginseng Firming Serum",
      fallbackDescription: "A firming serum.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              "@id": "https://example.com/products/ginseng-firming-serum#product",
              name: "Ginseng Firming Serum",
              description: "A firming serum.",
              additionalProperty: [
                { "@type": "PropertyValue", name: "Usage", value: usageValue }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "Ginseng Firming Serum",
          description: "A firming serum.",
          quickFacts: "",
          benefits: "",
          ingredients: "",
          howToUse: usageValue,
          faq: ""
        },
        html: ""
      }
    });

    const usageRepairs = repaired.validationRepairs.filter((repair) => /additionalProperty\.Usage/.test(repair.field));
    expect(usageRepairs).toEqual([]);
    const product = (repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>)
      .find((node) => node["@type"] === "Product") as Record<string, any>;
    const usage = (product.additionalProperty as Array<Record<string, any>>).find((item) => item.name === "Usage");
    expect(String(usage?.value)).toBe(usageValue);
  });
});

describe("clause join artifact repair", () => {
  // 실행 결과(2026-08-13)에서 관찰된 손상 문자열 그대로: ";," 결합,
  // "; and, and" 중복 접속사, 끝의 "in a" 절단 꼬리.
  it("repairs ';,' joins, duplicated conjunctions, and a dangling truncated tail", () => {
    const corrupted = "In a self-assessment of 32 women after 6 weeks of daily use, 100% of participants agreed that skin felt firmer and more elastic;, 100% of participants agreed that skin texture felt improved and more even; and, and 93% of participants agreed that fine lines and wrinkles felt diminished in a";
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "en-US",
      fallbackProductName: "Ginseng Firming Serum",
      fallbackDescription: "A firming serum.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              "@id": "https://example.com/products/ginseng-firming-serum#product",
              name: "Ginseng Firming Serum",
              description: "A firming serum.",
              additionalProperty: [
                { "@type": "PropertyValue", name: "Reported assessment summary", value: corrupted }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "Ginseng Firming Serum",
          description: "A firming serum.",
          quickFacts: "",
          benefits: "",
          ingredients: "",
          howToUse: "",
          faq: ""
        },
        html: ""
      }
    });

    const product = (repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>)
      .find((node) => node["@type"] === "Product") as Record<string, any>;
    const summary = (product.additionalProperty as Array<Record<string, any>>)
      .find((item) => /assessment summary/i.test(String(item.name)));

    expect(String(summary?.value)).toBe(
      "In a self-assessment of 32 women after 6 weeks of daily use, 100% of participants agreed that skin felt firmer and more elastic; 100% of participants agreed that skin texture felt improved and more even; and 93% of participants agreed that fine lines and wrinkles felt diminished"
    );
  });
});

describe("price cents normalization consistency", () => {
  it("normalizes a Shopify cents amount at normalization time, matching the Offer", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Ginseng Firming Serum",
          description: "A firming serum.",
          category: "Serum",
          benefits: ["firmness"],
          ingredients: ["Ginseng Peptide"],
          price: "21500",
          currency: "USD"
        }
      },
      hints: { locale: "en-US", market: "US" }
    });

    expect(result.diagnostics.normalizedProduct.price?.amount).toBe(215);
    const product = graphOf(result).find((node) => node["@type"] === "Product") as Record<string, any>;
    expect((product.offers as Record<string, any>).price).toBe(215);
  });

  it("keeps zero-decimal currency amounts untouched", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "수분 크림",
          description: "보습 크림입니다.",
          category: "크림",
          benefits: ["보습"],
          ingredients: ["세라마이드"],
          price: "32,000원",
          currency: "KRW"
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    });

    expect(result.diagnostics.normalizedProduct.price?.amount).toBe(32000);
  });
});

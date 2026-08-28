import { describe, expect, it } from "vitest";
import { evaluateGeoQuality } from "../src";
import { collectMetricIntegrityIssues } from "../src/quality/internal";

const upgradedSentence = "In a self-assessment from clinical of 31 women who used the product daily, 96% of participants showed improvement in skin After 6 weeks of use.";
const preservedSentence = "In a self-assessment with 31 women, 96% agreed skin felt smoother after 6 weeks.";

describe("collectMetricIntegrityIssues claim-modality lints", () => {
  it("detects self-assessment agreement upgraded to an improvement reading", () => {
    const issues = collectMetricIntegrityIssues(upgradedSentence, "en");
    expect(issues.join(" ")).toMatch(/upgrades a self-assessment/i);
    expect(issues.join(" ")).toMatch(/attributes clinical status to a self-assessment/i);
  });

  it("detects the Korean upgrade phrasing", () => {
    const issues = collectMetricIntegrityIssues("자가 평가에서 96%의 참여자가 피부 개선을 확인했습니다.", "ko");
    expect(issues.join(" ")).toMatch(/자가 평가/);
  });

  it("keeps preserved self-assessment modality clean", () => {
    expect(collectMetricIntegrityIssues(preservedSentence, "en")).toEqual([]);
  });
});

describe("collectMetricIntegrityIssues realization-defect lints", () => {
  // Live ExampleLuxe activating-serum defect (2026-08-11): the realizer nested the label's
  // own direction stem and spliced the timing clause with its capital intact.
  const nestedStemSentence = "In an instrumental assessment of 30 subjects, 100% of participants showed improvement in Visible improvement in fine lines After one bottle of daily use.";
  const repairedSentence = "In an instrumental assessment of 30 subjects, 100% of participants showed visible improvement in fine lines after one bottle of daily use.";

  it("detects a direction stem nested inside its own object phrase", () => {
    const issues = collectMetricIntegrityIssues(nestedStemSentence, "en");
    expect(issues.join(" ")).toMatch(/repeats its direction stem/i);
  });

  it("detects a capitalized temporal clause spliced mid-sentence", () => {
    const issues = collectMetricIntegrityIssues(nestedStemSentence, "en");
    expect(issues.join(" ")).toMatch(/spliced mid-sentence/i);
  });

  it("renders Korean copy for both lints", () => {
    const issues = collectMetricIntegrityIssues(nestedStemSentence, "ko");
    expect(issues.join(" ")).toMatch(/개선\/감소 표현이 중첩/);
    expect(issues.join(" ")).toMatch(/문장 중간에 대문자/);
  });

  it("keeps the repaired sentence clean", () => {
    expect(collectMetricIntegrityIssues(repairedSentence, "en")).toEqual([]);
  });

  it("does not flag legitimate enumerations or sentence-initial clauses", () => {
    const legitimate = "After 4 weeks of use, participants reported an improvement in hydration and an improvement in texture. Fine lines look reduced.";
    expect(collectMetricIntegrityIssues(legitimate, "en")).toEqual([]);
  });
});

describe("evaluateGeoQuality E-E-A-T impact", () => {
  function graphWithDescription(description: string) {
    return {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebPage", "@id": "https://example.com/p#webpage", name: "Test Cream", description: "Test Cream product page." },
        { "@type": "Product", "@id": "https://example.com/p#product", name: "Test Cream", description }
      ]
    };
  }

  it("penalizes the upgraded claim relative to the preserved one", () => {
    const upgraded = evaluateGeoQuality({
      jsonLd: graphWithDescription(`Test Cream is a moisturizer. ${upgradedSentence}`),
      diagnostics: { normalizedProduct: {}, validationWarnings: [] }
    }, "en");
    const preserved = evaluateGeoQuality({
      jsonLd: graphWithDescription(`Test Cream is a moisturizer. ${preservedSentence}`),
      diagnostics: { normalizedProduct: {}, validationWarnings: [] }
    }, "en");
    const upgradedEeat = upgraded.dimensions.find((dimension) => dimension.id === "eeat");
    const preservedEeat = preserved.dimensions.find((dimension) => dimension.id === "eeat");
    expect(upgradedEeat && preservedEeat && upgradedEeat.score < preservedEeat.score).toBe(true);
    expect(upgraded.dimensions.flatMap((dimension) => dimension.improvements).join(" "))
      .toMatch(/self-assessment/i);
  });
});

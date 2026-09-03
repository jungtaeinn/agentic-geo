import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src/agent";

/**
 * Regression tests for the four public-copy template defects observed in a
 * live ExampleLuxe CGR Serum run (2026-08-06):
 *
 * 1. "100%%"  — value already carried its unit and the unit was appended again
 *    (both the English metric narrative and the evidence-ledger atom).
 * 2. "showed improvement in 32 women" — the improvement-subject slot fell back
 *    to the study SAMPLE instead of the metric label.
 * 3. "Fine lines and wrinkles decreased by 100%" — a share-of-participants
 *    claim rendered as a change magnitude (claim-strength distortion).
 * 4. "supports supports" — ingredient-benefit templates prepended "supports"
 *    to a benefit phrase that already begins with a support verb.
 *
 * The fixture mirrors the failing product's semanticFacts shape. The run uses
 * the deterministic (mock) path, so assertions are stable.
 */

const regressionProduct = {
  name: "Ginseng Renewal Serum",
  brand: "TestBrand",
  category: "Serum",
  description: "A firming serum for the look of fine lines and elasticity.",
  benefits: ["Anti-aging", "Visibly firming"],
  effects: ["Improves the look of plumpness and fine lines."],
  ingredients: ["Ginseng Peptide", "Niacinamide"],
  usage: ["Apply morning and night after toner."],
  metrics: [
    "100% of 32 women saw reduced fine lines and wrinkles after 4 weeks of daily use in an instrumental result.",
    "After 6 weeks of daily use, 100% of 32 women showed instrumental improvement in elasticity."
  ],
  semanticFacts: {
    ingredients: ["Ginseng Peptide", "Niacinamide"],
    benefits: ["Visibly firming"],
    effects: [],
    skinTypes: ["normal skin"],
    usageSteps: ["Apply morning and night after toner."],
    safetyTests: [],
    metricClaims: [
      {
        label: "Fine lines and wrinkles",
        subject: "32 women",
        value: "100%",
        unit: "%",
        metric: "saw reduced fine lines and wrinkles",
        direction: "reduced",
        timing: "after 4 weeks",
        period: "4 weeks of daily use",
        sample: "32 women",
        method: "instrumental result",
        sentence: "100% of 32 women saw reduced fine lines and wrinkles after 4 weeks of daily use in an instrumental result."
      },
      {
        label: "Elasticity",
        subject: "32 women",
        value: "100%",
        unit: "%",
        metric: "showed improvement",
        direction: "improvement",
        timing: "after 6 weeks",
        period: "6 weeks of daily use",
        sample: "32 women",
        method: "instrumental result",
        sentence: "After 6 weeks of daily use, 100% of 32 women showed instrumental improvement in elasticity."
      }
    ],
    evidenceSentences: [
      "Ginseng Peptide helps support skin firmness and elasticity."
    ],
    ingredientBenefitLinks: [
      {
        ingredient: "Ginseng Peptide",
        benefit: "supports the look of skin firmness and elasticity",
        sentence: "Ginseng Peptide helps support the look of skin firmness and elasticity.",
        sourceText: "Ginseng Peptide helps support the look of skin firmness and elasticity."
      }
    ],
    citations: []
  }
};

const multiTimepointProduct = {
  name: "Ginseng Renewal Serum",
  brand: "TestBrand",
  category: "Serum",
  description: "A firming serum for the look of fine lines and elasticity.",
  benefits: ["Anti-aging", "Visibly firming"],
  effects: ["Improves the look of plumpness and fine lines."],
  ingredients: ["Ginseng Peptide", "Niacinamide"],
  usage: ["Apply morning and night after toner."],
  metrics: [
    "Fine lines and wrinkles were reduced by 80% after 4 weeks and 95% after 8 weeks of daily use in an instrumental result."
  ],
  semanticFacts: {
    ingredients: ["Ginseng Peptide", "Niacinamide"],
    benefits: ["Visibly firming"],
    effects: [],
    skinTypes: ["normal skin"],
    usageSteps: ["Apply morning and night after toner."],
    safetyTests: [],
    metricClaims: [
      {
        label: "Fine lines and wrinkles",
        subject: "32 women",
        value: "80% / 95%",
        unit: "%",
        metric: "reduction in fine lines and wrinkles",
        direction: "reduced",
        timing: "after 4 weeks, after 8 weeks",
        period: "8 weeks of daily use",
        sample: "32 women",
        method: "instrumental result",
        sentence: "Fine lines and wrinkles were reduced by 80% after 4 weeks and 95% after 8 weeks of daily use in an instrumental result."
      }
    ],
    evidenceSentences: [],
    ingredientBenefitLinks: [],
    citations: []
  }
};

const koreanMultiTimepointProduct = {
  name: "진생 리뉴얼 세럼",
  brand: "테스트브랜드",
  category: "세럼",
  description: "미세주름과 탄력 케어를 위한 퍼밍 세럼입니다.",
  benefits: ["탄력 개선"],
  effects: ["미세주름 개선"],
  ingredients: ["진세노사이드", "나이아신아마이드"],
  usage: ["토너 후 아침저녁으로 사용합니다."],
  metrics: [
    "인체적용시험에서 미세주름이 4주 후 80%, 8주 후 95% 감소했습니다."
  ],
  semanticFacts: {
    ingredients: ["진세노사이드", "나이아신아마이드"],
    benefits: ["탄력 개선"],
    effects: [],
    skinTypes: ["모든 피부"],
    usageSteps: ["토너 후 아침저녁으로 사용합니다."],
    safetyTests: [],
    metricClaims: [
      {
        label: "미세주름",
        subject: "여성 32명",
        value: "80% / 95%",
        unit: "%",
        metric: "미세주름",
        direction: "감소",
        timing: "4주 후, 8주 후",
        period: "8주",
        sample: "여성 32명",
        method: "인체적용시험",
        sentence: "인체적용시험에서 미세주름이 4주 후 80%, 8주 후 95% 감소했습니다."
      }
    ],
    evidenceSentences: [],
    ingredientBenefitLinks: [],
    citations: []
  }
};

/**
 * Mirrors the live ExampleLuxe FCAS run (2026-08-11): the claim label already
 * carries a direction stem ("Visible improvement in fine lines") and the
 * timing is a capitalized clause ("After one bottle of daily use"). The old
 * realizer only stripped labels that BEGIN with "improvement in", so it
 * rendered "showed improvement in Visible improvement in fine lines After
 * one bottle of daily use".
 */
const stemLabelProduct = {
  name: "Essential Activating Serum",
  brand: "TestBrand",
  category: "Serum",
  description: "A lightweight serum for dryness, dullness, and visible fine lines.",
  benefits: ["Delivers immediate hydration while improving dryness, dullness, and overall tone."],
  effects: [],
  ingredients: ["500-Hour Fermented Ginseng", "Korean Herb Extract"],
  usage: ["Gently pat 2-3 pumps onto skin morning and night."],
  metrics: [
    "100% of users had visible improvement in fine lines after one bottle of daily use in an instrumental result involving 30 subjects after 8 weeks."
  ],
  semanticFacts: {
    ingredients: ["500-Hour Fermented Ginseng", "Korean Herb Extract"],
    benefits: ["Delivers immediate hydration while improving dryness, dullness, and overall tone."],
    effects: [],
    skinTypes: ["dry skin"],
    usageSteps: ["Gently pat 2-3 pumps onto skin morning and night."],
    safetyTests: [],
    metricClaims: [
      {
        label: "Visible improvement in fine lines",
        subject: "Users",
        value: "100",
        unit: "%",
        metric: "visible improvement in fine lines",
        direction: "improvement",
        timing: "After one bottle of daily use",
        period: "8 weeks",
        sample: "30 subjects",
        method: "Instrumental result",
        sentence: "After one bottle of daily use, 100% of users had visible improvement in fine lines.",
        sourceText: "AFTER ONE BOTTLE OF DAILY USE* 100% users had visible improvement in FINE LINES *Instrumental result, 30 subjects, after 8 weeks of daily use"
      }
    ],
    evidenceSentences: [],
    ingredientBenefitLinks: [],
    citations: []
  }
};

function collectPublicTexts(run: Awaited<ReturnType<typeof generatePdpGeo>>): string {
  return [
    JSON.stringify(run.result.schemaMarkup.jsonLd),
    Object.values(run.result.content.sections).join("\n"),
    (run.diagnostics.evidenceLedger ?? []).map((item) => item.text).join("\n"),
    (run.diagnostics.inferredSearchQueries ?? []).map((query) => `${query.question} ${query.answer}`).join("\n")
  ].join("\n");
}

describe("metric narrative regressions (live-run defects)", () => {
  it("never renders %%, sample-as-subject, magnitude distortion, or duplicated support verbs", async () => {
    const run = await generatePdpGeo({
      product: regressionProduct,
      hints: { locale: "en-US", market: "US" }
    });

    const publicTexts = [
      JSON.stringify(run.result.schemaMarkup.jsonLd),
      Object.values(run.result.content.sections).join("\n"),
      (run.diagnostics.evidenceLedger ?? []).map((item) => item.text).join("\n"),
      (run.diagnostics.inferredSearchQueries ?? []).map((query) => `${query.question} ${query.answer}`).join("\n")
    ].join("\n");

    // 1. duplicated unit
    expect(publicTexts).not.toMatch(/%%/);
    // 2. study sample bound into the improvement-subject slot
    expect(publicTexts).not.toMatch(/improvement in 32 women/i);
    // 3. share-of-participants rendered as change magnitude
    expect(publicTexts).not.toMatch(/(?:decreased|reduced|improved) by 100%/i);
    // 4. duplicated support verb
    expect(publicTexts).not.toMatch(/supports\s+supports/i);
    expect(publicTexts).not.toMatch(/\bsupports\s+helps?\b/i);
  });

  it("renders share-of-participants reduction claims with participant framing", async () => {
    const run = await generatePdpGeo({
      product: regressionProduct,
      hints: { locale: "en-US", market: "US" }
    });
    const publicTexts = [
      JSON.stringify(run.result.schemaMarkup.jsonLd),
      Object.values(run.result.content.sections).join("\n")
    ].join("\n");

    // When the 4-week reduction claim is rendered as a structured narrative,
    // it must attribute the 100% to participants, not to the metric itself.
    if (/100% of participants/i.test(publicTexts)) {
      expect(publicTexts).toMatch(/100% of participants (?:saw a reduction in|showed improvement in)/i);
    }
    expect(publicTexts).not.toMatch(/wrinkles decreased by 100%/i);
  });

  it("strips the direction stem from the claim label instead of nesting it", async () => {
    const run = await generatePdpGeo({
      product: stemLabelProduct,
      hints: { locale: "en-US", market: "US" }
    });
    const publicTexts = [
      JSON.stringify(run.result.schemaMarkup.jsonLd),
      Object.values(run.result.content.sections).join("\n")
    ].join("\n");

    // Same direction stem nested inside its own object noun phrase
    // ("improvement in Visible improvement in fine lines").
    expect(publicTexts).not.toMatch(/\b(improvement|reduction|increase|decrease)\s+(?:in|of)\s+(?:(?!and\b|or\b)[A-Za-z-]+\s+){0,3}\1\s+(?:in|of)\b/i);
    // The label's source modality ("visible") survives in the realized claim.
    expect(publicTexts).toMatch(/showed visible improvement in fine lines/i);
  });

  it("joins the timing clause in lowercase instead of splicing a capitalized sentence start", async () => {
    const run = await generatePdpGeo({
      product: stemLabelProduct,
      hints: { locale: "en-US", market: "US" }
    });
    const publicTexts = [
      JSON.stringify(run.result.schemaMarkup.jsonLd),
      Object.values(run.result.content.sections).join("\n")
    ].join("\n");

    // A temporal clause spliced mid-sentence with its sentence-start capital
    // ("...fine lines After one bottle of daily use").
    expect(publicTexts).not.toMatch(/[a-z],? (?:After|Before|During|Within) (?:one|two|three|a |an |the |\d|use|using|daily|application|cleansing)/);
  });

  it("never renders %% for multi-timepoint metric values whose value already carries the unit (en-US)", async () => {
    const run = await generatePdpGeo({
      product: multiTimepointProduct,
      hints: { locale: "en-US", market: "US" }
    });
    expect(collectPublicTexts(run)).not.toMatch(/%%/);
  });

  it("never renders %% for multi-timepoint metric values whose value already carries the unit (ko-KR)", async () => {
    const run = await generatePdpGeo({
      product: koreanMultiTimepointProduct,
      hints: { locale: "ko-KR", market: "KR" }
    });
    expect(collectPublicTexts(run)).not.toMatch(/%%/);
  });
});

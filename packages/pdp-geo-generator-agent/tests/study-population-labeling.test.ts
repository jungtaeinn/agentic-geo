import { describe, expect, it } from "vitest";
import { extractTargetAudienceAgeSample } from "../src/generate";
import { generatePdpGeo } from "../src/agent";

/**
 * A source may state a study's age range and headcount without naming a
 * gender ("만 20~59세 30명"). The gender capture in the sample matcher is
 * optional, and the Korean population label used to default that gap to 여성,
 * so the rendered suitability evidence published a demographic the PDP never
 * stated — the class of invented fact the evidence gates exist to prevent,
 * produced by the deterministic renderer downstream of them. English already
 * returned the neutral "participants" for the same gap.
 *
 * The unit assertions below target the matcher directly because the path that
 * renders it (`localizedSuitabilityEvidenceContext`) is only reached when the
 * structured clinical summary declines the same evidence; an artifact-level
 * fixture passes whether or not the label is correct.
 */
describe("study population labeling", () => {
  it("uses the neutral label when the source states no gender", () => {
    expect(extractTargetAudienceAgeSample("만 20~59세 30명 대상 인체적용시험", "ko-KR"))
      .toBe("20~59세 대상자 고객");
    expect(extractTargetAudienceAgeSample("만 20~59세 30명 대상 인체적용시험", "en-US"))
      .toBe("participants aged 20-59");
    expect(extractTargetAudienceAgeSample("만 20~59세 30명 대상 인체적용시험", "ja-JP"))
      .toBe("20~59세の対象者");
  });

  it("keeps a gender the source did state", () => {
    expect(extractTargetAudienceAgeSample("만 20~59세 여성 30명 대상 인체적용시험", "ko-KR"))
      .toBe("20~59세 여성 고객");
    expect(extractTargetAudienceAgeSample("만 20~59세 남성 30명 대상 인체적용시험", "ko-KR"))
      .toBe("20~59세 남성 고객");
    expect(extractTargetAudienceAgeSample("women aged 20 to 59", "en-US"))
      .toBe("women aged 20-59");
  });

  it("keeps a neutral population word the source did state", () => {
    expect(extractTargetAudienceAgeSample("만 20~59세 참여자 30명", "ko-KR"))
      .toBe("20~59세 대상자 고객");
  });
});

const unstatedGenderProduct = {
  name: "배리어케어365 하이드로 수딩 크림",
  brand: "예시더마",
  category: "크림",
  description: "건조하고 민감한 피부를 위한 보습 크림입니다.",
  benefits: ["피부 장벽 강화", "속건조 완화"],
  effects: ["피부 수분을 채워 건조함을 완화합니다."],
  ingredients: ["세라마이드", "판테놀"],
  usage: ["세안 후 적당량을 덜어 얼굴에 부드럽게 펴 바릅니다."],
  metrics: [
    "만 20~59세 30명을 대상으로 한 인체적용시험에서 4주 후 피부 수분량이 32% 증가했습니다."
  ],
  semanticFacts: {
    ingredients: ["세라마이드", "판테놀"],
    benefits: ["피부 장벽 강화"],
    effects: ["피부 수분을 채워 건조함을 완화합니다."],
    skinTypes: ["건성 피부", "민감성 피부"],
    usageSteps: ["세안 후 적당량을 덜어 얼굴에 부드럽게 펴 바릅니다."],
    safetyTests: [],
    metricClaims: [
      {
        label: "피부 수분량",
        value: "32",
        unit: "%",
        metric: "피부 수분량 증가",
        direction: "증가",
        timing: "4주 후",
        period: "4주",
        sample: "만 20~59세 30명",
        method: "인체적용시험",
        sentence: "만 20~59세 30명을 대상으로 한 인체적용시험에서 4주 후 피부 수분량이 32% 증가했습니다."
      }
    ],
    evidenceSentences: [
      "만 20~59세 30명을 대상으로 한 인체적용시험에서 4주 후 피부 수분량이 32% 증가했습니다."
    ],
    ingredientBenefitLinks: [],
    citations: []
  }
};

describe("study population labeling (artifact-level safety net)", () => {
  it("publishes no gender for a source that states none", async () => {
    const run = await generatePdpGeo({
      product: unstatedGenderProduct,
      hints: { locale: "ko-KR", market: "KR" }
    });

    const publicText = [
      JSON.stringify(run.result.schemaMarkup.jsonLd),
      Object.values(run.result.content.sections).join("\n"),
      (run.diagnostics.evidenceLedger ?? []).map((item) => item.text).join("\n"),
      (run.diagnostics.inferredSearchQueries ?? []).map((query) => `${query.question} ${query.answer}`).join("\n")
    ].join("\n");

    expect(publicText).not.toMatch(/여성/u);
    expect(publicText).not.toMatch(/남성/u);
  });
});

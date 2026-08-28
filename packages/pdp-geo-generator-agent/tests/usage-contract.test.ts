import { describe, expect, it } from "vitest";
import {
  hasActionableApplicationVerb,
  hasProcedureActionCue,
  isConcreteUsageAction,
  isProceduralUsageInstruction,
  isRawPageTextBlock
} from "../src/contracts/usage-contract";

// Regression anchor: the EXAMPLEDERMA cream-mist run published two legitimate
// HowTo steps that the validator then rejected because its private copy of
// the action-cue regex lacked the spray/mist verb family. Publish and
// validate must judge usage text through this single shared contract.
describe("shared usage contract", () => {
  const mistSteps = [
    "연약하고 건조해진 피부 부위에 미세 분사합니다",
    "피부에 건조함이 느껴질 때 수시로 뿌려줍니다",
    "1. 연약하고 건조해진 피부 부위에 미세 분사합니다."
  ];

  it("accepts spray/mist application directions as procedural usage instructions", () => {
    for (const step of mistSteps) {
      expect(hasProcedureActionCue(step), step).toBe(true);
      expect(isProceduralUsageInstruction(step), step).toBe(true);
      expect(isConcreteUsageAction(step), step).toBe(true);
    }
    expect(hasActionableApplicationVerb("얼굴 전체에 고르게 분사합니다")).toBe(true);
    expect(isProceduralUsageInstruction("Spray evenly onto the face after cleansing.")).toBe(true);
  });

  it("still accepts the classic apply/spread direction family", () => {
    expect(isProceduralUsageInstruction("세안 후 적당량을 덜어 얼굴에 부드럽게 펴 바릅니다.")).toBe(true);
    expect(isProceduralUsageInstruction("Apply an appropriate amount to the face after cleansing.")).toBe(true);
  });

  it("keeps rejecting benefit, review, and evidence sentences as usage steps", () => {
    expect(isProceduralUsageInstruction("수분 충전과 동시에 보습막을 형성합니다.")).toBe(false);
    expect(isProceduralUsageInstruction("세라마이드는 피부 장벽을 강화하는 성분입니다.")).toBe(false);
    expect(isConcreteUsageAction("임상 테스트 결과 보습 효과가 32% 개선되었습니다.")).toBe(false);
    expect(isProceduralUsageInstruction("촉촉한 사용감과 산뜻한 마무리감이 느껴지는 미스트")).toBe(false);
  });

  it("flags stitched page/OCR dumps so they cannot enter public fields", () => {
    const blob = "2020 REVIEW PLATFORM AWARDS WINNER 94% 93% 93% 흔들 필요 없는 특수 에멀징 공법 "
      + "Step 1 배리어케어365 버블 클렌저 EXAMPLEDERMA 버블 클렌저 EXAMPLEDERMA Step 2 배리어케어365 하이드로 에센스 EXAMPLEDERMA "
      + "Step 3 배리어케어365 세라-히알 속수분 앰플 EXAMPLEDERMA Step 4 배리어케어365 크림 EXAMPLEDERMA";
    expect(isRawPageTextBlock(blob)).toBe(true);
    expect(isRawPageTextBlock("연약하고 건조해진 피부 부위에 미세 분사합니다.")).toBe(false);
  });
});

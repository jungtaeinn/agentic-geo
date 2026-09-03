import { describe, expect, it } from "vitest";
import {
  hasActionableApplicationVerb,
  hasProcedureActionCue,
  isConcreteUsageAction,
  isProceduralUsageInstruction,
  isRawPageTextBlock
} from "../src/contracts/usage-contract";
import { normalizePdpProduct } from "../src/normalize";

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

  // Same defect, next verb family: the cleanser run published `얼굴에 부드럽게
  // 롤링하여 노폐물을 녹여낸 후 미온수로 깨끗이 씻어냅니다` and the validator
  // rejected it, because `씻다` — the ordinary Korean verb for rinsing — was in
  // one of the four action vocabularies and missing from the other three. The
  // rejection cost a validation warning AND reverted the whole proofreading
  // pass, so a FAQ fix died with it. The four predicates now read one table.
  it("accepts the wash/rinse direction family through every action predicate", () => {
    const washSteps = [
      "얼굴에 부드럽게 롤링하여 노폐물을 녹여낸 후 미온수로 깨끗이 씻어냅니다",
      "얼굴에 부드럽게 롤링하여 노폐물을 녹여낸 후 미온수로 깨끗이 씻어줍니다",
      "미온수로 깨끗이 씻어냅니다"
    ];
    for (const step of washSteps) {
      expect(hasProcedureActionCue(step), step).toBe(true);
      expect(hasActionableApplicationVerb(step), step).toBe(true);
      expect(isProceduralUsageInstruction(step), step).toBe(true);
      expect(isConcreteUsageAction(step), step).toBe(true);
    }
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
    const blob = "2020 GLOWPICK AWARDS WINNER 94% 93% 93% 흔들 필요 없는 특수 에멀징 공법 "
      + "Step 1 모이베리어365 버블 클렌저 EXAMPLEDERMA 버블 클렌저 EXAMPLEDERMA Step 2 모이베리어365 하이드로 에센스 EXAMPLEDERMA "
      + "Step 3 모이베리어365 세라-히알 속수분 앰플 EXAMPLEDERMA Step 4 모이베리어365 크림 EXAMPLEDERMA";
    expect(isRawPageTextBlock(blob)).toBe(true);
    expect(isRawPageTextBlock("연약하고 건조해진 피부 부위에 미세 분사합니다.")).toBe(false);
  });
});

/**
 * 접수 단계도 같은 계약을 읽어야 한다.
 *
 * `normalize.ts`가 계약의 지시 동사 판정을 사설 사본으로 갖고 있었고, 클렌저의
 * 세정 동작(`씻어냅니다`)을 계약에만 넣어 사본은 그것을 몰랐다. 그 사본이 접수
 * 게이트라서, 계약을 고쳐도 그 문장은 애초에 `usage` 역할을 받지 못했다.
 */
describe("접수 단계의 사용법 판정", () => {
  const washSteps = [
    "거품을 충분히 낸 후 깨끗이 씻어냅니다.",
    "부드럽게 씻어낸 뒤 물기를 정돈합니다."
  ];

  it("keeps a cleanser's rinsing direction as a usage instruction", () => {
    const { product } = normalizePdpProduct({
      name: "예시더마 모이베리어365 젠틀 포밍클렌저",
      description: "건조하고 민감한 피부를 위한 포밍 클렌저입니다.",
      brand: "EXAMPLEDERMA",
      category: "클렌저",
      usage: washSteps
    } as never);

    for (const step of washSteps) {
      expect(product.usage.some((value) => value.includes("씻어")), step).toBe(true);
    }
  });
});

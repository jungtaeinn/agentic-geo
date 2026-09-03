import { describe, expect, it } from "vitest";
import { numbersAreSupported, numericSupportFailureReason } from "../src/content-planner";
import type { PdpGeoAtomicEvidence } from "../src/types";

// 실측 결함(예시더마 1027, 2026-09-01): 상품명 "모이베리어 365 크림 미스트"의
// "365"가 수치 클레임으로 추출되어, 인용 atom에 365가 없으면 FAQ가
// numeric-relationship에서 탈락했다. 상품명 속 숫자는 정체성 표기이지
// 클레임이 아니다.
const PRODUCT_NAME = "모이베리어 365 크림 미스트";

function atom(id: string, text: string): PdpGeoAtomicEvidence {
  return {
    id,
    role: "benefit",
    text,
    sourcePath: "product-detail",
    locale: "ko-KR",
    productScope: "product",
    confidence: 0.9
  };
}

function ledger(...atoms: PdpGeoAtomicEvidence[]): Map<string, PdpGeoAtomicEvidence> {
  return new Map(atoms.map((a) => [a.id, a]));
}

describe("product-identity numeric tokens are not numeric claims", () => {
  const benefitAtom = atom(
    "ev-benefit-wr7w5u",
    "이 제품은 수분을 충전하는 동시에 보습막을 형성하는 효능을 표방하며, 건성 피부 및 모든 피부 타입에 추천됩니다."
  );

  it("passes an answer that only mentions the product name (실측 재현)", () => {
    const answer = `${PRODUCT_NAME}는 수분을 충전하고 피부 표면 보습막 형성을 돕는 효능을 표방합니다.`;
    expect(numbersAreSupported(answer, [benefitAtom.id], ledger(benefitAtom), PRODUCT_NAME)).toBe(true);
  });

  it("still gates a unit-bearing numeric claim that no atom supports", () => {
    const answer = `${PRODUCT_NAME}는 365일 보습을 제공합니다.`;
    expect(numbersAreSupported(answer, [benefitAtom.id], ledger(benefitAtom), PRODUCT_NAME)).toBe(false);
  });

  it("still passes a genuinely supported numeric claim", () => {
    const metricAtom = atom("ev-metric-1", "세라마이드 10,000ppm을 함유했습니다.");
    const answer = `${PRODUCT_NAME}에는 세라마이드 10,000ppm이 함유되어 있습니다.`;
    expect(numbersAreSupported(answer, [metricAtom.id], ledger(metricAtom), PRODUCT_NAME)).toBe(true);
  });

  it("still gates an unsupported bare numeric claim outside the name", () => {
    const answer = `${PRODUCT_NAME}의 만족도는 98%입니다.`;
    expect(numbersAreSupported(answer, [benefitAtom.id], ledger(benefitAtom), PRODUCT_NAME)).toBe(false);
  });
});

// 리뷰 결함(2026-09-01, task-1-review.md Important): 상품명이 순수 숫자
// 토큰으로 시작하거나 끝날 때, 마스킹 정규식에 숫자 경계 가드가 없으면
// 텍스트에 구분자 없이 인접한 무관한 더 큰 숫자열 내부를 잘라내 위조된
// 숫자 토큰을 만들어낸다("10" + "100명" → "0명"). 이는 정당하게 근거
// 있는 클레임을 과잉 차단하거나, 드물게 근거 없는 숫자를 과통과시킬 수
// 있다. NUMERIC_CLAIM_TOKEN_PATTERN이 이미 쓰는 \p{N} 경계와 동일한
// 방식으로 마스킹 정규식 전체를 숫자 경계로 감싸 방지한다.
describe("product-identity mask does not splice adjacent unrelated numbers (숫자 경계 가드)", () => {
  it("does not forge a token when a bare-digit product name prefixes a larger unrelated number (선두 숫자 상품명)", () => {
    const name = "10";
    const supportAtom = atom("ev-support-lead", "이 제품은 100명의 평가단이 참여했습니다.");
    const supportedAnswer = `${name} 라인은 100명의 평가단이 참여한 결과를 반영합니다.`;
    expect(numbersAreSupported(supportedAnswer, [supportAtom.id], ledger(supportAtom), name)).toBe(true);

    const unsupportedAnswer = `${name} 라인은 100명의 평가단이 참여했고 만족도는 87%입니다.`;
    expect(numbersAreSupported(unsupportedAnswer, [supportAtom.id], ledger(supportAtom), name)).toBe(false);
  });

  it("does not forge a token when a bare-digit product name suffixes a larger unrelated number (말미 숫자 상품명)", () => {
    const name = "65";
    const supportAtom = atom("ev-support-tail", "이 제품은 총 165명의 소비자평가단 결과를 반영했습니다.");
    const supportedAnswer = `${name} 에디션은 165명의 소비자평가단 결과를 인용합니다.`;
    expect(numbersAreSupported(supportedAnswer, [supportAtom.id], ledger(supportAtom), name)).toBe(true);

    const unsupportedAnswer = `${name} 에디션은 165명의 소비자평가단 결과와 함께 만족도 92%를 기록했습니다.`;
    expect(numbersAreSupported(unsupportedAnswer, [supportAtom.id], ledger(supportAtom), name)).toBe(false);
  });
});

// 리뷰 결함(2026-09-01, final-review-opus): numericSupportFailureReason은
// numbersAreSupported의 상품명 마스킹·날짜 우선 검사 순서를 따르지 않아,
// 상품명 속 숫자("365")를 미지원 클레임으로 오지목하고 진짜 실패 원인인
// 날짜 불일치를 가렸다. 진단 문구는 게이트와 동일한 근거를 가리켜야 한다.
describe("numericSupportFailureReason mirrors the gate's masking and check order", () => {
  it("names the unsupported date, not the product-name-embedded number, when both a date mismatch and a bare product-name digit are present", () => {
    const evidenceAtom = atom(
      "ev-date-mismatch",
      "이 제품은 2021년 12월 19일 기준으로 소비자 평가를 진행했습니다."
    );
    const answer = `${PRODUCT_NAME}는 2022년 12월 19일 기준으로 측정된 결과를 반영합니다.`;

    expect(numbersAreSupported(answer, [evidenceAtom.id], ledger(evidenceAtom), PRODUCT_NAME)).toBe(false);
    const reason = numericSupportFailureReason(answer, [evidenceAtom.id], ledger(evidenceAtom), PRODUCT_NAME);
    expect(reason).toBe("a stated date was not present in the cited evidence");
    expect(reason).not.toContain("365");
  });
});

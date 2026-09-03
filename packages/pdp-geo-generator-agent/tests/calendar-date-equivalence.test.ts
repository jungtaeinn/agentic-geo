import { describe, expect, it } from "vitest";
import { numbersAreSupported } from "../src/content-planner";
import type { PdpGeoAtomicEvidence } from "../src/types";

// 실측 결함(2026-09-01): 근거 원문이 "22.12.19-22.12.22, 32명 대상"(2자리 연도,
// 범위 뒤 항의 일-단독 표기 없이 완전 표기)인데 자연문화된 설명 문장은
// "2022년 12월 19일부터 22일까지 32명을 대상으로…"로 연도를 4자리로,
// 범위 뒤 항을 일-단독("22일")으로 표기한다. 표기만 다를 뿐 같은 날짜인데도
// 날짜 게이트가 이를 인식하지 못해 Product.description에서 임상 테스트
// 상세 문장이 매 런 제거되었다.
const PRODUCT_NAME = "테스트 크림";

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

describe("calendar date notational equivalence (2자리 연도 · 범위 연속 표기)", () => {
  it("passes when a 2-digit-year dash range and a natural-language range-continuation phrase name the same dates (실측 재현)", () => {
    const evidenceAtom = atom(
      "ev-clinical-1",
      "피부에서 48시간 패치를 활용한 자극여부 확인 22.12.19-22.12.22, 32명 대상"
    );
    const answer = `${PRODUCT_NAME}는 2022년 12월 19일부터 22일까지 32명을 대상으로 48시간 패치 테스트를 진행했습니다.`;
    expect(numbersAreSupported(answer, [evidenceAtom.id], ledger(evidenceAtom), PRODUCT_NAME)).toBe(true);
  });

  it("still gates a claim date that the cited evidence never states (역방향 가드)", () => {
    const evidenceAtom = atom(
      "ev-clinical-2",
      "피부에서 48시간 패치를 활용한 자극여부 확인 22.12.19-22.12.22, 32명 대상"
    );
    const answer = `${PRODUCT_NAME}는 2023년 1월 5일부터 6일까지 48시간 패치 테스트를 진행했습니다.`;
    expect(numbersAreSupported(answer, [evidenceAtom.id], ledger(evidenceAtom), PRODUCT_NAME)).toBe(false);
  });

  it("still gates a mismatched year even though month and day agree (연도 오탐 가드)", () => {
    const evidenceAtom = atom("ev-clinical-3", "2021.12.19 기준 자극여부 확인 결과입니다.");
    const answer = `${PRODUCT_NAME}는 2022년 12월 19일 기준으로 자극여부를 확인했습니다.`;
    expect(numbersAreSupported(answer, [evidenceAtom.id], ledger(evidenceAtom), PRODUCT_NAME)).toBe(false);
  });

  it("does not misread a plain comma-grouped number as a date", () => {
    const evidenceAtom = atom("ev-metric-1", "세라마이드 10,000ppm을 함유했습니다.");
    const answer = `${PRODUCT_NAME}에는 세라마이드 10,000ppm이 함유되어 있습니다.`;
    expect(numbersAreSupported(answer, [evidenceAtom.id], ledger(evidenceAtom), PRODUCT_NAME)).toBe(true);
  });

  it("does not misread a bare duration or headcount number as a date", () => {
    const evidenceAtom = atom("ev-clinical-4", "48시간 패치 테스트에 32명이 참여했습니다.");
    const answer = `${PRODUCT_NAME}는 48시간 패치 테스트에 32명이 참여한 결과를 반영합니다.`;
    expect(numbersAreSupported(answer, [evidenceAtom.id], ledger(evidenceAtom), PRODUCT_NAME)).toBe(true);
  });

  it("does not misread a version-shaped decimal as a yy.mm.dd date", () => {
    const evidenceAtom = atom("ev-metric-2", "pH 4.05, 점도 2.70을 기록했습니다.");
    const answer = `${PRODUCT_NAME}는 pH 4.05, 점도 2.70을 기록했습니다.`;
    expect(numbersAreSupported(answer, [evidenceAtom.id], ledger(evidenceAtom), PRODUCT_NAME)).toBe(true);
  });

  // 리뷰 결함(2026-09-01, task-5-review.md): 일(day) 그룹이 패턴의 마지막
  // 그룹이라 무효한 두 자리 일("70", "32")에서 전체 매치 실패 대신 앞자리
  // 한 글자("7", "3")로 짧게 부분매치했다. 그 결과 "22.2.70", "22.12.32"
  // 같은(근거에 전혀 없는) 무관한 수치가 우연히 근거에 있는 진짜 날짜
  // (2022-2-7, 2022-12-3)와 같은 날짜로 오인되어 calendarDatesAreSupported를
  // 통과했고, 그 부작용으로 같은 클레임 안의 무관하지만 실제로 근거가 있는
  // 다른 수치("48시간")까지 날짜 게이트에서 통째로 탈락(false)했다 — 정상
  // 동작이라면 그 무관한 수치는 날짜로도 일반 수치로도 매치되지 않아
  // 조용히 무시되고 "48시간"은 그대로 근거로 통과해야 한다(true).
  it("does not misread an invalid two-digit day (\"70\") as a valid single-digit day and wrongly gate an unrelated supported number", () => {
    const evidenceAtom = atom("ev-metric-3", "48시간 지속력을 테스트했습니다.");
    const answer = `${PRODUCT_NAME}는 22.2.70의 순도 지수와 48시간 지속력을 기록했습니다.`;
    expect(numbersAreSupported(answer, [evidenceAtom.id], ledger(evidenceAtom), PRODUCT_NAME)).toBe(true);
  });

  it("does not misread an invalid two-digit day (\"32\") as a valid single-digit day and wrongly gate an unrelated supported number", () => {
    const evidenceAtom = atom("ev-metric-4", "48시간 지속력을 테스트했습니다.");
    const answer = `${PRODUCT_NAME}는 22.12.32의 순도 지수와 48시간 지속력을 기록했습니다.`;
    expect(numbersAreSupported(answer, [evidenceAtom.id], ledger(evidenceAtom), PRODUCT_NAME)).toBe(true);
  });
});
